// Advisor: health check, cash-flow forecast, fees & interest, and the tax year.
import { bad, forbidden, notFound } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { healthCheck } from '../lib/advisor/health.js';
import { forecast } from '../lib/advisor/forecast.js';
import { feesReport } from '../lib/advisor/fees.js';
import { taxYear, taxCsv, defaultTaxYear } from '../lib/advisor/tax.js';

const scopeOf = (ctx) => ({ scope: ctx.query.scope === 'me' ? 'me' : 'household', userId: ctx.user.id });

export function advisorRoutes(r) {
  r.get('/api/advisor', (ctx) => {
    const today = ctx.today();
    const opts = scopeOf(ctx);
    return {
      health: healthCheck(ctx.db, ctx.household.id, today, opts),
      forecast: forecast(ctx.db, ctx.household.id, today, { ...opts, viewerId: ctx.user.id }),
      fees: feesReport(ctx.db, ctx.household.id, today, opts),
      emergencyMonths: ctx.db.prepare('SELECT emergency_months FROM households WHERE id = ?').get(ctx.household.id).emergency_months,
    };
  });

  const yearOf = (raw, ctx) => {
    if (raw === undefined || raw === '') return defaultTaxYear(ctx.today());
    if (!/^\d{4}$/.test(String(raw))) throw notFound();
    return Number(raw);
  };

  r.get('/api/advisor/tax', (ctx) => taxYear(ctx.db, ctx.household.id, yearOf(ctx.query.year, ctx), scopeOf(ctx)));

  r.get('/api/advisor/tax/:file', (ctx) => {
    const m = /^(\d{4})\.csv$/.exec(ctx.params.file);
    if (!m) throw notFound();
    const body = taxCsv(taxYear(ctx.db, ctx.household.id, Number(m[1]), scopeOf(ctx)));
    return { $raw: body, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="finta-tax-${m[1]}.csv"` } };
  });

  r.put('/api/advisor/room', (ctx) => {
    const v = validate(ctx.body, {
      user_id: t.ref('users', { required: true, label: 'person' }), year: t.int(2009, 2100, { required: true }),
      kind: t.oneOf(['rrsp', 'tfsa', 'fhsa'], { required: true }), room: t.money({ label: 'room' }),
    }, { db: ctx.db, householdId: ctx.household.id });
    if (v.user_id !== ctx.user.id && ctx.user.role !== 'owner') throw forbidden('You can only enter your own room.');
    if (v.room == null) {   // an emptied field forgets the room
      ctx.db.prepare('DELETE FROM tax_room WHERE household_id = ? AND user_id = ? AND year = ? AND kind = ?').run(ctx.household.id, v.user_id, v.year, v.kind);
      return { ok: true };
    }
    if (v.room < 0) throw bad('Room can’t be negative.', { field: 'room' });
    ctx.db.prepare(`INSERT INTO tax_room (household_id, user_id, year, kind, room) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(household_id, user_id, year, kind) DO UPDATE SET room = excluded.room`).run(ctx.household.id, v.user_id, v.year, v.kind, v.room);
    return { ok: true };
  });

  r.patch('/api/advisor/settings', (ctx) => {
    if (ctx.user.role !== 'owner') throw forbidden('Only an owner can change this.');
    const v = validate(ctx.body, { emergency_months: t.int(1, 24, { required: true, label: 'emergency fund target' }) });
    if (v.emergency_months == null) throw bad('Choose between 1 and 24 months.');
    ctx.db.prepare('UPDATE households SET emergency_months = ? WHERE id = ?').run(v.emergency_months, ctx.household.id);
    return { emergencyMonths: v.emergency_months };
  });
}

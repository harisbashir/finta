// Household settings, members, invitations, activity and data export.
import { bad, forbidden, notFound, HttpError } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/session.js';
import { publicHousehold } from './auth.js';

const requireOwner = (ctx) => { if (ctx.user.role !== 'owner') throw forbidden('Only an owner can do that.'); };

export function householdRoutes(r) {
  r.patch('/api/household', (ctx) => {
    requireOwner(ctx);
    const v = validate(ctx.body, {
      name: t.str(80, { required: true, label: 'household name' }),
      currency: t.str(3), locale: t.str(20), timezone: t.str(60), week_starts: t.int(0, 1),
    }, { partial: true });
    if (v.currency && !/^[A-Z]{3}$/.test(v.currency)) throw bad('Choose a currency like CAD or USD.', { field: 'currency' });
    try { new Intl.NumberFormat(v.locale || ctx.household.locale, { style: 'currency', currency: v.currency || ctx.household.currency }); }
    catch { throw bad('That currency or region isn’t supported.'); }
    if (v.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { throw bad('Unknown time zone.', { field: 'timezone' }); } }
    const keys = Object.keys(v);
    if (keys.length) ctx.db.prepare(`UPDATE households SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), ctx.household.id);
    return publicHousehold(ctx.db.prepare('SELECT * FROM households WHERE id = ?').get(ctx.household.id));
  });

  r.get('/api/household/members', (ctx) => ctx.db.prepare(`SELECT id, name, email, role, color, created_at,
      totp_secret IS NOT NULL AS totp, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = users.id) AS passkeys
    FROM users WHERE household_id = ? ORDER BY created_at`).all(ctx.household.id)
    .map((m) => ({ ...m, totp: !!m.totp })));

  r.patch('/api/household/members/:id', (ctx) => {
    requireOwner(ctx);
    const v = validate(ctx.body, { role: t.oneOf(['owner', 'member'], { required: true }) });
    const m = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND household_id = ?').get(Number(ctx.params.id), ctx.household.id);
    if (!m) throw notFound();
    if (m.id === ctx.user.id && v.role !== 'owner') {
      const owners = ctx.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND role = 'owner'`).get(ctx.household.id).n;
      if (owners < 2) throw new HttpError(409, 'Your household needs at least one owner.');
    }
    ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(v.role, m.id);
    audit(ctx, 'member.role', `${m.name} → ${v.role}`);
    return { ok: true };
  });

  r.delete('/api/household/members/:id', (ctx) => {
    requireOwner(ctx);
    const id = Number(ctx.params.id);
    if (id === ctx.user.id) throw bad('To leave, delete your account in Settings.');
    const m = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND household_id = ?').get(id, ctx.household.id);
    if (!m) throw notFound();
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions & passkeys cascade
    audit(ctx, 'member.removed', m.name);
    return { ok: true };
  });

  r.get('/api/household/invites', (ctx) => {
    requireOwner(ctx);
    return ctx.db.prepare(`SELECT id, created_at, expires_at FROM invites WHERE household_id = ? AND used_at IS NULL
      AND expires_at > datetime('now') ORDER BY created_at DESC`).all(ctx.household.id);
  });

  r.post('/api/household/invites', (ctx) => {
    requireOwner(ctx);
    const token = randomToken(24);
    ctx.db.prepare(`INSERT INTO invites (household_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, datetime('now', '+7 days'))`)
      .run(ctx.household.id, sha256(token), ctx.user.id);
    audit(ctx, 'invite.created');
    return { url: `${ctx.cfg.appUrl}/#/join/${token}`, expiresInDays: 7 };
  });

  r.delete('/api/household/invites/:id', (ctx) => {
    requireOwner(ctx);
    ctx.db.prepare('DELETE FROM invites WHERE id = ? AND household_id = ?').run(Number(ctx.params.id), ctx.household.id);
    return { ok: true };
  });

  r.get('/api/household/activity', (ctx) => {
    requireOwner(ctx);
    return ctx.db.prepare(`SELECT a.event, a.detail, a.ip, a.created_at, u.name AS user_name FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.household_id = ? ORDER BY a.id DESC LIMIT 100`).all(ctx.household.id);
  });

  // Everything the household owns, as JSON. Secrets (password hashes, 2FA, passkeys) are never exported.
  r.get('/api/export', (ctx) => {
    const h = ctx.household.id;
    const all = (table) => ctx.db.prepare(`SELECT * FROM ${table} WHERE household_id = ?`).all(h);
    audit(ctx, 'data.exported');
    const body = JSON.stringify({
      app: 'finta', version: 1, exported_at: new Date().toISOString(),
      household: publicHousehold(ctx.household),
      members: ctx.db.prepare('SELECT id, name, email, role FROM users WHERE household_id = ?').all(h),
      categories: all('categories'), recurring: all('recurring'), transactions: all('transactions'), goals: all('goals'),
      tasks: all('tasks'), shopping_lists: all('shopping_lists'), shopping_items: all('shopping_items'),
      meals: all('meals'), assets: all('assets'), contacts: all('contacts'),
    }, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    return { $raw: body, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="finta-export-${stamp}.json"` } };
  });
}

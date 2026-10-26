// Alexa: connect an Amazon account (owners only), see sync status, pick the shopping list.
import { HttpError, bad, forbidden, notFound } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { RateLimiter } from '../lib/security.js';
import { audit } from '../lib/session.js';
import { AlexaError } from '../lib/alexa/client.js';

const PENDING_MS = 5 * 60000;
const REMINDER_GRACE_MS = 30 * 60000;   // a reminder that just went off stays visible for a bit

/** Alexa reminders due from now until `withinMs` from now (all upcoming if omitted). Safe fields only. */
export function upcomingReminders(db, householdId, { now = Date.now(), withinMs = Infinity } = {}) {
  const row = db.prepare('SELECT reminders FROM alexa_links WHERE household_id = ?').get(householdId);
  let list = [];
  try { list = JSON.parse(row?.reminders || '[]'); } catch { /* treat as none */ }
  return list.filter((r) => r.at && r.at >= now - REMINDER_GRACE_MS && r.at <= now + withinMs)
    .map(({ label, at, repeats }) => ({ label, at, repeats: !!repeats }));
}

export function alexaRoutes(r, app) {
  const limiter = new RateLimiter({ windowMs: 15 * 60000, max: 5 });
  const pending = new Map(); // householdId → { client, state, email, at }
  const now = () => (app.clock || Date.now)();
  const requireOwner = (ctx) => { if (ctx.user.role !== 'owner') throw forbidden('Only an owner can do that.'); };
  const amazon = async (fn) => {
    try { return await fn(); } catch (err) {
      if (err instanceof AlexaError) {
        if (err.diag) console.warn(`[alexa] sign-in stopped (${err.code}): ${err.diag}`);
        throw new HttpError(err.code === 'network' ? 502 : 400, err.message);
      }
      throw err;
    }
  };

  function status(ctx) {
    const l = ctx.db.prepare('SELECT * FROM alexa_links WHERE household_id = ?').get(ctx.household.id);
    return {
      connected: !!l, status: l?.status ?? null, email: l?.email ?? null, site: l?.site ?? null, shoppingListId: l?.shopping_list_id ?? null,
      lastSyncAt: l?.last_sync_at ?? null, lastError: l?.last_error ?? null, lastErrorAt: l?.last_error_at ?? null,
    };
  }

  r.get('/api/alexa', status);

  r.post('/api/alexa/connect', async (ctx) => {
    requireOwner(ctx);
    const v = validate(ctx.body, { email: t.email({ required: true }), password: t.str(200, { required: true }) });
    limiter.take(`alexa:${ctx.household.id}`);
    const client = app.alexa.makeClient();
    const state = await amazon(() => client.startLogin({ email: v.email, password: v.password }));
    // Amazon sometimes trusts the sign-in and skips the texted code.
    if (!state.needsCode) return complete(ctx, { client, state, email: v.email });
    pending.set(ctx.household.id, { client, state, email: v.email, at: now() });
    return { needsCode: true };
  });

  async function complete(ctx, p, code) {
    const login = await amazon(() => p.client.finishLogin(p.state, code));
    pending.delete(ctx.household.id);
    limiter.reset(`alexa:${ctx.household.id}`);
    ctx.db.prepare(`INSERT INTO alexa_links (household_id, site, email, login, cookies_at, connected_by) VALUES (?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(household_id) DO UPDATE SET site = excluded.site, email = excluded.email, login = excluded.login, cookies_at = excluded.cookies_at,
        connected_by = excluded.connected_by, status = 'ok', last_error = NULL, last_error_at = NULL`)
      .run(ctx.household.id, login.domain, p.email, JSON.stringify(login), ctx.user.id);
    audit(ctx, 'alexa.connected', p.email);
    app.alexa.syncNow(ctx.household.id)?.catch?.(() => {});
    return status(ctx);
  }

  r.post('/api/alexa/code', async (ctx) => {
    requireOwner(ctx);
    const code = String(ctx.body.code ?? '').replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(code)) throw bad('Enter the code Amazon texted you.', { field: 'code' });
    const p = pending.get(ctx.household.id);
    if (!p || now() - p.at > PENDING_MS) {
      pending.delete(ctx.household.id);
      throw bad('The Amazon sign-in expired. Start again.');
    }
    return complete(ctx, p, code);
  });

  r.get('/api/alexa/reminders', (ctx) => upcomingReminders(ctx.db, ctx.household.id, { now: now() }));

  r.post('/api/alexa/sync', (ctx) => {
    // Opening Lists or Tasks asks for a 'view' sync (skipped if one ran in the last minute); Sync Now always runs.
    app.alexa.requestSync(ctx.household.id, { reason: ctx.body?.now ? 'now' : 'view' });
    return status(ctx);
  });

  r.patch('/api/alexa', (ctx) => {
    requireOwner(ctx);
    if (!status(ctx).connected) throw notFound();
    const v = validate(ctx.body, { shopping_list_id: t.ref('shopping_lists', { label: 'list' }) }, { db: ctx.db, householdId: ctx.household.id, partial: true });
    if ('shopping_list_id' in v) ctx.db.prepare('UPDATE alexa_links SET shopping_list_id = ? WHERE household_id = ?').run(v.shopping_list_id, ctx.household.id);
    app.alexa.requestSync(ctx.household.id, { reason: 'change' });
    return status(ctx);
  });

  r.delete('/api/alexa', (ctx) => {
    requireOwner(ctx);
    pending.delete(ctx.household.id);
    ctx.db.prepare('DELETE FROM alexa_items WHERE household_id = ?').run(ctx.household.id);
    ctx.db.prepare('DELETE FROM alexa_links WHERE household_id = ?').run(ctx.household.id);
    audit(ctx, 'alexa.disconnected');
    return { ok: true };
  });
}

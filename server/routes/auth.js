// Setup, sign-in (password, 2FA, passkeys), sign-out and invitations.
import { bad, unauthorized, HttpError } from '../lib/http.js';
import { validate, t, checkPassword } from '../lib/validate.js';
import { hashPassword, verifyPassword, dummyVerify, verifyTotp, randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { createSession, destroySession, audit, newTicket, getTicket, dropTicket } from '../lib/session.js';
import { authenticationOptions, verifyAuthentication } from '../lib/webauthn.js';
import { RateLimiter } from '../lib/security.js';
import { tx } from '../db.js';
import { seedHousehold, seedSamples } from '../seed.js';
import fs from 'node:fs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

export const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, theme: u.theme || 'system', totp: !!u.totp_secret });
export const publicHousehold = (h) => h && ({ id: h.id, name: h.name, currency: h.currency, locale: h.locale, timezone: h.timezone, week_starts: h.week_starts });

const householdSchema = {
  householdName: t.str(80, { required: true, label: 'household name' }),
  currency: t.str(3, { default: 'CAD' }),
  locale: t.str(20, { default: 'en-CA' }),
  timezone: t.str(60, { default: 'UTC' }),
};
const personSchema = {
  name: t.str(60, { required: true, label: 'name' }),
  email: t.email({ required: true }),
};

function checkLocaleBits(v) {
  if (!/^[A-Z]{3}$/.test(v.currency)) throw bad('Choose a currency like CAD or USD.', { field: 'currency' });
  // Browsers occasionally report odd tags ("en-US@posix"); fall back rather than block sign-up.
  try { v.locale = Intl.getCanonicalLocales(v.locale)[0]; } catch { v.locale = 'en-CA'; }
  try { new Intl.NumberFormat(v.locale, { style: 'currency', currency: v.currency }); } catch { throw bad('That currency or region isn’t supported.'); }
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { v.timezone = 'UTC'; }
}

async function createHousehold(ctx, body, role = 'owner') {
  const hh = validate(body, householdSchema);
  const person = validate(body, personSchema);
  checkLocaleBits(hh);
  checkPassword(body.password, person);
  if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(person.email)) {
    throw bad('An account with that email already exists. Try signing in.', { field: 'email' });
  }
  const hash = await hashPassword(body.password);
  const user = tx(ctx.db, () => {
    const h = ctx.db.prepare('INSERT INTO households (name, currency, locale, timezone) VALUES (?, ?, ?, ?)')
      .run(hh.householdName, hh.currency, hh.locale, hh.timezone);
    const hid = Number(h.lastInsertRowid);
    const u = ctx.db.prepare('INSERT INTO users (household_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(hid, person.email, person.name, role, hash);
    seedHousehold(ctx.db, hid);
    return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(u.lastInsertRowid));
  });
  if (body.withSamples) seedSamples(ctx.db, user.household_id, user.id, ctx.today(hh.timezone));
  createSession(ctx, user.id);
  audit(ctx, 'household.created', hh.householdName, user);
  return user;
}

export function authRoutes(r, app) {
  const loginLimiter = new RateLimiter({ windowMs: 15 * 60000, max: app.cfg.loginRateLimit });
  const setupLimiter = new RateLimiter({ windowMs: 15 * 60000, max: Math.max(10, app.cfg.loginRateLimit / 2) });
  r.get('/api/bootstrap', (ctx) => {
    const needsSetup = !ctx.db.prepare('SELECT 1 FROM users LIMIT 1').get();
    return {
      needsSetup,
      setupCodeRequired: needsSetup,
      allowSignup: ctx.cfg.allowSignup,
      user: publicUser(ctx.user),
      household: publicHousehold(ctx.household),
      today: ctx.household ? ctx.today() : null,
      version: VERSION,
    };
  });

  // First run: whoever holds the setup code (printed in the container log) creates the household.
  r.post('/api/setup', async (ctx) => {
    setupLimiter.take(ctx.ip);
    if (ctx.db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, 'Finta is already set up. Sign in instead.');
    if (!safeEqual(String(ctx.body.setupCode || '').trim().toUpperCase(), app.setupCode)) {
      throw bad('That setup code doesn’t match. Find it in the container log.', { field: 'setupCode' });
    }
    const user = await createHousehold(ctx, ctx.body);
    return { ok: true, user: publicUser(user) };
  });

  r.post('/api/signup', async (ctx) => {
    if (!ctx.cfg.allowSignup) throw new HttpError(403, 'New households need an invitation.');
    setupLimiter.take(ctx.ip);
    const user = await createHousehold(ctx, ctx.body);
    return { ok: true, user: publicUser(user) };
  });

  r.post('/api/login', async (ctx) => {
    loginLimiter.take(`ip:${ctx.ip}`);
    const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(ctx.body.password || '');
    const user = email && ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const generic = bad('That email and password don’t match.');
    if (!user || !user.password_hash) { await dummyVerify(password); throw generic; }
    if (user.locked_until && Date.parse(user.locked_until + 'Z') > Date.now()) {
      await dummyVerify(password);
      throw new HttpError(429, `Too many attempts. Try again in ${LOCK_MINUTES} minutes or sign in with a passkey.`);
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const fails = user.failed_logins + 1;
      ctx.db.prepare(`UPDATE users SET failed_logins = ?, locked_until = CASE WHEN ? >= ? THEN datetime('now', ?) ELSE locked_until END WHERE id = ?`)
        .run(fails >= LOCK_AFTER ? 0 : fails, fails, LOCK_AFTER, `+${LOCK_MINUTES} minutes`, user.id);
      audit(ctx, 'login.failed', null, user);
      throw generic;
    }
    ctx.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    if (user.totp_secret) {
      return { twoFactor: true, ticket: newTicket(ctx.db, { kind: 'totp', userId: user.id, ttlSec: 300 }) };
    }
    createSession(ctx, user.id);
    audit(ctx, 'login', 'password', user);
    return { ok: true };
  });

  r.post('/api/login/2fa', async (ctx) => {
    loginLimiter.take(`ip:${ctx.ip}`);
    const ticket = getTicket(ctx.db, ctx.body.ticket, 'totp');
    if (!ticket) throw unauthorized('That sign-in expired. Start again.');
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ticket.user_id);
    const code = String(ctx.body.code || '').trim().toLowerCase();
    let ok = false;
    if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      const step = verifyTotp(user.totp_secret, code, user.totp_last_step);
      if (step) { ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id); ok = true; }
    } else if (/^[a-z0-9]{5}-?[a-z0-9]{5}$/.test(code)) {
      const norm = code.replace('-', '');
      const rc = ctx.db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .get(user.id, sha256(`${norm.slice(0, 5)}-${norm.slice(5)}`));
      if (rc) { ctx.db.prepare(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?`).run(rc.id); ok = true; audit(ctx, 'recovery_code.used', null, user); }
    }
    if (!ok) {
      ctx.db.prepare('UPDATE auth_tickets SET attempts = attempts + 1 WHERE id = ?').run(ticket.id);
      if (ticket.attempts + 1 >= 5) { dropTicket(ctx.db, ticket.id); throw unauthorized('Too many wrong codes. Start again.'); }
      throw bad('That code didn’t work. Check your authenticator app and try again.', { field: 'code' });
    }
    dropTicket(ctx.db, ticket.id);
    createSession(ctx, user.id);
    audit(ctx, 'login', '2fa', user);
    return { ok: true };
  });

  r.post('/api/logout', (ctx) => {
    destroySession(ctx);
    return { ok: true };
  });

  // ── Passkey sign-in (discoverable credentials: no email needed) ──
  r.post('/api/passkeys/login/options', (ctx) => {
    loginLimiter.take(`ip:${ctx.ip}`);
    const challenge = randomToken(32);
    const ticket = newTicket(ctx.db, { kind: 'pk-auth', challenge, ttlSec: 180 });
    return { ticket, options: authenticationOptions({ cfg: ctx.cfg, challenge }) };
  });

  r.post('/api/passkeys/login/verify', (ctx) => {
    loginLimiter.take(`ip:${ctx.ip}`);
    const ticket = getTicket(ctx.db, ctx.body.ticket, 'pk-auth');
    if (!ticket) throw unauthorized('That sign-in expired. Try again.');
    dropTicket(ctx.db, ticket.id);
    const credential = ctx.body.credential || {};
    const cred = ctx.db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(String(credential.id || ''));
    if (!cred) throw unauthorized('That passkey isn’t registered with Finta. Sign in with your password.');
    let result;
    try { result = verifyAuthentication({ cfg: ctx.cfg, challenge: ticket.challenge, response: credential, credential: cred }); }
    catch (e) { throw unauthorized(e.message); }
    ctx.db.prepare(`UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`).run(result.signCount, cred.id);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(cred.user_id);
    createSession(ctx, user.id);
    audit(ctx, 'login', 'passkey', user);
    return { ok: true };
  });

  // ── Invitations ──
  r.get('/api/invites/:token', (ctx) => {
    setupLimiter.take(ctx.ip, 0.2);
    const inv = ctx.db.prepare(`SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id
      WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > datetime('now')`).get(sha256(ctx.params.token));
    if (!inv) throw new HttpError(404, 'This invitation has expired or was already used. Ask for a new one.');
    return { household: inv.household_name };
  });

  r.post('/api/invites/:token/accept', async (ctx) => {
    setupLimiter.take(ctx.ip);
    const inv = ctx.db.prepare(`SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
      .get(sha256(ctx.params.token));
    if (!inv) throw new HttpError(404, 'This invitation has expired or was already used. Ask for a new one.');
    const person = validate(ctx.body, personSchema);
    checkPassword(ctx.body.password, person);
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(person.email)) {
      throw bad('An account with that email already exists.', { field: 'email' });
    }
    const hash = await hashPassword(ctx.body.password);
    const colors = ['orange', 'green', 'purple', 'pink', 'teal', 'indigo'];
    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ?').get(inv.household_id).n;
    const user = tx(ctx.db, () => {
      const claimed = ctx.db.prepare(`UPDATE invites SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(inv.id);
      if (!claimed.changes) throw new HttpError(409, 'This invitation was just used.');
      const u = ctx.db.prepare('INSERT INTO users (household_id, email, name, role, password_hash, color) VALUES (?, ?, ?, ?, ?, ?)')
        .run(inv.household_id, person.email, person.name, 'member', hash, colors[count % colors.length]);
      return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(u.lastInsertRowid));
    });
    createSession(ctx, user.id);
    audit(ctx, 'member.joined', person.name, user);
    return { ok: true };
  });
}

// Your own account: profile, password, two-factor, passkeys, devices, deletion.
import { bad, notFound, HttpError } from '../lib/http.js';
import { validate, t, checkPassword, COLORS } from '../lib/validate.js';
import { hashPassword, verifyPassword, newTotpSecret, verifyTotp, totpUri, newRecoveryCodes, sha256, randomToken } from '../lib/crypto.js';
import { audit, newTicket, getTicket, dropTicket, clearSessionCookie } from '../lib/session.js';
import { registrationOptions, verifyRegistration } from '../lib/webauthn.js';
import { RateLimiter } from '../lib/security.js';
import { tx } from '../db.js';
import { publicUser } from './auth.js';

let reauthLimiter;

async function requirePassword(ctx) {
  reauthLimiter.take(`u:${ctx.user.id}`);
  if (!(await verifyPassword(String(ctx.body.password || ''), ctx.user.password_hash))) {
    throw bad('That password isn’t right.', { field: 'password' });
  }
}

function issueRecoveryCodes(db, userId) {
  const codes = newRecoveryCodes();
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  for (const c of codes) ins.run(userId, sha256(c));
  return codes;
}

export function accountRoutes(r, app) {
  reauthLimiter = new RateLimiter({ windowMs: 15 * 60000, max: Math.max(10, app.cfg.loginRateLimit / 2) });
  r.patch('/api/me', (ctx) => {
    const v = validate(ctx.body, { name: t.str(60, { required: true }), color: t.oneOf(COLORS), theme: t.oneOf(['system', 'light', 'dark']) }, { partial: true });
    if (!Object.keys(v).length) return publicUser(ctx.user);
    const sets = Object.keys(v).map((k) => `${k} = ?`).join(', ');
    ctx.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(v), ctx.user.id);
    return publicUser(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id));
  });

  r.get('/api/me/security', (ctx) => {
    const u = ctx.user;
    return {
      totp: !!u.totp_secret,
      recoveryCodesLeft: ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(u.id).n,
      passkeys: ctx.db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(u.id),
      sessions: ctx.db.prepare(`SELECT id, created_at, last_seen_at, user_agent, ip, id = ? AS current FROM sessions
        WHERE user_id = ? AND expires_at > datetime('now') ORDER BY last_seen_at DESC`).all(u.session_id, u.id)
        .map((s) => ({ ...s, current: !!s.current })),
    };
  });

  r.post('/api/me/password', async (ctx) => {
    reauthLimiter.take(`u:${ctx.user.id}`);
    if (!(await verifyPassword(String(ctx.body.current || ''), ctx.user.password_hash))) {
      throw bad('Your current password isn’t right.', { field: 'current' });
    }
    checkPassword(ctx.body.password, ctx.user);
    const hash = await hashPassword(ctx.body.password);
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, ctx.user.id);
    // Sign out everywhere else: a password change usually means "I'm worried".
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(ctx.user.id, ctx.user.session_id);
    audit(ctx, 'password.changed');
    return { ok: true };
  });

  // ── Two-factor (authenticator app) ──
  r.post('/api/me/2fa/setup', async (ctx) => {
    await requirePassword(ctx);
    const secret = newTotpSecret();
    ctx.db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, ctx.user.id);
    return { secret, uri: totpUri({ secret, account: ctx.user.email, issuer: ctx.cfg.rpName }) };
  });

  r.post('/api/me/2fa/enable', (ctx) => {
    reauthLimiter.take(`u:${ctx.user.id}`);
    const secret = ctx.user.totp_pending;
    if (!secret) throw bad('Start two-factor setup again.');
    const step = verifyTotp(secret, ctx.body.code, 0);
    if (!step) throw bad('That code didn’t work. Enter the 6-digit code your app shows now.', { field: 'code' });
    const codes = tx(ctx.db, () => {
      ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(secret, step, ctx.user.id);
      return issueRecoveryCodes(ctx.db, ctx.user.id);
    });
    audit(ctx, '2fa.enabled');
    return { recoveryCodes: codes };
  });

  r.post('/api/me/2fa/disable', async (ctx) => {
    await requirePassword(ctx);
    ctx.db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(ctx.user.id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(ctx.user.id);
    audit(ctx, '2fa.disabled');
    return { ok: true };
  });

  r.post('/api/me/recovery-codes', async (ctx) => {
    await requirePassword(ctx);
    if (!ctx.user.totp_secret) throw bad('Turn on two-factor first.');
    audit(ctx, 'recovery_codes.regenerated');
    return { recoveryCodes: issueRecoveryCodes(ctx.db, ctx.user.id) };
  });

  // ── Passkeys ──
  r.post('/api/me/passkeys/options', (ctx) => {
    const challenge = randomToken(32);
    const exclude = ctx.db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(ctx.user.id).map((p) => p.credential_id);
    const ticket = newTicket(ctx.db, { kind: 'pk-reg', userId: ctx.user.id, challenge, ttlSec: 300 });
    return { ticket, options: registrationOptions({ cfg: ctx.cfg, user: ctx.user, challenge, exclude }) };
  });

  r.post('/api/me/passkeys', (ctx) => {
    const ticket = getTicket(ctx.db, ctx.body.ticket, 'pk-reg');
    if (!ticket || ticket.user_id !== ctx.user.id) throw bad('Passkey setup expired. Try again.');
    dropTicket(ctx.db, ticket.id);
    let reg;
    try { reg = verifyRegistration({ cfg: ctx.cfg, challenge: ticket.challenge, response: ctx.body.credential }); }
    catch (e) { throw bad(e.message); }
    if (ctx.db.prepare('SELECT 1 FROM passkeys WHERE credential_id = ?').get(reg.credentialId)) throw bad('That passkey is already saved.');
    const name = validate(ctx.body, { name: t.str(60) }).name || guessDevice(ctx.req.headers['user-agent']);
    ctx.db.prepare(`INSERT INTO passkeys (user_id, credential_id, public_key, alg, sign_count, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.user.id, reg.credentialId, JSON.stringify(reg.jwk), reg.alg, reg.signCount, JSON.stringify(reg.transports), name);
    audit(ctx, 'passkey.added', name);
    return { ok: true };
  });

  r.patch('/api/me/passkeys/:id', (ctx) => {
    const v = validate(ctx.body, { name: t.str(60, { required: true }) });
    const res = ctx.db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(v.name, Number(ctx.params.id), ctx.user.id);
    if (!res.changes) throw notFound();
    return { ok: true };
  });

  r.delete('/api/me/passkeys/:id', (ctx) => {
    const res = ctx.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), ctx.user.id);
    if (!res.changes) throw notFound();
    audit(ctx, 'passkey.removed');
    return { ok: true };
  });

  // ── Devices ──
  r.delete('/api/me/sessions/:id', (ctx) => {
    ctx.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), ctx.user.id);
    return { ok: true };
  });

  r.post('/api/me/sessions/sign-out-others', (ctx) => {
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(ctx.user.id, ctx.user.session_id);
    audit(ctx, 'sessions.revoked');
    return { ok: true };
  });

  // ── Delete account ──
  r.post('/api/me/delete', async (ctx) => {
    await requirePassword(ctx);
    const others = ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND id != ?').get(ctx.user.household_id, ctx.user.id).n;
    if (ctx.user.role === 'owner' && others > 0) {
      const owners = ctx.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND role = 'owner' AND id != ?`).get(ctx.user.household_id, ctx.user.id).n;
      if (!owners) throw new HttpError(409, 'Make someone else an owner first, so your household keeps an owner.');
    }
    tx(ctx.db, () => {
      if (others === 0) ctx.db.prepare('DELETE FROM households WHERE id = ?').run(ctx.user.household_id); // cascades
      else ctx.db.prepare('DELETE FROM users WHERE id = ?').run(ctx.user.id);
    });
    clearSessionCookie(ctx);
    return { ok: true, householdDeleted: others === 0 };
  });
}

function guessDevice(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

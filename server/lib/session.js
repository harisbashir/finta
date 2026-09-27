// Server-side sessions. The cookie holds a random token; the database holds only its hash,
// so a leaked database backup can't be replayed as a login.
import { randomToken, sha256 } from './crypto.js';
import { serializeCookie, parseCookies } from './http.js';

const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function createSession(ctx, userId) {
  const { db, cfg, req, res } = ctx;
  const token = randomToken(32);
  const expires = Date.now() + cfg.sessionDays * 86400000;
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, iso(expires), String(req.headers['user-agent'] || '').slice(0, 300), ctx.ip);
  res.setHeader('Set-Cookie', serializeCookie(cfg.cookieName, token, {
    maxAge: cfg.sessionDays * 86400, secure: cfg.secureCookies, sameSite: 'Lax',
  }));
  // Housekeeping: drop expired sessions and tickets.
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM auth_tickets WHERE expires_at < datetime('now')`).run();
}

export function clearSessionCookie(ctx) {
  ctx.res.setHeader('Set-Cookie', serializeCookie(ctx.cfg.cookieName, '', { maxAge: 0, secure: ctx.cfg.secureCookies }));
}

export function loadSession(ctx) {
  const { db, cfg, req } = ctx;
  const token = parseCookies(req.headers.cookie)[cfg.cookieName];
  if (!token || token.length > 100) return null;
  const row = db.prepare(`SELECT s.id AS session_id, s.last_seen_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
      AND s.last_seen_at > datetime('now', ?)`).get(sha256(token), `-${cfg.sessionIdleDays} days`);
  if (!row) return null;
  // Touch at most every 5 minutes to keep writes low.
  if (Date.now() - Date.parse(row.last_seen_at + 'Z') > 5 * 60000) {
    db.prepare(`UPDATE sessions SET last_seen_at = datetime('now'), ip = ? WHERE id = ?`).run(ctx.ip, row.session_id);
  }
  return row;
}

export function destroySession(ctx) {
  if (ctx.user) ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.user.session_id);
  clearSessionCookie(ctx);
}

export function audit(ctx, event, detail = null, userOverride) {
  const u = userOverride || ctx.user;
  ctx.db.prepare(`INSERT INTO audit_log (household_id, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(u?.household_id ?? null, u?.id ?? null, event, ctx.ip, detail ? String(detail).slice(0, 300) : null);
}

/** Short-lived server-side state (WebAuthn challenges, pending 2FA). */
export function newTicket(db, { kind, userId = null, challenge = null, ttlSec = 300 }) {
  const id = randomToken(24);
  db.prepare(`INSERT INTO auth_tickets (id, kind, user_id, challenge, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
    .run(id, kind, userId, challenge, `+${ttlSec} seconds`);
  return id;
}

export function getTicket(db, id, kind) {
  if (typeof id !== 'string' || id.length > 64) return null;
  return db.prepare(`SELECT * FROM auth_tickets WHERE id = ? AND kind = ? AND expires_at > datetime('now')`).get(id, kind) || null;
}

export const dropTicket = (db, id) => db.prepare('DELETE FROM auth_tickets WHERE id = ?').run(id);

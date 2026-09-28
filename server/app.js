// Request pipeline: security headers → static files or API → auth gate → CSRF → route.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router, HttpError, readJson, send } from './lib/http.js';
import { securityHeaders, clientIp, checkCsrf, RateLimiter } from './lib/security.js';
import { loadSession } from './lib/session.js';
import { today as todayIn } from './lib/dates.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { householdRoutes } from './routes/household.js';
import { moneyRoutes } from './routes/money.js';
import { homeRoutes } from './routes/home.js';
import { bankAccountRoutes } from './routes/accounts.js';
import { debtRoutes } from './routes/debts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

const PUBLIC_API = [
  ['GET', /^\/api\/bootstrap$/], ['POST', /^\/api\/setup$/], ['POST', /^\/api\/signup$/],
  ['POST', /^\/api\/login$/], ['POST', /^\/api\/login\/2fa$/], ['POST', /^\/api\/logout$/],
  ['POST', /^\/api\/passkeys\/login\/(options|verify)$/],
  ['GET', /^\/api\/invites\/[^/]+$/], ['POST', /^\/api\/invites\/[^/]+\/accept$/],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

export function createApp({ cfg, db, setupCode }) {
  const app = { setupCode: setupCode || '', cfg };
  const router = new Router();
  authRoutes(router, app);
  accountRoutes(router, app);
  householdRoutes(router);
  moneyRoutes(router);
  homeRoutes(router);
  bankAccountRoutes(router);
  debtRoutes(router);

  const apiLimiter = new RateLimiter({ windowMs: 60000, max: 600 });
  const headers = securityHeaders(cfg);
  const staticCache = new Map();

  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    let file;
    try { file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname))); } catch { return false; }
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    let entry = staticCache.get(file);
    if (!entry || !cfg.production) {
      let body;
      try { if (!fs.statSync(file).isFile()) return false; body = fs.readFileSync(file); } catch { return false; }
      entry = { body, etag: '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"' };
      staticCache.set(file, entry);
    }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, { ETag: entry.etag }); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: entry.etag, 'Content-Length': entry.body.length });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
    return true;
  }

  return async function handler(req, res) {
    const started = Date.now();
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    const ctx = { req, res, cfg, db, ip: clientIp(req, cfg), params: {}, query: Object.fromEntries(url.searchParams) };

    try {
      if (pathname === '/healthz') { db.prepare('SELECT 1').get(); return send(res, 200, { ok: true }); }

      if (!pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
        throw new HttpError(404, 'Not found.');
      }

      apiLimiter.take(ctx.ip);
      const match = router.match(req.method, pathname);
      if (!match) throw new HttpError(404, 'Not found.');
      if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
      ctx.params = match.params;

      checkCsrf(req, cfg);
      const session = loadSession(ctx);
      if (session) {
        ctx.user = session;
        ctx.household = db.prepare('SELECT * FROM households WHERE id = ?').get(session.household_id);
      }
      ctx.today = (tz) => todayIn(tz || ctx.household?.timezone);
      const isPublic = PUBLIC_API.some(([m, re]) => m === req.method && re.test(pathname));
      if (!isPublic && !ctx.user) throw new HttpError(401, 'Please sign in.');

      // Statement imports carry the CSV text; everything else stays small.
      ctx.body = await readJson(req, /\/import(\/preview)?$/.test(pathname) ? 8 * 1024 * 1024 : undefined);
      let result;
      for (const h of match.handlers) result = await h(ctx);
      if (result && result.$raw !== undefined) send(res, 200, result.$raw, result.headers);
      else send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        const extra = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
        send(res, err.status, { error: err.message, ...(err.extra?.field ? { field: err.extra.field } : {}) }, extra);
      } else if (/UNIQUE constraint/.test(err?.message)) {
        send(res, 409, { error: 'That already exists.' });
      } else {
        console.error(`[error] ${req.method} ${pathname}:`, err);
        send(res, 500, { error: 'Something went wrong on our side. Try again.' });
      }
    } finally {
      if (cfg.logRequests) {
        res.on('finish', () => console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
      }
    }
  };
}

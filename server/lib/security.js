// Response hardening, CSRF defence and rate limiting.
import { HttpError } from './http.js';

export function securityHeaders(cfg) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(cfg.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    ...(cfg.secureCookies ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

export function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * CSRF: every state-changing API call must (1) carry our custom header, which a cross-site
 * form cannot set and which forces a CORS preflight we never approve, and (2) come from our
 * own origin when the browser tells us the origin. SameSite cookies are a third layer.
 */
export function checkCsrf(req, cfg) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-finta'] !== '1') throw new HttpError(403, 'Request blocked (missing app header).');
  const origin = req.headers.origin;
  if (origin && origin !== cfg.origin) throw new HttpError(403, 'Request blocked (cross-site).');
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Request blocked (cross-site).');
}

/** Fixed-window limiter kept in memory. Fine for a single container. */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs).unref();
  }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
  /** Throws 429 when the key has exceeded its budget. */
  take(key, cost = 1) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count += cost;
    if (e.count > this.max) {
      const secs = Math.ceil((e.reset - now) / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${secs > 90 ? Math.ceil(secs / 60) + ' minutes' : secs + ' seconds'}.`,
        { retryAfter: secs });
    }
  }
  reset(key) { this.hits.delete(key); }
}

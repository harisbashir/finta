// All runtime configuration comes from environment variables (see .env.example).
import path from 'node:path';

function bool(v, dflt = false) {
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
  let url;
  try { url = new URL(appUrl); } catch { throw new Error(`APP_URL is not a valid URL: ${appUrl}`); }

  const secure = url.protocol === 'https:';
  if (production && !secure && !bool(env.ALLOW_INSECURE_HTTP)) {
    throw new Error(
      'APP_URL must start with https:// in production. Put Finta behind a TLS proxy ' +
      '(see compose.yaml) or set ALLOW_INSECURE_HTTP=true for a private LAN only.'
    );
  }

  return {
    production,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    appUrl,
    origin: url.origin,
    rpId: url.hostname,                                   // WebAuthn relying party
    rpName: env.APP_NAME || 'Finta',
    secureCookies: secure,
    cookieName: secure ? '__Host-finta' : 'finta_session', // __Host- requires Secure
    trustProxy: bool(env.TRUST_PROXY),
    sessionDays: Number(env.SESSION_DAYS || 30),
    sessionIdleDays: Number(env.SESSION_IDLE_DAYS || 14),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 20),         // sign-in attempts per IP per 15 min
    allowSignup: bool(env.ALLOW_SIGNUP),                  // open registration of new households
    logRequests: bool(env.LOG_REQUESTS, !production),
  };
}

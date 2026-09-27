// Spins up the real app on an ephemeral port with an in-memory database.
import http from 'node:http';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

export async function startServer(env = {}) {
  const db = openDatabase(':memory:');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = loadConfig({ APP_URL: `http://localhost:${port}`, LOG_REQUESTS: 'false', LOGIN_RATE_LIMIT: '1000', ...env });
  server.on('request', createApp({ cfg, db, setupCode: 'TESTCODE' }));
  const base = `http://127.0.0.1:${port}`;
  return { db, cfg, base, close: () => new Promise((r) => server.close(r)) };
}

/** A tiny cookie-keeping client, like one browser. */
export function client(base) {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-Finta': '1',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}, h) => call('PATCH', p, b, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    raw: call,
    get cookie() { return cookie; },
  };
}

export const OWNER = { setupCode: 'TESTCODE', householdName: 'The Testers', name: 'Alex', email: 'alex@example.com', password: 'correct horse battery', currency: 'CAD', timezone: 'America/Toronto' };

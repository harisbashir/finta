import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { totpCode, currentStep } from '../server/lib/crypto.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('fresh instance asks for setup and refuses a wrong setup code', async () => {
  const c = client(srv.base);
  const boot = await c.get('/api/bootstrap');
  assert.equal(boot.data.needsSetup, true);
  const r = await c.post('/api/setup', { ...OWNER, setupCode: 'WRONG' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'setupCode');
});

test('weak passwords are rejected with a helpful message', async () => {
  const r = await client(srv.base).post('/api/setup', { ...OWNER, password: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /10 characters/);
});

test('setup creates household, signs in, and cannot run twice', async () => {
  const c = client(srv.base);
  const r = await c.post('/api/setup', OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(c.cookie.startsWith('finta_session='));
  const boot = await c.get('/api/bootstrap');
  assert.equal(boot.data.user.email, OWNER.email);
  assert.equal(boot.data.user.password_hash, undefined, 'never leak hashes');
  assert.equal((await client(srv.base).post('/api/setup', { ...OWNER, email: 'x@example.com' })).status, 409);
});

test('API requires a session', async () => {
  const r = await client(srv.base).get('/api/today');
  assert.equal(r.status, 401);
});

test('CSRF: missing app header or foreign origin is blocked', async () => {
  const c = client(srv.base);
  await c.post('/api/login', { email: OWNER.email, password: OWNER.password });
  const noHeader = await fetch(srv.base + '/api/tasks', { method: 'POST', headers: { Cookie: c.cookie, 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(noHeader.status, 403);
  const foreign = await c.post('/api/tasks', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const ok = await c.post('/api/tasks', { title: 'Legit' }, { Origin: srv.cfg.origin });
  assert.equal(ok.status, 200);
});

test('security headers are set on every response', async () => {
  const res = await fetch(srv.base + '/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const traversal = await fetch(srv.base + '/..%2fpackage.json');
  assert.equal(traversal.status, 404);
});

test('wrong password gives one generic answer, and repeated failures lock the account', async () => {
  const c = client(srv.base);
  const unknown = await c.post('/api/login', { email: 'nobody@example.com', password: 'whatever12345' });
  const wrong = await c.post('/api/login', { email: OWNER.email, password: 'wrong password!' });
  assert.equal(unknown.data.error, wrong.data.error);
  // create a separate account to lock, so later tests keep working
  const owner = client(srv.base);
  await owner.post('/api/login', { email: OWNER.email, password: OWNER.password });
  const inv = await owner.post('/api/household/invites');
  const token = inv.data.url.split('/join/')[1];
  const joiner = client(srv.base);
  assert.equal((await joiner.get(`/api/invites/${token}`)).data.household, OWNER.householdName);
  const joined = await joiner.post(`/api/invites/${token}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'another good phrase' });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal((await client(srv.base).post(`/api/invites/${token}/accept`, { name: 'X', email: 'x2@example.com', password: 'another good phrase' })).status, 404, 'invites are single-use');
  for (let i = 0; i < 8; i++) await client(srv.base).post('/api/login', { email: 'sam@example.com', password: 'bad password ' + i });
  const locked = await client(srv.base).post('/api/login', { email: 'sam@example.com', password: 'another good phrase' });
  assert.equal(locked.status, 429);
  srv.db.prepare("UPDATE users SET locked_until = NULL WHERE email = 'sam@example.com'").run();
});

test('two-factor: enable, then sign-in needs a code; codes cannot be replayed; recovery codes work once', async () => {
  const c = client(srv.base);
  await c.post('/api/login', { email: OWNER.email, password: OWNER.password });
  const setup = await c.post('/api/me/2fa/setup', { password: OWNER.password });
  assert.equal(setup.status, 200);
  assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  const bad = await c.post('/api/me/2fa/enable', { code: '000000' });
  assert.equal(bad.status, 400);
  // use the previous step so the next login's current-step code is still fresh
  const enabled = await c.post('/api/me/2fa/enable', { code: totpCode(setup.data.secret, currentStep() - 1) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recoveryCodes.length, 10);

  const d = client(srv.base);
  const step1 = await d.post('/api/login', { email: OWNER.email, password: OWNER.password });
  assert.equal(step1.data.twoFactor, true);
  assert.equal(d.cookie, '', 'no session before the second factor');
  const code = totpCode(setup.data.secret, currentStep());
  const step2 = await d.post('/api/login/2fa', { ticket: step1.data.ticket, code });
  assert.equal(step2.status, 200);
  assert.equal((await d.get('/api/today')).status, 200);

  const e = client(srv.base);
  const again = await e.post('/api/login', { email: OWNER.email, password: OWNER.password });
  assert.equal((await e.post('/api/login/2fa', { ticket: again.data.ticket, code })).status, 400, 'replayed code rejected');
  const rc = enabled.data.recoveryCodes[0];
  assert.equal((await e.post('/api/login/2fa', { ticket: again.data.ticket, code: rc })).status, 200);
  const f = client(srv.base);
  const t3 = await f.post('/api/login', { email: OWNER.email, password: OWNER.password });
  assert.equal((await f.post('/api/login/2fa', { ticket: t3.data.ticket, code: rc })).status, 400, 'recovery code is single-use');

  assert.equal((await c.post('/api/me/2fa/disable', { password: OWNER.password })).status, 200);
});

test('changing password signs out other devices', async () => {
  const a = client(srv.base); const b = client(srv.base);
  await a.post('/api/login', { email: 'sam@example.com', password: 'another good phrase' });
  await b.post('/api/login', { email: 'sam@example.com', password: 'another good phrase' });
  const r = await a.post('/api/me/password', { current: 'another good phrase', password: 'a brand new phrase' });
  assert.equal(r.status, 200);
  assert.equal((await b.get('/api/today')).status, 401);
  assert.equal((await a.get('/api/today')).status, 200);
});

test('households are isolated from each other', async () => {
  const s2 = await startServer({ ALLOW_SIGNUP: 'true' });
  try {
    const a = client(s2.base); const b = client(s2.base);
    assert.equal((await a.post('/api/setup', OWNER)).status, 200);
    assert.equal((await b.post('/api/signup', { ...OWNER, email: 'other@example.com', householdName: 'Neighbours' })).status, 200);
    const task = await a.post('/api/tasks', { title: 'Private' });
    const cats = await a.get('/api/categories');
    assert.equal((await b.patch(`/api/tasks/${task.data.id}`, { title: 'Hacked' })).status, 404);
    assert.equal((await b.del(`/api/tasks/${task.data.id}`)).status, 404);
    assert.ok(!(await b.get('/api/tasks')).data.some((t) => t.id === task.data.id));
    // Cannot point own rows at another household's category.
    const r = await b.post('/api/transactions', { date: '2026-09-01', amount: 100, category_id: cats.data[0].id });
    assert.equal(r.status, 400);
  } finally { await s2.close(); }
});

test('sign out ends the session', async () => {
  const c = client(srv.base);
  await c.post('/api/login', { email: OWNER.email, password: OWNER.password });
  const stolen = c.cookie;
  await c.post('/api/logout');
  const replay = await fetch(srv.base + '/api/today', { headers: { Cookie: stolen } });
  assert.equal(replay.status, 401, 'old cookie is dead server-side');
});

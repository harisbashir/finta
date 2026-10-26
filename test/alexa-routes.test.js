import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { AlexaError } from '../server/lib/alexa/client.js';

// A stub runner: records sync requests and hands out a fake Amazon client.
const calls = [];
let clock = Date.now();
const fakeClient = {
  async startLogin({ password }) {
    if (password === 'wrong') throw new AlexaError('auth', 'Your password is incorrect');
    return { needsCode: password !== 'trusted' };
  },
  async finishLogin(_p, code) {
    if (code === '000000') throw new AlexaError('auth', 'The code you entered is not valid');
    return { refreshToken: 'Atzr|SECRET-REFRESH', cookies: { 'session-token': 'SECRET-COOKIE' }, domain: 'amazon.ca', cookiesAt: Date.now() };
  },
};
const alexa = {
  makeClient: () => fakeClient,
  requestSync: (hid, opts) => calls.push({ hid, ...opts }),
  syncNow: async (hid) => { calls.push({ hid, reason: 'now' }); },
};

let srv, owner, member, hid;
before(async () => {
  srv = await startServer({}, { alexa, clock: () => clock });
  owner = client(srv.base);
  await owner.post('/api/setup', OWNER);
  hid = srv.db.prepare('SELECT id FROM households').get().id;
  const inv = await owner.post('/api/household/invites');
  member = client(srv.base);
  await member.post(`/api/invites/${inv.data.url.split('/join/')[1]}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'another good phrase' });
});
after(async () => { await srv.close(); });
beforeEach(() => { calls.length = 0; clock = Date.now(); });

const connect = async (c = owner) => {
  const r1 = await c.post('/api/alexa/connect', { email: 'me@example.com', password: 'right one' });
  if (r1.status !== 200) return r1;
  return c.post('/api/alexa/code', { code: '123456' });
};

test('migration creates alexa tables and export leaves them out', async () => {
  srv.db.prepare(`INSERT INTO alexa_links (household_id, site, email, login) VALUES (?, 'amazon.ca', 'a@example.com', ?)`)
    .run(hid, JSON.stringify({ refreshToken: 'Atzr|SECRET-REFRESH' }));
  srv.db.prepare(`INSERT INTO alexa_items (household_id, alexa_list_id, alexa_item_id, kind, finta_id, finta_list_id, name, checked, version)
    VALUES (?, 'L1', 'I1', 'item', 1, 1, 'milk', 0, 1)`).run(hid);
  const r = await owner.get('/api/export');
  assert.equal(r.status, 200);
  assert.equal(r.data.alexa_links, undefined);
  assert.equal(r.data.alexa_items, undefined);
  assert.doesNotMatch(JSON.stringify(r.data), /SECRET-REFRESH/);
  srv.db.prepare('DELETE FROM alexa_items').run();
  srv.db.prepare('DELETE FROM alexa_links').run();
});

test('not connected: status says so', async () => {
  const r = await member.get('/api/alexa');
  assert.equal(r.status, 200);
  assert.equal(r.data.connected, false);
});

test('member cannot connect, enter a code, change or disconnect', async () => {
  assert.equal((await member.post('/api/alexa/connect', { email: 'me@example.com', password: 'x' })).status, 403);
  assert.equal((await member.post('/api/alexa/code', { code: '123456' })).status, 403);
  assert.equal((await member.patch('/api/alexa', { shopping_list_id: null })).status, 403);
  assert.equal((await member.del('/api/alexa')).status, 403);
});

test('code without connect is refused', async () => {
  const r = await owner.post('/api/alexa/code', { code: '123456' });
  assert.equal(r.status, 400);
});

test('wrong password shows Amazon’s message', async () => {
  const r = await owner.post('/api/alexa/connect', { email: 'me@example.com', password: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /password is incorrect/);
});

test('connect then code stores the link, starts a sync, and never returns tokens', async () => {
  const r1 = await owner.post('/api/alexa/connect', { email: 'me@example.com', password: 'right one' });
  assert.deepEqual(r1.data, { needsCode: true });
  const r2 = await owner.post('/api/alexa/code', { code: '123456' });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.equal(r2.data.connected, true);
  assert.ok(calls.some((c) => c.reason === 'now'));
  const r3 = await member.get('/api/alexa');
  assert.deepEqual(Object.keys(r3.data).sort(), ['connected', 'email', 'lastError', 'lastErrorAt', 'lastSyncAt', 'shoppingListId', 'site', 'status']);
  assert.equal(r3.data.email, 'me@example.com');
  for (const r of [r2, r3]) assert.doesNotMatch(JSON.stringify(r.data), /SECRET|refresh|cookie|token/i);
  assert.ok(srv.db.prepare(`SELECT 1 FROM audit_log WHERE event = 'alexa.connected'`).get());
});

test('pending sign-in expires after 5 minutes', async () => {
  await owner.post('/api/alexa/connect', { email: 'me@example.com', password: 'right one' });
  clock += 5 * 60000 + 1;
  const r = await owner.post('/api/alexa/code', { code: '123456' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /expired/i);
});

test('owner can pick the shopping list', async () => {
  await connect();
  const list = await owner.post('/api/lists', { name: 'Groceries' });
  const r = await owner.patch('/api/alexa', { shopping_list_id: list.data.id });
  assert.equal(r.status, 200);
  assert.equal(r.data.shoppingListId, list.data.id);
});

test('write routes ask for a sync; reads and other areas do not', async () => {
  const list = await owner.post('/api/lists', { name: 'Hardware' });
  calls.length = 0;
  await owner.post(`/api/lists/${list.data.id}/items`, { name: 'nails' });
  const task = await owner.post('/api/tasks', { title: 'Fix fence' });
  await owner.post(`/api/tasks/${task.data.id}/complete`);
  await owner.post(`/api/lists/${list.data.id}/clear-checked`);
  await owner.get('/api/tasks');
  await owner.post('/api/transactions', { date: '2026-10-01', amount: 100, note: 'x' });
  assert.deepEqual(calls.map((c) => c.reason), ['change', 'change', 'change', 'change']);
  assert.ok(calls.every((c) => c.hid === hid));
});

test('any member can ask for a sync', async () => {
  const r = await member.post('/api/alexa/sync');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ hid, reason: 'view' }]);
});

test('disconnect removes the link and snapshots', async () => {
  await connect();
  srv.db.prepare(`INSERT INTO alexa_items (household_id, alexa_list_id, alexa_item_id, kind, finta_id, name, checked, version) VALUES (?, 'L', 'I9', 'task', 99, 'x', 0, 1)`).run(hid);
  const r = await owner.del('/api/alexa');
  assert.equal(r.status, 200);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM alexa_links').get().n, 0);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM alexa_items').get().n, 0);
  assert.ok(srv.db.prepare(`SELECT 1 FROM audit_log WHERE event = 'alexa.disconnected'`).get());
});

test('connect finishes at once when Amazon skips the code', async () => {
  srv.db.prepare('DELETE FROM alexa_links').run();
  const r = await owner.post('/api/alexa/connect', { email: 'me@example.com', password: 'trusted' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.connected, true);
  assert.equal(r.data.needsCode, undefined);
});

test('sixth connect attempt in 15 minutes is rate limited', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await owner.post('/api/alexa/connect', { email: 'me@example.com', password: 'wrong' })).status);
  assert.equal(codes.at(-1), 429);
});

test('Sync Now asks for an immediate sync', async () => {
  await member.post('/api/alexa/sync', { now: true });
  assert.deepEqual(calls, [{ hid, reason: 'now' }]);
});

test('reminders: upcoming ones with safe fields; Today gets the next two days', async () => {
  srv.db.prepare('DELETE FROM alexa_links').run();
  const now = Date.now();
  srv.db.prepare(`INSERT INTO alexa_links (household_id, site, email, login, reminders) VALUES (?, 'amazon.ca', 'a@example.com', '{}', ?)`).run(hid, JSON.stringify([
    { id: 'old', label: 'long gone', at: now - 3 * 3600e3, repeats: false },
    { id: 'r1', label: 'call mom', at: now + 3600e3, repeats: false },
    { id: 'r2', label: 'dentist', at: now + 5 * 86400e3, repeats: true },
  ]));
  const r = await member.get('/api/alexa/reminders');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, [{ label: 'call mom', at: now + 3600e3, repeats: false }, { label: 'dentist', at: now + 5 * 86400e3, repeats: true }]);
  const t = await member.get('/api/today');
  assert.deepEqual(t.data.reminders.map((x) => x.label), ['call mom']);
});

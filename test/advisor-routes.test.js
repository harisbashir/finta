import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { limitsFor } from '../server/lib/advisor/limits.js';

let srv, owner, member, hid, ownerId, memberId;
before(async () => {
  srv = await startServer();
  owner = client(srv.base);
  await owner.post('/api/setup', OWNER);
  hid = srv.db.prepare('SELECT id FROM households').get().id;
  const inv = await owner.post('/api/household/invites');
  member = client(srv.base);
  await member.post(`/api/invites/${inv.data.url.split('/join/')[1]}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'another good phrase' });
  ownerId = srv.db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER.email).id;
  memberId = srv.db.prepare('SELECT id FROM users WHERE email = ?').get('sam@example.com').id;
});
after(async () => { await srv.close(); });

test('investment account can be marked TFSA; a chequing account cannot keep registered', async () => {
  const a = await owner.post('/api/accounts', { name: 'My TFSA', type: 'investment', registered: 'tfsa' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.registered, 'tfsa');
  const b = await owner.patch(`/api/accounts/${a.data.id}`, { type: 'chequing' });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.registered, null);
  const c = await owner.post('/api/accounts', { name: 'Chq', type: 'chequing', registered: 'rrsp' });
  assert.equal(c.data.registered, null);
});

test('limitsFor: known years, and later years fall back as estimates', () => {
  assert.equal(limitsFor(2026).rrsp, 3381000);
  assert.equal(limitsFor(2026).tfsa, 700000);
  assert.equal(limitsFor(2025).rrsp, 3249000);
  assert.equal(limitsFor(2026).estimate, false);
  const later = limitsFor(2030);
  assert.equal(later.estimate, true);
  assert.equal(later.tfsa, 700000);
  assert.equal(later.fhsaLifetime, 4000000);
});

test('export includes tax_room', async () => {
  srv.db.prepare(`INSERT INTO tax_room (household_id, user_id, year, kind, room) VALUES (?, ?, 2026, 'tfsa', 700000)`).run(hid, ownerId);
  const r = await owner.get('/api/export');
  assert.equal(r.data.tax_room.length, 1);
  srv.db.prepare('DELETE FROM tax_room').run();
});

test('GET /api/advisor returns the three tools and the emergency target', async () => {
  const r = await owner.get('/api/advisor');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data).sort(), ['emergencyMonths', 'fees', 'forecast', 'health']);
  assert.equal(r.data.emergencyMonths, 3);
});

test('only an owner changes the emergency-fund target', async () => {
  assert.equal((await member.patch('/api/advisor/settings', { emergency_months: 6 })).status, 403);
  assert.equal((await owner.patch('/api/advisor/settings', { emergency_months: 30 })).status, 400);
  assert.equal((await owner.patch('/api/advisor/settings', { emergency_months: 6 })).status, 200);
  assert.equal((await owner.get('/api/advisor')).data.emergencyMonths, 6);
});

test('a member sets their own contribution room, not someone else’s', async () => {
  const mine = await member.raw('PUT', '/api/advisor/room', { user_id: memberId, year: 2026, kind: 'tfsa', room: 700000 });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal((await member.raw('PUT', '/api/advisor/room', { user_id: ownerId, year: 2026, kind: 'tfsa', room: 1 })).status, 403);
  assert.equal((await owner.raw('PUT', '/api/advisor/room', { user_id: memberId, year: 2026, kind: 'rrsp', room: 500000 })).status, 200);
  assert.equal((await owner.raw('PUT', '/api/advisor/room', { user_id: memberId, year: 2026, kind: 'resp', room: 1 })).status, 400);
  const tax = await member.get('/api/advisor/tax?year=2026&scope=me');
  assert.equal(tax.data.people[0].contributions.find((c) => c.kind === 'tfsa').room, 700000);
});

test('tax CSV downloads as a file', async () => {
  const res = await fetch(srv.base + '/api/advisor/tax/2025.csv', { headers: { Cookie: owner.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /finta-tax-2025\.csv/);
  assert.match(await res.text(), /^person,section,item,amount/);
  assert.equal((await fetch(srv.base + '/api/advisor/tax/20x5.csv', { headers: { Cookie: owner.cookie } })).status, 404);
});

test('privacy: a member never sees payees from another member’s private account', async () => {
  const acc = await owner.post('/api/accounts', { name: 'Private chq', type: 'chequing', is_private: true });
  for (const d of ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05']) {
    srv.db.prepare(`INSERT INTO transactions (household_id, date, amount, direction, account_id, description, note, merchant)
      VALUES (?, ?, 4200, 'out', ?, 'E-TRANSFER SECRET-PAYEE', 'SECRET-PAYEE', 'SECRET PAYEE')`).run(hid, d, acc.data.id);
  }
  for (const path of ['/api/advisor?scope=household', '/api/advisor/tax?year=2026&scope=household']) {
    const r = await member.get(path);
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.data), /SECRET/i, path);
  }
});

test('/api/today warns when my chequing is heading below $0', async () => {
  const acc = await owner.post('/api/accounts', { name: 'Thin chq', type: 'chequing', current_balance: 1000 });
  assert.equal(acc.status, 200);
  const due = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
  await owner.post('/api/recurring', { name: 'Rent', kind: 'bill', amount: 250000, frequency: 'monthly', start_date: due });
  const t = await owner.get('/api/today');
  assert.equal(t.data.cashWarning.level, 'danger');
  assert.ok(t.data.cashWarning.low.balance < 0);
});

test('clearing room removes it; negative room is refused', async () => {
  await owner.raw('PUT', '/api/advisor/room', { user_id: ownerId, year: 2027, kind: 'fhsa', room: 800000 });
  assert.equal((await owner.raw('PUT', '/api/advisor/room', { user_id: ownerId, year: 2027, kind: 'fhsa', room: -5 })).status, 400);
  assert.equal((await owner.raw('PUT', '/api/advisor/room', { user_id: ownerId, year: 2027, kind: 'fhsa', room: null })).status, 200);
  assert.equal(srv.db.prepare(`SELECT COUNT(*) AS n FROM tax_room WHERE year = 2027`).get().n, 0);
});

test('Today only warns when chequing goes below $0, not when it is merely low', async () => {
  srv.db.prepare('DELETE FROM recurring').run();
  srv.db.prepare(`UPDATE accounts SET archived = 1 WHERE type = 'chequing'`).run();
  await owner.post('/api/accounts', { name: 'Low chq', type: 'chequing', current_balance: 5000 });
  assert.equal((await owner.get('/api/today')).data.cashWarning, null);
});

test('Looks Recurring never shows notes from someone else’s private account', async () => {
  const acc = await owner.post('/api/accounts', { name: 'Owner private', type: 'chequing', is_private: true });
  for (const d of ['2026-06-07', '2026-07-07', '2026-08-07', '2026-09-07']) {
    srv.db.prepare(`INSERT INTO transactions (household_id, date, amount, direction, account_id, note, merchant)
      VALUES (?, ?, 8800, 'out', ?, 'HIDDEN-NOTE', 'HIDDEN THING')`).run(hid, d, acc.data.id);
  }
  const r = await member.get('/api/money/suggestions');
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.data), /HIDDEN/);
  assert.match(JSON.stringify((await owner.get('/api/money/suggestions')).data), /HIDDEN/, 'the owner still sees their own');
});

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

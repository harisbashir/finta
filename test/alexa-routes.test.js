import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';

let srv, c, hid;

before(async () => {
  srv = await startServer();
  c = client(srv.base);
  await c.post('/api/setup', OWNER);
  hid = srv.db.prepare('SELECT id FROM households').get().id;
});
after(async () => { await srv.close(); });

test('migration creates alexa tables and export leaves them out', async () => {
  srv.db.prepare(`INSERT INTO alexa_links (household_id, site, email, login) VALUES (?, 'amazon.ca', 'a@example.com', ?)`)
    .run(hid, JSON.stringify({ refreshToken: 'Atzr|SECRET-REFRESH' }));
  srv.db.prepare(`INSERT INTO alexa_items (household_id, alexa_list_id, alexa_item_id, kind, finta_id, finta_list_id, name, checked, version)
    VALUES (?, 'L1', 'I1', 'item', 1, 1, 'milk', 0, 1)`).run(hid);
  const r = await c.get('/api/export');
  assert.equal(r.status, 200);
  assert.equal(r.data.alexa_links, undefined);
  assert.equal(r.data.alexa_items, undefined);
  assert.doesNotMatch(JSON.stringify(r.data), /SECRET-REFRESH/);
  srv.db.prepare('DELETE FROM alexa_items').run();
  srv.db.prepare('DELETE FROM alexa_links').run();
});

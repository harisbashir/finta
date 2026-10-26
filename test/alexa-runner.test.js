import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createAlexaRunner } from '../server/lib/alexa/runner.js';
import { AlexaError } from '../server/lib/alexa/client.js';
import { today } from '../server/lib/dates.js';

const quiet = { log() {}, warn() {}, error() {} };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// An in-memory Alexa with the same Session interface as client.js.
function fakeAlexa() {
  const lists = [{ id: 'S', type: 'SHOP', name: null, items: [] }, { id: 'T', type: 'TODO', name: null, items: [] }];
  const calls = [];
  const fail = {};
  const reminders = [];
  let n = 0;
  let gate = null;
  const find = (id) => lists.find((l) => l.id === id);
  const session = () => ({
    async getLists() { calls.push('getLists'); if (fail.lists) throw fail.lists; return lists.map(({ id, type, name }) => ({ id, type, name })); },
    async getItems(id) {
      calls.push(`getItems:${id}`);
      if (gate) await gate;
      if (fail.getItemsOnce?.[id]?.length) throw fail.getItemsOnce[id].shift();
      if (fail.emptyOnce?.[id]) { fail.emptyOnce[id]--; return []; }
      return find(id).items.slice(0, 100).map((i) => ({ ...i }));
    },
    async addItem(id, name) { calls.push('add'); if (fail.add) throw fail.add; find(id).items.push({ itemId: `n${++n}`, name, checked: false, version: 1 }); },
    async updateItem(id, itemId, version, { name, checked }) {
      calls.push('update');
      if (fail.update) throw fail.update;
      if (fail.untick && checked === false) throw fail.untick;
      const it = find(id).items.find((i) => i.itemId === itemId);
      if (name !== undefined) it.name = name;
      if (checked !== undefined) it.checked = checked;
      it.version++;
    },
    async getReminders() { calls.push('reminders'); if (fail.reminders) throw fail.reminders; return reminders; },
    async deleteItem(id, itemId) { calls.push('delete'); find(id).items = find(id).items.filter((i) => i.itemId !== itemId); },
  });
  return { lists, calls, fail, reminders, setGate: (p) => { gate = p; }, client: { session }, shop: () => find('S').items, todo: () => find('T').items };
}

let db, hid, groceries, fake, runner;
beforeEach(() => {
  db = openDatabase(':memory:');
  hid = Number(db.prepare(`INSERT INTO households (name, timezone) VALUES ('H', 'America/Toronto')`).run().lastInsertRowid);
  groceries = Number(db.prepare(`INSERT INTO shopping_lists (household_id, name) VALUES (?, 'Groceries')`).run(hid).lastInsertRowid);
  db.prepare(`INSERT INTO alexa_links (household_id, site, email, login) VALUES (?, 'amazon.ca', 'a@example.com', ?)`)
    .run(hid, JSON.stringify({ refreshToken: 'RT', cookies: {}, domain: 'amazon.ca', cookiesAt: Date.now() }));
  fake = fakeAlexa();
  runner = createAlexaRunner({ db, makeClient: () => fake.client, debounceMs: 5, log: quiet });
});

const items = (listId = groceries) => db.prepare('SELECT name, checked FROM shopping_items WHERE list_id = ? ORDER BY id').all(listId).map((r) => ({ ...r }));
const link = () => db.prepare('SELECT * FROM alexa_links WHERE household_id = ?').get(hid);
const addFinta = (name, listId = groceries) => db.prepare('INSERT INTO shopping_items (household_id, list_id, name) VALUES (?, ?, ?)').run(hid, listId, name);

test('pulls Alexa shopping items into the chosen list', async () => {
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  await runner.syncNow(hid);
  assert.deepEqual(items(), [{ name: 'milk', checked: 0 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alexa_items').get().n, 1);
  assert.ok(link().last_sync_at);
  assert.equal(link().last_error, null);
});

test('pushes a new Finta item and links it after re-fetch', async () => {
  addFinta('eggs');
  await runner.syncNow(hid);
  assert.deepEqual(fake.shop().map((i) => i.name), ['eggs']);
  const snap = db.prepare('SELECT * FROM alexa_items').get();
  assert.equal(snap.alexa_item_id, fake.shop()[0].itemId);
  assert.equal(snap.finta_list_id, groceries);
  await runner.syncNow(hid);
  assert.equal(fake.shop().length, 1, 'no duplicate on the next run');
});

test('ticking a repeating task on Alexa rolls it forward and unticks it on Alexa', async () => {
  const due = today('America/Toronto');
  db.prepare(`INSERT INTO tasks (household_id, title, due_date, repeat) VALUES (?, 'water plants', ?, 'weekly')`).run(hid, due);
  await runner.syncNow(hid);
  assert.equal(fake.todo().length, 1);
  fake.todo()[0].checked = true;
  await runner.syncNow(hid);
  const t = db.prepare('SELECT * FROM tasks').get();
  assert.equal(t.done_at, null);
  assert.ok(t.due_date > due, 'rolled forward');
  assert.equal(fake.todo()[0].checked, false);
});

test('a plain task ticked on Alexa is done in Finta', async () => {
  fake.todo().push({ itemId: 't1', name: 'call plumber', checked: false, version: 1 });
  await runner.syncNow(hid);
  fake.todo()[0].checked = true;
  await runner.syncNow(hid);
  assert.ok(db.prepare('SELECT done_at FROM tasks').get().done_at);
});

test('custom Alexa list creates a Finta list with that name', async () => {
  fake.lists.push({ id: 'C', type: 'CUSTOM', name: 'Costco', items: [{ itemId: 'c1', name: 'paper towels', checked: false, version: 1 }] });
  await runner.syncNow(hid);
  const costco = db.prepare(`SELECT id FROM shopping_lists WHERE name = 'Costco'`).get();
  assert.ok(costco);
  assert.deepEqual(items(costco.id), [{ name: 'paper towels', checked: 0 }]);
});

test('changing shopping_list_id does not delete Alexa items', async () => {
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  await runner.syncNow(hid);
  const other = Number(db.prepare(`INSERT INTO shopping_lists (household_id, name) VALUES (?, 'Other')`).run(hid).lastInsertRowid);
  db.prepare('UPDATE alexa_links SET shopping_list_id = ?').run(other);
  await runner.syncNow(hid);
  assert.equal(fake.calls.filter((c) => c === 'delete').length, 0);
  assert.deepEqual(items(other), [{ name: 'milk', checked: 0 }]);
});

test('deleting a Finta list does not delete Alexa items', async () => {
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  await runner.syncNow(hid);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(groceries);
  await runner.syncNow(hid);
  assert.equal(fake.calls.filter((c) => c === 'delete').length, 0);
  assert.equal(fake.shop().length, 1);
});

test('a deleted item whose id is reused is deleted on Alexa, not renamed', async () => {
  addFinta('milk');
  await runner.syncNow(hid);
  const id = db.prepare('SELECT id FROM shopping_items').get().id;
  db.prepare('DELETE FROM shopping_items').run();
  db.prepare(`INSERT INTO shopping_items (id, household_id, list_id, name, created_at) VALUES (?, ?, ?, 'eggs', datetime('now', '+1 minute'))`).run(id, hid, groceries);
  await runner.syncNow(hid);
  assert.deepEqual(fake.shop().map((i) => i.name), ['eggs']);
  assert.equal(fake.calls.filter((c) => c === 'delete').length, 1);
});

test('one failing Alexa call: others applied, last_error set, failed snapshot unchanged', async () => {
  addFinta('milk');
  await runner.syncNow(hid);
  db.prepare(`UPDATE shopping_items SET name = 'oat milk' WHERE name = 'milk'`).run();
  addFinta('eggs');
  fake.fail.update = new AlexaError('network', 'down');
  await runner.syncNow(hid);
  assert.deepEqual(fake.shop().map((i) => i.name).sort(), ['eggs', 'milk']);
  assert.match(link().last_error, /down/);
  assert.equal(db.prepare(`SELECT name FROM alexa_items WHERE alexa_item_id = ?`).get(fake.shop()[0].itemId).name, 'milk');
  delete fake.fail.update;
  await runner.syncNow(hid);
  assert.deepEqual(fake.shop().map((i) => i.name).sort(), ['eggs', 'oat milk']);
  assert.equal(link().last_error, null);
});

test('auth error sets status reconnect and requestSync then no-ops', async () => {
  fake.fail.lists = new AlexaError('auth', 'revoked');
  await runner.syncNow(hid);
  assert.equal(link().status, 'reconnect');
  const before = fake.calls.length;
  runner.requestSync(hid, { reason: 'change' });
  await tick();
  assert.equal(fake.calls.length, before);
});

test('disconnect during a run writes nothing afterwards', async () => {
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  let open;
  fake.setGate(new Promise((r) => { open = r; }));
  const run = runner.syncNow(hid);
  await tick();
  db.prepare('DELETE FROM alexa_links').run();
  open();
  await run;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alexa_items').get().n, 0);
  assert.deepEqual(items(), []);
  assert.equal(link(), undefined);
});

test('requestSync view within 60 s of last sync does not run', async () => {
  await runner.syncNow(hid);
  const before = fake.calls.length;
  runner.requestSync(hid, { reason: 'view' });
  await tick();
  assert.equal(fake.calls.length, before);
});

test('requestSync change runs after the debounce', async () => {
  await runner.syncNow(hid);
  addFinta('bread');
  runner.requestSync(hid, { reason: 'change' });
  await tick(60);
  assert.deepEqual(fake.shop().map((i) => i.name), ['bread']);
});

test('requestSync for a household without Alexa does nothing', async () => {
  db.prepare('DELETE FROM alexa_links').run();
  runner.requestSync(hid, { reason: 'change' });
  await tick();
  assert.equal(fake.calls.length, 0);
});

test('a long custom list name maps to one Finta list across runs', async () => {
  const name = 'Things to pick up from the hardware store this weekend';
  fake.lists.push({ id: 'C', type: 'CUSTOM', name, items: [{ itemId: 'c1', name: 'screws', checked: false, version: 1 }] });
  for (let i = 0; i < 3; i++) await runner.syncNow(hid);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_lists').get().n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM shopping_items WHERE name = 'screws'`).get().n, 1);
});

test('a list at the 100-item limit is left alone and reported', async () => {
  for (let i = 0; i < 105; i++) fake.shop().push({ itemId: `x${i}`, name: `thing ${i}`, checked: true, version: 1 });
  addFinta('eggs');
  await runner.syncNow(hid);
  await runner.syncNow(hid);
  assert.equal(fake.calls.filter((c) => c === 'add').length, 0);
  assert.deepEqual(items(), [{ name: 'eggs', checked: 0 }]);
  assert.match(link().last_error, /100/);
});

test('only open and recently done tasks sync', async () => {
  db.prepare(`INSERT INTO tasks (household_id, title, done_at) VALUES (?, 'old chore', datetime('now', '-30 days'))`).run(hid);
  db.prepare(`INSERT INTO tasks (household_id, title, done_at) VALUES (?, 'recent chore', datetime('now', '-2 days'))`).run(hid);
  await runner.syncNow(hid);
  assert.deepEqual(fake.todo().map((i) => i.name), ['recent chore']);
});

test('a repeating task is not rolled twice when unticking on Alexa fails', async () => {
  const due = today('America/Toronto');
  db.prepare(`INSERT INTO tasks (household_id, title, due_date, repeat) VALUES (?, 'water plants', ?, 'weekly')`).run(hid, due);
  await runner.syncNow(hid);
  fake.todo()[0].checked = true;
  fake.fail.untick = new AlexaError('network', 'down');
  await runner.syncNow(hid);
  const once = db.prepare('SELECT due_date FROM tasks').get().due_date;
  delete fake.fail.untick;
  await runner.syncNow(hid);
  assert.equal(db.prepare('SELECT due_date FROM tasks').get().due_date, once, 'rolled once');
  assert.equal(fake.todo()[0].checked, false);
});

test('one empty fetch does not delete Finta items; a second one does', async () => {
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 }, { itemId: 'b', name: 'eggs', checked: false, version: 1 });
  await runner.syncNow(hid);
  fake.fail.emptyOnce = { S: 2 };
  await runner.syncNow(hid);
  assert.equal(items().length, 2);
  fake.shop().length = 0;
  await runner.syncNow(hid);
  await runner.syncNow(hid);
  assert.equal(items().length, 0);
});

test('a failed re-fetch after adding still applies the Finta side', async () => {
  addFinta('eggs');
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  fake.fail.getItemsOnce = { S: [] };
  const original = fake.client.session;
  let n = 0;
  fake.client.session = (l) => { const s = original(l); const g = s.getItems; s.getItems = async (id) => { if (id === 'S' && ++n === 2) throw new AlexaError('network', 'blip'); return g(id); }; return s; };
  runner = createAlexaRunner({ db, makeClient: () => fake.client, debounceMs: 5, log: quiet });
  await runner.syncNow(hid);
  assert.deepEqual(items().map((i) => i.name).sort(), ['eggs', 'milk']);
});

test('requestSync now runs even right after a sync', async () => {
  await runner.syncNow(hid);
  const before = fake.calls.length;
  runner.requestSync(hid, { reason: 'now' });
  await tick();
  assert.ok(fake.calls.length > before);
});

test('a custom Alexa list named like the Shopping List pairing gets its own "(Alexa)" list', async () => {
  fake.lists.push({ id: 'C', type: 'CUSTOM', name: 'groceries', items: [{ itemId: 'c1', name: 'flour', checked: false, version: 1 }] });
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  for (let i = 0; i < 2; i++) await runner.syncNow(hid);
  const own = db.prepare(`SELECT id FROM shopping_lists WHERE name = 'groceries (Alexa)'`).get();
  assert.ok(own);
  assert.deepEqual(items(own.id), [{ name: 'flour', checked: 0 }]);
  assert.deepEqual(items(), [{ name: 'milk', checked: 0 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_lists').get().n, 2);
});

test('reminders are saved on each run', async () => {
  fake.reminders.push({ id: 'r1', label: 'call mom', at: 1000, repeats: false });
  await runner.syncNow(hid);
  assert.deepEqual(JSON.parse(link().reminders), [{ id: 'r1', label: 'call mom', at: 1000, repeats: false }]);
});

test('a reminders failure does not stop list sync', async () => {
  fake.fail.reminders = new AlexaError('network', 'reminders down');
  fake.shop().push({ itemId: 'a', name: 'milk', checked: false, version: 1 });
  await runner.syncNow(hid);
  assert.deepEqual(items(), [{ name: 'milk', checked: 0 }]);
  assert.match(link().last_error, /reminders down/);
});

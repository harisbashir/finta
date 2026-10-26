import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHousehold } from './advisor-helpers.js';
import { taxYear, taxCsv, defaultTaxYear } from '../server/lib/advisor/tax.js';

const person = (r, id) => r.people.find((p) => p.user_id === id);
const contrib = (p, kind) => p.contributions.find((c) => c.kind === kind);

function setup() {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 0 });
  return { h, chq };
}

test('yearly totals for donations, medical, tuition and kids', () => {
  const { h, chq } = setup();
  h.cat('Charity'); h.cat('Education');
  h.tx({ date: '2025-03-01', amount: 10000, category: 'Charity', account_id: chq });
  h.tx({ date: '2025-12-24', amount: 5000, category: 'Gifts', account_id: chq });
  h.tx({ date: '2025-05-01', amount: 20000, category: 'Health', account_id: chq });
  h.tx({ date: '2025-05-09', amount: 5000, direction: 'in', category: 'Health', account_id: chq });   // claim refund
  h.tx({ date: '2025-09-01', amount: 300000, category: 'Education', account_id: chq });
  h.tx({ date: '2026-01-02', amount: 99999, category: 'Charity', account_id: chq });                // next year
  const p = person(taxYear(h.db, h.hid, 2025), h.owner);
  assert.deepEqual(p.totals, { charity: 15000, medical: 15000, tuition: 300000, kids: 0 });
});

test('RRSP contributions in the first 60 days count for the year before', () => {
  const { h } = setup();
  const rrsp = h.account({ type: 'investment', registered: 'rrsp', balance: 0 });
  h.tx({ date: '2026-02-20', amount: 100000, direction: 'in', account_id: rrsp, is_transfer: 1 });
  h.tx({ date: '2026-03-05', amount: 50000, direction: 'in', account_id: rrsp, is_transfer: 1 });
  assert.equal(contrib(person(taxYear(h.db, h.hid, 2025), h.owner), 'rrsp').amount, 100000);
  assert.equal(contrib(person(taxYear(h.db, h.hid, 2026), h.owner), 'rrsp').amount, 50000);
});

test('TFSA room, limit and what is left; interest inside it is not a contribution', () => {
  const { h } = setup();
  const tfsa = h.account({ type: 'investment', registered: 'tfsa', balance: 0 });
  h.db.prepare(`INSERT INTO tax_room (household_id, user_id, year, kind, room) VALUES (?, ?, 2026, 'tfsa', 700000)`).run(h.hid, h.owner);
  h.tx({ date: '2026-02-01', amount: 150000, direction: 'in', account_id: tfsa, is_transfer: 1 });
  h.tx({ date: '2026-06-01', amount: 50000, direction: 'in', account_id: tfsa });
  h.tx({ date: '2026-06-30', amount: 1234, direction: 'in', account_id: tfsa, category: 'Other Income' });
  const c = contrib(person(taxYear(h.db, h.hid, 2026), h.owner), 'tfsa');
  assert.deepEqual(c, { kind: 'tfsa', amount: 200000, room: 700000, limit: 700000, remaining: 500000 });
});

test('RESP grant is 20% of contributions up to $2,500', () => {
  const { h } = setup();
  const resp = h.account({ type: 'investment', registered: 'resp', balance: 0 });
  h.tx({ date: '2026-04-01', amount: 400000, direction: 'in', account_id: resp, is_transfer: 1 });
  assert.deepEqual(person(taxYear(h.db, h.hid, 2026), h.owner).resp, { contributed: 400000, grant: 50000 });
});

test('scope me shows only me; household adds Joint', () => {
  const { h } = setup();
  const joint = h.account({ type: 'chequing', owner_id: null, balance: 0 });
  h.tx({ date: '2026-02-01', amount: 7000, category: 'Health', account_id: joint });
  const me = taxYear(h.db, h.hid, 2026, { scope: 'me', userId: h.owner });
  assert.deepEqual(me.people.map((p) => p.user_id), [h.owner]);
  const all = taxYear(h.db, h.hid, 2026);
  assert.deepEqual(all.people.map((p) => p.name), ['Alex', 'Sam', 'Joint']);
  assert.equal(all.people.at(-1).totals.medical, 7000);
  assert.deepEqual(all.people.at(-1).contributions, []);
});

test('years past the newest known limits are estimates', () => {
  const { h } = setup();
  assert.equal(taxYear(h.db, h.hid, 2030).estimate, true);
  assert.equal(taxYear(h.db, h.hid, 2026).estimate, false);
});

test('CSV has a header and one row per item, in dollars', () => {
  const { h, chq } = setup();
  h.cat('Charity');
  h.tx({ date: '2026-03-01', amount: 12345, category: 'Charity', account_id: chq });
  const csv = taxCsv(taxYear(h.db, h.hid, 2026, { scope: 'me', userId: h.owner }));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'person,section,item,amount');
  assert.ok(lines.includes('Alex,Credits & deductions,Donations,123.45'));
});

test('default tax year flips on May 1', () => {
  assert.equal(defaultTaxYear('2026-04-30'), 2025);
  assert.equal(defaultTaxYear('2026-05-01'), 2026);
});

test('joint registered accounts show on the Joint row', () => {
  const { h } = setup();
  const resp = h.account({ type: 'investment', registered: 'resp', owner_id: null, balance: 0 });
  h.tx({ date: '2026-04-01', amount: 250000, direction: 'in', account_id: resp, is_transfer: 1 });
  const joint = taxYear(h.db, h.hid, 2026).people.at(-1);
  assert.deepEqual(joint.resp, { contributed: 250000, grant: 50000 });
});

test('dividends, interest and sales inside a plan are not contributions', () => {
  const { h } = setup();
  const tfsa = h.account({ type: 'investment', registered: 'tfsa', balance: 0 });
  h.tx({ date: '2026-04-01', amount: 100000, direction: 'in', account_id: tfsa, is_transfer: 1 });
  for (const d of ['DIVIDEND XYZ', 'INTEREST', 'DISTRIBUTION ABC FUND', 'SOLD 10 XYZ']) h.tx({ date: '2026-05-01', amount: 5000, direction: 'in', account_id: tfsa, description: d });
  assert.equal(contrib(person(taxYear(h.db, h.hid, 2026), h.owner), 'tfsa').amount, 100000);
});

test('2023 and 2024 limits are the published ones', async () => {
  const { limitsFor } = await import('../server/lib/advisor/limits.js');
  assert.deepEqual([limitsFor(2023).tfsa, limitsFor(2023).rrsp, limitsFor(2023).estimate], [650000, 3078000, false]);
  assert.deepEqual([limitsFor(2024).tfsa, limitsFor(2024).rrsp, limitsFor(2024).estimate], [700000, 3156000, false]);
});

test('CSV cells cannot start a spreadsheet formula', () => {
  const { h } = setup();
  h.db.prepare(`UPDATE users SET name = '=HYPERLINK("http://x")' WHERE id = ?`).run(h.owner);
  const csv = taxCsv(taxYear(h.db, h.hid, 2026, { scope: 'me', userId: h.owner }));
  assert.ok(csv.split('\n')[1].startsWith(`"'=HYPERLINK`), csv.split('\n')[1]);
});

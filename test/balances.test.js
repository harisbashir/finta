// 1.1.2: payee names past bank labels, dated balances, statement closing balance, and the data upgrade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { merchantKey, displayName, guessCategory } from '../server/lib/merchant.js';
import { statementBalance } from '../server/lib/importer.js';
import { merchantKeys, balanceAnchors } from '../server/lib/upgrades.js';
import { today, addDays } from '../server/lib/dates.js';

test('payee is read past bank labels (Scotiabank-style details)', () => {
  const cases = [
    ['Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE PAY TO: CRA 608511357900', 'CRA'],
    ['Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE TIM HORTONS #2291 TORONTO ON', 'TIM HORTONS'],
    ['Point of Sale - Interac RETAIL PURCHASE 000001234567 NO FRILLS #3421', 'NO FRILLS'],
    ['Internet Banking E-TRANSFER 106129579322 ALI MOHAMMAD MUBIN MMALIK', 'ALI MOHAMMAD MUBIN'],
    ['INTERAC e-Transfer From: JOHN SMITH', 'JOHN SMITH'],
    ['Branch Transaction INTEREST', 'INTEREST'],
    ['Branch Transaction SERVICE CHARGE MONTHLY FEES', 'SERVICE CHARGE MONTHLY'],
    ['MB-BILL PAYMENT TORONTO HYDRO', 'TORONTO HYDRO'],
    ['POS PURCHASE TIM HORTONS #2291 TORONTO ON', 'TIM HORTONS'],
    ['Deposit', 'DEPOSIT'],
  ];
  for (const [text, key] of cases) assert.equal(merchantKey(text), key, text);
  assert.equal(displayName('CRA'), 'CRA');
  assert.equal(guessCategory('Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE PAY TO: CRA 608511357900', 'out'), 'Taxes');
  assert.equal(guessCategory('Branch Transaction INTEREST', 'in'), 'Other Income');
  assert.equal(guessCategory('Branch Transaction INTEREST', 'out'), 'Fees & Interest');
  assert.equal(guessCategory('Customer Transfer Dr. MB-FREE TRANSFER', 'out'), 'Transfer');
});

test('statement closing balance: the last row of the last day, in either file order', () => {
  const acct = { type: 'chequing' };
  // Three rows on the 24th: 1000 → −50 → 950 → +200 → 1150 → −25 → 1125 (closing).
  const oldestFirst = [
    { date: '2026-09-20', direction: 'in', amount: 100000, balance: 100000 },
    { date: '2026-09-24', direction: 'out', amount: 5000, balance: 95000 },
    { date: '2026-09-24', direction: 'in', amount: 20000, balance: 115000 },
    { date: '2026-09-24', direction: 'out', amount: 2500, balance: 112500 },
  ];
  assert.deepEqual(statementBalance(oldestFirst, acct), { date: '2026-09-24', amount: 112500 });
  assert.deepEqual(statementBalance([...oldestFirst].reverse(), acct), { date: '2026-09-24', amount: 112500 });
  // Shuffled same-day rows still resolve by the running balance.
  assert.deepEqual(statementBalance([oldestFirst[3], oldestFirst[1], oldestFirst[0], oldestFirst[2]], acct), { date: '2026-09-24', amount: 112500 });
  // Cards: balance owed goes up with purchases, and is stored as negative.
  const card = [
    { date: '2026-09-24', direction: 'out', amount: 1000, balance: 51000 },
    { date: '2026-09-24', direction: 'out', amount: 2000, balance: 53000 },
  ];
  assert.deepEqual(statementBalance([...card].reverse(), { type: 'credit_card' }), { date: '2026-09-24', amount: -53000 });
});

let srv, owner;
const d = today('America/Toronto');
const csv = (rows) => ['Date,Details,Debit,Credit', ...rows.map((r) => r.join(','))].join('\n');

before(async () => {
  srv = await startServer();
  owner = client(srv.base);
  await owner.post('/api/setup', OWNER);
});
after(async () => { await srv.close(); });

test('a balance typed today stays right when older statements are imported afterwards', async () => {
  const acc = (await owner.post('/api/accounts', { name: 'Scotia Chequing', type: 'chequing', current_balance: 250000 })).data;
  assert.equal(acc.balance, 250000);
  assert.equal(acc.balance_date, d);
  const past = csv([[addDays(d, -40), 'Payroll Deposit ACME', '', '3000.00'], [addDays(d, -30), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE LOBLAWS', '120.00', '']]);
  await owner.post(`/api/accounts/${acc.id}/import`, { csv: past });
  assert.equal((await owner.get(`/api/accounts/${acc.id}`)).data.balance, 250000, 'history before the balance date is already in it');
  // Something that happens after today's balance moves it.
  srv.db.prepare(`UPDATE accounts SET anchor_date = ? WHERE id = ?`).run(addDays(d, -35), acc.id);
  assert.equal((await owner.get(`/api/accounts/${acc.id}`)).data.balance, 250000 - 12000);
});

test('closing balance typed in the import preview pins the balance to the statement end date', async () => {
  const acc = (await owner.post('/api/accounts', { name: 'Savings', type: 'savings' })).data;
  const rows = csv([[addDays(d, -20), 'Branch Transaction INTEREST', '', '10.61'], [addDays(d, -5), 'Internet Banking INTERNET TRANSFER 000000123456', '', '500.00']]);
  const r = await owner.post(`/api/accounts/${acc.id}/import`, { csv: rows, closingBalance: { amount: 1234567 } });
  assert.deepEqual(r.data.balanceUpdated, { date: addDays(d, -5), amount: 1234567 });
  const a = (await owner.get(`/api/accounts/${acc.id}`)).data;
  assert.equal(a.balance, 1234567);
  assert.equal(a.balance_source, 'statement');
  // An older statement doesn't override the newer balance.
  const older = csv([[addDays(d, -60), 'Branch Transaction INTEREST', '', '9.80']]);
  const r2 = await owner.post(`/api/accounts/${acc.id}/import`, { csv: older, closingBalance: { amount: 100 } });
  assert.ok(r2.data.balanceKept);
  assert.equal((await owner.get(`/api/accounts/${acc.id}`)).data.balance, 1234567);
  // Interest is sorted automatically.
  const tx = (await owner.get(`/api/accounts/${acc.id}/transactions`)).data;
  assert.ok(tx.filter((t) => t.merchant === 'INTEREST').every((t) => t.category_name === 'Other Income' || t.category_id), JSON.stringify(tx));
});

test('editing the balance with a date re-pins it; future dates are refused', async () => {
  const acc = (await owner.post('/api/accounts', { name: 'Visa', type: 'credit_card' })).data;
  await owner.post(`/api/accounts/${acc.id}/import`, { csv: csv([[addDays(d, -3), 'STARBUCKS', '5.00', ''], [addDays(d, -1), 'AMAZON', '20.00', '']]) });
  const p = await owner.patch(`/api/accounts/${acc.id}`, { current_balance: 10000, balance_date: addDays(d, -2) });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.owed, 10000 + 2000, 'owed on that date, plus the purchase after it');
  assert.equal((await owner.patch(`/api/accounts/${acc.id}`, { current_balance: 1, balance_date: addDays(d, 3) })).status, 400);
});

test('Review groups by payee, not by bank label', async () => {
  const acc = (await owner.post('/api/accounts', { name: 'Chequing 2', type: 'chequing' })).data;
  await owner.post(`/api/accounts/${acc.id}/import`, { csv: csv([
    [addDays(d, -9), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE ZORBLAX EMPORIUM 1234', '40.00', ''],
    [addDays(d, -8), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE QUIBBLE HOUSE 99', '15.00', ''],
    [addDays(d, -7), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE ZORBLAX EMPORIUM 1234', '10.00', ''],
  ]) });
  const rv = (await owner.get('/api/review')).data;
  const z = rv.groups.find((g) => g.key === 'ZORBLAX EMPORIUM');
  assert.ok(z, JSON.stringify(rv.groups.map((g) => g.key)));
  assert.equal(z.rows.length, 2);
  assert.equal(z.total, 5000);
  assert.ok(rv.groups.find((g) => g.key === 'QUIBBLE HOUSE'));
  assert.ok(!rv.groups.some((g) => /POINT OF SALE/.test(g.key)));
});

test('upgrade: rows keyed by a bank label are re-keyed, and a rule learned for the label is removed', async () => {
  const acc = (await owner.post('/api/accounts', { name: 'Old Import', type: 'chequing' })).data;
  await owner.post(`/api/accounts/${acc.id}/import`, { csv: csv([
    [addDays(d, -9), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE FLIBBER CO 1', '40.00', ''],
    [addDays(d, -8), 'Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE WOBBLE SHOP 2', '15.00', ''],
  ]) });
  const hid = srv.db.prepare('SELECT household_id FROM accounts WHERE id = ?').get(acc.id).household_id;
  const groceries = srv.db.prepare("SELECT id FROM categories WHERE household_id = ? AND name = 'Groceries'").get(hid).id;
  // Recreate what 1.1.1 stored: the label as merchant, and a rule learned from it.
  srv.db.prepare("UPDATE transactions SET merchant = 'POINT OF SALE', note = 'Point of Sale', category_id = ?, cat_source = 'rule' WHERE account_id = ?").run(groceries, acc.id);
  srv.db.prepare("INSERT INTO rules (household_id, pattern, kind, category_id) VALUES (?, 'POINT OF SALE', 'categorize', ?)").run(hid, groceries);
  merchantKeys(srv.db);
  const rows = srv.db.prepare('SELECT merchant, note, category_id FROM transactions WHERE account_id = ? ORDER BY date').all(acc.id);
  assert.deepEqual(rows.map((r) => r.merchant), ['FLIBBER CO', 'WOBBLE SHOP']);
  assert.deepEqual(rows.map((r) => r.note), ['Flibber Co', 'Wobble Shop']);
  assert.ok(rows.every((r) => r.category_id === null), 'the label rule’s guesses go back to Review');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE pattern = 'POINT OF SALE'").get().n, 0);
});

test('upgrade: a balance typed at creation (1.1.1) is pinned to the day it was typed', () => {
  const hid = srv.db.prepare('SELECT id FROM households LIMIT 1').get().id;
  const id = Number(srv.db.prepare(`INSERT INTO accounts (household_id, name, type, opening_balance, created_at) VALUES (?, 'Legacy', 'chequing', 500000, ?)`)
    .run(hid, `${addDays(d, -1)} 15:00:00`).lastInsertRowid);
  srv.db.prepare(`INSERT INTO transactions (household_id, account_id, date, amount, direction, description, merchant) VALUES (?, ?, ?, 99900, 'out', 'OLD', 'OLD')`).run(hid, id, addDays(d, -100));
  balanceAnchors(srv.db);
  const a = srv.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  assert.equal(a.anchor_balance, 500000);
  assert.ok(a.anchor_date >= addDays(d, -2) && a.anchor_date <= addDays(d, -1));
});

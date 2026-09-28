import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { parseCsv, parseAmount, parseDate, detectMapping, extractRows } from '../server/lib/csv.js';
import { today, addDays, addMonths } from '../server/lib/dates.js';
import { simulate } from '../server/lib/debts.js';

// ───────── Parsing ─────────

test('CSV parser handles quotes, commas in fields, CRLF, BOM and blank lines', () => {
  const rows = parseCsv('﻿Date,Details,Debit,Credit\r\n2026-09-01,"LOBLAWS, #12",45.10,\r\n\r\n2026-09-02,"SAID ""HI""",,10\r\n');
  assert.deepEqual(rows, [['Date', 'Details', 'Debit', 'Credit'], ['2026-09-01', 'LOBLAWS, #12', '45.10', ''], ['2026-09-02', 'SAID "HI"', '', '10']]);
  assert.equal(parseCsv('a;b;c\n1;2;3')[1][2], '3', 'semicolon files');
});

test('amounts in every format banks use', () => {
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('(12.00)'), -1200);
  assert.equal(parseAmount('-12'), -1200);
  assert.equal(parseAmount('12.00-'), -1200);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('45.5'), 4550);
  assert.equal(parseAmount(''), null);
});

test('dates: ISO, month names, and day/month order detected from the data', () => {
  assert.equal(parseDate('2026-09-27'), '2026-09-27');
  assert.equal(parseDate('09/27/2026', 'MDY'), '2026-09-27');
  assert.equal(parseDate('27/09/2026', 'DMY'), '2026-09-27');
  assert.equal(parseDate('Sep 27, 2026'), '2026-09-27');
  assert.equal(parseDate('27-Sep-26'), '2026-09-27');
  assert.equal(parseDate('02/30/2026', 'MDY'), null);
  const m = detectMapping(parseCsv('13/01/2026,SHOP,10.00,\n14/01/2026,SHOP,5.00,'));
  assert.equal(m.dateOrder, 'DMY');
});

test('headerless TD-style file maps to date, description, debit, credit, balance', () => {
  const rows = parseCsv('09/01/2026,TIM HORTONS #1,2.45,,1000.00\n09/02/2026,PAYROLL,,1500.00,2497.55');
  const m = detectMapping(rows);
  assert.equal(m.hasHeader, false);
  assert.deepEqual([m.date, m.description, m.debit, m.credit, m.balance], [0, 1, 2, 3, 4]);
  const { rows: out } = extractRows(rows, m);
  assert.deepEqual(out.map((r) => [r.direction, r.amount]), [['out', 245], ['in', 150000]]);
});

test('single signed amount column', () => {
  const rows = parseCsv('Date,Description,Amount\n2026-09-01,COFFEE,-4.50\n2026-09-02,REFUND,4.50');
  const m = detectMapping(rows);
  assert.equal(m.amount, 2);
  assert.deepEqual(extractRows(rows, m).rows.map((r) => r.direction), ['out', 'in']);
});

test('debt planner: avalanche saves interest, extra payments shorten the plan', () => {
  const debts = [
    { id: 1, name: 'Card', type: 'credit_card', current_balance: 500000, rate: 19.99, min_payment: 15000 },
    { id: 2, name: 'Car', type: 'car', current_balance: 1200000, rate: 6.5, min_payment: 35000 },
    { id: 3, name: 'LOC', type: 'line_of_credit', current_balance: 300000, rate: 9.2, min_payment: 10000 },
  ];
  const base = simulate(debts, { extra: 0, strategy: 'avalanche', startDate: '2026-10-01' });
  const aval = simulate(debts, { extra: 50000, strategy: 'avalanche', startDate: '2026-10-01' });
  const snow = simulate(debts, { extra: 50000, strategy: 'snowball', startDate: '2026-10-01' });
  assert.ok(aval.months < base.months);
  assert.ok(aval.totalInterest <= snow.totalInterest);
  assert.equal(aval.order[0].name, 'Card', 'highest rate paid first');
  assert.equal(snow.order[0].name, 'LOC', 'smallest balance paid first');
  assert.equal(simulate([{ id: 1, name: 'X', type: 'personal', current_balance: 1000000, rate: 30, min_payment: 1000 }], { startDate: '2026-10-01' }).stuck, true);
});

// ───────── End to end ─────────

let srv, owner, partner, cheq, card, cats;
const d = today('America/Toronto');
const m0 = addMonths(d.slice(0, 7) + '-05', -2); // two months ago, the 5th
const day = (base, n) => addDays(base, n);

const cardCsv = (base) => [
  'Date,Details,Debit,Credit',
  `${day(base, 0)},LOBLAWS #1234 TORONTO ON,86.40,`,
  `${day(base, 1)},TIM HORTONS #22 TORONTO ON,4.25,`,
  `${day(base, 1)},TIM HORTONS #22 TORONTO ON,4.25,`,
  `${day(base, 3)},NETFLIX.COM,20.99,`,
  `${day(base, 4)},MYSTERY SHOP 991,33.00,`,
  `${day(base, 9)},PAYMENT - THANK YOU,,500.00`,
  `${day(base, 12)},AMAZON.CA REFUND,,15.00`,
].join('\n');

const cheqCsv = (base) => [
  'Date,Detail,Debit,Credit',
  `${day(base, 0)},PAYROLL DEP ACME CORP,,2400.00`,
  `${day(base, 2)},TORONTO HYDRO-ELECTRIC,102.33,`,
  `${day(base, 8)},TD VISA PAYMENT,500.00,`,
  `${day(base, 10)},TFR-TO 4521 SAVINGS,200.00,`,
  `${day(base, 11)},INTERAC E-TRANSFER TO J SMITH,60.00,`,
].join('\n');

before(async () => {
  srv = await startServer();
  owner = client(srv.base);
  await owner.post('/api/setup', OWNER);
  cats = Object.fromEntries((await owner.get('/api/categories')).data.map((c) => [c.name, c.id]));
  const inv = await owner.post('/api/household/invites');
  partner = client(srv.base);
  await partner.post(`/api/invites/${inv.data.url.split('/join/')[1]}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'another good phrase' });
  cheq = (await owner.post('/api/accounts', { name: 'Everyday Chequing', type: 'chequing', institution: 'TD', current_balance: 300000 })).data;
  card = (await owner.post('/api/accounts', { name: 'TD Visa', type: 'credit_card', current_balance: 0, credit_limit: 500000, rate: 19.99 })).data;
});
after(async () => { await srv.close(); });

test('credit card accounts create a linked debt; balances follow the sign convention', async () => {
  assert.equal(card.owed, 0);
  const debts = (await owner.get('/api/debts')).data;
  assert.equal(debts.debts.length, 1);
  assert.equal(debts.debts[0].account_id, card.id);
});

test('preview shows what will happen without saving anything', async () => {
  const r = await owner.post(`/api/accounts/${card.id}/import/preview`, { csv: cardCsv(m0) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, 7);
  assert.equal(r.data.stats.new, 7, 'two identical coffees are both kept');
  const byDesc = Object.fromEntries(r.data.rows.map((x) => [x.description, x]));
  assert.equal(byDesc['LOBLAWS #1234 TORONTO ON'].category, 'Groceries');
  assert.equal(byDesc['LOBLAWS #1234 TORONTO ON'].name, 'Loblaws');
  assert.equal(byDesc['NETFLIX.COM'].category, 'Subscriptions');
  assert.equal(byDesc['MYSTERY SHOP 991'].category, null);
  assert.equal(byDesc['PAYMENT - THANK YOU'].transfer, true);
  assert.equal((await owner.get(`/api/accounts/${card.id}/transactions`)).data.length, 0);
});

test('import categorizes, de-duplicates, and pairs the card payment with chequing', async () => {
  const a = await owner.post(`/api/accounts/${card.id}/import`, { csv: cardCsv(m0), filename: 'visa.csv' });
  assert.equal(a.data.imported, 7);
  const again = await owner.post(`/api/accounts/${card.id}/import`, { csv: cardCsv(m0) });
  assert.equal(again.data.imported, 0);
  assert.equal(again.data.duplicates, 7, 're-importing the same file adds nothing');

  const b = await owner.post(`/api/accounts/${cheq.id}/import`, { csv: cheqCsv(m0) });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const cardTx = (await owner.get(`/api/accounts/${card.id}/transactions`)).data;
  const cheqTx = (await owner.get(`/api/accounts/${cheq.id}/transactions`)).data;
  const pay = cardTx.find((t) => t.description === 'PAYMENT - THANK YOU');
  const visaPay = cheqTx.find((t) => t.description === 'TD VISA PAYMENT');
  assert.equal(pay.is_transfer, 1);
  assert.equal(visaPay.is_transfer, 1);
  assert.equal(pay.transfer_peer_id, visaPay.id, 'both halves point at each other');
  assert.equal(visaPay.peer_account, 'TD Visa');
  assert.equal(cheqTx.find((t) => t.description.startsWith('INTERAC')).is_transfer, 0, 'e-transfers to people are spending');
  assert.equal(cheqTx.find((t) => t.description.startsWith('PAYROLL')).category_id, cats.Salary);

  // Balances: card owes 86.40 + 8.50 + 20.99 + 33 − 500 − 15 = −366.11 (a credit)
  const acc = (await owner.get(`/api/accounts/${card.id}`)).data;
  assert.equal(acc.balance, 36611);
  const cq = (await owner.get(`/api/accounts/${cheq.id}`)).data;
  assert.equal(cq.balance, 300000 + 240000 - 10233 - 50000 - 20000 - 6000);
  assert.ok(cq.history.length > 60);
});

test('card payment and savings transfer are not spending; refund reduces spending', async () => {
  const s = (await owner.get(`/api/money/summary?month=${m0.slice(0, 7)}`)).data;
  // spending: groceries 86.40 + coffee 8.50 + netflix 20.99 + mystery 33 + hydro 102.33 + e-transfer 60 − refund 15
  assert.equal(s.spent, 8640 + 850 + 2099 + 3300 + 10233 + 6000 - 1500);
  assert.equal(s.extraIncome, 240000, 'payroll counts once; the card payment credit is not income');
  const ins = (await owner.get(`/api/money/insights?month=${m0.slice(0, 7)}`)).data;
  assert.equal(ins.categories.find((c) => c.name === 'Shopping'), undefined, 'refund-only category drops out');
  assert.ok(ins.categories.find((c) => c.name === 'Groceries').amount === 8640);
  assert.equal(ins.trend.length, 6);
});

test('Review: categorize once, and Finta remembers for every similar row and future imports', async () => {
  const rv = (await owner.get('/api/review')).data;
  const mystery = rv.groups.find((g) => g.key === 'MYSTERY SHOP');
  assert.ok(mystery, JSON.stringify(rv.groups.map((g) => g.key)));
  const r = await owner.post(`/api/transactions/${mystery.rows[0].id}/categorize`, { category_id: cats.Shopping, rename: 'Mystery Shop' });
  assert.equal(r.status, 200);
  const next = cardCsv(addMonths(m0, 1)).replace('NETFLIX.COM', 'NETFLIX.COM');
  const imp = await owner.post(`/api/accounts/${card.id}/import`, { csv: next });
  const tx = (await owner.get(`/api/accounts/${card.id}/transactions?month=${addMonths(m0, 1).slice(0, 7)}`)).data;
  const m = tx.find((t) => t.description === 'MYSTERY SHOP 991');
  assert.equal(m.category_id, cats.Shopping);
  assert.equal(m.cat_source, 'rule');
  assert.equal(m.note, 'Mystery Shop');
  assert.equal(imp.data.needsReview, 0);
  assert.ok((await owner.get('/api/rules')).data.some((x) => x.pattern === 'MYSTERY SHOP'));
});

test('a recurring bill is matched and marked paid from the statement, replacing the autopay placeholder', async () => {
  const month2 = addMonths(m0, 1);
  const hydro = (await owner.post('/api/recurring', { name: 'Hydro', kind: 'bill', amount: 10000, variable: true, frequency: 'monthly', start_date: day(month2, 2), autopay: true, category_id: cats.Utilities })).data;
  await owner.get('/api/money/summary');  // materializes the autopay placeholder
  const before = srv.db.prepare('SELECT * FROM transactions WHERE recurring_id = ?').all(hydro.id);
  assert.ok(before.length >= 1 && before.every((t) => t.account_id === null));
  const r = await owner.post(`/api/accounts/${cheq.id}/import`, { csv: cheqCsv(month2).replace('102.33', '97.10') });
  assert.equal(r.data.bills, 1);
  const linked = srv.db.prepare('SELECT * FROM transactions WHERE recurring_id = ? AND due_date = ?').get(hydro.id, day(month2, 2));
  assert.equal(linked.account_id, cheq.id);
  assert.equal(linked.amount, 9710, 'the real amount replaces the estimate');
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = ? AND due_date = ?').get(hydro.id, day(month2, 2)).n, 1);
  assert.ok((await owner.get('/api/rules')).data.some((x) => x.recurring_id === hydro.id), 'the match is learned');
});

test('"Looks recurring" finds Netflix after three months and tracks it in one tap', async () => {
  await owner.post(`/api/accounts/${card.id}/import`, { csv: cardCsv(addMonths(m0, 2)) });
  const sug = (await owner.get('/api/money/suggestions')).data;
  const nf = sug.find((x) => x.merchant === 'NETFLIX');
  assert.ok(nf, JSON.stringify(sug));
  assert.equal(nf.frequency, 'monthly');
  assert.equal(nf.kind, 'subscription');
  const acc = await owner.post('/api/money/suggestions/accept', { ...nf, first_date: nf.first_date });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.ok(acc.data.linked >= 3);
  assert.ok(!(await owner.get('/api/money/suggestions')).data.some((x) => x.merchant === 'NETFLIX'));
});

test('privacy: a member sees household totals but not another member’s private transactions', async () => {
  const list = (await partner.get('/api/accounts')).data;
  const theirView = list.find((a) => a.id === cheq.id);
  assert.equal(theirView.can_view, false);
  assert.equal(typeof theirView.balance, 'number', 'balance is visible as a total');
  assert.deepEqual((await partner.get(`/api/accounts/${cheq.id}`)).data.history, [], 'no day-by-day balances for private accounts');
  assert.equal((await partner.get(`/api/accounts/${cheq.id}/transactions`)).status, 403);
  assert.equal((await partner.post(`/api/accounts/${cheq.id}/import`, { csv: cheqCsv(m0) })).status, 403);
  assert.ok(!(await partner.get('/api/transactions?transfers=1')).data.some((t) => t.account_id === cheq.id));
  assert.equal((await partner.get('/api/review')).data.count, 0);
  const hh = (await partner.get(`/api/money/summary?month=${m0.slice(0, 7)}`)).data;
  const mine = (await partner.get(`/api/money/summary?month=${m0.slice(0, 7)}&scope=me`)).data;
  assert.ok(hh.spent > 0, 'household totals include everyone');
  assert.equal(mine.spent, 0, 'Sam has spent nothing personally');
  const members = (await partner.get(`/api/money/insights?month=${m0.slice(0, 7)}`)).data.members;
  assert.ok(members.find((x) => x.name === 'Alex').amount > 0);
  // Sharing the account makes its lines visible.
  await owner.patch(`/api/accounts/${cheq.id}`, { is_private: false });
  assert.equal((await partner.get(`/api/accounts/${cheq.id}/transactions`)).status, 200);
});

test('debts: per-person list, plan endpoint, and card debt follows the imported balance', async () => {
  const loc = await partner.post('/api/debts', { name: 'Student Loan', type: 'student', balance: 1500000, rate: 5.2, min_payment: 20000 });
  assert.equal(loc.status, 200, JSON.stringify(loc.data));
  const all = (await owner.get('/api/debts')).data;
  assert.equal(all.debts.length, 2);
  const mine = (await partner.get('/api/debts?scope=me')).data;
  assert.equal(mine.debts.length, 1);
  assert.equal((await owner.patch(`/api/debts/${loc.data.id}`, { balance: 1 })).status, 403, 'only the owner edits a personal debt');
  const plan = (await owner.get('/api/debts/plan?extra=20000&strategy=avalanche')).data;
  assert.ok(plan.plan.months > 0 && plan.baseline.months >= plan.plan.months);
});

test('undo an import removes its rows and un-pairs transfers', async () => {
  const imports = (await owner.get(`/api/accounts/${cheq.id}`)).data.imports;
  const first = imports.at(-1);
  const r = await owner.del(`/api/imports/${first.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.removed, 5);
  const pay = srv.db.prepare(`SELECT * FROM transactions WHERE account_id = ? AND description = 'PAYMENT - THANK YOU' AND date = ?`).get(card.id, day(m0, 9));
  assert.equal(pay.transfer_peer_id, null);
});

test('v1 loans migrate into debts', async () => {
  const s = await startServer();
  try {
    const x = client(s.base);
    await x.post('/api/setup', { ...OWNER, withSamples: true });
    const debts = (await x.get('/api/debts')).data.debts;
    assert.ok(debts.some((dd) => dd.type === 'mortgage' && dd.recurring_id));
    const accs = (await x.get('/api/accounts')).data;
    assert.ok(accs.length >= 2, 'sample data includes accounts');
  } finally { await s.close(); }
});

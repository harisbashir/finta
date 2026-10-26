import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHousehold, monthly } from './advisor-helpers.js';
import { healthCheck } from '../server/lib/advisor/health.js';

const TODAY = '2026-04-15';
const Q1 = ['2026-01', '2026-02', '2026-03'];
const metric = (r, key) => r.metrics.find((m) => m.key === key);

function base({ chequing = 300000, savings = 300000 } = {}) {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: chequing });
  h.account({ type: 'savings', balance: savings });
  monthly(h, Q1, 3, { amount: 150000, category: 'Housing', account_id: chq });
  monthly(h, Q1, 9, { amount: 50000, category: 'Groceries', account_id: chq });
  return { h, chq };
}

test('metrics come back in order with a target', () => {
  const { h } = base();
  const r = healthCheck(h.db, h.hid, TODAY);
  assert.deepEqual(r.metrics.map((m) => m.key), ['emergency', 'savings', 'dti', 'utilization']);
  assert.equal(r.target, 3);
  assert.equal(r.months, 3);
});

test('emergency fund: months of essential spending covered by cash', () => {
  // Spending reduces the chequing balance, so put it back to keep liquid at 600,000.
  const { h } = base({ chequing: 300000 + 600000 });
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'emergency');
  assert.equal(m.value, 3);
  assert.equal(m.status, 'good');
  assert.equal(m.display, '3.0 months');
});

test('emergency fund below one month is poor and suggests a monthly amount', () => {
  const { h } = base({ chequing: 100000 + 600000, savings: 0 });
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'emergency');
  assert.equal(m.status, 'poor');
  assert.match(m.next, /a month/);
});

test('the household target changes the emergency status', () => {
  const { h } = base({ chequing: 900000 });
  h.db.prepare('UPDATE households SET emergency_months = 6').run();
  const r = healthCheck(h.db, h.hid, TODAY);
  assert.equal(r.target, 6);
  assert.equal(metric(r, 'emergency').status, 'fair');
});

test('savings rate ignores transfers between your own accounts', () => {
  const { h, chq } = base();
  monthly(h, Q1, 1, { amount: 500000, direction: 'in', category: 'Salary', account_id: chq });
  monthly(h, Q1, 20, { amount: 200000, category: 'Shopping', account_id: chq });
  h.tx({ date: '2026-02-25', amount: 999999, account_id: chq, is_transfer: 1 });
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'savings');
  assert.equal(m.value, 0.2);
  assert.equal(m.status, 'good');
});

test('a refund lowers spending', () => {
  const { h, chq } = base();
  monthly(h, Q1, 1, { amount: 500000, direction: 'in', category: 'Salary', account_id: chq });
  monthly(h, Q1, 20, { amount: 200000, category: 'Shopping', account_id: chq });
  h.tx({ date: '2026-03-21', amount: 150000, direction: 'in', category: 'Shopping', account_id: chq });
  assert.equal(metric(healthCheck(h.db, h.hid, TODAY), 'savings').value, 0.3);
});

test('debt-to-income uses minimum payments', () => {
  const { h, chq } = base();
  monthly(h, Q1, 1, { amount: 500000, direction: 'in', category: 'Salary', account_id: chq });
  h.debt({ name: 'Car', type: 'car', balance: 1000000, min_payment: 60000 });
  h.debt({ name: 'Student', type: 'student', balance: 500000, min_payment: 40000 });
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'dti');
  assert.equal(m.value, 0.2);
  assert.equal(m.status, 'good');
});

test('card utilisation from card balances and limits', () => {
  const { h } = base();
  h.account({ type: 'credit_card', balance: -450000, credit_limit: 1000000 });
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'utilization');
  assert.equal(m.value, 0.45);
  assert.equal(m.status, 'fair');
});

test('no history: everything unknown, nothing NaN', () => {
  const h = makeHousehold();
  h.account({ type: 'chequing', balance: 1000 });
  const r = healthCheck(h.db, h.hid, TODAY);
  for (const m of r.metrics) {
    assert.equal(m.status, 'unknown', m.key);
    assert.ok(m.value === null || Number.isFinite(m.value), m.key);
  }
});

test('scope me leaves out the other person’s accounts and debts', () => {
  const { h } = base();
  h.account({ type: 'savings', balance: 5000000, owner_id: h.member, is_private: 1 });
  h.debt({ name: 'Theirs', type: 'personal', owner_id: h.member, balance: 1, min_payment: 99999 });
  const all = metric(healthCheck(h.db, h.hid, TODAY), 'emergency').value;
  const mine = metric(healthCheck(h.db, h.hid, TODAY, { scope: 'me', userId: h.owner }), 'emergency').value;
  assert.ok(all > mine);
});

test('just short of the target reads as short everywhere (no "3.0 months · good" with advice to save)', () => {
  const { h } = base({ chequing: 594000 + 600000, savings: 0 });   // liquid 594,000 = 2.97 months
  const m = metric(healthCheck(h.db, h.hid, TODAY), 'emergency');
  assert.equal(m.display, '2.9 months');
  assert.equal(m.status, 'fair');
  assert.match(m.next, /Set aside/);
});

test('a partial first month does not count as a month', () => {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 900000 });
  h.tx({ date: '2026-03-20', amount: 1000, category: 'Groceries', account_id: chq });
  const r = healthCheck(h.db, h.hid, TODAY);
  assert.equal(r.months, 0);
  assert.ok(r.metrics.every((m) => m.status === 'unknown'));
  h.tx({ date: '2026-01-20', amount: 1000, category: 'Groceries', account_id: chq });
  assert.equal(healthCheck(h.db, h.hid, TODAY).months, 2, 'Jan started on the 20th, so Feb and Mar');
});

test('in my scope, the window starts when my own data starts', () => {
  const { h } = base();
  const theirs = h.account({ type: 'chequing', owner_id: h.member, balance: 0 });
  h.tx({ date: '2025-10-01', amount: 1000, category: 'Groceries', account_id: theirs });
  const mine = h.account({ type: 'chequing', owner_id: h.member, balance: 0 });
  h.tx({ date: '2026-03-01', amount: 1000, category: 'Groceries', account_id: mine });
  assert.equal(healthCheck(h.db, h.hid, TODAY, { scope: 'me', userId: h.member }).months, 3, 'Sam has data from October');
  assert.equal(healthCheck(h.db, h.hid, TODAY, { scope: 'me', userId: h.owner }).months, 3);
});

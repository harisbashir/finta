import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, addMonths, nextTaskDate, nextDue } from '../server/lib/dates.js';
import { loanSplit, loanProjection, monthlyEquivalent } from '../server/lib/finance.js';

test('monthly on the 31st clamps to short months and returns to the 31st', () => {
  const s = { frequency: 'monthly', start: '2026-01-31' };
  assert.deepEqual(occurrences(s, '2026-01-01', '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.equal(addMonths('2024-01-31', 1, 31), '2024-02-29');
});

test('biweekly stays anchored across years', () => {
  const s = { frequency: 'biweekly', start: '2025-12-26' };
  assert.deepEqual(occurrences(s, '2026-01-01', '2026-01-31'), ['2026-01-09', '2026-01-23']);
  assert.equal(occurrences(s, '2026-12-01', '2026-12-31').length, 2);
});

test('semimonthly pays on the 15th and month end', () => {
  const s = { frequency: 'semimonthly', start: '2026-01-15' };
  assert.deepEqual(occurrences(s, '2026-02-01', '2026-02-28'), ['2026-02-15', '2026-02-28']);
});

test('quarterly, yearly, end dates, and nothing before start', () => {
  assert.deepEqual(occurrences({ frequency: 'quarterly', start: '2026-02-10' }, '2026-01-01', '2026-12-31'), ['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10']);
  assert.deepEqual(occurrences({ frequency: 'yearly', start: '2024-02-29' }, '2025-01-01', '2028-12-31'), ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  assert.deepEqual(occurrences({ frequency: 'monthly', start: '2026-03-01', end: '2026-04-15' }, '2026-01-01', '2026-12-31'), ['2026-03-01', '2026-04-01']);
  assert.equal(nextDue({ frequency: 'weekly', start: '2026-09-01' }, '2026-09-02'), '2026-09-08');
});

test('repeating tasks roll past today', () => {
  assert.equal(nextTaskDate('weekly', '2026-09-01', '2026-09-20'), '2026-09-22');
  assert.equal(nextTaskDate('monthly', '2026-01-31', '2026-02-10'), '2026-02-28');
  assert.equal(nextTaskDate('none', '2026-01-31', '2026-02-10'), null);
});

test('loan math: interest first, then principal; projection pays off', () => {
  const loan = { amount: 215000, frequency: 'monthly', loan_balance: 41200000, loan_rate: 4.79, start_date: '2026-01-01' };
  const { interest, principal } = loanSplit(loan);
  assert.equal(interest, Math.round(41200000 * 0.0479 / 12));
  assert.equal(interest + principal, 215000);
  const p = loanProjection(loan, '2026-10-01');
  assert.ok(p.payoffDate > '2040-01-01' && p.payoffDate < '2060-01-01', p.payoffDate);
  assert.ok(p.totalInterest > 0);
  assert.equal(loanProjection({ ...loan, amount: 1000 }, '2026-10-01').neverPaysOff, true);
});

test('monthly equivalent normalises frequencies', () => {
  assert.equal(monthlyEquivalent({ amount: 1200, frequency: 'yearly' }), 100);
  assert.equal(monthlyEquivalent({ amount: 1200, frequency: 'weekly' }), 5200);
  assert.equal(monthlyEquivalent({ amount: 1200, frequency: 'biweekly' }), 2600);
});

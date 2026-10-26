import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHousehold } from './advisor-helpers.js';
import { feesReport } from '../server/lib/advisor/fees.js';
import { addMonths } from '../server/lib/dates.js';

const TODAY = '2026-10-15';
const FEES = 'Fees & Interest';
const kind = (r, k) => r.byKind.find((x) => x.kind === k)?.amount ?? 0;

function setup() {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 0 });
  const fee = (description, amount, extra = {}) => h.tx({ date: '2026-06-10', amount, description, note: description, category: FEES, account_id: chq, ...extra });
  return { h, chq, fee };
}

test('fees and interest are grouped by kind', () => {
  const { h, chq, fee } = setup();
  for (let m = 0; m < 12; m++) {
    const date = addMonths('2025-11-05', m);
    h.tx({ date, amount: 1595, description: 'Branch Transaction SERVICE CHARGE', category: FEES, account_id: chq });
    h.tx({ date, amount: 4000, description: 'Branch Transaction PLC INTEREST CHARGED', category: FEES, account_id: chq });
  }
  fee('OVERDRAFT INTEREST CHARGE', 200);
  fee('NON-SUFFICIENT FUNDS CHARGE', 4500);
  fee('ANNUAL FEE', 12000);
  fee('ATM FEE', 300);
  const r = feesReport(h.db, h.hid, TODAY);
  assert.equal(kind(r, 'account_fees'), 19140);
  assert.equal(kind(r, 'overdraft_nsf'), 4700);
  assert.equal(kind(r, 'interest'), 48000);
  assert.equal(kind(r, 'annual_fees'), 12000);
  assert.equal(kind(r, 'atm'), 300);
  assert.equal(r.total, 19140 + 4700 + 48000 + 12000 + 300);
  assert.equal(r.from, '2025-10-16');
  assert.equal(r.to, TODAY);
});

test('rebates are netted and never go below zero', () => {
  const { fee, h } = setup();
  fee('SERVICE CHARGE', 1595);
  fee('SERVICE CHARGE DISCOUNT', 1595, { direction: 'in' });
  fee('SERVICE CHARGE REWARDS', 5000, { direction: 'in' });
  const r = feesReport(h.db, h.hid, TODAY);
  assert.equal(kind(r, 'account_fees'), 0);
  assert.equal(r.total, 0);
});

test('foreign-exchange cost is estimated at 2.5% of foreign-currency purchases', () => {
  const { h, chq } = setup();
  h.tx({ date: '2026-06-01', amount: 18000, description: "LEVI'S OUTLET LONDON 100.00 GBP @ 1.800000", category: 'Shopping', account_id: chq });
  h.tx({ date: '2026-06-02', amount: 5000, description: 'HOME HARDWARE OTTAWA, ON', category: 'Shopping', account_id: chq });
  const r = feesReport(h.db, h.hid, TODAY);
  assert.equal(kind(r, 'fx'), 450);
  assert.equal(r.fxEstimated, true);
});

test('transfers and rows older than a year are ignored', () => {
  const { h, chq, fee } = setup();
  fee('PLC INTEREST CHARGED', 4000, { is_transfer: 1 });
  h.tx({ date: '2025-09-01', amount: 4000, description: 'PLC INTEREST CHARGED', category: FEES, account_id: chq });
  assert.equal(feesReport(h.db, h.hid, TODAY).total, 0);
});

test('suggestions only for kinds that cost something, with no brand names', () => {
  const { h, fee } = setup();
  fee('SERVICE CHARGE', 1595);
  fee('NSF CHARGE', 4500);
  const r = feesReport(h.db, h.hid, TODAY);
  assert.deepEqual(r.suggestions.map((s) => s.kind).sort(), ['account_fees', 'overdraft_nsf']);
  for (const s of r.suggestions) assert.doesNotMatch(s.text, /\b(Tangerine|Simplii|EQ Bank|Wealthsimple|RBC|TD|CIBC|BMO|Scotia)\b/);
  assert.equal(r.suggestions.find((s) => s.kind === 'account_fees').saving, 1595);
});

test('FX and late fees are their own kinds, not account fees', () => {
  const { fee, h } = setup();
  fee('FOREIGN TRANSACTION FEE', 250);
  fee('LATE FEE', 2900);
  const r = feesReport(h.db, h.hid, TODAY);
  assert.equal(kind(r, 'account_fees'), 0);
  assert.equal(kind(r, 'fx'), 250);
  assert.equal(kind(r, 'late'), 2900);
  assert.ok(!r.suggestions.some((s) => s.kind === 'account_fees'));
});

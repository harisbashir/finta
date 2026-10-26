import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHousehold } from './advisor-helpers.js';
import { forecast } from '../server/lib/advisor/forecast.js';
import { addDays, addMonths } from '../server/lib/dates.js';

const TODAY = '2026-04-15';
const point = (r, date) => r.points.find((p) => p.date === date)?.balance;

test('no chequing account: nothing to forecast', () => {
  const h = makeHousehold();
  assert.equal(forecast(h.db, h.hid, TODAY).basis, 'no-chequing');
});

test('paydays and bills land on their days', () => {
  const h = makeHousehold();
  h.account({ type: 'chequing', balance: 100000 });
  h.recurring({ name: 'Paycheque', kind: 'income', direction: 'in', amount: 300000, start_date: '2026-01-01' });
  h.recurring({ name: 'Rent', amount: 250000, start_date: '2026-01-01' });
  const r = forecast(h.db, h.hid, TODAY);
  assert.equal(r.basis, 'events-only');
  assert.equal(r.start, 100000);
  assert.equal(r.points[0].date, TODAY);
  assert.equal(r.points.at(-1).date, addDays(TODAY, 60));
  assert.equal(point(r, '2026-04-30'), 100000);
  assert.equal(point(r, '2026-05-01'), 150000);
  assert.equal(r.events[0].date, '2026-05-01');
  assert.equal(r.warning, null);
});

test('an overdraft gives a danger warning on the day it happens', () => {
  const h = makeHousehold();
  h.account({ type: 'chequing', balance: 50000 });
  h.recurring({ name: 'Rent', amount: 250000, start_date: '2026-01-01' });
  const r = forecast(h.db, h.hid, TODAY);
  assert.deepEqual(r.warning, { level: 'danger', date: '2026-05-01' });
  assert.deepEqual(r.low, { date: '2026-06-01', balance: -450000 }, 'the lowest point is after the second rent');
});

test('a low but positive balance is worth watching', () => {
  const h = makeHousehold();
  h.account({ type: 'chequing', balance: 255000 });
  h.recurring({ name: 'Rent', amount: 250000, start_date: '2026-01-01', end_date: '2026-05-31' });
  assert.equal(forecast(h.db, h.hid, TODAY).warning.level, 'watch');
});

test('a paid bill is not counted again; one overdue in the last week lands today', () => {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 1000000 });
  const rent = h.recurring({ name: 'Rent', amount: 250000, start_date: '2026-01-10' });
  h.recurring({ name: 'Phone', amount: 5000, start_date: '2026-01-12' });
  h.tx({ date: '2026-04-10', amount: 250000, account_id: chq, recurring_id: rent, due_date: '2026-04-10' });
  const r = forecast(h.db, h.hid, TODAY);
  assert.equal(point(r, TODAY), 1000000 - 250000 - 5000);
  assert.equal(r.events.find((e) => e.name === 'Phone').date, TODAY);
});

test('typical day: 90 days of everyday money, without bills or moves between your own chequing', () => {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 2000000 });
  const chq2 = h.account({ type: 'chequing', name: 'Joint chequing', balance: 0 });
  for (let i = 0; i < 90; i++) h.tx({ date: addDays(TODAY, -i), amount: 1000, account_id: chq, category: 'Groceries' });
  const out = h.tx({ date: '2026-03-01', amount: 77700, account_id: chq, is_transfer: 1 });
  const inn = h.tx({ date: '2026-03-01', amount: 77700, direction: 'in', account_id: chq2, is_transfer: 1, transfer_peer_id: out });
  h.db.prepare('UPDATE transactions SET transfer_peer_id = ? WHERE id = ?').run(inn, out);
  h.tx({ date: '2026-03-20', amount: 45000, account_id: chq, is_transfer: 1, note: 'Card payment' });
  const r = forecast(h.db, h.hid, TODAY);
  assert.equal(r.basis, 'full');
  assert.equal(r.typical.out, Math.round((90 * 1000 + 45000) / 90));
  assert.equal(r.typical.in, 0);
  assert.equal(point(r, addDays(TODAY, 10)), point(r, TODAY) - 10 * r.typical.out);
});

test('a detected repeat is an event and not part of the typical day; a tracked bill wins', () => {
  const h = makeHousehold();
  const chq = h.account({ type: 'chequing', balance: 2000000 });
  for (let i = 0; i < 90; i++) h.tx({ date: addDays(TODAY, -i), amount: 1000, account_id: chq, category: 'Groceries' });
  for (let m = 1; m <= 4; m++) {
    h.tx({ date: addMonths('2025-12-05', m), amount: 5000, account_id: chq, merchant: 'FITPLACE CLUB', note: 'Fitplace Club', category: 'Subscriptions' });
  }
  let r = forecast(h.db, h.hid, TODAY);
  const ev = r.events.filter((e) => e.name === 'Fitplace Club');
  assert.equal(ev[0].source, 'detected');
  assert.equal(ev[0].date, '2026-05-05');
  assert.equal(r.typical.out, 1000, 'the detected rows are left out of the typical day');

  h.recurring({ name: 'Fitplace Club', kind: 'subscription', amount: 5000, start_date: '2026-01-05' });
  r = forecast(h.db, h.hid, TODAY);
  const both = r.events.filter((e) => /fitplace/i.test(e.name) && e.date === '2026-05-05');
  assert.equal(both.length, 1);
  assert.equal(both[0].source, 'bill');
  assert.equal(r.typical.out, 1000, 'rows for a tracked bill are not counted again in the typical day');
});

test('scope me forecasts only my chequing and my bills', () => {
  const h = makeHousehold();
  h.account({ type: 'chequing', balance: 100000 });
  h.account({ type: 'chequing', balance: 900000, owner_id: h.member, is_private: 1 });
  h.recurring({ name: 'Their rent', amount: 250000, start_date: '2026-01-01', owner_id: h.member });
  const mine = forecast(h.db, h.hid, TODAY, { scope: 'me', userId: h.owner });
  assert.equal(mine.start, 100000);
  assert.equal(mine.events.length, 0);
  assert.equal(forecast(h.db, h.hid, TODAY).start, 1000000);
});

test('repeats on someone else’s private account are not named to a viewer, but still count', () => {
  const h = makeHousehold();
  const theirs = h.account({ type: 'chequing', balance: 2000000, owner_id: h.member, is_private: 1 });
  for (let i = 0; i < 90; i++) h.tx({ date: addDays(TODAY, -i), amount: 1000, account_id: theirs, category: 'Groceries' });
  for (let m = 1; m <= 4; m++) h.tx({ date: addMonths('2025-12-05', m), amount: 5000, account_id: theirs, merchant: 'PRIVATE PAYEE', note: 'Private Payee', category: 'Subscriptions' });
  const owner = forecast(h.db, h.hid, TODAY, { viewerId: h.owner });
  assert.ok(!JSON.stringify(owner.events).includes('Private Payee'));
  assert.ok(owner.typical.out > 1000, 'their repeat still moves the balance');
  const member = forecast(h.db, h.hid, TODAY, { viewerId: h.member });
  assert.ok(JSON.stringify(member.events).includes('Private Payee'));
});

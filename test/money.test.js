import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, OWNER } from './helpers.js';
import { today, addDays, monthRange } from '../server/lib/dates.js';

let srv, c, cats;
const d = today('America/Toronto');
const { start } = monthRange(d.slice(0, 7));

before(async () => {
  srv = await startServer();
  c = client(srv.base);
  await c.post('/api/setup', OWNER);
  cats = Object.fromEntries((await c.get('/api/categories')).data.map((x) => [x.name, x.id]));
});
after(async () => { await srv.close(); });

test('left to spend = income − bills − spending − savings', async () => {
  await c.post('/api/recurring', { name: 'Salary', kind: 'income', amount: 500000, frequency: 'monthly', start_date: start });
  const rent = await c.post('/api/recurring', { name: 'Rent', kind: 'bill', amount: 200000, frequency: 'monthly', start_date: start, category_id: cats.Housing });
  assert.equal(rent.status, 200, JSON.stringify(rent.data));
  assert.equal(rent.data.direction, 'out');
  assert.equal(rent.data.monthly, 200000);
  await c.post('/api/transactions', { date: d, amount: 12345, category_id: cats.Groceries, note: 'Shop' });
  const goal = await c.post('/api/goals', { name: 'Trip', target: 100000 });
  await c.post(`/api/goals/${goal.data.id}/contribute`, { amount: 5000 });

  const s = (await c.get('/api/money/summary')).data;
  assert.equal(s.income, 500000);
  assert.equal(s.bills, 200000);
  assert.equal(s.spent, 12345);
  assert.equal(s.saved, 5000);
  assert.equal(s.left, 500000 - 200000 - 12345 - 5000);
  assert.ok(s.perDay > 0 && s.daysLeft > 0);
  assert.equal(s.budgets.find((b) => b.name === 'Groceries').spent, 12345);
  assert.equal((await c.get(`/api/goals`)).data[0].saved, 5000);
});

test('paying a bill marks the occurrence paid, and paying twice is harmless', async () => {
  const bill = await c.post('/api/recurring', { name: 'Water', amount: 4000, frequency: 'monthly', start_date: d });
  const pay = await c.post(`/api/recurring/${bill.data.id}/pay`, { due_date: d, amount: 4312 });
  assert.equal(pay.status, 200);
  assert.equal(pay.data.alreadyPaid, false);
  assert.notEqual(pay.data.item.next_due, d);
  assert.equal((await c.post(`/api/recurring/${bill.data.id}/pay`, { due_date: d })).data.alreadyPaid, true);
  const s = (await c.get('/api/money/summary')).data;
  const occ = s.schedule.find((x) => x.recurring_id === bill.data.id);
  assert.equal(occ.paid, true);
  assert.equal(occ.amount, 4312, 'actual amount replaces the estimate');
  assert.equal((await c.post(`/api/recurring/${bill.data.id}/pay`, { due_date: addDays(d, 3) })).status, 400, 'not a due date');
  await c.del(`/api/recurring/${bill.data.id}/pay/${d}`);
  assert.equal((await c.get('/api/money/summary')).data.schedule.find((x) => x.recurring_id === bill.data.id).paid, false);
});

test('autopay records itself; loan payments reduce the balance and undo restores it', async () => {
  const loan = await c.post('/api/recurring', {
    name: 'Mortgage', kind: 'loan', amount: 200000, frequency: 'monthly', start_date: start, autopay: true,
    loan_balance: 30000000, loan_rate: 5, category_id: cats.Housing,
  });
  assert.ok(loan.data.payoff_date, 'projection present');
  const after1 = (await c.get(`/api/recurring/${loan.data.id}`)).data;
  assert.equal(after1.history.length, 1, 'this month autopaid on read');
  const interest = Math.round(30000000 * 0.05 / 12);
  assert.equal(after1.loan_balance, 30000000 - (200000 - interest));
  const txId = after1.history[0].id;
  await c.del(`/api/transactions/${txId}`);
  const bal = srv.db.prepare('SELECT balance FROM debts WHERE recurring_id = ?').get(loan.data.id).balance;
  assert.equal(bal, 30000000);
});

test('validation explains what is wrong', async () => {
  const r = await c.post('/api/recurring', { name: '', amount: 100, start_date: d });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'name');
  const r2 = await c.post('/api/transactions', { date: '2026-02-30', amount: 100 });
  assert.equal(r2.data.field, 'date');
  const r3 = await c.post('/api/recurring', { name: 'X', amount: 100, start_date: d, frequency: 'hourly' });
  assert.equal(r3.data.field, 'frequency');
});

test('repeating tasks roll forward; one-off tasks complete', async () => {
  const t1 = await c.post('/api/tasks', { title: 'Recycling', repeat: 'weekly', due_date: addDays(d, -1) });
  const done = await c.post(`/api/tasks/${t1.data.id}/complete`);
  assert.equal(done.data.rolled, true);
  assert.ok(done.data.due_date > d);
  assert.equal(done.data.done_at, null);
  const t2 = await c.post('/api/tasks', { title: 'Call plumber' });
  assert.ok((await c.post(`/api/tasks/${t2.data.id}/complete`)).data.done_at);
});

test('shopping: add several at once, no duplicates, meal ingredients flow in', async () => {
  const lists = (await c.get('/api/lists')).data;
  const id = lists[0].id;
  const added = await c.post(`/api/lists/${id}/items`, { name: 'Milk, Eggs\nBread' });
  assert.equal(added.data.length, 3);
  await c.post(`/api/lists/${id}/items`, { name: 'milk' });
  assert.equal((await c.get(`/api/lists/${id}/items`)).data.length, 3);
  const meal = await c.post('/api/meals', { date: d, title: 'Pancakes', ingredients: 'Eggs\nFlour\nMaple syrup' });
  const r = await c.post(`/api/meals/${meal.data.id}/to-list`, { list_id: id });
  assert.equal(r.data.added, 2);
  const eggs = (await c.get(`/api/lists/${id}/items`)).data.find((i) => i.name === 'Eggs');
  await c.patch(`/api/items/${eggs.id}`, { checked: true });
  const cleared = await c.post(`/api/lists/${id}/clear-checked`);
  assert.equal(cleared.data.removed.length, 1);
});

test('today bundles the home screen in one call', async () => {
  const r = await c.get('/api/today');
  assert.equal(r.status, 200);
  for (const k of ['month', 'bills', 'tasks', 'meals', 'lists', 'warranties', 'trials']) assert.ok(k in r.data, k);
});

test('sample data seeds a realistic household', async () => {
  const s = await startServer();
  try {
    const x = client(s.base);
    await x.post('/api/setup', { ...OWNER, withSamples: true });
    const t = (await x.get('/api/today')).data;
    assert.ok(t.month.income > 0 && t.month.bills > 0);
    assert.ok((await x.get('/api/recurring')).data.length >= 10);
  } finally { await s.close(); }
});

test('export contains data but never secrets', async () => {
  const r = await c.get('/api/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const text = JSON.stringify(r.data);
  assert.ok(!/password_hash|totp_secret|scrypt\$/.test(text));
  assert.ok(r.data.recurring.length > 0);
});

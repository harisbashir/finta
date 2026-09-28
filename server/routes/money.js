// Money: categories, recurring items (income, bills, subscriptions, loans), transactions, goals.
import { bad, notFound, forbidden } from '../lib/http.js';
import { validate, t, isDate } from '../lib/validate.js';
import { crud, getOwned, insertRow, updateRow } from '../lib/crud.js';
import { monthSummary, upcomingBills, materializeAutopay, monthlyEquivalent, loanProjection, settleOccurrence, debtForRecurring,
  monthlyTrend, categoryBreakdown, memberBreakdown, netWorth, TX_JOINS, TX_VISIBLE, TX_OWNER, scopeFilter } from '../lib/finance.js';
import { restorePrincipal, unpairTransfer } from '../lib/importer.js';
import { canSeeAccount } from './accounts.js';
import { nextDue, occurrences, addDays } from '../lib/dates.js';
import { tx } from '../db.js';

const KINDS = ['income', 'bill', 'subscription', 'loan', 'insurance', 'savings'];
const FREQS = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'];

const recurringSchema = {
  name: t.str(80, { required: true }),
  kind: t.oneOf(KINDS, { default: 'bill' }),
  amount: t.money({ required: true }),
  variable: t.bool(),
  frequency: t.oneOf(FREQS, { default: 'monthly' }),
  start_date: t.date({ required: true, label: 'first due date' }),
  end_date: t.date({ label: 'end date' }),
  autopay: t.bool(),
  category_id: t.ref('categories', { label: 'category' }),
  owner_id: t.ref('users', { label: 'person' }),
  payee: t.str(80), url: t.str(300), notes: t.text(2000),
  loan_balance: t.money({ label: 'balance' }),
  loan_rate: t.real(0, 100, { label: 'interest rate' }),
  trial_ends: t.date({ label: 'trial end' }),
  paused: t.bool(),
};

const txSchema = {
  date: t.date({ required: true }),
  amount: t.money({ required: true }),
  direction: t.oneOf(['in', 'out'], { default: 'out' }),
  category_id: t.ref('categories', { label: 'category' }),
  note: t.str(200),
  paid_by: t.ref('users', { label: 'person' }),
  account_id: t.ref('accounts', { label: 'account' }),
};

function decorate(item, todayStr, db) {
  const sched = { frequency: item.frequency, start: item.start_date, end: item.end_date };
  // Next unpaid date: look from 60 days back so a missed bill stays visible.
  const recent = occurrences(sched, addDays(todayStr, -60), addDays(todayStr, 400));
  const paid = new Set(db.prepare(`SELECT due_date FROM transactions WHERE recurring_id = ? AND due_date >= ?`)
    .all(item.id, addDays(todayStr, -60)).map((r) => r.due_date));
  const created = item.created_at.slice(0, 7) + '-01';
  const next = recent.find((d) => !paid.has(d) && (d >= todayStr || d >= created)) || nextDue(sched, todayStr);
  const out = { ...item, monthly: monthlyEquivalent(item), next_due: next, overdue: !!next && next < todayStr };
  const debt = item.kind === 'loan' ? debtForRecurring(db, item.id) : null;
  out.loan_balance = debt ? debt.balance : null;
  out.loan_rate = debt ? debt.rate : null;
  out.debt_id = debt?.id ?? null;
  if (debt && debt.balance) {
    const p = loanProjection({ ...item, loan_balance: debt.balance, loan_rate: debt.rate }, next || todayStr);
    out.payoff_date = p.payoffDate;
    out.total_interest = p.totalInterest;
    out.never_pays_off = !!p.neverPaysOff;
  }
  return out;
}

function checkTxRefs(values) {
  if (values.amount === 0) throw bad('Enter an amount greater than zero.', { field: 'amount' });
}

export function moneyRoutes(r) {
  const today = (ctx) => ctx.today();

  crud(r, {
    path: '/api/categories', table: 'categories', order: 'kind DESC, sort, name',
    schema: {
      name: t.str(40, { required: true }), kind: t.oneOf(['in', 'out'], { default: 'out' }), color: t.color({ default: 'gray' }),
      icon: t.str(40, { default: 'tag' }), monthly_budget: t.money({ label: 'budget' }), sort: t.int(0, 10000), archived: t.bool(),
    },
    check: (v) => { if (v.icon && !/^[a-z0-9-]+$/.test(v.icon)) throw bad('Choose an icon from the list.'); },
  });

  // ── Recurring ──
  r.get('/api/recurring', (ctx) => {
    materializeAutopay(ctx.db, ctx.household.id, today(ctx));
    return ctx.db.prepare(`SELECT r.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
      FROM recurring r LEFT JOIN categories c ON c.id = r.category_id WHERE r.household_id = ? ORDER BY r.name`)
      .all(ctx.household.id).map((i) => decorate(i, today(ctx), ctx.db));
  });

  r.get('/api/recurring/:id', (ctx) => {
    materializeAutopay(ctx.db, ctx.household.id, today(ctx));
    const item = getOwned(ctx.db, 'recurring', ctx.params.id, ctx.household.id);
    const history = ctx.db.prepare(`SELECT id, date, due_date, amount, principal FROM transactions WHERE recurring_id = ? ORDER BY due_date DESC LIMIT 24`).all(item.id);
    const out = decorate(item, today(ctx), ctx.db);
    if (item.kind === 'loan' && out.loan_balance) out.projection = loanProjection({ ...item, loan_balance: out.loan_balance, loan_rate: out.loan_rate }, out.next_due || today(ctx));
    return { ...out, history };
  });

  const recurringCheck = (v, ctx, existing) => {
    if (v.kind) v.direction = v.kind === 'income' ? 'in' : 'out';
    const start = v.start_date ?? existing?.start_date;
    const end = 'end_date' in v ? v.end_date : existing?.end_date;
    if (end && start && end < start) throw bad('The end date is before the first due date.', { field: 'end_date' });
    if (v.amount === 0 && !(v.variable ?? existing?.variable)) throw bad('Enter an amount greater than zero.', { field: 'amount' });
  };

  r.post('/api/recurring', (ctx) => {
    const v = validate(ctx.body, recurringSchema, { db: ctx.db, householdId: ctx.household.id });
    recurringCheck(v, ctx, null);
    const loan = takeLoanFields(v);
    if (!('owner_id' in ctx.body)) v.owner_id = ctx.user.id;
    const row = tx(ctx.db, () => {
      const item = insertRow(ctx.db, 'recurring', ctx.household.id, v);
      syncLoanDebt(ctx, item, loan);
      return item;
    });
    return decorate(row, today(ctx), ctx.db);
  });

  r.patch('/api/recurring/:id', (ctx) => {
    const existing = getOwned(ctx.db, 'recurring', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, recurringSchema, { db: ctx.db, householdId: ctx.household.id, partial: true });
    for (const k of ['name', 'amount', 'start_date']) if (k in v && v[k] == null) throw bad(`Add a ${recurringSchema[k].label || k}.`, { field: k });
    recurringCheck(v, ctx, existing);
    const loan = takeLoanFields(v);
    const row = tx(ctx.db, () => {
      const item = updateRow(ctx.db, 'recurring', existing.id, ctx.household.id, v);
      syncLoanDebt(ctx, item, loan);
      return item;
    });
    return decorate(row, today(ctx), ctx.db);
  });

  r.delete('/api/recurring/:id', (ctx) => {
    const item = getOwned(ctx.db, 'recurring', ctx.params.id, ctx.household.id);
    // Past payments stay in the history as ordinary transactions (FK sets recurring_id NULL).
    ctx.db.prepare('DELETE FROM recurring WHERE id = ?').run(item.id);
    return { ok: true };
  });

  r.post('/api/recurring/:id/pay', (ctx) => {
    const item = getOwned(ctx.db, 'recurring', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, { due_date: t.date({ required: true }), amount: t.money(), date: t.date() });
    const sched = { frequency: item.frequency, start: item.start_date, end: item.end_date };
    if (!occurrences(sched, v.due_date, v.due_date).length) throw bad('That isn’t one of this item’s due dates.');
    const done = tx(ctx.db, () => settleOccurrence(ctx.db, item, v.due_date, {
      amount: v.amount ?? item.amount, date: v.date || today(ctx), paidBy: ctx.user.id,
    }));
    return { ok: true, alreadyPaid: !done, item: decorate(ctx.db.prepare('SELECT * FROM recurring WHERE id = ?').get(item.id), today(ctx), ctx.db) };
  });

  r.delete('/api/recurring/:id/pay/:due', (ctx) => {
    const item = getOwned(ctx.db, 'recurring', ctx.params.id, ctx.household.id);
    if (!isDate(ctx.params.due)) throw notFound();
    const row = ctx.db.prepare('SELECT * FROM transactions WHERE recurring_id = ? AND due_date = ?').get(item.id, ctx.params.due);
    if (!row) return { ok: true };
    removeTransaction(ctx, row);
    return { ok: true };
  });

  // ── Transactions ──
  r.get('/api/transactions', (ctx) => {
    const q = ctx.query;
    const sc = scopeFilter(q.scope === 'me' ? 'me' : 'household', ctx.user.id);
    const where = ['t.household_id = ?', TX_VISIBLE, '1=1' + sc.sql];
    const args = [ctx.household.id, ctx.user.id, ...sc.args];
    if (q.transfers !== '1') where.push('t.is_transfer = 0');
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push("substr(t.date, 1, 7) = ?"); args.push(q.month); }
    if (q.category) { where.push('t.category_id = ?'); args.push(Number(q.category)); }
    if (q.kind === 'spending') where.push('t.recurring_id IS NULL AND t.goal_id IS NULL AND t.direction = \'out\'');
    if (q.q) { where.push('(t.note LIKE ? OR t.description LIKE ?)'); const like = `%${String(q.q).slice(0, 60).replace(/[%_]/g, '')}%`; args.push(like, like); }
    return ctx.db.prepare(`SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon, c.kind AS category_kind,
        u.name AS paid_by_name, r.kind AS recurring_kind, g.name AS goal_name, a.name AS account_name, a.type AS account_type, ${TX_OWNER} AS owner_id
      ${TX_JOINS} LEFT JOIN users u ON u.id = t.paid_by LEFT JOIN goals g ON g.id = t.goal_id
      WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT 800`).all(...args);
  });

  r.post('/api/transactions', (ctx) => {
    const v = validate(ctx.body, txSchema, { db: ctx.db, householdId: ctx.household.id });
    checkTxRefs(v);
    if (!('paid_by' in ctx.body)) v.paid_by = ctx.user.id;
    if (v.account_id) checkAccountAccess(ctx, v.account_id);
    v.cat_source = 'manual';
    return insertRow(ctx.db, 'transactions', ctx.household.id, v);
  });

  r.patch('/api/transactions/:id', (ctx) => {
    const existing = getOwned(ctx.db, 'transactions', ctx.params.id, ctx.household.id);
    if (existing.account_id) checkAccountAccess(ctx, existing.account_id);
    const v = validate(ctx.body, txSchema, { db: ctx.db, householdId: ctx.household.id, partial: true });
    for (const k of ['date', 'amount']) if (k in v && v[k] == null) throw bad(`Add a ${k}.`, { field: k });
    checkTxRefs(v);
    if (v.account_id) checkAccountAccess(ctx, v.account_id);
    if ('category_id' in v) v.cat_source = 'manual';
    if (existing.goal_id && 'amount' in v) {
      ctx.db.prepare('UPDATE goals SET saved = MAX(0, saved + ?) WHERE id = ?').run(v.amount - existing.amount, existing.goal_id);
    }
    return updateRow(ctx.db, 'transactions', existing.id, ctx.household.id, v);
  });

  r.delete('/api/transactions/:id', (ctx) => {
    const row = getOwned(ctx.db, 'transactions', ctx.params.id, ctx.household.id);
    if (row.account_id) checkAccountAccess(ctx, row.account_id);
    removeTransaction(ctx, row);
    return { ok: true, deleted: row };
  });

  // ── Goals ──
  crud(r, {
    path: '/api/goals', table: 'goals', order: 'archived, target_date IS NULL, target_date, name',
    schema: {
      name: t.str(60, { required: true }), target: t.money({ required: true, label: 'target amount' }),
      saved: t.money({ default: 0 }), target_date: t.date({ label: 'target date' }), color: t.color({ default: 'teal' }),
      notes: t.text(1000), archived: t.bool(), owner_id: t.ref('users', { label: 'person' }),
    },
  });

  r.post('/api/goals/:id/contribute', (ctx) => {
    const goal = getOwned(ctx.db, 'goals', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, { amount: t.money({ required: true }), date: t.date() });
    if (!v.amount) throw bad('Enter an amount greater than zero.', { field: 'amount' });
    tx(ctx.db, () => {
      ctx.db.prepare(`INSERT INTO transactions (household_id, date, amount, direction, note, goal_id, paid_by) VALUES (?, ?, ?, 'out', ?, ?, ?)`)
        .run(ctx.household.id, v.date || today(ctx), v.amount, `Set aside for ${goal.name}`, goal.id, ctx.user.id);
      ctx.db.prepare('UPDATE goals SET saved = saved + ? WHERE id = ?').run(v.amount, goal.id);
    });
    return ctx.db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id);
  });

  // ── Summaries ──
  r.get('/api/money/summary', (ctx) => {
    const ym = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : today(ctx).slice(0, 7);
    materializeAutopay(ctx.db, ctx.household.id, today(ctx));
    const scope = ctx.query.scope === 'me' ? 'me' : 'household';
    const summary = monthSummary(ctx.db, ctx.household.id, ym, today(ctx), { scope, userId: ctx.user.id });
    summary.needsReview = reviewCount(ctx);
    return summary;
  });

  // Charts: trend, where the money went, who spent it, net worth.
  r.get('/api/money/insights', (ctx) => {
    const ym = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : today(ctx).slice(0, 7);
    const scope = ctx.query.scope === 'me' ? 'me' : 'household';
    const opts = { scope, userId: ctx.user.id };
    return {
      month: ym, scope,
      trend: monthlyTrend(ctx.db, ctx.household.id, today(ctx), { ...opts, months: 6 }),
      categories: categoryBreakdown(ctx.db, ctx.household.id, ym, opts),
      members: scope === 'household' ? memberBreakdown(ctx.db, ctx.household.id, ym) : null,
      netWorth: netWorth(ctx.db, ctx.household.id, scope, ctx.user.id),
    };
  });

  r.get('/api/money/upcoming', (ctx) => {
    materializeAutopay(ctx.db, ctx.household.id, today(ctx));
    const days = Math.min(90, Math.max(1, Number(ctx.query.days) || 30));
    return upcomingBills(ctx.db, ctx.household.id, today(ctx), days, { scope: ctx.query.scope === 'me' ? 'me' : 'household', userId: ctx.user.id });
  });
}

export function reviewCount(ctx) {
  return ctx.db.prepare(`SELECT COUNT(*) AS n ${TX_JOINS} WHERE t.household_id = ? AND ${TX_VISIBLE} AND t.account_id IS NOT NULL
    AND t.category_id IS NULL AND t.is_transfer = 0 AND t.recurring_id IS NULL AND t.goal_id IS NULL`).get(ctx.household.id, ctx.user.id).n;
}

function checkAccountAccess(ctx, accountId) {
  const a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ? AND household_id = ?').get(accountId, ctx.household.id);
  if (!a || !canSeeAccount(a, ctx.user)) throw forbidden('This account is private to its owner.');
}

/** Loans keep their balance and rate on a linked debt. */
function takeLoanFields(v) {
  const loan = {};
  for (const k of ['loan_balance', 'loan_rate']) if (k in v) { loan[k] = v[k]; delete v[k]; }
  return loan;
}
function syncLoanDebt(ctx, item, loan) {
  if (item.kind !== 'loan' || !Object.keys(loan).length) return;
  const debt = debtForRecurring(ctx.db, item.id);
  if (debt) {
    if ('loan_balance' in loan && loan.loan_balance != null) ctx.db.prepare('UPDATE debts SET balance = ? WHERE id = ?').run(loan.loan_balance, debt.id);
    if ('loan_rate' in loan) ctx.db.prepare('UPDATE debts SET rate = ? WHERE id = ?').run(loan.loan_rate, debt.id);
  } else if (loan.loan_balance) {
    const type = /mortgage/i.test(item.name) ? 'mortgage' : /car|auto/i.test(item.name) ? 'car' : /student|osap/i.test(item.name) ? 'student' : 'personal';
    ctx.db.prepare(`INSERT INTO debts (household_id, owner_id, name, type, lender, balance, original_amount, rate, min_payment, recurring_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ctx.household.id, item.owner_id, item.name, type, item.payee, loan.loan_balance, loan.loan_balance,
      loan.loan_rate ?? null, monthlyEquivalent(item), item.id);
  }
}

function removeTransaction(ctx, row) {
  tx(ctx.db, () => {
    restorePrincipal(ctx.db, row);
    if (row.is_transfer) unpairTransfer(ctx.db, row);
    if (row.goal_id) ctx.db.prepare('UPDATE goals SET saved = MAX(0, saved - ?) WHERE id = ?').run(row.amount, row.goal_id);
    ctx.db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
  });
}

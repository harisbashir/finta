// The money model, in one sentence:
//   Left to spend = expected income − bills due this month − everyday spending − money set aside.
// Recurring items (income, bills, subscriptions, loans) describe what *should* happen;
// transactions record what *did*. A bill is "paid" when a transaction settles its due date.
//
// v1.1 adds accounts and statement imports. Transfers between your own accounts (paying a card
// from chequing, moving money to savings) never count as spending or income, and money back
// from a shop counts as a refund against that shop's category, not as income.
//
// Scope: "household" counts everyone; "me" counts what belongs to one member — their own
// accounts, their recurring items, and manual entries they paid. Joint items appear only in
// the household view.
import { occurrences, MONTHLY_FACTOR, monthRange, addDays, diffDays, addMonths } from './dates.js';

export const PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, yearly: 1 };

export const monthlyEquivalent = (item) => Math.round(item.amount * (MONTHLY_FACTOR[item.frequency] || 1));

// ───────── SQL building blocks ─────────

export const TX_JOINS = `FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN recurring r ON r.id = t.recurring_id
  LEFT JOIN categories c ON c.id = t.category_id`;

/** Who a transaction belongs to: the account's owner, else the bill's owner, else whoever paid. NULL = joint. */
export const TX_OWNER = `(CASE WHEN t.account_id IS NOT NULL THEN COALESCE(a.owner_id, r.owner_id) ELSE COALESCE(r.owner_id, t.paid_by) END)`;

/** Rows a member may see line by line. Others' private accounts only show up in totals. */
export const TX_VISIBLE = `(t.account_id IS NULL OR a.owner_id IS NULL OR a.owner_id = ? OR a.is_private = 0)`;

export function scopeFilter(scope, userId, alias = 'tx') {
  if (scope !== 'me') return { sql: '', args: [] };
  if (alias === 'tx') return { sql: ` AND ${TX_OWNER} = ?`, args: [userId] };
  return { sql: ` AND ${alias}.owner_id = ?`, args: [userId] };
}

// ───────── Loans & debts ─────────

/** Interest/principal split for one loan payment. */
export function loanSplit(item, payment = item.amount) {
  const balance = item.loan_balance || 0;
  const rate = (item.loan_rate || 0) / 100 / (PERIODS_PER_YEAR[item.frequency] || 12);
  const interest = Math.round(balance * rate);
  const principal = Math.max(0, Math.min(balance, payment - interest));
  return { interest, principal };
}

/** Payment-by-payment projection until the loan is paid off (capped at 50 years). */
export function loanProjection(item, fromDate) {
  if (!item.loan_balance || item.loan_balance <= 0) return { payoffDate: null, totalInterest: 0, payments: 0, schedule: [] };
  let balance = item.loan_balance;
  let totalInterest = 0;
  const rate = (item.loan_rate || 0) / 100 / (PERIODS_PER_YEAR[item.frequency] || 12);
  const dates = occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, fromDate, addMonths(fromDate, 600));
  const schedule = [];
  let i = 0;
  for (; i < dates.length && balance > 0; i++) {
    const interest = Math.round(balance * rate);
    const principal = Math.min(balance, item.amount - interest);
    if (principal <= 0) return { payoffDate: null, totalInterest: null, payments: null, schedule, neverPaysOff: true };
    balance -= principal;
    totalInterest += interest;
    if (i % Math.max(1, PERIODS_PER_YEAR[item.frequency]) === 0 || balance <= 0) schedule.push({ date: dates[i], interest, principal, balance });
  }
  return { payoffDate: balance <= 0 ? dates[i - 1] : null, totalInterest, payments: i, schedule };
}

/** Debt linked to a recurring loan payment (source of truth for the balance). */
export const debtForRecurring = (db, recurringId) =>
  db.prepare('SELECT * FROM debts WHERE recurring_id = ? AND account_id IS NULL').get(recurringId) || null;

// ───────── Accounts ─────────

export function accountBalances(db, householdId) {
  const rows = db.prepare(`SELECT a.id, a.opening_balance + COALESCE(SUM(CASE t.direction WHEN 'in' THEN t.amount ELSE -t.amount END), 0) AS balance,
      MAX(t.date) AS last_date, COUNT(t.id) AS count
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    WHERE a.household_id = ? GROUP BY a.id`).all(householdId);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Current balance of every debt: from its account when it follows one, otherwise stored. */
export function debtBalances(db, householdId) {
  const bal = accountBalances(db, householdId);
  return db.prepare('SELECT * FROM debts WHERE household_id = ? AND archived = 0').all(householdId).map((d) => ({
    ...d,
    current_balance: d.account_id ? Math.max(0, -(bal.get(d.account_id)?.balance ?? 0)) : d.balance,
  }));
}

export function netWorth(db, householdId, scope, userId) {
  const bal = accountBalances(db, householdId);
  const accounts = db.prepare('SELECT * FROM accounts WHERE household_id = ? AND archived = 0').all(householdId)
    .filter((a) => scope !== 'me' || a.owner_id === userId);
  const debts = debtBalances(db, householdId).filter((d) => scope !== 'me' || d.owner_id === userId);
  let cash = 0, owedOnAccounts = 0;
  for (const a of accounts) {
    const b = bal.get(a.id)?.balance ?? a.opening_balance;
    if (b >= 0) cash += b; else owedOnAccounts += -b;
  }
  const otherDebt = debts.filter((d) => !d.account_id).reduce((s, d) => s + d.current_balance, 0);
  return { cash, debt: owedOnAccounts + otherDebt, net: cash - owedOnAccounts - otherDebt };
}

// ───────── Autopay & paying bills ─────────

/** Record autopay occurrences that have come due so nobody has to tick them off by hand. */
export function materializeAutopay(db, householdId, todayStr) {
  const items = db.prepare(`SELECT * FROM recurring WHERE household_id = ? AND autopay = 1 AND paused = 0`).all(householdId);
  for (const item of items) {
    const created = item.created_at.slice(0, 7) + '-01';
    const from = item.start_date > created ? item.start_date : created;
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, from, todayStr)) {
      settleOccurrence(db, item, due, { amount: item.amount, date: due });
    }
  }
}

/** Mark one occurrence paid (or received). Idempotent per (item, due date). */
export function settleOccurrence(db, item, due, { amount, date, paidBy = null } = {}) {
  let principal = null;
  const debt = item.kind === 'loan' ? debtForRecurring(db, item.id) : null;
  if (debt && debt.balance > 0) {
    principal = loanSplit({ loan_balance: debt.balance, loan_rate: debt.rate, frequency: item.frequency }, amount).principal;
  }
  const res = db.prepare(`INSERT OR IGNORE INTO transactions
    (household_id, date, amount, direction, category_id, note, recurring_id, due_date, principal, paid_by, cat_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring')`)
    .run(item.household_id, date, amount, item.direction, item.category_id, item.name, item.id, due, principal, paidBy);
  if (res.changes && principal) db.prepare('UPDATE debts SET balance = MAX(0, balance - ?) WHERE id = ?').run(principal, debt.id);
  return res.changes > 0;
}

// ───────── Month summary ─────────

export function monthSummary(db, householdId, ym, todayStr, { scope = 'household', userId = null } = {}) {
  const { start, end } = monthRange(ym);
  const rs = scopeFilter(scope, userId, 'r');
  const items = db.prepare(`SELECT r.*, c.name AS category_name, c.color AS category_color
    FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.household_id = ? AND r.paused = 0 ${rs.sql}`).all(householdId, ...rs.args);
  const ts = scopeFilter(scope, userId);
  const txs = db.prepare(`SELECT t.*, c.kind AS category_kind ${TX_JOINS}
    WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 ${ts.sql}`).all(householdId, start, end, ...ts.args);
  const settled = new Map();
  for (const row of db.prepare(`SELECT * FROM transactions WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date BETWEEN ? AND ?`).all(householdId, start, end)) {
    settled.set(`${row.recurring_id}:${row.due_date}`, row);
  }

  let incomePlanned = 0, incomeReceived = 0, billsPlanned = 0, billsPaid = 0;
  const schedule = [];
  for (const item of items) {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, start, end)) {
      const t = settled.get(`${item.id}:${due}`);
      const amount = t ? t.amount : item.amount;
      if (item.direction === 'in') { incomePlanned += amount; if (t) incomeReceived += amount; }
      else { billsPlanned += amount; if (t) billsPaid += amount; }
      schedule.push({
        recurring_id: item.id, name: item.name, kind: item.kind, direction: item.direction,
        due, amount, paid: !!t, transaction_id: t?.id || null, autopay: !!item.autopay, variable: !!item.variable,
        imported: !!t?.account_id, category_color: item.category_color, category_name: item.category_name, owner_id: item.owner_id,
      });
    }
  }

  let extraIncome = 0, spent = 0, saved = 0, refunds = 0;
  const byCat = new Map();
  for (const t of txs) {
    if (t.recurring_id) continue;
    if (t.goal_id) { saved += t.amount; continue; }
    if (t.direction === 'in') {
      if (t.category_kind === 'out') { refunds += t.amount; spent -= t.amount; byCat.set(t.category_id, (byCat.get(t.category_id) || 0) - t.amount); }
      else extraIncome += t.amount;
      continue;
    }
    spent += t.amount;
    byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + t.amount);
  }

  const income = incomePlanned + extraIncome;
  const left = income - billsPlanned - spent - saved;
  const isCurrent = todayStr >= start && todayStr <= end;
  const daysLeft = isCurrent ? diffDays(todayStr, end) + 1 : todayStr < start ? diffDays(start, end) + 1 : 0;

  const categories = db.prepare(`SELECT id, name, color, icon, monthly_budget FROM categories
    WHERE household_id = ? AND kind = 'out' AND archived = 0 ORDER BY sort, name`).all(householdId);
  const budgets = categories.map((c) => ({ ...c, spent: byCat.get(c.id) || 0 })).filter((c) => c.monthly_budget || c.spent);
  const uncategorized = byCat.get(null) || 0;
  if (uncategorized) budgets.push({ id: null, name: 'Uncategorized', color: 'gray', icon: 'tag', monthly_budget: null, spent: uncategorized });

  schedule.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
  const outItems = items.filter((i) => i.direction === 'out');
  return {
    month: ym, start, end, today: todayStr, daysLeft, scope,
    income, incomePlanned, incomeReceived, extraIncome,
    bills: billsPlanned, billsPaid, spent, saved, left, refunds,
    perDay: daysLeft > 0 ? Math.floor(Math.max(0, left) / daysLeft) : 0,
    schedule,
    budgets: budgets.sort((a, b) => b.spent - a.spent),
    monthly: {
      income: items.filter((i) => i.direction === 'in').reduce((s, i) => s + monthlyEquivalent(i), 0),
      committed: outItems.reduce((s, i) => s + monthlyEquivalent(i), 0),
      subscriptions: outItems.filter((i) => i.kind === 'subscription').reduce((s, i) => s + monthlyEquivalent(i), 0),
    },
  };
}

// ───────── Trends & breakdowns (actual transactions) ─────────

/** Money in and out per month for the last `months` months, from what actually happened. */
export function monthlyTrend(db, householdId, todayStr, { months = 6, scope = 'household', userId = null } = {}) {
  const first = addMonths(todayStr.slice(0, 7) + '-01', -(months - 1));
  const ts = scopeFilter(scope, userId);
  const rows = db.prepare(`SELECT substr(t.date, 1, 7) AS ym,
      SUM(CASE WHEN t.direction = 'in' AND COALESCE(c.kind, 'in') = 'in' AND t.goal_id IS NULL THEN t.amount ELSE 0 END) AS money_in,
      SUM(CASE WHEN t.direction = 'out' AND t.goal_id IS NULL THEN t.amount
               WHEN t.direction = 'in' AND c.kind = 'out' THEN -t.amount ELSE 0 END) AS money_out,
      SUM(CASE WHEN t.goal_id IS NOT NULL THEN t.amount ELSE 0 END) AS saved
    ${TX_JOINS} WHERE t.household_id = ? AND t.date >= ? AND t.date <= ? AND t.is_transfer = 0 ${ts.sql}
    GROUP BY ym`).all(householdId, first, todayStr, ...ts.args);
  const byMonth = new Map(rows.map((r) => [r.ym, r]));
  return Array.from({ length: months }, (_, i) => {
    const ym = addMonths(first, i).slice(0, 7);
    const r = byMonth.get(ym) || {};
    return { month: ym, in: r.money_in || 0, out: r.money_out || 0, saved: r.saved || 0 };
  });
}

/** Where the money went in a month: everything out (bills included), by category. */
export function categoryBreakdown(db, householdId, ym, { scope = 'household', userId = null } = {}) {
  const { start, end } = monthRange(ym);
  const ts = scopeFilter(scope, userId);
  return db.prepare(`SELECT c.id, COALESCE(c.name, 'Uncategorized') AS name, COALESCE(c.color, 'gray') AS color, COALESCE(c.icon, 'tag') AS icon,
      SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE -t.amount END) AS total, COUNT(*) AS count
    ${TX_JOINS} WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 AND t.goal_id IS NULL
      AND (t.direction = 'out' OR c.kind = 'out') ${ts.sql}
    GROUP BY c.id HAVING total > 0 ORDER BY total DESC`).all(householdId, start, end, ...ts.args)
    .map(({ total, ...rest }) => ({ ...rest, amount: total }));
}

/** Household view: how much each member (and joint) spent in a month. */
export function memberBreakdown(db, householdId, ym) {
  const { start, end } = monthRange(ym);
  const rows = db.prepare(`SELECT ${TX_OWNER} AS who,
      SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE -t.amount END) AS total
    ${TX_JOINS} WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 AND t.goal_id IS NULL
      AND (t.direction = 'out' OR c.kind = 'out')
    GROUP BY who`).all(householdId, start, end);
  const users = db.prepare('SELECT id, name, color FROM users WHERE household_id = ? ORDER BY created_at').all(householdId);
  const list = users.map((u) => ({ owner_id: u.id, name: u.name, color: u.color, amount: rows.find((r) => r.who === u.id)?.total || 0 }));
  const joint = rows.find((r) => r.who === null)?.total || 0;
  if (joint) list.push({ owner_id: null, name: 'Joint', color: 'gray', amount: joint });
  return list;
}

/** Bills not yet paid: overdue (last 60 days) and due within `days`. */
export function upcomingBills(db, householdId, todayStr, days = 14, { scope = 'household', userId = null } = {}) {
  const from = addDays(todayStr, -60);
  const to = addDays(todayStr, days);
  const rs = scopeFilter(scope, userId, 'r');
  const items = db.prepare(`SELECT r.*, c.color AS category_color FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.household_id = ? AND r.paused = 0 ${rs.sql}`).all(householdId, ...rs.args);
  const paid = new Set(db.prepare(`SELECT recurring_id || ':' || due_date AS k FROM transactions
    WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date BETWEEN ? AND ?`).all(householdId, from, to).map((r) => r.k));
  const out = [];
  for (const item of items) {
    const lo = [from, item.start_date, item.created_at.slice(0, 7) + '-01'].sort().at(-1);
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, lo, to)) {
      if (paid.has(`${item.id}:${due}`)) continue;
      out.push({
        recurring_id: item.id, name: item.name, kind: item.kind, direction: item.direction, amount: item.amount,
        due, overdue: due < todayStr, inDays: diffDays(todayStr, due), autopay: !!item.autopay, variable: !!item.variable,
        category_color: item.category_color, owner_id: item.owner_id,
      });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

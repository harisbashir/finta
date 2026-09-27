// The money model, in one sentence:
//   Left to spend = expected income − bills due this month − everyday spending − money set aside.
// Recurring items (income, bills, subscriptions, loans) describe what *should* happen;
// transactions record what *did*. A bill is "paid" when a transaction settles its due date.
import { occurrences, MONTHLY_FACTOR, monthRange, addDays, diffDays, addMonths, parse } from './dates.js';

const PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, yearly: 1 };

export const monthlyEquivalent = (item) => Math.round(item.amount * (MONTHLY_FACTOR[item.frequency] || 1));

/** Interest/principal split for one loan payment. */
export function loanSplit(item, payment = item.amount) {
  const balance = item.loan_balance || 0;
  const rate = (item.loan_rate || 0) / 100 / (PERIODS_PER_YEAR[item.frequency] || 12);
  const interest = Math.round(balance * rate);
  const principal = Math.max(0, Math.min(balance, payment - interest));
  return { interest, principal };
}

/** Month-by-month projection until the loan is paid off (capped at 50 years). */
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
    // keep one row per year (plus the last) so the payload stays small
    if (i % Math.max(1, PERIODS_PER_YEAR[item.frequency]) === 0 || balance <= 0) {
      schedule.push({ date: dates[i], interest, principal, balance });
    }
  }
  return { payoffDate: balance <= 0 ? dates[i - 1] : null, totalInterest, payments: i, schedule };
}

/** Record autopay occurrences that have come due so nobody has to tick them off by hand. */
export function materializeAutopay(db, householdId, todayStr) {
  const items = db.prepare(`SELECT * FROM recurring WHERE household_id = ? AND autopay = 1 AND paused = 0`).all(householdId);
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (household_id, date, amount, direction, category_id, note, recurring_id, due_date, principal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of items) {
    const created = item.created_at.slice(0, 7) + '-01';
    const from = item.start_date > created ? item.start_date : created;
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, from, todayStr)) {
      settleOccurrence(db, item, due, { amount: item.amount, date: due, insert });
    }
  }
}

/** Mark one occurrence paid (or received). Idempotent per (item, due date). */
export function settleOccurrence(db, item, due, { amount, date, paidBy = null, insert } = {}) {
  let principal = null;
  if (item.kind === 'loan' && item.loan_balance > 0) {
    principal = loanSplit(item, amount).principal;
  }
  const stmt = insert || db.prepare(`INSERT OR IGNORE INTO transactions
    (household_id, date, amount, direction, category_id, note, recurring_id, due_date, principal, paid_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const args = [item.household_id, date, amount, item.direction, item.category_id, item.name, item.id, due, principal];
  const res = insert ? stmt.run(...args) : stmt.run(...args, paidBy);
  if (res.changes && principal) {
    db.prepare('UPDATE recurring SET loan_balance = MAX(0, loan_balance - ?) WHERE id = ?').run(principal, item.id);
    item.loan_balance = Math.max(0, item.loan_balance - principal);
  }
  return res.changes > 0;
}

export function monthSummary(db, householdId, ym, todayStr) {
  const { start, end } = monthRange(ym);
  const items = db.prepare(`SELECT r.*, c.name AS category_name, c.color AS category_color
    FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.household_id = ? AND r.paused = 0`).all(householdId);
  const txs = db.prepare(`SELECT * FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`).all(householdId, start, end);
  const settled = new Map(); // "recurringId:due" -> tx
  for (const row of db.prepare(`SELECT * FROM transactions WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date BETWEEN ? AND ?`).all(householdId, start, end)) {
    settled.set(`${row.recurring_id}:${row.due_date}`, row);
  }

  let incomePlanned = 0, incomeReceived = 0, billsPlanned = 0, billsPaid = 0;
  const schedule = [];
  for (const item of items) {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, start, end)) {
      const tx = settled.get(`${item.id}:${due}`);
      const amount = tx ? tx.amount : item.amount;
      if (item.direction === 'in') { incomePlanned += amount; if (tx) incomeReceived += amount; }
      else { billsPlanned += amount; if (tx) billsPaid += amount; }
      schedule.push({
        recurring_id: item.id, name: item.name, kind: item.kind, direction: item.direction,
        due, amount, paid: !!tx, transaction_id: tx?.id || null, autopay: !!item.autopay, variable: !!item.variable,
        category_color: item.category_color, category_name: item.category_name,
      });
    }
  }
  // One-off income (a refund, a gift, a side job) adds to what you can spend.
  let extraIncome = 0, spent = 0, saved = 0;
  const byCat = new Map();
  for (const t of txs) {
    if (t.recurring_id) continue;
    if (t.direction === 'in') { extraIncome += t.amount; continue; }
    if (t.goal_id) { saved += t.amount; continue; }
    spent += t.amount;
    byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + t.amount);
  }

  const income = incomePlanned + extraIncome;
  const left = income - billsPlanned - spent - saved;
  const isCurrent = todayStr >= start && todayStr <= end;
  const daysLeft = isCurrent ? diffDays(todayStr, end) + 1 : todayStr < start ? diffDays(start, end) + 1 : 0;

  const categories = db.prepare(`SELECT id, name, color, icon, monthly_budget FROM categories
    WHERE household_id = ? AND kind = 'out' AND archived = 0 ORDER BY sort, name`).all(householdId);
  const budgets = categories
    .map((c) => ({ ...c, spent: byCat.get(c.id) || 0 }))
    .filter((c) => c.monthly_budget || c.spent);
  const uncategorized = byCat.get(null) || 0;
  if (uncategorized) budgets.push({ id: null, name: 'Uncategorized', color: 'gray', icon: 'tag', monthly_budget: null, spent: uncategorized });

  schedule.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));

  const outItems = items.filter((i) => i.direction === 'out');
  return {
    month: ym, start, end, today: todayStr, daysLeft,
    income, incomePlanned, incomeReceived, extraIncome,
    bills: billsPlanned, billsPaid, spent, saved, left,
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

/** Bills not yet paid: overdue (last 60 days) and due within `days`. */
export function upcomingBills(db, householdId, todayStr, days = 14) {
  const from = addDays(todayStr, -60);
  const to = addDays(todayStr, days);
  const items = db.prepare(`SELECT r.*, c.color AS category_color FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.household_id = ? AND r.paused = 0`).all(householdId);
  const paid = new Set(db.prepare(`SELECT recurring_id || ':' || due_date AS k FROM transactions
    WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date BETWEEN ? AND ?`).all(householdId, from, to).map((r) => r.k));
  const out = [];
  for (const item of items) {
    const created = item.created_at.slice(0, 10);
    const lo = [from, item.start_date, parse(created) && created.slice(0, 7) + '-01'].sort().at(-1);
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, lo, to)) {
      if (paid.has(`${item.id}:${due}`)) continue;
      out.push({
        recurring_id: item.id, name: item.name, kind: item.kind, direction: item.direction, amount: item.amount,
        due, overdue: due < todayStr, inDays: diffDays(todayStr, due), autopay: !!item.autopay, variable: !!item.variable,
        category_color: item.category_color,
      });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

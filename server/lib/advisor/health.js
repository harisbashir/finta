// Health check: four numbers a financial planner looks at first, each with a target and a next step.
//   Emergency fund  = cash you can reach ÷ a month of essential spending (plus minimum debt payments)
//   Savings rate    = (income − spending) ÷ income
//   Debt-to-income  = minimum debt payments ÷ income
//   Card utilisation = what's owed on cards and lines of credit ÷ their limits
// Measured over the last 3 full months (fewer if that's all the history there is).
import { TX_JOINS, scopeFilter, accountBalances } from '../finance.js';
import { monthRange, addMonths } from '../dates.js';
import { dollars } from './format.js';

const ESSENTIAL = ['Housing', 'Utilities', 'Groceries', 'Insurance', 'Transport', 'Health'];
const LIQUID = ['chequing', 'savings', 'cash'];
const REVOLVING = ['credit_card', 'line_of_credit'];
const round = (x, places = 3) => Math.round(x * 10 ** places) / 10 ** places;

/** The last (up to) 3 full months before today's month that have any history. */
function window(db, householdId, todayStr) {
  const first = db.prepare('SELECT MIN(date) AS d FROM transactions WHERE household_id = ?').get(householdId).d;
  if (!first) return null;
  const thisMonth = todayStr.slice(0, 7) + '-01';
  const months = [];
  for (let i = 1; i <= 3; i++) {
    const m = addMonths(thisMonth, -i);
    if (m.slice(0, 7) < first.slice(0, 7)) break;
    months.unshift(m.slice(0, 7));
  }
  if (!months.length) return null;
  return { months: months.length, from: monthRange(months[0]).start, to: monthRange(months.at(-1)).end };
}

export function healthCheck(db, householdId, todayStr, { scope = 'household', userId = null } = {}) {
  const target = db.prepare('SELECT emergency_months FROM households WHERE id = ?').get(householdId)?.emergency_months ?? 3;
  const w = window(db, householdId, todayStr);
  const mine = (row) => scope !== 'me' || row.owner_id === userId;

  const bal = accountBalances(db, householdId);
  const accounts = db.prepare('SELECT * FROM accounts WHERE household_id = ? AND archived = 0').all(householdId).filter(mine);
  const liquid = accounts.filter((a) => LIQUID.includes(a.type)).reduce((s, a) => s + Math.max(0, bal.get(a.id)?.balance ?? a.opening_balance), 0);
  const minPayments = db.prepare('SELECT * FROM debts WHERE household_id = ? AND archived = 0').all(householdId).filter(mine)
    .reduce((s, d) => s + (d.min_payment || 0), 0);
  const debts = db.prepare('SELECT * FROM debts WHERE household_id = ? AND archived = 0').all(householdId).filter(mine);

  let income = 0, outflow = 0, essential = 0;
  if (w) {
    const sc = scopeFilter(scope, userId);
    const rows = db.prepare(`SELECT t.amount, t.direction, c.kind AS cat_kind, c.name AS cat_name ${TX_JOINS}
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 AND t.goal_id IS NULL ${sc.sql}`)
      .all(householdId, w.from, w.to, ...sc.args);
    for (const t of rows) {
      const isEssential = ESSENTIAL.includes(t.cat_name);
      if (t.direction === 'in') {
        if (t.cat_kind === 'in') income += t.amount;
        else if (t.cat_kind === 'out') { outflow -= t.amount; if (isEssential) essential -= t.amount; }   // refunds
        continue;
      }
      outflow += t.amount;
      if (isEssential) essential += t.amount;
    }
    outflow = Math.max(0, outflow);
    essential = Math.max(0, essential);
  }
  const n = w?.months || 0;
  const monthlyIncome = n ? income / n : 0;
  const monthlyEssential = n ? essential / n + minPayments : 0;

  const metrics = [];
  // Emergency fund
  if (n && monthlyEssential > 0) {
    const value = Math.floor((liquid / monthlyEssential) * 10) / 10;   // round down: 2.97 months is not yet 3
    const short = target * monthlyEssential - liquid;
    const perMonth = Math.ceil(short / 12 / 2500) * 2500;
    metrics.push({
      key: 'emergency', label: 'Emergency Fund', value, display: `${value.toFixed(1)} months`, target: `${target} months`,
      status: value >= target ? 'good' : value >= 1 ? 'fair' : 'poor',
      next: short > 0 ? `Set aside ${dollars(perMonth)} a month to reach ${target} months within a year.`
        : 'You’re covered. Keep it somewhere you won’t spend it, like a savings account.',
    });
  } else metrics.push(unknown('emergency', 'Emergency Fund', `${target} months`, 'Import a full month of statements to see this.'));

  // Savings rate
  if (n && income > 0) {
    const value = round((income - outflow) / income);
    const gap = (goal) => dollars(Math.max(0, Math.ceil((goal * income - (income - outflow)) / n / 100) * 100));
    metrics.push({
      key: 'savings', label: 'Savings Rate', value, display: `${Math.round(value * 100)}%`, target: '20% or more',
      status: value >= 0.2 ? 'good' : value >= 0.1 ? 'fair' : 'poor',
      next: value >= 0.2 ? 'Great. Keep paying yourself first.'
        : value >= 0.1 ? `Reaching 20% means keeping ${gap(0.2)} more a month.` : `Saving 10% means keeping ${gap(0.1)} more a month.`,
    });
  } else metrics.push(unknown('savings', 'Savings Rate', '20% or more', n ? 'No income recorded in the last few months.' : 'Import a full month of statements to see this.'));

  // Debt-to-income
  if (n && monthlyIncome > 0) {
    const value = round(minPayments / monthlyIncome);
    const priciest = debts.filter((d) => d.rate).sort((a, b) => b.rate - a.rate)[0];
    metrics.push({
      key: 'dti', label: 'Debt Payments', value, display: `${Math.round(value * 100)}% of income`, target: '20% or less',
      status: value <= 0.2 ? 'good' : value <= 0.36 ? 'fair' : 'poor',
      next: value <= 0.2 ? 'Your debt payments are manageable.'
        : priciest ? `Paying down ${priciest.name} (${priciest.rate}%) first saves the most interest.` : 'Paying down the highest-rate debt first saves the most interest.',
    });
  } else metrics.push(unknown('dti', 'Debt Payments', '20% or less', 'Needs income from the last few months.'));

  // Card utilisation
  const cards = accounts.filter((a) => REVOLVING.includes(a.type) && a.credit_limit > 0);
  if (cards.length) {
    const owed = cards.reduce((s, a) => s + Math.max(0, -(bal.get(a.id)?.balance ?? a.opening_balance)), 0);
    const limit = cards.reduce((s, a) => s + a.credit_limit, 0);
    const value = round(owed / limit);
    metrics.push({
      key: 'utilization', label: 'Card Utilisation', value, display: `${Math.round(value * 100)}%`, target: 'Under 30%',
      status: value < 0.3 ? 'good' : value < 0.5 ? 'fair' : 'poor',
      next: value < 0.3 ? 'Keeping balances under 30% of limits helps your credit score.'
        : `Paying ${dollars(Math.ceil((owed - 0.3 * limit) / 100) * 100)} brings your cards under 30%, which helps your credit score.`,
    });
  } else metrics.push(unknown('utilization', 'Card Utilisation', 'Under 30%', 'Add a credit limit to your cards to see this.'));

  return { months: n, target, metrics };
}

const unknown = (key, label, target, next) => ({ key, label, value: null, display: '—', target, status: 'unknown', next });

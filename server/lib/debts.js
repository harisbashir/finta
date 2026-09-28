// Debt payoff planning. Simulates month by month:
//   • every debt accrues interest at its annual rate / 12
//   • every debt gets its minimum payment
//   • any extra money goes to one "focus" debt: highest rate first (avalanche — least interest)
//     or smallest balance first (snowball — quickest wins)
//   • when a debt is paid off, its minimum rolls into the next focus debt
import { addMonths } from './dates.js';

const MAX_MONTHS = 600;

/** A sensible minimum when none is recorded: cards ~3% of balance (at least $10), others ~1.5%. */
export function assumedMinimum(d) {
  if (d.min_payment) return d.min_payment;
  const pct = ['credit_card', 'line_of_credit'].includes(d.type) ? 0.03 : 0.015;
  return Math.max(1000, Math.round(d.current_balance * pct));
}

export function simulate(debts, { extra = 0, strategy = 'avalanche', startDate }) {
  const list = debts.filter((d) => d.current_balance > 0).map((d) => ({
    id: d.id, name: d.name, balance: d.current_balance, rate: (d.rate || 0) / 100 / 12, min: assumedMinimum(d), paidOffMonth: null, interest: 0,
  }));
  const order = () => list.filter((d) => d.balance > 0).sort(strategy === 'snowball'
    ? (a, b) => a.balance - b.balance || b.rate - a.rate
    : (a, b) => b.rate - a.rate || a.balance - b.balance);
  const series = [{ month: 0, date: startDate, balance: list.reduce((s, d) => s + d.balance, 0) }];
  let totalInterest = 0, month = 0, stuck = false;
  while (list.some((d) => d.balance > 0) && month < MAX_MONTHS) {
    month++;
    let pool = extra;
    for (const d of list) {
      if (d.balance <= 0) { pool += d.min; continue; }   // freed-up minimums roll over
      const interest = Math.round(d.balance * d.rate);
      d.interest += interest; totalInterest += interest;
      d.balance += interest;
      const pay = Math.min(d.balance, d.min);
      d.balance -= pay;
      pool += d.min - pay;
    }
    for (const d of order()) {
      if (pool <= 0) break;
      const pay = Math.min(d.balance, pool);
      d.balance -= pay; pool -= pay;
    }
    for (const d of list) if (d.balance <= 0 && d.paidOffMonth === null) d.paidOffMonth = month;
    const total = list.reduce((s, d) => s + Math.max(0, d.balance), 0);
    series.push({ month, date: addMonths(startDate, month), balance: total });
    if (month === 24 && total >= series[0].balance) { stuck = true; break; }   // payments don't cover interest
  }
  const done = !list.some((d) => d.balance > 0);
  return {
    months: done ? month : null, debtFreeDate: done ? addMonths(startDate, month) : null, totalInterest: done ? totalInterest : null, stuck,
    order: list.slice().sort((a, b) => (a.paidOffMonth ?? 1e9) - (b.paidOffMonth ?? 1e9))
      .map((d) => ({ id: d.id, name: d.name, paidOffDate: d.paidOffMonth ? addMonths(startDate, d.paidOffMonth) : null, interest: d.interest })),
    series,
  };
}

export function payoffPlan(debts, { extra = 0, strategy = 'avalanche', startDate }) {
  const plan = simulate(debts, { extra, strategy, startDate });
  const baseline = simulate(debts, { extra: 0, strategy, startDate });
  const other = simulate(debts, { extra, strategy: strategy === 'avalanche' ? 'snowball' : 'avalanche', startDate });
  // Same month steps for every series (≤ ~120 points) so they chart on one time axis.
  const step = Math.max(1, Math.ceil(Math.max(plan.series.length, baseline.series.length) / 120));
  for (const r of [plan, baseline, other]) r.series = r.series.filter((p) => p.month % step === 0);
  return { strategy, extra, step, plan, baseline, other };
}

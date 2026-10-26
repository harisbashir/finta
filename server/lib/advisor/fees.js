// Fees & interest: what banking cost over the last year, by kind, and generic ways to pay less.
// Rows come from the Fees & Interest category (or uncategorized bank rows); rebates there are netted.
// Foreign exchange isn't itemized on statements, so it's estimated at 2.5% of foreign-currency purchases.
import { TX_JOINS, scopeFilter } from '../finance.js';
import { addDays } from '../dates.js';
import { dollars } from './format.js';

const FX_RATE = 0.025;
const FX_TAIL = /\d[\d,]*\.\d+\s+[A-Z]{3}\s+@\s+[\d.]+\s*$/;
// First match wins, so overdraft interest is overdraft, not interest.
const KINDS = [
  ['overdraft_nsf', 'Overdraft & NSF', /\b(OVERDRAFT|NSF|NON-?SUFFICIENT|OD INTEREST|OD FEE)\b/],
  ['annual_fees', 'Annual fees', /\bANNUAL FEE\b/],
  ['atm', 'ATM fees', /\b(ATM FEE|ABM FEE|NETWORK FEE|INTERAC FEE)\b/],
  ['fx', 'Foreign exchange', /\b(FOREIGN TRANSACTION FEE|FOREIGN EXCHANGE FEE|FX FEE|CURRENCY CONVERSION)\b/],
  ['late', 'Late fees', /\bLATE (PAYMENT )?FEE\b/],
  ['account_fees', 'Account fees', /\b(SERVICE CHARGE|SERVICE FEE|MONTHLY FEE|MTHLY|ACCOUNT FEE|PLAN FEE|MONTHLY FIXED|FRAIS|TRANSACTION FEE|E-TRANSFER FEE)\b/],
  ['interest', 'Interest', /\b(INTEREST|INTERETS|INT CHARGED|PURCHASE INT)\b/],
];
const LABELS = { ...Object.fromEntries(KINDS.map(([k, l]) => [k, l])), fx: 'Foreign exchange' };

const SUGGEST = {
  account_fees: (x) => `A no-fee chequing account would save about ${x} a year.`,
  overdraft_nsf: () => 'Watch the forecast on Today: it warns before chequing goes below $0. Your bank can also set up low-balance alerts or overdraft protection.',
  interest: () => 'Paying card balances in full each month avoids this interest. For a balance you carry, a lower-rate line of credit costs less.',
  annual_fees: (x) => `Check that your card’s rewards are worth more than its ${x} annual fee.`,
  atm: (x) => `Using your own bank’s ATMs, or cash back at checkout, would save about ${x} a year.`,
  fx: (x) => `A card with no foreign-transaction fee would save about ${x} a year.`,
  late: (x) => `Autopay for at least the minimum payment would have avoided ${x} in late fees.`,
};

export function feesReport(db, householdId, todayStr, { scope = 'household', userId = null } = {}) {
  const from = addDays(todayStr, -364);
  const sc = scopeFilter(scope, userId);
  const rows = db.prepare(`SELECT t.amount, t.direction, COALESCE(t.description, t.note, '') AS text, c.name AS cat_name ${TX_JOINS}
    WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 ${sc.sql}`).all(householdId, from, todayStr, ...sc.args);

  const sums = new Map();
  const counts = new Map();
  const add = (kind, cents) => { sums.set(kind, (sums.get(kind) || 0) + cents); if (cents > 0) counts.set(kind, (counts.get(kind) || 0) + 1); };
  let fxEstimated = false;
  for (const t of rows) {
    const text = t.text.toUpperCase();
    if (t.direction === 'out' && FX_TAIL.test(text)) { add('fx', Math.round(t.amount * FX_RATE)); fxEstimated = true; }
    if (t.cat_name !== 'Fees & Interest' && t.cat_name != null) continue;
    const match = KINDS.find(([, , re]) => re.test(text));
    const kind = match ? match[0] : t.cat_name === 'Fees & Interest' ? 'account_fees' : null;
    if (!kind) continue;
    add(kind, t.direction === 'out' ? t.amount : -t.amount);   // money back (rebates, discounts) offsets the same kind
  }

  const byKind = [...new Set(KINDS.map(([k]) => k))]
    .map((kind) => ({ kind, label: LABELS[kind], amount: Math.max(0, sums.get(kind) || 0), count: counts.get(kind) || 0 }))
    .filter((k) => k.amount > 0);
  return {
    from, to: todayStr,
    total: byKind.reduce((s, k) => s + k.amount, 0),
    byKind,
    suggestions: byKind.map((k) => ({ kind: k.kind, text: SUGGEST[k.kind](dollars(k.amount)), saving: k.amount })),
    fxEstimated,
  };
}

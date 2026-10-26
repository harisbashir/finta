// Cash-flow forecast: where chequing is heading over the next 60 days.
//   asOf    = the last day there's data for (statements are imported now and then, so it may be before today)
//   start   = chequing's balance on that day
//   events  = unpaid bills and paydays (Bills & Income) + repeating payments Finta detected on chequing
//   typical = chequing's average day over the 90 days before asOf, leaving out those events and moves between
//             your own chequing accounts (card payments, savings transfers and e-transfers stay in: they spend chequing)
import { accountBalances } from '../finance.js';
import { occurrences, addDays, diffDays } from '../dates.js';
import { recurringSuggestions, tokens } from '../importer.js';

const HISTORY_DAYS = 90;
const MIN_HISTORY_DAYS = 30;
const OVERDUE_DAYS = 7;
const WATCH_BELOW = 10000;   // $100
const PERIOD_DAYS = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91 };

/**
 * scope 'me' counts the member's own accounts and bills; with includeJoint, shared ones too (for Today).
 * viewerId: repeats are only named from chequing accounts the viewer may see line by line.
 */
export function forecast(db, householdId, todayStr, { scope = 'household', userId = null, viewerId = null, includeJoint = false, days = 60 } = {}) {
  const mine = (row) => scope !== 'me' || row.owner_id === userId || (includeJoint && row.owner_id == null);
  const chequing = db.prepare(`SELECT * FROM accounts WHERE household_id = ? AND type = 'chequing' AND archived = 0`).all(householdId).filter(mine);
  if (!chequing.length) return { basis: 'no-chequing', asOf: todayStr, start: 0, points: [], low: null, events: [], warning: null, typical: null };
  const ids = [...chequing.map((a) => a.id)];
  const idSet = new Set(ids);
  const bal = accountBalances(db, householdId);

  // The last day with data: the newest transaction or typed-in balance on these accounts, never after today.
  const latest = chequing.flatMap((a) => [bal.get(a.id)?.last_date, a.anchor_date]).filter(Boolean).sort().at(-1);
  const base = latest && latest < todayStr ? latest : todayStr;
  const start = chequing.reduce((s, a) => s + (bal.get(a.id)?.balance ?? a.opening_balance), 0);
  const end = addDays(todayStr, days);

  // ── Known events ──
  const events = [];
  const items = db.prepare('SELECT * FROM recurring WHERE household_id = ? AND paused = 0').all(householdId).filter(mine);
  const settled = new Set(db.prepare(`SELECT recurring_id || ':' || due_date AS k FROM transactions
    WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date >= ?`).all(householdId, addDays(base, -OVERDUE_DAYS)).map((r) => r.k));
  for (const item of items) {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, addDays(base, -OVERDUE_DAYS), end)) {
      if (settled.has(`${item.id}:${due}`)) continue;
      events.push({ date: due < base ? base : due, name: item.name, amount: item.amount, direction: item.direction, source: 'bill' });
    }
  }
  // Repeats are detected from chequing the viewer can see, so names and amounts never come from someone's private rows.
  const visible = chequing.filter((a) => viewerId == null || a.owner_id == null || a.owner_id === viewerId || !a.is_private).map((a) => a.id);
  const detected = visible.length ? recurringSuggestions(db, householdId, base, { limit: Infinity, accountIds: visible })
    .filter((s) => diffDays(s.last_date, base) <= 1.5 * PERIOD_DAYS[s.frequency]) : [];   // stopped repeating: leave it out
  for (const s of detected) {
    for (const date of occurrences({ frequency: s.frequency, start: s.last_date }, addDays(base, 1), end)) {
      events.push({ date, name: s.name, amount: s.amount, direction: s.direction, source: 'detected' });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  // ── Typical day ──
  const first = db.prepare(`SELECT MIN(date) AS d FROM transactions WHERE household_id = ? AND account_id IN (${ids.join(',')})`).get(householdId).d;
  const span = first ? Math.min(HISTORY_DAYS, diffDays(first, base) + 1) : 0;
  let typical = null;
  if (span >= MIN_HISTORY_DAYS) {
    const history = db.prepare(`SELECT t.*, peer.account_id AS peer_account FROM transactions t LEFT JOIN transactions peer ON peer.id = t.transfer_peer_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.account_id IN (${ids.join(',')})`).all(householdId, addDays(base, -(span - 1)), base);
    const detectedMerchants = new Set(detected.map((s) => s.merchant));
    // A tracked bill's own rows aren't linked to it, so skip rows that carry every word of a bill's name.
    const billWords = items.map((r) => tokens(r.payee || r.name)).filter((w) => w.length);
    let tin = 0, tout = 0;
    for (const t of history) {
      if (t.recurring_id) continue;
      if (t.merchant && detectedMerchants.has(t.merchant)) continue;
      if (t.merchant) { const words = new Set(tokens(t.merchant)); if (billWords.some((bw) => bw.every((w) => words.has(w)))) continue; }
      if (t.is_transfer && t.peer_account && idSet.has(t.peer_account)) continue;   // between your own chequing accounts
      if (t.direction === 'in') tin += t.amount; else tout += t.amount;
    }
    typical = { in: Math.round(tin / span), out: Math.round(tout / span) };
  }

  // ── Daily balance, from the last day with data ──
  const byDate = new Map();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) || 0) + (e.direction === 'in' ? e.amount : -e.amount));
  const daily = typical ? typical.in - typical.out : 0;
  const points = [];
  let balance = start;
  for (let i = 0, n = diffDays(base, end); i <= n; i++) {
    const date = addDays(base, i);
    if (i > 0) balance += daily;
    balance += byDate.get(date) || 0;
    points.push({ date, balance });
  }
  const low = points.reduce((m, p) => (p.balance < m.balance ? p : m), points[0]);
  const below = points.find((p) => p.balance < 0);
  const warning = below ? { level: 'danger', date: below.date } : low.balance < WATCH_BELOW ? { level: 'watch', date: low.date } : null;

  return {
    basis: typical ? 'full' : 'events-only', asOf: base, start, points, low: { date: low.date, balance: low.balance },
    events: events.filter((e) => e.date >= base).slice(0, 15), warning, typical,
  };
}

// Cash-flow forecast: where chequing is heading over the next 60 days.
//   start   = today's chequing balance
//   events  = unpaid bills and paydays (Bills & Income) + repeating payments Finta detected but you haven't added
//   typical = chequing's average day over the last 90 days, leaving out those events and moves between
//             your own chequing accounts (card payments, savings transfers and e-transfers stay in: they spend chequing)
import { accountBalances } from '../finance.js';
import { occurrences, addDays, diffDays } from '../dates.js';
import { recurringSuggestions, tokens } from '../importer.js';

const HISTORY_DAYS = 90;
const MIN_HISTORY_DAYS = 30;
const OVERDUE_DAYS = 7;
const WATCH_BELOW = 10000;   // $100

export function forecast(db, householdId, todayStr, { scope = 'household', userId = null, viewerId = null, days = 60 } = {}) {
  const mine = (row) => scope !== 'me' || row.owner_id === userId;
  const chequing = db.prepare(`SELECT * FROM accounts WHERE household_id = ? AND type = 'chequing' AND archived = 0`).all(householdId).filter(mine);
  if (!chequing.length) return { basis: 'no-chequing', start: 0, points: [], low: null, events: [], warning: null, typical: null };
  const ids = new Set(chequing.map((a) => a.id));
  const bal = accountBalances(db, householdId);
  const start = chequing.reduce((s, a) => s + (bal.get(a.id)?.balance ?? a.opening_balance), 0);
  const end = addDays(todayStr, days);

  // ── Known events ──
  const events = [];
  const items = db.prepare('SELECT * FROM recurring WHERE household_id = ? AND paused = 0').all(householdId).filter(mine);
  const settled = new Set(db.prepare(`SELECT recurring_id || ':' || due_date AS k FROM transactions
    WHERE household_id = ? AND recurring_id IS NOT NULL AND due_date >= ?`).all(householdId, addDays(todayStr, -OVERDUE_DAYS)).map((r) => r.k));
  for (const item of items) {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, addDays(todayStr, -OVERDUE_DAYS), end)) {
      if (settled.has(`${item.id}:${due}`)) continue;
      events.push({ date: due < todayStr ? todayStr : due, name: item.name, amount: item.amount, direction: item.direction, source: 'bill' });
    }
  }
  const since = addDays(todayStr, -(HISTORY_DAYS - 1));
  const history = db.prepare(`SELECT t.*, peer.account_id AS peer_account FROM transactions t LEFT JOIN transactions peer ON peer.id = t.transfer_peer_id
    WHERE t.household_id = ? AND t.date BETWEEN ? AND ?`).all(householdId, since, todayStr).filter((t) => ids.has(t.account_id));
  // Repeats are listed by name only from accounts the viewer may see line by line; others still count in the typical day.
  const visible = new Set(chequing.filter((a) => viewerId == null || a.owner_id == null || a.owner_id === viewerId || !a.is_private).map((a) => a.id));
  const chequingMerchants = new Set(history.filter((t) => visible.has(t.account_id)).map((t) => t.merchant).filter(Boolean));
  const detected = recurringSuggestions(db, householdId, todayStr, { limit: Infinity }).filter((s) => chequingMerchants.has(s.merchant));
  for (const s of detected) {
    for (const date of occurrences({ frequency: s.frequency, start: s.last_date }, addDays(todayStr, 1), end)) {
      if (date === s.last_date) continue;
      events.push({ date, name: s.name, amount: s.amount, direction: s.direction, source: 'detected' });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  // ── Typical day ──
  const first = db.prepare(`SELECT MIN(date) AS d FROM transactions WHERE household_id = ? AND account_id IN (${[...ids].join(',')})`).get(householdId).d;
  const span = first ? Math.min(HISTORY_DAYS, diffDays(first, todayStr) + 1) : 0;
  let typical = null;
  if (span >= MIN_HISTORY_DAYS) {
    const detectedMerchants = new Set(detected.map((s) => s.merchant));
    const trackedWords = new Set(items.flatMap((r) => tokens(`${r.name} ${r.payee || ''}`)));
    let tin = 0, tout = 0;
    for (const t of history) {
      if (t.recurring_id) continue;
      if (t.merchant && (detectedMerchants.has(t.merchant) || tokens(t.merchant).some((w) => trackedWords.has(w)))) continue;
      if (t.is_transfer && t.peer_account && ids.has(t.peer_account)) continue;   // between your own chequing accounts
      if (t.direction === 'in') tin += t.amount; else tout += t.amount;
    }
    typical = { in: Math.round(tin / span), out: Math.round(tout / span) };
  }

  // ── Daily balance ──
  const byDate = new Map();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) || 0) + (e.direction === 'in' ? e.amount : -e.amount));
  const daily = typical ? typical.in - typical.out : 0;
  const points = [];
  let balance = start;
  for (let i = 0; i <= days; i++) {
    const date = addDays(todayStr, i);
    if (i > 0) balance += daily;
    balance += byDate.get(date) || 0;
    points.push({ date, balance });
  }
  const low = points.reduce((m, p) => (p.balance < m.balance ? p : m), points[0]);
  const below = points.find((p) => p.balance < 0);
  const warning = below ? { level: 'danger', date: below.date } : low.balance < WATCH_BELOW ? { level: 'watch', date: low.date } : null;

  return {
    basis: typical ? 'full' : 'events-only', start, points, low: { date: low.date, balance: low.balance },
    events: events.slice(0, 15), warning, typical,
  };
}

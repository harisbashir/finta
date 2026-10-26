// Tax year (Canada): the yearly totals people look for at tax time, and registered-plan contributions
// compared with their room. RRSP contributions in the first 60 days of the next year count for this year
// (simplified to Mar 2 – Mar 1). Room comes from the CRA notice of assessment, entered by the person.
import { TX_JOINS, TX_OWNER } from '../finance.js';
import { limitsFor } from './limits.js';

const TOTALS = { charity: ['Charity', 'Gifts'], medical: ['Health'], tuition: ['Education'], kids: ['Kids'] };
const PLANS = ['rrsp', 'tfsa', 'fhsa'];

/** Before May 1 people are still filing last year's return. */
export const defaultTaxYear = (todayStr) => Number(todayStr.slice(0, 4)) - (todayStr.slice(5) < '05-01' ? 1 : 0);

export function taxYear(db, householdId, year, { scope = 'household', userId = null } = {}) {
  const limits = limitsFor(year);
  const users = db.prepare('SELECT id, name FROM users WHERE household_id = ? ORDER BY created_at, id').all(householdId)
    .filter((u) => scope !== 'me' || u.id === userId);

  // Spending (net of refunds) per owner and category for the calendar year.
  const rows = db.prepare(`SELECT ${TX_OWNER} AS who, c.name AS cat, SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE -t.amount END) AS net
    ${TX_JOINS} WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.is_transfer = 0 AND t.goal_id IS NULL AND c.kind = 'out'
    GROUP BY who, c.name`).all(householdId, `${year}-01-01`, `${year}-12-31`);
  const totalsFor = (who) => Object.fromEntries(Object.entries(TOTALS).map(([key, cats]) => [key,
    Math.max(0, rows.filter((r) => r.who === who && cats.includes(r.cat)).reduce((s, r) => s + r.net, 0))]));

  const accounts = db.prepare(`SELECT id, owner_id, registered FROM accounts WHERE household_id = ? AND registered IS NOT NULL`).all(householdId);
  const deposits = (accountIds, from, to) => accountIds.length ? db.prepare(`SELECT COALESCE(SUM(t.amount), 0) AS s FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.account_id IN (${accountIds.join(',')}) AND t.direction = 'in' AND t.date BETWEEN ? AND ? AND COALESCE(c.kind, '') != 'in'`).get(from, to).s : 0;
  const window = (kind) => kind === 'rrsp' ? [`${year}-03-02`, `${year + 1}-03-01`] : [`${year}-01-01`, `${year}-12-31`];
  const roomRows = db.prepare('SELECT user_id, kind, room FROM tax_room WHERE household_id = ? AND year = ?').all(householdId, year);

  const people = users.map((u) => {
    const own = (kind) => accounts.filter((a) => a.owner_id === u.id && a.registered === kind).map((a) => a.id);
    const contributions = PLANS.filter((kind) => own(kind).length || roomRows.some((r) => r.user_id === u.id && r.kind === kind)).map((kind) => {
      const amount = deposits(own(kind), ...window(kind));
      const room = roomRows.find((r) => r.user_id === u.id && r.kind === kind)?.room ?? null;
      return { kind, amount, room, limit: limits[kind], remaining: room == null ? null : room - amount };
    });
    const respContributed = deposits(own('resp'), ...window('resp'));
    return {
      user_id: u.id, name: u.name, totals: totalsFor(u.id), contributions,
      resp: { contributed: respContributed, grant: Math.round(Math.min(respContributed, limits.respGrantBase) * limits.respGrantRate) },
    };
  });
  if (scope !== 'me') {
    people.push({ user_id: null, name: 'Joint', totals: totalsFor(null), contributions: [], resp: { contributed: 0, grant: 0 } });
  }
  return { year, estimate: limits.estimate, people };
}

const LABEL = { charity: 'Donations', medical: 'Medical expenses', tuition: 'Tuition', kids: 'Kids (check which are childcare)', rrsp: 'RRSP', tfsa: 'TFSA', fhsa: 'FHSA' };
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const amt = (cents) => (cents / 100).toFixed(2);

/** One row per person per line item, amounts in dollars. */
export function taxCsv(result) {
  const out = [['person', 'section', 'item', 'amount']];
  for (const p of result.people) {
    for (const [k, v] of Object.entries(p.totals)) out.push([p.name, 'Credits & deductions', LABEL[k], amt(v)]);
    for (const c of p.contributions) {
      out.push([p.name, 'Registered plans', `${LABEL[c.kind]} contributions`, amt(c.amount)]);
      if (c.room != null) out.push([p.name, 'Registered plans', `${LABEL[c.kind]} room left`, amt(c.remaining)]);
    }
    if (p.resp.contributed) {
      out.push([p.name, 'Registered plans', 'RESP contributions', amt(p.resp.contributed)]);
      out.push([p.name, 'Registered plans', 'RESP grant (estimated CESG)', amt(p.resp.grant)]);
    }
  }
  return out.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

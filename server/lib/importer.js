// Statement import: CSV rows → categorized, de-duplicated transactions.
//
// For every imported row, in order:
//   1. Duplicate?          Same account, date, amount, direction and text as a row already stored → skipped.
//   2. Your rules          "TIM HORTONS → Dining Out", "TORONTO HYDRO → Hydro bill" (learned when you categorize).
//   3. Your bills          Matches a recurring item by name and amount near a due date → marked paid, linked.
//   4. Built-in knowledge  Hundreds of Canadian/US merchants and bank phrases → a category.
//   5. Otherwise           Left for you in Review, where one tap teaches Finta for next time.
// Afterwards, money leaving one of your accounts and arriving in another (a card payment from
// chequing, a move to savings) is paired as a transfer so it never counts as spending twice.
import crypto from 'node:crypto';
import { parseCsv, detectMapping, extractRows } from './csv.js';
import { merchantKey, displayName, guessCategory, looksLikeTransfer } from './merchant.js';
import { occurrences, addDays, diffDays } from './dates.js';
import { loanSplit, setAnchor } from './finance.js';
import { tx as inTx } from '../db.js';

export const MAX_ROWS = 5000;
const TOLERANCE_DAYS = { weekly: 2, biweekly: 4, semimonthly: 4, monthly: 7, quarterly: 10, yearly: 14 };

const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

export function fingerprint(row, n) {
  return crypto.createHash('sha256').update(`${row.date}|${row.direction}|${row.amount}|${norm(row.description)}|${n}`).digest('base64url').slice(0, 32);
}

// ───────── Context loaded once per import ─────────

export function loadContext(db, householdId) {
  const categories = db.prepare('SELECT * FROM categories WHERE household_id = ? AND archived = 0').all(householdId);
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const rules = db.prepare(`SELECT * FROM rules WHERE household_id = ? ORDER BY length(pattern) DESC`).all(householdId);
  const recurring = db.prepare('SELECT * FROM recurring WHERE household_id = ? AND paused = 0').all(householdId);
  return { db, householdId, categories, byName, rules, recurring, catById: new Map(categories.map((c) => [c.id, c])) };
}

const catId = (ctx, name) => ctx.byName.get(String(name).toLowerCase())?.id ?? null;

export function matchRule(ctx, merchant, kind = null) {
  return ctx.rules.find((r) => (!kind || r.kind === kind) && r.kind !== 'ignore_recurring' && merchant.includes(r.pattern)) || null;
}

const tokens = (s) => norm(s).split(/[^A-Z0-9&]+/).filter((w) => w.length >= 4 && !['PAYMENT', 'BILL', 'MONTHLY', 'CANADA', 'THE'].includes(w));

/** A recurring item this row probably pays: shared name word, similar amount, near a due date. */
function guessRecurring(ctx, row, merchant) {
  const words = new Set(tokens(merchant + ' ' + row.description));
  let best = null;
  for (const item of ctx.recurring) {
    if (item.direction !== row.direction) continue;
    const itemWords = tokens(`${item.name} ${item.payee || ''}`);
    if (!itemWords.some((w) => words.has(w))) continue;
    const diff = Math.abs(row.amount - item.amount);
    if (!item.variable && diff > Math.max(500, item.amount * 0.1)) continue;
    if (item.variable && diff > Math.max(2000, item.amount * 0.6)) continue;
    const occ = nearestOccurrence(item, row.date);
    if (!occ) continue;
    const score = -Math.abs(diffDays(occ, row.date)) - diff / 1000;
    if (!best || score > best.score) best = { item, occ, score };
  }
  return best;
}

export function nearestOccurrence(item, date) {
  const tol = TOLERANCE_DAYS[item.frequency] ?? 7;
  const occ = occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, addDays(date, -tol), addDays(date, tol));
  return occ.sort((a, b) => Math.abs(diffDays(a, date)) - Math.abs(diffDays(b, date)))[0] || null;
}

/**
 * Decide category/transfer/bill for one row (no writes).
 * Returns { name, category_id, cat_source, is_transfer, transfer_hint, recurring, occ }
 */
export function classify(ctx, row) {
  const merchant = merchantKey(row.description);
  const out = { merchant, name: displayName(merchant), category_id: null, cat_source: null, is_transfer: 0, transfer_hint: false, recurring: null, occ: null };

  const rule = matchRule(ctx, merchant);
  if (rule) {
    if (rule.rename_to) out.name = rule.rename_to;
    if (rule.kind === 'transfer') { out.is_transfer = 1; out.cat_source = 'rule'; return out; }
    if (rule.recurring_id) {
      const item = ctx.recurring.find((r) => r.id === rule.recurring_id);
      const occ = item && nearestOccurrence(item, row.date);
      if (item && occ && item.direction === row.direction) { out.recurring = item; out.occ = occ; }
    }
    out.category_id = rule.category_id ?? out.recurring?.category_id ?? null;
    out.cat_source = 'rule';
    if (out.category_id || out.recurring) return out;
  }

  const guess = guessCategory(row.description, row.direction);
  if (guess === 'Transfer') { out.is_transfer = 1; out.cat_source = 'auto'; out.transfer_hint = true; return out; }

  const bill = guessRecurring(ctx, row, merchant);
  if (bill) {
    out.recurring = bill.item; out.occ = bill.occ;
    out.category_id = bill.item.category_id; out.cat_source = 'recurring';
    out.name = bill.item.name;
    return out;
  }

  if (guess === 'Credit Card Payment') {
    // Paying a card you haven't imported: treat as a debt payment until its other half shows up.
    out.transfer_hint = true;
    out.category_id = catId(ctx, 'Debt'); out.cat_source = 'auto';
    return out;
  }
  if (guess) { out.category_id = catId(ctx, guess); out.cat_source = out.category_id ? 'auto' : null; }
  // Money in with transfer wording may be one of your own transfers, but an e-transfer from a person isn't.
  const fromPerson = /\b(E-?\s?TRANSFER|INTERAC E|E-?TFR|ETFR|EMT)\b/i.test(row.description);
  if (!out.category_id && row.direction === 'in' && !fromPerson && looksLikeTransfer(row.description)) out.transfer_hint = true;
  return out;
}

// ───────── Preview & commit ─────────

export function readStatement(account, csvText, override = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('That file is empty.');
  if (rows.length > MAX_ROWS + 1) throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller date ranges.`);
  const remembered = account.csv_mapping ? JSON.parse(account.csv_mapping) : null;
  const detected = detectMapping(rows);
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  // Reuse the mapping from last time when the file has the same shape.
  const base = remembered && remembered.width === width && remembered.hasHeader === detected.hasHeader ? { ...detected, ...remembered } : detected;
  const mapping = { ...base, ...pickMapping(override), width };
  if (mapping.date < 0) throw new Error('Couldn’t find a date column. Choose it below.');
  if (mapping.amount < 0 && mapping.debit < 0 && mapping.credit < 0) throw new Error('Couldn’t find the amount columns. Choose them below.');
  let flipSign = override.flipSign;
  if (flipSign === undefined) flipSign = remembered?.flipSign;
  if (flipSign === undefined && mapping.amount >= 0 && ['credit_card', 'line_of_credit'].includes(account.type)) {
    // Card statements with one amount column usually list purchases as positive numbers.
    const probe = extractRows(rows, mapping).rows;
    flipSign = probe.filter((r) => r.direction === 'in').length > probe.length / 2;
  }
  const { rows: parsed, errors } = extractRows(rows, mapping, { flipSign: !!flipSign });
  return { raw: rows, mapping: { ...mapping, flipSign: !!flipSign }, parsed, errors };
}

function pickMapping(o) {
  const out = {};
  for (const k of ['date', 'description', 'debit', 'credit', 'amount', 'balance']) if (Number.isInteger(o[k]) && o[k] >= -1 && o[k] < 100) out[k] = o[k];
  if (['MDY', 'DMY', 'YMD'].includes(o.dateOrder)) out.dateOrder = o.dateOrder;
  if (typeof o.hasHeader === 'boolean') out.hasHeader = o.hasHeader;
  return out;
}

function withFingerprints(accountId, rows) {
  const seen = new Map();
  return rows.map((r) => {
    const k = `${r.date}|${r.direction}|${r.amount}|${norm(r.description)}`;
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return { ...r, fingerprint: fingerprint(r, n) };
  });
}

export function previewImport(db, account, csvText, override) {
  const st = readStatement(account, csvText, override);
  const ctx = loadContext(db, account.household_id);
  const existing = new Set(db.prepare('SELECT fingerprint FROM transactions WHERE account_id = ? AND fingerprint IS NOT NULL').all(account.id).map((r) => r.fingerprint));
  const rows = withFingerprints(account.id, st.parsed).map((r) => {
    const c = classify(ctx, r);
    return {
      line: r.line, date: r.date, description: r.description, amount: r.amount, direction: r.direction,
      name: c.name, category_id: c.category_id, category: c.category_id ? ctx.catById.get(c.category_id)?.name : null,
      transfer: !!c.is_transfer || c.transfer_hint, bill: c.recurring?.name || null,
      duplicate: existing.has(r.fingerprint),
    };
  });
  const fresh = rows.filter((r) => !r.duplicate);
  return {
    mapping: st.mapping,
    headers: st.mapping.headers || st.raw[0].map((_, i) => `Column ${i + 1}`),
    sample: st.raw.slice(0, 4),
    rows: rows.slice(0, 200),
    total: rows.length,
    errors: st.errors.slice(0, 20),
    stats: {
      new: fresh.length,
      duplicates: rows.length - fresh.length,
      categorized: fresh.filter((r) => r.category_id || r.transfer).length,
      needsReview: fresh.filter((r) => !r.category_id && !r.transfer).length,
      bills: fresh.filter((r) => r.bill).length,
      transfers: fresh.filter((r) => r.transfer).length,
      moneyIn: fresh.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amount, 0),
      moneyOut: fresh.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amount, 0),
      from: rows.reduce((m, r) => (!m || r.date < m ? r.date : m), null),
      to: rows.reduce((m, r) => (!m || r.date > m ? r.date : m), null),
    },
    statementBalance: statementBalance(st.parsed, account),
  };
}

/**
 * The closing balance printed on the statement, if the file has a balance column: the balance
 * after the last transaction of the last day. Banks list rows oldest-first or newest-first, and
 * several rows can share the last date, so the running balance itself decides which row was last.
 */
export function statementBalance(rows, account) {
  const withBal = rows.filter((r) => r.balance !== null && r.balance !== undefined);
  if (!withBal.length) return null;
  const lastDate = withBal.reduce((m, r) => (r.date > m ? r.date : m), withBal[0].date);
  const sameDay = withBal.filter((r) => r.date === lastDate);
  let last = null;
  if (sameDay.length === 1) last = sameDay[0];
  else {
    // The last row is the one no other same-day row continues from: next.balance = this.balance ± next.amount.
    for (const sign of [1, -1]) {                       // bank accounts (+ in) and cards (+ owed) move opposite ways
      const signed = (r) => sign * (r.direction === 'in' ? r.amount : -r.amount);
      const ends = sameDay.filter((c) => !sameDay.some((x) => x !== c && Math.abs(x.balance - (c.balance + signed(x))) <= 1));
      if (ends.length === 1) { last = ends[0]; break; }
    }
    if (!last) {
      // Fall back to file order: the end of the file for oldest-first files, the start for newest-first.
      const ascending = rows[0].date <= rows[rows.length - 1].date;
      last = ascending ? sameDay[sameDay.length - 1] : sameDay[0];
    }
  }
  const owed = ['credit_card', 'line_of_credit'].includes(account.type);
  return { date: last.date, amount: owed ? -Math.abs(last.balance) : last.balance };
}

/** Write the import. Returns a summary for the "Imported" screen. */
export function commitImport(db, account, csvText, override, { userId, filename, useStatementBalance = true, closingBalance = null }) {
  const st = readStatement(account, csvText, override);
  const ctx = loadContext(db, account.household_id);
  const rows = withFingerprints(account.id, st.parsed);
  const summary = { imported: 0, duplicates: 0, categorized: 0, needsReview: 0, bills: 0, transfers: 0, errors: st.errors.length };

  return inTx(db, () => {
    const dates = rows.map((r) => r.date).sort();
    const imp = db.prepare(`INSERT INTO imports (household_id, account_id, filename, rows_total, date_from, date_to, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(account.household_id, account.id, filename ? String(filename).slice(0, 120) : null, rows.length, dates[0] || null, dates.at(-1) || null, userId);
    const importId = Number(imp.lastInsertRowid);
    const insert = db.prepare(`INSERT OR IGNORE INTO transactions
      (household_id, account_id, import_id, date, amount, direction, category_id, note, description, merchant, fingerprint, is_transfer, cat_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const bump = db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?');

    for (const r of rows) {
      const c = classify(ctx, r);
      const res = insert.run(account.household_id, account.id, importId, r.date, r.amount, r.direction, c.category_id, c.name,
        r.description, c.merchant, r.fingerprint, c.is_transfer, c.cat_source);
      if (!res.changes) { summary.duplicates++; continue; }
      summary.imported++;
      const id = Number(res.lastInsertRowid);
      if (c.cat_source === 'rule') { const rule = matchRule(ctx, c.merchant); if (rule) bump.run(rule.id); }
      if (c.recurring && c.occ && linkToOccurrence(db, c.recurring, id, c.occ)) summary.bills++;
      if (c.is_transfer) summary.transfers++;
      if (c.category_id || c.is_transfer) summary.categorized++; else summary.needsReview++;
      // Learn: an automatic bill match becomes a rule so next month is instant.
      if (c.cat_source === 'recurring' && c.recurring) learnRule(db, account.household_id, c.merchant, { category_id: c.recurring.category_id, recurring_id: c.recurring.id, rename_to: c.recurring.name }, userId, ctx);
    }
    db.prepare('UPDATE imports SET rows_imported = ?, rows_skipped = ? WHERE id = ?').run(summary.imported, summary.duplicates, importId);

    const paired = pairTransfers(db, account.household_id, addDays(dates[0] || '1970-01-01', -7), addDays(dates.at(-1) || '2999-01-01', 7));
    summary.transfers += paired.newlyPaired;
    summary.needsReview = Math.max(0, summary.needsReview - paired.fromReview);

    // Remember how this bank's files look.
    const { headers, ...keep } = st.mapping;
    db.prepare('UPDATE accounts SET csv_mapping = ? WHERE id = ?').run(JSON.stringify(keep), account.id);

    // Pin the balance to the statement: its own closing balance, or the one you typed in the preview
    // (for files without a balance column). An older statement never overrides a newer balance.
    let sb = useStatementBalance ? statementBalance(st.parsed, account) : null;
    if (!sb && closingBalance && Number.isInteger(closingBalance.amount) && dates.length) {
      const owed = ['credit_card', 'line_of_credit'].includes(account.type);
      sb = { date: dates.at(-1), amount: owed ? -Math.abs(closingBalance.amount) : closingBalance.amount };
    }
    if (sb) {
      if (setAnchor(db, account, sb.amount, sb.date, 'statement')) summary.balanceUpdated = sb;
      else summary.balanceKept = { date: account.anchor_date };
    }
    return { importId, ...summary, from: dates[0] || null, to: dates.at(-1) || null };
  });
}

// ───────── Bills ─────────

/**
 * Make transaction `txId` the payment for `item` on `occ`. An automatic (autopay) placeholder
 * for that date is replaced; a real payment already there wins and nothing changes.
 */
export function linkToOccurrence(db, item, txId, occ) {
  const existing = db.prepare('SELECT * FROM transactions WHERE recurring_id = ? AND due_date = ?').get(item.id, occ);
  if (existing && existing.id !== txId) {
    if (existing.account_id) return false;                 // already settled by another real transaction
    restorePrincipal(db, existing);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(existing.id);
  }
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  let principal = null;
  if (item.kind === 'loan') {
    const debt = db.prepare('SELECT * FROM debts WHERE recurring_id = ? AND account_id IS NULL').get(item.id);
    if (debt && debt.balance > 0) {
      principal = loanSplit({ loan_balance: debt.balance, loan_rate: debt.rate, frequency: item.frequency }, t.amount).principal;
      db.prepare('UPDATE debts SET balance = MAX(0, balance - ?) WHERE id = ?').run(principal, debt.id);
    }
  }
  db.prepare(`UPDATE transactions SET recurring_id = ?, due_date = ?, principal = ?, is_transfer = 0, transfer_peer_id = NULL,
    category_id = COALESCE(category_id, ?), cat_source = COALESCE(cat_source, 'recurring') WHERE id = ?`)
    .run(item.id, occ, principal, item.category_id, txId);
  return true;
}

export function restorePrincipal(db, t) {
  if (!t.principal || !t.recurring_id) return;
  db.prepare('UPDATE debts SET balance = balance + ? WHERE recurring_id = ? AND account_id IS NULL').run(t.principal, t.recurring_id);
}

// ───────── Transfers ─────────

/**
 * Pair money out of one account with the same amount into another within 5 days.
 * A pair needs a reason beyond the amount: payment/transfer wording, or a card/credit-line on
 * the receiving side. Paired rows stop counting as spending or income.
 */
export function pairTransfers(db, householdId, from, to) {
  const rows = db.prepare(`SELECT t.*, a.type AS account_type FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.transfer_peer_id IS NULL AND t.recurring_id IS NULL
      AND t.goal_id IS NULL AND (t.cat_source IS NULL OR t.cat_source != 'manual')
    ORDER BY t.date`).all(householdId, from, to);
  const outs = rows.filter((r) => r.direction === 'out');
  const ins = rows.filter((r) => r.direction === 'in');
  const used = new Set();
  let newlyPaired = 0, fromReview = 0;
  const set = db.prepare(`UPDATE transactions SET is_transfer = 1, transfer_peer_id = ?, category_id = NULL, cat_source = 'transfer' WHERE id = ?`);
  for (const o of outs) {
    let best = null;
    for (const i of ins) {
      if (used.has(i.id) || i.account_id === o.account_id || i.amount !== o.amount) continue;
      const gap = Math.abs(diffDays(o.date, i.date));
      if (gap > 5) continue;
      let score = 0;
      if (looksLikeTransfer(o.description) || o.is_transfer) score += 2;
      if (looksLikeTransfer(i.description) || i.is_transfer) score += 2;
      if (['credit_card', 'line_of_credit'].includes(i.account_type) && !['credit_card', 'line_of_credit'].includes(o.account_type)) score += 2;
      if (score < 2) continue;
      score -= gap * 0.3;
      if (!best || score > best.score) best = { i, score };
    }
    if (!best) continue;
    used.add(best.i.id);
    for (const t of [o, best.i]) if (!t.category_id && !t.is_transfer) fromReview++;
    set.run(best.i.id, o.id);
    set.run(o.id, best.i.id);
    newlyPaired++;
  }
  return { newlyPaired, fromReview };
}

export function unpairTransfer(db, t) {
  if (t.transfer_peer_id) {
    db.prepare(`UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL, cat_source = NULL WHERE id = ?`).run(t.transfer_peer_id);
  }
  db.prepare(`UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL WHERE id = ?`).run(t.id);
}

// ───────── Learning ─────────

/** Create or update a rule for a merchant, then apply it to matching rows you haven't set by hand. */
export function learnRule(db, householdId, pattern, { category_id = null, recurring_id = null, rename_to = null, kind = 'categorize' }, userId, ctx) {
  if (!pattern || pattern.length < 3) return null;
  const existing = db.prepare('SELECT * FROM rules WHERE household_id = ? AND pattern = ? AND kind = ?').get(householdId, pattern, kind);
  let id;
  if (existing) {
    db.prepare('UPDATE rules SET category_id = ?, recurring_id = COALESCE(?, recurring_id), rename_to = COALESCE(?, rename_to) WHERE id = ?')
      .run(category_id, recurring_id, rename_to, existing.id);
    id = existing.id;
  } else {
    id = Number(db.prepare('INSERT INTO rules (household_id, pattern, kind, category_id, recurring_id, rename_to, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(householdId, pattern, kind, category_id, recurring_id, rename_to, userId).lastInsertRowid);
  }
  if (ctx) ctx.rules = db.prepare(`SELECT * FROM rules WHERE household_id = ? ORDER BY length(pattern) DESC`).all(householdId);
  return id;
}

/** Re-apply one rule to earlier rows: fills in anything not categorized by hand. Returns rows changed. */
export function applyRule(db, householdId, ruleId) {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ? AND household_id = ?').get(ruleId, householdId);
  if (!rule) return 0;
  const rows = db.prepare(`SELECT * FROM transactions WHERE household_id = ? AND merchant LIKE ? ESCAPE '\\'
    AND (cat_source IS NULL OR cat_source IN ('auto','rule')) AND transfer_peer_id IS NULL AND goal_id IS NULL`)
    .all(householdId, `%${rule.pattern.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  let changed = 0;
  for (const t of rows) {
    if (rule.kind === 'transfer') {
      db.prepare(`UPDATE transactions SET is_transfer = 1, category_id = NULL, cat_source = 'rule' WHERE id = ?`).run(t.id);
    } else {
      db.prepare(`UPDATE transactions SET category_id = ?, is_transfer = 0, cat_source = 'rule', note = COALESCE(?, note) WHERE id = ?`)
        .run(rule.category_id, rule.rename_to, t.id);
      if (rule.recurring_id && !t.recurring_id) {
        const item = db.prepare('SELECT * FROM recurring WHERE id = ?').get(rule.recurring_id);
        const occ = item && item.direction === t.direction && nearestOccurrence(item, t.date);
        if (occ) linkToOccurrence(db, item, t.id, occ);
      }
    }
    changed++;
  }
  return changed;
}

export function undoImport(db, householdId, importId) {
  return inTx(db, () => {
    const rows = db.prepare('SELECT * FROM transactions WHERE import_id = ? AND household_id = ?').all(importId, householdId);
    for (const t of rows) { restorePrincipal(db, t); unpairTransfer(db, t); }
    db.prepare('DELETE FROM transactions WHERE import_id = ? AND household_id = ?').run(importId, householdId);
    db.prepare('DELETE FROM imports WHERE id = ? AND household_id = ?').run(importId, householdId);
    return rows.length;
  });
}

// ───────── Recurring suggestions ─────────

/**
 * Spot things that repeat: the same merchant in at least 3 of the last 6 months (or every
 * week/two weeks), at a steady amount, not already tracked. Returns suggestions to accept in one tap.
 */
export function recurringSuggestions(db, householdId, todayStr) {
  const since = addDays(todayStr, -200);
  // Everyday spending repeats too (groceries every week) but isn't a bill. Only fixed-amount
  // repeats in those categories are worth suggesting.
  const everyday = new Set(db.prepare(`SELECT id FROM categories WHERE household_id = ? AND name IN
    ('Groceries','Dining Out','Transport','Shopping','Entertainment','Personal Care','Health','Gifts','Travel','Kids','Pets','Other Income','Fees & Interest')`).all(householdId).map((c) => c.id));
  const rows = db.prepare(`SELECT merchant, note, date, amount, direction, category_id FROM transactions
    WHERE household_id = ? AND account_id IS NOT NULL AND date >= ? AND recurring_id IS NULL AND is_transfer = 0
      AND goal_id IS NULL AND merchant IS NOT NULL ORDER BY date`).all(householdId, since);
  const ignored = new Set(db.prepare(`SELECT pattern FROM rules WHERE household_id = ? AND kind = 'ignore_recurring'`).all(householdId).map((r) => r.pattern));
  const tracked = db.prepare('SELECT name, payee FROM recurring WHERE household_id = ?').all(householdId).flatMap((r) => tokens(`${r.name} ${r.payee || ''}`));
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.direction}|${r.merchant}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [direction, merchant] = k.split('|');
    if (ignored.has(merchant) || list.length < 2) continue;
    if (tokens(merchant).some((w) => tracked.includes(w))) continue;
    const amounts = list.map((r) => r.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const steady = list.filter((r) => Math.abs(r.amount - median) <= Math.max(300, median * 0.15));
    if (steady.length < 2) continue;
    const gaps = steady.slice(1).map((r, i) => diffDays(steady[i].date, r.date)).filter((g) => g > 0);
    if (!gaps.length) continue;
    const g = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const frequency = g >= 5 && g <= 9 ? 'weekly' : g >= 12 && g <= 16 ? 'biweekly' : g >= 26 && g <= 35 ? 'monthly' : g >= 85 && g <= 100 ? 'quarterly' : null;
    if (!frequency) continue;
    const months = new Set(steady.map((r) => r.date.slice(0, 7))).size;
    const needed = frequency === 'monthly' ? 3 : frequency === 'quarterly' ? 2 : 4;
    if ((frequency === 'monthly' || frequency === 'quarterly' ? months : steady.length) < needed) continue;
    const last = steady.at(-1);
    const variable = amounts.at(-1) - amounts[0] > Math.max(300, median * 0.05);
    const fixed = steady.every((x) => x.amount === steady[0].amount);
    if (everyday.has(steady.at(-1).category_id) && !fixed) continue;
    out.push({
      merchant, direction, frequency, amount: median, variable, count: steady.length,
      name: last.note || displayName(merchant), last_date: last.date, first_date: steady[0].date,
      category_id: last.category_id,
      kind: direction === 'in' ? 'income' : /NETFLIX|SPOTIFY|DISNEY|PRIME|APPLE|GOOGLE|YOUTUBE|ADOBE|MICROSOFT|CRAVE|AUDIBLE|PATREON|DROPBOX|OPENAI|GYM|FITNESS/.test(merchant) ? 'subscription'
        : /INSURANCE|INTACT|AVIVA|BELAIR|MANULIFE|SUN LIFE/.test(merchant) ? 'insurance' : 'bill',
    });
  }
  return out.sort((a, b) => b.amount - a.amount).slice(0, 12);
}

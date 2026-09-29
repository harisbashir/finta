// One-time data upgrades that need code, not just SQL. Each runs once, recorded in schema_migrations
// next to the SQL migrations, inside its own transaction.
import { merchantKey, displayName } from './merchant.js';
import { loadContext, classify, linkToOccurrence, pairTransfers } from './importer.js';

const STEPS = [
  ['1.1.2-merchant-keys', merchantKeys],
  ['1.1.2-balance-anchors', balanceAnchors],
];

export { merchantKeys, balanceAnchors };

export function runUpgrades(db) {
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const [name, fn] of STEPS) {
    if (done.has(name)) continue;
    db.exec('BEGIN');
    try {
      fn(db);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Upgrade ${name} failed: ${err.message}`);
    }
  }
}

/**
 * 1.1.2 reads payees past bank labels ("Point of Sale - Visa Debit … PAY TO: CRA" is CRA, not
 * "Point of Sale"). Re-key every imported row, drop rules that were learned for a bank label
 * (they lumped unrelated payees together), and sort again whatever those rules had sorted.
 */
function merchantKeys(db) {
  for (const { id: hid } of db.prepare('SELECT id FROM households').all()) {
    const rows = db.prepare('SELECT * FROM transactions WHERE household_id = ? AND account_id IS NOT NULL AND description IS NOT NULL').all(hid);
    if (!rows.length) continue;
    const next = new Map(rows.map((r) => [r.id, merchantKey(r.description)]));
    const rules = db.prepare("SELECT * FROM rules WHERE household_id = ? AND kind != 'ignore_recurring'").all(hid);

    // A rule is stale when it matched old keys but matches no new key. If its old rows now fall under
    // one payee, it follows that payee; if they spread over several, it was a bank label: remove it.
    const reset = new Set();
    for (const rule of rules) {
      if (rows.some((r) => next.get(r.id).includes(rule.pattern))) continue;
      const hit = rows.filter((r) => (r.merchant || '').includes(rule.pattern));
      if (!hit.length) continue;
      const payees = new Set(hit.map((r) => next.get(r.id)));
      if (payees.size === 1) {
        const [key] = payees;
        const clash = db.prepare('SELECT id FROM rules WHERE household_id = ? AND pattern = ? AND kind = ?').get(hid, key, rule.kind);
        if (clash) db.prepare('DELETE FROM rules WHERE id = ?').run(rule.id);
        else db.prepare('UPDATE rules SET pattern = ? WHERE id = ?').run(key, rule.id);
      } else {
        db.prepare('DELETE FROM rules WHERE id = ?').run(rule.id);
        for (const r of hit) if (r.cat_source === 'rule' || r.cat_source === 'auto') reset.add(r.id);
      }
    }

    const upd = db.prepare('UPDATE transactions SET merchant = ?, note = ? WHERE id = ?');
    for (const r of rows) {
      const key = next.get(r.id);
      if (key === r.merchant) continue;
      // Keep names you typed; replace names Finta made from the old key.
      const autoName = !r.note || r.note === displayName(r.merchant || '');
      upd.run(key, autoName ? displayName(key) : r.note, r.id);
    }
    if (reset.size) {
      const clear = db.prepare(`UPDATE transactions SET category_id = NULL, is_transfer = 0, cat_source = NULL
        WHERE id = ? AND recurring_id IS NULL AND transfer_peer_id IS NULL AND goal_id IS NULL`);
      for (const id of reset) clear.run(id);
    }

    // Sort again everything still waiting in Review.
    const ctx = loadContext(db, hid);
    const waiting = db.prepare(`SELECT * FROM transactions WHERE household_id = ? AND account_id IS NOT NULL AND category_id IS NULL
      AND is_transfer = 0 AND recurring_id IS NULL AND goal_id IS NULL AND (cat_source IS NULL OR cat_source != 'manual')`).all(hid);
    const set = db.prepare('UPDATE transactions SET category_id = ?, is_transfer = ?, cat_source = ?, note = ? WHERE id = ?');
    for (const t of waiting) {
      const c = classify(ctx, { date: t.date, amount: t.amount, direction: t.direction, description: t.description });
      if (!c.category_id && !c.is_transfer && !c.recurring) continue;
      set.run(c.category_id, c.is_transfer, c.cat_source, c.name, t.id);
      if (c.recurring && c.occ) linkToOccurrence(db, c.recurring, t.id, c.occ);
    }
    const span = db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM transactions WHERE household_id = ? AND account_id IS NOT NULL').get(hid);
    if (span.a) pairTransfers(db, hid, span.a, span.b);
  }
}

/**
 * Before 1.1.2 a balance typed when creating an account became its *opening* balance, so importing
 * older statements afterwards added that history on top. Pin it to the day it was typed instead.
 * Skipped for accounts whose files carry a balance column (the statement already sets it) and for
 * the example data (whose opening balance really is an opening balance).
 */
function balanceAnchors(db) {
  const accounts = db.prepare(`SELECT a.*, h.timezone FROM accounts a JOIN households h ON h.id = a.household_id
    WHERE a.anchor_date IS NULL AND a.opening_balance != 0`).all();
  const example = db.prepare(`SELECT 1 FROM imports WHERE account_id = ? AND filename LIKE '%example.csv' LIMIT 1`);
  const set = db.prepare(`UPDATE accounts SET anchor_balance = opening_balance, anchor_date = ?, anchor_source = 'you' WHERE id = ?`);
  for (const a of accounts) {
    let mapping = null;
    try { mapping = a.csv_mapping ? JSON.parse(a.csv_mapping) : null; } catch { /* ignore */ }
    if (mapping && mapping.balance >= 0) continue;
    if (example.get(a.id)) continue;
    const created = new Date(String(a.created_at).replace(' ', 'T') + 'Z');
    let day;
    try { day = created.toLocaleDateString('en-CA', { timeZone: a.timezone || 'UTC' }); } catch { day = created.toISOString().slice(0, 10); }
    set.run(day, a.id);
  }
}

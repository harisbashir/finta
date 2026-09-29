// Accounts, statement import, the Review inbox, and learned rules.
import { bad, notFound, forbidden } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { getOwned, insertRow, updateRow } from '../lib/crud.js';
import { accountBalances, setAnchor, TX_JOINS, TX_VISIBLE } from '../lib/finance.js';
import { previewImport, commitImport, undoImport, learnRule, applyRule, loadContext, pairTransfers, unpairTransfer,
  linkToOccurrence, nearestOccurrence, recurringSuggestions, restorePrincipal } from '../lib/importer.js';
import { merchantKey, displayName } from '../lib/merchant.js';
import { addDays } from '../lib/dates.js';
import { audit } from '../lib/session.js';
import { tx } from '../db.js';

const TYPES = ['chequing', 'savings', 'credit_card', 'line_of_credit', 'cash', 'investment'];
const OWES = ['credit_card', 'line_of_credit'];

const accountSchema = {
  name: t.str(60, { required: true }),
  type: t.oneOf(TYPES, { required: true }),
  institution: t.str(60),
  last4: t.str(4),
  owner_id: t.ref('users', { label: 'owner' }),
  credit_limit: t.money({ label: 'credit limit' }),
  is_private: t.bool(),
  archived: t.bool(),
};

/** Can this member see this account's individual transactions? */
export const canSeeAccount = (a, user) => a.owner_id === null || a.owner_id === user.id || !a.is_private;
/** Can this member change this account (import, edit)? Joint accounts: anyone. */
const canEditAccount = (a, user) => a.owner_id === null || a.owner_id === user.id;

function present(a, bal, user, users) {
  const b = bal.get(a.id);
  const balance = b ? b.balance : a.opening_balance;
  const visible = canSeeAccount(a, user);
  return {
    id: a.id, name: a.name, type: a.type, institution: a.institution, last4: a.last4, owner_id: a.owner_id,
    owner_name: a.owner_id ? users.get(a.owner_id)?.name : null, is_private: !!a.is_private, archived: !!a.archived,
    credit_limit: a.credit_limit, balance, owed: OWES.includes(a.type) ? Math.max(0, -balance) : null,
    last_date: b?.last_date || null, count: visible ? b?.count || 0 : null,
    can_view: visible, can_edit: canEditAccount(a, user),
    balance_date: a.anchor_date || null, balance_source: a.anchor_source || null,
  };
}

export function bankAccountRoutes(r) {
  const today = (ctx) => ctx.today();
  /** "Balance on" date sent with a typed balance: today by default, never in the future. */
  const balanceDate = (ctx) => {
    const d = ctx.body.balance_date;
    if (d === undefined || d === null || d === '') return today(ctx);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || Number.isNaN(Date.parse(d))) throw bad('Use a real date for the balance.', { field: 'balance_date' });
    if (d > today(ctx)) throw bad('The balance date can’t be in the future.', { field: 'balance_date' });
    return d;
  };
  const usersMap = (ctx) => new Map(ctx.db.prepare('SELECT id, name FROM users WHERE household_id = ?').all(ctx.household.id).map((u) => [u.id, u]));
  const loadAccount = (ctx, id, { edit = false, view = false } = {}) => {
    const a = getOwned(ctx.db, 'accounts', id, ctx.household.id);
    if (view && !canSeeAccount(a, ctx.user)) throw forbidden('This account is private to its owner.');
    if (edit && !canEditAccount(a, ctx.user)) throw forbidden('Only the owner can change this account.');
    return a;
  };

  r.get('/api/accounts', (ctx) => {
    const bal = accountBalances(ctx.db, ctx.household.id);
    const users = usersMap(ctx);
    return ctx.db.prepare('SELECT * FROM accounts WHERE household_id = ? ORDER BY archived, type, name').all(ctx.household.id)
      .map((a) => present(a, bal, ctx.user, users));
  });

  r.post('/api/accounts', (ctx) => {
    const v = validate(ctx.body, accountSchema, { db: ctx.db, householdId: ctx.household.id });
    if (v.last4 && !/^\d{1,4}$/.test(v.last4)) throw bad('Last digits should be up to 4 numbers.', { field: 'last4' });
    if (!('owner_id' in ctx.body)) v.owner_id = ctx.user.id;
    const current = validate(ctx.body, { current_balance: t.int(-100_000_000_000, 100_000_000_000, { label: 'balance' }) }).current_balance ?? 0;
    // People enter what a card *owes* as a positive number.
    v.opening_balance = OWES.includes(v.type) ? -Math.abs(current) : current;
    const row = tx(ctx.db, () => {
      const acc = insertRow(ctx.db, 'accounts', ctx.household.id, v);
      // A balance typed in now is today's balance: statements imported later fill in history behind it.
      if ('current_balance' in ctx.body && ctx.body.current_balance !== null) setAnchor(ctx.db, acc, v.opening_balance, balanceDate(ctx), 'you', { force: true });
      if (OWES.includes(v.type) && ctx.body.track_debt !== false) {
        const d = validate(ctx.body, { rate: t.real(0, 100, { label: 'interest rate' }), min_payment: t.money({ label: 'minimum payment' }) });
        ctx.db.prepare(`INSERT INTO debts (household_id, owner_id, name, type, lender, rate, min_payment, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(ctx.household.id, v.owner_id ?? null, v.name, v.type, v.institution ?? null, d.rate ?? null, d.min_payment ?? null, acc.id);
      }
      return acc;
    });
    return present(row, accountBalances(ctx.db, ctx.household.id), ctx.user, usersMap(ctx));
  });

  r.patch('/api/accounts/:id', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id, { edit: true });
    const v = validate(ctx.body, accountSchema, { db: ctx.db, householdId: ctx.household.id, partial: true });
    if ('name' in v && !v.name) throw bad('Add a name.', { field: 'name' });
    if ('owner_id' in v && a.owner_id !== ctx.user.id && a.owner_id !== null) throw forbidden();
    // "Current balance" re-anchors the account without touching transactions.
    if ('current_balance' in ctx.body) {
      const cur = validate(ctx.body, { current_balance: t.int(-100_000_000_000, 100_000_000_000, { required: true, label: 'balance' }) }).current_balance;
      const target = OWES.includes(v.type || a.type) ? -Math.abs(cur) : cur;
      setAnchor(ctx.db, a, target, balanceDate(ctx), 'you', { force: true });
    }
    const row = updateRow(ctx.db, 'accounts', a.id, ctx.household.id, v);
    if (v.name) ctx.db.prepare('UPDATE debts SET name = ? WHERE account_id = ?').run(v.name, a.id);
    return present(row, accountBalances(ctx.db, ctx.household.id), ctx.user, usersMap(ctx));
  });

  r.delete('/api/accounts/:id', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id, { edit: true });
    tx(ctx.db, () => {
      // Transfers that pointed at this account's rows become ordinary rows again.
      ctx.db.prepare(`UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL, cat_source = NULL
        WHERE transfer_peer_id IN (SELECT id FROM transactions WHERE account_id = ?)`).run(a.id);
      for (const t of ctx.db.prepare('SELECT * FROM transactions WHERE account_id = ? AND principal IS NOT NULL').all(a.id)) restorePrincipal(ctx.db, t);
      ctx.db.prepare('DELETE FROM debts WHERE account_id = ?').run(a.id);
      ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    });
    audit(ctx, 'account.deleted', a.name);
    return { ok: true };
  });

  /** One account: balance history (for the chart) and recent imports. */
  r.get('/api/accounts/:id', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id);
    const bal = accountBalances(ctx.db, ctx.household.id);
    const out = present(a, bal, ctx.user, usersMap(ctx));
    // Daily closing balance for the last 180 days (walk back from today's balance).
    const since = addDays(today(ctx), -180);
    const net = new Map(ctx.db.prepare(`SELECT date, SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) AS net FROM transactions
      WHERE account_id = ? AND date > ? GROUP BY date`).all(a.id, since).map((d) => [d.date, d.net]));
    const future = [...net].filter(([d]) => d > today(ctx)).reduce((s, [, n]) => s + n, 0);
    let running = out.balance - future;
    const series = [];
    for (let i = 0; i <= 180; i++) {
      const date = addDays(today(ctx), -i);
      series.push({ date, balance: running });
      running -= net.get(date) || 0;
    }
    // Day-by-day balances would reveal individual amounts, so private accounts only show today's total.
    out.history = out.can_view ? series.reverse() : [];
    out.imports = canEditAccount(a, ctx.user) ? ctx.db.prepare(`SELECT id, filename, rows_imported, rows_skipped, date_from, date_to, created_at FROM imports
      WHERE account_id = ? ORDER BY id DESC LIMIT 12`).all(a.id) : [];
    out.debt = ctx.db.prepare('SELECT id, rate, min_payment FROM debts WHERE account_id = ?').get(a.id) || null;
    return out;
  });

  // ── Import ──
  r.post('/api/accounts/:id/import/preview', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id, { edit: true });
    const csv = String(ctx.body.csv || '');
    if (!csv.trim()) throw bad('Choose a CSV file.');
    try { return previewImport(ctx.db, a, csv, ctx.body.mapping || {}); }
    catch (e) { throw bad(e.message); }
  });

  r.post('/api/accounts/:id/import', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id, { edit: true });
    const csv = String(ctx.body.csv || '');
    if (!csv.trim()) throw bad('Choose a CSV file.');
    let res;
    try {
      res = commitImport(ctx.db, a, csv, ctx.body.mapping || {}, {
        userId: ctx.user.id, filename: ctx.body.filename, useStatementBalance: ctx.body.useStatementBalance !== false,
        closingBalance: ctx.body.closingBalance ?? null,
      });
    } catch (e) { throw bad(e.message); }
    audit(ctx, 'statement.imported', `${a.name}: ${res.imported} rows`);
    return res;
  });

  r.delete('/api/imports/:id', (ctx) => {
    const imp = getOwned(ctx.db, 'imports', ctx.params.id, ctx.household.id);
    loadAccount(ctx, imp.account_id, { edit: true });
    const removed = undoImport(ctx.db, ctx.household.id, imp.id);
    return { ok: true, removed };
  });

  // ── Transactions of one account ──
  r.get('/api/accounts/:id/transactions', (ctx) => {
    const a = loadAccount(ctx, ctx.params.id, { view: true });
    const where = ['t.account_id = ?'];
    const args = [a.id];
    if (/^\d{4}-\d{2}$/.test(ctx.query.month || '')) { where.push('substr(t.date, 1, 7) = ?'); args.push(ctx.query.month); }
    if (ctx.query.filter === 'review') where.push('t.category_id IS NULL AND t.is_transfer = 0 AND t.recurring_id IS NULL');
    if (ctx.query.q) { where.push('(t.note LIKE ? OR t.description LIKE ?)'); const q = `%${String(ctx.query.q).slice(0, 60).replace(/[%_]/g, '')}%`; args.push(q, q); }
    return ctx.db.prepare(`SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon, r.name AS recurring_name, r.kind AS recurring_kind,
        pa.name AS peer_account
      ${TX_JOINS} LEFT JOIN transactions pt ON pt.id = t.transfer_peer_id LEFT JOIN accounts pa ON pa.id = pt.account_id
      WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT 1000`).all(...args);
  });

  // ── Review inbox ──
  r.get('/api/review', (ctx) => {
    const rows = ctx.db.prepare(`SELECT t.*, a.name AS account_name, a.type AS account_type ${TX_JOINS}
      WHERE t.household_id = ? AND ${TX_VISIBLE} AND t.category_id IS NULL AND t.is_transfer = 0 AND t.recurring_id IS NULL AND t.goal_id IS NULL
        AND t.account_id IS NOT NULL
      ORDER BY t.date DESC LIMIT 1000`).all(ctx.household.id, ctx.user.id);
    // Group by merchant so one decision can cover many rows.
    const groups = new Map();
    for (const row of rows) {
      const k = `${row.direction}|${row.merchant || row.description}`;
      if (!groups.has(k)) groups.set(k, { key: row.merchant, label: displayName(row.merchant || ''), direction: row.direction, name: row.note || displayName(row.merchant || ''), rows: [], total: 0 });
      const g = groups.get(k); g.rows.push(row); g.total += row.amount;
    }
    return { count: rows.length, groups: [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || b.total - a.total) };
  });

  /**
   * Categorize a transaction (and, by default, every similar one, now and in future imports).
   * body: { category_id?, transfer?: bool, recurring_id?, rename?, apply_to_similar = true }
   */
  r.post('/api/transactions/:id/categorize', (ctx) => {
    const row = getOwned(ctx.db, 'transactions', ctx.params.id, ctx.household.id);
    const acc = row.account_id ? ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.account_id) : null;
    if (acc && !canSeeAccount(acc, ctx.user)) throw forbidden();
    const v = validate(ctx.body, {
      category_id: t.ref('categories', { label: 'category' }), recurring_id: t.ref('recurring', { label: 'bill' }),
      transfer: t.bool(), rename: t.str(80), apply_to_similar: t.bool({ default: 1 }),
    }, { db: ctx.db, householdId: ctx.household.id });
    const merchant = row.merchant || merchantKey(row.description || row.note || '');
    let similar = 0;
    tx(ctx.db, () => {
      if (v.transfer) {
        ctx.db.prepare(`UPDATE transactions SET is_transfer = 1, category_id = NULL, cat_source = 'manual', note = COALESCE(?, note) WHERE id = ?`).run(v.rename ?? null, row.id);
        if (v.apply_to_similar && row.account_id) {
          const id = learnRule(ctx.db, ctx.household.id, merchant, { kind: 'transfer', rename_to: v.rename ?? null }, ctx.user.id);
          similar = applyRule(ctx.db, ctx.household.id, id);
        }
        pairTransfers(ctx.db, ctx.household.id, addDays(row.date, -6), addDays(row.date, 6));
        return;
      }
      if (row.is_transfer) unpairTransfer(ctx.db, row);
      ctx.db.prepare(`UPDATE transactions SET category_id = ?, is_transfer = 0, cat_source = 'manual', note = COALESCE(?, note) WHERE id = ?`)
        .run(v.category_id ?? null, v.rename ?? null, row.id);
      if (v.recurring_id) {
        const item = ctx.db.prepare('SELECT * FROM recurring WHERE id = ?').get(v.recurring_id);
        const occ = nearestOccurrence(item, row.date);
        if (!occ) throw bad(`This doesn’t line up with a ${item.name} due date. Check the bill’s schedule.`);
        if (item.direction !== row.direction) throw bad(item.direction === 'in' ? 'That’s income; this row is money out.' : 'That’s a bill; this row is money in.');
        linkToOccurrence(ctx.db, item, row.id, occ);
        if (!v.category_id && item.category_id) ctx.db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(item.category_id, row.id);
      }
      if (v.apply_to_similar && row.account_id && (v.category_id || v.recurring_id)) {
        const id = learnRule(ctx.db, ctx.household.id, merchant, { category_id: v.category_id ?? null, recurring_id: v.recurring_id ?? null, rename_to: v.rename ?? null }, ctx.user.id);
        similar = applyRule(ctx.db, ctx.household.id, id);
      }
    });
    return { ok: true, similar: Math.max(0, similar - 1), transaction: ctx.db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id) };
  });

  // ── Rules ──
  r.get('/api/rules', (ctx) => ctx.db.prepare(`SELECT ru.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon, rc.name AS recurring_name
    FROM rules ru LEFT JOIN categories c ON c.id = ru.category_id LEFT JOIN recurring rc ON rc.id = ru.recurring_id
    WHERE ru.household_id = ? ORDER BY ru.kind, ru.pattern`).all(ctx.household.id));

  r.post('/api/rules', (ctx) => {
    const v = validate(ctx.body, {
      pattern: t.str(60, { required: true, label: 'text to match' }), category_id: t.ref('categories', { label: 'category' }),
      kind: t.oneOf(['categorize', 'transfer'], { default: 'categorize' }), rename_to: t.str(80),
    }, { db: ctx.db, householdId: ctx.household.id });
    const pattern = v.pattern.toUpperCase().replace(/\s+/g, ' ').trim();
    if (pattern.length < 3) throw bad('Use at least 3 characters.', { field: 'pattern' });
    if (v.kind === 'categorize' && !v.category_id) throw bad('Choose a category.', { field: 'category_id' });
    const id = learnRule(ctx.db, ctx.household.id, pattern, v, ctx.user.id);
    return { id, applied: applyRule(ctx.db, ctx.household.id, id) };
  });

  r.delete('/api/rules/:id', (ctx) => {
    ctx.db.prepare('DELETE FROM rules WHERE id = ? AND household_id = ?').run(Number(ctx.params.id), ctx.household.id);
    return { ok: true };
  });

  // ── "Looks recurring" ──
  r.get('/api/money/suggestions', (ctx) => recurringSuggestions(ctx.db, ctx.household.id, today(ctx)));

  r.post('/api/money/suggestions/accept', (ctx) => {
    const v = validate(ctx.body, {
      merchant: t.str(80, { required: true }), name: t.str(80, { required: true }), amount: t.money({ required: true }),
      frequency: t.oneOf(['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'], { required: true }),
      kind: t.oneOf(['income', 'bill', 'subscription', 'loan', 'insurance', 'savings'], { default: 'bill' }),
      first_date: t.date({ required: true }), category_id: t.ref('categories'), variable: t.bool(), owner_id: t.ref('users'),
    }, { db: ctx.db, householdId: ctx.household.id });
    return tx(ctx.db, () => {
      const item = insertRow(ctx.db, 'recurring', ctx.household.id, {
        name: v.name, kind: v.kind, direction: v.kind === 'income' ? 'in' : 'out', amount: v.amount, frequency: v.frequency,
        start_date: v.first_date, category_id: v.category_id ?? null, variable: v.variable ?? 0, autopay: 1, owner_id: v.owner_id ?? ctx.user.id,
      });
      const id = learnRule(ctx.db, ctx.household.id, v.merchant, { category_id: v.category_id ?? null, recurring_id: item.id, rename_to: v.name }, ctx.user.id);
      const linked = applyRule(ctx.db, ctx.household.id, id);
      return { ok: true, recurring: item, linked };
    });
  });

  r.post('/api/money/suggestions/dismiss', (ctx) => {
    const v = validate(ctx.body, { merchant: t.str(80, { required: true }) });
    learnRule(ctx.db, ctx.household.id, v.merchant, { kind: 'ignore_recurring' }, ctx.user.id);
    return { ok: true };
  });

  // Re-run automatic categorization and transfer matching over everything (Settings → Rules).
  r.post('/api/money/recategorize', (ctx) => {
    let changed = 0;
    tx(ctx.db, () => {
      const lctx = loadContext(ctx.db, ctx.household.id);
      for (const rule of lctx.rules.filter((x) => x.kind !== 'ignore_recurring')) changed += applyRule(ctx.db, ctx.household.id, rule.id);
      changed += pairTransfers(ctx.db, ctx.household.id, '1970-01-01', '2999-12-31').newlyPaired;
    });
    return { ok: true, changed };
  });
}

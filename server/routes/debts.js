// Debts: everything you owe, per person, with a payoff planner.
import { bad, forbidden } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { getOwned, insertRow, updateRow } from '../lib/crud.js';
import { debtBalances, monthlyEquivalent, accountBalances } from '../lib/finance.js';
import { payoffPlan, assumedMinimum } from '../lib/debts.js';

const TYPES = ['mortgage', 'credit_card', 'line_of_credit', 'car', 'student', 'personal', 'other'];

const schema = {
  name: t.str(60, { required: true }),
  type: t.oneOf(TYPES, { required: true }),
  owner_id: t.ref('users', { label: 'person' }),
  lender: t.str(60),
  balance: t.money({ label: 'balance' }),
  original_amount: t.money({ label: 'original amount' }),
  rate: t.real(0, 100, { label: 'interest rate' }),
  min_payment: t.money({ label: 'monthly payment' }),
  due_day: t.int(1, 31, { label: 'due day' }),
  account_id: t.ref('accounts', { label: 'account' }),
  recurring_id: t.ref('recurring', { label: 'payment' }),
  notes: t.text(2000),
  archived: t.bool(),
};

export function debtRoutes(r) {
  const today = (ctx) => ctx.today();

  const list = (ctx) => {
    const users = new Map(ctx.db.prepare('SELECT id, name, color FROM users WHERE household_id = ?').all(ctx.household.id).map((u) => [u.id, u]));
    const rec = new Map(ctx.db.prepare('SELECT * FROM recurring WHERE household_id = ?').all(ctx.household.id).map((x) => [x.id, x]));
    return debtBalances(ctx.db, ctx.household.id).map((d) => {
      const payment = d.recurring_id && rec.get(d.recurring_id) ? monthlyEquivalent(rec.get(d.recurring_id)) : d.min_payment;
      const monthlyInterest = Math.round(d.current_balance * (d.rate || 0) / 1200);
      return {
        ...d, owner_name: d.owner_id ? users.get(d.owner_id)?.name : 'Joint', owner_color: d.owner_id ? users.get(d.owner_id)?.color : 'gray',
        monthly_payment: payment ?? null, assumed_payment: payment ? null : assumedMinimum({ ...d, current_balance: d.current_balance }),
        monthly_interest: monthlyInterest,
        paid_off_pct: d.original_amount ? Math.max(0, Math.min(100, Math.round((1 - d.current_balance / d.original_amount) * 100))) : null,
        can_edit: d.owner_id === null || d.owner_id === ctx.user.id,
      };
    });
  };

  r.get('/api/debts', (ctx) => {
    const scope = ctx.query.scope === 'me' ? 'me' : 'household';
    const debts = list(ctx).filter((d) => scope === 'household' || d.owner_id === ctx.user.id);
    const total = debts.reduce((s, d) => s + d.current_balance, 0);
    const monthlyInterest = debts.reduce((s, d) => s + d.monthly_interest, 0);
    const cards = ctx.db.prepare(`SELECT a.id, a.credit_limit, a.owner_id FROM accounts a WHERE a.household_id = ? AND a.type = 'credit_card' AND a.credit_limit > 0 AND a.archived = 0`)
      .all(ctx.household.id).filter((c) => scope === 'household' || c.owner_id === ctx.user.id);
    const bal = accountBalances(ctx.db, ctx.household.id);
    const cardOwed = cards.reduce((s, c) => s + Math.max(0, -(bal.get(c.id)?.balance ?? 0)), 0);
    const cardLimit = cards.reduce((s, c) => s + c.credit_limit, 0);
    return { debts, total, monthlyInterest, utilization: cardLimit ? Math.round((cardOwed / cardLimit) * 100) : null };
  });

  r.get('/api/debts/plan', (ctx) => {
    const scope = ctx.query.scope === 'me' ? 'me' : 'household';
    const extra = Math.max(0, Math.min(10_000_000, Math.round(Number(ctx.query.extra) || 0)));
    const strategy = ctx.query.strategy === 'snowball' ? 'snowball' : 'avalanche';
    const includeMortgage = ctx.query.mortgage === '1';
    const debts = list(ctx)
      .filter((d) => scope === 'household' || d.owner_id === ctx.user.id)
      .filter((d) => includeMortgage || d.type !== 'mortgage')
      .map((d) => ({ ...d, min_payment: d.monthly_payment || null }));
    return payoffPlan(debts, { extra, strategy, startDate: today(ctx).slice(0, 7) + '-01' });
  });

  const guard = (ctx, d) => { if (d.owner_id !== null && d.owner_id !== ctx.user.id) throw forbidden('Only the person this debt belongs to can change it.'); };

  r.post('/api/debts', (ctx) => {
    const v = validate(ctx.body, schema, { db: ctx.db, householdId: ctx.household.id });
    if (!('owner_id' in ctx.body)) v.owner_id = ctx.user.id;
    if (!v.account_id && v.balance == null) throw bad('Enter how much is owed.', { field: 'balance' });
    if (v.original_amount == null && v.balance) v.original_amount = v.balance;
    return insertRow(ctx.db, 'debts', ctx.household.id, v);
  });

  r.patch('/api/debts/:id', (ctx) => {
    const d = getOwned(ctx.db, 'debts', ctx.params.id, ctx.household.id);
    guard(ctx, d);
    const v = validate(ctx.body, schema, { db: ctx.db, householdId: ctx.household.id, partial: true });
    if ('name' in v && !v.name) throw bad('Add a name.', { field: 'name' });
    return updateRow(ctx.db, 'debts', d.id, ctx.household.id, v);
  });

  r.delete('/api/debts/:id', (ctx) => {
    const d = getOwned(ctx.db, 'debts', ctx.params.id, ctx.household.id);
    guard(ctx, d);
    ctx.db.prepare('DELETE FROM debts WHERE id = ?').run(d.id);
    return { ok: true };
  });
}

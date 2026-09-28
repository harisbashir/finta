// Sheets shared by Today and Money: add expense, recurring items, paying bills, goals, budgets.
import { api } from '../api.js';
import { html, raw, icon, $, $$, S, money, fmtDate, relDay, sheet, toast, confirmDialog, fText, fMoney, fSelect, fDate, fToggle, fTextarea, fNumber,
  FREQ_LABEL, centsToInput, currencySymbol, parseMoney, emptyState, hydrate } from '../ui.js';
import { getCategories, getMembers } from '../store.js';

export const KINDS = {
  income: { label: 'Income', plural: 'Income', icon: 'banknote', color: 'green', hint: 'Paycheques, benefits, rent you receive' },
  bill: { label: 'Bill', plural: 'Bills & Utilities', icon: 'receipt', color: 'blue', hint: 'Hydro, internet, phone, property tax' },
  subscription: { label: 'Subscription', plural: 'Subscriptions', icon: 'repeat', color: 'purple', hint: 'Streaming, apps, memberships' },
  loan: { label: 'Loan', plural: 'Loans & Mortgage', icon: 'landmark', color: 'brown', hint: 'Mortgage, car loan, line of credit' },
  insurance: { label: 'Insurance', plural: 'Insurance', icon: 'shield', color: 'teal', hint: 'Home, car, life' },
  savings: { label: 'Savings', plural: 'Automatic Savings', icon: 'piggy-bank', color: 'pink', hint: 'Money you move to savings on a schedule' },
};
export const KIND_ORDER = ['income', 'bill', 'subscription', 'loan', 'insurance', 'savings'];
const FREQ_OPTIONS = Object.entries(FREQ_LABEL);
const DEFAULT_CATEGORY = { income: 'Salary', bill: 'Utilities', subscription: 'Subscriptions', loan: 'Housing', insurance: 'Insurance', savings: null };

const catOptions = (cats, kind) => [['', 'None'], ...cats.filter((c) => !c.archived && c.kind === kind).map((c) => [c.id, c.name])];

// ─────────── Expense / income entry ───────────
export async function expenseSheet({ tx = null, onSaved, direction = 'out' } = {}) {
  const [cats, members] = await Promise.all([getCategories(), getMembers()]);
  let dir = tx?.direction || direction;
  let catId = tx?.category_id ?? null;
  const isBill = !!tx?.recurring_id;
  const isGoal = !!tx?.goal_id;

  const render = () => {
    const list = cats.filter((c) => !c.archived && c.kind === dir);
    return html`<form class="form" novalidate>
      ${!tx ? html`<div class="segmented" role="tablist">
        <button type="button" role="tab" data-dir="out" aria-selected="${String(dir === 'out')}">Expense</button>
        <button type="button" role="tab" data-dir="in" aria-selected="${String(dir === 'in')}">Income</button></div>` : ''}
      <div class="amount-entry">
        <label for="amt">${dir === 'in' ? 'Amount Received' : 'Amount Spent'}</label>
        <div class="wrap"><span>${currencySymbol()}</span><input id="amt" name="amount" data-money inputmode="decimal" placeholder="0" autocomplete="off" value="${centsToInput(tx?.amount)}" required autofocus></div>
      </div>
      ${isBill ? html`<p class="hint">Payment for ${tx.note} (due ${fmtDate(tx.due_date)}).</p>` : ''}
      ${isGoal ? html`<p class="hint">Money set aside for ${tx.goal_name}.</p>` : ''}
      ${!isBill && !isGoal ? html`
        <div class="group-label">Category</div>
        <div class="cat-grid" role="group" aria-label="Category">
          ${list.map((c) => html`<button type="button" data-cat="${c.id}" aria-pressed="${String(c.id === catId)}"><span class="tile" data-color="${c.color}">${icon(c.icon)}</span>${c.name}</button>`)}
        </div>
        <input type="hidden" name="category_id" data-int value="${catId ?? ''}">` : ''}
      <div class="group">
        ${!isGoal ? fText('note', 'Note', tx?.note || '', { placeholder: dir === 'in' ? 'Tax refund' : 'What was it?', maxlength: 200 }) : ''}
        ${fDate('date', 'Date', tx?.date || S.today, { required: true })}
        ${members.length > 1 ? fSelect('paid_by', dir === 'in' ? 'Received by' : 'Paid by', [['', 'Not set'], ...members.map((m) => [m.id, m.name])], tx ? tx.paid_by ?? '' : S.user.id, { data: 'data-int' }) : ''}
      </div>
      <input type="hidden" name="direction" value="${dir}">
      ${tx ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete ${isBill ? 'Payment' : 'Transaction'}</button></div>` : ''}
    </form>`;
  };

  const s = sheet({
    title: tx ? 'Edit Transaction' : 'Add Expense',
    primary: tx ? 'Save' : 'Add',
    render,
    onMount: (d, api2) => {
      $$('[data-dir]', d).forEach((b) => b.addEventListener('click', () => {
        const amt = $('#amt', d).value;
        dir = b.dataset.dir; catId = null; api2.rerender(); api2.setTitle(dir === 'in' ? 'Add Income' : 'Add Expense');
        $('#amt', d).value = amt;
      }));
      $$('[data-cat]', d).forEach((b) => b.addEventListener('click', () => {
        catId = Number(b.dataset.cat) === catId ? null : Number(b.dataset.cat);
        $$('[data-cat]', d).forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.cat) === catId)));
        $('[name=category_id]', d).value = catId ?? '';
      }));
      $('[data-delete]', d)?.addEventListener('click', async () => {
        await api.del(`/api/transactions/${tx.id}`);
        s.close();
        onSaved?.();
        if (!isBill && !isGoal) {
          toast(`Deleted ${money(tx.amount)}${tx.note ? ` · ${tx.note}` : ''}`, {
            undo: async () => { await api.post('/api/transactions', pick(tx, ['date', 'amount', 'direction', 'category_id', 'note', 'paid_by'])); onSaved?.(); },
          });
        } else toast(isBill ? 'Payment removed. The bill shows as unpaid again.' : 'Removed from goal.');
      });
    },
    onSubmit: async (v) => {
      if (!v.amount) throw Object.assign(new Error('Enter an amount.'), { field: 'amount' });
      if (isBill || isGoal) { delete v.category_id; delete v.direction; }
      if (tx) await api.patch(`/api/transactions/${tx.id}`, v);
      else await api.post('/api/transactions', v);
      toast(tx ? 'Saved' : `${dir === 'in' ? 'Added' : 'Spent'} ${money(v.amount)}${v.note ? ` · ${v.note}` : ''}`);
      onSaved?.();
    },
  });
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// ─────────── Recurring items ───────────
export async function recurringSheet({ item = null, kind = null, onSaved } = {}) {
  const [cats, members] = await Promise.all([getCategories(), getMembers()]);
  let k = item?.kind || kind;

  const render = () => {
    if (!k) {
      return html`<p class="hint">What do you want to track? Pick the closest match — you can change it later.</p>
        <div class="group has-icons">${KIND_ORDER.map((id) => html`<button type="button" class="row" data-kind="${id}"><span class="tile" data-color="${KINDS[id].color}">${icon(KINDS[id].icon)}</span><span class="body"><span class="title">${KINDS[id].label}</span><span class="sub">${KINDS[id].hint}</span></span>${icon('chevron-right', 'chev')}</button>`)}</div>`;
    }
    const meta = KINDS[k];
    const catKind = k === 'income' ? 'in' : 'out';
    const defaultCat = item ? item.category_id : cats.find((c) => c.name === DEFAULT_CATEGORY[k] && c.kind === catKind)?.id;
    const placeholder = { income: 'Paycheque', bill: 'Hydro', subscription: 'Netflix', loan: 'Mortgage', insurance: 'Car Insurance', savings: 'To Savings' }[k];
    return html`<form class="form" novalidate>
      <input type="hidden" name="kind" value="${k}">
      <div class="group">
        ${fText('name', 'Name', item?.name || '', { placeholder, required: true, maxlength: 80, autofocus: !item })}
        ${fMoney('amount', k === 'loan' ? 'Payment' : 'Amount', item?.amount, { required: true })}
        ${fSelect('frequency', 'Repeats', FREQ_OPTIONS, item?.frequency || 'monthly')}
        ${fDate('start_date', item ? 'First Due' : 'Next Due', item?.start_date || S.today, { required: true })}
      </div>
      ${item ? html`<p class="hint">The schedule counts forward from the first due date${item.next_due ? html` — next is <strong>${fmtDate(item.next_due, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>` : ''}.</p>` : ''}
      <div class="group">
        ${fToggle('variable', 'Amount changes', !!item?.variable, 'Like hydro or gas. Enter an estimate; confirm the real amount when you pay.')}
        ${fToggle('autopay', k === 'income' ? 'Arrives automatically' : 'Paid automatically', item ? !!item.autopay : ['subscription', 'loan', 'insurance', 'savings', 'income'].includes(k),
          k === 'income' ? 'Marked as received on its date.' : 'Marked as paid on its due date, so you don’t have to.')}
      </div>
      ${k === 'loan' ? html`<div class="group-label">Loan Details</div><div class="group">
        ${fMoney('loan_balance', 'Balance Owing', item?.loan_balance, { placeholder: '0' })}
        ${fNumber('loan_rate', 'Interest Rate', item?.loan_rate ?? '', { placeholder: '4.79', suffix: '%' })}
      </div><p class="hint">With a balance and rate, Finta splits each payment into interest and principal and estimates your payoff date.</p>` : ''}
      ${k === 'subscription' ? html`<div class="group">${fDate('trial_ends', 'Free Trial Ends', item?.trial_ends)}</div>
        <p class="hint">Finta reminds you on Today two weeks before a trial ends.</p>` : ''}
      <div class="group">
        ${fSelect('category_id', 'Category', catOptions(cats, catKind), defaultCat ?? '', { data: 'data-int' })}
        ${members.length > 1 ? fSelect('owner_id', 'Whose', [...members.map((m) => [m.id, m.id === S.user.id ? `${m.name} (You)` : m.name]), ['', 'Joint — shared']], item ? item.owner_id ?? '' : S.user.id, { data: 'data-int' }) : ''}
        ${fDate('end_date', 'Ends', item?.end_date)}
      </div>
      <div class="group">
        ${fText('payee', k === 'income' ? 'From' : 'Pay To', item?.payee || '', { placeholder: 'Optional', maxlength: 80 })}
        ${fText('url', 'Website', item?.url || '', { placeholder: 'Optional', type: 'url', maxlength: 300 })}
        ${fTextarea('notes', 'Notes — account number, how to cancel…', item?.notes || '', { rows: 2 })}
      </div>
      ${item ? html`<div class="group">${fToggle('paused', 'Paused', !!item.paused, 'Paused items don’t count toward your month.')}</div>
        <div class="group"><button type="button" class="row destructive" data-delete>Delete ${meta.label}</button></div>` : ''}
    </form>`;
  };

  const s = sheet({
    title: item ? `Edit ${KINDS[k].label}` : k ? `New ${KINDS[k].label}` : 'New Recurring Item',
    primary: item ? 'Save' : 'Add',
    render,
    onMount: (d, a) => {
      const primary = $('[data-sheet-primary]', d);
      if (primary) primary.hidden = !k;
      $$('[data-kind]', d).forEach((b) => b.addEventListener('click', () => { k = b.dataset.kind; a.rerender(); a.setTitle(`New ${KINDS[k].label}`); $('[name=name]', d)?.focus(); }));
      $('[data-delete]', d)?.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: `Delete “${item.name}”?`, message: 'Past payments stay in your spending history.' });
        if (!ok) return;
        await api.del(`/api/recurring/${item.id}`);
        s.close(); toast(`Deleted ${item.name}`); onSaved?.();
      });
    },
    onSubmit: async (v) => {
      if (!k) throw new Error('Pick a type first.');
      if (item) await api.patch(`/api/recurring/${item.id}`, v);
      else await api.post('/api/recurring', v);
      toast(item ? 'Saved' : `Added ${v.name}`);
      onSaved?.();
    },
  });
}

/** Detail view for a recurring item: schedule, history, loan projection. */
export async function recurringDetail(id, { onChanged } = {}) {
  let item = await api.get(`/api/recurring/${id}`);
  const meta = KINDS[item.kind];
  const render = () => {
    const yearly = Math.round(item.monthly * 12);
    const p = item.projection;
    return html`
      <div class="card" data-color="${meta.color}">
        <div class="row" ><span class="tile" data-color="${item.category_color || meta.color}">${icon(meta.icon)}</span>
          <span class="body"><span class="title"><strong>${item.name}</strong></span><span class="sub">${FREQ_LABEL[item.frequency]}${item.autopay ? ' · Autopay' : ''}${item.paused ? ' · Paused' : ''}</span></span>
          <span class="trail"><span class="amount">${item.variable ? '~' : ''}${money(item.amount)}</span></span></div>
      </div>
      <div class="section"></div>
      <div class="group">
        <div class="row"><span class="body">Next ${item.direction === 'in' ? 'payday' : 'due'}</span><span class="trail">${item.next_due ? html`<span class="${item.overdue ? 'text-neg' : ''}">${item.overdue ? 'Overdue · ' : ''}${relDay(item.next_due)}</span>` : 'Ended'}</span></div>
        <div class="row"><span class="body">Per month</span><span class="trail amount">${money(item.monthly)}</span></div>
        <div class="row"><span class="body">Per year</span><span class="trail amount">${money(yearly)}</span></div>
        ${item.trial_ends ? html`<div class="row"><span class="body">Trial ends</span><span class="trail">${fmtDate(item.trial_ends)}</span></div>` : ''}
        ${item.payee ? html`<div class="row"><span class="body">${item.direction === 'in' ? 'From' : 'Pay to'}</span><span class="trail">${item.payee}</span></div>` : ''}
        ${item.url && /^https?:\/\//.test(item.url) ? html`<a class="row" href="${item.url}" target="_blank" rel="noopener noreferrer"><span class="body">Website</span><span class="trail">${icon('external-link', 'icon-sm')}</span></a>` : ''}
      </div>
      ${item.next_due && !item.autopay ? html`<div class="section"></div><button class="btn prominent block" data-pay>${icon('check')} Mark ${fmtDate(item.next_due)} ${item.direction === 'in' ? 'Received' : 'Paid'}</button>` : ''}
      ${item.kind === 'loan' ? html`<div class="section"></div><div class="section-head"><h2>Loan</h2></div>
        <div class="group">
          <div class="row"><span class="body">Balance owing</span><span class="trail amount">${money(item.loan_balance || 0)}</span></div>
          <div class="row"><span class="body">Interest rate</span><span class="trail">${item.loan_rate ?? '—'}${item.loan_rate != null ? '%' : ''}</span></div>
          ${item.never_pays_off ? html`<div class="row"><span class="body text-neg">The payment doesn’t cover the interest, so this balance won’t go down.</span></div>`
            : p?.payoffDate ? html`<div class="row"><span class="body">Paid off</span><span class="trail">${fmtDate(p.payoffDate, { month: 'long', year: 'numeric' })}</span></div>
              <div class="row"><span class="body">Interest still to pay</span><span class="trail amount">${money(p.totalInterest)}</span></div>` : ''}
        </div>
        <p class="section-foot">Estimates assume the same payment and rate. Canadian mortgages compound semi-annually, so your lender’s numbers may differ slightly.</p>` : ''}
      ${item.notes ? html`<div class="section"></div><div class="card"><div class="text-2">${item.notes}</div></div>` : ''}
      <div class="section"></div>
      <div class="section-head"><h2>History</h2></div>
      ${item.history.length ? html`<div class="group">${item.history.map((h) => html`<div class="row"><span class="body"><span class="title">${fmtDate(h.due_date, { month: 'long', day: 'numeric', year: 'numeric' })}</span>${h.date !== h.due_date ? html`<span class="sub">Paid ${fmtDate(h.date)}</span>` : ''}${h.principal ? html`<span class="sub">${money(h.principal)} to principal</span>` : ''}</span><span class="trail amount">${money(h.amount)}</span></div>`)}</div>`
        : html`<div class="group">${emptyState('clock', 'No payments yet', item.autopay ? 'Autopay entries appear here on each due date.' : 'Mark a payment and it shows up here.')}</div>`}
      <div class="section"></div>
      <button class="btn block" data-edit>${icon('pencil')} Edit</button>`;
  };
  const s = sheet({
    title: item.name, render, dismissOnly: true,
    onMount: (d, a) => {
      $('[data-edit]', d)?.addEventListener('click', () => { s.close(); recurringSheet({ item, onSaved: onChanged }); });
      $('[data-pay]', d)?.addEventListener('click', async () => {
        const occ = { recurring_id: item.id, due: item.next_due, amount: item.amount, variable: item.variable, name: item.name, direction: item.direction };
        if (item.variable) { s.close(); payVariableSheet(occ, { onSaved: onChanged }); return; }
        await markPaid(occ, onChanged);
        item = await api.get(`/api/recurring/${id}`);
        a.rerender();
      });
    },
  });
}

/** Mark a fixed-amount occurrence paid, with Undo. */
export async function markPaid(occ, onChanged) {
  if (occ.variable) return payVariableSheet(occ, { onSaved: onChanged });
  await api.post(`/api/recurring/${occ.recurring_id}/pay`, { due_date: occ.due });
  onChanged?.();
  toast(`${occ.name} marked ${occ.direction === 'in' ? 'received' : 'paid'}`, {
    undo: async () => { await api.del(`/api/recurring/${occ.recurring_id}/pay/${occ.due}`); onChanged?.(); },
  });
}

export async function markUnpaid(occ, onChanged) {
  await api.del(`/api/recurring/${occ.recurring_id}/pay/${occ.due}`);
  onChanged?.();
  toast(`${occ.name} marked unpaid`);
}

export function payVariableSheet(occ, { onSaved } = {}) {
  sheet({
    title: occ.name, primary: occ.direction === 'in' ? 'Received' : 'Paid',
    render: () => html`<form class="form" novalidate>
      <div class="amount-entry"><label for="pay-amt">Actual Amount</label>
        <div class="wrap"><span>${currencySymbol()}</span><input id="pay-amt" name="amount" data-money inputmode="decimal" value="${centsToInput(occ.amount)}" autocomplete="off" autofocus required></div></div>
      <p class="hint">Due ${fmtDate(occ.due, { weekday: 'long', month: 'long', day: 'numeric' })}. Estimate was ${money(occ.amount)}.</p>
      <div class="group">${fDate('date', occ.direction === 'in' ? 'Received On' : 'Paid On', S.today, { required: true })}</div>
    </form>`,
    onSubmit: async (v) => {
      await api.post(`/api/recurring/${occ.recurring_id}/pay`, { due_date: occ.due, amount: v.amount, date: v.date });
      toast(`${occ.name}: ${money(v.amount)} ${occ.direction === 'in' ? 'received' : 'paid'}`);
      onSaved?.();
    },
  });
}

// ─────────── Goals ───────────
let membersForGoals = [];
export async function goalSheet({ goal = null, onSaved } = {}) {
  membersForGoals = await getMembers();
  const colors = ['teal', 'blue', 'indigo', 'purple', 'pink', 'orange', 'green', 'mint'];
  const s = sheet({
    title: goal ? 'Edit Goal' : 'New Goal', primary: goal ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">
        ${fText('name', 'Goal', goal?.name || '', { placeholder: 'Emergency fund', required: true, maxlength: 60, autofocus: !goal })}
        ${fMoney('target', 'Target', goal?.target, { required: true, placeholder: '0' })}
        ${fMoney('saved', 'Saved So Far', goal?.saved ?? 0, { placeholder: '0' })}
        ${fDate('target_date', 'Target Date', goal?.target_date)}
        ${fSelect('color', 'Color', colors.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), goal?.color || 'teal')}
        ${membersForGoals.length > 1 ? fSelect('owner_id', 'Whose', [['', 'Joint — shared'], [S.user.id, `${S.user.name} (You)`]], goal ? goal.owner_id ?? '' : '', { data: 'data-int' }) : ''}
      </div>
      <p class="hint">With a target date, Finta tells you how much to set aside each month.</p>
      ${goal ? html`<div class="group">${fToggle('archived', 'Completed', !!goal.archived, 'Hide it from your active goals.')}</div>
        <div class="group"><button type="button" class="row destructive" data-delete>Delete Goal</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${goal.name}”?`, message: 'Money you set aside stays in your history as spending.' }))) return;
        await api.del(`/api/goals/${goal.id}`); s.close(); toast('Goal deleted'); onSaved?.();
      });
    },
    onSubmit: async (v) => {
      if (!v.target) throw Object.assign(new Error('Enter a target amount.'), { field: 'target' });
      if (goal) await api.patch(`/api/goals/${goal.id}`, v); else await api.post('/api/goals', v);
      onSaved?.();
    },
  });
}

export function contributeSheet(goal, { onSaved } = {}) {
  sheet({
    title: goal.name, primary: 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="amount-entry"><label for="g-amt">Set Aside</label>
        <div class="wrap"><span>${currencySymbol()}</span><input id="g-amt" name="amount" data-money inputmode="decimal" placeholder="0" autocomplete="off" autofocus required></div></div>
      <p class="hint">This counts as “Saved” in your month, so it comes out of what’s left to spend.</p>
      <div class="group">${fDate('date', 'Date', S.today, { required: true })}</div>
    </form>`,
    onSubmit: async (v) => {
      if (!v.amount) throw Object.assign(new Error('Enter an amount.'), { field: 'amount' });
      await api.post(`/api/goals/${goal.id}/contribute`, v);
      toast(`${money(v.amount)} set aside for ${goal.name}`);
      onSaved?.();
    },
  });
}

// ─────────── Budgets ───────────
export async function budgetsSheet({ onSaved } = {}) {
  const cats = (await getCategories(true)).filter((c) => c.kind === 'out' && !c.archived);
  sheet({
    title: 'Monthly Budgets', primary: 'Save',
    render: () => html`<form class="form" novalidate>
      <p class="hint">Set a monthly limit for the categories you want to watch. Leave the rest empty. Budgets cover everyday spending, not recurring bills.</p>
      <div class="group has-icons">
        ${cats.map((c) => html`<div class="field"><span class="tile" data-color="${c.color}">${icon(c.icon)}</span>
          <label for="b-${c.id}">${c.name}</label>
          <input id="b-${c.id}" name="b-${c.id}" data-money inputmode="decimal" value="${centsToInput(c.monthly_budget)}" placeholder="No limit" autocomplete="off"></div>`)}
      </div></form>`,
    onSubmit: async (v) => {
      const changes = cats.filter((c) => (v[`b-${c.id}`] ?? null) !== (c.monthly_budget ?? null));
      await Promise.all(changes.map((c) => api.patch(`/api/categories/${c.id}`, { monthly_budget: v[`b-${c.id}`] ?? null })));
      await getCategories(true);
      toast('Budgets saved');
      onSaved?.();
    },
  });
}

// ─────────── The month strip (signature element) ───────────
export function monthCard(m, { title } = {}) {
  const income = Math.max(m.income, 0);
  const over = m.left < 0 ? -m.left : 0;
  const total = Math.max(income, m.bills + m.spent + m.saved) || 1;
  const pct = (v) => (v / total) * 100;
  const segs = [
    ['bills', 'Bills', m.bills, 'var(--seg-bills)', `${money(m.billsPaid, { short: true })} paid`],
    ['spent', 'Spent', m.spent, 'var(--seg-spent)', ''],
    ['saved', 'Saved', m.saved, 'var(--seg-saved)', ''],
    ['left', 'Left', Math.max(0, m.left), 'var(--seg-left)', ''],
  ];
  const isCurrent = m.today >= m.start && m.today <= m.end;
  return html`<section class="card month-card" aria-labelledby="month-h">
    <div class="eyebrow"><span id="month-h">${title || fmtDate(m.start, { month: 'long', year: 'numeric' })}</span><span>${income ? `${money(income, { short: true })} coming in` : ''}</span></div>
    ${income || m.bills || m.spent ? html`
      <div class="headline">
        <span class="big ${m.left < 0 ? 'text-neg' : ''}">${m.left < 0 ? money(m.left) : money(m.left, { short: true })}</span>
        <span>${m.left < 0 ? 'over this month' : 'left to spend'}</span>
      </div>
      <p class="perday">${isCurrent && m.left > 0 ? html`About <strong>${money(m.perDay, { short: true })} a day</strong> for the next ${m.daysLeft === 1 ? 'day' : `${m.daysLeft} days`}.`
        : isCurrent && m.left <= 0 ? 'Spending is ahead of income this month. Check Bills and Spending for what to trim.' : m.today < m.start ? 'Planned so far for this month.' : 'How the month finished.'}</p>
      <div class="strip" role="img" aria-label="${`Of ${money(income)} income: bills ${money(m.bills)}, spent ${money(m.spent)}, saved ${money(m.saved)}, ${m.left < 0 ? `over by ${money(over)}` : `left ${money(m.left)}`}`}">
        ${segs.filter((s) => s[2] > 0).map((s) => html`<span class="${s[0]}" data-w="${pct(s[2])}"></span>`)}
        ${over ? html`<span class="over" data-w="${pct(over)}"></span>` : ''}
      </div>
      <dl class="legend">
        ${segs.map((s) => html`<div><dt><i class="k-${s[0]}"></i>${s[1]}</dt><dd>${money(s[2], { short: true })}${s[4] ? html` <span class="sub">${s[4]}</span>` : ''}</dd></div>`)}
      </dl>` : html`<div class="headline"><span class="big">${money(0, { short: true })}</span><span>left to spend</span></div>
      <p class="perday">Add your income and regular bills and Finta works out what’s left to spend each month.</p>
      <button class="btn prominent" data-setup-money>${icon('plus')} Add Income or a Bill</button>`}
  </section>`;
}
export { hydrate };

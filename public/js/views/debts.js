// Debts: what each person owes, and a plan to be debt-free.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, fmtDate, sheet, toast, confirmDialog, fText, fMoney, fSelect, fNumber, fTextarea, fToggle,
  emptyState, hydrate, plural, currencySymbol } from '../ui.js';
import { lines, stack, SERIES_CLASSES } from '../charts.js';
import { getMembers } from '../store.js';
import { getScope, scopeSwitch } from './money.js';

export const DEBT_TYPES = {
  mortgage: { label: 'Mortgage', icon: 'house', color: 'blue' },
  credit_card: { label: 'Credit Card', icon: 'credit-card', color: 'indigo' },
  line_of_credit: { label: 'Line of Credit', icon: 'banknote', color: 'brown' },
  car: { label: 'Car Loan', icon: 'car', color: 'orange' },
  student: { label: 'Student Loan', icon: 'briefcase', color: 'purple' },
  personal: { label: 'Personal Loan', icon: 'hand-coins', color: 'teal' },
  other: { label: 'Other', icon: 'tag', color: 'gray' },
};

export async function mountDebts(v) {
  let data, plan;
  let extra = 10000, strategy = 'avalanche', mortgage = false;
  const sw = await scopeSwitch(() => load());
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add a debt">${icon('plus')}</button>`, { '[data-add]': () => debtSheet({ onSaved: load }) });

  async function load() {
    data = await api.get(`/api/debts?scope=${getScope()}`);
    await loadPlan(false);
    if (v.alive()) render();
  }
  async function loadPlan(rerender = true) {
    plan = await api.get(`/api/debts/plan?scope=${getScope()}&extra=${extra}&strategy=${strategy}&mortgage=${mortgage ? 1 : 0}`);
    if (rerender && v.alive()) renderPlan();
  }

  function render() {
    const scope = getScope();
    const byPerson = new Map();
    for (const d of data.debts) { const k = d.owner_name || 'Joint'; if (!byPerson.has(k)) byPerson.set(k, []); byPerson.get(k).push(d); }
    const byType = Object.keys(DEBT_TYPES).map((t) => ({ name: DEBT_TYPES[t].label, value: data.debts.filter((d) => d.type === t).reduce((s, d) => s + d.current_balance, 0) })).filter((x) => x.value > 0);
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Debts</h1></div>
      ${sw.markup}
      ${data.debts.length ? html`
        <div class="hero"><div class="label">${scope === 'me' ? 'You owe' : 'Your household owes'}</div><div class="value">${money(data.total)}</div>
          <div class="sub">${data.monthlyInterest ? `About ${money(data.monthlyInterest, { short: true })} of interest a month` : ''}${data.utilization !== null ? ` · cards ${data.utilization}% used` : ''}</div></div>
        ${byType.length > 1 ? html`<section class="section card"><h3>What It’s Made Of</h3><p class="card-sub">Balance by type.</p>
          ${stack(byType.slice(0, 4).map((x, i) => ({ ...x, cls: SERIES_CLASSES[i] })).concat(byType.length > 4 ? [{ name: 'Other', value: byType.slice(4).reduce((s, x) => s + x.value, 0), cls: 'c-muted' }] : []), { caption: 'Debt by type' })}</section>` : ''}
        <div class="grid-2">
          <div>${[...byPerson].map(([who, list]) => html`<section class="section">
            <div class="section-head"><h2>${scope === 'household' ? who : 'Your Debts'}</h2><span class="caps">${money(list.reduce((s, d) => s + d.current_balance, 0), { short: true })}</span></div>
            <div class="group has-icons">${list.map(debtRow)}</div></section>`)}
            <p class="section-foot">Cards and credit lines follow their account’s imported balance. Loans with a payment in Bills go down each time it’s paid.</p>
          </div>
          <div><section class="section card" id="planner"></section></div>
        </div>`
        : html`<div class="group">${emptyState('credit-card', 'No debts — or none added yet', 'Add a mortgage, car loan, student loan or line of credit. Credit cards appear here when you add them under Accounts.',
          html`<button class="btn prominent small" data-first>${icon('plus')} Add a Debt</button>`)}</div>`}`);
    hydrate(v.el);
    sw.wire(v.el);
    $('[data-first]', v.el)?.addEventListener('click', () => debtSheet({ onSaved: load }));
    if (data.debts.length) renderPlan();
  }

  function renderPlan() {
    const box = $('#planner', v.el);
    if (!box) return;
    const p = plan.plan, b = plan.baseline, o = plan.other;
    const hasMortgage = data.debts.some((d) => d.type === 'mortgage');
    const saved = p.totalInterest !== null && b.totalInterest !== null ? b.totalInterest - p.totalInterest : null;
    box.innerHTML = String(html`
      <h3>Payoff Plan</h3>
      <p class="card-sub">Pay every minimum, then put extra toward one debt at a time. When one is gone, its payment rolls into the next.</p>
      <div class="planner-controls">
        <div class="segmented" role="tablist">
          <button role="tab" data-strategy="avalanche" aria-selected="${String(strategy === 'avalanche')}">Highest Rate First</button>
          <button role="tab" data-strategy="snowball" aria-selected="${String(strategy === 'snowball')}">Smallest First</button>
        </div>
        <label class="slider-row"><span>Extra each month</span><input type="range" min="0" max="200000" step="2500" value="${extra}" data-extra aria-label="Extra payment each month"><output>${money(extra, { short: true })}</output></label>
        ${hasMortgage ? fToggle('mortgage', 'Include Mortgage', mortgage, 'Mortgages are usually paid on their own schedule.') : ''}
      </div>
      ${p.stuck || p.months === null ? html`<div class="form-error">${icon('circle-alert')}<span>At these payments some balances never go down. Raise a payment or add extra above.</span></div>` : html`
      <div class="planner-result">
        <div><b>${fmtDate(p.debtFreeDate, { month: 'short', year: 'numeric' })}</b><span>Debt-free${p.months ? ` in ${p.months >= 24 ? `${Math.round(p.months / 12)} years` : plural(p.months, 'month')}` : ''}</span></div>
        <div><b>${money(p.totalInterest, { short: true })}</b><span>Interest to pay</span></div>
        ${saved > 0 ? html`<div><b class="text-pos">${money(saved, { short: true })}</b><span>Saved vs minimums${b.months ? `, ${plural(b.months - p.months, 'month')} sooner` : ''}</span></div>` : ''}
      </div>
      <div id="plan-chart"></div>
      <div class="section-head"><span class="caps">Order</span></div>
      <div class="group">${p.order.map((d, i) => html`<div class="row"><span class="avatar" data-color="gray">${i + 1}</span><span class="body"><span class="title">${d.name}</span>
        <span class="sub">${d.paidOffDate ? `Paid off ${fmtDate(d.paidOffDate, { month: 'short', year: 'numeric' })}` : 'Not within 50 years'} · ${money(d.interest, { short: true })} interest</span></span></div>`)}</div>
      ${o.totalInterest !== null && p.totalInterest !== null && o.totalInterest !== p.totalInterest ? html`<p class="section-foot">${strategy === 'avalanche' ? 'Smallest First' : 'Highest Rate First'} would cost ${money(Math.abs(o.totalInterest - p.totalInterest), { short: true })} ${o.totalInterest > p.totalInterest ? 'more' : 'less'} in interest${o.months !== p.months ? ` and finish ${fmtDate(o.debtFreeDate, { month: 'short', year: 'numeric' })}` : ''}.</p>` : ''}
      <p class="section-foot">Estimates. Minimums you haven’t entered are assumed (3% of card balances, 1.5% of loans).</p>`}`);
    if (!p.stuck && p.months !== null && $('#plan-chart', box)) {
      const n = Math.max(p.series.length, b.series.length);
      const at = (s, i) => (s.series[i] ?? s.series.at(-1));
      const pts = Array.from({ length: n }, (_, i) => i);
      const series = [{ name: 'With your plan', cls: 'c-4', points: pts.map((i) => ({ x: at(p, i).date, y: i < p.series.length ? at(p, i).balance : 0 })) }];
      if (!b.stuck && b.months !== null && b.months !== p.months) series.push({ name: 'Minimums only', cls: 'c-1', points: pts.map((i) => ({ x: at(b, i).date, y: at(b, i).balance })) });
      // both series share the longer one's dates (same month steps from the server)
      const longer = b.series.length > p.series.length ? b.series : p.series;
      series.forEach((sr) => sr.points.forEach((pt, i) => { pt.x = (longer[i] || longer.at(-1)).date; }));
      lines($('#plan-chart', box), { series, height: 180, caption: 'Total debt over time', area: false, xFormat: { year: 'numeric' }, tipDate: { month: 'short', year: 'numeric' }, endLabel: false });
    }
    $$('[data-strategy]', box).forEach((x) => x.addEventListener('click', () => { strategy = x.dataset.strategy; loadPlan(); }));
    const range = $('[data-extra]', box);
    let t;
    range.addEventListener('input', () => { extra = Number(range.value); $('output', box).textContent = money(extra, { short: true }); clearTimeout(t); t = setTimeout(() => loadPlan(), 250); });
    $('[name=mortgage]', box)?.addEventListener('change', (e) => { mortgage = e.target.checked; loadPlan(); });
  }

  v.el.onclick = (e) => { const r = e.target.closest('[data-debt]'); if (r) debtSheet({ debt: data.debts.find((d) => d.id === Number(r.dataset.debt)), onSaved: load }); };
  await load();
}

function debtRow(d) {
  const t = DEBT_TYPES[d.type];
  const pay = d.monthly_payment || d.assumed_payment;
  return html`<button class="row" data-debt="${d.id}">
    <span class="tile" data-color="${t.color}">${icon(t.icon)}</span>
    <span class="body"><span class="title">${d.name}</span>
      <span class="sub">${[d.rate != null ? `${d.rate}%` : 'Rate not set', pay ? `${d.monthly_payment ? '' : '~'}${money(pay, { short: true })}/mo` : '', d.account_id ? 'from account' : d.recurring_id ? 'from bill' : ''].filter(Boolean).join(' · ')}</span>
      ${d.paid_off_pct !== null ? html`<span class="util"><i data-w="${d.paid_off_pct}"></i></span><span class="sub">${d.paid_off_pct}% paid off</span>` : ''}
    </span>
    <span class="trail"><span class="amount">${money(d.current_balance)}</span>${icon('chevron-right', 'chev')}</span>
  </button>`;
}

async function debtSheet({ debt = null, onSaved } = {}) {
  const members = await getMembers();
  let k = debt?.type || null;
  const linked = !!debt?.account_id;
  const s = sheet({
    title: debt ? debt.name : 'New Debt', primary: debt ? 'Save' : 'Add',
    render: () => {
      if (!k) return html`<p class="hint">What kind of debt? Credit cards are easiest to add under Accounts, so their statements keep the balance current.</p>
        <div class="group has-icons">${Object.entries(DEBT_TYPES).map(([id, t]) => html`<button type="button" class="row" data-type="${id}"><span class="tile" data-color="${t.color}">${icon(t.icon)}</span><span class="body"><span class="title">${t.label}</span></span>${icon('chevron-right', 'chev')}</button>`)}</div>`;
      return html`<form class="form" novalidate>
        <input type="hidden" name="type" value="${k}">
        <div class="group">
          ${fText('name', 'Name', debt?.name || '', { placeholder: DEBT_TYPES[k].label, required: true, maxlength: 60, autofocus: !debt })}
          ${fText('lender', 'Lender', debt?.lender || '', { placeholder: 'Optional', maxlength: 60 })}
        </div>
        <div class="group">
          ${linked ? html`<div class="field"><span class="label">Balance</span><input value="${money(debt.current_balance)}" disabled aria-label="Balance"></div>` : fMoney('balance', 'Balance Owed', debt?.balance, { required: true, placeholder: '0.00' })}
          ${fNumber('rate', 'Interest Rate', debt?.rate ?? '', { placeholder: '5.5', suffix: '%' })}
          ${fMoney('min_payment', 'Monthly Payment', debt?.min_payment, { placeholder: 'Minimum' })}
          ${!linked ? fMoney('original_amount', 'Original Amount', debt?.original_amount, { placeholder: 'Optional' }) : ''}
        </div>
        <p class="hint">${linked ? 'This balance comes from the linked account’s statements.' : debt?.recurring_id ? 'This balance goes down each time its payment in Bills is paid.' : 'Update the balance whenever you check your statement. For automatic tracking, add the payment under Bills & Income as a Loan.'}</p>
        <div class="group">
          ${fSelect('owner_id', 'Whose Debt', [[S.user.id, `${S.user.name} (You)`], ...(members.length > 1 ? [['', 'Joint']] : [])], debt ? debt.owner_id ?? '' : S.user.id, { data: 'data-int' })}
        </div>
        <div class="group">${fTextarea('notes', 'Notes — renewal date, account number…', debt?.notes || '', { rows: 2 })}</div>
        ${debt ? html`<div class="group">${fToggle('archived', 'Paid Off', !!debt.archived, 'Hide it from your debts.')}</div>
          <div class="group"><button type="button" class="row destructive" data-delete>Delete Debt</button></div>` : ''}
      </form>`;
    },
    onMount: (d, a2) => {
      $$('[data-type]', d).forEach((b) => b.addEventListener('click', () => { k = b.dataset.type; a2.rerender(); a2.setTitle(`New ${DEBT_TYPES[k].label}`); }));
      const primary = $('[data-sheet-primary]', d); if (primary) primary.hidden = !k;
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${debt.name}”?`, message: linked ? 'The account and its transactions stay.' : '' }))) return;
        await api.del(`/api/debts/${debt.id}`); s.close(); onSaved?.();
      });
    },
    onSubmit: async (v) => {
      if (debt) await api.patch(`/api/debts/${debt.id}`, v); else await api.post('/api/debts', v);
      toast(debt ? 'Saved' : `Added ${v.name}`);
      onSaved?.();
    },
  });
}

export { currencySymbol };

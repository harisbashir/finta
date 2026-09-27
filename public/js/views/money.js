// Money: month overview, recurring bills & income, everyday spending, savings goals.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, fmtDate, fmtMonth, relDay, relPhrase, addMonthsYM, segmented, emptyState, hydrate, FREQ_LABEL, plural, daysBetween, enableSwipe, toast } from '../ui.js';
import { monthCard, expenseSheet, recurringSheet, recurringDetail, markPaid, markUnpaid, goalSheet, contributeSheet, budgetsSheet, KINDS, KIND_ORDER } from './money-sheets.js';

const TABS = [['overview', 'Month'], ['bills', 'Recurring'], ['spending', 'Spending'], ['goals', 'Goals']];

export async function mount(v) {
  const tab = TABS.some(([k]) => k === v.params[0]) ? v.params[0] : 'overview';
  v.el.innerHTML = String(html`<div class="large-title"><h1>Money</h1></div>${segmented(TABS, tab)}<div id="money-body"></div>`);
  $$('[data-seg]', v.el).forEach((b) => b.addEventListener('click', () => v.go(`#/money/${b.dataset.seg}`)));
  const body = $('#money-body', v.el);
  const views = { overview, bills, spending, goals };
  await views[tab](v, body);
  enableSwipe(v.el);
}

function monthSwitcher(ym) {
  const current = S.today.slice(0, 7);
  return html`<div class="month-switch">
    <button class="bar-btn icon-only" data-month="-1" aria-label="Previous month">${icon('chevron-left')}</button>
    <h2>${ym === current ? 'This Month' : fmtMonth(ym)}</h2>
    <button class="bar-btn icon-only" data-month="1" aria-label="Next month">${icon('chevron-right')}</button>
  </div>`;
}

// ─────────── Month overview ───────────
async function overview(v, body) {
  let ym = S.today.slice(0, 7);
  let m;
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add expense">${icon('plus')}</button>`, { '[data-add]': () => expenseSheet({ onSaved: load }) });

  async function load() {
    m = await api.get(`/api/money/summary?month=${ym}`);
    if (!v.alive()) return;
    S.today = m.today;
    render();
    v.refreshBadges();
  }

  function render() {
    const income = m.schedule.filter((s) => s.direction === 'in');
    const out = m.schedule.filter((s) => s.direction === 'out').sort((a, b) => a.paid - b.paid || a.due.localeCompare(b.due));
    const unpaid = out.filter((s) => !s.paid);
    const budgets = m.budgets.filter((b) => b.monthly_budget);
    const others = m.budgets.filter((b) => !b.monthly_budget);
    body.innerHTML = String(html`
      ${monthSwitcher(ym)}
      ${monthCard(m, { title: fmtMonth(ym) })}
      <div class="grid-2">
        <div>
          <section class="section">
            <div class="section-head"><h2>Bills</h2><span class="caps">${unpaid.length ? `${money(unpaid.reduce((s, x) => s + x.amount, 0), { short: true })} to go` : out.length ? 'All paid' : ''}</span></div>
            ${out.length ? html`<div class="group">${out.map((o) => occurrenceRow(o))}</div>`
              : html`<div class="group">${emptyState('receipt', 'No bills this month', 'Add rent or mortgage, utilities, phone and subscriptions once — Finta repeats them for you.', html`<button class="btn small" data-new="bill">${icon('plus')} Add a Bill</button>`)}</div>`}
          </section>
          <section class="section">
            <div class="section-head"><h2>Income</h2><span class="caps">${money(m.income, { short: true })}</span></div>
            ${income.length || m.extraIncome ? html`<div class="group">${income.map((o) => occurrenceRow(o))}
              ${m.extraIncome ? html`<a class="row" href="#/money/spending"><span class="body"><span class="title">Other income</span><span class="sub">One-off money in</span></span><span class="trail"><span class="amount text-pos">+${money(m.extraIncome)}</span></span></a>` : ''}</div>`
              : html`<div class="group">${emptyState('banknote', 'No income yet', 'Add your paycheques so Finta can show what’s left to spend.', html`<button class="btn small" data-new="income">${icon('plus')} Add Income</button>`)}</div>`}
          </section>
        </div>
        <div>
          <section class="section">
            <div class="section-head"><h2>Budgets</h2><button class="link" data-budgets>${budgets.length ? 'Edit' : 'Set Up'}</button></div>
            ${budgets.length ? html`<div class="group has-icons">${budgets.map(budgetRow)}</div>`
              : html`<div class="group">${emptyState('target', 'No budgets', 'Optional: set monthly limits for groceries, dining out and other everyday spending.')}</div>`}
            ${others.length ? html`<div class="section"></div><div class="section-head"><span class="caps">Other Spending</span></div><div class="group has-icons">${others.map(budgetRow)}</div>` : ''}
          </section>
          <section class="section">
            <div class="section-head"><h2>Every Month</h2></div>
            <div class="group">
              <div class="row"><span class="body"><span class="title">Regular income</span></span><span class="trail"><span class="amount">${money(m.monthly.income, { short: true })}</span></span></div>
              <div class="row"><span class="body"><span class="title">Committed costs</span><span class="sub">Bills, loans, insurance, subscriptions</span></span><span class="trail"><span class="amount">${money(m.monthly.committed, { short: true })}</span></span></div>
              <a class="row" href="#/money/bills"><span class="body"><span class="title">Subscriptions</span><span class="sub">${money(m.monthly.subscriptions * 12, { short: true })} a year</span></span><span class="trail"><span class="amount">${money(m.monthly.subscriptions, { short: true })}</span>${icon('chevron-right', 'chev')}</span></a>
            </div>
            <p class="section-foot">Averaged per month, so yearly and weekly items compare fairly.</p>
          </section>
        </div>
      </div>`);
    hydrate(body);
    $$('[data-month]', body).forEach((b) => b.addEventListener('click', () => { ym = addMonthsYM(ym, Number(b.dataset.month)); load(); }));
    $('[data-budgets]', body).onclick = () => budgetsSheet({ onSaved: load });
    $$('[data-new]', body).forEach((b) => b.addEventListener('click', () => recurringSheet({ kind: b.dataset.new, onSaved: load })));
    $('[data-setup-money]', body)?.addEventListener('click', () => recurringSheet({ onSaved: load }));
  }

  body.onclick = async (e) => {
    const key = (el) => { const [id, due] = el.split('|'); return m.schedule.find((s) => s.recurring_id === Number(id) && s.due === due); };
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      const o = key(pay.dataset.pay);
      if (o.paid) { if (!o.autopay) await markUnpaid({ ...o, due: o.due }, load); else toast('Autopay items are marked paid automatically. Turn off autopay to change this.'); }
      else await markPaid({ ...o }, load);
      return;
    }
    const d = e.target.closest('[data-detail]');
    if (d) recurringDetail(d.dataset.detail, { onChanged: load });
  };
  await load();
}

function occurrenceRow(o) {
  const k = KINDS[o.kind] || KINDS.bill;
  const overdue = !o.paid && o.due < S.today;
  const sub = o.paid ? (o.direction === 'in' ? 'Received' : 'Paid') + (o.autopay ? ' automatically' : '')
    : overdue ? html`<span class="text-neg">Overdue · ${relDay(o.due)}</span>` : `${o.direction === 'in' ? '' : 'Due '}${relDay(o.due)}${o.autopay ? ' · Autopay' : ''}`;
  return html`<div class="row ${o.paid ? '' : ''}">
    <button class="check positive" role="checkbox" aria-checked="${String(o.paid)}" data-pay="${o.recurring_id}|${o.due}" aria-label="${o.paid ? 'Paid' : 'Mark paid'}: ${o.name}, ${fmtDate(o.due)}"><span class="ring">${icon('check')}</span></button>
    <button class="body" data-detail="${o.recurring_id}"><span class="title">${o.name}</span><span class="sub">${sub}${o.variable && !o.paid ? ' · Estimate' : ''}</span></button>
    <span class="trail"><span class="amount ${o.direction === 'in' ? 'text-pos' : ''}">${o.direction === 'in' ? '+' : ''}${o.variable && !o.paid ? '~' : ''}${money(o.amount)}</span></span>
  </div>`;
}

function budgetRow(b) {
  const pct = b.monthly_budget ? (b.spent / b.monthly_budget) * 100 : 0;
  const over = b.monthly_budget && b.spent > b.monthly_budget;
  return html`<a class="row" href="#/money/spending">
    <span class="tile" data-color="${b.color}">${icon(b.icon)}</span>
    <span class="body"><span class="title kv"><span>${b.name}</span><span class="amount ${over ? 'text-neg' : ''}">${money(b.spent, { short: true })}${b.monthly_budget ? html` <span class="text-2">of ${money(b.monthly_budget, { short: true })}</span>` : ''}</span></span>
      ${b.monthly_budget ? html`<span class="bar ${over ? 'over' : ''}" data-color="${b.color}"><i data-w="${pct}"></i></span>
        <span class="sub">${over ? html`<span class="text-neg">${money(b.spent - b.monthly_budget, { short: true })} over</span>` : `${money(b.monthly_budget - b.spent, { short: true })} left`}</span>` : ''}
    </span></a>`;
}

// ─────────── Recurring (bills, income, subscriptions, loans) ───────────
async function bills(v, body) {
  let items = [];
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="New recurring item">${icon('plus')}</button>`, { '[data-add]': () => recurringSheet({ onSaved: load }) });
  async function load() { items = await api.get('/api/recurring'); if (v.alive()) render(); }

  function render() {
    const active = items.filter((i) => !i.paused);
    const inM = active.filter((i) => i.direction === 'in').reduce((s, i) => s + i.monthly, 0);
    const outM = active.filter((i) => i.direction === 'out').reduce((s, i) => s + i.monthly, 0);
    body.innerHTML = String(items.length ? html`
      <div class="card month-card">
        <div class="eyebrow"><span>Averaged per month</span></div>
        <dl class="legend">
          <div><dt><i class="k-left"></i>In</dt><dd>${money(inM, { short: true })}</dd></div>
          <div><dt><i class="k-bills"></i>Committed</dt><dd>${money(outM, { short: true })}</dd></div>
          <div><dt><i class="k-free"></i>Free after bills</dt><dd class="${inM - outM < 0 ? 'text-neg' : ''}">${money(inM - outM, { short: true })}</dd></div>
        </dl>
      </div>
      ${KIND_ORDER.map((k) => {
        const list = items.filter((i) => i.kind === k);
        if (!list.length) return '';
        const total = list.filter((i) => !i.paused).reduce((s, i) => s + i.monthly, 0);
        return html`<section class="section">
          <div class="section-head"><h2>${KINDS[k].plural}</h2><span class="caps">${money(total, { short: true })}/mo${k === 'subscription' ? ` · ${money(total * 12, { short: true })}/yr` : ''}</span></div>
          <div class="group has-icons">${list.map(itemRow)}</div>
        </section>`;
      })}
      <p class="section-foot">Tap an item for its schedule, payment history and — for loans — your payoff date.</p>`
      : html`<div class="group">${emptyState('repeat', 'Set it once, see it every month', 'Add your paycheques, mortgage or rent, utilities, insurance and subscriptions. Finta handles the repeating.', html`<button class="btn prominent small" data-first>${icon('plus')} Add Your First Item</button>`)}</div>`);
    $('[data-first]', body)?.addEventListener('click', () => recurringSheet({ onSaved: load }));
  }

  function itemRow(i) {
    const k = KINDS[i.kind];
    const next = !i.next_due ? 'Ended' : i.overdue ? html`<span class="text-neg">Overdue · ${relDay(i.next_due)}</span>` : `Next ${relPhrase(i.next_due).replace(/^on /, '')}`;
    const trialSoon = i.trial_ends && i.trial_ends >= S.today && daysBetween(S.today, i.trial_ends) <= 14;
    return html`<button class="row" data-item="${i.id}">
      <span class="tile" data-color="${i.category_color || k.color}">${icon(i.category_icon || k.icon)}</span>
      <span class="body"><span class="title">${i.name}</span>
        <span class="sub">${i.paused ? 'Paused' : next}${i.autopay && !i.paused ? ' · Autopay' : ''}${i.kind === 'loan' && i.payoff_date ? ` · Paid off ${fmtDate(i.payoff_date, { month: 'short', year: 'numeric' })}` : ''}</span>
        ${trialSoon ? html`<span class="pill warn">${icon('clock')}Trial ends ${relPhrase(i.trial_ends)}</span>` : ''}
      </span>
      <span class="trail"><span class="stack"><span class="amount ${i.direction === 'in' ? 'text-pos' : ''}">${i.variable ? '~' : ''}${money(i.amount)}</span><span class="freq">${FREQ_LABEL[i.frequency]}</span></span>${icon('chevron-right', 'chev')}</span>
    </button>`;
  }
  body.onclick = (e) => { const r = e.target.closest('[data-item]'); if (r) recurringDetail(r.dataset.item, { onChanged: load }); };
  await load();
}

// ─────────── Spending ───────────
async function spending(v, body) {
  let ym = S.today.slice(0, 7);
  let txs = [];
  let q = '';
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add expense">${icon('plus')}</button>`, { '[data-add]': () => expenseSheet({ onSaved: load }) });
  async function load() { txs = await api.get(`/api/transactions?month=${ym}`); if (v.alive()) render(); }

  function render() {
    const needle = q.trim().toLowerCase();
    const shown = needle ? txs.filter((t) => [t.note, t.category_name, t.goal_name].some((s) => s?.toLowerCase().includes(needle))) : txs;
    const spent = shown.filter((t) => t.direction === 'out' && !t.recurring_id && !t.goal_id).reduce((s, t) => s + t.amount, 0);
    const byDay = new Map();
    for (const t of shown) { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); }
    body.innerHTML = String(html`
      ${monthSwitcher(ym)}
      <div class="group"><label class="quick-add">${icon('search')}<input type="search" data-search placeholder="Search notes and categories" value="${q}" aria-label="Search transactions"></label></div>
      <p class="section-foot">${money(spent)} everyday spending${needle ? ' matching' : ''} in ${fmtMonth(ym)}. Bill payments are listed but counted under Bills.</p>
      <div class="section"></div>
      ${shown.length ? [...byDay].map(([day, list]) => html`
        <div class="day-head"><span>${relDay(day)}</span><span class="num">${money(list.filter((t) => t.direction === 'out').reduce((s, t) => s + t.amount, 0), { short: true })}</span></div>
        <div class="group has-icons">${list.map(txRow)}</div>`)
        : html`<div class="group">${emptyState('receipt', needle ? 'No matches' : 'No spending yet', needle ? 'Try another word.' : 'Tap + to add what you spend. It takes a few seconds and keeps your month honest.')}</div>`}`);
    const s = $('[data-search]', body);
    s.addEventListener('input', () => { q = s.value; const pos = s.selectionStart; render(); const n = $('[data-search]', body); n.focus(); n.setSelectionRange(pos, pos); });
    $$('[data-month]', body).forEach((b) => b.addEventListener('click', () => { ym = addMonthsYM(ym, Number(b.dataset.month)); load(); }));
  }

  function txRow(t) {
    const k = t.recurring_id ? KINDS[t.recurring_kind] || KINDS.bill : null;
    const tileIcon = t.goal_id ? 'piggy-bank' : k ? k.icon : t.category_icon || (t.direction === 'in' ? 'banknote' : 'tag');
    const color = t.goal_id ? 'teal' : t.category_color || (k ? k.color : 'gray');
    const label = t.note || t.category_name || (t.direction === 'in' ? 'Income' : 'Expense');
    const sub = [t.goal_id ? 'Savings' : t.recurring_id ? (t.direction === 'in' ? 'Recurring income' : 'Bill payment') : t.category_name && t.note ? t.category_name : '', t.paid_by_name && S.household ? t.paid_by_name : ''].filter(Boolean).join(' · ');
    return html`<button class="row" data-tx="${t.id}"><span class="tile" data-color="${color}">${icon(tileIcon)}</span>
      <span class="body"><span class="title">${label}</span>${sub ? html`<span class="sub">${sub}</span>` : ''}</span>
      <span class="trail"><span class="amount ${t.direction === 'in' ? 'text-pos' : ''}">${t.direction === 'in' ? '+' : ''}${money(t.amount)}</span></span></button>`;
  }
  body.onclick = (e) => { const r = e.target.closest('[data-tx]'); if (r) expenseSheet({ tx: txs.find((t) => t.id === Number(r.dataset.tx)), onSaved: load }); };
  await load();
}

// ─────────── Goals ───────────
async function goals(v, body) {
  let list = [];
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="New goal">${icon('plus')}</button>`, { '[data-add]': () => goalSheet({ onSaved: load }) });
  async function load() { list = await api.get('/api/goals'); if (v.alive()) render(); }

  function monthlyNeeded(g) {
    if (!g.target_date || g.saved >= g.target) return null;
    const months = Math.max(1, Math.round(daysBetween(S.today, g.target_date) / 30.44));
    return Math.ceil((g.target - g.saved) / months);
  }

  function render() {
    const active = list.filter((g) => !g.archived);
    const done = list.filter((g) => g.archived);
    body.innerHTML = String(list.length ? html`
      <div class="goal-grid">${active.map((g) => {
        const pct = Math.min(100, (g.saved / g.target) * 100);
        const need = monthlyNeeded(g);
        return html`<article class="card goal" data-color="${g.color}">
          <button class="goal-head" data-edit="${g.id}"><span class="tile" data-color="${g.color}">${icon('target')}</span><span class="body"><span class="title"><strong>${g.name}</strong></span>
            <span class="sub">${g.target_date ? `By ${fmtDate(g.target_date, { month: 'long', year: 'numeric' })}` : 'No date'}</span></span>${icon('chevron-right', 'chev')}</button>
          <div class="goal-amounts"><span class="big">${money(g.saved, { short: true })}</span><span class="text-2">of ${money(g.target, { short: true })}</span></div>
          <div class="bar" data-color="${g.color}" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${g.name} progress"><i data-w="${pct}"></i></div>
          <p class="sub">${g.saved >= g.target ? 'Goal reached. Nicely done.' : need ? `Set aside about ${money(need, { short: true })} a month to get there.` : `${money(g.target - g.saved, { short: true })} to go.`}</p>
          <button class="btn small block" data-contribute="${g.id}">${icon('plus')} Add Money</button>
        </article>`;
      })}</div>
      ${done.length ? html`<div class="section"></div><div class="section-head"><span class="caps">Completed</span></div>
        <div class="group">${done.map((g) => html`<button class="row" data-edit="${g.id}"><span class="body"><span class="title">${g.name}</span></span><span class="trail amount">${money(g.saved, { short: true })}</span></button>`)}</div>` : ''}
      <p class="section-foot">Money you add to a goal counts as “Saved” in your month.</p>`
      : html`<div class="group">${emptyState('piggy-bank', 'Save for something', 'An emergency fund, a trip, a new roof. Finta shows how much to put away each month.', html`<button class="btn prominent small" data-first>${icon('plus')} New Goal</button>`)}</div>`);
    hydrate(body);
    $('[data-first]', body)?.addEventListener('click', () => goalSheet({ onSaved: load }));
  }
  body.onclick = (e) => {
    const byId = (id) => list.find((g) => g.id === Number(id));
    const c = e.target.closest('[data-contribute]');
    if (c) return contributeSheet(byId(c.dataset.contribute), { onSaved: load });
    const ed = e.target.closest('[data-edit]');
    if (ed) goalSheet({ goal: byId(ed.dataset.edit), onSaved: load });
  };
  await load();
}

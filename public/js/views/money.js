// Money: the month at a glance with charts, then Accounts, Bills & Income, Spending, Debts and Goals.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, fmtDate, fmtMonth, relDay, relPhrase, addMonthsYM, segmented, emptyState, hydrate, FREQ_LABEL, plural, daysBetween, enableSwipe, toast } from '../ui.js';
import { monthCard, expenseSheet, recurringSheet, recurringDetail, markPaid, markUnpaid, goalSheet, contributeSheet, budgetsSheet, KINDS, KIND_ORDER } from './money-sheets.js';
import { columns, barList, stack, SERIES_CLASSES } from '../charts.js';
import { getMembers, getCategories } from '../store.js';

const PAGES = {
  accounts: 'Accounts', review: 'Review', bills: 'Bills & Income', spending: 'Spending', debts: 'Debts', goals: 'Goals',
};

// "Household" or "Just Me": remembered on this device only (a viewing preference).
export function getScope() { try { return localStorage.getItem('finta-scope') === 'me' ? 'me' : 'household'; } catch { return 'household'; } }
function setScope(v) { try { localStorage.setItem('finta-scope', v); } catch { /* ignore */ } }

export async function scopeSwitch(onChange) {
  const members = await getMembers();
  if (members.length < 2) return { markup: '', wire: () => {} };
  const cur = getScope();
  return {
    markup: html`<div class="scope" role="group" aria-label="Show money for">
      <button data-scope="household" aria-pressed="${String(cur === 'household')}">${S.household.name}</button>
      <button data-scope="me" aria-pressed="${String(cur === 'me')}">Just Me</button></div>`,
    wire: (root) => $$('[data-scope]', root).forEach((b) => b.addEventListener('click', () => { setScope(b.dataset.scope); onChange(); })),
  };
}

export async function mount(v) {
  const page = v.params[0];
  if (!page || !PAGES[page]) return overview(v);
  v.setLead(html`<a class="bar-btn" href="#/money">${icon('chevron-left')}<span>Money</span></a>`);
  v.setTitle(PAGES[page]);
  if (page === 'accounts') return (await import('./accounts.js')).mountAccounts(v);
  if (page === 'review') return (await import('./accounts.js')).mountReview(v);
  if (page === 'debts') return (await import('./debts.js')).mountDebts(v);
  v.el.innerHTML = String(html`<div class="large-title"><h1>${PAGES[page]}</h1></div><div id="money-body"></div>`);
  const body = $('#money-body', v.el);
  await ({ bills, spending, goals })[page](v, body);
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

const shortMonth = (ym) => fmtDate(ym + '-01', { month: 'short' });

// ─────────── Overview ───────────
async function overview(v) {
  let ym = S.today.slice(0, 7);
  let m, ins, accounts, debts;
  const sw = await scopeSwitch(() => load());
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add expense">${icon('plus')}</button>`, { '[data-add]': () => expenseSheet({ onSaved: load }) });

  async function load() {
    const scope = getScope();
    [m, ins, accounts, debts] = await Promise.all([
      api.get(`/api/money/summary?month=${ym}&scope=${scope}`), api.get(`/api/money/insights?month=${ym}&scope=${scope}`),
      api.get('/api/accounts'), api.get(`/api/debts?scope=${scope}`),
    ]);
    if (!v.alive()) return;
    S.today = m.today;
    render();
    v.refreshBadges();
  }

  function render() {
    const scope = getScope();
    const sw2 = sw;
    const out = m.schedule.filter((s) => s.direction === 'out').sort((a, b) => a.paid - b.paid || a.due.localeCompare(b.due));
    const unpaid = out.filter((s) => !s.paid);
    const budgets = m.budgets.filter((b) => b.monthly_budget);
    let trend = ins.trend;
    const firstData = trend.findIndex((t) => t.in || t.out);
    if (firstData > 0) trend = trend.slice(Math.min(firstData, trend.length - 3));
    const hasTrend = trend.some((t) => t.in || t.out);
    const mine = accounts.filter((a) => scope === 'household' || a.owner_id === S.user.id);
    const nw = ins.netWorth;
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Money</h1></div>
      ${sw2.markup}
      ${m.needsReview ? html`<a class="banner" href="#/money/review"><span class="tile" data-color="blue">${icon('tag')}</span>
        <span class="body"><span class="title">${plural(m.needsReview, 'transaction')} to sort</span><span class="sub">One tap each — Finta remembers for next time.</span></span>${icon('chevron-right', 'chev')}</a>` : ''}
      ${monthSwitcher(ym)}
      ${monthCard(m, { title: fmtMonth(ym) + (scope === 'me' ? ' · Just Me' : '') })}

      <div class="tiles">
        <a class="tile-stat" href="#/money/accounts"><span class="label">${icon('landmark', 'icon-sm')} Cash & Savings</span><span class="value">${money(nw.cash, { short: true })}</span><span class="delta">${plural(mine.filter((a) => !['credit_card', 'line_of_credit'].includes(a.type)).length, 'account')}</span></a>
        <a class="tile-stat" href="#/money/debts"><span class="label">${icon('credit-card', 'icon-sm')} Total Debt</span><span class="value">${money(debts.total, { short: true })}</span><span class="delta">${debts.monthlyInterest ? `~${money(debts.monthlyInterest, { short: true })} interest a month` : plural(debts.debts.length, 'debt')}</span></a>
      </div>

      <div class="grid-2">
        <div>
          <section class="section card">
            <div class="card-head"><h3>In and Out</h3></div>
            <p class="card-sub">What actually came in and went out each month, from your accounts and entries. Transfers between your accounts aren’t counted.</p>
            ${hasTrend ? html`<div id="trend-chart"></div>` : html`<p class="text-2">Import a statement or add spending to see your months side by side.</p>`}
          </section>
          <section class="section card">
            <div class="card-head"><h3>Where It Went</h3><a href="#/money/spending">All Spending</a></div>
            <p class="card-sub">${fmtMonth(ym)}, bills included. Tap a category to see its transactions.</p>
            ${ins.categories.length ? barList(ins.categories.map((c) => ({ label: c.name, value: c.amount, id: c.id, icon: html`<span class="tile" data-color="${c.color}">${icon(c.icon)}</span>`, sub: plural(c.count, 'transaction') })),
              { caption: 'Spending by category', href: (r) => r.id ? `#/money/spending/${ym}/${r.id}` : `#/money/spending/${ym}` }) : html`<p class="text-2">Nothing spent yet this month.</p>`}
          </section>
          ${ins.members && ins.members.length > 1 ? html`<section class="section card">
            <div class="card-head"><h3>Who Spent</h3></div><p class="card-sub">${fmtMonth(ym)}. Joint accounts and shared bills count as Joint.</p>
            ${stack(ins.members.map((p, i) => ({ name: p.name, value: p.amount, cls: p.owner_id === null ? 'c-muted' : SERIES_CLASSES[i % 4] })), { caption: 'Spending by person' })}
          </section>` : ''}
        </div>
        <div>
          <section class="section">
            <div class="group has-icons">
              ${navRow('#/money/accounts', 'landmark', 'blue', 'Accounts', `${plural(accounts.length, 'account')} · Import statements`)}
              ${navRow('#/money/bills', 'repeat', 'purple', 'Bills & Income', `${money(m.monthly.committed, { short: true })} a month committed`)}
              ${navRow('#/money/spending', 'receipt', 'orange', 'Spending', `${money(m.spent, { short: true })} this month`)}
              ${navRow('#/money/debts', 'credit-card', 'brown', 'Debts', debts.total ? `${money(debts.total, { short: true })} owed` : 'Nothing owed')}
              ${navRow('#/money/goals', 'piggy-bank', 'teal', 'Goals', m.saved ? `${money(m.saved, { short: true })} set aside this month` : 'Save for something')}
            </div>
          </section>
          <section class="section">
            <div class="section-head"><h2>Bills</h2><span class="caps">${unpaid.length ? `${money(unpaid.reduce((s, x) => s + x.amount, 0), { short: true })} to go` : out.length ? 'All paid' : ''}</span></div>
            ${out.length ? html`<div class="group">${out.map((o) => occurrenceRow(o))}</div>`
              : html`<div class="group">${emptyState('receipt', 'No bills this month', 'Add rent or mortgage, utilities, phone and subscriptions once — Finta repeats them for you.', html`<button class="btn small" data-new="bill">${icon('plus')} Add a Bill</button>`)}</div>`}
          </section>
          <section class="section">
            <div class="section-head"><h2>Budgets</h2><button class="link" data-budgets>${budgets.length ? 'Edit' : 'Set Up'}</button></div>
            ${budgets.length ? html`<div class="group has-icons">${budgets.map(budgetRow)}</div>`
              : html`<div class="group">${emptyState('target', 'No budgets', 'Optional: set monthly limits for groceries, dining out and other everyday spending.')}</div>`}
          </section>
        </div>
      </div>`);
    hydrate(v.el);
    sw2.wire(v.el);
    if (hasTrend) columns($('#trend-chart', v.el), {
      labels: trend.map((t) => shortMonth(t.month)), fullLabels: trend.map((t) => fmtMonth(t.month)), caption: 'Money in and out by month',
      series: [{ name: 'In', cls: 'c-in', values: trend.map((t) => t.in) }, { name: 'Out', cls: 'c-out', values: trend.map((t) => t.out) }],
    });
    $$('[data-month]', v.el).forEach((b) => b.addEventListener('click', () => { ym = addMonthsYM(ym, Number(b.dataset.month)); load(); }));
    $('[data-budgets]', v.el).onclick = () => budgetsSheet({ onSaved: load });
    $$('[data-new]', v.el).forEach((b) => b.addEventListener('click', () => recurringSheet({ kind: b.dataset.new, onSaved: load })));
    $('[data-setup-money]', v.el)?.addEventListener('click', () => recurringSheet({ onSaved: load }));
  }

  v.el.onclick = async (e) => {
    const key = (el) => { const [id, due] = el.split('|'); return m.schedule.find((s) => s.recurring_id === Number(id) && s.due === due); };
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      const o = key(pay.dataset.pay);
      if (o.paid) { if (o.imported) toast('Paid from an imported statement. Remove it from the account to undo.'); else if (!o.autopay) await markUnpaid({ ...o }, load); else toast('Autopay items are marked paid automatically. Turn off autopay to change this.'); }
      else await markPaid({ ...o }, load);
      return;
    }
    const d = e.target.closest('[data-detail]');
    if (d) recurringDetail(d.dataset.detail, { onChanged: load });
  };
  await load();
  enableSwipe(v.el);
}

function navRow(href, ic, color, title, sub) {
  return html`<a class="row" href="${href}"><span class="tile" data-color="${color}">${icon(ic)}</span>
    <span class="body"><span class="title">${title}</span><span class="sub">${sub}</span></span>${icon('chevron-right', 'chev')}</a>`;
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
  let suggestions = [];
  async function load() {
    [items, suggestions] = await Promise.all([api.get('/api/recurring'), api.get('/api/money/suggestions')]);
    if (v.alive()) render();
  }
  const suggestionCard = () => (suggestions.length ? html`<section class="section">
      <div class="section-head"><h2>Looks Recurring</h2><span class="caps">From your statements</span></div>
      <div class="group has-icons">${suggestions.map((x, i) => html`<div class="row">
        <span class="tile" data-color="${KINDS[x.kind].color}">${icon(KINDS[x.kind].icon)}</span>
        <span class="body"><span class="title">${x.name}</span><span class="sub">${x.variable ? 'About ' : ''}${money(x.amount)} ${FREQ_LABEL[x.frequency].toLowerCase()} · seen ${x.count} times</span>
          <span class="row-actions"><button class="btn small prominent" data-track="${i}">Track as ${KINDS[x.kind].label}</button><button class="btn small plain" data-dismiss="${i}">Not a Bill</button></span></span>
      </div>`)}</div>
      <p class="section-foot">Tracking one adds it to your month and marks each statement payment as paid automatically.</p></section>` : '');

  function render() {
    const active = items.filter((i) => !i.paused);
    const inM = active.filter((i) => i.direction === 'in').reduce((s, i) => s + i.monthly, 0);
    const outM = active.filter((i) => i.direction === 'out').reduce((s, i) => s + i.monthly, 0);
    body.innerHTML = String(items.length ? html`
      ${suggestionCard()}
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
      : html`${suggestionCard()}<div class="group">${emptyState('repeat', 'Set it once, see it every month', 'Add your paycheques, mortgage or rent, utilities, insurance and subscriptions. Finta handles the repeating.', html`<button class="btn prominent small" data-first>${icon('plus')} Add Your First Item</button>`)}</div>`);
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
  body.onclick = async (e) => {
    const tr = e.target.closest('[data-track]');
    if (tr) {
      const x = suggestions[Number(tr.dataset.track)];
      tr.setAttribute('aria-busy', 'true');
      const r = await api.post('/api/money/suggestions/accept', x);
      toast(`Tracking ${x.name}${r.linked ? ` · ${plural(r.linked, 'past payment')} matched` : ''}`);
      return load();
    }
    const dm = e.target.closest('[data-dismiss]');
    if (dm) { await api.post('/api/money/suggestions/dismiss', { merchant: suggestions[Number(dm.dataset.dismiss)].merchant }); return load(); }
    const r = e.target.closest('[data-item]'); if (r) recurringDetail(r.dataset.item, { onChanged: load });
  };
  await load();
}

// ─────────── Spending ───────────
async function spending(v, body) {
  let ym = /^\d{4}-\d{2}$/.test(v.params[1] || '') ? v.params[1] : S.today.slice(0, 7);
  let cat = v.params[2] ? Number(v.params[2]) : null;
  let txs = [];
  let q = '';
  let showTransfers = false;
  const cats = await getCategories();
  const sw = await scopeSwitch(() => load());
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add expense">${icon('plus')}</button>`, { '[data-add]': () => expenseSheet({ onSaved: load }) });
  async function load() {
    txs = await api.get(`/api/transactions?month=${ym}&scope=${getScope()}${showTransfers ? '&transfers=1' : ''}${cat ? `&category=${cat}` : ''}`);
    if (v.alive()) render();
  }

  function render() {
    const needle = q.trim().toLowerCase();
    const shown = needle ? txs.filter((t) => [t.note, t.category_name, t.goal_name, t.description, t.account_name].some((x) => x?.toLowerCase().includes(needle))) : txs;
    const spent = shown.filter((t) => !t.is_transfer && !t.goal_id).reduce((s2, t) => s2 + (t.direction === 'out' ? t.amount : t.category_kind === 'out' ? -t.amount : 0), 0);
    const byDay = new Map();
    for (const t of shown) { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); }
    const c = cat ? cats.find((x) => x.id === cat) : null;
    body.innerHTML = String(html`
      ${sw.markup}
      ${monthSwitcher(ym)}
      <div class="group"><label class="quick-add">${icon('search')}<input type="search" data-search placeholder="Search descriptions, categories, accounts" value="${q}" aria-label="Search transactions"></label></div>
      <div class="chips spend-chips" role="group" aria-label="Filters">
        ${c ? html`<button class="chip" aria-pressed="true" data-clear-cat>${c.name} ${icon('x', 'icon-sm')}</button>` : ''}
        <button class="chip" data-transfers aria-pressed="${String(showTransfers)}">${icon('refresh-cw', 'icon-sm')} Show transfers</button>
      </div>
      <p class="section-foot">${money(spent)} spent${c ? ` on ${c.name}` : ''}${needle ? ' matching' : ''} in ${fmtMonth(ym)}, bills included, refunds subtracted.</p>
      <div class="section"></div>
      ${shown.length ? [...byDay].map(([day, list]) => html`
        <div class="day-head"><span>${relDay(day)}</span><span class="num">${money(list.filter((t) => t.direction === 'out' && !t.is_transfer).reduce((s2, t) => s2 + t.amount, 0), { short: true })}</span></div>
        <div class="group has-icons">${list.map(txRow)}</div>`)
        : html`<div class="group">${emptyState('receipt', needle || c ? 'No matches' : 'No spending yet', needle || c ? 'Try another filter.' : 'Import a statement from Accounts, or tap + to add what you spend.')}</div>`}`);
    sw.wire(body);
    const s2 = $('[data-search]', body);
    s2.addEventListener('input', () => { q = s2.value; const pos = s2.selectionStart; render(); const n = $('[data-search]', body); n.focus(); n.setSelectionRange(pos, pos); });
    $$('[data-month]', body).forEach((b) => b.addEventListener('click', () => { ym = addMonthsYM(ym, Number(b.dataset.month)); load(); }));
    $('[data-clear-cat]', body)?.addEventListener('click', () => { cat = null; history.replaceState(null, '', '#/money/spending'); load(); });
    $('[data-transfers]', body).onclick = () => { showTransfers = !showTransfers; load(); };
  }

  body.onclick = (e) => { const r = e.target.closest('[data-tx]'); if (r) txSheet(txs.find((t) => t.id === Number(r.dataset.tx)), load); };
  await load();
}

/** Row for any transaction list. */
export function txRow(t) {
  const k = t.recurring_id ? KINDS[t.recurring_kind] || KINDS.bill : null;
  const tileIcon = t.is_transfer ? 'refresh-cw' : t.goal_id ? 'piggy-bank' : k ? k.icon : t.category_icon || (t.direction === 'in' ? 'banknote' : 'tag');
  const color = t.is_transfer ? 'gray' : t.goal_id ? 'teal' : t.category_color || (k ? k.color : 'gray');
  const label = t.note || t.category_name || (t.direction === 'in' ? 'Income' : 'Expense');
  const refund = t.direction === 'in' && t.category_kind === 'out';
  const what = t.is_transfer ? (t.peer_account ? `Transfer ${t.direction === 'out' ? 'to' : 'from'} ${t.peer_account}` : 'Transfer') : t.goal_id ? 'Savings'
    : t.recurring_id ? (t.direction === 'in' ? 'Recurring income' : 'Bill payment') : refund ? `Refund · ${t.category_name}` : t.category_name || '';
  const sub = [what, t.account_name].filter(Boolean).join(' · ');
  const needs = !t.category_id && !t.is_transfer && !t.recurring_id && !t.goal_id && t.account_id;
  return html`<button class="row" data-tx="${t.id}"><span class="tile" data-color="${color}">${icon(tileIcon)}</span>
    <span class="body"><span class="title">${label}</span><span class="sub">${needs ? html`<span class="text-warn">Needs a category</span>${t.account_name ? ` · ${t.account_name}` : ''}` : sub}</span></span>
    <span class="trail"><span class="amount ${t.direction === 'in' && !t.is_transfer ? 'text-pos' : ''} ${t.is_transfer ? 'text-2' : ''}">${t.direction === 'in' ? '+' : ''}${money(t.amount)}</span></span></button>`;
}

/** Imported rows open the categorize sheet; manual ones open the editor. */
export async function txSheet(t, reload) {
  if (t.account_id && t.import_id) return (await import('./accounts.js')).categorizeSheet(t, reload);
  return expenseSheet({ tx: t, onSaved: reload });
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

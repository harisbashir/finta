// Today: the month at a glance, what needs attention, and quick entry.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, relPhrase, fmtLong, relDay, fmtDate, toast, emptyState, hydrate, enableSwipe, plural } from '../ui.js';
import { monthCard, expenseSheet, recurringSheet, recurringDetail, markPaid, KINDS } from './money-sheets.js';
import { taskRow, taskSheet, completeTask, deleteTask } from './tasks.js';
import { addItemsSheet } from './lists.js';

export async function mount(v) {
  const load = async () => {
    const t = await api.get('/api/today');
    if (!v.alive()) return;
    S.today = t.today;
    render(v, t, load);
    v.refreshBadges();
  };
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add expense">${icon('plus')}</button>`, {
    '[data-add]': () => expenseSheet({ onSaved: load }),
  });
  await load();
  enableSwipe(v.el);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function render(v, t, reload) {
  const overdueBills = t.bills.filter((b) => b.overdue && !b.autopay);
  const soonBills = t.bills.filter((b) => !b.overdue && b.direction === 'out');
  const payday = t.bills.find((b) => b.direction === 'in' && !b.overdue);
  const tonight = t.meals.filter((m) => m.date === t.today);
  const tomorrowMeals = t.meals.filter((m) => m.date !== t.today);
  const overdueTasks = t.tasks.filter((x) => x.due_date < t.today);
  const heads = [
    ...t.trials.map((x) => ({ icon: 'calendar-clock', color: 'purple', title: `${x.name} trial ends ${relPhrase(x.trial_ends)}`, sub: `Then ${money(x.amount)} a period. Cancel before if you don’t want it.`, href: '#/money/bills' })),
    ...t.warranties.map((x) => ({ icon: 'shield-check', color: 'orange', title: `${x.name} warranty ends ${relPhrase(x.warranty_until)}`, sub: 'Check it over while it’s still covered.', href: '#/home/things' })),
  ];

  v.el.innerHTML = String(html`
    <div class="large-title"><h1>${greeting()}, ${S.user.name}</h1><p>${fmtLong(t.today)}</p></div>

    ${monthCard(t.month)}
    ${t.needsReview ? html`<a class="banner" href="#/money/review"><span class="tile" data-color="blue">${icon('tag')}</span>
      <span class="body"><span class="title">${plural(t.needsReview, 'transaction')} to sort</span><span class="sub">From your last statement import. One tap each.</span></span>${icon('chevron-right', 'chev')}</a>` : ''}

    <div class="quick">
      <button class="btn prominent" data-q="expense">${icon('receipt')}Add Expense</button>
      <button class="btn" data-q="task">${icon('circle-check')}Add Task</button>
      <button class="btn" data-q="list">${icon('shopping-cart')}Add to List</button>
    </div>

    <div class="grid-2">
      <div>
        ${overdueBills.length || soonBills.length || payday ? html`
        <section class="section">
          <div class="section-head"><h2>Bills This Week</h2><a href="#/money/overview">See Month</a></div>
          <div class="group">
            ${[...overdueBills, ...soonBills].map((b) => billRow(b))}
            ${payday ? html`<div class="row"><span class="tile" data-color="green">${icon('banknote')}</span><span class="body"><span class="title">${payday.name}</span><span class="sub">${relDay(payday.due)}${payday.autopay ? ' · Automatic' : ''}</span></span><span class="trail"><span class="amount text-pos">+${money(payday.amount)}</span></span></div>` : ''}
          </div>
        </section>` : html`
        <section class="section"><div class="section-head"><h2>Bills This Week</h2></div>
          <div class="group">${emptyState('circle-check', 'Nothing due this week', 'Bills you add show up here a week before they’re due.', html`<button class="btn small" data-add-bill>${icon('plus')} Add a Bill</button>`)}</div>
        </section>`}

        <section class="section">
          <div class="section-head"><h2>Tasks</h2><a href="#/tasks">All Tasks</a></div>
          ${t.tasks.length ? html`<div class="group">${t.tasks.map((x) => taskRow(x, t.today))}</div>
            ${overdueTasks.length ? html`<p class="section-foot">${plural(overdueTasks.length, 'task')} overdue.</p>` : ''}`
            : html`<div class="group">${emptyState('sparkles', 'All clear', 'Nothing due today or tomorrow.')}</div>`}
        </section>
      </div>

      <div>
        <section class="section">
          <div class="section-head"><h2>Meals</h2><a href="#/lists/meals">Plan Week</a></div>
          <div class="group has-icons">
            ${tonight.length ? tonight.map((m) => mealRow(m, 'Today')) : html`<a class="row" href="#/lists/meals"><span class="tile" data-color="orange">${icon('chef-hat')}</span><span class="body"><span class="title">What’s for dinner?</span><span class="sub">Nothing planned for today</span></span>${icon('chevron-right', 'chev')}</a>`}
            ${tomorrowMeals.map((m) => mealRow(m, 'Tomorrow'))}
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Shopping</h2><a href="#/lists/shopping">Open Lists</a></div>
          <div class="group has-icons">
            ${t.lists.map((l) => html`<a class="row" href="#/lists/shopping/${l.id}"><span class="tile" data-color="green">${icon('shopping-cart')}</span>
              <span class="body"><span class="title">${l.name}</span><span class="sub">${l.open_count ? plural(l.open_count, 'item') + ' to get' : 'All done'}</span></span>${icon('chevron-right', 'chev')}</a>`)}
          </div>
        </section>

        ${heads.length ? html`<section class="section"><div class="section-head"><h2>Heads Up</h2></div>
          <div class="group has-icons">${heads.map((h) => html`<a class="row" href="${h.href}"><span class="tile" data-color="${h.color}">${icon(h.icon)}</span><span class="body"><span class="title">${h.title}</span><span class="sub">${h.sub}</span></span>${icon('chevron-right', 'chev')}</a>`)}</div></section>` : ''}
      </div>
    </div>`);
  hydrate(v.el);

  const el = v.el;
  $('[data-q=expense]', el).onclick = () => expenseSheet({ onSaved: reload });
  $('[data-q=task]', el).onclick = () => taskSheet({ onSaved: reload });
  $('[data-q=list]', el).onclick = () => addItemsSheet({ onSaved: reload });
  $('[data-setup-money]', el)?.addEventListener('click', () => recurringSheet({ onSaved: reload }));
  $('[data-add-bill]', el)?.addEventListener('click', () => recurringSheet({ kind: 'bill', onSaved: reload }));

  const billsById = Object.fromEntries(t.bills.map((b) => [`${b.recurring_id}:${b.due}`, b]));
  el.onclick = async (e) => {
    const pay = e.target.closest('[data-pay]');
    if (pay) { e.stopPropagation(); await markPaid(billsById[pay.dataset.pay], reload); return; }
    const bill = e.target.closest('[data-bill]');
    if (bill) { recurringDetail(bill.dataset.bill, { onChanged: reload }); return; }
    const done = e.target.closest('[data-complete]');
    if (done) { e.stopPropagation(); await completeTask(t.tasks.find((x) => x.id === Number(done.dataset.complete)), reload); return; }
    const del = e.target.closest('[data-del-task]');
    if (del) { await deleteTask(t.tasks.find((x) => x.id === Number(del.dataset.delTask)), reload); return; }
    const task = e.target.closest('[data-task]');
    if (task) taskSheet({ task: t.tasks.find((x) => x.id === Number(task.dataset.task)), onSaved: reload });
  };
}

function billRow(b) {
  const k = KINDS[b.kind] || KINDS.bill;
  const when = b.overdue ? html`<span class="text-neg">Overdue · ${relDay(b.due)}</span>` : relDay(b.due);
  return html`<div class="row link">
    ${b.autopay ? html`<span class="tile" data-color="${b.category_color || k.color}">${icon(k.icon)}</span>`
      : html`<button class="check positive" role="checkbox" aria-checked="false" data-pay="${b.recurring_id}:${b.due}" aria-label="Mark ${b.name} paid"><span class="ring">${icon('check')}</span></button>`}
    <button class="body" data-bill="${b.recurring_id}"><span class="title">${b.name}</span><span class="sub">${when}${b.autopay ? ' · Autopay' : ''}${b.variable ? ' · Estimate' : ''}</span></button>
    <span class="trail"><span class="amount">${b.variable ? '~' : ''}${money(b.amount)}</span></span>
  </div>`;
}

function mealRow(m, when) {
  return html`<a class="row" href="#/lists/meals"><span class="tile" data-color="orange">${icon('utensils')}</span>
    <span class="body"><span class="title">${m.title}</span><span class="sub">${when} · ${m.slot[0].toUpperCase() + m.slot.slice(1)}</span></span>${icon('chevron-right', 'chev')}</a>`;
}

// Lists: shared shopping lists and a weekly meal plan that feeds them.
import { api } from '../api.js';
import { html, icon, $, $$, S, sheet, toast, confirmDialog, fText, fSelect, fDate, fTextarea, segmented, emptyState, enableSwipe, addDays, fmtDate, plural } from '../ui.js';
import { getLists, invalidate } from '../store.js';

export async function mount(v) {
  const tab = v.params[0] === 'meals' ? 'meals' : 'shopping';
  v.el.innerHTML = String(html`<div class="large-title"><h1>Lists</h1></div>
    ${segmented([['shopping', 'Shopping'], ['meals', 'Meals']], tab)}<div id="list-body"></div>`);
  $$('[data-seg]', v.el).forEach((b) => b.addEventListener('click', () => v.go(`#/lists/${b.dataset.seg}`)));
  const body = $('#list-body', v.el);
  if (tab === 'meals') await meals(v, body); else await shopping(v, body, Number(v.params[1]) || null);
  enableSwipe(v.el);
}

// ─────────── Shopping ───────────
async function shopping(v, body, wantedId) {
  let lists = await getLists(true);
  let current = lists.find((l) => l.id === wantedId) || lists[0];
  let items = [];

  v.setToolbar(html`<button class="bar-btn" data-new-list>${icon('list-plus')}<span>New List</span></button>`, {
    '[data-new-list]': () => listSheet({ onSaved: async (l) => { lists = await getLists(true); current = lists.find((x) => x.id === l.id) || current; await load(); } }),
  });

  const load = async () => {
    if (!current) { render(); return; }
    items = await api.get(`/api/lists/${current.id}/items`);
    if (!v.alive()) return;
    render();
  };

  function render() {
    if (!current) {
      body.innerHTML = String(html`<div class="group">${emptyState('shopping-cart', 'No lists yet', 'Make a list for groceries, the hardware store, or anything you pick up regularly.', html`<button class="btn prominent small" data-first>New List</button>`)}</div>`);
      $('[data-first]', body).onclick = () => listSheet({ onSaved: async () => { lists = await getLists(true); current = lists[0]; await load(); } });
      return;
    }
    const open = items.filter((i) => !i.checked);
    const got = items.filter((i) => i.checked);
    body.innerHTML = String(html`
      ${lists.length > 1 ? html`<div class="chips" role="group" aria-label="Lists">${lists.map((l) => html`<button class="chip" data-list="${l.id}" aria-pressed="${String(l.id === current.id)}">${l.name}${l.id === current.id ? '' : html` <span class="count">${l.open_count || ''}</span>`}</button>`)}</div>` : ''}
      <div class="section-head"><h2>${current.name}</h2><button class="link" data-edit-list>Edit</button></div>
      <form class="group" data-add-item>
        <label class="quick-add">${icon('circle-plus')}<input name="name" placeholder="Add items — separate with commas" maxlength="400" autocomplete="off" aria-label="Add items to ${current.name}"></label>
      </form>
      <div class="section"></div>
      <section class="section">
        ${open.length ? html`<div class="group">${open.map(itemRow)}</div>`
          : html`<div class="group">${emptyState('circle-check', got.length ? 'Got everything' : 'List is empty', got.length ? 'Nice work. Clear the checked items when you’re home.' : 'Type above to add. Everyone in the household sees the same list.')}</div>`}
      </section>
      ${got.length ? html`<section class="section">
        <div class="section-head"><span class="caps">In the Cart · ${got.length}</span><button class="link" data-clear>Clear</button></div>
        <div class="group">${got.map(itemRow)}</div></section>` : ''}`);

    const input = $('[data-add-item] input', body);
    $('[data-add-item]', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      input.value = '';
      try { await api.post(`/api/lists/${current.id}/items`, { name }); await load(); $('[data-add-item] input', body)?.focus(); }
      catch (err) { toast(err.message, { error: true }); input.value = name; }
    });
    $$('[data-list]', body).forEach((b) => b.addEventListener('click', async () => {
      current = lists.find((l) => l.id === Number(b.dataset.list));
      history.replaceState(null, '', `#/lists/shopping/${current.id}`);
      await load();
    }));
    $('[data-edit-list]', body).onclick = () => listSheet({ list: current, onSaved: async (l) => { lists = await getLists(true); current = l ? lists.find((x) => x.id === l.id) : lists[0]; await load(); } });
    $('[data-clear]', body)?.addEventListener('click', async () => {
      const r = await api.post(`/api/lists/${current.id}/clear-checked`);
      await load();
      toast(`Cleared ${plural(r.removed.length, 'item')}`, {
        undo: async () => {
          for (const it of r.removed) {
            const [n] = await api.post(`/api/lists/${current.id}/items`, { name: it.name, quantity: it.quantity });
            await api.patch(`/api/items/${n.id}`, { checked: true });
          }
          await load();
        },
      });
    });
  }

  function itemRow(i) {
    return html`<div class="swipe"><div class="row ${i.checked ? 'done' : ''}">
      <button class="check" role="checkbox" aria-checked="${String(!!i.checked)}" data-toggle="${i.id}" aria-label="${i.name}"><span class="ring">${icon('check')}</span></button>
      <button class="body" data-item="${i.id}"><span class="title">${i.name}</span>${i.quantity ? html`<span class="sub">${i.quantity}</span>` : ''}</button>
    </div><div class="swipe-actions"><button class="del" data-del-item="${i.id}">${icon('trash-2')}Delete</button></div></div>`;
  }

  body.onclick = async (e) => {
    const byId = (id) => items.find((x) => x.id === Number(id));
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const it = byId(tg.dataset.toggle);
      it.checked = it.checked ? 0 : 1;
      tg.setAttribute('aria-checked', String(!!it.checked));
      await api.patch(`/api/items/${it.id}`, { checked: !!it.checked });
      setTimeout(load, 350); // let the check land before the row moves
      return;
    }
    const del = e.target.closest('[data-del-item]');
    if (del) {
      const it = byId(del.dataset.delItem);
      await api.del(`/api/items/${it.id}`);
      await load();
      toast(`Deleted ${it.name}`, { undo: async () => { await api.post(`/api/lists/${current.id}/items`, { name: it.name, quantity: it.quantity }); await load(); } });
      return;
    }
    const row = e.target.closest('[data-item]');
    if (row) itemSheet(byId(row.dataset.item), lists, load);
  };

  await load();
}

function itemSheet(item, lists, onSaved) {
  const s = sheet({
    title: 'Item',
    render: () => html`<form class="form" novalidate><div class="group">
      ${fText('name', 'Item', item.name, { required: true, maxlength: 80 })}
      ${fText('quantity', 'Quantity', item.quantity || '', { placeholder: '2 L, 1 dozen…', maxlength: 30 })}
      ${lists.length > 1 ? fSelect('list_id', 'List', lists.map((l) => [l.id, l.name]), item.list_id, { data: 'data-int' }) : ''}
    </div>${item.added_by_name ? html`<p class="hint">Added by ${item.added_by_name}.</p>` : ''}
    <div class="group"><button type="button" class="row destructive" data-delete>Delete Item</button></div></form>`,
    onMount: (d) => { $('[data-delete]', d).onclick = async () => { await api.del(`/api/items/${item.id}`); s.close(); onSaved(); }; },
    onSubmit: async (v) => { await api.patch(`/api/items/${item.id}`, v); onSaved(); },
  });
}

function listSheet({ list = null, onSaved }) {
  const s = sheet({
    title: list ? 'Edit List' : 'New List', primary: list ? 'Save' : 'Create',
    render: () => html`<form class="form" novalidate><div class="group">${fText('name', '', list?.name || '', { placeholder: 'Hardware Store', required: true, maxlength: 40, autofocus: true, stack: true })}</div>
      ${list ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete List</button></div>` : ''}</form>`,
    onMount: (d) => {
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${list.name}”?`, message: 'All items on this list are deleted too.' }))) return;
        await api.del(`/api/lists/${list.id}`); invalidate('lists'); s.close(); onSaved(null);
      });
    },
    onSubmit: async (v) => {
      const l = list ? await api.patch(`/api/lists/${list.id}`, v) : await api.post('/api/lists', v);
      invalidate('lists');
      onSaved(l);
    },
  });
}

/** Used from Today: add to any list without leaving the screen. */
export async function addItemsSheet({ onSaved } = {}) {
  const lists = await getLists(true);
  if (!lists.length) { location.hash = '#/lists/shopping'; return; }
  sheet({
    title: 'Add to List', primary: 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">${fTextarea('name', 'Milk, eggs, bread — one per line or separated by commas', '', { rows: 4, label: 'Items' })}</div>
      ${lists.length > 1 ? html`<div class="group">${fSelect('list', 'List', lists.map((l) => [l.id, l.name]), lists[0].id)}</div>` : ''}
    </form>`,
    onMount: (d) => $('textarea', d).focus(),
    onSubmit: async (v) => {
      if (!v.name) throw Object.assign(new Error('Type at least one item.'), { field: 'name' });
      const id = v.list || lists[0].id;
      const added = await api.post(`/api/lists/${id}/items`, { name: v.name });
      toast(`Added ${plural(added.length, 'item')} to ${lists.find((l) => String(l.id) === String(id)).name}`);
      onSaved?.();
    },
  });
}

// ─────────── Meals ───────────
async function meals(v, body) {
  const weekStart = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    const dow = (d.getDay() - (S.household.week_starts || 0) + 7) % 7;
    return addDays(iso, -dow);
  };
  let start = weekStart(S.today);
  let data = [];

  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Plan a meal">${icon('plus')}</button>`, {
    '[data-add]': () => mealSheet({ date: S.today, onSaved: load }),
  });

  const load = async () => {
    data = await api.get(`/api/meals?from=${start}&days=6`);
    if (!v.alive()) return;
    render();
  };

  function render() {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const end = days[6];
    const label = `${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(end, { month: start.slice(5, 7) === end.slice(5, 7) ? undefined : 'short', day: 'numeric' })}`;
    body.innerHTML = String(html`
      <div class="month-switch">
        <button class="bar-btn icon-only" data-week="-7" aria-label="Previous week">${icon('chevron-left')}</button>
        <h2>${start === weekStart(S.today) ? 'This Week' : label}</h2>
        <button class="bar-btn icon-only" data-week="7" aria-label="Next week">${icon('chevron-right')}</button>
      </div>
      ${start !== weekStart(S.today) ? '' : html`<p class="section-foot meal-range">${label}</p>`}
      <div class="group">
        ${days.map((d) => {
          const ms = data.filter((m) => m.date === d);
          const dt = new Date(d + 'T12:00:00');
          return html`<div class="row meal-day-row">
            <div class="meal-date ${d === S.today ? 'today' : ''}"><span>${dt.toLocaleDateString(S.household.locale, { weekday: 'short' })}</span><b>${dt.getDate()}</b></div>
            <div class="body">
              ${ms.map((m) => html`<button class="meal-btn" data-meal="${m.id}"><span class="title">${m.title}</span><span class="sub">${m.slot === 'dinner' ? '' : m.slot[0].toUpperCase() + m.slot.slice(1)}${m.ingredients ? `${m.slot === 'dinner' ? '' : ' · '}${plural(m.ingredients.split('\n').filter(Boolean).length, 'ingredient')}` : ''}</span></button>`)}
              ${ms.length ? '' : html`<button class="meal-add" data-add-meal="${d}">${icon('plus', 'icon-sm')} Add a meal</button>`}
            </div>
          </div>`;
        })}
      </div>
      <p class="section-foot">Add ingredients to a meal, then send them to your shopping list in one tap.</p>`);
    $$('[data-week]', body).forEach((b) => b.addEventListener('click', () => { start = addDays(start, Number(b.dataset.week)); load(); }));
  }

  body.onclick = (e) => {
    const m = e.target.closest('[data-meal]');
    if (m) return mealSheet({ meal: data.find((x) => x.id === Number(m.dataset.meal)), onSaved: load });
    const a = e.target.closest('[data-add-meal]');
    if (a) mealSheet({ date: a.dataset.addMeal, onSaved: load });
  };
  await load();
}

async function mealSheet({ meal = null, date, onSaved }) {
  const lists = await getLists();
  const s = sheet({
    title: meal ? meal.title : 'Plan a Meal', primary: meal ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">
        ${fText('title', '', meal?.title || '', { placeholder: 'What’s cooking?', required: true, maxlength: 100, autofocus: !meal, stack: true })}
      </div>
      <div class="group">
        ${fDate('date', 'Day', meal?.date || date, { required: true })}
        ${fSelect('slot', 'Meal', [['dinner', 'Dinner'], ['lunch', 'Lunch'], ['breakfast', 'Breakfast']], meal?.slot || 'dinner')}
      </div>
      <div class="group-label">Ingredients</div>
      <div class="group">${fTextarea('ingredients', 'One per line', meal?.ingredients || '', { rows: 5, label: 'Ingredients' })}</div>
      <div class="group">${fTextarea('notes', 'Recipe link or notes', meal?.notes || '', { rows: 2, label: 'Notes' })}</div>
      ${meal && meal.ingredients && lists.length ? html`<button type="button" class="btn block" data-to-list>${icon('shopping-cart')} Add Ingredients to ${lists[0].name}</button><div class="section"></div>` : ''}
      ${meal ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete Meal</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $('[data-to-list]', d)?.addEventListener('click', async () => {
        const r = await api.post(`/api/meals/${meal.id}/to-list`, { list_id: lists[0].id });
        toast(r.added ? `Added ${plural(r.added, 'ingredient')} to ${lists[0].name}` : 'Everything is already on the list');
      });
      $('[data-delete]', d)?.addEventListener('click', async () => {
        await api.del(`/api/meals/${meal.id}`); s.close(); onSaved();
        toast(`Deleted ${meal.title}`, { undo: async () => { await api.post('/api/meals', { date: meal.date, slot: meal.slot, title: meal.title, ingredients: meal.ingredients, notes: meal.notes }); onSaved(); } });
      });
    },
    onSubmit: async (v) => {
      if (meal) await api.patch(`/api/meals/${meal.id}`, v); else await api.post('/api/meals', v);
      onSaved();
    },
  });
}

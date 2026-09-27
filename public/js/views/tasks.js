// Tasks & chores: Reminders-style quick add, smart sections, repeating tasks that roll forward.
import { api } from '../api.js';
import { html, icon, $, $$, S, relDay, relPhrase, fmtDate, sheet, toast, fText, fSelect, fDate, fTextarea, REPEAT_LABEL, initials, emptyState, enableSwipe, addDays } from '../ui.js';
import { getMembers } from '../store.js';

const AREAS = { chore: ['Chore', 'sparkles', 'blue'], maintenance: ['Maintenance', 'wrench', 'orange'], errand: ['Errand', 'car', 'green'], admin: ['Admin', 'file-text', 'indigo'], other: ['Other', 'tag', 'gray'] };

export function taskRow(t, today = S.today) {
  const done = !!t.done_at;
  const overdue = !done && t.due_date && t.due_date < today;
  const meta = [
    t.due_date ? html`<span class="${overdue ? 'text-neg' : ''}">${relDay(t.due_date, today)}</span>` : '',
    t.repeat !== 'none' ? html`<span>${icon('repeat', 'icon-sm')}</span>` : '',
  ].filter(Boolean);
  return html`<div class="swipe"><div class="row ${done ? 'done' : ''}">
      <button class="check" role="checkbox" aria-checked="${String(done)}" data-complete="${t.id}" aria-label="${done ? 'Mark not done' : 'Complete'}: ${t.title}"><span class="ring">${icon('check')}</span></button>
      <button class="body" data-task="${t.id}"><span class="title">${t.title}</span>
        ${meta.length || t.area !== 'chore' ? html`<span class="sub task-meta">${meta}${t.area !== 'chore' ? html`<span>${AREAS[t.area][0]}</span>` : ''}${t.repeat !== 'none' ? html`<span class="sr-only">${REPEAT_LABEL[t.repeat]}</span>` : ''}</span>` : ''}
      </button>
      ${t.assignee_name ? html`<span class="avatar" data-color="${t.assignee_color}" title="${t.assignee_name}" aria-label="Assigned to ${t.assignee_name}">${initials(t.assignee_name)}</span>` : ''}
    </div>
    <div class="swipe-actions"><button class="del" data-del-task="${t.id}">${icon('trash-2')}Delete</button></div>
  </div>`;
}

export async function completeTask(t, reload) {
  if (t.done_at) {
    await api.post(`/api/tasks/${t.id}/reopen`);
    reload?.();
    return;
  }
  const r = await api.post(`/api/tasks/${t.id}/complete`);
  reload?.();
  toast(r.rolled ? `Done · next due ${relPhrase(r.due_date)}` : `Done: ${t.title}`, {
    undo: async () => { await api.post(`/api/tasks/${t.id}/reopen`, r.rolled ? { due_date: r.previous_due } : {}); reload?.(); },
  });
}

export async function deleteTask(t, reload) {
  await api.del(`/api/tasks/${t.id}`);
  reload?.();
  toast(`Deleted “${t.title}”`, {
    undo: async () => {
      await api.post('/api/tasks', { title: t.title, notes: t.notes, due_date: t.due_date, repeat: t.repeat, area: t.area, assignee_id: t.assignee_id });
      reload?.();
    },
  });
}

export async function taskSheet({ task = null, onSaved, defaults = {} } = {}) {
  const members = await getMembers();
  const t = task || { repeat: 'none', area: 'chore', ...defaults };
  const s = sheet({
    title: task ? 'Task' : 'New Task', primary: task ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">
        ${fText('title', '', t.title || '', { placeholder: 'Title', required: true, maxlength: 120, autofocus: !task, stack: true })}
        ${fTextarea('notes', 'Notes', t.notes || '', { rows: 2 })}
      </div>
      <div class="group">
        ${fDate('due_date', 'Due', t.due_date)}
        ${fSelect('repeat', 'Repeat', Object.entries(REPEAT_LABEL), t.repeat)}
      </div>
      <div class="chips" role="group" aria-label="Quick dates">
        ${[['Today', 0], ['Tomorrow', 1], ['This Weekend', weekendOffset()], ['Next Week', 7]].map(([l, n]) => html`<button type="button" class="chip" data-when="${n}">${l}</button>`)}
      </div>
      <div class="group">
        ${fSelect('area', 'Type', Object.entries(AREAS).map(([k, a]) => [k, a[0]]), t.area)}
        ${members.length > 1 ? fSelect('assignee_id', 'Assigned To', [['', 'Anyone'], ...members.map((m) => [m.id, m.name])], t.assignee_id ?? '', { data: 'data-int' }) : ''}
      </div>
      ${t.last_done_at && t.repeat !== 'none' ? html`<p class="hint">Last done ${fmtDate(t.last_done_at.slice(0, 10), { month: 'long', day: 'numeric' })}.</p>` : ''}
      ${task ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete Task</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $$('[data-when]', d).forEach((b) => b.addEventListener('click', () => { $('[name=due_date]', d).value = addDays(S.today, Number(b.dataset.when)); }));
      $('[data-delete]', d)?.addEventListener('click', async () => { s.close(); await deleteTask(task, onSaved); });
    },
    onSubmit: async (v) => {
      if (task) await api.patch(`/api/tasks/${task.id}`, v); else await api.post('/api/tasks', v);
      onSaved?.();
    },
  });
}

function weekendOffset() {
  const dow = new Date(S.today + 'T12:00:00').getDay();
  return dow === 6 ? 0 : dow === 0 ? 0 : 6 - dow;
}

// ─────────── Tasks screen ───────────
export async function mount(v) {
  let filter = 'all';
  let tasks = [];
  const members = await getMembers();
  const load = async () => {
    tasks = await api.get('/api/tasks');
    if (!v.alive()) return;
    render();
    v.refreshBadges();
  };

  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="New task">${icon('plus')}</button>`, {
    '[data-add]': () => taskSheet({ onSaved: load }),
  });

  function bucket(t) {
    if (t.done_at) return 'done';
    if (!t.due_date) return 'someday';
    const d = t.due_date;
    if (d < S.today) return 'overdue';
    if (d === S.today) return 'today';
    if (d === addDays(S.today, 1)) return 'tomorrow';
    if (d <= addDays(S.today, 7)) return 'week';
    return 'later';
  }
  const SECTIONS = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 Days'], ['later', 'Later'], ['someday', 'No Date'], ['done', 'Recently Done']];

  function render() {
    const visible = tasks.filter((t) => filter === 'all' || (filter === 'mine' ? t.assignee_id === S.user.id : t.area === filter));
    const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
    visible.forEach((t) => groups[bucket(t)].push(t));
    const openCount = visible.filter((t) => !t.done_at).length;
    const chips = [['all', 'All'], ...(members.length > 1 ? [['mine', 'Mine']] : []), ['chore', 'Chores'], ['maintenance', 'Maintenance'], ['errand', 'Errands'], ['admin', 'Admin']];

    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Tasks</h1><p>${openCount ? `${openCount} to do` : 'Nothing to do'}</p></div>
      <div class="chips" role="group" aria-label="Filter">${chips.map(([k, l]) => html`<button class="chip" data-filter="${k}" aria-pressed="${String(filter === k)}">${l}</button>`)}</div>
      <form class="group quick-add-form" data-quick>
        <label class="quick-add">${icon('circle-plus')}<input name="title" placeholder="New task — press Return to add" maxlength="120" autocomplete="off" aria-label="New task"></label>
      </form>
      <div class="section"></div>
      ${visible.length ? SECTIONS.filter(([k]) => groups[k].length).map(([k, label]) => html`
        <section class="section">
          <div class="section-head"><h2 class="${k === 'overdue' ? 'text-neg' : ''}">${label}</h2><span class="caps">${groups[k].length}</span></div>
          <div class="group">${groups[k].map((t) => taskRow(t))}</div>
        </section>`)
        : html`<div class="group">${emptyState('list-checks', filter === 'all' ? 'No tasks yet' : 'Nothing here', 'Add chores, home maintenance and errands. Repeating tasks come back on their own.')}</div>`}
      <p class="section-foot">Tip: repeating tasks like “Replace furnace filter” move to their next date when you tick them off.</p>`);

    const el = v.el;
    $$('[data-filter]', el).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
    const qf = $('[data-quick]', el);
    qf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = qf.elements.title;
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      const area = ['chore', 'maintenance', 'errand', 'admin'].includes(filter) ? filter : 'chore';
      try {
        await api.post('/api/tasks', { title, area, ...(filter === 'mine' ? { assignee_id: S.user.id } : {}) });
        await load();
        $('[data-quick] input', v.el)?.focus();
      } catch (err) { toast(err.message, { error: true }); input.value = title; }
    });
    el.onclick = async (e) => {
      const byId = (id) => tasks.find((t) => t.id === Number(id));
      const c = e.target.closest('[data-complete]');
      if (c) return completeTask(byId(c.dataset.complete), load);
      const d = e.target.closest('[data-del-task]');
      if (d) return deleteTask(byId(d.dataset.delTask), load);
      const t = e.target.closest('[data-task]');
      if (t) taskSheet({ task: byId(t.dataset.task), onSaved: load });
    };
  }

  await load();
  enableSwipe(v.el);
}

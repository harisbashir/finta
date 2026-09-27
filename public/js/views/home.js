// Home: the things you own (with warranties) and the people who help keep the house running.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, fmtDate, relDay, relPhrase, sheet, toast, confirmDialog, fText, fMoney, fDate, fTextarea, segmented, emptyState, daysBetween, plural } from '../ui.js';

export async function mount(v) {
  const tab = v.params[0] === 'contacts' ? 'contacts' : 'things';
  v.el.innerHTML = String(html`<div class="large-title"><h1>Home</h1></div>
    ${segmented([['things', 'Things'], ['contacts', 'Contacts']], tab)}<div id="home-body"></div>`);
  $$('[data-seg]', v.el).forEach((b) => b.addEventListener('click', () => v.go(`#/home/${b.dataset.seg}`)));
  const body = $('#home-body', v.el);
  if (tab === 'contacts') await contacts(v, body); else await things(v, body);
}

// ─────────── Things ───────────
function warrantyPill(a) {
  if (!a.warranty_until) return '';
  const d = daysBetween(S.today, a.warranty_until);
  if (d < 0) return html`<span class="pill">Warranty ended</span>`;
  if (d <= 45) return html`<span class="pill warn">${icon('clock')}Warranty ends ${relPhrase(a.warranty_until)}</span>`;
  return html`<span class="pill pos">${icon('shield-check')}Covered to ${fmtDate(a.warranty_until, { month: 'short', year: 'numeric' })}</span>`;
}

async function things(v, body) {
  let items = [];
  const load = async () => { items = await api.get('/api/assets'); if (v.alive()) render(); };
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add a thing">${icon('plus')}</button>`, { '[data-add]': () => assetSheet({ onSaved: load }) });

  function render() {
    const rooms = new Map();
    for (const a of items) { const r = a.room || 'Other'; if (!rooms.has(r)) rooms.set(r, []); rooms.get(r).push(a); }
    const total = items.reduce((s, a) => s + (a.price || 0), 0);
    body.innerHTML = String(items.length ? html`
      ${[...rooms.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b)).map((room) => html`
        <section class="section"><div class="section-head"><h2>${room}</h2><span class="caps">${rooms.get(room).length}</span></div>
          <div class="group">${rooms.get(room).map((a) => html`<button class="row" data-asset="${a.id}">
            <span class="body"><span class="title">${a.name}</span><span class="sub">${[a.brand, a.model].filter(Boolean).join(' ') || (a.purchase_date ? `Bought ${fmtDate(a.purchase_date, { month: 'short', year: 'numeric' })}` : '')}</span></span>
            <span class="trail">${warrantyPill(a)}${icon('chevron-right', 'chev')}</span></button>`)}</div></section>`)}
      ${total ? html`<p class="section-foot">${plural(items.length, 'thing')} worth about ${money(total, { short: true })} — handy for insurance claims.</p>` : ''}`
      : html`<div class="group">${emptyState('package', 'Keep track of your things', 'Appliances, electronics, furniture: model and serial numbers, what you paid, and when the warranty ends.', html`<button class="btn prominent small" data-first>${icon('plus')} Add Something</button>`)}</div>`);
    $('[data-first]', body)?.addEventListener('click', () => assetSheet({ onSaved: load }));
  }
  body.onclick = (e) => { const r = e.target.closest('[data-asset]'); if (r) assetSheet({ asset: items.find((a) => a.id === Number(r.dataset.asset)), onSaved: load }); };
  await load();
}

function assetSheet({ asset = null, onSaved }) {
  const s = sheet({
    title: asset ? asset.name : 'New Thing', primary: asset ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">
        ${fText('name', 'Name', asset?.name || '', { placeholder: 'Dishwasher', required: true, maxlength: 80, autofocus: !asset })}
        ${fText('room', 'Room', asset?.room || '', { placeholder: 'Kitchen', maxlength: 40 })}
      </div>
      <div class="group">
        ${fText('brand', 'Brand', asset?.brand || '', { placeholder: 'Optional', maxlength: 60 })}
        ${fText('model', 'Model', asset?.model || '', { placeholder: 'Optional', maxlength: 80 })}
        ${fText('serial', 'Serial Number', asset?.serial || '', { placeholder: 'Optional', maxlength: 80 })}
      </div>
      <div class="group">
        ${fDate('purchase_date', 'Bought On', asset?.purchase_date)}
        ${fMoney('price', 'Price', asset?.price, { placeholder: '0' })}
        ${fDate('warranty_until', 'Warranty Until', asset?.warranty_until)}
      </div>
      <p class="hint">Finta reminds you on Today when a warranty is about to end.</p>
      <div class="group">${fTextarea('notes', 'Notes — where the manual is, filter size…', asset?.notes || '', { rows: 3 })}</div>
      ${asset ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${asset.name}”?` }))) return;
        await api.del(`/api/assets/${asset.id}`); s.close(); onSaved(); toast(`Deleted ${asset.name}`);
      });
    },
    onSubmit: async (v) => { if (asset) await api.patch(`/api/assets/${asset.id}`, v); else await api.post('/api/assets', v); onSaved(); },
  });
}

// ─────────── Contacts ───────────
async function contacts(v, body) {
  let list = [];
  const load = async () => { list = await api.get('/api/contacts'); if (v.alive()) render(); };
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="Add a contact">${icon('plus')}</button>`, { '[data-add]': () => contactSheet({ onSaved: load }) });
  const tel = (p) => 'tel:' + String(p).replace(/[^\d+]/g, '');
  function render() {
    body.innerHTML = String(list.length ? html`<div class="group">${list.map((c) => html`<div class="row">
        <button class="body" data-contact="${c.id}"><span class="title">${c.name}</span>${c.role ? html`<span class="sub">${c.role}</span>` : ''}</button>
        <span class="trail">
          ${c.phone ? html`<a class="bar-btn icon-only" href="${tel(c.phone)}" aria-label="Call ${c.name}">${icon('phone')}</a>` : ''}
          ${c.email ? html`<a class="bar-btn icon-only" href="mailto:${c.email}" aria-label="Email ${c.name}">${icon('mail')}</a>` : ''}
        </span></div>`)}</div>
      <p class="section-foot">Everyone in your household sees these — no more hunting for the plumber’s number.</p>`
      : html`<div class="group">${emptyState('users', 'No contacts yet', 'Plumber, electrician, babysitter, landlord — the people your household calls.', html`<button class="btn prominent small" data-first>${icon('plus')} Add a Contact</button>`)}</div>`);
    $('[data-first]', body)?.addEventListener('click', () => contactSheet({ onSaved: load }));
  }
  body.onclick = (e) => { const r = e.target.closest('[data-contact]'); if (r) contactSheet({ contact: list.find((c) => c.id === Number(r.dataset.contact)), onSaved: load }); };
  await load();
}

function contactSheet({ contact = null, onSaved }) {
  const s = sheet({
    title: contact ? contact.name : 'New Contact', primary: contact ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">
        ${fText('name', 'Name', contact?.name || '', { placeholder: 'Name or business', required: true, maxlength: 80, autofocus: !contact })}
        ${fText('role', 'Role', contact?.role || '', { placeholder: 'Plumber', maxlength: 60 })}
        ${fText('phone', 'Phone', contact?.phone || '', { type: 'tel', placeholder: 'Optional', maxlength: 40, autocomplete: 'tel' })}
        ${fText('email', 'Email', contact?.email || '', { type: 'email', placeholder: 'Optional', maxlength: 254 })}
      </div>
      <div class="group">${fTextarea('notes', 'Notes — rates, account number, who to ask for…', contact?.notes || '', { rows: 3 })}</div>
      ${contact ? html`<div class="group"><button type="button" class="row destructive" data-delete>Delete Contact</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete ${contact.name}?` }))) return;
        await api.del(`/api/contacts/${contact.id}`); s.close(); onSaved();
      });
    },
    onSubmit: async (v) => { if (contact) await api.patch(`/api/contacts/${contact.id}`, v); else await api.post('/api/contacts', v); onSaved(); },
  });
}

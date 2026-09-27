// UI toolkit: safe templating, formatting, sheets, alerts, toasts, swipe actions, form fields.
import { ICONS } from './icons.js';

// ─────────── Safe HTML templating ───────────
// Every interpolated value is escaped unless it was itself produced by html``/raw().
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += esc(vals[i]) + strings[i + 1];
  return new Safe(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function icon(name, cls = '') {
  const inner = ICONS[name] || ICONS.tag;
  return raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}

// ─────────── Formatting ───────────
export const S = { household: null, user: null, today: null };

const nfCache = new Map();
function nf(opts) {
  const key = JSON.stringify(opts) + (S.household?.locale || '') + (S.household?.currency || '');
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(S.household?.locale || 'en-CA', { style: 'currency', currency: S.household?.currency || 'CAD', ...opts }));
  return nfCache.get(key);
}
/** cents → "$1,234.56" (drops .00 when `short`) */
export function money(cents, { short = false, sign = false } = {}) {
  const v = (cents || 0) / 100;
  const whole = Number.isInteger(v);
  const s = nf(short && whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}).format(Math.abs(v));
  if (v < 0) return '−' + s;
  return sign && v > 0 ? '+' + s : s;
}
export function currencySymbol() {
  return nf({}).formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
}
/** "12.3", "1,200", "$45" → cents; '' → null; invalid → NaN */
export function parseMoney(str) {
  if (str == null) return null;
  const s = String(str).replace(/[^\d.,-]/g, '').trim();
  if (!s) return null;
  // Treat the last , or . followed by 1–2 digits as the decimal separator.
  const m = s.match(/^(.*?)[.,](\d{1,2})$/);
  const whole = (m ? m[1] : s).replace(/[.,]/g, '');
  const frac = m ? m[2].padEnd(2, '0') : '00';
  const n = Number(whole || 0) * 100 + Number(frac);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}
export const centsToInput = (c) => (c == null ? '' : (c / 100).toFixed(2).replace(/\.00$/, ''));

const dateObj = (iso) => new Date(iso + 'T12:00:00');
const locale = () => S.household?.locale || navigator.language || 'en-CA';
export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return dateObj(iso).toLocaleDateString(locale(), opts);
}
export const fmtLong = (iso) => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtMonth = (ym) => fmtDate(ym + '-01', { month: 'long', year: 'numeric' });
export function daysBetween(a, b) { return Math.round((dateObj(b) - dateObj(a)) / 86400000); }
export function addDays(iso, n) { const d = dateObj(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
export function addMonthsYM(ym, n) { const [y, m] = ym.split('-').map(Number); const i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`; }
/** "Today", "Tomorrow", "2 days ago", "Fri", "Oct 4" */
export function relDay(iso, today = S.today) {
  if (!iso) return '';
  const d = daysBetween(today, iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d < -1 && d > -7) return `${-d} days ago`;
  if (d > 1 && d < 7) return fmtDate(iso, { weekday: 'long' });
  return fmtDate(iso, { month: 'short', day: 'numeric', ...(iso.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
}
/** Mid-sentence form: "today", "tomorrow", "on Tuesday", "on Oct 22" */
export function relPhrase(iso, today = S.today) {
  const d = daysBetween(today, iso);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 1 && d < 7) return 'on ' + fmtDate(iso, { weekday: 'long' });
  return 'on ' + fmtDate(iso, { month: 'short', day: 'numeric' });
}
export const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };
export const FREQ_SHORT = { weekly: '/wk', biweekly: '/2 wk', semimonthly: '/half-mo', monthly: '/mo', quarterly: '/qtr', yearly: '/yr' };
export const REPEAT_LABEL = { none: 'Never', daily: 'Every day', weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };
export const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ─────────── Toasts ───────────
let toastTimer;
export function toast(message, { undo, error = false, duration = 5000 } = {}) {
  let host = $('.toast-host');
  if (!host) { host = document.createElement('div'); host.className = 'toast-host'; host.setAttribute('aria-live', 'polite'); document.body.append(host); }
  host.innerHTML = String(html`<div class="toast ${error ? 'error' : ''}" role="status">
    ${error ? icon('circle-alert') : ''}<span>${message}</span>${undo ? html`<button class="btn small prominent" data-undo>Undo</button>` : ''}</div>`);
  const el = host.firstElementChild;
  if (undo) el.querySelector('[data-undo]').onclick = async () => { host.innerHTML = ''; await undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (host.firstElementChild === el) host.innerHTML = ''; }, duration);
}

// ─────────── Alerts ───────────
export function confirmDialog({ title, message = '', confirm = 'Delete', destructive = true, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'alert';
    d.setAttribute('aria-labelledby', 'alert-title');
    d.innerHTML = String(html`<div class="alert-body"><h2 id="alert-title">${title}</h2>${message ? html`<p>${message}</p>` : ''}</div>
      <div class="alert-actions"><button class="btn" value="cancel" autofocus>${cancel}</button>
      <button class="btn ${destructive ? 'destructive' : 'prominent'}" value="ok">${confirm}</button></div>`);
    document.body.append(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    d.querySelectorAll('button').forEach((b) => { b.onclick = () => done(b.value === 'ok'); });
    d.showModal();
  });
}

// ─────────── Sheets ───────────
let openSheetEl = null;

/**
 * Present a sheet. `render()` returns the body; `onSubmit(values, api)` handles the primary action.
 * Only one sheet at a time (sheets.md › Best practices): opening a new one closes the current.
 */
export function sheet({ title, render, primary = 'Save', onSubmit, onMount, cancel = 'Cancel', dismissOnly = false }) {
  if (openSheetEl) closeSheet(openSheetEl, true);
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.setAttribute('aria-label', title);
  let dirty = false;
  const api = {
    el: d,
    close: () => closeSheet(d),
    rerender: () => { $('.sheet-body', d).innerHTML = String(render(api)); dirty = false; onMount?.(d, api); },
    setTitle: (t) => { $('.sheet-head h2', d).textContent = t; },
    markClean: () => { dirty = false; },
  };
  d.innerHTML = String(html`
    <div class="sheet-grabber" aria-hidden="true"></div>
    <header class="sheet-head">
      <div class="lead"><button class="btn plain" data-sheet-cancel type="button">${dismissOnly ? 'Done' : cancel}</button></div>
      <h2>${title}</h2>
      <div class="trail">${!dismissOnly && onSubmit ? html`<button class="btn small prominent" data-sheet-primary type="button">${primary}</button>` : ''}</div>
    </header>
    <div class="sheet-body">${render(api)}</div>`);
  document.body.append(d);
  openSheetEl = d;

  const tryClose = async () => {
    if (dirty && !dismissOnly) {
      const ok = await confirmDialog({ title: 'Discard changes?', confirm: 'Discard', cancel: 'Keep Editing' });
      if (!ok) return;
    }
    closeSheet(d);
  };
  const submit = async () => {
    const btn = $('[data-sheet-primary]', d);
    const form = $('form', d);
    if (form && !form.reportValidity()) return;
    btn?.setAttribute('aria-busy', 'true');
    clearErrors(d);
    try {
      const values = form ? readForm(form) : {};
      const keepOpen = await onSubmit(values, api);
      if (keepOpen !== true) closeSheet(d);
    } catch (err) {
      showError(d, err);
    } finally {
      btn?.removeAttribute('aria-busy');
    }
  };
  d.addEventListener('input', () => { dirty = true; });
  d.addEventListener('cancel', (e) => { e.preventDefault(); tryClose(); });
  d.addEventListener('click', (e) => { if (e.target === d) tryClose(); });   // backdrop
  $('[data-sheet-cancel]', d).onclick = tryClose;
  $('[data-sheet-primary]', d)?.addEventListener('click', submit);
  d.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  enableDragToDismiss(d, tryClose);
  d.showModal();
  onMount?.(d, api);
  const first = $('[autofocus]', d);
  if (first && matchMedia('(pointer: fine)').matches) first.focus();
  return api;
}

function closeSheet(d, instant = false) {
  if (!d.isConnected) return;
  if (openSheetEl === d) openSheetEl = null;
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); d.remove(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.close(); d.remove(); }, 200);
}

function enableDragToDismiss(d, onDismiss) {
  let startY = null, dy = 0;
  const handles = [$('.sheet-grabber', d), $('.sheet-head', d)];
  const move = (e) => { if (startY == null) return; dy = Math.max(0, e.clientY - startY); d.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (startY == null) return;
    startY = null;
    d.style.transition = 'transform 250ms var(--ease)';
    if (dy > 110) { d.style.transform = ''; onDismiss(); } else d.style.transform = '';
    setTimeout(() => { d.style.transition = ''; }, 260);
    window.removeEventListener('pointermove', move);
  };
  for (const h of handles) {
    h.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || innerWidth >= 700) return;
      startY = e.clientY; dy = 0;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', end, { once: true });
    });
  }
}

export function clearErrors(root) {
  $$('.field.invalid', root).forEach((f) => f.classList.remove('invalid'));
  $$('.field-error, .form-error', root).forEach((e) => e.remove());
}

export function showError(root, err) {
  const msg = err?.message || 'Something went wrong. Try again.';
  const field = err?.field && root.querySelector(`[name="${CSS.escape(err.field)}"]`);
  if (field) {
    const row = field.closest('.field, .toggle-row, .amount-entry') || field;
    row.classList.add('invalid');
    const box = row.closest('.group') || row;
    box.insertAdjacentHTML('afterend', String(html`<div class="field-error" role="alert">${msg}</div>`));
    field.focus?.();
  } else {
    const body = $('.sheet-body', root) || root.querySelector('form') || root;
    body.insertAdjacentHTML('afterbegin', String(html`<div class="form-error" role="alert">${icon('circle-alert')}<span>${msg}</span></div>`));
    body.scrollTop = 0;
  }
}

// ─────────── Form fields ───────────
const id = (() => { let n = 0; return (p) => `${p}-${++n}`; })();

export function fText(name, label, value = '', { placeholder = '', type = 'text', required = false, autocomplete = 'off', inputmode = '', maxlength = 200, autofocus = false, stack = false } = {}) {
  const i = id(name);
  return html`<div class="field ${stack ? 'stack' : ''}">
    ${label ? html`<label for="${i}">${label}</label>` : ''}
    <input id="${i}" name="${name}" type="${type}" value="${value ?? ''}" placeholder="${placeholder}" ${required ? raw('required') : ''}
      autocomplete="${autocomplete}" ${inputmode ? raw(`inputmode="${inputmode}"`) : ''} maxlength="${maxlength}" ${autofocus ? raw('autofocus') : ''}
      ${!label ? raw(`aria-label="${esc(placeholder)}"`) : ''}>
  </div>`;
}

export function fMoney(name, label, cents, { placeholder = '0.00', required = false } = {}) {
  const i = id(name);
  return html`<div class="field">
    <label for="${i}">${label}</label>
    <input id="${i}" name="${name}" data-money inputmode="decimal" value="${centsToInput(cents)}" placeholder="${currencySymbol()}${placeholder}" ${required ? raw('required') : ''} autocomplete="off">
  </div>`;
}

export function fNumber(name, label, value, { placeholder = '', step = 'any', min = '', max = '', suffix = '' } = {}) {
  const i = id(name);
  return html`<div class="field">
    <label for="${i}">${label}</label>
    <input id="${i}" name="${name}" data-number type="text" inputmode="decimal" value="${value ?? ''}" placeholder="${placeholder}" autocomplete="off">
    ${suffix ? html`<span class="prefix">${suffix}</span>` : ''}
  </div>`;
}

export function fSelect(name, label, options, value, { data = '' } = {}) {
  const i = id(name);
  return html`<div class="field">
    <label for="${i}">${label}</label>
    <span class="select-wrap"><select id="${i}" name="${name}" ${data ? raw(data) : ''}>
      ${options.map(([v, l]) => html`<option value="${v ?? ''}" ${String(v ?? '') === String(value ?? '') ? raw('selected') : ''}>${l}</option>`)}
    </select>${icon('chevrons-up-down')}</span>
  </div>`;
}

export function fDate(name, label, value, { required = false } = {}) {
  const i = id(name);
  return html`<div class="field"><label for="${i}">${label}</label>
    <input id="${i}" name="${name}" type="date" value="${value || ''}" ${required ? raw('required') : ''}></div>`;
}

export function fToggle(name, label, checked, sub = '') {
  const i = id(name);
  return html`<div class="toggle-row"><label for="${i}"><span>${label}</span>${sub ? html`<span class="sub">${sub}</span>` : ''}</label>
    <span class="switch"><input type="checkbox" role="switch" id="${i}" name="${name}" ${checked ? raw('checked') : ''}><span></span></span></div>`;
}

export function fTextarea(name, placeholder, value = '', { rows = 3, maxlength = 2000, label = '' } = {}) {
  const i = id(name);
  return html`<div class="field stack">${label ? html`<label for="${i}" class="sr-only">${label}</label>` : ''}
    <textarea id="${i}" name="${name}" rows="${rows}" placeholder="${placeholder}" maxlength="${maxlength}" ${!label ? raw(`aria-label="${esc(placeholder)}"`) : ''}>${value || ''}</textarea></div>`;
}

/** Collect a form's values: money → cents, toggles → booleans, empty → null. */
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    if (el.dataset.money !== undefined) {
      const c = parseMoney(el.value);
      if (Number.isNaN(c)) throw Object.assign(new Error('Enter an amount like 12.50'), { field: el.name });
      out[el.name] = c; continue;
    }
    if (el.dataset.number !== undefined) {
      const v = el.value.trim().replace(',', '.');
      if (v === '') { out[el.name] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) throw Object.assign(new Error('Enter a number.'), { field: el.name });
      out[el.name] = n; continue;
    }
    if (el.dataset.int !== undefined) { out[el.name] = el.value === '' ? null : Number(el.value); continue; }
    out[el.name] = el.value.trim() === '' ? null : el.value;
  }
  return out;
}

// ─────────── Swipe actions on list rows ───────────
// Markup: <div class="swipe"><div class="row">…</div><div class="swipe-actions">…buttons…</div></div>
export function enableSwipe(root) {
  let active = null;
  root.addEventListener('pointerdown', (e) => {
    const wrap = e.target.closest('.swipe');
    if (active && active !== wrap) { close(active); }
    if (!wrap || e.pointerType === 'mouse' || e.target.closest('.swipe-actions')) return;
    const row = wrap.firstElementChild;
    const width = wrap.querySelector('.swipe-actions').offsetWidth;
    const startX = e.clientX, startY = e.clientY;
    const base = wrap.classList.contains('open') ? -width : 0;
    let dx = 0, decided = false, horizontal = false;
    const move = (ev) => {
      const mx = ev.clientX - startX, my = ev.clientY - startY;
      if (!decided && Math.hypot(mx, my) > 8) { decided = true; horizontal = Math.abs(mx) > Math.abs(my); if (horizontal) wrap.classList.add('dragging'); }
      if (!horizontal) return;
      dx = Math.min(0, Math.max(-width - 30, base + mx));
      row.style.transform = `translateX(${dx}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      wrap.classList.remove('dragging');
      if (!horizontal) return;
      const open = dx < -width / 2;
      row.style.transform = open ? `translateX(${-width}px)` : '';
      wrap.classList.toggle('open', open);
      active = open ? wrap : null;
      // swallow the click that follows a drag
      if (Math.abs(dx - base) > 6) wrap.addEventListener('click', (c) => { c.stopPropagation(); c.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
  function close(w) { w.classList.remove('open'); w.firstElementChild.style.transform = ''; active = null; }
  root.addEventListener('click', (e) => { if (active && e.target.closest('.swipe-actions')) setTimeout(() => active && close(active), 50); });
}

/** CSP forbids style attributes, so sizes travel as data-* and are applied here. */
export function hydrate(root) {
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`; });
  root.querySelectorAll('[data-grow]').forEach((el) => { el.style.flexGrow = el.dataset.grow; el.style.flexBasis = '0'; });
}

export function emptyState(iconName, title, text, action = '') {
  return html`<div class="empty">${icon(iconName)}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action}</div>`;
}

export function segmented(items, current, attr = 'data-seg') {
  return html`<div class="segmented" role="tablist">${items.map(([v, l]) => html`<button role="tab" ${raw(attr)}="${v}" aria-selected="${String(v === current)}">${l}</button>`)}</div>`;
}

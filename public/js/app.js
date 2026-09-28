// App shell: bootstrap, hash routing, sidebar (regular width) / tab bar (compact width).
import { api, setUnauthorizedHandler } from './api.js';
import { html, icon, $, S, initials, toast, applyTheme } from './ui.js';
import { renderAuth } from './views/auth.js';

const SECTIONS = [
  { id: 'today', label: 'Today', icon: 'sun', load: () => import('./views/today.js') },
  { id: 'money', label: 'Money', icon: 'wallet', load: () => import('./views/money.js') },
  { id: 'tasks', label: 'Tasks', icon: 'list-checks', load: () => import('./views/tasks.js') },
  { id: 'lists', label: 'Lists', icon: 'shopping-basket', load: () => import('./views/lists.js') },
  { id: 'home', label: 'Home', icon: 'house', load: () => import('./views/home.js') },
];
const SETTINGS = { id: 'settings', label: 'Settings', icon: 'settings', load: () => import('./views/settings.js') };

const root = document.getElementById('root');
let shellReady = false;
let navToken = 0;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { section: parts[0] || 'today', rest: parts.slice(1) };
}

async function boot() {
  let info;
  try { info = await api.get('/api/bootstrap'); }
  catch (e) { root.innerHTML = String(html`<div class="auth"><div class="auth-card empty">${icon('circle-alert')}<h3>Can’t reach Finta</h3><p>${e.message}</p><button class="btn prominent" id="reload">Try Again</button></div></div>`); $('#reload').onclick = () => location.reload(); return; }
  S.user = info.user; S.household = info.household;
  S.today = info.today || new Date().toLocaleDateString('en-CA');
  S.version = info.version;
  if (info.user) applyTheme(info.user.theme);
  const { section, rest } = parseHash();
  if (!info.user) {
    shellReady = false;
    renderAuth(root, { mode: info.needsSetup ? 'setup' : section === 'join' ? 'join' : 'signin', token: rest[0], allowSignup: info.allowSignup, onDone: () => { location.hash = '#/today'; boot(); } });
    return;
  }
  if (section === 'join') { location.hash = '#/today'; }
  renderShell();
  navigate();
}

function renderShell() {
  const h = S.household;
  root.innerHTML = String(html`
  <div class="app">
    <nav class="sidebar" aria-label="Sections"><div class="sidebar-inner">
      <div class="brand"><img src="/icon.svg" alt=""><div><strong>Finta</strong><span>${h.name}</span></div></div>
      ${SECTIONS.map((s) => html`<a class="side-link" href="#/${s.id}" data-nav="${s.id}">${icon(s.icon)}<span>${s.label}</span><span class="badge" data-badge="${s.id}" hidden></span></a>`)}
      <div class="side-sep" role="separator"></div>
      <a class="side-link" href="#/settings" data-nav="settings">${icon('settings')}<span>Settings</span></a>
      <div class="side-foot"><a class="side-link" href="#/settings" aria-label="Your account"><span class="avatar sm" data-color="${S.user.color}">${initials(S.user.name)}</span><span>${S.user.name}</span></a></div>
    </div></nav>
    <main class="main" id="main">
      <header class="navbar" id="navbar"><div class="lead" id="nav-lead"></div><span class="inline-title" id="nav-title" aria-hidden="true"></span><div class="trail" id="nav-trail"></div></header>
      <div class="page" id="page"></div>
    </main>
    <nav class="tabbar" aria-label="Sections">
      ${SECTIONS.map((s) => html`<a class="tab" href="#/${s.id}" data-nav="${s.id}">${icon(s.icon)}<span>${s.label}</span><span class="badge" data-badge="${s.id}" hidden></span></a>`)}
    </nav>
  </div>`);
  shellReady = true;
  const navbar = $('#navbar');
  const onScroll = () => {
    navbar.classList.toggle('scrolled', scrollY > 6);
  };
  window.removeEventListener('scroll', window.__fintaScroll || (() => {}));
  window.__fintaScroll = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
}

async function navigate() {
  if (!S.user) return;
  if (!shellReady) renderShell();
  const { section, rest } = parseHash();
  const def = [...SECTIONS, SETTINGS].find((s) => s.id === section) || SECTIONS[0];
  document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === def.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });

  // A sheet belongs to the screen that opened it.
  document.querySelectorAll('dialog[open]').forEach((d) => { d.close(); d.remove(); });
  const token = ++navToken;
  const old = $('#page');
  const page = document.createElement('div');
  page.className = 'page';
  page.id = 'page';
  page.innerHTML = '<div class="skeleton-title"></div><div class="skeleton"></div><div class="skeleton short"></div>';
  old.replaceWith(page);
  const trail = $('#nav-trail'); const lead = $('#nav-lead');
  trail.innerHTML = ''; lead.innerHTML = '';
  $('#nav-title').textContent = def.label;
  document.title = `${def.label} · Finta`;
  if (!location.hash.startsWith('#/' + def.id + '/')) scrollTo(0, 0);

  const view = {
    el: page, params: rest, section: def.id,
    alive: () => token === navToken,
    setTitle: (t) => { $('#nav-title').textContent = t; document.title = `${t} · Finta`; },
    setToolbar: (markup, handlers = {}) => {
      trail.innerHTML = String(markup);
      for (const [sel, fn] of Object.entries(handlers)) trail.querySelector(sel)?.addEventListener('click', fn);
    },
    setLead: (markup, handlers = {}) => {
      lead.innerHTML = String(markup);
      for (const [sel, fn] of Object.entries(handlers)) lead.querySelector(sel)?.addEventListener('click', fn);
    },
    go: (hash) => { location.hash = hash; },
    refreshBadges,
  };
  try {
    const mod = await def.load();
    if (token !== navToken) return;
    await mod.mount(view);
    if (def.id !== 'settings' && !trail.querySelector('[data-settings]')) {
      trail.insertAdjacentHTML('beforeend', String(html`<a class="bar-btn icon-only hide-regular" href="#/settings" data-settings aria-label="Settings"><span class="avatar nav-avatar" data-color="${S.user.color}">${initials(S.user.name)}</span></a>`));
    }
  } catch (e) {
    if (token !== navToken) return;
    console.error(e);
    page.innerHTML = String(html`<div class="empty page-error">${icon('circle-alert')}<h3>This page didn’t load</h3><p>${e.message}</p><button class="btn prominent" id="retry">Try Again</button></div>`);
    $('#retry', page).onclick = navigate;
  }
  refreshBadges();
}

let badgeTimer;
export function refreshBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const t = await api.get('/api/today');
      const overdueBills = t.bills.filter((b) => b.overdue && !b.autopay).length;
      const dueTasks = t.tasks.filter((x) => x.due_date <= t.today).length;
      setBadge('money', overdueBills, `${overdueBills} overdue`);
      setBadge('tasks', dueTasks, `${dueTasks} due`);
    } catch { /* badges are best-effort */ }
  }, 300);
}
function setBadge(id, n, label) {
  document.querySelectorAll(`[data-badge="${id}"]`).forEach((b) => {
    b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); b.setAttribute('aria-label', label);
  });
}

setUnauthorizedHandler(() => {
  if (!S.user) return;
  S.user = null;
  toast('You were signed out. Please sign in again.');
  boot();
});

window.addEventListener('hashchange', () => { if (S.user) navigate(); else boot(); });
boot();

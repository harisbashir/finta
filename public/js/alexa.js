// Alexa sync status, shared by Lists, Tasks and Settings.
import { api } from './api.js';
import { html, icon, fmtDate, relDay, S } from './ui.js';

/** "just now", "3 min ago", "2 hr ago", "Oct 5" — from SQLite's UTC "YYYY-MM-DD HH:MM:SS". */
export function ago(sqlUtc) {
  if (!sqlUtc) return '';
  const t = Date.parse(sqlUtc.replace(' ', 'T') + 'Z');
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} hr ago`;
  return fmtDate(new Date(t).toISOString().slice(0, 10), { month: 'short', day: 'numeric' });
}

/** "Today 8:00 PM", "Tomorrow 7:30 AM", "Friday 9:00 AM" for a reminder's time (ms). */
export function reminderWhen(ms) {
  const d = new Date(ms);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${relDay(iso, S.today)} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** Read-only rows for Alexa reminders. Dismissing happens on Alexa. */
export function reminderSection(reminders, title = 'Alexa Reminders') {
  if (!reminders?.length) return '';
  return html`<section class="section">
    <div class="section-head"><h2>${title}</h2></div>
    <div class="group has-icons">${reminders.map((r) => html`<div class="row"><span class="tile" data-color="cyan">${icon('bell')}</span>
      <span class="body"><span class="title">${r.label}</span><span class="sub">${reminderWhen(r.at)}${r.repeats ? html` · ${icon('repeat', 'icon-sm')}<span class="sr-only">Repeats</span>` : ''}</span></span></div>`)}</div>
    <p class="section-foot">From Alexa. Change or dismiss them with Alexa.</p>
  </section>`;
}

/**
 * When the household uses Alexa, ask for a sync on open and reload once it has had time to run.
 * Returns a function that renders the status line.
 */
export function alexaSync(v, { rerender, reload }) {
  let st = null;
  // Never redraw under someone typing a new item or task.
  const typing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.value; };
  (async () => {
    try {
      st = await api.get('/api/alexa');
      if (!st.connected || !v.alive()) return;
      if (!typing()) rerender();
      const before = (st = await api.post('/api/alexa/sync')).lastSyncAt;
      setTimeout(async () => {
        if (!v.alive()) return;
        try { st = await api.get('/api/alexa'); } catch { return; }
        if (st.lastSyncAt !== before && !typing()) reload();
      }, 4000);
    } catch { /* the status line is optional */ }
  })();
  return () => {
    if (!st?.connected) return '';
    if (st.status === 'reconnect') return html`<p class="section-foot text-neg">Alexa needs to be reconnected in Settings.</p>`;
    if (st.lastError) return html`<p class="section-foot text-neg">Alexa sync failed: ${st.lastError}</p>`;
    return html`<p class="section-foot">Synced with Alexa${st.lastSyncAt ? ` · ${ago(st.lastSyncAt)}` : ''}</p>`;
  };
}

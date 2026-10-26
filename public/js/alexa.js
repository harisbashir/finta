// Alexa sync status, shared by Lists, Tasks and Settings.
import { api } from './api.js';
import { html, fmtDate } from './ui.js';

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

/**
 * When the household uses Alexa, ask for a sync on open and reload once it has had time to run.
 * Returns a function that renders the status line.
 */
export function alexaSync(v, { rerender, reload }) {
  let st = null;
  (async () => {
    try {
      st = await api.get('/api/alexa');
      if (!st.connected || !v.alive()) return;
      rerender();
      st = await api.post('/api/alexa/sync');
      setTimeout(async () => {
        if (!v.alive()) return;
        try { st = await api.get('/api/alexa'); } catch { /* keep the last status */ }
        reload();
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

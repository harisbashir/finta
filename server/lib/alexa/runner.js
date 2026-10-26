// Runs Alexa list sync: every 10 minutes, when Lists or Tasks is opened, and shortly after a
// change in Finta. One run at a time per household; a failure is recorded, never thrown.
import { createAlexaClient, ITEMS_PAGE } from './client.js';
import { plan, sameName } from './sync.js';
import { tx } from '../../db.js';
import { today } from '../dates.js';
import { completeTask } from '../tasks.js';

const VIEW_MIN_MS = 60000;
const ITEM_LIMIT = ITEMS_PAGE;   // what one fetch returns; past this, sync can't see the whole list
const NAME_MAX = { item: 80, task: 120 };
const LIST_NAME_MAX = 40;

export function createAlexaRunner({ db, makeClient = () => createAlexaClient(), intervalMs = 600000, debounceMs = 2000, log = console, now = Date.now } = {}) {
  const state = new Map(); // householdId → { chain, queued, debounce, lastRunAt }
  const emptySeen = new Set(); // "householdId:alexaListId" that came back empty last run
  const st = (hid) => {
    if (!state.has(hid)) state.set(hid, { chain: Promise.resolve(), queued: false, debounce: null, lastRunAt: 0 });
    return state.get(hid);
  };
  const getLink = (hid) => db.prepare('SELECT * FROM alexa_links WHERE household_id = ?').get(hid);
  const alive = (hid) => !!db.prepare('SELECT 1 FROM alexa_links WHERE household_id = ?').get(hid);
  let client = null;
  let timer = null;

  function enqueue(hid) {
    const s = st(hid);
    if (s.queued) return s.chain;
    s.queued = true;
    s.chain = s.chain.then(() => { s.queued = false; return runOnce(hid); }).catch((err) => log.error(`[alexa] household ${hid} crashed:`, err?.message));
    return s.chain;
  }

  function requestSync(hid, { reason = 'change' } = {}) {
    try {
      const link = getLink(hid);
      if (!link || link.status !== 'ok') return;
      const s = st(hid);
      if (reason === 'now') { enqueue(hid); return; }
      if (reason === 'view') {
        if (now() - s.lastRunAt < VIEW_MIN_MS || s.queued) return;
        enqueue(hid);
        return;
      }
      clearTimeout(s.debounce);
      s.debounce = setTimeout(() => enqueue(hid), debounceMs);
      s.debounce.unref?.();
    } catch (err) {
      log.error(`[alexa] household ${hid} request failed:`, err?.message);
    }
  }

  async function runOnce(hid) {
    const link = getLink(hid);
    if (!link || link.status !== 'ok') return;
    st(hid).lastRunAt = now();
    const login = JSON.parse(link.login);
    let firstError = null;
    let reminders = null;
    try {
      client ??= makeClient();
      const session = client.session(login);
      const lists = await session.getLists();
      if (!alive(hid)) return;
      for (const pairing of pairLists(hid, link, lists)) {
        try {
          await syncPairing(hid, session, pairing);
        } catch (err) {
          if (err.code === 'auth') throw err;
          firstError ??= err;
        }
      }
      try {
        reminders = JSON.stringify(await session.getReminders());
      } catch (err) {
        if (err.code === 'auth') throw err;
        firstError ??= err;
      }
    } catch (err) {
      firstError = err;
    }
    if (!alive(hid)) return;
    if (firstError) log.warn(`[alexa] household ${hid} ${firstError.code || 'error'}: ${firstError.message}`);
    db.prepare(`UPDATE alexa_links SET login = ?, cookies_at = ?, status = ?, reminders = COALESCE(?, reminders),
        last_sync_at = CASE WHEN ? THEN last_sync_at ELSE datetime('now') END,
        last_error = ?, last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE datetime('now') END
      WHERE household_id = ?`)
      .run(JSON.stringify(login), login.cookiesAt ? new Date(login.cookiesAt).toISOString() : null,
        firstError?.code === 'auth' ? 'reconnect' : 'ok', reminders,
        firstError && !firstError.code ? 1 : 0,
        firstError ? String(firstError.message).slice(0, 300) : null, firstError ? 1 : null, hid);
  }

  /** Which Finta list or tasks each Alexa list syncs with. Creates Finta lists as needed. */
  function pairLists(hid, link, lists) {
    const fintaLists = () => db.prepare('SELECT id, name FROM shopping_lists WHERE household_id = ? ORDER BY sort, id').all(hid);
    const createList = (name) => Number(db.prepare('INSERT INTO shopping_lists (household_id, name) VALUES (?, ?)').run(hid, name.slice(0, LIST_NAME_MAX)).lastInsertRowid);
    const pairings = [];
    let shopId = fintaLists().find((l) => l.id === link.shopping_list_id)?.id;
    for (const list of lists) {
      if (list.type === 'SHOP') {
        shopId ??= fintaLists()[0]?.id ?? createList('Groceries');
        pairings.push({ list, kind: 'item', fintaListId: shopId });
      } else if (list.type === 'TODO') {
        pairings.push({ list, kind: 'task', fintaListId: null });
      }
    }
    for (const list of lists) {
      let name = String(list.name || '').trim().slice(0, LIST_NAME_MAX).trim();
      if (list.type !== 'CUSTOM' || !name) continue;
      let match = fintaLists().find((l) => sameName(l.name, name));
      // That Finta list already syncs with Alexa's Shopping List, so this one gets its own.
      if (match && match.id === shopId) {
        name = `${name.slice(0, LIST_NAME_MAX - 8).trim()} (Alexa)`;
        match = fintaLists().find((l) => sameName(l.name, name));
      }
      pairings.push({ list, kind: 'item', fintaListId: match?.id ?? createList(name) });
    }
    return pairings;
  }

  function fintaRows(hid, { kind, fintaListId, list }) {
    const elsewhere = new Set(db.prepare('SELECT finta_id FROM alexa_items WHERE household_id = ? AND kind = ? AND alexa_list_id != ?')
      .all(hid, kind, list.id).map((r) => r.finta_id));
    const rows = kind === 'task'
      // Like the Tasks screen: open tasks and ones done in the last 14 days. Older ones leave Alexa.
      ? db.prepare(`SELECT id, title AS name, done_at IS NOT NULL AS checked, repeat, created_at FROM tasks
          WHERE household_id = ? AND (done_at IS NULL OR done_at > datetime('now', '-14 days'))`).all(hid)
      : db.prepare(`SELECT id, name, checked, 'none' AS repeat, created_at FROM shopping_items WHERE household_id = ? AND list_id = ?`).all(hid, fintaListId);
    return rows.filter((r) => !elsewhere.has(r.id)).map((r) => ({ ...r, checked: !!r.checked }));
  }

  async function syncPairing(hid, session, pairing) {
    const { list, kind, fintaListId } = pairing;
    const items = await session.getItems(list.id);
    if (!alive(hid)) return;
    if (items.length >= ITEM_LIMIT) {
      const label = list.name || (list.type === 'TODO' ? 'To-do list' : 'Shopping List');
      throw Object.assign(new Error(`Alexa’s ${label} has ${ITEM_LIMIT} or more items, so Finta skipped it. Delete completed items in the Alexa app.`), { code: 'api' });
    }
    const all = db.prepare('SELECT * FROM alexa_items WHERE household_id = ? AND alexa_list_id = ?').all(hid, list.id);
    const valid = all.filter((s) => s.kind === kind && (kind === 'task' || s.finta_list_id === fintaListId));
    // An empty list where items used to be may be an Amazon hiccup: wait for a second empty answer.
    const emptyKey = `${hid}:${list.id}`;
    if (!items.length && valid.length && !emptySeen.has(emptyKey)) {
      emptySeen.add(emptyKey);
      log.warn(`[alexa] household ${hid}: ${list.type} list came back empty; checking again next run`);
      return;
    }
    emptySeen.delete(emptyKey);
    const orphans = all.filter((s) => !valid.includes(s));
    const finta = fintaRows(hid, pairing);
    const created = new Map(finta.map((r) => [r.id, r.created_at]));
    const actions = plan({
      finta, alexa: items, maxName: NAME_MAX[kind],
      // A snapshot whose row was deleted and its id reused points at nothing (fintaId 0).
      snapshots: valid.map((s) => ({ fintaId: created.get(s.finta_id) === s.finta_created ? s.finta_id : 0, itemId: s.alexa_item_id, name: s.name, checked: !!s.checked, version: s.version })),
    });

    let firstError = null;
    const attempt = async (fn) => {
      try { await fn(); return true; } catch (err) {
        if (err.code === 'auth') throw err;
        firstError ??= err;
        return false;
      }
    };
    const snaps = [];   // snapshot rows to write: { fintaId, itemId, name, checked, version }
    const unlinks = [];
    const added = [];
    for (const a of actions) {
      if (a.op === 'alexa.add') {
        if (await attempt(() => session.addItem(list.id, a.name))) added.push(a);
      } else if (a.op === 'alexa.update') {
        if (await attempt(() => session.updateItem(list.id, a.itemId, a.version, { name: a.name, checked: a.checked }))) snaps.push(a);
      } else if (a.op === 'alexa.delete') {
        if (await attempt(() => session.deleteItem(list.id, a.itemId, a.version))) unlinks.push(a.itemId);
      }
    }
    if (added.length) {
      // Amazon doesn't return the new item's ID: read the list again and match by name.
      const known = new Set([...items.map((i) => i.itemId), ...valid.map((s) => s.alexa_item_id)]);
      let fresh = [];
      // If this fails, the adds are matched by name next run; the Finta side below still applies.
      await attempt(async () => { fresh = (await session.getItems(list.id)).filter((i) => !known.has(i.itemId)); });
      for (const a of added) {
        const item = fresh.find((i) => sameName(i.name, a.name));
        if (!item) continue;
        fresh.splice(fresh.indexOf(item), 1);
        let checked = false;
        if (a.checked && await attempt(() => session.updateItem(list.id, item.itemId, item.version, { checked: true }))) checked = true;
        snaps.push({ fintaId: a.fintaId, itemId: item.itemId, name: a.name, checked, version: item.version });
      }
    }

    const rolls = [];
    if (!alive(hid)) return;
    const todayStr = today(db.prepare('SELECT timezone FROM households WHERE id = ?').get(hid)?.timezone);
    tx(db, () => {
      for (const a of actions) {
        if (a.op === 'finta.add') {
          const id = kind === 'task'
            ? db.prepare(`INSERT INTO tasks (household_id, title, done_at, last_done_at) VALUES (?, ?, CASE WHEN ? THEN datetime('now') END, CASE WHEN ? THEN datetime('now') END)`).run(hid, a.name, a.checked ? 1 : 0, a.checked ? 1 : 0).lastInsertRowid
            : db.prepare('INSERT INTO shopping_items (household_id, list_id, name, checked) VALUES (?, ?, ?, ?)').run(hid, fintaListId, a.name, a.checked ? 1 : 0).lastInsertRowid;
          snaps.push({ ...a, fintaId: Number(id) });
        } else if (a.op === 'finta.update') {
          if (kind === 'task') {
            db.prepare(`UPDATE tasks SET title = ?, done_at = CASE WHEN ? THEN COALESCE(done_at, datetime('now')) END,
              last_done_at = CASE WHEN ? THEN COALESCE(done_at, datetime('now')) ELSE last_done_at END WHERE id = ? AND household_id = ?`)
              .run(a.name, a.checked ? 1 : 0, a.checked ? 1 : 0, a.fintaId, hid);
          } else {
            db.prepare('UPDATE shopping_items SET name = ?, checked = ? WHERE id = ? AND household_id = ?').run(a.name, a.checked ? 1 : 0, a.fintaId, hid);
          }
          snaps.push(a);
        } else if (a.op === 'finta.roll') {
          const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND household_id = ?').get(a.fintaId, hid);
          if (task) {
            db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(a.name, task.id);
            completeTask(db, task, todayStr);
          }
          // Still ticked on Alexa until the untick below succeeds; if it fails, next run retries the untick, not the roll.
          snaps.push({ ...a, checked: true });
          rolls.push(a);
        } else if (a.op === 'finta.delete') {
          db.prepare(`DELETE FROM ${kind === 'task' ? 'tasks' : 'shopping_items'} WHERE id = ? AND household_id = ?`).run(a.fintaId, hid);
          unlinks.push(a.itemId);
        } else if (a.op === 'link') {
          snaps.push(a);
        } else if (a.op === 'unlink') {
          unlinks.push(a.itemId);
        }
      }
      const del = db.prepare('DELETE FROM alexa_items WHERE household_id = ? AND alexa_item_id = ?');
      for (const s of orphans) del.run(hid, s.alexa_item_id);
      for (const itemId of unlinks) del.run(hid, itemId);
      const put = db.prepare(`INSERT OR REPLACE INTO alexa_items (household_id, alexa_list_id, alexa_item_id, kind, finta_id, finta_list_id, finta_created, name, checked, version)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT created_at FROM ${kind === 'task' ? 'tasks' : 'shopping_items'} WHERE id = ?), ?, ?, ?)`);
      for (const s of snaps) put.run(hid, list.id, s.itemId, kind, s.fintaId, fintaListId, s.fintaId, s.name, s.checked ? 1 : 0, Number(s.version) || 0);
    });
    // A repeating task ticked on Alexa is open again in Finta, so untick it on Alexa.
    for (const a of rolls) {
      if (await attempt(() => session.updateItem(list.id, a.itemId, a.version, { checked: false })) && alive(hid)) {
        db.prepare('UPDATE alexa_items SET checked = 0 WHERE household_id = ? AND alexa_item_id = ?').run(hid, a.itemId);
      }
    }
    if (firstError) throw firstError;
  }

  function tick() {
    try {
      for (const { household_id: hid } of db.prepare(`SELECT household_id FROM alexa_links WHERE status = 'ok'`).all()) enqueue(hid);
    } catch (err) {
      log.error('[alexa] scheduler failed:', err?.message);
    }
  }

  return {
    makeClient,
    requestSync,
    syncNow: (hid) => enqueue(hid),
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      setTimeout(tick, 5000).unref?.();
    },
    stop() { clearInterval(timer); timer = null; for (const s of state.values()) clearTimeout(s.debounce); },
  };
}

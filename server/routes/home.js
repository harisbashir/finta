// Home: tasks & chores, shopping lists, meal plan, things (assets & warranties), contacts, and Today.
import { bad } from '../lib/http.js';
import { validate, t } from '../lib/validate.js';
import { crud, getOwned, insertRow } from '../lib/crud.js';
import { nextTaskDate, addDays, monthRange } from '../lib/dates.js';
import { materializeAutopay, monthSummary, upcomingBills, netWorth } from '../lib/finance.js';
import { reviewCount } from './money.js';
import { tx } from '../db.js';

const REPEATS = ['none', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

export function homeRoutes(r) {
  const today = (ctx) => ctx.today();

  // ── Tasks ──
  const taskSchema = {
    title: t.str(120, { required: true }), notes: t.text(2000), due_date: t.date({ label: 'due date' }),
    repeat: t.oneOf(REPEATS, { default: 'none' }), area: t.oneOf(['chore', 'maintenance', 'errand', 'admin', 'other'], { default: 'chore' }),
    assignee_id: t.ref('users', { label: 'person' }),
  };
  crud(r, {
    path: '/api/tasks', table: 'tasks', schema: taskSchema,
    check: (v, ctx, existing) => {
      const repeat = v.repeat ?? existing?.repeat;
      const due = 'due_date' in v ? v.due_date : existing?.due_date;
      if (repeat && repeat !== 'none' && !due) v.due_date = today(ctx);
    },
    listQuery: (ctx) => ctx.db.prepare(`SELECT t.*, u.name AS assignee_name, u.color AS assignee_color FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.household_id = ? AND (t.done_at IS NULL OR t.done_at > datetime('now', '-14 days'))
      ORDER BY t.done_at IS NOT NULL, t.due_date IS NULL, t.due_date, t.id`).all(ctx.household.id),
  });

  r.post('/api/tasks/:id/complete', (ctx) => {
    const task = getOwned(ctx.db, 'tasks', ctx.params.id, ctx.household.id);
    if (task.repeat !== 'none') {
      // Repeating tasks roll forward instead of disappearing.
      const next = nextTaskDate(task.repeat, task.due_date, today(ctx));
      ctx.db.prepare(`UPDATE tasks SET due_date = ?, last_done_at = datetime('now') WHERE id = ?`).run(next, task.id);
      return { ...ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), rolled: true, previous_due: task.due_date };
    }
    ctx.db.prepare(`UPDATE tasks SET done_at = datetime('now'), last_done_at = datetime('now') WHERE id = ?`).run(task.id);
    return ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  });

  r.post('/api/tasks/:id/reopen', (ctx) => {
    const task = getOwned(ctx.db, 'tasks', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, { due_date: t.date() });
    ctx.db.prepare('UPDATE tasks SET done_at = NULL, due_date = COALESCE(?, due_date) WHERE id = ?').run(v.due_date ?? null, task.id);
    return ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  });

  // ── Shopping ──
  crud(r, {
    path: '/api/lists', table: 'shopping_lists', order: 'sort, id',
    schema: { name: t.str(40, { required: true }), sort: t.int(0, 1000) },
    listQuery: (ctx) => ctx.db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 0) AS open_count
      FROM shopping_lists l WHERE l.household_id = ? ORDER BY l.sort, l.id`).all(ctx.household.id),
  });

  r.get('/api/lists/:id/items', (ctx) => {
    const list = getOwned(ctx.db, 'shopping_lists', ctx.params.id, ctx.household.id);
    return ctx.db.prepare(`SELECT i.*, u.name AS added_by_name FROM shopping_items i LEFT JOIN users u ON u.id = i.added_by
      WHERE i.list_id = ? ORDER BY i.checked, i.created_at DESC, i.id DESC`).all(list.id);
  });

  const itemSchema = { name: t.str(80, { required: true }), quantity: t.str(30), checked: t.bool(), list_id: t.ref('shopping_lists', { label: 'list' }) };

  r.post('/api/lists/:id/items', (ctx) => {
    const list = getOwned(ctx.db, 'shopping_lists', ctx.params.id, ctx.household.id);
    // Accept several items at once: "milk, eggs, bread" or one per line.
    const names = String(ctx.body.name || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!names.length) throw bad('Type something to add.', { field: 'name' });
    const added = [];
    tx(ctx.db, () => {
      for (const name of names) {
        const v = validate({ ...ctx.body, name }, itemSchema, { db: ctx.db, householdId: ctx.household.id });
        // If it's already on the list and unchecked, don't duplicate.
        const dup = ctx.db.prepare('SELECT * FROM shopping_items WHERE list_id = ? AND name = ? COLLATE NOCASE AND checked = 0').get(list.id, v.name);
        if (dup) { added.push(dup); continue; }
        added.push(insertRow(ctx.db, 'shopping_items', ctx.household.id, { list_id: list.id, name: v.name, quantity: v.quantity ?? null, added_by: ctx.user.id }));
      }
    });
    return added;
  });

  r.patch('/api/items/:id', (ctx) => {
    const item = getOwned(ctx.db, 'shopping_items', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, itemSchema, { db: ctx.db, householdId: ctx.household.id, partial: true });
    if ('name' in v && !v.name) throw bad('Add a name.');
    const keys = Object.keys(v);
    if (keys.length) ctx.db.prepare(`UPDATE shopping_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), item.id);
    return ctx.db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(item.id);
  });

  r.delete('/api/items/:id', (ctx) => {
    const item = getOwned(ctx.db, 'shopping_items', ctx.params.id, ctx.household.id);
    ctx.db.prepare('DELETE FROM shopping_items WHERE id = ?').run(item.id);
    return { ok: true, deleted: item };
  });

  r.post('/api/lists/:id/clear-checked', (ctx) => {
    const list = getOwned(ctx.db, 'shopping_lists', ctx.params.id, ctx.household.id);
    const removed = ctx.db.prepare('SELECT * FROM shopping_items WHERE list_id = ? AND checked = 1').all(list.id);
    ctx.db.prepare('DELETE FROM shopping_items WHERE list_id = ? AND checked = 1').run(list.id);
    return { ok: true, removed };
  });

  // ── Meals ──
  const mealSchema = {
    date: t.date({ required: true }), slot: t.oneOf(['breakfast', 'lunch', 'dinner'], { default: 'dinner' }),
    title: t.str(100, { required: true }), ingredients: t.text(2000), notes: t.text(1000),
  };
  crud(r, {
    path: '/api/meals', table: 'meals', schema: mealSchema,
    listQuery: (ctx) => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.from || '') ? ctx.query.from : addDays(today(ctx), -1);
      const to = addDays(from, Math.min(62, Math.max(1, Number(ctx.query.days) || 14)));
      return ctx.db.prepare(`SELECT * FROM meals WHERE household_id = ? AND date BETWEEN ? AND ?
        ORDER BY date, CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END`).all(ctx.household.id, from, to);
    },
  });

  r.post('/api/meals/:id/to-list', (ctx) => {
    const meal = getOwned(ctx.db, 'meals', ctx.params.id, ctx.household.id);
    const v = validate(ctx.body, { list_id: t.ref('shopping_lists', { required: true, label: 'list' }) }, { db: ctx.db, householdId: ctx.household.id });
    const lines = String(meal.ingredients || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!lines.length) throw bad('This meal has no ingredients yet.');
    let added = 0;
    tx(ctx.db, () => {
      for (const name of lines) {
        const dup = ctx.db.prepare('SELECT 1 FROM shopping_items WHERE list_id = ? AND name = ? COLLATE NOCASE AND checked = 0').get(v.list_id, name.slice(0, 80));
        if (dup) continue;
        insertRow(ctx.db, 'shopping_items', ctx.household.id, { list_id: v.list_id, name: name.slice(0, 80), added_by: ctx.user.id });
        added++;
      }
    });
    return { ok: true, added };
  });

  // ── Things & contacts ──
  crud(r, {
    path: '/api/assets', table: 'assets', order: 'name',
    schema: {
      name: t.str(80, { required: true }), room: t.str(40), brand: t.str(60), model: t.str(80), serial: t.str(80),
      purchase_date: t.date({ label: 'purchase date' }), price: t.money(), warranty_until: t.date({ label: 'warranty end' }), notes: t.text(2000),
    },
  });

  crud(r, {
    path: '/api/contacts', table: 'contacts', order: 'name',
    schema: { name: t.str(80, { required: true }), role: t.str(60), phone: t.str(40), email: t.str(254), notes: t.text(2000) },
  });

  // ── Today: one request for the home screen ──
  r.get('/api/today', (ctx) => {
    const d = today(ctx);
    const hid = ctx.household.id;
    materializeAutopay(ctx.db, hid, d);
    const summary = monthSummary(ctx.db, hid, d.slice(0, 7), d);
    const bills = upcomingBills(ctx.db, hid, d, 7);
    const tasks = ctx.db.prepare(`SELECT t.*, u.name AS assignee_name, u.color AS assignee_color FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.household_id = ? AND t.done_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date LIMIT 20`).all(hid, addDays(d, 2));
    const meals = ctx.db.prepare(`SELECT * FROM meals WHERE household_id = ? AND date BETWEEN ? AND ?
      ORDER BY date, CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END`).all(hid, d, addDays(d, 1));
    const lists = ctx.db.prepare(`SELECT l.id, l.name, (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 0) AS open_count
      FROM shopping_lists l WHERE l.household_id = ? ORDER BY l.sort, l.id`).all(hid);
    const warranties = ctx.db.prepare(`SELECT id, name, warranty_until FROM assets WHERE household_id = ?
      AND warranty_until BETWEEN ? AND ? ORDER BY warranty_until`).all(hid, d, addDays(d, 45));
    const trials = ctx.db.prepare(`SELECT id, name, trial_ends, amount FROM recurring WHERE household_id = ?
      AND trial_ends BETWEEN ? AND ? ORDER BY trial_ends`).all(hid, d, addDays(d, 14));
    const { start, end } = monthRange(d.slice(0, 7));
    return {
      today: d, month: { ...summary, schedule: undefined, start, end },
      bills, tasks, meals, lists, warranties, trials,
      needsReview: reviewCount(ctx),
      netWorth: netWorth(ctx.db, hid, 'household', ctx.user.id),
    };
  });
}

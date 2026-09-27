// Household-scoped CRUD for simple resources. Every statement filters by household_id,
// so one household can never read or change another's rows.
import { notFound, bad } from './http.js';
import { validate } from './validate.js';

export function getOwned(db, table, id, householdId) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND household_id = ?`).get(n, householdId);
  if (!row) throw notFound();
  return row;
}

export function insertRow(db, table, householdId, values) {
  const cols = ['household_id', ...Object.keys(values)];
  const res = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(householdId, ...Object.values(values));
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(res.lastInsertRowid));
}

export function updateRow(db, table, id, householdId, values) {
  const keys = Object.keys(values);
  if (keys.length) {
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND household_id = ?`)
      .run(...Object.values(values), id, householdId);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

export function crud(r, { path, table, schema, order = 'id', where = '', check, after, listQuery }) {
  const ctxOpts = (ctx, partial) => ({ db: ctx.db, householdId: ctx.household.id, partial });

  r.get(path, (ctx) => listQuery
    ? listQuery(ctx)
    : ctx.db.prepare(`SELECT * FROM ${table} WHERE household_id = ? ${where} ORDER BY ${order}`).all(ctx.household.id));

  r.post(path, (ctx) => {
    const values = validate(ctx.body, schema, ctxOpts(ctx, false));
    check?.(values, ctx, null);
    const row = insertRow(ctx.db, table, ctx.household.id, values);
    return after ? after(row, ctx) : row;
  });

  r.patch(`${path}/:id`, (ctx) => {
    const existing = getOwned(ctx.db, table, ctx.params.id, ctx.household.id);
    const values = validate(ctx.body, schema, ctxOpts(ctx, true));
    for (const [k, spec] of Object.entries(schema)) {
      if (spec.required && k in values && values[k] == null) throw bad(`Add a ${spec.label || k}.`, { field: k });
    }
    check?.(values, ctx, existing);
    const row = updateRow(ctx.db, table, existing.id, ctx.household.id, values);
    return after ? after(row, ctx) : row;
  });

  r.delete(`${path}/:id`, (ctx) => {
    const existing = getOwned(ctx.db, table, ctx.params.id, ctx.household.id);
    ctx.db.prepare(`DELETE FROM ${table} WHERE id = ? AND household_id = ?`).run(existing.id, ctx.household.id);
    return { ok: true, deleted: existing };
  });
}

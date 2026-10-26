// A tiny made-up household for advisor tests: default categories, two people, and row helpers.
import { openDatabase } from '../server/db.js';
import { seedHousehold } from '../server/seed.js';

export function makeHousehold() {
  const db = openDatabase(':memory:');
  const hid = Number(db.prepare(`INSERT INTO households (name, timezone) VALUES ('Test Home', 'America/Toronto')`).run().lastInsertRowid);
  seedHousehold(db, hid);
  const user = (name, email, role) => Number(db.prepare('INSERT INTO users (household_id, email, name, role) VALUES (?, ?, ?, ?)').run(hid, email, name, role).lastInsertRowid);
  const owner = user('Alex', 'alex@example.com', 'owner');
  const member = user('Sam', 'sam@example.com', 'member');
  const insert = (table, fields) => {
    const keys = ['household_id', ...Object.keys(fields)];
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(hid, ...Object.values(fields)).lastInsertRowid);
  };
  const cat = (name) => db.prepare('SELECT id FROM categories WHERE household_id = ? AND name = ?').get(hid, name)?.id
    ?? insert('categories', { name, kind: 'out', color: 'gray', icon: 'tag' });
  return {
    db, hid, owner, member, cat,
    /** account({ name, type, balance, owner_id, is_private, credit_limit, registered }) — balance is the opening balance. */
    account: ({ balance = 0, ...f }) => insert('accounts', { name: f.name || f.type, owner_id: owner, is_private: 0, opening_balance: balance, ...f }),
    /** tx({ date, amount, direction, category: name, account_id, ... }) */
    tx: ({ category, direction = 'out', ...f }) => insert('transactions', { direction, category_id: category ? cat(category) : null, ...f }),
    debt: (f) => insert('debts', { name: f.name || 'Debt', type: 'other', owner_id: owner, ...f }),
    recurring: (f) => insert('recurring', { kind: 'bill', direction: 'out', frequency: 'monthly', owner_id: owner, ...f }),
  };
}

/** Same row every month for a list of months ('2026-01', …), on day `day`. */
export function monthly(h, months, day, fields) {
  for (const ym of months) h.tx({ date: `${ym}-${String(day).padStart(2, '0')}`, ...fields });
}

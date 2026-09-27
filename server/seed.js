// Defaults every new household gets, plus optional example data to learn the app with.
import { addDays, addMonths, parse, fmt, occurrences } from './lib/dates.js';
import { settleOccurrence } from './lib/finance.js';

const CATEGORIES = [
  // name, kind, color, icon, sample monthly budget (cents)
  ['Housing', 'out', 'blue', 'house', null],
  ['Utilities', 'out', 'yellow', 'zap', null],
  ['Groceries', 'out', 'green', 'shopping-cart', 90000],
  ['Dining Out', 'out', 'orange', 'utensils', 25000],
  ['Transport', 'out', 'indigo', 'car', 30000],
  ['Health', 'out', 'red', 'heart-pulse', null],
  ['Insurance', 'out', 'teal', 'shield', null],
  ['Subscriptions', 'out', 'purple', 'repeat', null],
  ['Kids', 'out', 'pink', 'baby', null],
  ['Shopping', 'out', 'cyan', 'shopping-bag', 20000],
  ['Entertainment', 'out', 'pink', 'ticket', 10000],
  ['Personal Care', 'out', 'mint', 'sparkles', null],
  ['Gifts', 'out', 'red', 'gift', null],
  ['Travel', 'out', 'cyan', 'plane', null],
  ['Pets', 'out', 'brown', 'paw-print', null],
  ['Debt', 'out', 'brown', 'credit-card', null],
  ['Other', 'out', 'gray', 'tag', null],
  ['Salary', 'in', 'green', 'briefcase', null],
  ['Other Income', 'in', 'mint', 'circle-plus', null],
];

export function seedHousehold(db, hid, { withSamples = false, today }) {
  const insCat = db.prepare('INSERT INTO categories (household_id, name, kind, color, icon, monthly_budget, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const cat = {};
  CATEGORIES.forEach(([name, kind, color, icon, budget], i) => {
    cat[name] = Number(insCat.run(hid, name, kind, color, icon, withSamples ? budget : null, i).lastInsertRowid);
  });
  const list = Number(db.prepare('INSERT INTO shopping_lists (household_id, name, sort) VALUES (?, ?, 0)').run(hid, 'Groceries').lastInsertRowid);
  if (!withSamples) return;

  const { y, m } = parse(today);
  const day = (d) => fmt(y, m, d);
  const lastMonth = (d) => addMonths(day(d), -1);

  const rec = db.prepare(`INSERT INTO recurring (household_id, name, direction, kind, amount, variable, frequency, start_date,
    autopay, category_id, payee, loan_balance, loan_rate, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','-40 days'))`);
  const R = (name, dir, kind, amount, freq, start, { autopay = 0, cat: c = null, variable = 0, bal = null, rate = null, payee = null } = {}) =>
    rec.run(hid, name, dir, kind, amount, variable, freq, start, autopay, c, payee, bal, rate);

  R('Paycheque', 'in', 'income', 285000, 'biweekly', addDays(today, -44), { cat: cat.Salary, autopay: 1 });
  R('Paycheque (Partner)', 'in', 'income', 240000, 'semimonthly', lastMonth(15), { cat: cat.Salary, autopay: 1 });
  R('Mortgage', 'out', 'loan', 215000, 'monthly', lastMonth(1), { cat: cat.Housing, autopay: 1, bal: 41200000, rate: 4.79, payee: 'Bank' });
  R('Property Tax', 'out', 'bill', 34500, 'monthly', lastMonth(15), { cat: cat.Housing });
  R('Hydro', 'out', 'bill', 9500, 'monthly', addMonths(addDays(today, 2), -1), { cat: cat.Utilities, variable: 1 });
  R('Gas & Heating', 'out', 'bill', 8000, 'monthly', lastMonth(18), { cat: cat.Utilities, variable: 1 });
  R('Internet', 'out', 'bill', 7500, 'monthly', lastMonth(5), { cat: cat.Utilities, autopay: 1 });
  R('Phones', 'out', 'bill', 11000, 'monthly', addMonths(addDays(today, 5), -1), { cat: cat.Utilities, autopay: 1 });
  R('Home Insurance', 'out', 'insurance', 11800, 'monthly', lastMonth(3), { cat: cat.Insurance, autopay: 1 });
  R('Car Insurance', 'out', 'insurance', 21000, 'monthly', lastMonth(20), { cat: cat.Insurance, autopay: 1 });
  R('Netflix', 'out', 'subscription', 2099, 'monthly', lastMonth(9), { cat: cat.Subscriptions, autopay: 1 });
  R('Spotify Family', 'out', 'subscription', 1999, 'monthly', lastMonth(26), { cat: cat.Subscriptions, autopay: 1 });
  R('Cloud Storage', 'out', 'subscription', 399, 'monthly', lastMonth(14), { cat: cat.Subscriptions, autopay: 1 });
  R('Costco Membership', 'out', 'subscription', 6500, 'yearly', addMonths(day(Math.min(28, parse(today).d)), 2), { cat: cat.Subscriptions });

  // Everything already due has been paid, so the example starts calm rather than overdue.
  const all = db.prepare('SELECT * FROM recurring WHERE household_id = ?').all(hid);
  for (const item of all) {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date, end: item.end_date }, lastMonth(1), addDays(today, -1))) {
      settleOccurrence(db, item, due, { amount: item.amount, date: due });
    }
  }

  const spend = db.prepare('INSERT INTO transactions (household_id, date, amount, direction, category_id, note) VALUES (?,?,?,?,?,?)');
  const d = parse(today).d;
  const past = (n) => addDays(today, -Math.min(n, d - 1));
  [[0, 8743, 'Groceries', 'Weekly shop'], [1, 1250, 'Dining Out', 'Coffee'], [2, 6200, 'Transport', 'Gas'],
    [4, 13420, 'Groceries', 'Costco'], [5, 4800, 'Dining Out', 'Pizza night'], [7, 3999, 'Shopping', 'Kids’ shoes'],
    [9, 2600, 'Entertainment', 'Movie'], [11, 7710, 'Groceries', 'Weekly shop']]
    .forEach(([ago, amt, c, note]) => spend.run(hid, past(ago), amt, 'out', cat[c], note));

  const goal = db.prepare('INSERT INTO goals (household_id, name, target, saved, target_date, color) VALUES (?,?,?,?,?,?)');
  const ef = Number(goal.run(hid, 'Emergency Fund', 1000000, 320000, addMonths(today, 14), 'teal').lastInsertRowid);
  db.prepare(`INSERT INTO transactions (household_id, date, amount, direction, note, goal_id) VALUES (?, ?, ?, 'out', ?, ?)`)
    .run(hid, past(3), 40000, 'Set aside for Emergency Fund', ef);
  goal.run(hid, 'Summer Trip', 400000, 90000, addMonths(today, 8), 'orange');

  const task = db.prepare('INSERT INTO tasks (household_id, title, due_date, repeat, area) VALUES (?,?,?,?,?)');
  task.run(hid, 'Take out recycling', addDays(today, 1), 'weekly', 'chore');
  task.run(hid, 'Replace furnace filter', addDays(today, 3), 'quarterly', 'maintenance');
  task.run(hid, 'Test smoke alarms', addDays(today, 10), 'monthly', 'maintenance');
  task.run(hid, 'Clean gutters', addDays(today, 24), 'yearly', 'maintenance');
  task.run(hid, 'Book dentist appointments', addDays(today, -1), 'none', 'admin');
  task.run(hid, 'Water the plants', today, 'weekly', 'chore');

  const item = db.prepare('INSERT INTO shopping_items (household_id, list_id, name, quantity) VALUES (?,?,?,?)');
  [['Milk', '2 L'], ['Eggs', '1 dozen'], ['Bananas', null], ['Dish soap', null], ['Chicken thighs', '1 kg']]
    .forEach(([n, q]) => item.run(hid, list, n, q));

  const meal = db.prepare('INSERT INTO meals (household_id, date, slot, title, ingredients) VALUES (?,?,?,?,?)');
  meal.run(hid, today, 'dinner', 'Sheet-pan chicken & veg', 'Chicken thighs\nPotatoes\nBroccoli\nLemon');
  meal.run(hid, addDays(today, 1), 'dinner', 'Spaghetti bolognese', 'Spaghetti\nGround beef\nCrushed tomatoes\nOnion');
  meal.run(hid, addDays(today, 2), 'dinner', 'Tacos', 'Tortillas\nBlack beans\nCheddar\nSalsa');

  const asset = db.prepare('INSERT INTO assets (household_id, name, room, brand, purchase_date, price, warranty_until) VALUES (?,?,?,?,?,?,?)');
  asset.run(hid, 'Furnace', 'Basement', 'Lennox', addMonths(today, -30), 520000, addMonths(today, 90));
  asset.run(hid, 'Refrigerator', 'Kitchen', 'LG', addMonths(today, -11), 189900, addDays(today, 25));
  asset.run(hid, 'Washer', 'Laundry', 'Whirlpool', addMonths(today, -40), 89900, addMonths(today, -4));

  const contact = db.prepare('INSERT INTO contacts (household_id, name, role, phone) VALUES (?,?,?,?)');
  contact.run(hid, 'Northside Plumbing', 'Plumber', '416-555-0142');
  contact.run(hid, 'Bright Electric', 'Electrician', '416-555-0199');
}

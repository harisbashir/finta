// Defaults every new household gets, plus optional example data to learn the app with.
// The example household's bank and card history is generated as CSV statements and run
// through the real importer, so it looks exactly like a household that imported its own.
import { addDays, addMonths, occurrences } from './lib/dates.js';
import { commitImport } from './lib/importer.js';

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
  ['Fees & Interest', 'out', 'brown', 'receipt', null],
  ['Taxes', 'out', 'gray', 'landmark', null],
  ['Other', 'out', 'gray', 'tag', null],
  ['Salary', 'in', 'green', 'briefcase', null],
  ['Other Income', 'in', 'mint', 'circle-plus', null],
];

/** Categories and a first shopping list. Runs inside the sign-up transaction. */
export function seedHousehold(db, hid) {
  const insCat = db.prepare('INSERT INTO categories (household_id, name, kind, color, icon, sort) VALUES (?, ?, ?, ?, ?, ?)');
  CATEGORIES.forEach(([name, kind, color, icon], i) => insCat.run(hid, name, kind, color, icon, i));
  db.prepare('INSERT INTO shopping_lists (household_id, name, sort) VALUES (?, ?, 0)').run(hid, 'Groceries');
}

// Deterministic "random" so example data is stable between runs.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
const money = (cents) => (cents / 100).toFixed(2);

/** A realistic household: three months of statements, bills, debts, goals, chores, meals. */
export function seedSamples(db, hid, userId, today) {
  const cat = Object.fromEntries(db.prepare('SELECT id, name FROM categories WHERE household_id = ?').all(hid).map((c) => [c.name, c.id]));
  for (const [name, , , , budget] of CATEGORIES) if (budget) db.prepare('UPDATE categories SET monthly_budget = ? WHERE id = ?').run(budget, cat[name]);
  const list = db.prepare('SELECT id FROM shopping_lists WHERE household_id = ?').get(hid).id;
  const r = rng(hid * 7919 + 17);
  const start = addMonths(today.slice(0, 7) + '-01', -2);       // first day, two months ago
  const yesterday = addDays(today, -1);

  // ── Recurring: named the way they appear on statements, so the importer links them ──
  const rec = db.prepare(`INSERT INTO recurring (household_id, name, direction, kind, amount, variable, frequency, start_date,
    autopay, category_id, payee, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','-100 days'))`);
  const R = (name, dir, kind, amount, freq, first, o = {}) => ({
    id: Number(rec.run(hid, name, dir, kind, amount, o.variable ? 1 : 0, freq, first, o.autopay ? 1 : 0, o.cat ?? null, o.payee ?? null, o.owner === undefined ? userId : o.owner).lastInsertRowid),
    name, amount, frequency: freq, start_date: first, ...o,
  });
  const dayOf = (n) => addDays(start, n - 1);
  const items = {
    pay: R('Paycheque (Acme)', 'in', 'income', 325000, 'biweekly', dayOf(3), { cat: cat.Salary, autopay: true, desc: 'PAYROLL DEP ACME CORP' }),
    mortgage: R('Mortgage', 'out', 'loan', 215000, 'monthly', dayOf(1), { cat: cat.Housing, autopay: true, payee: 'TD Bank', owner: null, desc: 'TD MORTGAGE PMT' }),
    tax: R('Property Tax', 'out', 'bill', 34500, 'monthly', dayOf(15), { cat: cat.Housing, owner: null, desc: 'CITY OF TORONTO PROPERTY TAX' }),
    hydro: R('Hydro', 'out', 'bill', 9500, 'monthly', dayOf(22), { cat: cat.Utilities, variable: true, owner: null, desc: 'TORONTO HYDRO-ELECTRIC' }),
    gas: R('Enbridge Gas', 'out', 'bill', 8000, 'monthly', dayOf(18), { cat: cat.Utilities, variable: true, owner: null, desc: 'ENBRIDGE GAS DISTRIBUTION' }),
    internet: R('Internet (Rogers)', 'out', 'bill', 7500, 'monthly', dayOf(5), { cat: cat.Utilities, autopay: true, owner: null, desc: 'ROGERS INTERNET' }),
    phones: R('Phones (Fido)', 'out', 'bill', 11000, 'monthly', dayOf(12), { cat: cat.Utilities, autopay: true, desc: 'FIDO MOBILE' }),
    home: R('Home Insurance (Aviva)', 'out', 'insurance', 11800, 'monthly', dayOf(3), { cat: cat.Insurance, autopay: true, owner: null, desc: 'AVIVA INSURANCE' }),
    car: R('Car Insurance (Intact)', 'out', 'insurance', 21000, 'monthly', dayOf(20), { cat: cat.Insurance, autopay: true, desc: 'INTACT INSURANCE' }),
    carloan: R('Car Loan (Honda)', 'out', 'loan', 38500, 'monthly', dayOf(25), { cat: cat.Debt, autopay: true, payee: 'Honda Financial', desc: 'HONDA FINANCIAL SVCS' }),
    netflix: R('Netflix', 'out', 'subscription', 2099, 'monthly', dayOf(9), { cat: cat.Subscriptions, autopay: true, owner: null, card: true, desc: 'NETFLIX.COM' }),
    spotify: R('Spotify Family', 'out', 'subscription', 1999, 'monthly', dayOf(26), { cat: cat.Subscriptions, autopay: true, owner: null, card: true, desc: 'SPOTIFY P2C3A1' }),
    icloud: R('iCloud Storage', 'out', 'subscription', 399, 'monthly', dayOf(14), { cat: cat.Subscriptions, autopay: true, card: true, desc: 'APPLE.COM/BILL ICLOUD' }),
  };
  R('Costco Membership', 'out', 'subscription', 6500, 'yearly', addMonths(today, 2), { cat: cat.Subscriptions, owner: null });
  db.prepare('INSERT INTO recurring (household_id, name, direction, kind, amount, frequency, start_date, autopay, category_id, trial_ends, owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(hid, 'Disney+', 'out', 'subscription', 1399, 'monthly', addDays(today, 9), 0, cat.Subscriptions, addDays(today, 8), userId);

  // ── Debts ──
  const debt = db.prepare(`INSERT INTO debts (household_id, owner_id, name, type, lender, balance, original_amount, rate, min_payment, recurring_id, account_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  debt.run(hid, null, 'Mortgage', 'mortgage', 'TD Bank', 41420000, 52000000, 4.79, 215000, items.mortgage.id, null);
  debt.run(hid, userId, 'Car Loan', 'car', 'Honda Financial', 1460000, 3200000, 6.49, 38500, items.carloan.id, null);
  debt.run(hid, userId, 'Line of Credit', 'line_of_credit', 'TD Bank', 350000, null, 9.2, 10000, null, null);

  // ── Accounts ──
  const acc = db.prepare(`INSERT INTO accounts (household_id, owner_id, name, type, institution, last4, opening_balance, credit_limit, is_private) VALUES (?,?,?,?,?,?,?,?,?)`);
  const cheq = Number(acc.run(hid, null, 'Joint Chequing', 'chequing', 'TD', '4521', 540000, null, 0).lastInsertRowid);
  const save = Number(acc.run(hid, userId, 'High-Interest Savings', 'savings', 'EQ Bank', '8810', 1250000, null, 1).lastInsertRowid);
  const visa = Number(acc.run(hid, userId, 'TD Visa', 'credit_card', 'TD', '3007', -42000, 800000, 1).lastInsertRowid);
  debt.run(hid, userId, 'TD Visa', 'credit_card', 'TD', 0, null, 20.99, 5000, null, visa);

  // ── Statements ──
  const cheqRows = [], cardRows = [], saveRows = [];
  const pushOcc = (item, rows, jitter = 0) => {
    for (const due of occurrences({ frequency: item.frequency, start: item.start_date }, start, yesterday)) {
      const amt = item.variable ? Math.round(item.amount * (0.85 + r() * 0.3)) : item.amount;
      const date = addDays(due, jitter && r() < 0.3 ? 1 : 0);
      if (date > yesterday) continue;
      const isIn = item === items.pay;
      rows.push([date, item.desc, isIn ? '' : money(amt), isIn ? money(amt) : '']);
    }
  };
  for (const it of Object.values(items)) pushOcc(it, it.card ? cardRows : cheqRows, it.variable ? 1 : 0);

  // Everyday card spending: groceries weekly, coffee, takeout, gas, shopping, a few unknowns for Review.
  const shops = [
    ['LOBLAWS #1041 TORONTO ON', 7, 9000, 16000], ['NO FRILLS #3321 TORONTO ON', 10, 5000, 9000], ['COSTCO WHOLESALE #535', 21, 15000, 26000],
    ['TIM HORTONS #2291 TORONTO ON', 3, 250, 900], ['STARBUCKS 800 NORTH YORK ON', 6, 550, 900], ['UBER* EATS', 9, 2800, 5200],
    ['PETRO-CANADA 4412', 8, 5500, 8200], ['AMZN Mktp CA*2K8TR45T2', 11, 1800, 7400], ['SHOPPERS DRUG MART #0823', 14, 1200, 4800],
    ['CINEPLEX ENT #1122', 25, 3200, 5600], ['PRESTO FARE/TTC', 12, 1000, 1500], ['DOLLARAMA #1532', 16, 600, 2400],
  ];
  for (const [desc, every, lo, hi] of shops) {
    for (let dd = start; dd <= yesterday; dd = addDays(dd, every + Math.floor(r() * 3) - 1)) {
      cardRows.push([addDays(dd, Math.floor(r() * 2)), desc, money(lo + Math.round(r() * (hi - lo))), '']);
    }
  }
  for (const [desc, off, amt] of [['JOE\'S HARDWARE 55 TORONTO', 4, 6400], ['GREENLEAF GARDEN CTR', 12, 3850], ['PIXEL PRINT STUDIO', 19, 2800], ['GREENLEAF GARDEN CTR', 47, 2215]]) {
    const date = addDays(today, -off);
    if (date >= start) cardRows.push([date, desc, money(amt), '']);
  }
  cardRows.push([addDays(start, 26), 'PURCHASE INTEREST', '8.12', '']);

  // Pay last month's card bill in full from chequing on the 20th (it posts to the card two days later),
  // and move money to savings after the first payday.
  const cents = (x) => Math.round(Number(x) * 100);
  for (let mo = 0; mo < 3; mo++) {
    const monthStart = addMonths(start, mo);
    const payDay = addDays(monthStart, 19);
    if (addDays(payDay, 2) <= yesterday) {
      const prev = addMonths(monthStart, -1);
      const owed = mo === 0 ? 42000 : cardRows.filter((x) => x[0] >= prev && x[0] < monthStart && x[2]).reduce((t, x) => t + cents(x[2]), 0);
      const amt = money(owed);
      cheqRows.push([payDay, 'TD VISA PAYMENT', amt, '']);
      cardRows.push([addDays(payDay, 2), 'PAYMENT - THANK YOU', '', amt]);
    }
    const sv = addDays(monthStart, 3);
    if (sv <= yesterday) {
      cheqRows.push([sv, 'TFR-TO 8810 SAVINGS', '300.00', '']);
      saveRows.push([addDays(sv, 1), 'TRANSFER FROM CHEQUING 4521', '', '300.00']);
    }
    // A gym membership nobody set up as a bill yet: Finta suggests tracking it.
    if (addDays(monthStart, 6) <= yesterday) cardRows.push([addDays(monthStart, 6), 'GOODLIFE FITNESS CLUBS', '54.99', '']);
    const interest = addDays(monthStart, 27);
    if (interest <= yesterday) saveRows.push([interest, 'INTEREST PAID', '', money(3900 + Math.round(r() * 400))]);
  }
  cheqRows.push([addDays(today, -20), 'INTERAC E-TRANSFER TO MIRA K', '45.00', '']);
  cheqRows.push([addDays(today, -33), 'MONTHLY ACCOUNT FEE', '16.95', '']);

  const toCsv = (rows) => ['Date,Details,Debit,Credit', ...rows.sort((a, b) => a[0].localeCompare(b[0])).map((x) => x.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))].join('\n');
  const accounts = db.prepare('SELECT * FROM accounts WHERE household_id = ?').all(hid);
  const byId = (id) => accounts.find((a) => a.id === id);
  // Card first, so the chequing import finds the payment's other half.
  commitImport(db, byId(visa), toCsv(cardRows), {}, { userId, filename: 'td-visa-example.csv', useStatementBalance: false });
  commitImport(db, byId(save), toCsv(saveRows), {}, { userId, filename: 'eq-savings-example.csv', useStatementBalance: false });
  commitImport(db, byId(cheq), toCsv(cheqRows), {}, { userId, filename: 'td-chequing-example.csv', useStatementBalance: false });

  // ── Goals, home ──
  const goal = db.prepare('INSERT INTO goals (household_id, name, target, saved, target_date, color, owner_id) VALUES (?,?,?,?,?,?,?)');
  const ef = Number(goal.run(hid, 'Emergency Fund', 1500000, 620000, addMonths(today, 14), 'teal', null).lastInsertRowid);
  goal.run(hid, 'Summer Trip', 400000, 90000, addMonths(today, 8), 'orange', userId);
  db.prepare(`INSERT INTO transactions (household_id, date, amount, direction, note, goal_id, paid_by, cat_source) VALUES (?, ?, ?, 'out', ?, ?, ?, 'manual')`)
    .run(hid, addDays(today, -3), 40000, 'Set aside for Emergency Fund', ef, userId);

  const task = db.prepare('INSERT INTO tasks (household_id, title, due_date, repeat, area) VALUES (?,?,?,?,?)');
  task.run(hid, 'Take out recycling', addDays(today, 1), 'weekly', 'chore');
  task.run(hid, 'Replace furnace filter', addDays(today, 3), 'quarterly', 'maintenance');
  task.run(hid, 'Test smoke alarms', addDays(today, 10), 'monthly', 'maintenance');
  task.run(hid, 'Clean gutters', addDays(today, 24), 'yearly', 'maintenance');
  task.run(hid, 'Book dentist appointments', addDays(today, -1), 'none', 'admin');
  task.run(hid, 'Water the plants', today, 'weekly', 'chore');

  const item = db.prepare('INSERT INTO shopping_items (household_id, list_id, name, quantity) VALUES (?,?,?,?)');
  [['Milk', '2 L'], ['Eggs', '1 dozen'], ['Bananas', null], ['Dish soap', null], ['Chicken thighs', '1 kg']].forEach(([n, q]) => item.run(hid, list, n, q));

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

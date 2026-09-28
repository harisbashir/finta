-- Finta v1.1: bank & card accounts with CSV import, learned categorization rules,
-- debts as their own records, per-member ownership and privacy, and an appearance setting.

ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark'));

-- Accounts: chequing, savings, credit cards, lines of credit.
-- Balance = opening_balance + money in − money out. For cards and credit lines the balance is
-- negative (what you owe), so one formula works for every account.
CREATE TABLE accounts (
  id               INTEGER PRIMARY KEY,
  household_id     INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL = joint
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('chequing','savings','credit_card','line_of_credit','cash','investment')),
  institution      TEXT,
  last4            TEXT,
  opening_balance  INTEGER NOT NULL DEFAULT 0,
  credit_limit     INTEGER,
  is_private       INTEGER NOT NULL DEFAULT 1,  -- others see totals, not transactions
  archived         INTEGER NOT NULL DEFAULT 0,
  csv_mapping      TEXT,                        -- remembered column mapping (JSON)
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX accounts_household ON accounts(household_id);

CREATE TABLE imports (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename      TEXT,
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  date_from     TEXT,
  date_to       TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD COLUMN import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN description TEXT;          -- raw statement text
ALTER TABLE transactions ADD COLUMN merchant TEXT;             -- normalized key, e.g. "TIM HORTONS"
ALTER TABLE transactions ADD COLUMN fingerprint TEXT;          -- de-duplicates re-imports
ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN transfer_peer_id INTEGER;  -- the other side of a transfer
ALTER TABLE transactions ADD COLUMN cat_source TEXT;           -- rule | recurring | auto | manual | transfer
CREATE UNIQUE INDEX transactions_fingerprint ON transactions(account_id, fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX transactions_account_date ON transactions(account_id, date);
CREATE INDEX transactions_merchant ON transactions(household_id, merchant);

-- Rules learned from you: "TIM HORTONS" → Dining Out; "TORONTO HYDRO" → the Hydro bill.
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  pattern       TEXT    NOT NULL,                         -- normalized merchant key (contains-match)
  kind          TEXT    NOT NULL DEFAULT 'categorize' CHECK (kind IN ('categorize','transfer','ignore_recurring')),
  category_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  recurring_id  INTEGER REFERENCES recurring(id) ON DELETE CASCADE,
  rename_to     TEXT,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX rules_pattern ON rules(household_id, pattern, kind);

-- Debts: one record per thing you owe. A debt can follow a card/credit-line account
-- (balance comes from imported statements) or a recurring payment (balance falls as you pay).
CREATE TABLE debts (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('mortgage','credit_card','line_of_credit','car','student','personal','other')),
  lender          TEXT,
  balance         INTEGER NOT NULL DEFAULT 0,       -- ignored when account_id is set
  original_amount INTEGER,
  rate            REAL,                             -- annual %
  min_payment     INTEGER,                          -- per month
  due_day         INTEGER,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  recurring_id    INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
  notes           TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX debts_household ON debts(household_id);

ALTER TABLE goals ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Existing loans become debts linked to their payment schedule.
INSERT INTO debts (household_id, owner_id, name, type, lender, balance, original_amount, rate, min_payment, recurring_id)
  SELECT household_id, owner_id, name,
         CASE WHEN lower(name) LIKE '%mortgage%' THEN 'mortgage'
              WHEN lower(name) LIKE '%car%' OR lower(name) LIKE '%auto%' THEN 'car'
              WHEN lower(name) LIKE '%student%' OR lower(name) LIKE '%osap%' THEN 'student'
              ELSE 'personal' END,
         payee, COALESCE(loan_balance, 0), loan_balance, loan_rate,
         CAST(ROUND(amount * CASE frequency WHEN 'weekly' THEN 52.0/12 WHEN 'biweekly' THEN 26.0/12
           WHEN 'semimonthly' THEN 2 WHEN 'quarterly' THEN 1.0/3 WHEN 'yearly' THEN 1.0/12 ELSE 1 END) AS INTEGER),
         id
  FROM recurring WHERE kind = 'loan' AND loan_balance IS NOT NULL;

-- A category for bank fees and card interest, for households created before v1.1.
INSERT INTO categories (household_id, name, kind, color, icon, sort)
  SELECT id, 'Fees & Interest', 'out', 'brown', 'receipt', 16 FROM households
  WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.household_id = households.id AND c.name = 'Fees & Interest');

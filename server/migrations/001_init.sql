-- Finta schema v1. Money is stored as integer cents. Dates are ISO 'YYYY-MM-DD' text.
-- Every household-owned row carries household_id; every query filters on it.

CREATE TABLE households (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'CAD',
  locale        TEXT    NOT NULL DEFAULT 'en-CA',
  timezone      TEXT    NOT NULL DEFAULT 'UTC',
  week_starts   INTEGER NOT NULL DEFAULT 0,          -- 0 = Sunday, 1 = Monday
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  password_hash   TEXT,
  totp_secret     TEXT,                                -- set only once 2FA is confirmed
  totp_pending    TEXT,                                -- secret awaiting first valid code
  totp_last_step  INTEGER NOT NULL DEFAULT 0,          -- blocks code replay
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  color           TEXT    NOT NULL DEFAULT 'blue',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recovery_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  used_at    TEXT
);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE passkeys (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT    NOT NULL UNIQUE,              -- base64url
  public_key     TEXT    NOT NULL,                     -- JWK JSON
  alg            INTEGER NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,
  name           TEXT    NOT NULL DEFAULT 'Passkey',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT
);

-- Short-lived server state: WebAuthn challenges and half-finished 2FA logins.
CREATE TABLE auth_tickets (
  id          TEXT PRIMARY KEY,                        -- random, sent to client
  kind        TEXT NOT NULL,                           -- 'totp' | 'pk-reg' | 'pk-auth'
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  challenge   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL
);

CREATE TABLE invites (
  id           INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  household_id INTEGER,
  user_id      INTEGER,
  event        TEXT NOT NULL,
  ip           TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_household ON audit_log(household_id, created_at);

-- ───────────── Money ─────────────

CREATE TABLE categories (
  id           INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'out' CHECK (kind IN ('in','out')),
  color        TEXT    NOT NULL DEFAULT 'gray',
  icon         TEXT    NOT NULL DEFAULT 'tag',
  monthly_budget INTEGER,                              -- cents; NULL = no budget
  sort         INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX categories_household ON categories(household_id);

-- One table for everything that repeats: income, bills, subscriptions, loans, insurance.
CREATE TABLE recurring (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  direction     TEXT    NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out')),
  kind          TEXT    NOT NULL DEFAULT 'bill'
                CHECK (kind IN ('income','bill','subscription','loan','insurance','savings')),
  amount        INTEGER NOT NULL,                      -- cents per occurrence (estimate if variable)
  variable      INTEGER NOT NULL DEFAULT 0,            -- amount changes each time (e.g. hydro)
  frequency     TEXT    NOT NULL DEFAULT 'monthly'
                CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly','yearly')),
  start_date    TEXT    NOT NULL,                      -- first due date; anchors the schedule
  end_date      TEXT,
  autopay       INTEGER NOT NULL DEFAULT 0,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payee         TEXT,
  url           TEXT,
  notes         TEXT,
  -- loans & mortgages
  loan_balance  INTEGER,                               -- cents outstanding
  loan_rate     REAL,                                  -- annual %, e.g. 4.89
  -- subscriptions
  trial_ends    TEXT,
  paused        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX recurring_household ON recurring(household_id);

CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,
  amount        INTEGER NOT NULL,                      -- cents, always positive
  direction     TEXT    NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out')),
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  note          TEXT,
  paid_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recurring_id  INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
  due_date      TEXT,                                  -- which occurrence this settles
  goal_id       INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  principal     INTEGER,                               -- loan payments: part that reduced the balance
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transactions_household_date ON transactions(household_id, date);
CREATE UNIQUE INDEX transactions_occurrence ON transactions(recurring_id, due_date)
  WHERE recurring_id IS NOT NULL AND due_date IS NOT NULL;

CREATE TABLE goals (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  target        INTEGER NOT NULL,
  saved         INTEGER NOT NULL DEFAULT 0,
  target_date   TEXT,
  color         TEXT    NOT NULL DEFAULT 'teal',
  notes         TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────── Home ─────────────

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  notes         TEXT,
  due_date      TEXT,
  repeat        TEXT    NOT NULL DEFAULT 'none'
                CHECK (repeat IN ('none','daily','weekly','biweekly','monthly','quarterly','yearly')),
  area          TEXT    NOT NULL DEFAULT 'chore'
                CHECK (area IN ('chore','maintenance','errand','admin','other')),
  assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at       TEXT,
  last_done_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX tasks_household ON tasks(household_id, done_at, due_date);

CREATE TABLE shopping_lists (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE shopping_items (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  list_id       INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  quantity      TEXT,
  checked       INTEGER NOT NULL DEFAULT 0,
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX shopping_items_list ON shopping_items(list_id, checked);

CREATE TABLE meals (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,
  slot          TEXT    NOT NULL DEFAULT 'dinner' CHECK (slot IN ('breakfast','lunch','dinner')),
  title         TEXT    NOT NULL,
  ingredients   TEXT,                                  -- one per line
  notes         TEXT
);
CREATE INDEX meals_household_date ON meals(household_id, date);

CREATE TABLE assets (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  room            TEXT,
  brand           TEXT,
  model           TEXT,
  serial          TEXT,
  purchase_date   TEXT,
  price           INTEGER,
  warranty_until  TEXT,
  notes           TEXT
);

CREATE TABLE contacts (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  role          TEXT,
  phone         TEXT,
  email         TEXT,
  notes         TEXT
);

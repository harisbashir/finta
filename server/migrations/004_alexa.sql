-- Alexa list sync: one Amazon connection per household, plus a snapshot of each synced item.

CREATE TABLE alexa_links (
  household_id     INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  site             TEXT NOT NULL,                 -- 'amazon.ca'
  email            TEXT NOT NULL,                 -- shown in Settings only
  login            TEXT NOT NULL,                 -- JSON: tokens, cookies, device serial (never sent to clients)
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','reconnect')),
  shopping_list_id INTEGER REFERENCES shopping_lists(id) ON DELETE SET NULL,
  cookies_at       TEXT,
  last_sync_at     TEXT,
  last_error       TEXT,
  last_error_at    TEXT,
  connected_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE alexa_items (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  alexa_list_id TEXT    NOT NULL,
  alexa_item_id TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('item','task')),
  finta_id      INTEGER NOT NULL,                 -- shopping_items.id or tasks.id
  finta_list_id INTEGER,                          -- shopping_lists.id for items; NULL for tasks
  finta_created TEXT,                             -- the Finta row's created_at: SQLite reuses deleted ids
  name          TEXT    NOT NULL,                 -- snapshot from the last sync
  checked       INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  UNIQUE (household_id, alexa_item_id),
  UNIQUE (household_id, kind, finta_id)
);
CREATE INDEX alexa_items_list ON alexa_items(household_id, alexa_list_id);

-- Deleting a Finta list forgets its pairing instead of deleting its items on Alexa.
CREATE TRIGGER alexa_items_list_deleted AFTER DELETE ON shopping_lists
BEGIN
  DELETE FROM alexa_items WHERE finta_list_id = OLD.id;
END;

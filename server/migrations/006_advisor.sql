-- Advisor tools: registered investment accounts, emergency-fund target, contribution room.
ALTER TABLE accounts ADD COLUMN registered TEXT CHECK (registered IN ('rrsp','tfsa','fhsa','resp'));  -- only for type 'investment'
ALTER TABLE households ADD COLUMN emergency_months INTEGER NOT NULL DEFAULT 3 CHECK (emergency_months BETWEEN 1 AND 24);

CREATE TABLE tax_room (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('rrsp','tfsa','fhsa')),
  room          INTEGER NOT NULL,          -- cents, from the CRA notice of assessment
  UNIQUE (household_id, user_id, year, kind)
);

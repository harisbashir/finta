-- 1.1.2: an account's balance is pinned to a known amount on a known date ("anchor"), so importing
-- older statements later never changes today's balance. Balance = anchor + everything after it.
-- Accounts without an anchor keep the old rule: opening balance + every transaction.
ALTER TABLE accounts ADD COLUMN anchor_balance INTEGER;
ALTER TABLE accounts ADD COLUMN anchor_date    TEXT;
ALTER TABLE accounts ADD COLUMN anchor_source  TEXT;   -- 'you' (typed in) | 'statement'

-- Taxes: CRA payments and instalments get their own category.
UPDATE categories SET sort = sort + 1 WHERE name = 'Other' AND kind = 'out'
  AND household_id NOT IN (SELECT household_id FROM categories WHERE name = 'Taxes');
INSERT INTO categories (household_id, name, kind, color, icon, sort)
  SELECT h.id, 'Taxes', 'out', 'gray', 'landmark',
         COALESCE((SELECT sort - 1 FROM categories c WHERE c.household_id = h.id AND c.name = 'Other' AND c.kind = 'out'), 17)
  FROM households h
  WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.household_id = h.id AND c.name = 'Taxes');

# Advisor tools — design

Date: 2026-10-26 · Status: approved in conversation, awaiting spec review

## Goal

Give every household four financial-advisor tools on one **Advisor** page (Money → Advisor), built from data Finta already has:

1. **Health check**: emergency fund, savings rate, debt-to-income, card utilisation, each with a target and one next step.
2. **Cash-flow forecast**: the chequing balance over the next 60 days, with a warning before it goes below $0.
3. **Fees & interest**: what banking cost over the last 12 months, by kind, with generic ways to save.
4. **Tax year (Canada)**: yearly totals that matter at tax time, and RRSP/TFSA/FHSA/RESP contributions against room and limits, exportable as CSV.

Today shows a warning card only when the forecast goes below $0 within 60 days.

## Constraints

- No npm dependencies. The server code follows the existing `server/lib/finance.js` style: SQL plus plain functions.
- **Scope** works as elsewhere in Money. `scope=household` counts everyone. `scope=me` counts the member's own accounts, debts and recurring items, and transactions where `TX_OWNER` is them. Another member's private accounts appear only in totals, never as rows. Advisor responses contain only totals and recurring/detected events; they never list transactions from private accounts.
- Amounts are integer cents, as everywhere in Finta.
- **Advice wording:** plain, generic suggestions ("a no-fee chequing account"). No bank or product brands. Each tool has a one-line note: "Estimates from your Finta data, not professional advice."
- **Yearly limits live in one table in code** (`server/lib/advisor/limits.js`) with the year and a source comment, so updating them each year is a one-line change. If no entry exists for a year, the latest known year's figures are used and marked "estimate".

| Year | TFSA | RRSP cap | FHSA annual / lifetime | RESP grant (CESG) |
|---|---|---|---|---|
| 2025 | $7,000 | $32,490 | $8,000 / $40,000 | 20% of the first $2,500 a year, $7,200 lifetime |
| 2026 | $7,000 | $33,810 | $8,000 / $40,000 | same |

Sources: Government of Canada TFSA dollar limits, reported in Investment Executive / Advisor.ca ("TFSA dollar limit to hold steady in 2026"); RRSP dollar limits from Investment Executive ("Registered plan contributions, conversations in 2026"). FHSA and CESG figures are unchanged since the programs began.

## Data — migration `006_advisor.sql`

```sql
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
```

- The account sheet shows a **Registered** picker (None, RRSP, TFSA, FHSA, RESP) when the account type is Investment. The `registered` column is validated with `t.oneOf` and cleared when the type isn't `investment`.
- `emergency_months` is set on the Advisor page by an owner, through `PATCH /api/advisor/settings`. The existing `PATCH /api/household` requires the name, so it isn't reused.
- `/api/export` includes `tax_room`. It's the household's own data, not a secret.

## 1. Health check — `server/lib/advisor/health.js`

`healthCheck(db, householdId, todayStr, { scope, userId }) → { metrics: Metric[], months }`

`Metric = { key, label, value, display, target, status: 'good'|'fair'|'poor'|'unknown', next }`

The window is the last 3 full calendar months before today's month. If there's less history than that, use the full months that exist (at least 1); with none, every metric is `unknown` with "Import a full month of statements to see this."

| Key | Value | Good / fair / poor | Next step (example) |
|---|---|---|---|
| `emergency` | months = liquid ÷ essential. **Liquid** = sum of positive balances of `chequing`, `savings` and `cash` accounts in scope (not archived). **Essential** = monthly average of spending in Housing, Utilities, Groceries, Insurance, Transport and Health (same rules as `monthSummary`: transfers excluded, refunds net) plus the sum of `min_payment` of debts in scope. | ≥ target · ≥ 1 · < 1, where the target is `households.emergency_months` | "Set aside $X a month to reach N months by <month>". X is the shortfall ÷ 12, rounded up to $25. |
| `savings` | (income − outflow) ÷ income over the window. Income = transactions in `in` categories plus recurring income received. Outflow = all spending including bills and debt payments, excluding transfers and goal contributions. | ≥ 20% · ≥ 10% · < 10% | "Saving 10% would mean $X more a month" |
| `dti` | sum of `min_payment` of debts in scope (monthly) ÷ average monthly income | ≤ 20% · ≤ 36% · > 36% | "Paying down <highest-rate debt> first saves the most interest" (links to Debts) |
| `utilization` | amount owed ÷ `accounts.credit_limit`, over `credit_card` and `line_of_credit` accounts in scope that have a limit. Owed = the negative of a negative balance. | < 30% · < 50% · ≥ 50% | "Bringing cards under 30% helps your credit score: pay $X" |

Metrics with no inputs (no income, no cards with limits) are `unknown` with a short reason.

## 2. Cash-flow forecast — `server/lib/advisor/forecast.js`

`forecast(db, householdId, todayStr, { scope, userId, days = 60 }) → { start, points: [{date, balance}], low: {date, balance}, events: Event[], basis, warning }`

- **Accounts:** chequing accounts in scope, not archived. With none: `{ basis: 'no-chequing' }`. The start is the sum of their current balances (`accountBalances`).
- **Known events** within (today, today+days]:
  - **Recurring items in scope** (not paused). Occurrences not yet settled, with each unpaid occurrence placed on its due date. Overdue unpaid occurrences within the last 7 days are placed on today. Amount `+` for `in`, `−` for `out`. `source: 'bill'`.
  - **Detected repeats:** `recurringSuggestions(db, householdId, todayStr, { limit: Infinity })`, which gains a `limit` option (default 12, unchanged for its existing caller). An item is kept only if its `merchant` has a transaction on an in-scope chequing account in the last 90 days. Next dates come from `last_date` plus the item's `frequency`, repeated through the window. `source: 'detected'`.
- **Typical day:** over the last 90 days of chequing transactions, excluding rows linked to a recurring item, rows whose merchant matches a detected repeat used above, and transfers *between in-scope chequing accounts*:
  - `typicalIn` = sum of other inflows ÷ 90
  - `typicalOut` = sum of other outflows ÷ 90
  
  Card payments, other transfers and e-transfers are included, because they move chequing money. Each future day adds `typicalIn − typicalOut`.
  - With fewer than 30 days of history: no typical day, and `basis: 'events-only'` with a note.
- **Points:** one per day: start + cumulative events + cumulative typical. `low` = the minimum point.
- **Warning:**
  - `{ level: 'danger', date }` if `low.balance < 0`.
  - Otherwise `{ level: 'watch' }` if `low.balance < 10000` ($100).
  - Otherwise `null`.
- `events`: the next 15 known events: `{ date, name, amount, direction, source }`.

## 3. Fees & interest — `server/lib/advisor/fees.js`

`feesReport(db, householdId, todayStr, { scope, userId }) → { from, to, total, byKind: [{kind, label, amount, count}], suggestions: [{kind, text, saving}] }`

Window: the last 365 days. Rows are in-scope transactions, `out`, not transfers.

| Kind | Rows |
|---|---|
| `account_fees` | category Fees & Interest and text matching SERVICE CHARGE, MONTHLY FEE, ACCOUNT FEE, PLAN FEE, MTHLY, FRAIS, MONTHLY FIXED |
| `overdraft_nsf` | text matching OVERDRAFT, NSF, NON-SUFFICIENT, OD INTEREST |
| `interest` | text matching INTEREST, INTERETS (excluding overdraft, which is counted above) |
| `annual_fees` | text matching ANNUAL FEE |
| `atm` | text matching ATM FEE, NETWORK FEE, ABM FEE |
| `fx` | **estimated**: 2.5% of `out` rows whose description has a foreign-currency tail (`<amount> <CCY> @ <rate>`) |

- Rebates (`in` rows in Fees & Interest such as "SERVICE CHARGE DISCOUNT" or "ANNUAL FEE REBATE") are subtracted from the matching kind and never go below 0.
- **Suggestions**, only when the kind is above $0:
  - account fees: "A no-fee chequing account would save about $X a year."
  - overdraft/NSF: "Watch the forecast on Today: it warns before you go below $0." Plus "Ask your bank for overdraft protection or low-balance alerts."
  - interest: "Paying card balances in full each month avoids this; for balances you carry, a lower-rate line of credit costs less." Links to Debts.
  - annual fees: "Check that the card's rewards are worth $X a year."
  - fx: "A card with no foreign-transaction fee would save about $X a year."

## 4. Tax year — `server/lib/advisor/tax.js`

`taxYear(db, householdId, year, { scope, userId }) → { year, people: [Person], estimate: boolean }`

`Person = { user_id, name, totals: { charity, medical, tuition, kids }, contributions: [{ kind, amount, room, limit, remaining }], resp: { contributed, grant } }`

- **People:**
  - `scope=me`: only the member.
  - `household`: every member.
  - Rows belong to a person by `TX_OWNER`. Joint rows (owner NULL) are listed once as "Joint" in the totals.
- **Totals for the calendar year:** spending (`out` minus refunds) in the categories named **Charity** or **Gifts** (charity), **Health** (medical), **Education** (tuition) and **Kids** (labelled "check which are childcare"). A missing category gives 0.
- **Contributions:**
  - `in` transactions on accounts with `registered` set, owned by the person, with `is_transfer = 1` or any inflow. Interest and dividends aren't counted: rows whose category kind is `in` with names Other Income/Salary are excluded.
  - **RRSP** counts Mar 2 of `year` through Mar 1 of `year+1` (the first 60 days rule, simplified to Mar 1). TFSA, FHSA and RESP count the calendar year.
  - `room` comes from `tax_room` for (person, year, kind). `limit` comes from `limits.js`. `remaining = room − amount` when room is set, otherwise `null`.
  - **RESP:** `grant = min(contributed, 250000) × 20%`, labelled "estimated CESG".
- **CSV:** `GET /api/advisor/tax/:year.csv` has one row per person per line item, with a `Content-Disposition` attachment, following the `/api/export` pattern.

## Routes — `server/routes/advisor.js`

| Method | Path | Returns |
|---|---|---|
| GET | `/api/advisor?scope=` | `{ health, forecast, fees, emergencyMonths }`. Tax isn't included because it's per year. |
| GET | `/api/advisor/tax?year=&scope=` | `taxYear(...)`. The default year is the previous year until Apr 30, then the current one. |
| GET | `/api/advisor/tax/:year.csv?scope=` | CSV |
| PUT | `/api/advisor/room` | `{ user_id, year, kind, room }`. A member may set their own room. An owner may set anyone's. |
| PATCH | `/api/advisor/settings` | `{ emergency_months }`, owner only |

`/api/today` gains `cashWarning` = the `forecast(...).warning` plus `low`, for scope `me`, so each member sees their own chequing.

## Interface

- **Money overview:** a new nav row **Advisor** (icon `trending-up`, color `green`), whose subtitle is the worst health status ("2 things to look at" or "Looking good").
- **`#/money/advisor`:** a large title "Advisor", the scope switch, then four sections:
  1. **Health:** 4 stat tiles (value, a colored dot for status with its text, target), each with the next step under it. An owner sees an "Emergency fund target: N months" stepper.
  2. **Cash Flow:** a line chart (existing `charts.js`), 60 days, with a zero line, the low point marked, and the next 15 events listed. A warning row if a warning exists.
  3. **Fees & Interest:** the total for 12 months, a breakdown list, and suggestions.
  4. **Tax Year:** a year picker, per-person groups with totals, contributions against room (with editable room fields), the RESP grant, and **Export CSV**.
  
  The page ends with a section foot: "Estimates from your Finta data, not professional advice."
- **Account sheet:** the Registered picker for Investment accounts.
- **Today:** when `cashWarning.level === 'danger'`, a red row at the top: "Chequing may go below $0 around <date>", linking to the Advisor. For `watch`, an orange row.

## Testing

All tests use `node:test` with an in-memory database (`openDatabase(':memory:')`) and seeded rows.

- `test/advisor-health.test.js`:
  - known balances and spending give emergency months, savings rate, debt-to-income and utilisation
  - the status thresholds
  - `unknown` when there's no history
  - scope `me` excludes another member's accounts and debts
- `test/advisor-forecast.test.js`:
  - payday and rent events land on the right days
  - the typical day comes from 90 days of history excluding events and internal transfers
  - an overdraft gives `danger` with the right date
  - fewer than 30 days of history gives `events-only`
  - no chequing account gives `no-chequing`
  - detected repeats are included once and aren't double counted with the typical day
- `test/advisor-fees.test.js`:
  - rows sorted into kinds
  - rebates netted
  - the FX estimate from foreign-currency tails
  - suggestions only for kinds above zero
- `test/advisor-tax.test.js`:
  - category totals for the year
  - the RRSP Mar-1 window
  - room and remaining
  - the RESP grant cap
  - a limits fallback year is marked `estimate`
  - CSV content
- `test/advisor-routes.test.js`:
  - permissions for room and emergency months
  - privacy: no response lists another member's private-account transactions
  - `/api/today` includes `cashWarning`
  - migration 006 applies on an existing database

## Out of scope

Investment returns, budgeting changes, bank or product recommendations, provincial tax credits, automatic room calculation (room comes from the CRA notice), and notifications outside the app.

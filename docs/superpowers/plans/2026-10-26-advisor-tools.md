# Advisor Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Advisor page (Money → Advisor) with a health check, a 60-day cash-flow forecast, a fees & interest report and a Canadian tax-year summary, plus an overdraft warning on Today.

**Architecture:**
- Four modules in `server/lib/advisor/` (`health.js`, `forecast.js`, `fees.js`, `tax.js`), plus `limits.js` for the yearly limits. Each module is a set of functions that query the database and return plain objects.
- `server/routes/advisor.js` serves them.
- One new view module, `public/js/views/advisor.js`, renders them, mounted from Money.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`), `node:test`, plain ES-module front end, the existing `charts.js` `lines()`.

**Spec:** `docs/superpowers/specs/2026-10-26-advisor-tools-design.md`. Every formula, threshold, window and response shape below comes from it; read it first.

**Running tests:**
- Use `PATH=/tmp/claude-1000/-home-haris-development-github-finta/cdc673fa-1662-4ef5-a657-b5b1cad5bd34/scratchpad/node/cur/bin:$PATH npm test`. The system Node is v18.
- One file: `node --disable-warning=ExperimentalWarning --test test/advisor-health.test.js`.

## Global Constraints

- **No npm dependencies.** Amounts are integer cents. Dates are `YYYY-MM-DD` strings, computed with `server/lib/dates.js`.
- **Scope:** `scope=household|me` as in `server/lib/finance.js`, using `scopeFilter`, `TX_OWNER` and `TX_JOINS`. Advisor responses never list rows from another member's private accounts, only totals and recurring or detected events.
- **Test data:** made-up data only. The repo is public: no real statement lines.
- **Wording:** generic advice with no bank or product brands. Every tool section ends with "Estimates from your Finta data, not professional advice."
- **Limits:**
  - 2025: TFSA 700000, RRSP 3249000, FHSA 800000 per year and 4000000 lifetime.
  - 2026: TFSA 700000, RRSP 3381000, FHSA 800000 / 4000000.
  - RESP grant: 20% of the first 250000 per year.
  - A year without an entry uses the latest year's figures, with `estimate: true`.
- **Thresholds:**

  | Metric | Good | Fair | Poor |
  |---|---|---|---|
  | Emergency fund | ≥ target | ≥ 1 month | < 1 month |
  | Savings rate | ≥ 20% | ≥ 10% | < 10% |
  | Debt-to-income | ≤ 20% | ≤ 36% | > 36% |
  | Card utilisation | < 30% | < 50% | ≥ 50% |

  Forecast warning: `danger` if the low point is below 0, `watch` if it's below 10000.
- **Windows:**
  - health: the last 3 full months, or whatever full months exist, at least 1
  - forecast: 60 days ahead, with a typical day computed from the last 90 days and 30 days of history required
  - fees: the last 365 days
  - RRSP contribution year: Mar 2 of the year through Mar 1 of the next year

## Review Focus

1. **A household that just imported part of a month** (no full month yet): health is `unknown`, the forecast is `events-only`, and nothing divides by zero or returns NaN. *Tests: Tasks 2 and 3.*
2. **Transfers between your own accounts** (chequing to card payment, chequing to savings) never count as spending, income or fees in any tool. Between two in-scope chequing accounts they don't affect the forecast's typical day. *Tests: Tasks 2, 3 and 4.*
3. **Scope `me` with a partner's private account:** totals may include it in household scope only. No row-level data from it reaches any advisor response. *Test: Task 6.*
4. **Refunds and rebates** reduce their category or fee kind and never push a total below 0. *Tests: Tasks 2 and 4.*
5. **A detected repeat that's also a tracked bill** is counted once in the forecast. *Test: Task 3.*

---

### Task 1: Schema, limits, and registered accounts

**Files:**
- Create: `server/migrations/006_advisor.sql` (SQL from the spec)
- Create: `server/lib/advisor/limits.js`
- Modify:
  - `server/routes/accounts.js`: add `registered: t.oneOf(['rrsp','tfsa','fhsa','resp'], { label: 'registered type' })` to `accountSchema`. In create and patch, force `registered = null` unless the resulting type is `investment`.
  - `server/lib/importer.js`: `recurringSuggestions(db, householdId, todayStr, { limit = 12 } = {})`, with the final `.slice(0, limit)`.
  - `server/routes/household.js`: add `tax_room: all('tax_room')` to `/api/export`.
- Test: `test/advisor-routes.test.js` (created here)

**Interfaces:**
- Produces:
  - `limitsFor(year) → { year, tfsa, rrsp, fhsa, fhsaLifetime, respGrantRate: 0.2, respGrantBase: 250000, estimate }`
  - DB columns `accounts.registered` and `households.emergency_months`, and the table `tax_room`
  - `recurringSuggestions(…, { limit })`

- [ ] **Step 1: Write the failing tests** (server with `OWNER` set up):
  - `investment account can be marked TFSA; a chequing account cannot keep registered`: POST an investment account with `registered: 'tfsa'` and expect `registered === 'tfsa'`. PATCH its type to `chequing` and expect `registered === null`.
  - `limitsFor`: `limitsFor(2026).rrsp === 3381000`; `limitsFor(2030).estimate === true` with `tfsa === 700000`.
  - `export includes tax_room`
- [ ] **Step 2: Run** `node --test test/advisor-routes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, then `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(advisor): schema, limits, registered accounts`.

### Task 2: Health check

**Files:**
- Create: `server/lib/advisor/health.js`
- Create: `test/advisor-helpers.js`: `makeHousehold(db) → { hid, owner, member, cat: (name) => id, account: (fields) => id, tx: (fields) => id, debt: (fields) => id }`. It creates a household, uses `seedHousehold(db, hid)` from `server/seed.js` for the default categories, and creates two users.
- Test: `test/advisor-health.test.js`

**Interfaces:**
- Consumes: `accountBalances` and `TX_JOINS`, `TX_OWNER`, `scopeFilter` from `finance.js`; `monthRange`, `addMonths` from `dates.js`.
- Produces: `healthCheck(db, householdId, todayStr, { scope = 'household', userId = null } = {}) → { months: number, target: number, metrics: [{ key, label, value, display, target, status, next }] }`. The keys are, in order: `emergency`, `savings`, `dti`, `utilization`.

- [ ] **Step 1: Write the failing tests.** Today is 2026-04-15, so the window is Jan to Mar 2026.
  - `emergency months`:
    - chequing balance 300000, savings 300000
    - Housing 150000 a month and Groceries 50000 a month for 3 months
    - one debt with `min_payment` 0
    - Expected: value 3.0, status `good` (target 3), `display` "3.0 months".
  - `emergency poor + next step`: liquid 100000 and the same spending → status `poor`. `next` contains "a month".
  - `savings rate`: Salary 500000 a month for 3 months, spending 400000 a month → value 0.2, status `good`. A chequing → card payment marked `is_transfer=1` doesn't change it.
  - `refund nets spending`: a Shopping refund (`in`, kind-`out` category) lowers outflow and never pushes it below 0.
  - `dti`: debts with min_payment 60000 + 40000, income 500000 → 0.2, status `good`.
  - `utilization`: card account with `credit_limit` 1000000 and balance −450000 → 0.45, status `fair`.
  - `no history → unknown` for all four, and no NaN in any value.
  - `scope me excludes the member's private account and debts`.
- [ ] **Step 2: Run** `node --test test/advisor-health.test.js`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `healthCheck`.** Use the formulas in the spec's table. `next` texts follow the spec's examples. Emergency X = (target × essential − liquid) ÷ 12, rounded up to 2500 cents.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(advisor): health check`.

### Task 3: Cash-flow forecast

**Files:**
- Create: `server/lib/advisor/forecast.js`
- Test: `test/advisor-forecast.test.js`

**Interfaces:**
- Consumes: `makeHousehold` (Task 2), `recurringSuggestions(…, { limit: Infinity })` (Task 1), `occurrences`, `addDays` and `diffDays` from `dates.js`, `accountBalances`.
- Produces: `forecast(db, householdId, todayStr, { scope = 'household', userId = null, days = 60 } = {}) → { basis: 'full'|'events-only'|'no-chequing', start, points: [{date, balance}], low: {date, balance}|null, events: [{date, name, amount, direction, source}], warning: {level, date}|null, typical: {in, out}|null }`

- [ ] **Step 1: Write the failing tests.** Today is 2026-04-15.
  - `no chequing → basis no-chequing`
  - `events land on their days`:
    - chequing balance 100000
    - recurring Salary +300000 monthly, starting 2026-01-01
    - recurring Rent −250000 monthly, starting 2026-01-01
    - fewer than 30 days of history
    - Expected: `basis` `events-only`, the point on 2026-05-01 = 100000 + 300000 − 250000, and the events list starts with 2026-05-01.
  - `overdraft warning`: start 50000, Rent −250000 on 2026-05-01 with no income → `warning.level` `danger`, `warning.date` `2026-05-01`, `low.balance` −200000.
  - `watch`: low point between 0 and 9999 → `watch`.
  - `typical day`:
    - 90 days of history with −1000 every day, not recurring
    - plus one transfer between two in-scope chequing accounts (excluded)
    - plus a card payment from chequing (included)
    - Expected: `typical.out` = (90 × 1000 + card payment) ÷ 90, rounded to an integer.
  - `detected repeat counted once`:
    - a merchant with 4 monthly −5000 rows on chequing, which becomes a detected repeat
    - Expected: it appears in `events` with `source` `detected`, and its rows are excluded from the typical day.
    - If the same merchant is also a tracked recurring item (rows linked with `recurring_id`), it appears only as `bill`.
  - `scope me uses only the member's chequing`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `forecast` per the spec.** Repeated events stop at today+days. Overdue unpaid recurring occurrences from the last 7 days go on today. Round the typical values with `Math.round`.
- [ ] **Step 4: Run it, then `npm test`** (because Task 1 changed `recurringSuggestions`). Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(advisor): cash-flow forecast`.

### Task 4: Fees & interest

**Files:**
- Create: `server/lib/advisor/fees.js`
- Test: `test/advisor-fees.test.js`

**Interfaces:**
- Produces: `feesReport(db, householdId, todayStr, { scope = 'household', userId = null } = {}) → { from, to, total, byKind: [{ kind, label, amount, count }], suggestions: [{ kind, text, saving }], fxEstimated: boolean }`
- The kinds are `account_fees`, `overdraft_nsf`, `interest`, `annual_fees`, `atm` and `fx`. Labels: "Account fees", "Overdraft & NSF", "Interest", "Annual fees", "ATM fees", "Foreign exchange (est.)".

- [ ] **Step 1: Write the failing tests.** Today is 2026-10-15.
  - `kinds`:
    - rows: "SERVICE CHARGE" 1595 ×12, "OVERDRAFT INTEREST CHARGE" 200, "NON-SUFFICIENT FUNDS CHARGE" 4500, "PLC INTEREST CHARGED" 4000 ×12, "ANNUAL FEE" 12000, "ATM FEE" 300
    - all of them `out` in Fees & Interest
    - Expected: `account_fees` 19140, `overdraft_nsf` 4700, `interest` 48000, `annual_fees` 12000, `atm` 300.
  - `rebates net and floor at 0`: "SERVICE CHARGE DISCOUNT" `in` 1595 ×12 → `account_fees` 0, not negative.
  - `fx estimate`: Shopping row "LEVI'S OUTLET LONDON 100.00 GBP @ 1.800000" amount 18000 → `fx` 450 and `fxEstimated` true.
  - `transfers ignored`: an `is_transfer=1` row whose text contains "INTEREST" isn't counted.
  - `rows older than 365 days ignored`
  - `suggestions only for kinds above zero`, with text that contains no bank names.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.** Match kinds on the upper-cased `description || note`, using the spec's patterns in the order overdraft_nsf, annual_fees, atm, account_fees, then interest. FX regex: `/\d[\d,]*\.\d+\s+[A-Z]{3}\s+@\s+[\d.]+\s*$/`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(advisor): fees and interest report`.

### Task 5: Tax year

**Files:**
- Create: `server/lib/advisor/tax.js`
- Test: `test/advisor-tax.test.js`

**Interfaces:**
- Consumes: `limitsFor` (Task 1).
- Produces:
  - `taxYear(db, householdId, year, { scope = 'household', userId = null } = {}) → { year, estimate, people: [{ user_id, name, totals: { charity, medical, tuition, kids }, contributions: [{ kind, amount, room, limit, remaining }], resp: { contributed, grant } }] }`
    - In household scope, joint rows form a last "person" with `user_id: null` and `name: 'Joint'`, and that person has no contributions.
  - `taxCsv(result) → string`, with the header `person,section,item,amount`. Amounts are in dollars with 2 decimals.
  - `defaultTaxYear(todayStr) → number`: before May 1 the previous year, otherwise the current year.

- [ ] **Step 1: Write the failing tests.**
  - `totals by category`: Charity 10000 + Gifts 5000 → charity 15000. A Health refund lowers medical. Education 300000 → tuition.
  - `RRSP window`: a deposit to the owner's RRSP on 2026-02-20 counts for 2025, not 2026; one on 2026-03-05 counts for 2026.
  - `TFSA room and remaining`: a `tax_room` row with 700000, deposits of 200000 → remaining 500000, limit 700000.
  - `interest inside a TFSA is not a contribution`: an `in` row in Other Income doesn't count.
  - `RESP grant capped`: contributions of 400000 → grant 50000.
  - `scope me` → only the member.
  - `estimate` for 2030.
  - `CSV has a header and a row per item`.
  - `defaultTaxYear('2026-04-30') === 2025`, and `defaultTaxYear('2026-05-01') === 2026`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(advisor): tax-year summary`.

### Task 6: Routes and Today warning

**Files:**
- Create: `server/routes/advisor.js`
- Modify:
  - `server/app.js`: register `advisorRoutes(router)`.
  - `server/routes/home.js`: in `/api/today`, add `cashWarning: (({ warning, low }) => warning ? { ...warning, low } : null)(forecast(ctx.db, hid, d, { scope: 'me', userId: ctx.user.id }))`.
- Test: `test/advisor-routes.test.js`, adding to the Task 1 file.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: the endpoints in the spec's Routes table:
  - `GET /api/advisor` → `{ health, forecast, fees, emergencyMonths }`
  - `GET /api/advisor/tax`
  - `GET /api/advisor/tax/:year.csv`. The router needs a pattern that captures `:year`. Validate it as `^\d{4}$`, otherwise 404.
  - `PUT /api/advisor/room`. Validation: `user_id` is a member of the household; `year` is 2009–2100; `kind` is one of rrsp, tfsa, fhsa; `room` is `t.money`. A non-owner may only set their own room.
  - `PATCH /api/advisor/settings` with `{ emergency_months }`, 1–24, owner only.

- [ ] **Step 1: Write the failing tests.**
  - `GET /api/advisor shape`: has keys `health`, `forecast`, `fees`, `emergencyMonths`, and `emergencyMonths` is 3.
  - `member cannot change emergency months (403)`; owner sets it to 6 and GET reflects that.
  - `member can set own room, not the owner's (403)`
  - `tax CSV`: status 200, `text/csv` content type, attachment filename `finta-tax-2025.csv`.
  - `privacy`:
    - the owner has a private chequing account with an e-transfer described "SECRET-PAYEE"
    - the member's `GET /api/advisor?scope=household` and `/api/advisor/tax?scope=household` don't contain "SECRET-PAYEE"
  - `/api/today has cashWarning`: the owner's chequing at 1000 with rent 250000 due in 10 days → `cashWarning.level` is `danger`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it, then `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(advisor): routes and Today cash warning`.

### Task 7: Interface, docs, version

**Files:**
- Create: `public/js/views/advisor.js`, exporting `mountAdvisor(v)`.
- Modify:
  - `public/js/views/money.js`: add `advisor: 'Advisor'` to `PAGES`. In `mount`, `if (page === 'advisor') return (await import('./advisor.js')).mountAdvisor(v);`. Add the overview row `navRow('#/money/advisor', 'trending-up', 'green', 'Advisor', <summary>)`, where the summary comes from `GET /api/advisor` (count of `poor` or `fair` metrics: "2 things to look at", otherwise "Looking good").
  - `public/js/views/accounts.js`: in `accountSheet`, an `fSelect('registered', 'Registered', [['', 'None'], ['rrsp','RRSP'], ['tfsa','TFSA'], ['fhsa','FHSA'], ['resp','RESP']])`, shown only while the type select is `investment`.
  - `public/js/views/today.js`: a warning row at the top when `t.cashWarning` exists (`text-neg` for danger, `text-warn` for watch), linking to `#/money/advisor`.
  - `README.md` (Features table row "Advisor"), `CHANGELOG.md` (1.3.0), `package.json` (1.3.0).
- No automated front-end tests; there's no front-end test setup.

**Approach**
- Reuse `scopeSwitch`/`getScope` from `money.js` (export them if they aren't exported).
- **Health:** a `.tile-stat` grid with value, status dot and text, target, and the next step. Owners get a stepper for the emergency target.
- **Cash flow:** `lines()` with a single series. The zero line is a second, flat series named "$0". The low point is shown in the section head as "Lowest: $X on Oct 30". Then an events list.
- **Fees:** the total, rows per kind, and a suggestions list.
- **Tax:** a year `fSelect` (current year and the 3 before it); per person, groups of totals; contribution rows with room as an editable money field that saves on blur through `PUT /api/advisor/room`; and an Export CSV link to `/api/advisor/tax/<year>.csv?scope=`.
- Every section ends with `<p class="section-foot">Estimates from your Finta data, not professional advice.</p>`.

- [ ] **Step 1: Implement the UI.**
- [ ] **Step 2: Check it.**
  1. Run `node --check` on the changed files.
  2. Run the dev server (Node 22, `DATA_DIR` in the scratchpad), set up with sample data, then `curl` `/api/advisor` and `/api/advisor/tax` and check that the JSON has numbers rather than NaN or null where data exists.
  3. Fetch `/js/views/advisor.js` and expect 200.
- [ ] **Step 3: Update docs and version.**
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(advisor): Advisor page, Today warning, account registered type; v1.3.0`.

### Task 8: Deploy and look at it with the user

- [ ] **Step 1:** Push the branch, then on the server: back up, `git checkout advisor-tools && git pull`, `docker compose up -d --build`, and check health.
- [ ] **Step 2:** Ask the user to open Money → Advisor in light and dark mode and at phone width, after importing their statements, and confirm that the numbers make sense. Fix anything reported.

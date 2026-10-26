# Finta — notes for Claude

A self-hosted household money, chores, lists and meals app. One container, plain Node.js, SQLite. See README.md for features and DESIGN.md for the UI rules (Apple HIG translated to the web).

## Ground rules

- **Zero npm dependencies.** Node ≥ 22.13 built-ins only (`node:sqlite`, `fetch`, `node:crypto`, `node:test`). The front end is plain ES modules with no build step. Don't add packages.
- **This repo is public.** Tests, fixtures, docs and commit messages use **made-up data only**. Never paste real statement lines, card numbers (even masked), names, amounts or places from a user's files.
- **Money is integer cents; dates are `YYYY-MM-DD` strings.** Use `server/lib/dates.js` for date math, never `Date` arithmetic on local time.
- **Every query is scoped to the household** (`household_id = ?`). References between rows are checked on write (`t.ref`, `getOwned`).
- **Privacy within a household:** a member's private account (`accounts.is_private`) shows others its balance and totals, never its rows. That includes names, notes and payees derived from those rows: suggestions, forecast events and anything else. Use `canSeeAccount`, `TX_VISIBLE` and `TX_OWNER` / `scopeFilter` from `server/lib/finance.js`. Scope is `household` or `me` (Just Me).
- **Secrets never leave the server.** Alexa tokens live in `alexa_links.login` and are never sent to clients, never logged, and kept out of `/api/export`, which lists its tables one by one on purpose.

## Commands

```bash
npm test        # node:test suites in test/ — run the whole suite before calling anything done
npm run dev     # http://localhost:3000, restarts on change; setup code is printed
npm run cli     # backup, reset-password, disable-2fa, unlock
```

## Layout

- `server/app.js`: request pipeline. Security headers, then static, auth, CSRF (`X-Finta: 1` plus Origin), then routes. After a successful write to lists or tasks it calls `app.alexa.requestSync`.
- `server/routes/*.js`: one file per area. Use the `crud()` helper for simple resources.
- `server/lib/`:
  - `finance.js`: the money model and scope helpers
  - `importer.js`, `csv.js`, `merchant.js`: statement import
  - `alexa/`: Amazon client, sync planner, runner
  - `advisor/`: health, forecast, fees, tax, limits
- `server/migrations/NNN_name.sql`: applied in order at startup, once each. **Never edit a migration that has shipped**; add the next number.
- `public/js/views/*.js`: one module per screen. `public/js/ui.js` has `html` (escaping tagged template), sheets, form fields and toasts.
- `docs/superpowers/specs` and `plans`: design specs and implementation plans for larger features.

## Conventions

- 2-space indentation, single quotes, short `//` comments that say why. Validation through `t.*` in `server/lib/validate.js`. `tx(db, fn)` for multi-statement writes.
- Write the failing test first. Library code gets unit tests on an in-memory database: `openDatabase(':memory:')`, or `test/advisor-helpers.js` `makeHousehold()`. Routes get tests through `test/helpers.js` `startServer()` / `client()`.
- Every user-facing change gets a `CHANGELOG.md` entry and a version bump in `package.json`.
- UI copy: plain sentences, Title Case for buttons and rows, no jargon. Advisor text is generic advice with no bank or product brands, and ends with "Estimates from your Finta data, not professional advice."

## Statement import (`server/lib/merchant.js`)

- `merchantKey()` strips the bank's channel wording ("Point of Sale - Visa Debit…", "Electronic Funds Transfer PAY…", "Paiement facture - AccèsD…"), store numbers, towns and foreign-currency tails, so one shop gets one key. Rules learned in Review match keys with `includes`.
- `guessCategory()` uses `DICTIONARY`, where the **first match wins**: order matters, and specific entries go before general ones.
- Add new bank wording or billers with a test in `test/merchant.test.js` or `test/banks.test.js`.

## Alexa (`server/lib/alexa/`)

Amazon's public list API closed in 2024. `client.js` speaks the private API used by the Alexa app, ported from [aioamazondevices](https://github.com/chemelli74/aioamazondevices). Everything Amazon-specific stays in `client.js`. Lessons from the live account:

- Sign-in always happens on **www.amazon.com**, whatever the country. amazon.ca answers 404 to the app's OAuth sign-in. The lists site comes from `alexa.amazon.com/api/welcome` afterwards.
- Amazon may skip the texted code and redirect straight to `/ap/maplanding?openid.oa2.authorization_code=…`. Read the code from any step's redirect.
- List item fetch: page size must be **below 200** (`limit=100`). The response has a `nextToken`; paging isn't implemented.
- Reminders come from `alexa.<site>/api/notifications`: `triggerTime` comes back as `0`, and a repeating reminder's next time is an ISO string in `rRuleData.nextTriggerTimes`.
- On sign-in failures the server logs the *shape* of the page (`describe()`: title, form ids, field names; never values). Debug from that.

## Advisor (`server/lib/advisor/`)

- `limits.js` holds the TFSA, RRSP and FHSA limits and the RESP grant by year. **Update it every year**, with the source in the comment. Years after the newest entry are marked `estimate`.
- The forecast starts from the last day with chequing data (`asOf`), not necessarily today. Today shows a warning only when it goes below $0.

## Deploying

`bash scripts/update.sh` on the server: it backs up, pulls, rebuilds and checks health. Migrations run on start. The container's root filesystem is read-only. Run one-off scripts with `docker compose exec -T finta node --input-type=module - < script.mjs`.

# Alexa List Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Alexa's Shopping, custom and To-do lists in two-way sync with Finta's shopping lists and tasks.

**Architecture:**
- **`client.js`** is the only file that talks to Amazon, using the unofficial API ported from `aioamazondevices`.
- **`sync.js`** is a pure function that compares Finta rows and Alexa items against stored snapshots and returns a list of actions.
- **`runner.js`** runs `plan()`, applies its actions to both sides, and schedules syncs (every 10 minutes, when Lists or Tasks is opened, and after Finta changes).
- **Routes and a Settings screen** let an owner connect and disconnect.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, global `fetch`, `node:crypto`), `node:test`, plain ES-module front end. No npm packages.

**Spec:** `docs/superpowers/specs/2026-10-26-alexa-list-sync-design.md`. Read it first. It holds the Amazon request details (OAuth parameters, register body, token refresh) that this plan only refers to. The reference implementation is `aioamazondevices` (`src/aioamazondevices/login.py`, `http_wrapper.py`, `implementation/todo.py`, `const/http.py`) at https://github.com/chemelli74/aioamazondevices.

**Running tests:** the local Node is v18, so use `PATH=<node22>/bin:$PATH npm test`. A portable Node 22 is unpacked at `/tmp/claude-1000/-home-haris-development-github-finta/cdc673fa-1662-4ef5-a657-b5b1cad5bd34/scratchpad/node/cur/bin`. One file: `node --disable-warning=ExperimentalWarning --test test/alexa-sync.test.js`.

## Global Constraints

- Zero npm dependencies. HTML forms are parsed with regex.
- Only `role = 'owner'` can connect, disconnect or change Alexa settings. Any member can read the status and trigger a sync.
- Amazon tokens, cookies and passwords never appear in an API response, in `/api/export`, or in a log line. The Amazon password is never stored.
- Background interval: **10 minutes**. A view sync is skipped if the last sync was **< 60 s** ago. A change sync is debounced by **2 s**. A pending login lives for **5 minutes**.
- Connect and code limit: **5 attempts per household per 15 minutes**.
- Amazon request timeout: **20 s**. Cookies refresh when older than **12 h**, or once after a 401 or 403.
- Conflict, where both sides changed: **Alexa wins**.
- Amazon app name in register and token calls: `Finta`. Device type `A2IVLV5VM2W81`, app version `2.2.663733.0`, OS version `18.5`, software version `35602678`. These are the library's values.
- Sign-in site `https://www.amazon.ca`. Global API `https://api.amazon.com`. Alexa site discovery `https://alexa.amazon.ca/api/welcome`. Language `en-CA`.
- Finta name limits: shopping item 80 characters, task title 120 characters. Names pulled from Alexa are trimmed to fit.
- Match the code style of the codebase: 2-space indentation, single quotes, brief `//` comments, `t.*` validators, `tx()` for transactions.

## Review Focus

1. **Duplicate names on one side** (two "milk" on Alexa): matching pairs one-to-one and never folds two items into one Finta row. *Test: Task 2.*
2. **Changing the Shopping List pairing, or deleting a Finta list,** must not delete anything on Alexa. Snapshots are scoped by `finta_list_id`, and orphaned snapshots are dropped, not treated as deletes. *Test: Task 4.*
3. **One Alexa call failing mid-run:** the other actions still apply, the failed action's snapshot stays as it was, `last_error` is set, and the timer never throws an unhandled rejection. *Test: Task 4.*
4. **Disconnecting while a sync is running:** the run must not write snapshots or `alexa_links` back afterwards. *Test: Task 4.*
5. **An Alexa name that is too long or blank:** it's trimmed to the Finta limit, and a blank item is ignored rather than failing validation. *Test: Task 2.*

---

### Task 1: Schema

**Files:**
- Create: `server/migrations/004_alexa.sql`
- Test: `test/alexa-routes.test.js` (created here, and added to in Task 5)

**Interfaces:**
- Produces:
  - table `alexa_links`, exactly as in the spec
  - table `alexa_items`, as in the spec plus a column `finta_list_id INTEGER`. That column is NULL for tasks and set to `shopping_lists.id` for items. It is used for Review Focus #2.

- [ ] **Step 1: Write the failing test** `migration creates alexa tables and export leaves them out`:
  - start the server and set up `OWNER`
  - insert an `alexa_links` row and an `alexa_items` row directly through `srv.db`
  - `GET /api/export`, parse the body, and assert there's no `alexa_links` or `alexa_items` key
  - assert the body text doesn't contain the fake refresh token string
- [ ] **Step 2: Run it.** Expected: FAIL with `no such table: alexa_links`.
- [ ] **Step 3: Write `004_alexa.sql`.** Use the spec's SQL plus `finta_list_id INTEGER` and `CREATE INDEX alexa_items_list ON alexa_items(household_id, alexa_list_id)`.
- [ ] **Step 4: Run the test, then `npm test`.** Expected: all pass, and the 55 existing tests still pass.
- [ ] **Step 5: Commit** with message `feat(alexa): add alexa_links and alexa_items tables`.

### Task 2: Sync engine

**Files:**
- Create: `server/lib/alexa/sync.js`
- Test: `test/alexa-sync.test.js`

**Interfaces:**
- Produces: `plan({ finta, alexa, snapshots, maxName }) → Action[]`
  - `finta`: `{ id, name, checked, repeat }[]`. `repeat` is `'none'` for shopping items.
  - `alexa`: `{ itemId, name, checked, version }[]`
  - `snapshots`: `{ fintaId, itemId, name, checked, version }[]`
- `Action` is one of:

```js
{ op: 'alexa.add',      fintaId, name, checked }
{ op: 'alexa.update',   fintaId, itemId, version, name, checked }
{ op: 'alexa.delete',   itemId, version }
{ op: 'finta.add',      itemId, version, name, checked }
{ op: 'finta.update',   fintaId, itemId, version, name, checked }
{ op: 'finta.roll',     fintaId, itemId, version, name }   // repeating task ticked on Alexa
{ op: 'finta.delete',   fintaId, itemId }
{ op: 'link',           fintaId, itemId, version, name, checked }   // pair without changing either side
{ op: 'unlink',         itemId }
```

- Also exports `sameName(a, b)`: case-insensitive comparison of trimmed names with inner whitespace collapsed.

**Algorithm.** The rules table in the spec is normative.
1. Index Finta rows by id and Alexa items by itemId.
2. For each snapshot, compare each side's current `name` (using `sameName`) and `checked` with the snapshot.
3. Rows and items with no snapshot are "unmapped". Match them one-to-one by `sameName`, preferring the same `checked` state. Each match emits `link`.
4. Leftovers emit `alexa.add` or `finta.add`.
5. Pulled names are trimmed to `maxName`. Alexa items with a blank name are skipped.
6. A pull that would set `checked: true` on a row with `repeat !== 'none'` emits `finta.roll` instead of `finta.update`.

- [ ] **Step 1: Write the failing tests**, table-driven. Each case gives inputs and the expected `ops` list, compared with `assert.deepEqual` after sorting by `op`:
  - nothing changed → `[]`
  - Finta renamed "milk" to "oat milk" → `alexa.update` with name `oat milk` and the snapshot version
  - Alexa ticked → `finta.update` with `checked: true`
  - both changed (Finta renamed, Alexa ticked) → `finta.update` carrying Alexa's values
  - Finta row gone → `alexa.delete`
  - Alexa item gone → `finta.delete`
  - both gone → `unlink`
  - case-only change on Alexa ("Milk" vs snapshot "milk") → `[]`
  - first sync with Finta `[milk, eggs]` and Alexa `[Milk, bread]` → `link` milk, `alexa.add` eggs, `finta.add` bread
  - duplicates: Alexa `[milk, milk]` and Finta `[milk]` → one `link` and one `finta.add`
  - repeating task ticked on Alexa → `finta.roll`
  - an Alexa name of 100 characters with `maxName: 80` → `finta.add` name length 80
  - an Alexa item with a blank name → no action
- [ ] **Step 2: Run** `node --test test/alexa-sync.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `plan` and `sameName`** in `server/lib/alexa/sync.js`. No I/O and no imports from the database.
- [ ] **Step 4: Run it.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(alexa): pure sync planner`.

### Task 3: Amazon client

**Files:**
- Create: `server/lib/alexa/client.js`
- Create: `test/fixtures/alexa/` with `signin-email.html`, `signin-password.html`, `signin-otp.html`, `signin-error.html` and `captcha.html`. These are minimal hand-written pages containing only the form, hidden inputs and the IDs the client looks for (`auth-mfa-otpcode`, `auth-error-message-box`, `cvf-aamation-challenge-form`).
- Test: `test/alexa-client.test.js`

**Interfaces:**
- Produces:

```js
export class AlexaError extends Error { constructor(code, message) }   // code: 'auth' | 'challenge' | 'network' | 'api'
export function createAlexaClient({ fetch = globalThis.fetch, hosts = DEFAULT_HOSTS, now = Date.now } = {})
// DEFAULT_HOSTS = { signin: 'https://www.amazon.ca', api: 'https://api.amazon.com', alexa: 'https://alexa.amazon.ca', retail: (domain) => `https://www.${domain}` }
client.startLogin({ email, password }) → Promise<Pending>           // Pending is opaque: { jar, action, inputs, verifier, serial, createdAt }
client.finishLogin(pending, code)     → Promise<Login>
client.session(login)                 → Session                      // mutates login.cookies / login.cookiesAt; the caller persists login afterwards
session.getLists()                    → Promise<{ id, type: 'SHOP'|'TODO'|'CUSTOM', name }[]>
session.getItems(listId)              → Promise<{ itemId, name, checked, version }[]>
session.addItem(listId, name)         → Promise<void>
session.updateItem(listId, itemId, version, { name, checked }) → Promise<void>
session.deleteItem(listId, itemId, version) → Promise<void>
// Login = { serial, refreshToken, accessToken, accessExpires, adpToken, devicePrivateKey, cookies: { [name]: value }, domain: 'amazon.ca', customerId, cookiesAt }
```

**Approach**
- Requests use `redirect: 'manual'`, with a small cookie jar (a `Map` from name to value) that collects `set-cookie` headers.
- `startLogin` follows the spec's steps 1–2 with the OAuth parameters from `login.py::_build_oauth_url`. It returns when the OTP page appears. Errors:
  - `challenge`: a captcha page, or any page without the next field.
  - `auth`: an error box. Use Amazon's text as the message.
- `finishLogin`:
  1. Submit the code and read `openid.oa2.authorization_code` from the `Location` header.
  2. Register (body from `login.py::_register_device`, with `app_name: 'Finta'`).
  3. GET `/api/welcome` to discover the domain.
  4. Refresh cookies if the domain isn't `amazon.ca`.
- Session list calls send `Cookie` (`login.cookies` plus `lc-acbit=en-CA`) and `csrf` (from the most recent `csrf` cookie seen).
- A 401 or 403 triggers one `refreshCookies` and one retry. A second failure throws `AlexaError('auth')`.
- A cookie refresh runs before the first call when `now() - cookiesAt > 12h`.
- An abort or 5xx throws `network`. Any other non-2xx, or JSON without the expected arrays, throws `api`.
- Use `AbortSignal.timeout(20000)` on every request.

- [ ] **Step 1: Write the failing tests** against a fake Amazon (`node:http` on port 0 serving the fixtures and recording requests; set `hosts` to point every key at it):
  - `login happy path`: email → password → OTP → code → register → welcome. `finishLogin` returns `refreshToken: 'RT'` and `domain: 'amazon.ca'`. The register request body has `auth_data.code_verifier` and `registration_data.app_name === 'Finta'`.
  - `wrong password`: the error-box page → rejects with `code: 'auth'` and Amazon's message text.
  - `captcha`: rejects with `code: 'challenge'`.
  - `lists and items are normalized`: `getLists` maps `listType` to `type`. `getItems` maps `itemStatus: 'COMPLETE'` to `checked: true`.
  - `cookie header and csrf are sent`: after a response sets `csrf=abc`, the next list request has header `csrf: abc` and a `Cookie` containing `session-token=` and `lc-acbit=en-CA`.
  - `401 refreshes once then succeeds`: the first items call returns 401, the token endpoint returns new cookies, and the retry gets 200. The token endpoint was called once.
  - `401 twice is an auth error`.
  - `stale cookies refresh first`: with `cookiesAt` 13 h old, the token call happens before the list call.
  - `add/update/delete send the right bodies`: compare against the spec's table.
- [ ] **Step 2: Run** `node --test test/alexa-client.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `client.js`.**
- [ ] **Step 4: Run it, then `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(alexa): Amazon client (login, cookies, list API)`.

### Task 4: Runner

**Files:**
- Create: `server/lib/alexa/runner.js`
- Create: `server/lib/tasks.js`, which takes the roll-forward logic out of `server/routes/home.js:35-46`
- Modify: `server/routes/home.js`, so the `/api/tasks/:id/complete` handler calls `completeTask`
- Test: `test/alexa-runner.test.js`

**Interfaces:**
- Consumes:
  - `plan`, `sameName` (Task 2)
  - `createAlexaClient`, `AlexaError`, and the Session methods (Task 3)
  - `tx` from `server/db.js`
  - `today` from `server/lib/dates.js`
- Produces:

```js
// server/lib/tasks.js
export function completeTask(db, task, todayStr) → row   // same behaviour as the current route, including { rolled, previous_due }

// server/lib/alexa/runner.js
export function createAlexaRunner({ db, makeClient = () => createAlexaClient(), intervalMs = 600000, debounceMs = 2000, log = console })
runner.start() / runner.stop()
runner.requestSync(householdId, { reason: 'change' | 'view' }) → void        // no-op if the household isn't connected or status is 'reconnect'
runner.syncNow(householdId) → Promise<void>                                  // one full run; resolves after it finishes (tests and the first sync after connect)
runner.makeClient                                                             // exposed for the routes' login flow
```

**One run** (see the spec's "Runner" section):
1. Load `alexa_links`. Build `session` from `JSON.parse(login)`.
2. Call `getLists()`.
3. Pair each list:
   - `SHOP` → `shopping_list_id`, or the first list by `sort, id`, or a new list "Groceries".
   - `TODO` → tasks.
   - `CUSTOM` → the Finta list whose name matches by `sameName`, or a new list. A custom list that matches the shopping pairing is skipped.
4. For each pairing:
   - Load the Finta rows, the Alexa items, and the snapshots where `alexa_list_id = list.id` and (`kind='task'` or `finta_list_id = paired list id`).
   - Delete any other snapshots for that `alexa_list_id`. These are orphans and are never treated as deletes (Review Focus #2).
   - Call `plan()`.
   - Run the Alexa-side actions one at a time, each in its own try/catch. Collect the first error.
   - After any `alexa.add`, call `getItems()` once more. Match the new item to its Finta row by `sameName` among items that have no snapshot, and write a link.
   - Apply the Finta-side actions and the snapshot writes in one `tx()`:
     - `finta.roll` calls `completeTask`, then queues an `alexa.update` to `checked: false`, which runs right after.
     - Snapshots store the values as now on both sides.
5. Before every database write, check that the `alexa_links` row still exists. If it's gone, stop quietly (Review Focus #4).
6. Save `login` (cookies may have been refreshed) and `last_sync_at`. Clear `last_error` unless there was an error.
7. On `AlexaError('auth')`, set `status='reconnect'`.

**Scheduling**
- At most one run per household, plus a "needs another run" flag.
- The timer callback and all scheduling catch errors themselves. Nothing may throw out of `setInterval` or `setTimeout`.
- Log one line on error, formatted `[alexa] household <id> <code>: <message>`. Never log `login`.

- [ ] **Step 1: Write the failing tests.** Use an in-memory db from `openDatabase(':memory:')` with a seeded household, user and list, and a fake client whose `session()` returns an object backed by in-memory arrays.
  - `pulls Alexa shopping items into the chosen list`
  - `pushes a new Finta item and links it after re-fetch`
  - `ticking a repeating task on Alexa rolls it forward and unticks it on Alexa`
  - `custom Alexa list creates a Finta list with that name`
  - `changing shopping_list_id does not delete Alexa items`: sync, change the pairing, sync again; the fake's delete count is 0
  - `deleting a Finta list does not delete Alexa items`
  - `one failing Alexa call: others applied, last_error set, failed snapshot unchanged`
  - `auth error sets status reconnect and requestSync then no-ops`
  - `disconnect during a run writes nothing afterwards`: the fake's `getItems` awaits a promise the test controls; delete the link, then resolve; no `alexa_items` rows exist
  - `requestSync view within 60 s of last sync does not run`
  - `completeTask` keeps the route's behaviour: the existing tests in `test/money.test.js` and other files still pass
- [ ] **Step 2: Run** `node --test test/alexa-runner.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `server/lib/tasks.js`, update `home.js`, and implement `runner.js`.**
- [ ] **Step 4: Run it, then `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(alexa): sync runner`.

### Task 5: Routes and wiring

**Files:**
- Create: `server/routes/alexa.js`
- Modify:
  - `server/app.js`: `createApp({ cfg, db, setupCode, alexa })`. The default is `createAlexaRunner({ db })`, not started. Set `app.alexa`. Call `alexaRoutes(router, app)`. Change `homeRoutes(router)` to `homeRoutes(router, app)`.
  - `server/routes/home.js`: after each successful write, call `app.alexa.requestSync(ctx.household.id, { reason: 'change' })`. That covers task POST, PATCH and DELETE (through crud's `after`), complete, reopen, item add, PATCH and DELETE, clear-checked, meals → list, and list delete.
  - `server/index.js`: create the runner, pass it to `createApp`, call `runner.start()`, and `runner.stop()` on shutdown.
  - `test/helpers.js`: `startServer(env, { alexa } = {})` passes it through.
- Test: `test/alexa-routes.test.js`

**Interfaces:**
- Consumes: `runner.requestSync`, `runner.syncNow`, `runner.makeClient` (Task 4), and `AlexaError` (Task 3).
- Produces: the HTTP API in the spec's Routes table. `GET /api/alexa` returns exactly `{ connected, status, email, site, shoppingListId, lastSyncAt, lastError, lastErrorAt }`.

**Approach**
- Pending logins: a `Map` keyed by household ID, holding `{ pending, email, at }`, dropped after 5 minutes.
- `POST /api/alexa/connect`:
  1. Validate `email` with `t.email` and `password` with `t.str(200)`.
  2. Call `limiter.take('alexa:' + householdId)`.
  3. Call `startLogin` and store the pending login.
- `POST /api/alexa/code`:
  1. Validate `code` as 4–8 digits.
  2. Call `finishLogin`.
  3. Upsert `alexa_links` with `connected_by`.
  4. Write an `audit(ctx, 'alexa.connected', email)` entry.
  5. Fire `syncNow(...).catch(() => {})`.
- An `AlexaError` becomes `HttpError(400, err.message)`, or 502 for `network`.
- `DELETE /api/alexa`: delete the link and the household's `alexa_items` rows, and write `audit(ctx, 'alexa.disconnected')`.
- `PATCH /api/alexa`: validate `shopping_list_id` with `t.ref('shopping_lists')`.

- [ ] **Step 1: Write the failing tests.** The fake client comes from Task 3's test helpers, or is inlined.
  - `member cannot connect, code, patch or disconnect (403)`
  - `connect → code stores link; GET /api/alexa shows connected and contains no token fields`: assert `JSON.stringify(res.data)` doesn't match `/RT|refresh|cookie|token/i`
  - `code without connect → 400`
  - `pending login expires after 5 minutes`: use an injectable `now`
  - `sixth connect attempt in 15 minutes → 429`
  - `disconnect removes link and snapshots`
  - `write routes call requestSync`: a stub runner records calls; adding an item, ticking a task, and clear-checked each record one `{ reason: 'change' }`
  - `activity log shows alexa.connected`
- [ ] **Step 2: Run** `node --test test/alexa-routes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the routes and wiring.**
- [ ] **Step 4: Run it, then `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(alexa): connect/disconnect/status routes and change hooks`.

### Task 6: Interface, docs and release

**Files:**
- Modify:
  - `public/js/views/settings.js`: an "Alexa" section above "Account", a `#/settings/alexa` sub-page, and the connect and code sheets
  - `public/js/views/lists.js` and `public/js/views/tasks.js`: the sync footer, and calling sync when opened
  - `public/js/icons.js`: add Lucide `mic` if it's missing
  - `public/css/app.css`: only if a new class is needed. Reuse `.section-foot` and `.row`.
  - `CHANGELOG.md`, `README.md` (the Alexa feature, plus a note that it's unofficial), `package.json` (version `1.2.0`)

**Approach**
- **Settings row:**
  - Not connected: tile `mic`, color `cyan`, title "Alexa", sub "Not connected".
  - Connected: sub "Synced 3 min ago".
  - Status `reconnect`: sub "Reconnect needed", shown in `text-neg`.
- **Sub-page, owner and not connected:**
  1. A note: "Uses the same private connection as the Alexa app. Amazon can change it at any time, and sync may stop until Finta is updated."
  2. A Connect button that opens a sheet with Email and Password.
  3. When the server answers `needsCode`, a second sheet asks for the "Code Amazon texted you".
  4. A success toast, then the page refreshes.
- **Sub-page, connected:** email, Last Synced (`relPhrase`), Sync Now, a "Shopping List" picker (`fSelect` over `getLists()`), and Disconnect (`confirmDialog`, destructive).
- **Members** see status only.
- **Lists and Tasks:**
  1. On mount, `api.get('/api/alexa')`. If connected, `api.post('/api/alexa/sync')`, then reload the data once after 4 s.
  2. Footer: `<p class="section-foot">Synced with Alexa · 3 min ago</p>`, or `text-neg` with "Alexa sync failed: <lastError>".

- [ ] **Step 1: Implement the UI.**
- [ ] **Step 2: Manual check.**
  1. Run `npm run dev` with Node 22, set up a household, and open Settings → Alexa.
  2. Connecting with a fake email shows Amazon's error (or the network error) in a toast, and the page doesn't break.
  3. Lists and Tasks render with no footer when not connected.
  4. Check both light and dark mode at phone width.
- [ ] **Step 3: Update `CHANGELOG.md` (1.2.0), the `README.md` Features table and the Security notes, and the `package.json` version.**
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(alexa): settings and sync status UI; docs; v1.2.0`.

### Task 7: Deploy and live test (with the user)

- [ ] **Step 1:** Mirror to `/mnt/hgfs/GitHub/Finta/finta`, push the branch, and open a PR. Ask before pushing.
- [ ] **Step 2:** On the VM, back up the database with `docker compose exec finta node server/cli.js backup`, check out the branch, then run `docker compose up -d --build`.
- [ ] **Step 3:** The user connects in Settings → Alexa and enters the texted code. Check that a sync runs and Alexa lists appear in Finta.
- [ ] **Step 4:** "Alexa, add bananas to my shopping list". Open Lists, and bananas appears within about 1 minute. Tick it in Finta, and the Alexa app shows it ticked within a few seconds.
- [ ] **Step 5:** Repeat for To-do ↔ Tasks and one custom list. Fix any differences in Amazon's responses in `client.js` only.

# Alexa list sync — design

Date: 2026-10-26 · Status: approved in conversation, awaiting spec review

## Goal

Alexa's built-in lists and Finta stay the same in both directions. "Alexa, add milk to my shopping list" appears in Finta; adding, ticking, renaming or deleting in Finta shows up in Alexa.

| Alexa | Finta |
|---|---|
| Shopping List | One Finta list chosen in Settings (default: the household's first list) |
| Each custom list (e.g. "Costco") | The Finta list with the same name (case-insensitive) |
| To-do list | All tasks |

Out of scope: Echo announcements, an official Alexa skill, HTTP/2 push, creating Alexa lists from Finta.

## Constraints

- **Unofficial API.** Amazon removed third-party list access on 2024-07-01. Finta uses the private API used by the Alexa app, following the open-source `aioamazondevices` library (the one Home Assistant's Alexa Devices integration uses). Amazon can change it at any time. Everything Amazon-specific stays in one file so a breakage needs a fix in one place.
- **Account:** amazon.ca, two-step verification by text message. Sign-in still happens on amazon.com (the Alexa app's sign-in only exists there; amazon.ca answers 404), and the lists site is discovered afterwards. Sign-in must work with SMS codes and with authenticator-app codes.
- **No npm dependencies.** Use `fetch`, `node:crypto`, and HTML form parsing with regex.
- **Isolation.** A failing sync must never break the rest of Finta or slow down a request.
- One Amazon connection per household. Only household owners can connect, disconnect or change Alexa settings.

## Success criteria

- A change made in Finta reaches Alexa within a few seconds (it's pushed right after the request).
- A change made through Alexa reaches Finta within 10 minutes, or within a minute when someone opens Lists or Tasks.
- No Amazon token or password ever appears in an API response, in Export Data or in the logs.
- Sync status and errors are visible in Settings.

## Amazon client — `server/lib/alexa/client.js`

The only module that talks to Amazon. Ported from `aioamazondevices` (`login.py`, `http_wrapper.py`, `implementation/todo.py`).

**Sign-in, in two steps.** Steps 1 and 2 must happen in the same server process.

1. `startLogin({ site, email, password })`
   - Build the OAuth sign-in URL: PKCE S256 code challenge, a random device serial, client ID `hex(serial + "#" + "A2IVLV5VM2W81")`, and `openid.assoc_handle=amzn_dp_project_dee_ios`.
   - GET the URL, then submit the email form and the password form. Each form's hidden inputs and `action` URL are read from the HTML.
   - Keep cookies in a small cookie jar.
   - If the response page has an `auth-mfa-otpcode` input, Amazon has asked for a code. Keep the pending state (cookie jar, form action, hidden inputs, code verifier, serial) in memory for 5 minutes, keyed by household. Return `{ needsCode: true }`.
   - Any other page means Amazon wants something Finta can't do (a captcha, approving in the Amazon app, an email check). Throw an error with a clear message. If the page has `auth-error-message-box` or `auth-warning-message-box`, use Amazon's own message.
2. `finishLogin(pending, code)`
   - Submit the code form with `otpCode`, `mfaSubmit=Submit` and `rememberDevice=false`.
   - Read `openid.oa2.authorization_code` from the redirect URL. Don't follow the redirect to `/ap/maplanding`; read it from the `Location` header.
   - POST `https://api.amazon.com/auth/register` (global endpoint) with the registration body from `aioamazondevices`. Use `requested_token_type` values `bearer`, `mac_dms`, `website_cookies` and `store_authentication_cookie`.
   - Find the account's Alexa site: GET `https://alexa.amazon.com/api/welcome` and read `alexaHostName` (for example `alexa.amazon.ca`). The retail domain is that host with `alexa` replaced by `www`. If it differs from the sign-in domain, refresh cookies for it.
   - Return the stored login data: refresh token, access token and its expiry, ADP token, device private key, website cookies, `session-token` cookie, device serial, customer ID and retail domain.

**Session**
- `refreshCookies(login)`: POST `https://api.amazon.com/auth/token` (form-encoded) with `requested_token_type=auth_cookies`, `source_token_type=refresh_token`, `app_name=Finta` and `domain=www.<retail domain>`. The response's `response.tokens.cookies` is a map of domain → `[{ Name, Value }]`. This replaces the website cookies.
- Before each sync: if the last cookie refresh was more than 12 hours ago, refresh. If a list call returns 401 or 403, refresh once and retry once.
- Read the `csrf` cookie from responses and send it back as a `csrf` header, the same way the library does.
- Every list request sends a Cookie header with the website cookies, `session-token` and `lc-acbit=en-CA`. It also sends the library's browser User-Agent and `Accept-Language: en-CA`.

**Lists**: all calls are on `https://www.<retail domain>/alexashoppinglists/api/v2/lists`.

| Function | Call |
|---|---|
| `getLists()` | `POST /fetch` → `listInfoList[]`: `{ listId, listType: SHOP, TODO or CUSTOM, listName }` |
| `getItems(listId)` | `POST /{listId}/items/fetch?limit=200` (the library uses 100 and doesn't page; Finta asks for 200 and logs a warning if 200 come back) → `itemInfoList[]`: `{ itemId, itemName, itemStatus: ACTIVE or COMPLETE, version }` |
| `addItem(listId, name)` | `POST /{listId}/items`, body `{ items: [{ itemType: "KEYWORD", itemName }] }` |
| `updateItem(listId, itemId, version, { name?, checked? })` | `PUT /{listId}/items/{itemId}?version=`, body `itemAttributesToUpdate` |
| `deleteItem(listId, itemId, version)` | `DELETE /{listId}/items/{itemId}?version=` |

`addItem` doesn't return the new item's ID. After adding, re-fetch the list and match the new item by name among unmapped active items.

**Errors**: one `AlexaError` class with a `code`:
- `auth`: refresh failed, so reconnecting is needed.
- `challenge`: Amazon wants a captcha or app approval.
- `network`: a timeout or a 5xx.
- `api`: an unexpected shape or a 4xx.

Every request has a 20-second timeout.

**Testability.** The client takes a `fetch` function and a base-URL map in its options, so tests can point it at a local fake server.

## Sync engine — `server/lib/alexa/sync.js`

A pure function with no I/O:

```
plan({ finta, alexa, snapshots }) → actions[]
```

- `finta`: the rows of one paired container. Each is `{ id, name, checked, repeat? }`. Tasks map `title` to name, and `done_at != null` to checked.
- `alexa`: the items of the paired Alexa list: `{ itemId, name, checked, version }`.
- `snapshots`: rows from `alexa_items` for this pairing: `{ fintaId, itemId, name, checked, version }`.

**Rules for each snapshot pair:**

| Finta vs snapshot | Alexa vs snapshot | Action |
|---|---|---|
| same | same | nothing |
| changed | same | push the Finta values to Alexa |
| same | changed | pull the Alexa values into Finta |
| changed | changed | **Alexa wins**, so pull |
| deleted | present | delete on Alexa |
| present | deleted | delete in Finta |
| deleted | deleted | drop the snapshot |

**Rows with no snapshot**
- A Finta row with no snapshot is created on Alexa.
- An Alexa item with no snapshot is created in Finta.
- **Matching first:** on every run, before creating anything, unmapped rows and unmapped items are paired one-to-one by name (case-insensitive), preferring the same checked state. Connecting, or an add whose new ID couldn't be read, never creates duplicates.

**Name comparison** ignores case and surrounding spaces, because Alexa often changes capitalization.

**Repeating tasks.** When Alexa marks a repeating task complete:
1. Finta runs the normal completion, which rolls the due date forward.
2. Finta then pushes "unchecked" back to Alexa, because the task is open again in Finta.

**Shopping-item quantity** stays Finta-only.

**Clear Checked** in Finta deletes those rows. The deletion rule then deletes them on Alexa.

**Tasks shown in Finta.** Finta's task list hides tasks finished more than 14 days ago, but sync uses the full `tasks` table. A done task stays paired until either side deletes it.

**Apply step** (in the runner):
1. Make the Alexa calls one at a time.
2. Apply the Finta changes inside one `tx()`.
3. Update the snapshots from the results.

If an Alexa call fails, its snapshot isn't updated, so the next run tries the same action again.

## Runner — `server/lib/alexa/runner.js`

- `startAlexaRunner({ db })` is called from `server/index.js`. It checks every connected household every **10 minutes**.
- `requestSync(householdId, { reason })` is debounced:
  - after a Finta change (`reason: 'change'`): runs within 2 seconds.
  - when Lists or Tasks is opened (`reason: 'view'`): skipped if the last sync was less than 60 seconds ago.
- At most one sync runs per household at a time. A request that comes in during a run marks the household as needing another run.
- One run, in order:
  1. Refresh cookies if needed.
  2. `getLists()`.
  3. Work out the pairings: Shopping List → the chosen Finta list, To-do → tasks, and each custom list → the Finta list with the same name. A custom list with no matching Finta list gets one created.
  4. Run plan and apply for each pairing.
  5. Write `last_sync_at` and clear `last_error`.
- On error, write `last_error` and `last_error_at`. If the error is `auth`, set `status = 'reconnect'` and stop syncing until the household reconnects. Errors are logged on one line with the household ID and the error code, never with tokens.
- Tests run with no runner started. The runner is only started from `index.js`, so the route tests aren't affected.

## Data — `server/migrations/004_alexa.sql`

```sql
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
  name          TEXT    NOT NULL,                 -- snapshot from the last sync
  checked       INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  UNIQUE (household_id, alexa_item_id),
  UNIQUE (household_id, kind, finta_id)
);
```

`finta_id` has no foreign key because it points to one of two tables. A sync only uses snapshots whose `finta_list_id` matches the list currently paired with that Alexa list. Others (left over after changing the Shopping List pairing, or after deleting a Finta list) are dropped and never treated as deletions, so nothing on Alexa is lost. A deleted custom Finta list comes back on the next sync while the Alexa list still exists. To get rid of one, delete it in the Alexa app. When a Finta row is deleted, the next sync sees that its snapshot has no matching row, and that is the delete signal.

`/api/export` already lists its tables one by one, so these two tables stay out of it. A test checks this.

Disconnecting deletes the `alexa_links` row and all of the household's `alexa_items` rows. It doesn't change anything on Alexa or in Finta.

## Routes — `server/routes/alexa.js`

Every route needs a signed-in user. Every route that writes needs `role = 'owner'`.

| Method | Path | Does |
|---|---|---|
| GET | `/api/alexa` | `{ connected, status, email, site, shoppingListId, lastSyncAt, lastError, lastErrorAt }`. Any member can call it. |
| POST | `/api/alexa/connect` | `{ email, password }` → `{ needsCode: true }`, or an error message |
| POST | `/api/alexa/code` | `{ code }` → finishes sign-in, saves `alexa_links` and starts the first sync |
| POST | `/api/alexa/sync` | `requestSync(reason: 'view')`. Any member can call it. |
| PATCH | `/api/alexa` | `{ shopping_list_id }` |
| DELETE | `/api/alexa` | Disconnects |

- Connect and code use their own `RateLimiter` (from `server/lib/security.js`, the same class sign-in uses): 5 attempts per household per 15 minutes, so a wrong password can't get the Amazon account locked.
- Connecting and disconnecting are written to the activity log using the existing `audit()`.
- **Hooks into existing routes:** after a successful write to tasks (create, patch, delete, complete, reopen), shopping items (add, patch, delete), clear-checked and meals → list, call `requestSync(householdId, { reason: 'change' })`. This does nothing if the household isn't connected.

## Interface

- **Settings → Alexa** (a new group):
  - Not connected:
    1. A short note: unofficial, can break, uses your Amazon sign-in.
    2. Email and password.
    3. The code field, shown once Amazon has texted the code.
  - Connected:
    - The account email.
    - "Last synced 3 min ago".
    - Sync Now.
    - A Shopping list picker.
    - Disconnect, which confirms with an alert.
    - Status `reconnect`: a warning row and a Reconnect button that reopens the sign-in form.
  - Members who aren't owners see the status only.
- **Lists and Tasks:**
  - Opening either screen calls `POST /api/alexa/sync` when connected.
  - A footer reads "Synced with Alexa · 3 min ago". It turns into a warning row when `last_error` or `reconnect` is set.
  - When the sync finishes, the screen re-fetches once.

## Testing

All tests use `node:test` and the existing `test/helpers.js`.

- `test/alexa-sync.test.js`: table-driven tests of `plan()` for every row of the rules table, plus:
  - first-sync name matching
  - case-only renames
  - a repeating task completed on Alexa
  - Clear Checked
- `test/alexa-client.test.js`: a fake Amazon server on `node:http` serving saved sign-in page HTML.
  - Email, password and code flow, down to register.
  - Wrong-password and captcha pages give the right error codes.
  - A 401 refreshes once and then succeeds.
  - Site discovery from `api/welcome`, and the Cookie header on list calls.
- `test/alexa-routes.test.js`:
  - A member can't connect or disconnect.
  - No response, including `GET /api/alexa`, contains token fields.
  - Export doesn't include the Alexa tables.
  - Write routes call `requestSync`. A stub records the calls.
- **Live Amazon:** you test it by hand on the server after deploying. It can't run in CI.

## Risks

- **Amazon changes the sign-in pages or the API.** Sync stops and Settings shows the error. Only `client.js` needs fixing.
- **Account security prompts.** Amazon may email a "new device" notice. Finta registers with app name `Finta`, so it appears in the account's device list as "<first name>'s Finta". Removing it there revokes Finta's access, and Settings then shows Reconnect.
- **Rate limits.** A 10-minute interval, at most one sync a minute when a screen opens, and only one run at a time.
- **Terms of service.** This is unofficial use, the same as Home Assistant's integration. You've accepted this.

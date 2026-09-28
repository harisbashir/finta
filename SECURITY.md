# Security

Finta holds a household’s finances and is meant to run on the public internet. This file lists what protects it, what you are responsible for as the person hosting it, and how to report a problem.

## Reporting a vulnerability

Please **don’t open a public issue**. Use GitHub’s *Report a vulnerability* button (under **Security → Advisories**) on this repository, or email the maintainer. Include steps to reproduce. We aim to reply within a week.

## What Finta does

### Accounts and sign-in

| Control | Detail |
| --- | --- |
| First-run claim | A fresh install accepts setup only with a random code printed in the container log (or `SETUP_CODE`). Nobody can take over a new server by reaching it first |
| Registration | Invite-only by default. Invitation tokens are 192-bit, stored hashed, single-use, and expire after 7 days. `ALLOW_SIGNUP=true` turns on open sign-up |
| Password storage | scrypt (N=2¹⁵, r=8, p=1, 16-byte salt), compared in constant time. A dummy hash is checked for unknown emails so response timing doesn’t reveal which accounts exist |
| Password policy | At least 10 characters. Common passwords and passwords containing your name or email are refused |
| Passkeys | WebAuthn with discoverable credentials. User verification (biometric or PIN) is required, and the origin, RP ID and challenge are checked. Challenges are single-use and expire after 3 minutes. Sign counters are checked for cloned keys. ES256, EdDSA and RS256 are supported |
| Two-factor | TOTP (RFC 6238) with a ±30 s window. Each time step is accepted once (no replay). 10 recovery codes are stored hashed and each works once. The half-finished sign-in ticket allows 5 attempts |
| Brute force | 20 sign-in attempts per IP address per 15 minutes (configurable). An account locks for 15 minutes after 8 wrong passwords. Password re-checks for sensitive settings are rate-limited per user |
| Re-authentication | Turning two-factor on or off, making new recovery codes, changing your password and deleting your account all ask for your password |

### Sessions

- A random 256-bit token is kept in a cookie. The database stores only its SHA-256 hash.
- Cookies are `HttpOnly`, `Secure` and `SameSite=Lax`, and use the `__Host-` prefix when served over HTTPS.
- Sessions expire after 30 days, or after 14 idle days.
- Signing out deletes the session on the server. Changing your password signs out every other device. **Settings → Sign-In & Security → Devices** shows every session and lets you revoke any of them.

### Requests

- **CSRF:** every state-changing request needs an `X-Finta: 1` header, which cross-site forms can’t send and which forces a CORS preflight that Finta never approves. Requests are also rejected if the `Origin` doesn’t match or `Sec-Fetch-Site` is cross-site. SameSite cookies are a third layer.
- **Input:** every write is checked against a schema (types, lengths, enums, dates, amounts). Unknown fields are dropped and control characters are stripped. Request bodies are capped at 256 KB and must be JSON.
- **SQL:** all queries are parameterized. Every read and write is scoped to the caller’s household, and IDs that point to other rows (a category, a person, a list) are checked to belong to the same household.
- **Output:** the web app escapes every interpolated value by default. The Content Security Policy allows only same-origin scripts and styles, with no inline code and no `eval`.
- **Headers:** CSP, `Strict-Transport-Security` (2 years), `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and a restrictive `Permissions-Policy`.
- **Errors:** error responses never include stack traces or internal details.
- **Timeouts:** the server enforces header and request timeouts.

### Members and privacy

- Each account, recurring item, goal and debt belongs to a member or is joint.
- A member's **private account** (the default for personal accounts) is enforced on the server. Other members get its balance and its contribution to household totals, but never its individual rows, its day-by-day balance history, or its imports. Every route that returns or changes transactions checks this: account transactions, the transaction list, Review, categorize, edit and delete.
- Only an account's owner (or anyone, for joint accounts) can import into it, edit it, undo its imports or delete it. Only a debt's owner can change a personal debt.

### Statement import

- CSV text is parsed on the server by a strict in-house parser. It is never evaluated, and formula-looking cells stay plain text.
- Imports are capped at 8 MB and 5,000 rows. Only import routes accept bodies larger than 256 KB.
- Imported descriptions are escaped on output like everything else.

### Data

- **Export** never includes password hashes, two-factor secrets or passkeys.
- **Account deletion** is available in the app. If you are the last member of your household, the whole household is deleted.
- **Activity log:** owners can see sign-ins, failed attempts and security changes.

### Container

- Runs as the unprivileged `node` user.
- In `compose.yaml` the root filesystem is read-only, all Linux capabilities are dropped, `no-new-privileges` is set, and only the `/data` volume is writable.
- There are no npm dependencies, so there is no supply chain to audit beyond Node.js itself. The two vendored browser files (Lucide icons and a QR code generator) are listed in `THIRD_PARTY_NOTICES.md`.
- In production the server refuses to start if `APP_URL` is not `https://`, unless you explicitly set `ALLOW_INSECURE_HTTP=true` for a private network.

## Your part as the host

1. **Use HTTPS.** `compose.yaml` sets up Caddy, which handles certificates automatically. Keep `APP_URL` exactly equal to the address people use.
2. **Keep things updated.** Run `git pull && docker compose up -d --build` regularly. Dependabot opens pull requests for base-image updates.
3. **Back up** the `finta-data` volume (`node server/cli.js backup`) and store copies somewhere else. Backups contain your financial data, so protect them.
4. **Encourage passkeys or two-factor** for everyone in the household. Owners can see who has them turned on under **Settings → People**.
5. **Leave `TRUST_PROXY` off** unless Finta sits behind a proxy you control. Otherwise clients could spoof their IP address to get around rate limits.

## Known limits

- Rate limits are kept in memory and reset when the container restarts. They are per container, which is fine for one household.
- There is no email, so password reset is done by the host with `server/cli.js reset-password`. Recovery codes cover a lost two-factor device.
- Loan payoff figures are estimates, not financial advice.

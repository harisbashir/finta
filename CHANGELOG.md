# Changelog

## 1.1.1 — 2026-09-28

### Fixed
- **The Household / Just Me switch now shows which one is selected.** The figures always changed, but the highlighted button stayed on the household (Money, Spending and Debts).
- **Dark mode text in more browsers.** Buttons, list rows, menus, dropdown options, disabled fields and autofilled fields now always use the app's own text colours, so browsers that paint form controls with their system colours no longer show dark text on dark rows.
- Initials on grey, yellow, mint and cyan avatars (for example the debt payoff order) now meet contrast in both modes.

### Easier statement import
- **Import** button on the Money screen, next to +.
- An **Import Your Bank Statements** prompt on Money when you have no accounts yet.
- The import sheet can **create the account for you** ("New Account…"), then carries straight on to choosing the file.

### Install and update scripts
- `scripts/install.sh` sets up Docker if needed, writes `.env`, builds, starts, waits for health and prints your address and setup code. Use `--domain` for public HTTPS, or no options for a home network.
- `scripts/update.sh` backs up to `./backups`, pulls, rebuilds, restarts and checks health. Pass a tag to switch releases.
- [docs/INSTALL-PROXMOX.md](docs/INSTALL-PROXMOX.md): a fresh install on a Proxmox VM, step by step.
- `compose.vm.yaml` for a home server or VM reached by IP now ships with Finta.

**Upgrading from 1.1.0** (the update script arrives with this release, and the install guide had you create `compose.vm.yaml` yourself):

```bash
cd ~/finta
mv compose.vm.yaml compose.vm.yaml.old   # only if you created it from the guide
git pull
bash scripts/update.sh
```

From then on, `bash scripts/update.sh` is all you need.

## 1.1.0 — 2026-09-27

### Accounts and statement import
- **Accounts** for chequing, savings, credit cards, lines of credit, cash and investments. Each has its own page with a balance-over-time chart, its transactions, and its import history.
- **CSV import** in three steps: choose a file, check the preview, import. Formats are detected automatically:
  - headers or no headers;
  - separate Debit and Credit columns, or one signed Amount column;
  - `$1,234.56`, `(12.00)`, `12.00-` and `DR`/`CR` amounts;
  - ISO, month/day, day/month and "Sep 27, 2026" dates;
  - comma, semicolon or tab separators.

  The column mapping is remembered per account, and you can adjust it in the preview.
- **Duplicates are skipped** when statements overlap, so re-importing the same file adds nothing. Two identical purchases on the same day are both kept.
- **Statement balances**: if the file has a balance column, the account balance is set to the statement's closing balance.
- **Undo any import** from the account page.

### Automatic sorting
- **Built-in knowledge** of hundreds of Canadian and US merchants and bank phrases, such as Loblaws, Tim Hortons, Petro-Canada, Toronto Hydro and Netflix. They are sorted into categories on import.
- **Learned rules**: sort a transaction once in **Review** and every similar row, past and future, follows. You can manage rules in **Settings → Import Rules**.
- **Bill matching**: a statement line that matches a recurring bill by name, amount and due date marks that bill paid. It replaces the autopay placeholder and records the real amount. Each match is learned for next month.
- **Looks Recurring**: Finta spots payments that repeat at a steady amount, such as a gym membership, and offers to track them as bills in one tap.
- **Refunds** count against the category they came from, not as income.

### Transfers between your own accounts
- A credit card payment from chequing, or a move to savings, is **paired automatically**: same amount, both accounts, within five days, and either a payment/transfer description or a card on the receiving side. Transfers never count as spending or income, so nothing is counted twice.
- A card payment whose card you haven't added counts as a **Debt** payment until its other half shows up.
- An e-transfer to a person is treated as spending, not a transfer.

### Debts
- **Debts** has its own screen, grouped by person:
  - mortgages, credit cards, lines of credit, car loans, student loans and personal loans;
  - each debt's balance, rate, monthly payment and progress paid off;
  - estimated interest per month and card utilization.
- Card and line-of-credit debts follow their account's imported balance. Loans follow their payment schedule under Bills.
- **Payoff planner**: choose Highest Rate First (avalanche) or Smallest First (snowball), and add an extra monthly amount. You see your debt-free date, total interest, savings compared with paying minimums only, the payoff order, and a chart.
- Loans from v1.0 are migrated into debts automatically.

### Household and members
- Accounts, bills, goals and debts belong to a **member** or are **Joint**.
- Money screens switch between **the household** and **Just Me**.
- **Private accounts**: other members see the balance and totals, but not the individual transactions or the day-by-day balance history. This is enforced on the server.
- **Who Spent** shows each member's share of the month.

### Charts
- New on Money:
  - **In and Out**, a six-month comparison;
  - **Where It Went**, spending by category, bills included;
  - **Who Spent**;
  - Cash & Savings and Total Debt tiles.
- Also new: a balance chart on each account, a debt composition bar, and a payoff projection.
- Every chart has hover and keyboard tooltips and a "Show as table" view. Colours are validated for colour-blind separation in light and dark mode.

### Appearance
- **Settings → Appearance**: Automatic (follows the device), Light or Dark. It is saved to your account and applied before the first paint, so there's no flash.

### Fixes
- Opening a Money screen directly (a bookmark or refresh) no longer fails before Today has loaded.
- Sheets now close when you navigate to another screen.

## 1.0.0 — 2026-09-27
- First release: Today, money (income, bills, subscriptions, loans, spending, budgets, goals), tasks, shopping lists, meal plan, home inventory and contacts. Passkeys, two-factor, invites, Docker + Caddy.

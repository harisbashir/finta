# Design

Finta’s interface follows Apple’s [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines), translated for the web. This file records the decisions, with the HIG page each one comes from, so they survive future changes.

## Thesis

**One screen answers one question: how is our month going?** The signature element is the *month strip*: a single bar that divides this month’s income into bills, spending, savings and what’s left, with the amounts written underneath and a per-day figure (“about $85 a day for the next 12 days”). It is the app’s one bold moment, and everything around it stays quiet (HIG `branding.md`: branding defers to content). The app icon draws the same strip inside a house.

Everything else is a deliberately quiet utility. It uses system type, system colors, grouped lists and familiar controls, so a household can use it without learning anything new.

## Structure

| Width | Navigation | Source |
| --- | --- | --- |
| Under 900 px | Floating tab bar with five tabs (Today, Money, Tasks, Lists, Home) and an account button in the navigation bar | `tab-bars.md` — few tabs, no More tab, single-word labels, always visible |
| 900 px and wider | Sidebar with the same five sections plus Settings; no critical actions at the bottom | `sidebars.md` › Best practices, Desktop |

- Tabs **navigate**; actions such as adding an item live in the toolbar at the top right (`tab-bars.md`: “Use a tab bar to support navigation, not to provide actions.”).
- Sub-sections use a **segmented control** (Month · Recurring · Spending · Goals).
- Focused tasks open in a **sheet**: at the bottom on phones, with a grabber and swipe to dismiss, and centered as a form sheet on wider screens. Every sheet has Cancel and a prominent primary action, only one sheet is open at a time, and closing a sheet with unsaved changes asks whether to discard them (`sheets.md` › Best practices).
- Lists use the **inset grouped** style with 44 px rows, Settings-style colored glyph tiles, and separators inset to the text (`lists-and-tables.md`).
- **Swipe actions** on tasks and shopping items give a quick Delete. Every action is also reachable without swiping.
- Common mistakes are fixed with **Undo** in a toast rather than a confirmation (`undo-and-redo.md`, `feedback.md`). Alerts are kept for destructive actions that can’t be undone: deleting a recurring item, a goal or a member, and deleting your account (`alerts.md`).

## Tokens

### Color

Colors use Apple’s semantic system colors, defined as CSS custom properties with light, dark and **Increase Contrast** variants (`color.md` › Best practices). Appearance defaults to **Automatic**, which follows the system. Since v1.1, **Settings → Appearance** also offers Light and Dark; this was a product requirement and is listed under departures below. The choice is saved to the account and applied by a tiny head script before first paint, so the page never flashes the wrong appearance.

Apple’s `secondaryLabel` (60 % opacity) measures 3.4:1 on white, below the 4.5:1 that `accessibility.md` asks of text up to 17 pt. Finta darkens it to 78 %. Semantic text colors use Apple’s accessible variants in light mode.

| Token | Light | on white / grouped | Dark | on #1c1c1e / black |
| --- | --- | --- | --- | --- |
| `--label-2` | `rgba(60,60,67,.78)` ≈ #67676c | 5.6 / 5.0 | `rgba(235,235,245,.62)` | 6.2 / 7.7 |
| `--tint` (links, selected) | #0064d2 | 5.6 / 5.0 | #409cff | 6.0 / 7.4 |
| `--positive` (income, left) | #1d7a33 | 5.4 / 4.8 | #30d158 | 8.4 / 10.4 |
| `--negative` (overdue) | #d70015 | 5.4 / 4.8 | #ff6961 | 6.0 / 7.4 |
| `--warning` (due soon) | #c93400 | 5.3 / 4.7 | #ff9f0a | 8.3 / 10.2 |
| White on prominent button | #0064d2 | 5.6 | #0a84ff | 3.6 (semibold label; ≥ 3:1 for bold) |

**One color means one thing.** Blue means interactive. Green means money in, what’s left, or paid. Red means overdue, over budget or destructive. Orange means soon. Category colors use the system palette and always come with a name, so no information depends on color alone. The month strip carries an `aria-label` that states every amount.

### Charts

Charts follow the dataviz method: pick the form first, then colour by job, validate, apply the mark specs, add hover and focus, and check accessibility.

| Chart | Form | Why |
| --- | --- | --- |
| In and Out, six months | Grouped columns, 2 series | Compare two magnitudes per month on one axis |
| Where It Went | Horizontal bars, one hue | Nominal categories ranked by size. The category's own glyph tile identifies it, so bars aren't coloured by rank |
| Who Spent / What It's Made Of | One stacked bar + legend with values and % | Part-to-whole, at most 4 parts; the rest fold into grey |
| Account balance, debt payoff | Line (area for a single series) with crosshair | Change over time |
| Cash & Savings, Total Debt | Stat tiles | One number each; a chart would add nothing |

**Palette.** Four chart slots in a fixed order, run through `validate_palette.js`. Every check passes in both modes: lightness band, chroma floor, colour-blind separation (worst adjacent ΔE 16.5 light / 16.0 dark) and normal-vision separation.

| Slot | Light | Dark | Used for |
| --- | --- | --- | --- |
| 1 | #5856d6 | #6664e8 | Bills / Out / first person |
| 2 | #d97706 | #cc7a08 | Spent |
| 3 | #0a8db0 | #1f9bb5 | Saved |
| 4 | #2e9e46 | #27a844 | Left / In / with-plan |

Green against orange failed the colour-blind check (ΔE 4.9), so two-series charts pair **green with indigo** instead. The month strip uses the same tokens.

**Marks.** Bars are at most 24 px wide, with 4 px rounded data-ends that are square at the baseline. There's a 2 px surface gap between stacked segments, lines are 2 px, gridlines are solid hairlines, and there is only ever one y-axis. Text never takes a series colour.

**Interaction.** Columns have a per-band hover and focus tooltip. Lines have a crosshair that snaps to the nearest day and can be moved with the arrow keys. Every chart has a **Show as table** view, so no value is only available on hover. Tooltip text is inserted with `textContent`.

### Type

System fonts only (`typography.md` › Using system fonts), with Apple’s *Large (default)* text styles set in `rem`, so the browser’s text size setting scales the whole interface the way Dynamic Type does.

| Style | Phone | Wide screen with pointer |
| --- | --- | --- |
| Large Title | 34 / bold | 28 |
| Title 3 (section headers) | 20 / bold | 17 |
| Body | 17 | 15 |
| Subhead (secondary lines) | 15 | 13 |
| Footnote (captions, hints) | 13 | 12 |

Amounts use tabular figures. The month headline and goal amounts use SF Pro Rounded, falling back to the system font elsewhere; it is used only for money.

### Materials

**Liquid Glass** (backdrop blur 24 px, saturation 1.5, translucent fill and a hairline edge) is used only on the **functional layer**: the tab bar, sidebar, toolbar buttons, the scrolled navigation bar, alerts and toasts. It is never used on content (`liquid-glass.md` › Where the material belongs). The navigation bar is transparent at rest and turns to glass once content scrolls beneath it, which is Apple’s scroll-edge effect (`layout.md` › Visual hierarchy).

- **Reduce Transparency**, and browsers without `backdrop-filter`, get opaque surfaces.
- **Increase Contrast** gets opaque bars, darker labels and stronger separators.
- **Reduce Motion** turns off sheet, toast and alert animations.

### Targets

Touch controls are 44 × 44 px, and check circles have a 44 px hit area around a 24 px mark. On wide screens with a precise pointer, controls are 32 px (`accessibility.md` › Mobility). Keyboard focus is always visible.

## Writing

- Buttons say what happens: “Add Expense”, “Mark Oct 1 Paid”, “Clear”, “Remove from Household”. Title-style capitalization is used for buttons and titles (`writing.md`).
- Errors say what went wrong and how to fix it, next to the field that caused it, without apologizing: “Use at least 10 characters for your password.”
- Empty screens invite the next step: “Set it once, see it every month.”
- The sign-in screen explains what the app is for, and the passkey button names its method: “Sign In with a Passkey” (`managing-accounts.md`).

## Where Finta departs from the HIG, and why

| Guideline | Finta | Reason |
| --- | --- | --- |
| “Delay sign-in for as long as possible” (`managing-accounts.md`) | Sign-in comes first | Every screen shows private household data on a server that anyone on the internet can reach. The sign-in screen explains the benefit instead |
| SF Symbols | Lucide icons | SF Symbols may only be used on Apple platforms. Lucide has one consistent stroke weight that sits well next to system type |
| Menu bar for every command (macOS) | Not applicable | Finta is a web app, so commands live in toolbars and sheets |
| “Avoid offering an app-specific appearance setting” (`dark-mode.md`) | Automatic / Light / Dark in Settings | Requested for v1.1. Automatic is the default, so the HIG behaviour is kept unless someone opts out |

## Self-review (apple-design lenses)

- **Accessibility:** every text/background pair in the table above meets 4.5:1, or 3:1 for bold text. Targets are 44 px. Color is never the only signal. Icon-only buttons have `aria-label`s. Sheets use `<dialog>`, which traps focus and closes on Esc. Reduce Motion, Reduce Transparency and Increase Contrast are all handled.
- **Conventions:** there is a tab bar on phones and a sidebar on wide screens, tabs never act, sheets have Cancel, there’s one prominent action per view, and destructive actions are red and confirmed.
- **Craft:** the boldness goes into one place, the month strip; there are no gradients in content and one accent color. **Remove one accessory:** we removed a duplicated type grid from the “New Recurring Item” sheet and the per-day “Add another” links in the meal plan during review.

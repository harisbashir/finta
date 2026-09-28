// Accounts: chequing, savings, credit cards and credit lines; statement import; the Review inbox.
import { api } from '../api.js';
import { html, raw, icon, $, $$, S, money, fmtDate, fmtMonth, relDay, sheet, toast, confirmDialog, fText, fMoney, fSelect, fToggle, fNumber,
  emptyState, hydrate, plural, centsToInput, addMonthsYM, segmented } from '../ui.js';
import { lines } from '../charts.js';
import { getCategories, getMembers, invalidate } from '../store.js';
import { txRow, txSheet, getScope } from './money.js';
import { KINDS } from './money-sheets.js';

export const ACCOUNT_TYPES = {
  chequing: { label: 'Chequing', icon: 'landmark', color: 'blue' },
  savings: { label: 'Savings', icon: 'piggy-bank', color: 'teal' },
  credit_card: { label: 'Credit Card', icon: 'credit-card', color: 'indigo', owes: true },
  line_of_credit: { label: 'Line of Credit', icon: 'banknote', color: 'brown', owes: true },
  cash: { label: 'Cash', icon: 'coins', color: 'green' },
  investment: { label: 'Investments', icon: 'trending-up', color: 'purple' },
};
const GROUPS = [['Bank Accounts', ['chequing', 'savings', 'cash', 'investment']], ['Credit Cards', ['credit_card']], ['Lines of Credit', ['line_of_credit']]];

export async function mountAccounts(v) {
  if (v.params[1]) return accountDetail(v, Number(v.params[1]));
  let accounts = [];
  const load = async () => { accounts = await api.get('/api/accounts'); if (v.alive()) render(); };
  v.setToolbar(html`<button class="bar-btn" data-import>${icon('download')}<span>Import</span></button><button class="bar-btn icon-only" data-add aria-label="Add account">${icon('plus')}</button>`, {
    '[data-add]': () => accountSheet({ onSaved: load }),
    '[data-import]': () => importSheet({ accounts, onDone: load }),
  });

  function render() {
    const scope = getScope();
    const shown = accounts.filter((a) => !a.archived && (scope === 'household' || a.owner_id === S.user.id || a.owner_id === null));
    const cash = shown.filter((a) => !ACCOUNT_TYPES[a.type].owes).reduce((s, a) => s + a.balance, 0);
    const owed = shown.filter((a) => ACCOUNT_TYPES[a.type].owes).reduce((s, a) => s + (a.owed || 0), 0);
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Accounts</h1><p>Import CSV statements from your bank and cards. Finta sorts them for you.</p></div>
      ${shown.length ? html`
        <div class="tiles">
          <div class="tile-stat"><span class="label">In the bank</span><span class="value">${money(cash, { short: true })}</span></div>
          <div class="tile-stat"><span class="label">Owed on cards & credit</span><span class="value">${money(owed, { short: true })}</span></div>
        </div>
        ${GROUPS.map(([title, types]) => {
          const list = shown.filter((a) => types.includes(a.type));
          if (!list.length) return '';
          return html`<section class="section"><div class="section-head"><h2>${title}</h2></div>
            <div class="group has-icons">${list.map(accountRow)}</div></section>`;
        })}
        <p class="section-foot">Accounts marked ${icon('lock', 'icon-sm')} are private: others in your household see the balance, not the transactions.</p>`
        : html`<div class="group">${emptyState('landmark', 'Add your first account', 'Chequing, savings, credit cards, lines of credit. Then import a CSV statement — Finta categorizes it, spots card payments and transfers, and marks bills paid.',
          html`<button class="btn prominent small" data-first>${icon('plus')} Add Account</button>`)}</div>`}`);
    hydrate(v.el);
    $('[data-first]', v.el)?.addEventListener('click', () => accountSheet({ onSaved: load }));
  }
  await load();
}

function accountRow(a) {
  const t = ACCOUNT_TYPES[a.type];
  const util = t.owes && a.credit_limit ? Math.round((a.owed / a.credit_limit) * 100) : null;
  const who = a.owner_id === null ? 'Joint' : a.owner_id === S.user.id ? '' : a.owner_name;
  return html`<a class="row" href="#/money/accounts/${a.id}">
    <span class="tile" data-color="${t.color}">${icon(t.icon)}</span>
    <span class="body"><span class="title">${a.name}${!a.can_view ? html`<span class="badge-inline">${icon('lock')}Private</span>` : ''}</span>
      <span class="sub">${[a.institution, a.last4 ? `••${a.last4}` : '', who, a.last_date ? `updated ${relDay(a.last_date).replace(/^(Today|Yesterday|Tomorrow)$/, (w) => w.toLowerCase())}` : 'no transactions yet'].filter(Boolean).join(' · ')}</span>
      ${util !== null ? html`<span class="util ${util > 90 ? 'over' : util > 30 ? 'high' : ''}"><i data-w="${Math.min(100, util)}"></i></span><span class="sub">${util}% of ${money(a.credit_limit, { short: true })} limit used</span>` : ''}
    </span>
    <span class="trail"><span class="stack"><span class="amount">${t.owes ? money(a.owed) : money(a.balance)}</span><span class="freq">${t.owes ? (a.balance > 0 ? 'credit' : 'owed') : 'balance'}</span></span>${icon('chevron-right', 'chev')}</span>
  </a>`;
}

// ─────────── One account ───────────
async function accountDetail(v, id) {
  v.setLead(html`<a class="bar-btn" href="#/money/accounts">${icon('chevron-left')}<span>Accounts</span></a>`);
  let a, txs = [], filter = 'all', q = '', ym = null;
  const load = async () => {
    a = await api.get(`/api/accounts/${id}`);
    if (a.can_view) txs = await api.get(`/api/accounts/${id}/transactions?${ym ? `month=${ym}&` : ''}${filter === 'review' ? 'filter=review' : ''}`);
    if (v.alive()) render();
  };

  function render() {
    const t = ACCOUNT_TYPES[a.type];
    v.setTitle(a.name);
    v.setToolbar(a.can_edit ? html`<button class="bar-btn" data-edit>Edit</button>` : '', { '[data-edit]': () => accountSheet({ account: a, onSaved: load, onDeleted: () => v.go('#/money/accounts') }) });
    const needle = q.trim().toLowerCase();
    const shown = txs.filter((x) => (filter !== 'transfers' || x.is_transfer) && (!needle || [x.note, x.description, x.category_name].some((s) => s?.toLowerCase().includes(needle))));
    const byDay = new Map();
    for (const x of shown) { if (!byDay.has(x.date)) byDay.set(x.date, []); byDay.get(x.date).push(x); }
    const reviewN = txs.filter((x) => !x.category_id && !x.is_transfer && !x.recurring_id).length;
    // Trim the history to when this account has data.
    const firstIdx = a.history.findIndex((p, i) => i > 0 && p.balance !== a.history[i - 1].balance);
    const hist = a.history.slice(Math.max(0, Math.min(firstIdx - 1, a.history.length - 30)));
    v.el.innerHTML = String(html`
      <div class="hero">
        <div class="label">${t.owes ? (a.balance > 0 ? 'Credit balance' : 'Balance owed') : 'Balance'}${a.institution ? ` · ${a.institution}` : ''}${a.last4 ? ` ••${a.last4}` : ''}</div>
        <div class="value">${t.owes ? money(Math.abs(a.balance)) : money(a.balance)}</div>
        <div class="sub">${[a.owner_id === null ? 'Joint account' : a.owner_name ? `${a.owner_name}’s account` : '', a.credit_limit ? `${money(Math.max(0, a.credit_limit - (a.owed || 0)), { short: true })} available of ${money(a.credit_limit, { short: true })}` : '', a.debt?.rate ? `${a.debt.rate}% interest` : ''].filter(Boolean).join(' · ')}</div>
      </div>
      ${a.can_edit ? html`<div class="btn-row section"><button class="btn prominent" data-import>${icon('download')} Import Statement</button></div>` : ''}
      ${hist.length > 2 ? html`<section class="section card"><div class="card-head"><h3>${t.owes ? 'Owed Over Time' : 'Balance Over Time'}</h3></div>
        <p class="card-sub">Closing balance each day. Hover or use arrow keys to read a day.</p><div id="bal-chart"></div></section>` : ''}
      ${!a.can_view ? html`<div class="group">${emptyState('lock', 'Private account', `${a.owner_name || 'Its owner'} keeps these transactions private. Its balance and spending still count in your household totals.`)}</div>` : html`
        <div class="section-head"><h2>Transactions</h2><span class="caps">${plural(txs.length, 'row')}</span></div>
        ${segmented([['all', 'All'], ['review', `To Sort${reviewN && filter !== 'review' ? ` (${reviewN})` : ''}`], ['transfers', 'Transfers']], filter, 'data-filter')}
        <div class="group"><label class="quick-add">${icon('search')}<input type="search" data-search placeholder="Search this account" value="${q}" aria-label="Search this account"></label></div>
        <div class="month-switch compact">
          <button class="chip" data-month="-1" aria-label="Earlier month">${icon('chevron-left', 'icon-sm')}</button>
          <button class="chip" data-month-all aria-pressed="${String(!ym)}">${ym ? fmtMonth(ym) : 'All months'}</button>
          <button class="chip" data-month="1" aria-label="Later month">${icon('chevron-right', 'icon-sm')}</button>
        </div>
        ${shown.length ? [...byDay].map(([day, list]) => html`<div class="day-head"><span>${relDay(day)}</span></div><div class="group has-icons">${list.map(txRow)}</div>`)
          : html`<div class="group">${emptyState(txs.length ? 'circle-check' : 'download', txs.length ? 'Nothing here' : 'No transactions yet', txs.length ? '' : 'Import a CSV statement from your bank’s website to fill this account.')}</div>`}
        ${a.imports.length ? html`<section class="section"><div class="section-head"><h2>Imports</h2></div><div class="group">
          ${a.imports.map((im) => html`<div class="row"><span class="body"><span class="title">${im.filename || 'Statement'}</span>
            <span class="sub">${fmtDate(im.created_at.slice(0, 10))} · ${plural(im.rows_imported, 'new row')}${im.rows_skipped ? `, ${im.rows_skipped} already here` : ''}${im.date_from ? ` · ${fmtDate(im.date_from)} – ${fmtDate(im.date_to)}` : ''}</span></span>
            <button class="btn small destructive plain" data-undo="${im.id}">Undo</button></div>`)}</div>
          <p class="section-foot">Undo removes exactly the rows that import added.</p></section>` : ''}`}`);
    hydrate(v.el);
    if (hist.length > 2) lines($('#bal-chart', v.el), {
      series: [{ name: t.owes ? 'Owed' : 'Balance', cls: 'c-tint', points: hist.map((p) => ({ x: p.date, y: t.owes ? -p.balance : p.balance })) }],
      caption: `${a.name} ${t.owes ? 'amount owed' : 'balance'} over time`,
    });
    $('[data-import]', v.el)?.addEventListener('click', () => importSheet({ account: a, onDone: load }));
    $$('[data-filter]', v.el).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; load(); }));
    const s = $('[data-search]', v.el);
    s?.addEventListener('input', () => { q = s.value; const pos = s.selectionStart; render(); const n = $('[data-search]', v.el); n.focus(); n.setSelectionRange(pos, pos); });
    $$('[data-month]', v.el).forEach((b) => b.addEventListener('click', () => { ym = ym ? addMonthsYM(ym, Number(b.dataset.month)) : S.today.slice(0, 7); load(); }));
    $('[data-month-all]', v.el)?.addEventListener('click', () => { ym = null; load(); });
    $$('[data-undo]', v.el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Undo this import?', message: 'Its rows are removed. Categories you set on them are lost; your rules stay.', confirm: 'Undo Import' }))) return;
      const r = await api.del(`/api/imports/${b.dataset.undo}`);
      toast(`Removed ${plural(r.removed, 'row')}`);
      load();
    }));
  }
  v.el.onclick = (e) => { const r = e.target.closest('[data-tx]'); if (r) txSheet(txs.find((x) => x.id === Number(r.dataset.tx)), load); };
  await load();
}

// ─────────── Add / edit account ───────────
export async function accountSheet({ account = null, type = null, onSaved, onDeleted } = {}) {
  const members = await getMembers();
  let k = account?.type || type;
  const s = sheet({
    title: account ? 'Edit Account' : 'New Account', primary: account ? 'Save' : 'Add',
    render: (api2) => {
      if (!k) return html`<p class="hint">What kind of account?</p><div class="group has-icons">
        ${Object.entries(ACCOUNT_TYPES).map(([id, t]) => html`<button type="button" class="row" data-type="${id}"><span class="tile" data-color="${t.color}">${icon(t.icon)}</span><span class="body"><span class="title">${t.label}</span></span>${icon('chevron-right', 'chev')}</button>`)}</div>`;
      const t = ACCOUNT_TYPES[k];
      const current = account ? (t.owes ? Math.abs(account.balance) : account.balance) : null;
      return html`<form class="form" novalidate>
        <input type="hidden" name="type" value="${k}">
        <div class="group">
          ${fText('name', 'Name', account?.name || '', { placeholder: { chequing: 'Everyday Chequing', savings: 'Savings', credit_card: 'Visa', line_of_credit: 'Line of Credit', cash: 'Wallet', investment: 'TFSA' }[k], required: true, maxlength: 60, autofocus: !account })}
          ${fText('institution', 'Bank', account?.institution || '', { placeholder: 'TD, RBC, Scotiabank…', maxlength: 60 })}
          ${fText('last4', 'Last 4 Digits', account?.last4 || '', { placeholder: 'Optional', inputmode: 'numeric', maxlength: 4 })}
        </div>
        <div class="group">
          ${fMoney('current_balance', t.owes ? 'Amount Owed' : 'Current Balance', current, { placeholder: '0.00' })}
          ${t.owes ? fMoney('credit_limit', 'Credit Limit', account?.credit_limit, { placeholder: 'Optional' }) : ''}
        </div>
        <p class="hint">${account ? 'Changing this re-anchors the balance without touching transactions.' : 'What your bank shows today. Imported statements with a balance column keep it in sync.'}</p>
        ${t.owes && !account ? html`<div class="group-label">For the Debts Planner</div><div class="group">
          ${fNumber('rate', 'Interest Rate', '', { placeholder: '20.99', suffix: '%' })}
          ${fMoney('min_payment', 'Minimum Payment', null, { placeholder: 'Optional' })}
        </div>` : ''}
        <div class="group">
          ${fSelect('owner_id', 'Belongs To', [[S.user.id, `${S.user.name} (You)`], ...(members.length > 1 ? [['', 'Joint — everyone']] : [])], account ? account.owner_id ?? '' : S.user.id, { data: 'data-int' })}
          ${members.length > 1 ? fToggle('is_private', 'Keep Transactions Private', account ? account.is_private : true, 'Others see the balance and totals, not the individual rows.') : ''}
        </div>
        ${account ? html`<div class="group">${fToggle('archived', 'Hide Account', account.archived, 'Keeps its history but hides it from lists.')}</div>
          <div class="group"><button type="button" class="row destructive" data-delete>Delete Account</button></div>` : ''}
      </form>`;
    },
    onMount: (d, a2) => {
      $$('[data-type]', d).forEach((b) => b.addEventListener('click', () => { k = b.dataset.type; a2.rerender(); a2.setTitle(`New ${ACCOUNT_TYPES[k].label}`); }));
      const primary = $('[data-sheet-primary]', d); if (primary) primary.hidden = !k;
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${account.name}”?`, message: 'Its imported transactions are deleted too. This can’t be undone.' }))) return;
        await api.del(`/api/accounts/${account.id}`); s.close(); toast(`Deleted ${account.name}`); onDeleted ? onDeleted() : onSaved?.();
      });
    },
    onSubmit: async (v) => {
      if (v.owner_id === null && members.length < 2) v.owner_id = S.user.id;
      if (v.current_balance == null) delete v.current_balance;
      if (account) { if (v.current_balance === (ACCOUNT_TYPES[k].owes ? Math.abs(account.balance) : account.balance)) delete v.current_balance; await api.patch(`/api/accounts/${account.id}`, v); }
      else await api.post('/api/accounts', v);
      toast(account ? 'Saved' : `Added ${v.name}`);
      onSaved?.();
    },
  });
}

// ─────────── Import a statement ───────────
/** One sheet, three steps: choose file → check preview → done. */
export function importSheet({ account = null, accounts = [], onDone } = {}) {
  let step = 'file';
  let acc = account || (accounts.length === 1 ? accounts[0] : null);
  let csv = '', filename = '', preview = null, result = null, mapping = {}, busy = false, error = '';
  const editable = accounts.filter((x) => x.can_edit && !x.archived);

  const s = sheet({
    title: 'Import Statement', primary: 'Import', dismissOnly: false,
    render: () => {
      if (step === 'file') return html`<div class="form">
        ${!account ? html`<div class="group-label">Account</div>
          ${editable.length ? html`<div class="group">${fSelect('acc', 'Import Into', [['', 'Choose…'], ...editable.map((x) => [x.id, x.name])], acc?.id ?? '', { data: 'data-int' })}</div>`
            : html`<div class="form-error">${icon('circle-alert')}<span>Add an account first — Accounts → +.</span></div>`}` : ''}
        <label class="drop" data-drop tabindex="0">${icon('download')}<strong>Choose a CSV file</strong><span>or drop it here</span>
          <input type="file" accept=".csv,text/csv,.txt" data-file aria-label="Choose a CSV file"></label>
        ${error ? html`<div class="form-error">${icon('circle-alert')}<span>${error}</span></div>` : ''}
        <p class="hint">Download “CSV” or “Spreadsheet” from your bank’s website for any date range. Columns like Date, Details, Debit, Credit (or a single Amount) are detected automatically. Overlapping dates are fine — rows already imported are skipped.</p>
      </div>`;
      if (step === 'done') return html`<div class="form">
        <div class="empty">${icon('circle-check')}<h3>Imported ${plural(result.imported, 'transaction')}</h3>
          <p>${[result.duplicates ? `${result.duplicates} already here` : '', result.bills ? `${plural(result.bills, 'bill')} marked paid` : '', result.transfers ? `${plural(result.transfers, 'transfer')} matched` : ''].filter(Boolean).join(' · ') || 'All sorted.'}</p></div>
        ${result.needsReview ? html`<a class="banner" href="#/money/review" data-go-review><span class="tile" data-color="blue">${icon('tag')}</span><span class="body"><span class="title">${plural(result.needsReview, 'transaction')} to sort</span><span class="sub">Finta learns from each one.</span></span>${icon('chevron-right', 'chev')}</a>`
          : html`<p class="section-foot">Everything was categorized automatically.</p>`}
        ${result.balanceUpdated ? html`<p class="section-foot">Balance set to ${money(Math.abs(result.balanceUpdated.amount))} from the statement (${fmtDate(result.balanceUpdated.date)}).</p>` : ''}
      </div>`;
      const p = preview;
      const cols = p.headers.map((h, i) => [i, h || `Column ${i + 1}`]);
      const colOpt = (name, label, value, allowNone = true) => fSelect(name, label, [...(allowNone ? [[-1, '—']] : []), ...cols], value, { data: 'data-int' });
      return html`<form class="form" novalidate>
        <p class="hint">${filename} → <strong>${acc.name}</strong> · ${p.stats.from ? `${fmtDate(p.stats.from)} – ${fmtDate(p.stats.to)}` : ''}</p>
        <div class="stat-grid">
          <div><b>${p.stats.new}</b><span>new</span></div>
          <div><b>${p.stats.categorized}</b><span>auto-sorted</span></div>
          <div><b>${p.stats.needsReview}</b><span>to review</span></div>
          <div><b>${p.stats.duplicates}</b><span>already here</span></div>
          <div><b>${p.stats.bills}</b><span>bills paid</span></div>
          <div><b>${p.stats.transfers}</b><span>transfers</span></div>
        </div>
        ${p.errors.length ? html`<div class="form-error">${icon('circle-alert')}<span>${plural(p.errors.length, 'row')} couldn’t be read (e.g. line ${p.errors[0].line}: ${p.errors[0].reason}). The rest will import.</span></div>` : ''}
        <details class="mapping" ${p.stats.new === 0 && p.total ? '' : ''}><summary>Columns look wrong? Adjust them</summary>
          <div class="group">
            ${colOpt('date', 'Date', p.mapping.date, false)}
            ${colOpt('description', 'Details', p.mapping.description, false)}
            ${colOpt('debit', 'Debit (money out)', p.mapping.debit)}
            ${colOpt('credit', 'Credit (money in)', p.mapping.credit)}
            ${colOpt('amount', 'Or One Amount Column', p.mapping.amount)}
            ${colOpt('balance', 'Balance', p.mapping.balance)}
            ${fSelect('dateOrder', 'Date Format', [['MDY', 'Month/Day/Year'], ['DMY', 'Day/Month/Year'], ['YMD', 'Year-Month-Day']], p.mapping.dateOrder)}
            ${p.mapping.amount >= 0 ? fToggle('flipSign', 'Purchases Are Positive', p.mapping.flipSign, 'Turn on if spending shows as money in.') : ''}
            ${fToggle('hasHeader', 'First Row Is Headers', p.mapping.hasHeader)}
          </div>
          <div class="btn-row"><button class="btn small" type="button" data-remap>Update Preview</button></div>
        </details>
        ${p.statementBalance ? html`<div class="group">${fToggle('useBalance', 'Use Statement Balance', true, `Set the balance to ${money(Math.abs(p.statementBalance.amount))} as of ${fmtDate(p.statementBalance.date)}.`)}</div>` : ''}
        <div class="group-label">First ${Math.min(p.rows.length, 25)} of ${p.total} rows</div>
        <table class="preview-table"><tbody>
          ${p.rows.slice(0, 25).map((r) => html`<tr class="${r.duplicate ? 'dup' : ''}">
            <td class="when">${fmtDate(r.date)}</td>
            <td>${r.name}<span class="desc">${r.description}</span>
              <span class="tag">${r.duplicate ? html`<span class="pill">Already here</span>` : r.transfer ? html`<span class="pill">${icon('refresh-cw')}Transfer</span>` : r.bill ? html`<span class="pill pos">${icon('check')}${r.bill}</span>` : r.category ? html`<span class="pill tint">${r.category}</span>` : html`<span class="pill warn">To review</span>`}</span></td>
            <td class="amt ${r.direction === 'in' ? 'text-pos' : ''}">${r.direction === 'in' ? '+' : '−'}${money(r.amount)}</td></tr>`)}
        </tbody></table>
      </form>`;
    },
    onMount: (d, api2) => {
      const primary = $('[data-sheet-primary]', d);
      if (primary) { primary.hidden = step !== 'preview' || !preview?.stats.new; primary.textContent = preview ? `Import ${preview.stats.new}` : 'Import'; }
      const cancel = $('[data-sheet-cancel]', d);
      if (cancel) cancel.textContent = step === 'done' ? 'Done' : 'Cancel';
      const read = async (file) => {
        if (!file) return;
        if (!acc) { error = 'Choose the account this statement is from.'; api2.rerender(); return; }
        if (file.size > 6 * 1024 * 1024) { error = 'That file is over 6 MB. Export a shorter date range.'; api2.rerender(); return; }
        filename = file.name; csv = await file.text();
        await doPreview(api2);
      };
      $('[name=acc]', d)?.addEventListener('change', (e) => { acc = editable.find((x) => x.id === Number(e.target.value)) || null; error = ''; });
      $('[data-file]', d)?.addEventListener('change', (e) => read(e.target.files[0]));
      const drop = $('[data-drop]', d);
      if (drop) {
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); read(e.dataTransfer.files[0]); });
        drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('[data-file]', d).click(); } });
      }
      $('[data-remap]', d)?.addEventListener('click', async () => {
        for (const k of ['date', 'description', 'debit', 'credit', 'amount', 'balance']) { const el = $(`[name=${k}]`, d); if (el) mapping[k] = Number(el.value); }
        mapping.dateOrder = $('[name=dateOrder]', d).value;
        const fl = $('[name=flipSign]', d); if (fl) mapping.flipSign = fl.checked;
        mapping.hasHeader = $('[name=hasHeader]', d).checked;
        await doPreview(api2);
      });
      $('[data-go-review]', d)?.addEventListener('click', () => s.close());
    },
    onSubmit: async (v) => {
      if (step === 'done') return;
      busy = true;
      result = await api.post(`/api/accounts/${acc.id}/import`, { csv, filename, mapping, useStatementBalance: v.useBalance !== false });
      step = 'done';
      s.setTitle('Imported');
      s.rerender();
      onDone?.();
      return true; // keep the sheet open on the summary
    },
  });

  async function doPreview(api2) {
    try {
      error = '';
      preview = await api.post(`/api/accounts/${acc.id}/import/preview`, { csv, mapping });
      mapping = { ...mapping };
      step = 'preview';
      api2.setTitle('Check & Import');
    } catch (e) { error = e.message; step = 'file'; }
    api2.rerender();
  }
}

// ─────────── Review inbox ───────────
export async function mountReview(v) {
  let data, cats, recurring;
  const load = async () => {
    [data, cats, recurring] = await Promise.all([api.get('/api/review'), getCategories(), api.get('/api/recurring')]);
    if (v.alive()) render();
  };
  function render() {
    const out = cats.filter((c) => c.kind === 'out' && !c.archived);
    const inc = cats.filter((c) => c.kind === 'in' && !c.archived);
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Review</h1><p>${data.count ? `${plural(data.count, 'transaction')} Finta couldn’t place. Pick a category once and it’s remembered.` : 'All caught up.'}</p></div>
      ${data.groups.length ? data.groups.map((g, gi) => {
        const list = g.direction === 'in' ? [...inc, ...out] : out;
        const bills = recurring.filter((r) => r.direction === g.direction && !r.paused);
        return html`<article class="review-card" data-group="${gi}">
          <div class="rc-head"><span class="rc-name">${g.name}</span><span class="amount ${g.direction === 'in' ? 'text-pos' : ''}">${g.direction === 'in' ? '+' : ''}${money(g.total)}</span></div>
          <div class="rc-meta">${g.rows.length > 1 ? `${g.rows.length} times · ` : ''}${g.rows.slice(0, 3).map((r) => fmtDate(r.date)).join(', ')}${g.rows.length > 3 ? '…' : ''} · ${g.rows[0].account_name}<br>${g.rows[0].description}</div>
          <div class="chips" role="group" aria-label="Category for ${g.name}">
            ${list.map((c) => html`<button class="chip" data-cat="${c.id}"><span class="tile" data-color="${c.color}">${icon(c.icon)}</span>${c.name}</button>`)}
            <button class="chip" data-transfer>${icon('refresh-cw', 'icon-sm')} Transfer</button>
          </div>
          <div class="rc-foot">
            ${bills.length ? html`<label>${g.direction === 'in' ? 'It’s income:' : 'It’s a bill:'} <select data-bill><option value="">Choose…</option>${bills.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select></label>` : ''}
            <label><input type="checkbox" data-remember checked> Remember for ${g.key || 'similar'}</label>
          </div>
        </article>`;
      }) : html`<div class="group">${emptyState('circle-check', 'Nothing to sort', 'New imports land here only when Finta can’t tell what something is.')}</div>`}
      ${data.groups.length ? html`<p class="section-foot">Transfers are money moving between your own accounts, like paying a card or topping up savings. They don’t count as spending.</p>` : ''}`);
  }
  v.el.onclick = async (e) => {
    const card = e.target.closest('[data-group]');
    if (!card) return;
    const g = data.groups[Number(card.dataset.group)];
    const remember = $('[data-remember]', card).checked;
    const cat = e.target.closest('[data-cat]');
    const tr = e.target.closest('[data-transfer]');
    if (!cat && !tr) return;
    card.classList.add('done');
    const body = tr ? { transfer: true, apply_to_similar: remember } : { category_id: Number(cat.dataset.cat), apply_to_similar: remember };
    const first = await api.post(`/api/transactions/${g.rows[0].id}/categorize`, body);
    // Without "remember", still apply to the other rows in this group.
    if (!remember) for (const r of g.rows.slice(1)) await api.post(`/api/transactions/${r.id}/categorize`, { ...body, apply_to_similar: false });
    const label = tr ? 'Transfer' : cats.find((c) => c.id === Number(cat.dataset.cat)).name;
    toast(`${g.name} → ${label}${remember && first.similar ? ` · ${plural(first.similar, 'more')} updated` : ''}`);
    v.refreshBadges();
    await load();
  };
  v.el.onchange = async (e) => {
    const sel = e.target.closest('[data-bill]');
    if (!sel || !sel.value) return;
    const card = sel.closest('[data-group]');
    const g = data.groups[Number(card.dataset.group)];
    card.classList.add('done');
    try {
      await api.post(`/api/transactions/${g.rows[0].id}/categorize`, { recurring_id: Number(sel.value), apply_to_similar: $('[data-remember]', card).checked });
      toast(`${g.name} linked to ${sel.selectedOptions[0].textContent}`);
    } catch (err) { toast(err.message, { error: true }); }
    await load();
  };
  await load();
}

// ─────────── One imported transaction ───────────
export async function categorizeSheet(t, reload) {
  const [cats, recurring] = await Promise.all([getCategories(), api.get('/api/recurring')]);
  let catId = t.category_id;
  const list = cats.filter((c) => !c.archived && (t.direction === 'in' ? true : c.kind === 'out'));
  const bills = recurring.filter((r) => r.direction === t.direction);
  sheet({
    title: t.note || 'Transaction', primary: 'Save',
    render: () => html`<form class="form" novalidate>
      <div class="amount-entry"><label>${t.direction === 'in' ? 'Money In' : 'Money Out'}</label><div class="wrap">${t.direction === 'in' ? '+' : ''}${money(t.amount)}</div></div>
      <p class="hint">${fmtDate(t.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${t.account_name || 'Imported'}<br><span class="text-2">${t.description}</span></p>
      ${t.is_transfer ? html`<div class="banner"><span class="tile" data-color="gray">${icon('refresh-cw')}</span><span class="body"><span class="title">Transfer${t.peer_account ? ` ${t.direction === 'out' ? 'to' : 'from'} ${t.peer_account}` : ''}</span><span class="sub">Not counted as spending or income. Pick a category below if this was really a purchase.</span></span></div>` : ''}
      ${t.recurring_id ? html`<div class="banner"><span class="tile" data-color="green">${icon('check')}</span><span class="body"><span class="title">Paid ${t.recurring_name || 'a bill'}</span><span class="sub">Due ${fmtDate(t.due_date)}</span></span></div>` : ''}
      <div class="group">${fText('rename', 'Name', t.note || '', { maxlength: 80 })}</div>
      <div class="group-label">Category</div>
      <div class="cat-grid" role="group" aria-label="Category">
        ${list.map((c) => html`<button type="button" data-cat="${c.id}" aria-pressed="${String(c.id === catId)}"><span class="tile" data-color="${c.color}">${icon(c.icon)}</span>${c.name}</button>`)}
      </div>
      <div class="group">
        ${bills.length ? fSelect('recurring_id', t.direction === 'in' ? 'Income It Pays' : 'Bill It Pays', [['', 'None'], ...bills.map((b) => [b.id, b.name])], t.recurring_id ?? '', { data: 'data-int' }) : ''}
        ${fToggle('transfer', 'This Is a Transfer', !!t.is_transfer, 'Money between my own accounts — a card payment or savings top-up.')}
        ${fToggle('apply_to_similar', 'Remember for Similar', true, `Future and past rows from ${t.merchant || 'this merchant'} get the same treatment.`)}
      </div>
      <input type="hidden" name="category_id" data-int value="${catId ?? ''}">
    </form>`,
    onMount: (d) => {
      $$('[data-cat]', d).forEach((b) => b.addEventListener('click', () => {
        catId = Number(b.dataset.cat) === catId ? null : Number(b.dataset.cat);
        $$('[data-cat]', d).forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.cat) === catId)));
        $('[name=category_id]', d).value = catId ?? '';
        if (catId) $('[name=transfer]', d).checked = false;
      }));
    },
    onSubmit: async (v) => {
      const body = { apply_to_similar: v.apply_to_similar, rename: v.rename && v.rename !== t.note ? v.rename : undefined };
      if (v.transfer) body.transfer = true;
      else { body.category_id = v.category_id; if (v.recurring_id && v.recurring_id !== t.recurring_id) body.recurring_id = v.recurring_id; }
      const r = await api.post(`/api/transactions/${t.id}/categorize`, body);
      toast(r.similar ? `Saved · ${plural(r.similar, 'similar row')} updated` : 'Saved');
      reload?.();
    },
  });
}

export { raw, KINDS, centsToInput };

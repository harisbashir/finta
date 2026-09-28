// Settings: profile, household & members, categories, sign-in & security, data.
import { api, passkeysSupported, createPasskey } from '../api.js';
import { html, raw, icon, $, $$, S, sheet, toast, confirmDialog, fText, fSelect, fToggle, fMoney, initials, emptyState, fmtDate, plural, applyTheme } from '../ui.js';
import { getCategories, getMembers, invalidate } from '../store.js';
import { COLORS_UI } from './palette.js';

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'INR', 'PKR', 'AED', 'JPY', 'CHF', 'MXN'];
const ICON_CHOICES = ['house', 'zap', 'shopping-cart', 'utensils', 'car', 'heart-pulse', 'shield', 'repeat', 'baby', 'shopping-bag', 'ticket', 'sparkles', 'gift', 'plane', 'paw-print', 'credit-card', 'tag', 'briefcase', 'circle-plus', 'wifi', 'droplets', 'flame', 'tv', 'sofa', 'coins', 'store', 'sprout', 'umbrella', 'hammer', 'monitor'];

export async function mount(v) {
  const sub = v.params[0];
  v.setLead(html`${sub ? html`<a class="bar-btn" href="#/settings">${icon('chevron-left')}<span>Settings</span></a>` : ''}`);
  if (sub === 'security') return security(v);
  if (sub === 'categories') return categories(v);
  if (sub === 'activity') return activity(v);
  if (sub === 'rules') return rules(v);
  return main(v);
}

async function main(v) {
  const members = await getMembers(true);
  const owner = S.user.role === 'owner';
  const h = S.household;
  v.el.innerHTML = String(html`
    <div class="large-title"><h1>Settings</h1></div>
    <section class="section"><div class="group">
      <button class="row" data-profile><span class="avatar lg" data-color="${S.user.color}">${initials(S.user.name)}</span>
        <span class="body"><span class="title"><strong>${S.user.name}</strong></span><span class="sub">${S.user.email} · ${S.user.role === 'owner' ? 'Owner' : 'Member'}</span></span>${icon('chevron-right', 'chev')}</button>
    </div></section>

    <section class="section">
      <div class="section-head"><span class="caps">Appearance</span></div>
      <div class="segmented appearance" role="radiogroup" aria-label="Appearance">
        ${[['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => html`<button role="radio" data-theme-choice="${k}" aria-checked="${String((S.user.theme || 'system') === k)}" aria-selected="${String((S.user.theme || 'system') === k)}">${l}</button>`)}
      </div>
      <p class="section-foot">Automatic follows your device’s light or dark setting.</p>
    </section>

    <section class="section">
      <div class="section-head"><span class="caps">Household</span></div>
      <div class="group has-icons">
        <button class="row" data-household ${owner ? '' : raw('disabled')}><span class="tile" data-color="blue">${icon('house')}</span><span class="body"><span class="title">${h.name}</span><span class="sub">${h.currency} · ${h.timezone.replace(/_/g, ' ')}</span></span>${owner ? icon('chevron-right', 'chev') : ''}</button>
        <a class="row" href="#/settings/categories"><span class="tile" data-color="orange">${icon('tag')}</span><span class="body"><span class="title">Categories</span></span>${icon('chevron-right', 'chev')}</a>
        <a class="row" href="#/settings/rules"><span class="tile" data-color="purple">${icon('sparkles')}</span><span class="body"><span class="title">Import Rules</span><span class="sub">What Finta has learned about your merchants</span></span>${icon('chevron-right', 'chev')}</a>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><span class="caps">People</span></div>
      <div class="group">
        ${members.map((m) => html`<button class="row" data-member="${m.id}" ${owner && m.id !== S.user.id ? '' : raw('disabled')}>
          <span class="avatar" data-color="${m.color}">${initials(m.name)}</span>
          <span class="body"><span class="title">${m.name}${m.id === S.user.id ? ' (You)' : ''}</span><span class="sub">${m.role === 'owner' ? 'Owner' : 'Member'}${m.totp || m.passkeys ? ' · Extra security on' : ''}</span></span>
          ${owner && m.id !== S.user.id ? icon('chevron-right', 'chev') : ''}</button>`)}
        ${owner ? html`<button class="row center" data-invite>${icon('users')} Invite Someone</button>` : ''}
      </div>
      <p class="section-foot">Everyone shares the same money, tasks, lists and meals. Owners can change household settings and invite people.</p>
    </section>

    <section class="section">
      <div class="section-head"><span class="caps">Account</span></div>
      <div class="group has-icons">
        <a class="row" href="#/settings/security"><span class="tile" data-color="green">${icon('lock')}</span><span class="body"><span class="title">Sign-In & Security</span><span class="sub">Passkeys, two-factor, password, devices</span></span>${icon('chevron-right', 'chev')}</a>
        <a class="row" href="/api/export" download><span class="tile" data-color="indigo">${icon('download')}</span><span class="body"><span class="title">Export Data</span><span class="sub">Everything, as a JSON file</span></span></a>
        ${owner ? html`<a class="row" href="#/settings/activity"><span class="tile" data-color="gray">${icon('activity')}</span><span class="body"><span class="title">Activity</span><span class="sub">Sign-ins and security changes</span></span>${icon('chevron-right', 'chev')}</a>` : ''}
      </div>
    </section>

    <section class="section"><div class="group">
      <button class="row center" data-signout>Sign Out</button>
    </div></section>
    <section class="section"><div class="group">
      <button class="row destructive" data-delete-account>Delete Account…</button>
    </div>
    <p class="section-foot">Finta ${S.version || ''} · self-hosted · your data never leaves your server.</p></section>`);

  const el = v.el;
  $$('[data-theme-choice]', el).forEach((b) => b.addEventListener('click', async () => {
    const theme = b.dataset.themeChoice;
    applyTheme(theme);
    S.user.theme = theme;
    $$('[data-theme-choice]', el).forEach((x) => { const on = String(x === b); x.setAttribute('aria-checked', on); x.setAttribute('aria-selected', on); });
    try { await api.patch('/api/me', { theme }); } catch (err) { toast(err.message, { error: true }); }
  }));
  $('[data-profile]', el).onclick = () => profileSheet(() => location.reload());
  $('[data-household]', el).onclick = () => householdSheet(() => location.reload());
  $('[data-invite]', el)?.addEventListener('click', inviteSheet);
  $$('[data-member]', el).forEach((b) => b.addEventListener('click', () => memberSheet(members.find((m) => m.id === Number(b.dataset.member)), () => main(v))));
  $('[data-signout]', el).onclick = async () => { await api.post('/api/logout'); location.hash = '#/'; location.reload(); };
  $('[data-delete-account]', el).onclick = deleteAccountSheet;
}

function profileSheet(done) {
  sheet({
    title: 'Profile',
    render: () => html`<form class="form" novalidate>
      <div class="group">${fText('name', 'Name', S.user.name, { required: true, maxlength: 60 })}
        <div class="field"><span class="label">Email</span><input value="${S.user.email}" disabled aria-label="Email"></div></div>
      <div class="group-label">Color</div>
      <div class="color-row" role="radiogroup" aria-label="Color">${COLORS_UI.map((c) => html`<label class="swatch" data-color="${c}"><input type="radio" name="color" value="${c}" ${c === S.user.color ? raw('checked') : ''} aria-label="${c}"><span></span></label>`)}</div>
    </form>`,
    onSubmit: async (v) => { await api.patch('/api/me', v); invalidate('members'); done(); },
  });
}

function householdSheet(done) {
  const h = S.household;
  const zones = (Intl.supportedValuesOf?.('timeZone') || [h.timezone]);
  sheet({
    title: 'Household',
    render: () => html`<form class="form" novalidate>
      <div class="group">${fText('name', 'Name', h.name, { required: true, maxlength: 80 })}
        ${fSelect('currency', 'Currency', CURRENCIES.map((c) => [c, c]), h.currency)}
        ${fSelect('timezone', 'Time Zone', zones.map((z) => [z, z.replace(/_/g, ' ')]), h.timezone)}
        ${fSelect('week_starts', 'Week Starts', [[0, 'Sunday'], [1, 'Monday']], h.week_starts, { data: 'data-int' })}
      </div>
      <p class="hint">The time zone decides when “today” starts for bills and tasks.</p>
    </form>`,
    onSubmit: async (v) => { await api.patch('/api/household', v); done(); },
  });
}

async function inviteSheet() {
  const r = await api.post('/api/household/invites');
  sheet({
    title: 'Invite Someone', dismissOnly: true,
    render: () => html`<div class="form">
      <p class="hint">Send this link to someone in your household. It works once and expires in ${r.expiresInDays} days.</p>
      <div class="group"><div class="field stack"><input value="${r.url}" readonly aria-label="Invitation link" data-link></div></div>
      <div class="btn-row">
        <button class="btn prominent" data-copy>${icon('copy')} Copy Link</button>
        ${navigator.share ? html`<button class="btn" data-share>Share…</button>` : ''}
      </div>
      <div class="section"></div>
      <div class="qr" data-qr aria-label="QR code for the invitation link"></div>
      <p class="section-foot">Or scan this code with their phone’s camera.</p>
    </div>`,
    onMount: async (d) => {
      $('[data-copy]', d).onclick = async () => { await navigator.clipboard.writeText(r.url); toast('Link copied'); };
      $('[data-share]', d)?.addEventListener('click', () => navigator.share({ title: 'Join our household on Finta', url: r.url }).catch(() => {}));
      $('[data-qr]', d).innerHTML = await qrSvg(r.url);
    },
  });
}

async function qrSvg(text) {
  const { default: qrcode } = await import('../vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function memberSheet(m, done) {
  const s = sheet({
    title: m.name,
    render: () => html`<form class="form" novalidate>
      <div class="group">${fSelect('role', 'Role', [['member', 'Member'], ['owner', 'Owner']], m.role)}</div>
      <p class="hint">Owners can change household settings, invite people and remove members.</p>
      <div class="group"><button type="button" class="row destructive" data-remove>Remove from Household</button></div>
    </form>`,
    onMount: (d) => {
      $('[data-remove]', d).onclick = async () => {
        if (!(await confirmDialog({ title: `Remove ${m.name}?`, message: 'They’ll be signed out and lose access. Their past entries stay.', confirm: 'Remove' }))) return;
        await api.del(`/api/household/members/${m.id}`); invalidate('members'); s.close(); done(); toast(`${m.name} removed`);
      };
    },
    onSubmit: async (v) => { await api.patch(`/api/household/members/${m.id}`, v); invalidate('members'); done(); },
  });
}

function deleteAccountSheet() {
  sheet({
    title: 'Delete Account', primary: 'Delete',
    render: () => html`<form class="form" novalidate>
      <div class="form-error">${icon('circle-alert')}<span>This can’t be undone. ${S.user.role === 'owner' ? 'If you’re the only person in the household, the whole household and all its data are deleted.' : 'Your account is removed; the household’s data stays.'} Export your data first if you want a copy.</span></div>
      <div class="group">${fText('password', 'Password', '', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Required' })}</div>
    </form>`,
    onSubmit: async (v) => {
      await api.post('/api/me/delete', v);
      location.hash = '#/'; location.reload();
    },
  });
}

// ─────────── Sign-in & security ───────────
async function security(v) {
  v.setTitle('Sign-In & Security');
  const load = async () => {
    const s = await api.get('/api/me/security');
    if (!v.alive()) return;
    const pk = passkeysSupported();
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Sign-In & Security</h1><p>Finta is on the internet, so it’s worth adding a passkey or two-factor.</p></div>

      <section class="section">
        <div class="section-head"><h2>Passkeys</h2></div>
        <div class="group has-icons">
          ${s.passkeys.map((p) => html`<div class="row"><span class="tile" data-color="blue">${icon('fingerprint')}</span>
            <span class="body"><span class="title">${p.name}</span><span class="sub">Added ${fmtDate(p.created_at.slice(0, 10))}${p.last_used_at ? ` · Last used ${fmtDate(p.last_used_at.slice(0, 10))}` : ''}</span></span>
            <button class="btn small destructive plain" data-remove-pk="${p.id}" aria-label="Remove ${p.name}">Remove</button></div>`)}
          ${pk ? html`<button class="row center" data-add-pk>${icon('plus')} Add a Passkey</button>` : html`<div class="row"><span class="body sub">Passkeys need a secure (https) connection and a supported browser.</span></div>`}
        </div>
        <p class="section-foot">Sign in with Face ID, Touch ID, Windows Hello or your phone — no password to type or steal.</p>
      </section>

      <section class="section">
        <div class="section-head"><h2>Two-Factor Authentication</h2></div>
        <div class="group">
          <div class="row"><span class="body"><span class="title">Authenticator app</span><span class="sub">${s.totp ? `On · ${plural(s.recoveryCodesLeft, 'recovery code')} left` : 'Off'}</span></span>
            ${s.totp ? html`<span class="pill pos">${icon('shield-check')}On</span>` : ''}</div>
          ${s.totp ? html`<button class="row center" data-new-codes>New Recovery Codes</button><button class="row destructive" data-disable-2fa>Turn Off Two-Factor</button>`
            : html`<button class="row center" data-enable-2fa>Turn On Two-Factor</button>`}
        </div>
        <p class="section-foot">After your password, Finta asks for a 6-digit code from an app like 1Password, Google Authenticator or Authy.</p>
      </section>

      <section class="section"><div class="group"><button class="row center" data-password>Change Password</button></div></section>

      <section class="section">
        <div class="section-head"><h2>Devices</h2>${s.sessions.length > 1 ? html`<button class="link" data-signout-others>Sign Out Others</button>` : ''}</div>
        <div class="group has-icons">${s.sessions.map((x) => html`<div class="row"><span class="tile" data-color="gray">${icon(/iPhone|Android|Mobile/.test(x.user_agent || '') ? 'smartphone' : 'laptop')}</span>
          <span class="body"><span class="title">${describeUA(x.user_agent)}${x.current ? ' · This device' : ''}</span><span class="sub">Active ${fmtDate(x.last_seen_at.slice(0, 10))} · ${x.ip || ''}</span></span>
          ${x.current ? '' : html`<button class="btn small destructive plain" data-revoke="${x.id}">Sign Out</button>`}</div>`)}</div>
      </section>`);

    const el = v.el;
    $('[data-add-pk]', el)?.addEventListener('click', addPasskey);
    $$('[data-remove-pk]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Remove this passkey?', message: 'You won’t be able to sign in with it anymore.', confirm: 'Remove' }))) return;
      await api.del(`/api/me/passkeys/${b.dataset.removePk}`); load();
    }));
    $('[data-enable-2fa]', el)?.addEventListener('click', () => enable2fa(load));
    $('[data-disable-2fa]', el)?.addEventListener('click', () => passwordSheet('Turn Off Two-Factor', 'Turn Off', async (pw) => { await api.post('/api/me/2fa/disable', { password: pw }); toast('Two-factor is off'); load(); }));
    $('[data-new-codes]', el)?.addEventListener('click', () => passwordSheet('New Recovery Codes', 'Continue', async (pw) => { const r = await api.post('/api/me/recovery-codes', { password: pw }); showCodes(r.recoveryCodes, load); return true; }));
    $('[data-password]', el).onclick = changePassword;
    $('[data-signout-others]', el)?.addEventListener('click', async () => { await api.post('/api/me/sessions/sign-out-others'); toast('Signed out of other devices'); load(); });
    $$('[data-revoke]', el).forEach((b) => b.addEventListener('click', async () => { await api.del(`/api/me/sessions/${b.dataset.revoke}`); load(); }));
  };

  async function addPasskey() {
    try {
      const { ticket, options } = await api.post('/api/me/passkeys/options');
      const credential = await createPasskey(options);
      await api.post('/api/me/passkeys', { ticket, credential });
      toast('Passkey added. Next time, choose “Sign In with a Passkey”.');
      load();
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;
      toast(err.name === 'InvalidStateError' ? 'This device already has a passkey for Finta.' : err.message, { error: true });
    }
  }
  await load();
}

function describeUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac OS X/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function passwordSheet(title, primary, action) {
  sheet({
    title, primary,
    render: () => html`<form class="form" novalidate><p class="hint">Enter your password to continue.</p>
      <div class="group">${fText('password', 'Password', '', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Required', autofocus: true })}</div></form>`,
    onSubmit: async (v) => action(v.password),
  });
}

function enable2fa(done) {
  passwordSheet('Turn On Two-Factor', 'Continue', async (pw) => {
    const setup = await api.post('/api/me/2fa/setup', { password: pw });
    setTimeout(() => sheet({
      title: 'Scan the Code', primary: 'Verify',
      render: () => html`<form class="form" novalidate>
        <p class="hint">1. Open your authenticator app and scan this code.</p>
        <div class="qr" data-qr></div>
        <p class="secret" aria-label="Setup key">${setup.secret.match(/.{1,4}/g).join(' ')}</p>
        <p class="hint">Can’t scan? Enter the key above instead. 2. Type the 6-digit code the app shows.</p>
        <div class="group">${fText('code', '', '', { placeholder: '123456', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, stack: true, maxlength: 6 })}</div>
      </form>`,
      onMount: async (d) => { $('[data-qr]', d).innerHTML = await qrSvg(setup.uri); $('[name=code]', d).classList.add('code-input'); },
      onSubmit: async (v) => { const r = await api.post('/api/me/2fa/enable', { code: v.code }); setTimeout(() => showCodes(r.recoveryCodes, done), 250); },
    }), 250);
  });
}

function showCodes(codes, done) {
  sheet({
    title: 'Recovery Codes', dismissOnly: true,
    render: () => html`<div class="form">
      <div class="form-error">${icon('circle-alert')}<span>Save these somewhere safe, like your password manager. Each code signs you in once if you lose your phone. You won’t see them again.</span></div>
      <div class="group recovery-codes">${codes.map((c) => html`<span>${c}</span>`)}</div>
      <div class="section"></div>
      <button class="btn prominent block" data-copy>${icon('copy')} Copy Codes</button></div>`,
    onMount: (d) => { $('[data-copy]', d).onclick = async () => { await navigator.clipboard.writeText(codes.join('\n')); toast('Codes copied'); }; },
  });
  done?.();
}

function changePassword() {
  sheet({
    title: 'Change Password', primary: 'Change',
    render: () => html`<form class="form" novalidate>
      <input type="text" name="username" value="${S.user.email}" autocomplete="username" hidden>
      <div class="group">
        ${fText('current', 'Current', '', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Required' })}
        ${fText('password', 'New', '', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '10+ characters' })}
      </div>
      <p class="hint">Other devices are signed out when you change your password.</p></form>`,
    onSubmit: async (v) => { await api.post('/api/me/password', v); toast('Password changed'); },
  });
}

// ─────────── Categories ───────────
async function categories(v) {
  v.setTitle('Categories');
  const load = async () => {
    const cats = await getCategories(true);
    if (!v.alive()) return;
    const render = (kind) => cats.filter((c) => c.kind === kind).map((c) => html`<button class="row" data-cat="${c.id}">
      <span class="tile" data-color="${c.color}">${icon(c.icon)}</span><span class="body"><span class="title">${c.name}</span>${c.archived ? html`<span class="sub">Hidden</span>` : ''}</span>${icon('chevron-right', 'chev')}</button>`);
    v.el.innerHTML = String(html`<div class="large-title"><h1>Categories</h1></div>
      <section class="section"><div class="section-head"><span class="caps">Spending</span></div><div class="group has-icons">${render('out')}</div></section>
      <section class="section"><div class="section-head"><span class="caps">Income</span></div><div class="group has-icons">${render('in')}</div></section>`);
    $$('[data-cat]', v.el).forEach((b) => b.addEventListener('click', () => categorySheet(cats.find((c) => c.id === Number(b.dataset.cat)), load)));
  };
  v.setToolbar(html`<button class="bar-btn icon-only" data-add aria-label="New category">${icon('plus')}</button>`, { '[data-add]': () => categorySheet(null, load) });
  await load();
}

function categorySheet(cat, done) {
  let chosenIcon = cat?.icon || 'tag';
  const s = sheet({
    title: cat ? cat.name : 'New Category', primary: cat ? 'Save' : 'Add',
    render: () => html`<form class="form" novalidate>
      <div class="group">${fText('name', 'Name', cat?.name || '', { required: true, maxlength: 40, autofocus: !cat })}
        ${cat ? '' : fSelect('kind', 'Type', [['out', 'Spending'], ['in', 'Income']], 'out')}
        ${fMoney('monthly_budget', 'Monthly Budget', cat?.monthly_budget, { placeholder: 'None' })}</div>
      <div class="group-label">Color</div>
      <div class="color-row" role="radiogroup" aria-label="Color">${COLORS_UI.map((c) => html`<label class="swatch" data-color="${c}"><input type="radio" name="color" value="${c}" ${c === (cat?.color || 'blue') ? raw('checked') : ''} aria-label="${c}"><span></span></label>`)}</div>
      <div class="group-label">Symbol</div>
      <div class="icon-grid" role="radiogroup" aria-label="Symbol">${ICON_CHOICES.map((i) => html`<button type="button" data-icon="${i}" aria-pressed="${String(i === chosenIcon)}" aria-label="${i.replace(/-/g, ' ')}">${icon(i)}</button>`)}</div>
      <input type="hidden" name="icon" value="${chosenIcon}">
      ${cat ? html`<div class="group">${fToggle('archived', 'Hide', !!cat.archived, 'Hidden categories stay on past entries but aren’t offered for new ones.')}</div>
        <div class="group"><button type="button" class="row destructive" data-delete>Delete Category</button></div>` : ''}
    </form>`,
    onMount: (d) => {
      $$('[data-icon]', d).forEach((b) => b.addEventListener('click', () => {
        chosenIcon = b.dataset.icon; $('[name=icon]', d).value = chosenIcon;
        $$('[data-icon]', d).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.icon === chosenIcon)));
      }));
      $('[data-delete]', d)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete “${cat.name}”?`, message: 'Entries in this category become uncategorized.' }))) return;
        await api.del(`/api/categories/${cat.id}`); invalidate('categories'); s.close(); done();
      });
    },
    onSubmit: async (v) => {
      if (cat) await api.patch(`/api/categories/${cat.id}`, v); else await api.post('/api/categories', v);
      invalidate('categories'); done();
    },
  });
}

// ─────────── Activity ───────────
async function activity(v) {
  v.setTitle('Activity');
  const rows = await api.get('/api/household/activity');
  const LABEL = {
    login: 'Signed in', 'login.failed': 'Wrong password', 'password.changed': 'Changed password', '2fa.enabled': 'Turned on two-factor',
    '2fa.disabled': 'Turned off two-factor', 'passkey.added': 'Added a passkey', 'passkey.removed': 'Removed a passkey', 'member.joined': 'Joined the household',
    'member.removed': 'Removed a member', 'member.role': 'Changed a role', 'invite.created': 'Created an invitation', 'household.created': 'Created the household',
    'data.exported': 'Exported data', 'sessions.revoked': 'Signed out other devices', 'recovery_code.used': 'Used a recovery code', 'recovery_codes.regenerated': 'Made new recovery codes',
  };
  v.el.innerHTML = String(html`<div class="large-title"><h1>Activity</h1><p>The last 100 security events in your household.</p></div>
    ${rows.length ? html`<div class="group">${rows.map((r) => html`<div class="row"><span class="body"><span class="title ${r.event === 'login.failed' ? 'text-neg' : ''}">${r.user_name || 'Someone'} · ${LABEL[r.event] || r.event}${r.detail && r.event !== 'login.failed' ? ` (${r.detail})` : ''}</span>
      <span class="sub">${new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString(S.household.locale, { dateStyle: 'medium', timeStyle: 'short' })}${r.ip ? ` · ${r.ip}` : ''}</span></span></div>`)}</div>`
      : html`<div class="group">${emptyState('activity', 'No activity yet', '')}</div>`}`);
}

// ─────────── Import rules ───────────
async function rules(v) {
  v.setTitle('Import Rules');
  const load = async () => {
    const [list, cats] = await Promise.all([api.get('/api/rules'), getCategories()]);
    if (!v.alive()) return;
    const shown = list.filter((r) => r.kind !== 'ignore_recurring');
    const ignored = list.filter((r) => r.kind === 'ignore_recurring');
    v.el.innerHTML = String(html`<div class="large-title"><h1>Import Rules</h1><p>When a statement line contains this text, Finta files it this way. Rules are created as you sort transactions.</p></div>
      ${shown.length ? html`<div class="group has-icons">${shown.map((r) => html`<div class="row">
        <span class="tile" data-color="${r.kind === 'transfer' ? 'gray' : r.category_color || 'gray'}">${icon(r.kind === 'transfer' ? 'refresh-cw' : r.category_icon || 'tag')}</span>
        <span class="body"><span class="title">${r.pattern}</span><span class="sub">${r.kind === 'transfer' ? 'Transfer' : r.category_name || 'No category'}${r.recurring_name ? ` · pays ${r.recurring_name}` : ''}${r.rename_to ? ` · shown as “${r.rename_to}”` : ''}${r.hits ? ` · used ${plural(r.hits, 'time')}` : ''}</span></span>
        <button class="btn small destructive plain" data-del="${r.id}" aria-label="Delete rule ${r.pattern}">Delete</button></div>`)}</div>`
        : html`<div class="group">${emptyState('sparkles', 'No rules yet', 'Sort a transaction in Review and Finta creates a rule for it.')}</div>`}
      <div class="section"></div>
      <div class="btn-row"><button class="btn" data-add>${icon('plus')} Add Rule</button><button class="btn" data-rerun>${icon('refresh-cw')} Re-sort Everything</button></div>
      ${ignored.length ? html`<p class="section-foot">Not suggested as bills: ${ignored.map((r) => r.pattern).join(', ')}.</p>` : ''}`);
    $$('[data-del]', v.el).forEach((b) => b.addEventListener('click', async () => { await api.del(`/api/rules/${b.dataset.del}`); load(); }));
    $('[data-rerun]', v.el).onclick = async () => { const r = await api.post('/api/money/recategorize'); toast(`Re-sorted · ${plural(r.changed, 'row')} updated`); };
    $('[data-add]', v.el).onclick = () => sheet({
      title: 'New Rule', primary: 'Add',
      render: () => html`<form class="form" novalidate>
        <div class="group">${fText('pattern', 'When Text Has', '', { placeholder: 'COSTCO', required: true, maxlength: 60, autofocus: true })}
          ${fSelect('category_id', 'File Under', cats.filter((c) => !c.archived).map((c) => [c.id, c.name]), '', { data: 'data-int' })}
          ${fText('rename_to', 'Show As', '', { placeholder: 'Optional', maxlength: 80 })}</div>
        <p class="hint">Matching is on the cleaned-up merchant name, so leave out store numbers and cities.</p></form>`,
      onSubmit: async (vals) => { const r = await api.post('/api/rules', vals); toast(r.applied ? `Rule added · ${plural(r.applied, 'row')} updated` : 'Rule added'); load(); },
    });
  };
  await load();
}

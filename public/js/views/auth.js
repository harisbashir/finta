// Sign in, two-factor, first-run setup, and joining by invitation.
import { api, passkeysSupported, getPasskey } from '../api.js';
import { html, icon, $, fText, fSelect, fToggle, readForm, showError, clearErrors } from '../ui.js';

const CURRENCIES = [['CAD', 'Canadian Dollar (CAD)'], ['USD', 'US Dollar (USD)'], ['EUR', 'Euro (EUR)'], ['GBP', 'British Pound (GBP)'], ['AUD', 'Australian Dollar (AUD)'], ['NZD', 'New Zealand Dollar (NZD)'], ['INR', 'Indian Rupee (INR)'], ['PKR', 'Pakistani Rupee (PKR)'], ['AED', 'UAE Dirham (AED)'], ['JPY', 'Japanese Yen (JPY)'], ['CHF', 'Swiss Franc (CHF)'], ['MXN', 'Mexican Peso (MXN)']];

function guessCurrency() {
  const region = (navigator.language.split('-')[1] || '').toUpperCase();
  return { CA: 'CAD', US: 'USD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', IN: 'INR', PK: 'PKR', AE: 'AED', JP: 'JPY', CH: 'CHF', MX: 'MXN', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR' }[region] || 'CAD';
}

const shell = (title, subtitle, body, foot = '') => html`
  <div class="auth"><div class="auth-card">
    <div class="auth-head"><img src="/icon.svg" alt=""><h1>${title}</h1><p>${subtitle}</p></div>
    ${body}
    ${foot ? html`<div class="auth-foot">${foot}</div>` : ''}
  </div></div>`;

export function renderAuth(root, opts) {
  document.title = 'Finta';
  if (opts.mode === 'setup') return setup(root, opts);
  if (opts.mode === 'join') return join(root, opts);
  return signIn(root, opts);
}

function busy(btn, on) { if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); }

function signIn(root, opts) {
  const pk = passkeysSupported();
  root.innerHTML = String(shell('Welcome to Finta',
    'Your household’s money, chores, lists and meals — in one calm place.',
    html`<form class="form" id="signin" novalidate>
      <div class="group">
        ${fText('email', '', '', { placeholder: 'Email', type: 'email', autocomplete: 'username webauthn', required: true, stack: true, maxlength: 254 })}
        ${fText('password', '', '', { placeholder: 'Password', type: 'password', autocomplete: 'current-password', required: true, stack: true, maxlength: 256 })}
      </div>
      <button class="btn prominent block" type="submit">Sign In</button>
    </form>
    ${pk ? html`<div class="divider">or</div><button class="btn block" id="pk">${icon('fingerprint')} Sign In with a Passkey</button>` : ''}`,
    html`Forgot your password? Ask the person who set up Finta to run the reset command.${opts.allowSignup ? html`<br><a href="#" id="signup">Create a new household</a>` : ''}`));

  const form = $('#signin');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(root);
    const btn = form.querySelector('[type=submit]');
    const v = readForm(form);
    if (!v.email || !v.password) return showError(form, { message: 'Enter your email and password.' });
    busy(btn, true);
    try {
      const r = await api.post('/api/login', v);
      if (r.twoFactor) return twoFactor(root, r.ticket, opts);
      opts.onDone();
    } catch (err) { showError(form, { message: err.message }); } finally { busy(btn, false); }
  });

  $('#pk')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    clearErrors(root);
    busy(btn, true);
    try {
      const { ticket, options } = await api.post('/api/passkeys/login/options');
      const credential = await getPasskey(options);
      await api.post('/api/passkeys/login/verify', { ticket, credential });
      opts.onDone();
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') showError(form, { message: err.message });
    } finally { busy(btn, false); }
  });
  $('#signup')?.addEventListener('click', (e) => { e.preventDefault(); setup(root, { ...opts, signup: true }); });
}

function twoFactor(root, ticket, opts) {
  root.innerHTML = String(shell('Two-Factor Authentication',
    'Enter the 6-digit code from your authenticator app. Lost your phone? Use one of your recovery codes instead.',
    html`<form class="form" id="tfa" novalidate>
      <div class="group">${fText('code', '', '', { placeholder: '123456', autocomplete: 'one-time-code', inputmode: 'numeric', required: true, stack: true, maxlength: 11, autofocus: true })}</div>
      <button class="btn prominent block" type="submit">Verify</button>
      <button class="btn plain block" type="button" id="back">Back</button>
    </form>`));
  const input = $('input[name=code]');
  input.classList.add('code-input');
  input.focus();
  const form = $('#tfa');
  const go = async () => {
    clearErrors(root);
    const btn = form.querySelector('[type=submit]');
    busy(btn, true);
    try { await api.post('/api/login/2fa', { ticket, code: input.value }); opts.onDone(); }
    catch (err) { if (err.status === 401) { signIn(root, opts); } else { showError(form, { message: err.message }); input.select(); } }
    finally { busy(btn, false); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  input.addEventListener('input', () => { if (/^\d{6}$/.test(input.value.trim())) go(); });
  $('#back').onclick = () => signIn(root, opts);
}

function passwordHint() {
  return html`<p class="hint">Use 10 or more characters. A short phrase of a few unrelated words is strong and easy to remember.</p>`;
}

function setup(root, opts) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const signup = !!opts.signup;
  root.innerHTML = String(shell(signup ? 'New Household' : 'Set Up Finta',
    signup ? 'Create a household and your account. You can invite others afterwards.'
      : 'Create your household and your account. You’ll be the owner and can invite others afterwards.',
    html`<form class="form" id="setup" novalidate>
      ${signup ? '' : html`<div class="group-label">Setup Code</div>
      <div class="group">${fText('setupCode', '', '', { placeholder: 'From the server log', required: true, stack: true, maxlength: 40, autocomplete: 'off' })}</div>
      <p class="hint">This one-time code is printed in the container log when Finta starts. It stops strangers from claiming your server.</p>`}
      <div class="group-label">Household</div>
      <div class="group">
        ${fText('householdName', 'Name', '', { placeholder: 'The Smiths', required: true, maxlength: 80 })}
        ${fSelect('currency', 'Currency', CURRENCIES, guessCurrency())}
      </div>
      <div class="group-label">You</div>
      <div class="group">
        ${fText('name', 'Name', '', { placeholder: 'Your first name', required: true, autocomplete: 'given-name', maxlength: 60 })}
        ${fText('email', 'Email', '', { placeholder: 'you@example.com', type: 'email', required: true, autocomplete: 'email', maxlength: 254 })}
        ${fText('password', 'Password', '', { placeholder: 'Required', type: 'password', required: true, autocomplete: 'new-password', maxlength: 256 })}
      </div>
      ${passwordHint()}
      <div class="group">${fToggle('withSamples', 'Start with example data', false, 'A realistic household to explore. Delete anything later.')}</div>
      <button class="btn prominent block" type="submit">Create Household</button>
      ${signup ? html`<button class="btn plain block" type="button" id="back">Back to Sign In</button>` : ''}
    </form>`,
    'Your data stays on this server. Nothing is shared with anyone else.'));

  const form = $('#setup');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(root);
    const btn = form.querySelector('[type=submit]');
    busy(btn, true);
    try {
      const v = readForm(form);
      await api.post(signup ? '/api/signup' : '/api/setup', { ...v, timezone: tz, locale: navigator.language || 'en-CA' });
      opts.onDone();
    } catch (err) { showError(form, err); } finally { busy(btn, false); }
  });
  $('#back')?.addEventListener('click', () => signIn(root, opts));
}

async function join(root, opts) {
  let household;
  try { household = (await api.get(`/api/invites/${encodeURIComponent(opts.token || '')}`)).household; }
  catch (err) {
    root.innerHTML = String(shell('Invitation Unavailable', err.message, html`<a class="btn prominent block" href="#/">Go to Sign In</a>`));
    $('.auth a').addEventListener('click', () => signIn(root, opts));
    return;
  }
  root.innerHTML = String(shell(`Join ${household}`,
    'You’ve been invited to share this household’s money, tasks, lists and meals.',
    html`<form class="form" id="join" novalidate>
      <div class="group">
        ${fText('name', 'Name', '', { placeholder: 'Your first name', required: true, autocomplete: 'given-name', maxlength: 60 })}
        ${fText('email', 'Email', '', { placeholder: 'you@example.com', type: 'email', required: true, autocomplete: 'email', maxlength: 254 })}
        ${fText('password', 'Password', '', { placeholder: 'Required', type: 'password', required: true, autocomplete: 'new-password', maxlength: 256 })}
      </div>
      ${passwordHint()}
      <button class="btn prominent block" type="submit">Join Household</button>
    </form>`));
  const form = $('#join');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(root);
    const btn = form.querySelector('[type=submit]');
    busy(btn, true);
    try { await api.post(`/api/invites/${encodeURIComponent(opts.token)}/accept`, readForm(form)); opts.onDone(); }
    catch (err) { showError(form, err); } finally { busy(btn, false); }
  });
}

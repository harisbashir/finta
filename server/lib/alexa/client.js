// Amazon Alexa lists client. Unofficial: Amazon closed the public List API in July 2024, so this
// speaks the same private API as the Alexa app, ported from the aioamazondevices library
// (github.com/chemelli74/aioamazondevices: login.py, http_wrapper.py, implementation/todo.py).
// When Amazon changes something, this is the only file that should need fixing.
import crypto from 'node:crypto';

const DEVICE_TYPE = 'A2IVLV5VM2W81';
const APP_NAME = 'Finta';
const APP_VERSION = '2.2.663733.0';
const APP_ID = 'MAPiOSLib/6.0/ToHideRetailLink';
const BUNDLE_ID = 'com.amazon.echo';
const OS_VERSION = '18.5';
const SOFTWARE_VERSION = '35602678';
const LANGUAGE = 'en-CA';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';
const TIMEOUT_MS = 20000;
const COOKIE_MAX_AGE_MS = 12 * 3600e3;
const LISTS_PATH = '/alexashoppinglists/api/v2/lists';
export const ITEMS_PAGE = 100;

// Like the Alexa app, sign-in always happens on amazon.com, whatever the country; the account's own
// lists site (amazon.ca for Canada) is then read from alexa.amazon.com/api/welcome.
export const DEFAULT_HOSTS = {
  signin: 'https://www.amazon.com',
  api: 'https://api.amazon.com',
  alexa: 'https://alexa.amazon.com',
  retail: (domain) => `https://www.${domain}`,
  alexaFor: (domain) => `https://alexa.${domain}`,
};

export class AlexaError extends Error {
  /** @param {'auth'|'challenge'|'network'|'api'} code */
  constructor(code, message) { super(message); this.code = code; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ── Tiny HTML helpers (no DOM in Node; Amazon's sign-in pages are plain forms) ──
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4]);
  if (!('checked' in out) && /(^|\s)checked(?=[\s/]|$)/i.test(tag)) out.checked = '';   // bare boolean attribute
  return out;
}
function forms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({ attrs: attrs(m[1]), inputs: [...m[2].matchAll(/<input\b([^>]*)>/gi)].map((i) => attrs(i[1])) }));
}
const hasInput = (html, name) => forms(html).some((f) => f.inputs.some((i) => i.name === name));
const hasId = (html, id) => new RegExp(`id=["']${id}["']`).test(html);
function pickForm(html, { id, needs } = {}) {
  const all = forms(html);
  return (id && all.find((f) => f.attrs.id === id)) || (needs && all.find((f) => f.inputs.some((i) => i.name === needs)))
    || all.find((f) => f.attrs.name === 'signIn') || all[0] || null;
}
function formFields(form) {
  const out = {};
  for (const i of form.inputs) {
    if (!i.name) continue;
    if (i.type === 'hidden' || (i.type === 'radio' && 'checked' in i)) out[i.name] = i.value ?? '';
  }
  return out;
}
function errorMessage(html) {
  for (const id of ['auth-error-message-box', 'auth-warning-message-box']) {
    const m = html.match(new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)</div>`));
    if (m) return decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  return null;
}
const pageTitle = (html) => decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim();

/** The shape of a sign-in page for the server log: title, forms, field names and step ids. Never values. */
function describe(page) {
  const path = (u) => { try { return new URL(u, 'https://x').pathname; } catch { return '?'; } };
  const ids = [...new Set([...page.html.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]).filter((id) => /auth|cvf|captcha|mfa|otp|claim|approv|challenge|verif|signin|error|warning/i.test(id)))].slice(0, 25);
  const fs = forms(page.html).map((f) => `form#${f.attrs.id || '-'}[${f.attrs.name || '-'}] → ${path(f.attrs.action || '')} {${f.inputs.map((i) => `${i.name || '?'}:${i.type || 'text'}`).join(', ')}}`);
  return `after ${path(page.url)} · status ${page.status} · title “${pageTitle(page.html)}” · ${fs.join(' | ') || 'no forms'} · ids: ${ids.join(', ') || 'none'}`.slice(0, 2000);
}

// ── Cookies ──
function takeCookies(res, into) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair, ...opts] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
    const expired = !value || opts.some((o) => /^\s*max-age\s*=\s*0\s*$/i.test(o) || (/^\s*expires\s*=/i.test(o) && Date.parse(o.split('=').slice(1).join('=')) < Date.now()));
    if (expired) delete into[name]; else into[name] = value;
  }
}
/** When a reminder next goes off (ms). Amazon sends triggerTime 0, and a repeating reminder's next time as an ISO string. */
function reminderTime(n) {
  const candidates = [Date.parse(n.rRuleData?.nextTriggerTimes?.[0]), Number(n.triggerTime), Number(n.alarmTime)];
  return candidates.find((t) => Number.isFinite(t) && t > 0) ?? null;
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function initCookies() {
  const mapMd = { device_user_dictionary: [], device_registration_data: { software_version: SOFTWARE_VERSION }, app_identifier: { app_version: APP_VERSION, bundle_id: BUNDLE_ID } };
  return {
    'amzn-app-id': APP_ID,
    frc: crypto.randomBytes(313).toString('base64').replace(/=+$/, ''),
    'map-md': Buffer.from(JSON.stringify(mapMd)).toString('base64').replace(/=+$/, ''),
  };
}

export function createAlexaClient({ fetch = globalThis.fetch, hosts = DEFAULT_HOSTS, now = Date.now } = {}) {
  async function send(url, { method = 'GET', headers = {}, body, jar }) {
    let res;
    try {
      res = await fetch(url, {
        method, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': LANGUAGE, ...(jar ? { Cookie: cookieHeader(jar) } : {}), ...headers },
      });
    } catch (err) {
      throw new AlexaError('network', `Couldn’t reach Amazon (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
    }
    if (jar) takeCookies(res, jar);
    return res;
  }

  /** Browser-style navigation: follow redirects by hand so every hop's cookies are kept. */
  async function navigate(url, opts, stopAt) {
    let res = await send(url, opts);
    for (let hops = 0; hops < 10 && res.status >= 300 && res.status < 400; hops++) {
      const loc = new URL(res.headers.get('location'), url);
      if (stopAt?.(loc)) return { stoppedAt: loc };
      url = loc.href;
      res = await send(url, { jar: opts.jar });
    }
    return { url, status: res.status, html: await res.text() };
  }

  async function submit(page, form, extra, jar, stopAt) {
    const action = new URL(form.attrs.action || page.url, page.url).href;
    const body = new URLSearchParams({ ...formFields(form), ...extra }).toString();
    return navigate(action, { method: (form.attrs.method || 'POST').toUpperCase(), body, jar, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, stopAt);
  }

  // Sign-in ends with a redirect to /ap/maplanding carrying the code; read it there, don't follow it.
  const hasCode = (loc) => loc.searchParams.has('openid.oa2.authorization_code');
  const codeOf = (res) => res.stoppedAt?.searchParams.get('openid.oa2.authorization_code') || null;

  function failOnError(page) {
    const msg = errorMessage(page.html);
    if (msg) throw new AlexaError('auth', msg);
  }

  async function startLogin({ email, password }) {
    const serial = crypto.randomBytes(16).toString('hex').toUpperCase();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const clientId = Buffer.from(`${serial}#${DEVICE_TYPE}`).toString('hex');
    const q = new URLSearchParams({
      'openid.return_to': 'https://www.amazon.com/ap/maplanding',
      'openid.oa2.code_challenge_method': 'S256',
      'openid.assoc_handle': 'amzn_dp_project_dee_ios',
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      pageId: 'amzn_dp_project_dee_ios',
      accountStatusPolicy: 'P1',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.mode': 'checkid_setup',
      'openid.ns.oa2': 'http://www.amazon.com/ap/ext/oauth/2',
      'openid.oa2.client_id': `device:${clientId}`,
      language: 'en-US',
      'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
      'openid.oa2.code_challenge': challenge,
      'openid.oa2.scope': 'device_auth_access',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.pape.max_auth_age': '0',
      'openid.oa2.response_type': 'code',
    });
    const jar = initCookies();
    const base = { jar, verifier, serial, createdAt: now() };
    // Amazon sometimes trusts the sign-in and skips the code step: then the code arrives early.
    const early = (res) => (codeOf(res) ? { ...base, needsCode: false, code: codeOf(res) } : null);
    let page = await navigate(`${hosts.signin}/ap/signin?${q}`, { jar }, hasCode);
    if (early(page)) return early(page);
    // Email and password are asked on separate pages.
    for (const [field, value] of [['email', email], ['password', password]]) {
      if (!hasInput(page.html, field)) break;
      page = await submit(page, pickForm(page.html, { needs: field }), { [field]: value }, jar, hasCode);
      if (early(page)) return early(page);
      failOnError(page);
    }
    // Accounts with several two-step options first ask where to send the code.
    if (hasId(page.html, 'auth-select-device-form')) {
      page = await submit(page, pickForm(page.html, { id: 'auth-select-device-form' }), {}, jar, hasCode);
      if (early(page)) return early(page);
      failOnError(page);
    }
    if (hasId(page.html, 'cvf-aamation-challenge-form') || !hasId(page.html, 'auth-mfa-otpcode')) {
      const title = pageTitle(page.html);
      const err = new AlexaError('challenge', `Amazon asked for something Finta can’t show here${title ? ` (“${title}”)` : ''}. Wait a few minutes and try again, or sign in to amazon.ca in a browser first.`);
      err.diag = describe(page);
      throw err;
    }
    const form = pickForm(page.html, { needs: 'otpCode' });
    return { ...base, needsCode: true, url: page.url, form };
  }

  async function register(code, pending) {
    const body = {
      requested_extensions: ['device_info', 'customer_info'],
      cookies: { website_cookies: [], domain: '.amazon.com' },
      registration_data: {
        domain: 'Device', app_version: APP_VERSION, device_type: DEVICE_TYPE,
        device_name: `%FIRST_NAME%'s%DUPE_STRATEGY_1ST%${APP_NAME}`,
        os_version: OS_VERSION, device_serial: pending.serial, device_model: 'iPhone', app_name: APP_NAME, software_version: SOFTWARE_VERSION,
      },
      auth_data: {
        use_global_authentication: 'true', client_id: Buffer.from(`${pending.serial}#${DEVICE_TYPE}`).toString('hex'),
        authorization_code: code, code_verifier: pending.verifier, code_algorithm: 'SHA-256', client_domain: 'DeviceLegacy',
      },
      user_context_map: { frc: pending.jar.frc },
      requested_token_type: ['bearer', 'mac_dms', 'website_cookies', 'store_authentication_cookie'],
    };
    const res = await send(`${hosts.api}/auth/register`, { method: 'POST', body: JSON.stringify(body), jar: pending.jar, headers: { 'Content-Type': 'application/json' } });
    const json = await res.json().catch(() => null);
    if (res.status >= 500) throw new AlexaError('network', `Amazon couldn’t register Finta right now (${res.status}).`);
    const ok = json?.response?.success;
    if (!res.ok || !ok) throw new AlexaError('api', `Amazon refused to register Finta: ${json?.response?.error?.message || res.status}.`);
    const t = ok.tokens;
    const cookies = {};
    for (const c of t.website_cookies || []) cookies[c.Name] = String(c.Value).replace(/"/g, '');
    cookies['session-token'] = t.store_authentication_cookie?.cookie;
    return {
      serial: pending.serial,
      refreshToken: t.bearer.refresh_token,
      accessToken: t.bearer.access_token,
      accessExpires: now() + Number(t.bearer.expires_in) * 1000,
      adpToken: t.mac_dms?.adp_token,
      devicePrivateKey: t.mac_dms?.device_private_key,
      cookies,
      domain: 'amazon.com',
      customerId: ok.extensions?.customer_info?.user_id || null,
      cookiesAt: now(),
    };
  }

  async function finishLogin(pending, code) {
    let authCode = pending.code;
    if (!authCode) {
      const result = await submit({ url: pending.url }, pending.form, { otpCode: String(code), mfaSubmit: 'Submit', rememberDevice: 'false' }, pending.jar, hasCode);
      authCode = codeOf(result);
      if (!authCode) {
        failOnError(result);
        const err = new AlexaError('challenge', 'Amazon didn’t accept the sign-in. Start again and use the newest code.');
        err.diag = describe(result);
        throw err;
      }
    }
    const login = await register(authCode, pending);
    // Find which Amazon site holds this account's Alexa lists, then get cookies for it (the library
    // always does this outside amazon.com).
    const res = await send(`${hosts.alexa}/api/welcome`, { jar: { ...login.cookies } });
    const host = res.ok ? (await res.json().catch(() => ({}))).alexaHostName : null;
    login.domain = host ? String(host).replace(/^alexa\./, '') : 'amazon.com';
    await refreshCookies(login);
    // Alexa hands out the csrf cookie the lists API expects back as a header.
    await send(`${hosts.alexa}/api/welcome`, { jar: login.cookies });
    return login;
  }

  async function refreshCookies(login) {
    const body = new URLSearchParams({
      app_name: APP_NAME, app_version: APP_VERSION, 'di.sdk.version': '6.12.4', source_token: login.refreshToken,
      package_name: BUNDLE_ID, 'di.hw.version': 'iPhone', platform: 'iOS', requested_token_type: 'auth_cookies',
      source_token_type: 'refresh_token', 'di.os.name': 'iOS', 'di.os.version': OS_VERSION,
      current_version: '6.12.4', previous_version: '6.12.4', domain: `www.${login.domain}`,
    }).toString();
    const res = await send(`${hosts.api}/auth/token`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (res.status >= 500) throw new AlexaError('network', `Amazon couldn’t refresh the sign-in right now (${res.status}).`);
    const json = await res.json().catch(() => null);
    const byDomain = json?.response?.tokens?.cookies;
    if (!res.ok || !byDomain) throw new AlexaError('auth', 'Amazon no longer accepts Finta’s sign-in. Reconnect Alexa in Settings.');
    const cookies = login.cookies?.csrf ? { csrf: login.cookies.csrf } : {};
    for (const list of Object.values(byDomain)) for (const c of list) cookies[c.Name] = String(c.Value).replace(/"/g, '');
    login.cookies = cookies;
    login.cookiesAt = now();
  }

  function session(login) {
    async function call(method, path, { query, body, url: fullUrl } = {}) {
      if (!login.cookiesAt || now() - login.cookiesAt > COOKIE_MAX_AGE_MS) await refreshCookies(login);
      const url = fullUrl || `${hosts.retail(login.domain)}${LISTS_PATH}/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
      const once = () => send(url, {
        method, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),   // Amazon refuses list calls without a body
        jar: login.cookies,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: cookieHeader({ ...login.cookies, 'lc-acbit': LANGUAGE }), ...(login.cookies.csrf ? { csrf: login.cookies.csrf } : {}) },
      });
      let res = await once();
      if (res.status === 401 || res.status === 403) {
        await refreshCookies(login);
        res = await once();
        if (res.status === 401 || res.status === 403) throw new AlexaError('auth', 'Amazon no longer accepts Finta’s sign-in. Reconnect Alexa in Settings.');
      }
      if (res.status >= 500 || res.status === 429) throw new AlexaError('network', `Alexa lists are unavailable right now (${res.status}).`);
      if (!res.ok) throw new AlexaError('api', `Alexa refused the request (${res.status}).`);
      return res.json().catch(() => ({}));
    }
    return {
      async getLists() {
        const json = await call('POST', 'fetch');
        if (!Array.isArray(json.listInfoList)) throw new AlexaError('api', 'Alexa sent lists in an unexpected format.');
        return json.listInfoList.map((l) => ({ id: l.listId, type: l.listType, name: l.listName ?? null }));
      },
      async getItems(listId) {
        // Amazon accepts page sizes below 200 ("maxResults should be in range: from 0 to 200"); 100 as in the library.
        const json = await call('POST', `${encodeURIComponent(listId)}/items/fetch`, { query: { limit: ITEMS_PAGE } });
        if (!Array.isArray(json.itemInfoList)) throw new AlexaError('api', 'Alexa sent list items in an unexpected format.');
        return json.itemInfoList.map((i) => ({ itemId: i.itemId, name: i.itemName ?? '', checked: i.itemStatus === 'COMPLETE', version: i.version }));
      },
      async addItem(listId, name) {
        await call('POST', `${encodeURIComponent(listId)}/items`, { body: { items: [{ itemType: 'KEYWORD', itemName: name }] } });
      },
      async updateItem(listId, itemId, version, { name, checked }) {
        const update = [];
        if (name !== undefined) update.push({ type: 'itemName', value: name });
        if (checked !== undefined) update.push({ type: 'itemStatus', value: checked ? 'COMPLETE' : 'ACTIVE' });
        await call('PUT', `${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, { query: { version }, body: { itemAttributesToUpdate: update, itemAttributesToRemove: [] } });
      },
      /** Active Alexa reminders, soonest first: { id, label, at (ms), repeats }. Read-only. */
      async getReminders() {
        const json = await call('GET', null, { url: `${hosts.alexaFor(login.domain)}/api/notifications` });
        if (!Array.isArray(json.notifications)) throw new AlexaError('api', 'Alexa sent reminders in an unexpected format.');
        return json.notifications
          .filter((n) => n.type === 'Reminder' && n.status === 'ON')
          .map((n) => ({
            id: String(n.id),
            label: String(n.reminderLabel || 'Reminder').slice(0, 200),
            at: reminderTime(n),
            repeats: !!(n.recurringPattern || n.rRuleData?.recurrenceRules?.length || n.rRuleData?.frequency),
          }))
          .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
      },
      async deleteItem(listId, itemId, version) {
        await call('DELETE', `${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, { query: { version } });
      },
    };
  }

  return { startLogin, finishLogin, refreshCookies, session };
}

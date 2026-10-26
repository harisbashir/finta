import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAlexaClient, AlexaError, DEFAULT_HOSTS } from '../server/lib/alexa/client.js';

// A fake Amazon: sign-in pages, register, token refresh, welcome and the lists API.
const form = (action, inner, attrs = 'name="signIn"') => `<html><body><form ${attrs} method="post" action="${action}">
  <input type="hidden" name="appActionToken" value="tok&amp;1"><input name="workflowState" type="hidden" value="ws">${inner}</form></body></html>`;
const PAGES = {
  email: form('/ap/signin-email', '<input type="email" name="email">'),
  password: form('/ap/signin-password', '<input type="password" name="password">'),
  otp: form('/ap/mfa', '<input id="auth-mfa-otpcode" name="otpCode">', 'id="auth-mfa-form"'),
  choose: form('/ap/choose', '<input type="radio" name="otpDeviceContext" value="sms-1" checked>', 'id="auth-select-device-form"'),
  error: `<html><div id="auth-error-message-box"><h4>There was a problem</h4><span>Your password is incorrect</span></div>${form('/ap/signin-password', '<input type="password" name="password">')}</html>`,
  captcha: '<html><form id="cvf-aamation-challenge-form" action="/cvf"></form></html>',
};

let srv, base, log, state;
const reset = () => {
  log = [];
  state = { chooseFirst: false, itemsFail: 0, items: [{ itemId: 'i1', itemName: 'milk', itemStatus: 'ACTIVE', version: 3 }] };
};

before(async () => {
  srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const html = (page, cookies = []) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': cookies }); res.end(page); };
    const json = (obj, status = 200, cookies = []) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': cookies }); res.end(JSON.stringify(obj)); };
    const p = url.pathname;
    const f = Object.fromEntries(new URLSearchParams(body));
    if (p === '/ap/signin') return html(PAGES.email, ['session-id=S1; Path=/']);
    if (p === '/ap/signin-email') return html(PAGES.password);
    if (p === '/ap/signin-password') {
      if (f.password === 'bad') return html(PAGES.error);
      if (f.password === 'captcha') return html(PAGES.captcha);
      if (f.password === 'trusted') { res.writeHead(302, { Location: '/ap/maplanding?openid.oa2.authorization_code=AUTHCODE' }); return res.end(); }
      return html(state.chooseFirst ? PAGES.choose : PAGES.otp);
    }
    if (p === '/ap/choose') return html(PAGES.otp);
    if (p === '/ap/mfa') {
      if (f.otpCode === '000000') return html(PAGES.error.replace('Your password is incorrect', 'The code you entered is not valid'));
      res.writeHead(302, { Location: '/ap/maplanding?openid.oa2.authorization_code=AUTHCODE' }); return res.end();
    }
    if (p === '/ap/maplanding') { res.writeHead(404); return res.end('nope'); }
    if (p === '/auth/register') {
      return json({ response: { success: {
        tokens: {
          bearer: { access_token: 'AT', refresh_token: 'RT', expires_in: '3600' },
          mac_dms: { adp_token: 'ADP', device_private_key: 'KEY' },
          website_cookies: [{ Name: 'at-acbca', Value: '"web1"' }, { Name: 'ubid-acbca', Value: 'u1' }],
          store_authentication_cookie: { cookie: 'SESSTOK' },
        },
        extensions: { device_info: { device_serial_number: 'X' }, customer_info: { user_id: 'CUST1', home_region: 'NA' } },
      } } });
    }
    if (p === '/api/welcome') return json({ alexaHostName: 'alexa.amazon.ca' }, 200, ['csrf=fromwelcome; Path=/']);
    if (p === '/auth/token') return json({ response: { tokens: { cookies: { '.amazon.ca': [{ Name: 'at-acbca', Value: '"web2"' }, { Name: 'session-token', Value: 'SESSTOK2' }] } } } });
    const lists = '/alexashoppinglists/api/v2/lists';
    if (p === `${lists}/fetch`) {
      return json({ listInfoList: [{ listId: 'L-shop', listType: 'SHOP', listName: null }, { listId: 'L-todo', listType: 'TODO' }, { listId: 'L-c', listType: 'CUSTOM', listName: 'Costco' }] }, 200, ['csrf=abc; Path=/']);
    }
    if (p === `${lists}/L-shop/items/fetch`) {
      if (state.itemsFail > 0) { state.itemsFail--; return json({ message: 'unauthorized' }, 401); }
      return json({ itemInfoList: state.items });
    }
    if (p.startsWith(`${lists}/L-shop/items`)) return json({});
    if (p === `${lists}/L-boom/items/fetch`) return json({ oops: true }, 500);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));
beforeEach(reset);

const hosts = () => ({ signin: base, api: base, alexa: base, retail: () => base });
const newClient = (opts = {}) => createAlexaClient({ hosts: hosts(), ...opts });
const loginData = (extra = {}) => ({ serial: 'X', refreshToken: 'RT', cookies: { 'at-acbca': 'web1', 'session-token': 'SESSTOK' }, domain: 'amazon.ca', cookiesAt: Date.now(), ...extra });

test('login happy path: email → password → code → register → welcome', async () => {
  const c = newClient();
  const pending = await c.startLogin({ email: 'me@example.com', password: 'right' });
  const login = await c.finishLogin(pending, '123456');
  assert.equal(login.refreshToken, 'RT');
  assert.equal(login.domain, 'amazon.ca');
  assert.equal(login.cookies['session-token'], 'SESSTOK2', 'cookies refreshed after register');
  assert.equal(login.cookies['at-acbca'], 'web2', 'quotes stripped');
  const emailPost = log.find((r) => r.path === '/ap/signin-email');
  const sent = Object.fromEntries(new URLSearchParams(emailPost.body));
  assert.equal(sent.email, 'me@example.com');
  assert.equal(sent.appActionToken, 'tok&1', 'hidden inputs decoded and passed through');
  const mfa = Object.fromEntries(new URLSearchParams(log.find((r) => r.path === '/ap/mfa').body));
  assert.equal(mfa.otpCode, '123456');
  assert.equal(mfa.rememberDevice, 'false');
  const reg = JSON.parse(log.find((r) => r.path === '/auth/register').body);
  assert.equal(reg.registration_data.app_name, 'Finta');
  assert.equal(reg.auth_data.authorization_code, 'AUTHCODE');
  assert.ok(reg.auth_data.code_verifier.length >= 43);
  assert.ok(reg.user_context_map.frc);
  const first = log.find((r) => r.path === '/ap/signin');
  assert.equal(first.query.get('openid.oa2.code_challenge_method'), 'S256');
  assert.match(first.headers.cookie, /frc=/);
});

test('SMS device choice page is submitted before the code page', async () => {
  state.chooseFirst = true;
  const pending = await newClient().startLogin({ email: 'me@example.com', password: 'right' });
  assert.ok(pending);
  const choose = log.find((r) => r.path === '/ap/choose');
  assert.equal(new URLSearchParams(choose.body).get('otpDeviceContext'), 'sms-1', 'the checked option is sent');
});

test('wrong password is an auth error with Amazon’s message', async () => {
  await assert.rejects(newClient().startLogin({ email: 'me@example.com', password: 'bad' }),
    (e) => e instanceof AlexaError && e.code === 'auth' && /password is incorrect/.test(e.message));
});

test('wrong code is an auth error', async () => {
  const c = newClient();
  const pending = await c.startLogin({ email: 'me@example.com', password: 'right' });
  await assert.rejects(c.finishLogin(pending, '000000'), (e) => e.code === 'auth' && /not valid/.test(e.message));
});

test('captcha is a challenge error', async () => {
  await assert.rejects(newClient().startLogin({ email: 'me@example.com', password: 'captcha' }), (e) => e.code === 'challenge');
});

test('lists and items are normalized', async () => {
  const s = newClient().session(loginData());
  assert.deepEqual(await s.getLists(), [
    { id: 'L-shop', type: 'SHOP', name: null }, { id: 'L-todo', type: 'TODO', name: null }, { id: 'L-c', type: 'CUSTOM', name: 'Costco' },
  ]);
  state.items.push({ itemId: 'i2', itemName: 'eggs', itemStatus: 'COMPLETE', version: 1 });
  assert.deepEqual(await s.getItems('L-shop'), [
    { itemId: 'i1', name: 'milk', checked: false, version: 3 }, { itemId: 'i2', name: 'eggs', checked: true, version: 1 },
  ]);
  assert.equal(log.at(-1).query.get('limit'), '200');
});

test('cookie header and csrf are sent', async () => {
  const s = newClient().session(loginData());
  await s.getLists();
  await s.getItems('L-shop');
  const r = log.at(-1);
  assert.equal(r.headers.csrf, 'abc');
  assert.match(r.headers.cookie, /session-token=SESSTOK/);
  assert.match(r.headers.cookie, /lc-acbit=en-CA/);
  assert.equal(r.headers['accept-language'], 'en-CA');
});

test('401 refreshes cookies once then succeeds', async () => {
  state.itemsFail = 1;
  const login = loginData();
  const items = await newClient().session(login).getItems('L-shop');
  assert.equal(items.length, 1);
  assert.equal(log.filter((r) => r.path === '/auth/token').length, 1);
  const tok = Object.fromEntries(new URLSearchParams(log.find((r) => r.path === '/auth/token').body));
  assert.equal(tok.requested_token_type, 'auth_cookies');
  assert.equal(tok.source_token, 'RT');
  assert.equal(tok.domain, 'www.amazon.ca');
  assert.equal(login.cookies['session-token'], 'SESSTOK2');
});

test('401 twice is an auth error', async () => {
  state.itemsFail = 2;
  await assert.rejects(newClient().session(loginData()).getItems('L-shop'), (e) => e.code === 'auth');
});

test('stale cookies refresh before the first call', async () => {
  await newClient().session(loginData({ cookiesAt: Date.now() - 13 * 3600e3 })).getLists();
  assert.deepEqual(log.map((r) => r.path), ['/auth/token', '/alexashoppinglists/api/v2/lists/fetch']);
});

test('5xx is a network error', async () => {
  await assert.rejects(newClient().session(loginData()).getItems('L-boom'), (e) => e.code === 'network');
});

test('add, update and delete send the right requests', async () => {
  const s = newClient().session(loginData());
  await s.addItem('L-shop', 'bread');
  await s.updateItem('L-shop', 'i1', 3, { name: 'oat milk', checked: true });
  await s.deleteItem('L-shop', 'i1', 4);
  const [add, upd, del] = log;
  assert.equal(add.method, 'POST');
  assert.equal(add.path, '/alexashoppinglists/api/v2/lists/L-shop/items');
  assert.deepEqual(JSON.parse(add.body), { items: [{ itemType: 'KEYWORD', itemName: 'bread' }] });
  assert.equal(upd.method, 'PUT');
  assert.equal(upd.path, '/alexashoppinglists/api/v2/lists/L-shop/items/i1');
  assert.equal(upd.query.get('version'), '3');
  assert.deepEqual(JSON.parse(upd.body), { itemAttributesToUpdate: [{ type: 'itemName', value: 'oat milk' }, { type: 'itemStatus', value: 'COMPLETE' }], itemAttributesToRemove: [] });
  assert.equal(del.method, 'DELETE');
  assert.equal(del.body, '{}', 'Amazon expects a JSON body on every list call');
  assert.equal(del.query.get('version'), '4');
});

test('sign-in keeps the csrf cookie from welcome and refreshes cookies like the library', async () => {
  const c = newClient();
  const login = await c.finishLogin(await c.startLogin({ email: 'me@example.com', password: 'right' }), '123456');
  assert.ok(log.some((r) => r.path === '/auth/token'), 'auth_cookies refresh after register');
  assert.equal(login.cookies.csrf, 'fromwelcome');
  log.length = 0;
  await c.session(login).getLists();
  assert.equal(log[0].headers.csrf, 'fromwelcome');
});

test('an unexpected page is described for the log without any values', async () => {
  await assert.rejects(newClient().startLogin({ email: 'me@example.com', password: 'captcha' }), (e) => {
    assert.equal(e.code, 'challenge');
    assert.match(e.diag, /cvf-aamation-challenge-form/);
    assert.match(e.diag, /\/ap\/signin-password/, 'the page that was submitted');
    assert.doesNotMatch(e.diag, /me@example\.com|captcha/, 'no user values');
    return true;
  });
});

test('sign-in always starts on amazon.com, like the Alexa app; the lists site comes from welcome', async () => {
  assert.equal(DEFAULT_HOSTS.signin, 'https://www.amazon.com');
  assert.equal(DEFAULT_HOSTS.alexa, 'https://alexa.amazon.com');
  const c = newClient();
  const login = await c.finishLogin(await c.startLogin({ email: 'me@example.com', password: 'right' }), '123456');
  const reg = JSON.parse(log.find((r) => r.path === '/auth/register').body);
  assert.equal(reg.cookies.domain, '.amazon.com');
  assert.equal(login.domain, 'amazon.ca', 'from alexaHostName');
});

test('when Amazon skips the code step, sign-in finishes without one', async () => {
  const c = newClient();
  const pending = await c.startLogin({ email: 'me@example.com', password: 'trusted' });
  assert.equal(pending.needsCode, false);
  const login = await c.finishLogin(pending);
  assert.equal(login.refreshToken, 'RT');
  assert.ok(!log.some((r) => r.path === '/ap/mfa'));
  assert.ok(!log.some((r) => r.path === '/ap/maplanding'), 'the redirect is read, not followed');
});

test('a normal sign-in says a code is needed', async () => {
  const pending = await newClient().startLogin({ email: 'me@example.com', password: 'right' });
  assert.equal(pending.needsCode, true);
});

// End-to-end passkey test with a software authenticator (P-256), exercising the real API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, client, OWNER } from './helpers.js';
import { cborDecode } from '../server/lib/webauthn.js';

// Minimal CBOR encoder for the test authenticator.
function enc(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  throw new Error('unsupported');
}

function softAuthenticator(rpId, origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let count = 0;
  const rpHash = crypto.createHash('sha256').update(rpId).digest();
  const b64 = (b) => Buffer.from(b).toString('base64url');
  return {
    create(options) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, enc(cose)]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
      const att = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', response: { clientDataJSON: b64(clientData), attestationObject: b64(att), transports: ['internal'] } };
    },
    get(options, { flags = 0x05, originOverride } = {}) {
      count++;
      const c = Buffer.alloc(4); c.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), c]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: originOverride || origin }));
      const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(sig) } };
    },
  };
}

let srv, owner;
before(async () => {
  srv = await startServer();
  owner = client(srv.base);
  await owner.post('/api/setup', OWNER);
});
after(async () => { await srv.close(); });

test('CBOR decoder reads maps, byte strings and negatives', () => {
  const { value } = cborDecode(enc(new Map([[1, 2], [-1, 1], ['k', Buffer.from([1, 2, 3])]])));
  assert.equal(value.get(1), 2);
  assert.equal(value.get(-1), 1);
  assert.deepEqual([...value.get('k')], [1, 2, 3]);
});

test('register a passkey, then sign in with it (no password)', async () => {
  const auth = softAuthenticator(srv.cfg.rpId, srv.cfg.origin);
  const opts = await owner.post('/api/me/passkeys/options');
  assert.equal(opts.data.options.authenticatorSelection.userVerification, 'required');
  const reg = await owner.post('/api/me/passkeys', { ticket: opts.data.ticket, credential: auth.create(opts.data.options), name: 'Test key' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal((await owner.get('/api/me/security')).data.passkeys.length, 1);

  const c = client(srv.base);
  const lo = await c.post('/api/passkeys/login/options');
  const ok = await c.post('/api/passkeys/login/verify', { ticket: lo.data.ticket, credential: auth.get(lo.data.options) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await c.get('/api/today')).status, 200);

  // Challenges are single-use.
  const replay = await client(srv.base).post('/api/passkeys/login/verify', { ticket: lo.data.ticket, credential: auth.get(lo.data.options) });
  assert.equal(replay.status, 401);

  // Wrong origin and missing user verification are refused.
  const lo2 = await c.post('/api/passkeys/login/options');
  assert.equal((await client(srv.base).post('/api/passkeys/login/verify', { ticket: lo2.data.ticket, credential: auth.get(lo2.data.options, { originOverride: 'https://evil.example' }) })).status, 401);
  const lo3 = await c.post('/api/passkeys/login/options');
  assert.equal((await client(srv.base).post('/api/passkeys/login/verify', { ticket: lo3.data.ticket, credential: auth.get(lo3.data.options, { flags: 0x01 }) })).status, 401);
});

test('a tampered signature is rejected', async () => {
  const auth = softAuthenticator(srv.cfg.rpId, srv.cfg.origin);
  const opts = await owner.post('/api/me/passkeys/options');
  await owner.post('/api/me/passkeys', { ticket: opts.data.ticket, credential: auth.create(opts.data.options) });
  const c = client(srv.base);
  const lo = await c.post('/api/passkeys/login/options');
  const cred = auth.get(lo.data.options);
  const sig = Buffer.from(cred.response.signature, 'base64url'); sig[sig.length - 1] ^= 1;
  cred.response.signature = sig.toString('base64url');
  assert.equal((await c.post('/api/passkeys/login/verify', { ticket: lo.data.ticket, credential: cred })).status, 401);
});

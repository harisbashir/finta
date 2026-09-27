// Passkeys (WebAuthn Level 2) with no dependencies: a minimal CBOR reader, COSE→JWK,
// and signature checks on node:crypto. Attestation is not requested ('none'), which is
// the right choice for a consumer app: we care that the key signs, not who made it.
import crypto from 'node:crypto';

// ───────── CBOR (RFC 8949) — just what WebAuthn uses ─────────

export function cborDecode(buf, start = 0) {
  let pos = start;
  const u8 = () => buf[pos++];
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) return u8();
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new Error('CBOR: indefinite lengths are not supported');
  }
  function item() {
    if (pos >= buf.length) throw new Error('CBOR: unexpected end');
    const b = u8();
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); const v = buf.subarray(pos, pos + n); pos += n; return Buffer.from(v); }
      case 3: { const n = readLen(info); const v = buf.toString('utf8', pos, pos + n); pos += n; return v; }
      case 4: { const n = readLen(info); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: {
        const n = readLen(info); const m = new Map();
        for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); }
        return m;
      }
      case 6: readLen(info); return item(); // tag: ignore, return content
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
        if (info === 26) { const v = buf.readFloatBE(pos); pos += 4; return v; }
        if (info === 27) { const v = buf.readDoubleBE(pos); pos += 8; return v; }
        throw new Error('CBOR: unsupported simple value');
      default: throw new Error('CBOR: bad major type');
    }
  }
  const value = item();
  return { value, end: pos };
}

// ───────── Authenticator data ─────────

export function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authData too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = {
    rpIdHash, signCount,
    up: !!(flags & 0x01), uv: !!(flags & 0x04),
    be: !!(flags & 0x08), bs: !!(flags & 0x10),
    at: !!(flags & 0x40),
  };
  if (out.at) {
    let p = 37;
    p += 16; // aaguid
    const len = buf.readUInt16BE(p); p += 2;
    out.credentialId = Buffer.from(buf.subarray(p, p + len)); p += len;
    const { value } = cborDecode(buf, p);
    out.coseKey = value;
  }
  return out;
}

export function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const b64 = (b) => Buffer.from(b).toString('base64url');
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64(cose.get(-2)), y: b64(cose.get(-3)) } };
  }
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) {
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64(cose.get(-2)) } };
  }
  if (kty === 3 && alg === -257) {
    return { alg, jwk: { kty: 'RSA', n: b64(cose.get(-1)), e: b64(cose.get(-2)) } };
  }
  throw new Error('This passkey uses an unsupported algorithm.');
}

export function verifySignature(alg, jwk, data, signature) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
  if (alg === -257) return crypto.verify('sha256', data, key, signature);
  if (alg === -8) return crypto.verify(null, data, key, signature);
  return false;
}

// ───────── Ceremonies ─────────

const PARAMS = [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }];

export function registrationOptions({ cfg, user, challenge, exclude = [] }) {
  return {
    challenge,
    rp: { id: cfg.rpId, name: cfg.rpName },
    user: {
      id: Buffer.from(`finta-user-${user.id}`).toString('base64url'),
      name: user.email,
      displayName: user.name,
    },
    pubKeyCredParams: PARAMS,
    timeout: 120000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
  };
}

export function authenticationOptions({ cfg, challenge }) {
  return { challenge, rpId: cfg.rpId, timeout: 120000, userVerification: 'required', allowCredentials: [] };
}

function checkClientData(b64, { type, challenge, origin }) {
  const raw = Buffer.from(String(b64 || ''), 'base64url');
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Malformed client data.'); }
  if (cd.type !== type) throw new Error('Wrong ceremony type.');
  if (cd.challenge !== challenge) throw new Error('This sign-in request expired. Try again.');
  if (cd.origin !== origin) throw new Error('Passkey was created for a different site.');
  return raw;
}

function checkRp(authData, rpId) {
  const expected = crypto.createHash('sha256').update(rpId).digest();
  if (!crypto.timingSafeEqual(authData.rpIdHash, expected)) throw new Error('Passkey belongs to a different site.');
  if (!authData.up) throw new Error('User presence was not confirmed.');
  if (!authData.uv) throw new Error('This passkey needs Face ID, Touch ID, or your device PIN.');
}

export function verifyRegistration({ cfg, challenge, response }) {
  const r = response?.response || {};
  checkClientData(r.clientDataJSON, { type: 'webauthn.create', challenge, origin: cfg.origin });
  const { value: att } = cborDecode(Buffer.from(String(r.attestationObject || ''), 'base64url'));
  if (!(att instanceof Map)) throw new Error('Malformed attestation.');
  const authData = parseAuthData(att.get('authData'));
  checkRp(authData, cfg.rpId);
  if (!authData.at || !authData.credentialId) throw new Error('No credential in response.');
  const { alg, jwk } = coseToJwk(authData.coseKey);
  const credentialId = authData.credentialId.toString('base64url');
  if (response.id && response.id !== credentialId) throw new Error('Credential ID mismatch.');
  return {
    credentialId, alg, jwk,
    signCount: authData.signCount,
    transports: Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string').slice(0, 6) : [],
  };
}

export function verifyAuthentication({ cfg, challenge, response, credential }) {
  const r = response?.response || {};
  const clientRaw = checkClientData(r.clientDataJSON, { type: 'webauthn.get', challenge, origin: cfg.origin });
  const authRaw = Buffer.from(String(r.authenticatorData || ''), 'base64url');
  const authData = parseAuthData(authRaw);
  checkRp(authData, cfg.rpId);
  const signed = Buffer.concat([authRaw, crypto.createHash('sha256').update(clientRaw).digest()]);
  const ok = verifySignature(credential.alg, JSON.parse(credential.public_key), signed,
    Buffer.from(String(r.signature || ''), 'base64url'));
  if (!ok) throw new Error('Passkey signature didn’t verify.');
  if (authData.signCount !== 0 || credential.sign_count !== 0) {
    if (authData.signCount <= credential.sign_count) throw new Error('This passkey may have been cloned.');
  }
  return { signCount: authData.signCount };
}

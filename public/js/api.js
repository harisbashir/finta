// JSON API client. The X-Finta header is part of the server's CSRF defence.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(message, status, field) { super(message); this.status = status; this.field = field; }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Finta': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('You’re offline or the server can’t be reached. Check your connection and try again.', 0);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/passkeys/login')) onUnauthorized();
    throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data?.field);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

// ─── WebAuthn helpers: base64url JSON ⇄ ArrayBuffers ───
const b64ToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => !!window.PublicKeyCredential && window.isSecureContext;

export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: b64ToBuf(options.challenge),
    user: { ...options.user, id: b64ToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: bufToB64(cred.response.clientDataJSON),
      attestationObject: bufToB64(cred.response.attestationObject),
      transports: cred.response.getTransports?.() || [],
    },
  };
}

export async function getPasskey(options, mediation) {
  const publicKey = { ...options, challenge: b64ToBuf(options.challenge), allowCredentials: [] };
  const cred = await navigator.credentials.get({ publicKey, ...(mediation ? { mediation } : {}) });
  return {
    id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: bufToB64(cred.response.clientDataJSON),
      authenticatorData: bufToB64(cred.response.authenticatorData),
      signature: bufToB64(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64(cred.response.userHandle) : null,
    },
  };
}

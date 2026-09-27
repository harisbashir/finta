// Declarative input validation. Every write goes through a schema; unknown fields are dropped.
import { bad } from './http.js';

export const COLORS = ['red', 'orange', 'yellow', 'green', 'mint', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const t = {
  str: (max = 200, opts = {}) => ({ kind: 'str', max, ...opts }),
  text: (max = 4000, opts = {}) => ({ kind: 'str', max, multiline: true, ...opts }),
  email: (opts = {}) => ({ kind: 'email', ...opts }),
  int: (min = 0, max = Number.MAX_SAFE_INTEGER, opts = {}) => ({ kind: 'int', min, max, ...opts }),
  money: (opts = {}) => ({ kind: 'int', min: 0, max: 100_000_000_000, ...opts }), // ≤ 1 billion in cents
  real: (min, max, opts = {}) => ({ kind: 'real', min, max, ...opts }),
  date: (opts = {}) => ({ kind: 'date', ...opts }),
  oneOf: (values, opts = {}) => ({ kind: 'enum', values, ...opts }),
  bool: (opts = {}) => ({ kind: 'bool', ...opts }),
  ref: (table, opts = {}) => ({ kind: 'ref', table, ...opts }),
  color: (opts = {}) => ({ kind: 'enum', values: COLORS, ...opts }),
};

/**
 * @param body   request JSON
 * @param schema { field: spec }  — spec.label is used in messages
 * @param ctx    { db, householdId, partial }
 */
export function validate(body, schema, { db, householdId, partial = false } = {}) {
  const out = {};
  for (const [field, spec] of Object.entries(schema)) {
    const label = spec.label || field.replace(/_/g, ' ');
    const present = Object.prototype.hasOwnProperty.call(body, field);
    let v = body[field];
    if (!present) {
      if (partial) continue;
      if (spec.default !== undefined) { out[field] = spec.default; continue; }
      if (spec.required) throw bad(`Add ${aOrAn(label)}.`, { field });
      continue;
    }
    if (typeof v === 'string' && spec.kind !== 'str') v = v.trim();
    if (v === null || v === '') {
      if (spec.required) throw bad(`Add ${aOrAn(label)}.`, { field });
      out[field] = null;
      continue;
    }
    switch (spec.kind) {
      case 'str': {
        if (typeof v !== 'string') throw bad(`${cap(label)} should be text.`, { field });
        v = spec.multiline ? v.replace(/\r\n/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
        // strip control characters except newline/tab
        v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        if (!v && spec.required) throw bad(`Add ${aOrAn(label)}.`, { field });
        if (v.length > spec.max) throw bad(`${cap(label)} is too long (max ${spec.max} characters).`, { field });
        out[field] = v || null;
        break;
      }
      case 'email': {
        if (typeof v !== 'string') throw bad('Enter an email address.', { field });
        v = v.trim().toLowerCase();
        if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad('Enter a valid email address.', { field });
        out[field] = v;
        break;
      }
      case 'int': {
        const n = typeof v === 'string' ? Number(v) : v;
        if (!Number.isInteger(n)) throw bad(`${cap(label)} should be a whole number.`, { field });
        if (n < spec.min || n > spec.max) throw bad(`${cap(label)} is out of range.`, { field });
        out[field] = n;
        break;
      }
      case 'real': {
        const n = typeof v === 'string' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${cap(label)} should be a number.`, { field });
        if (n < spec.min || n > spec.max) throw bad(`${cap(label)} is out of range.`, { field });
        out[field] = n;
        break;
      }
      case 'date':
        if (!isDate(v)) throw bad(`${cap(label)} should be a date.`, { field });
        out[field] = v;
        break;
      case 'enum':
        if (!spec.values.includes(v)) throw bad(`Choose a valid ${label}.`, { field });
        out[field] = v;
        break;
      case 'bool':
        out[field] = v === true || v === 1 || v === 'true' ? 1 : 0;
        break;
      case 'ref': {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) throw bad(`Choose a valid ${label}.`, { field });
        // Tenant isolation: a reference must point at a row in the caller's household.
        const row = db.prepare(`SELECT 1 FROM ${spec.table} WHERE id = ? AND household_id = ?`).get(id, householdId);
        if (!row) throw bad(`Choose a valid ${label}.`, { field });
        out[field] = id;
        break;
      }
      default:
        throw new Error(`Unknown spec kind ${spec.kind}`);
    }
  }
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const aOrAn = (s) => (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s;

export function checkPassword(pw, { email, name } = {}) {
  if (typeof pw !== 'string' || pw.length < 10) throw bad('Use at least 10 characters for your password.', { field: 'password' });
  if (pw.length > 256) throw bad('That password is too long.', { field: 'password' });
  const lower = pw.toLowerCase();
  const weak = ['password', '1234567890', 'qwertyuiop', 'letmein', 'welcome', 'iloveyou', 'finta'];
  if (weak.some((w) => lower.includes(w)) || /^(.)\1+$/.test(pw)) throw bad('That password is too easy to guess. Try a short phrase of a few words.', { field: 'password' });
  if (email && lower.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) throw bad('Don’t include your email in your password.', { field: 'password' });
  if (name && name.length >= 4 && lower.includes(name.toLowerCase())) throw bad('Don’t include your name in your password.', { field: 'password' });
}

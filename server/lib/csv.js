// Bank-statement CSV reading. Banks disagree on everything — headers or none, column order,
// date formats, one signed amount column or separate debit/credit columns, "$1,234.56" or
// "(12.00)". This module turns any of those into { date, description, amount, direction }.

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, BOM. Returns string[][] */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const delim = sniffDelimiter(s);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field.trim() === '') { q = true; field = ''; }
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
  return rows;
}

function sniffDelimiter(s) {
  const firstLines = s.split(/\r?\n/).slice(0, 5).join('\n');
  const count = (ch) => (firstLines.match(new RegExp(ch === '|' ? '\\|' : ch, 'g')) || []).length;
  const scores = { ',': count(','), ';': count(';'), '\t': count('\t'), '|': count('|') };
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

// ───────── Amounts ─────────

/** "$1,234.56" → 123456; "(12.00)" / "-12" / "12.00-" / "12.00 DR" → negative; "" → null */
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\b(DR|DB|D)$/i.test(s)) { neg = true; s = s.replace(/\s*(DR|DB|D)$/i, ''); }
  if (/\bCR$/i.test(s)) s = s.replace(/\s*CR$/i, '');
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^-/.test(s.replace(/^[^\d-]+/, ''))) neg = !neg;
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  // Decimal separator: the last . or , followed by exactly 1–2 digits.
  const m = s.match(/^(.*?)[.,](\d{1,2})$/);
  const whole = (m ? m[1] : s).replace(/[.,]/g, '');
  const cents = Number(whole || 0) * 100 + (m ? Number(m[2].padEnd(2, '0')) : 0);
  if (!Number.isFinite(cents)) return null;
  return neg ? -cents : cents;
}

// ───────── Dates ─────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => {
  if (!(y > 1970 && y < 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const year = (y) => (y < 100 ? 2000 + y : y);

export const DATE_FORMATS = ['YMD', 'MDY', 'DMY'];

/** Parse one date with a given numeric order. Month-name dates parse regardless of order. */
export function parseDate(raw, order = 'MDY') {
  const s = String(raw || '').trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '');
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return valid(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return valid(+m[1], +m[2], +m[3]);
  // "Sep 27, 2026", "27 Sep 2026", "27-Sep-26", "September 27 2026"
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/))) return valid(year(+m[3]), MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{2,4})$/))) return valid(year(+m[3]), MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    const a = +m[1], b = +m[2], y = year(+m[3]);
    if (order === 'DMY') return valid(y, b, a);
    if (order === 'YMD') return null;
    return valid(y, a, b);
  }
  return null;
}

/** Look at every date in a column and pick the order that parses all of them. */
export function detectDateOrder(values) {
  const nums = values.map((v) => String(v).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/)).filter(Boolean);
  if (!nums.length) return 'YMD';
  if (nums.some((m) => +m[1] > 12)) return 'DMY';
  if (nums.some((m) => +m[2] > 12)) return 'MDY';
  return 'MDY'; // ambiguous everywhere: North American default; the user can switch in the preview
}

// ───────── Columns ─────────

const HEADER_HINTS = {
  date: /^(transaction\s*)?date$|^posted(\s*date)?$|^posting\s*date$|^trans(action)?\.?\s*date$|^date\s*posted$/i,
  description: /desc|detail|narrative|payee|merchant|memo|transaction$|^name$|particulars/i,
  debit: /debit|withdraw|money\s*out|paid\s*out|^out$|charges?|purchases?/i,
  credit: /credit|deposit|money\s*in|paid\s*in|^in$|payments?$/i,
  amount: /^amount|^cad\s*\$|^value$|^transaction\s*amount/i,
  balance: /balance/i,
};

/**
 * Work out which column is which. Returns
 * { hasHeader, date, description, debit, credit, amount, balance, dateOrder, headers }
 * where each column is an index (or -1).
 */
export function detectMapping(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  const hasHeader = !first.some((c) => parseDate(c, 'MDY') || parseDate(c, 'DMY')) && first.some((c) => /[a-z]/i.test(c));
  const body = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const map = { hasHeader, date: -1, description: -1, debit: -1, credit: -1, amount: -1, balance: -1, headers: hasHeader ? first : null };

  if (hasHeader) {
    first.forEach((h, i) => {
      for (const key of ['date', 'balance', 'debit', 'credit', 'amount', 'description']) {
        if (map[key] === -1 && HEADER_HINTS[key].test(h)) { map[key] = i; break; }
      }
    });
  }
  const sample = body.slice(0, 200);
  const isDateCol = (i) => sample.length && sample.filter((r) => parseDate(r[i], 'MDY') || parseDate(r[i], 'DMY') || parseDate(r[i], 'YMD')).length / sample.length > 0.8;
  const isNumCol = (i) => sample.length && sample.filter((r) => !r[i] || parseAmount(r[i]) !== null).length / sample.length > 0.9 && sample.some((r) => r[i]);
  const textScore = (i) => sample.reduce((s, r) => s + ((r[i] || '').replace(/[\d\s.,$()-]/g, '').length), 0);

  if (map.date === -1) for (let i = 0; i < width; i++) if (isDateCol(i)) { map.date = i; break; }
  if (map.description === -1) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < width; i++) { if (i === map.date) continue; const sc = textScore(i); if (sc > bestScore) { best = i; bestScore = sc; } }
    map.description = best;
  }
  if (map.debit === -1 && map.credit === -1 && map.amount === -1) {
    // Headerless: the usual Canadian layout is date, description, debit, credit[, balance].
    const nums = [];
    for (let i = 0; i < width; i++) if (i !== map.date && i !== map.description && isNumCol(i)) nums.push(i);
    const signed = (i) => sample.some((r) => (parseAmount(r[i]) ?? 0) < 0);
    if (nums.length >= 2 && !signed(nums[0]) && !signed(nums[1])) {
      [map.debit, map.credit] = nums;
      if (nums[2] !== undefined) map.balance = nums[2];
    } else if (nums.length >= 1) {
      map.amount = nums[0];
      if (nums[1] !== undefined) map.balance = nums[1];
    }
  }
  map.dateOrder = map.date >= 0 ? detectDateOrder(body.map((r) => r[map.date] || '')) : 'MDY';
  return map;
}

/**
 * Turn rows into transactions.
 * @param mapping from detectMapping, possibly edited by the user
 * @param opts.flipSign  treat a single amount column's sign the other way round
 *                       (some card statements show purchases as positive)
 */
export function extractRows(rows, mapping, { flipSign = false } = {}) {
  const out = [];
  const errors = [];
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  body.forEach((r, idx) => {
    const line = idx + (mapping.hasHeader ? 2 : 1);
    const date = parseDate(r[mapping.date], mapping.dateOrder);
    if (!date) { if (r.some((c) => c)) errors.push({ line, reason: `Unreadable date “${(r[mapping.date] || '').slice(0, 20)}”` }); return; }
    const description = (r[mapping.description] || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    let amount = null;
    if (mapping.amount >= 0) {
      amount = parseAmount(r[mapping.amount]);
      if (amount !== null && flipSign) amount = -amount;
    } else {
      const d = parseAmount(r[mapping.debit]);
      const c = parseAmount(r[mapping.credit]);
      if (d) amount = -Math.abs(d);
      else if (c) amount = Math.abs(c);
      else if (d === 0 || c === 0) amount = 0;
    }
    if (amount === null) { errors.push({ line, reason: 'No amount' }); return; }
    if (amount === 0) return; // informational rows ("opening balance")
    const balance = mapping.balance >= 0 ? parseAmount(r[mapping.balance]) : null;
    out.push({ line, date, description, amount: Math.abs(amount), direction: amount < 0 ? 'out' : 'in', balance });
  });
  return { rows: out, errors };
}

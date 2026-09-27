// Calendar math on 'YYYY-MM-DD' strings. Everything is a plain date (no time zones):
// a bill due on the 1st is due on the 1st wherever you are.

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
const pad = (n) => String(n).padStart(2, '0');
export const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const toUTC = (s) => { const { y, m, d } = parse(s); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000); // b - a

/** Add months, clamping to the month's length but remembering the intended day. */
export function addMonths(s, n, anchorDay) {
  const { y, m, d } = parse(s);
  const day = anchorDay || d;
  const idx = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export function today(tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || process.env.TZ || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: fmt(y, m, 1), end: fmt(y, m, daysInMonth(y, m)) };
}

export const MONTHLY_FACTOR = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 };
const DAY_STEP = { weekly: 7, biweekly: 14 };

/**
 * All due dates of a schedule within [from, to], inclusive.
 * The schedule is anchored on `start` so dates never drift.
 */
export function occurrences({ frequency, start, end }, from, to) {
  const out = [];
  const last = end && end < to ? end : to;
  if (last < start || last < from) return out;

  if (DAY_STEP[frequency]) {
    const step = DAY_STEP[frequency];
    let k = Math.max(0, Math.ceil(diffDays(start, from) / step));
    for (let date = addDays(start, k * step); date <= last; date = addDays(start, ++k * step)) {
      if (date >= from && date >= start) out.push(date);
    }
    return out;
  }

  if (frequency === 'semimonthly') {
    const { d } = parse(start);
    const [d1, d2] = d <= 15 ? [d, d + 15] : [d - 15, d];
    let { y, m } = parse(from < start ? start : from);
    for (let guard = 0; guard < 1200; guard++) {
      for (const dd of [d1, d2]) {
        const date = fmt(y, m, Math.min(dd, daysInMonth(y, m)));
        if (date > last) return out;
        if (date >= from && date >= start) out.push(date);
      }
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  const step = MONTH_STEP[frequency] || 1;
  const s = parse(start);
  const f = parse(from);
  const monthsBetween = (f.y - s.y) * 12 + (f.m - s.m);
  let k = Math.max(0, Math.floor(monthsBetween / step) - 1);
  for (let guard = 0; guard < 2400; guard++, k++) {
    const date = addMonths(start, k * step, s.d);
    if (date > last) break;
    if (date >= from) out.push(date);
  }
  return out;
}

/** The first due date on or after `date`, or null if the schedule has ended. */
export function nextDue(item, date) {
  const horizon = addDays(date, 800);
  return occurrences(item, date, horizon)[0] || null;
}

const TASK_STEP = { daily: [1, 'd'], weekly: [7, 'd'], biweekly: [14, 'd'], monthly: [1, 'm'], quarterly: [3, 'm'], yearly: [12, 'm'] };

/** Next due date for a repeating task, always after `todayStr`. */
export function nextTaskDate(repeat, due, todayStr) {
  const rule = TASK_STEP[repeat];
  if (!rule) return null;
  const [n, unit] = rule;
  const base = due || todayStr;
  const anchorDay = parse(base).d;
  let next = base;
  for (let i = 1; i < 5000; i++) {
    next = unit === 'd' ? addDays(base, n * i) : addMonths(base, n * i, anchorDay);
    if (next > todayStr) return next;
  }
  return next;
}

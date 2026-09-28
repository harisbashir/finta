// A small, dependency-free chart kit, built to the dataviz rules:
//   thin marks (≤ 24 px bars, 2 px lines), 4 px rounded data-ends square at the baseline,
//   2 px surface gaps, hairline solid grid, one y-axis, legend for 2+ series, selective labels,
//   a hover/focus tooltip on every chart, and a table view so no value hides behind hover.
// Colours come from validated CSS tokens (--chart-*), applied by class because the CSP forbids
// inline styles. Text always uses text colours, never series colours.
import { html, raw, money, fmtDate } from './ui.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Compact money for axes: $0, $950, $1.2k, $15k, $1.3M */
export function moneyCompact(cents) {
  const v = cents / 100;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const sym = money(0, { short: true }).replace(/[\d.,\s]/g, '') || '$';
  if (a >= 1e6) return `${sign}${sym}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${sign}${sym}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${sign}${sym}${Math.round(a)}`;
}

function niceMax(v) {
  if (v <= 0) return 100;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/** Rect with rounded top corners only (data-end), square at the baseline. */
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function tooltipEl(host) {
  let tip = host.querySelector('.chart-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.setAttribute('role', 'status'); host.append(tip); }
  return tip;
}

function showTip(host, x, y, title, rows) {
  const tip = tooltipEl(host);
  tip.replaceChildren();
  const h = document.createElement('div'); h.className = 'chart-tip-title'; h.textContent = title; tip.append(h);
  for (const r of rows) {
    const line = document.createElement('div'); line.className = 'chart-tip-row';
    const key = document.createElement('i'); key.className = `key ${r.cls || ''}`;
    const v = document.createElement('strong'); v.textContent = r.value;
    const n = document.createElement('span'); n.textContent = r.name;
    line.append(key, v, n); tip.append(line);
  }
  tip.classList.add('on');
  const hw = host.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.max(4, Math.min(hw - tw - 4, x - tw / 2))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
}
const hideTip = (host) => host.querySelector('.chart-tip')?.classList.remove('on');

function legend(series, shape = 'rect') {
  if (series.length < 2) return '';
  return html`<div class="chart-legend">${series.map((s) => html`<span><i class="key ${shape === 'line' ? 'line' : ''} ${s.cls}"></i>${s.name}</span>`)}</div>`;
}

function table(caption, head, rows) {
  return html`<details class="chart-table"><summary>Show as table</summary>
    <table><caption class="sr-only">${caption}</caption><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i === 0 ? html`<th scope="row">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></details>`;
}

/** Re-render on width changes. Returns the host element. */
function responsive(host, draw) {
  let last = 0;
  const run = () => { const w = host.clientWidth; if (w && Math.abs(w - last) > 4) { last = w; draw(w); } };
  new ResizeObserver(run).observe(host);
  run();
}

// ───────── Grouped columns (e.g. money in vs out per month) ─────────
/**
 * @param el     container element
 * @param labels x categories
 * @param series [{ name, cls: 'c-in' | 'c-out' | 'c-1'…, values: cents[] }]
 */
export function columns(el, { labels, series, height = 190, caption = 'Chart', fullLabels }) {
  el.classList.add('chart');
  el.innerHTML = String(html`<div class="chart-plot"></div>${legend(series)}${table(caption, ['', ...series.map((s) => s.name)],
    labels.map((l, i) => [fullLabels?.[i] || l, ...series.map((s) => money(s.values[i], { short: true }))]))}`);
  const host = el.querySelector('.chart-plot');
  responsive(host, (W) => {
    const max = niceMax(Math.max(...series.flatMap((s) => s.values), 1));
    const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
    const padL = Math.max(...ticks.map((t) => moneyCompact(t).length)) * 7 + 10;
    const padB = 24, padT = 10, H = height;
    const plotW = W - padL - 4, plotH = H - padB - padT;
    const band = plotW / labels.length;
    const barW = Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length);
    const groupW = barW * series.length + 2 * (series.length - 1);
    const y = (v) => padT + plotH - (v / max) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(caption)}">`;
    for (const t of ticks) svg += `<line class="grid" x1="${padL}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${esc(moneyCompact(t))}</text>`;
    labels.forEach((l, i) => {
      const gx = padL + band * i + (band - groupW) / 2;
      svg += `<g class="band" data-i="${i}">`;
      svg += `<rect class="hit" x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH + padB}" tabindex="0" aria-label="${esc(`${fullLabels?.[i] || l}: ${series.map((s) => `${s.name} ${money(s.values[i], { short: true })}`).join(', ')}`)}"/>`;
      series.forEach((s, j) => {
        const v = Math.max(0, s.values[i]);
        svg += `<path class="mark ${s.cls}" d="${colPath(gx + j * (barW + 2), y(v), barW, plotH + padT - y(v))}"/>`;
      });
      svg += `</g><text class="tick" x="${padL + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`;
    });
    svg += `<line class="axis" x1="${padL}" x2="${W - 4}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
    host.innerHTML = svg;
    host.querySelectorAll('.band').forEach((g) => {
      const i = Number(g.dataset.i);
      const on = () => {
        host.querySelectorAll('.band').forEach((b) => b.classList.toggle('dim', b !== g));
        showTip(host, padL + band * i + band / 2, y(Math.max(...series.map((s) => s.values[i]))), fullLabels?.[i] || labels[i],
          series.map((s) => ({ name: s.name, value: money(s.values[i], { short: true }), cls: s.cls })));
      };
      const off = () => { host.querySelectorAll('.band').forEach((b) => b.classList.remove('dim')); hideTip(host); };
      g.addEventListener('pointerenter', on); g.addEventListener('pointerleave', off);
      g.querySelector('.hit').addEventListener('focus', on); g.querySelector('.hit').addEventListener('blur', off);
    });
  });
  return el;
}

// ───────── Lines (balance over time, debt payoff) ─────────
/**
 * @param series [{ name, cls, points: [{ x: 'YYYY-MM-DD', y: cents }] }] — all series share x values
 */
export function lines(el, { series, height = 200, caption = 'Chart', area = series.length === 1, xFormat = { month: 'short' }, tipDate = { month: 'short', day: 'numeric', year: 'numeric' }, endLabel = true }) {
  el.classList.add('chart');
  const xs = series[0].points.map((p) => p.x);
  const step = Math.max(1, Math.ceil(xs.length / 12));
  el.innerHTML = String(html`<div class="chart-plot"></div>${legend(series, 'line')}${table(caption, ['Date', ...series.map((s) => s.name)],
    xs.filter((_, i) => i % step === 0 || i === xs.length - 1).map((x) => [fmtDate(x, tipDate), ...series.map((s) => money(s.points.find((p) => p.x === x)?.y ?? 0, { short: true }))]))}`);
  const host = el.querySelector('.chart-plot');
  responsive(host, (W) => {
    const all = series.flatMap((s) => s.points.map((p) => p.y));
    const lo = Math.min(0, ...all), hiRaw = Math.max(...all, 1);
    const hi = niceMax(hiRaw - lo) + lo;
    const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
    const endPad = endLabel && series.length === 1 ? 64 : 8;
    const padL = Math.max(...ticks.map((t) => moneyCompact(t).length)) * 7 + 10, padB = 24, padT = 12, H = height;
    const plotW = W - padL - endPad, plotH = H - padB - padT;
    const x = (i) => padL + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
    const y = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(caption)}">`;
    for (const t of ticks) svg += `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${esc(moneyCompact(t))}</text>`;
    if (lo < 0) svg += `<line class="axis" x1="${padL}" x2="${padL + plotW}" y1="${y(0)}" y2="${y(0)}"/>`;
    // x labels: first of each month (or evenly spaced), never crowded
    const labelled = [];
    let lastX = -1e9;
    xs.forEach((d, i) => {
      const isBoundary = i === 0 || d.slice(0, 7) !== xs[i - 1].slice(0, 7);
      if (!isBoundary || x(i) - lastX < 56) return;
      lastX = x(i); labelled.push(i);
      svg += `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(fmtDate(d, xFormat))}</text>`;
    });
    series.forEach((s) => {
      const pts = s.points.map((p, i) => `${x(i).toFixed(1)},${y(p.y).toFixed(1)}`);
      if (area) svg += `<path class="area ${s.cls}" d="M${x(0)},${y(Math.max(lo, 0))}L${pts.join('L')}L${x(s.points.length - 1)},${y(Math.max(lo, 0))}Z"/>`;
      svg += `<polyline class="line ${s.cls}" points="${pts.join(' ')}"/>`;
    });
    if (endLabel && series.length === 1) {
      const last = series[0].points.at(-1);
      svg += `<circle class="dot ${series[0].cls}" cx="${x(xs.length - 1)}" cy="${y(last.y)}" r="4"/>`;
      svg += `<text class="end-label" x="${x(xs.length - 1) + 8}" y="${y(last.y) + 4}">${esc(moneyCompact(last.y))}</text>`;
    }
    svg += `<g class="cross" hidden><line class="crosshair" y1="${padT}" y2="${padT + plotH}"/>${series.map((s) => `<circle class="dot ${s.cls}" r="4"/>`).join('')}</g>`;
    svg += `<rect class="hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" tabindex="0" aria-label="${esc(caption)}: use arrow keys to read values"/></svg>`;
    host.innerHTML = svg;
    const cross = host.querySelector('.cross');
    const hit = host.querySelector('.hit');
    let idx = xs.length - 1;
    const show = (i) => {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      cross.hidden = false;
      cross.querySelector('line').setAttribute('x1', x(idx)); cross.querySelector('line').setAttribute('x2', x(idx));
      cross.querySelectorAll('circle').forEach((c, k) => { c.setAttribute('cx', x(idx)); c.setAttribute('cy', y(series[k].points[idx].y)); });
      showTip(host, x(idx), Math.min(...series.map((s) => y(s.points[idx].y))), fmtDate(xs[idx], tipDate),
        series.map((s) => ({ name: s.name, value: money(s.points[idx].y, { short: true }), cls: s.cls })));
    };
    hit.addEventListener('pointermove', (e) => {
      const r = hit.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * plotW;
      show(Math.round((px / plotW) * (xs.length - 1)));
    });
    hit.addEventListener('pointerleave', () => { cross.hidden = true; hideTip(host); });
    hit.addEventListener('focus', () => show(idx));
    hit.addEventListener('blur', () => { cross.hidden = true; hideTip(host); });
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - Math.max(1, Math.round(xs.length / 30))); }
      if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + Math.max(1, Math.round(xs.length / 30))); }
    });
  });
  return el;
}

// ───────── Horizontal bars (one series: where the money went) ─────────
/** rows: [{ label, value (cents), icon markup?, href?, sub? }] — one hue, sorted by value. */
export function barList(rows, { caption = 'Chart', max, limit = 8, href } = {}) {
  const top = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (rest.length) top.push({ label: `${rest.length} more`, value: rest.reduce((s, r) => s + r.value, 0), other: true });
  const m = max || Math.max(...top.map((r) => r.value), 1);
  return html`<div class="bar-list" role="list" aria-label="${caption}">
    ${top.map((r) => {
      const inner = html`${r.icon || ''}<span class="bl-body"><span class="bl-top"><span class="bl-label">${r.label}</span><span class="bl-value">${money(r.value, { short: true })}</span></span>
        <span class="bl-track"><i class="${r.other ? 'muted' : ''}" data-w="${(Math.max(0, r.value) / m) * 100}"></i></span>${r.sub ? html`<span class="bl-sub">${r.sub}</span>` : ''}</span>`;
      const link = r.href || (href && !r.other ? href(r) : null);
      return link ? html`<a class="bl-row" role="listitem" href="${link}">${inner}</a>` : html`<div class="bl-row" role="listitem">${inner}</div>`;
    })}
  </div>`;
}

// ───────── One stacked bar (share of a whole, e.g. who spent what) ─────────
/** parts: [{ name, value, cls }] — ≤ 4 parts get distinct colours; a legend with values is always shown. */
export function stack(parts, { caption = 'Chart' } = {}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  const shown = parts.filter((p) => p.value > 0);
  return html`<div class="stackbar" role="img" aria-label="${caption}: ${shown.map((p) => `${p.name} ${money(p.value, { short: true })}`).join(', ')}">
      ${shown.map((p) => html`<span class="${p.cls}" data-grow="${p.value / total}"></span>`)}
    </div>
    <div class="chart-legend values">${parts.map((p) => html`<span><i class="key ${p.cls}"></i>${p.name} <strong>${money(p.value, { short: true })}</strong> <em>${pct(p.value, total)}</em></span>`)}</div>`;
}

const pct = (v, total) => { const x = (Math.max(0, v) / total) * 100; return x > 0 && x < 1 ? '<1%' : `${Math.round(x)}%`; };

export const SERIES_CLASSES = ['c-1', 'c-2', 'c-3', 'c-4'];
export { raw };

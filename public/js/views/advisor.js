// Advisor: health check, where chequing is heading, what banking costs, and the tax year.
import { api } from '../api.js';
import { html, icon, $, $$, S, money, fmtDate, relDay, fSelect, toast } from '../ui.js';
import { lines } from '../charts.js';
import { getScope, scopeSwitch } from './money.js';

const STATUS = { good: ['Good', 'text-pos'], fair: ['Could be better', 'text-warn'], poor: ['Needs attention', 'text-neg'], unknown: ['Not enough data yet', 'text-2'] };
const PLAN = { rrsp: 'RRSP', tfsa: 'TFSA', fhsa: 'FHSA' };
const TOTALS = [['charity', 'Donations'], ['medical', 'Medical expenses'], ['tuition', 'Tuition'], ['kids', 'Kids (check which are childcare)']];
const NOTE = html`<p class="section-foot">Estimates from your Finta data, not professional advice.</p>`;
const short = (iso) => fmtDate(iso, { month: 'short', day: 'numeric' });

export async function mountAdvisor(v) {
  const sw = await scopeSwitch(() => load());
  const owner = S.user.role === 'owner';
  let data, tax, year = null;

  async function load() {
    const scope = getScope();
    [data, tax] = await Promise.all([
      api.get(`/api/advisor?scope=${scope}`),
      api.get(`/api/advisor/tax?scope=${scope}${year ? `&year=${year}` : ''}`),
    ]);
    year = tax.year;
    if (v.alive()) render();
  }

  function render() {
    const { health, forecast: f, fees } = data;
    const thisYear = Number(S.today.slice(0, 4));
    const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => [y, String(y)]);
    v.el.innerHTML = String(html`
      <div class="large-title"><h1>Advisor</h1><p>A check-up on your money, from what’s in Finta.</p></div>
      ${sw.markup}

      <section class="section">
        <div class="section-head"><h2>Health Check</h2>${health.months ? html`<span class="caps">Last ${health.months} ${health.months === 1 ? 'month' : 'months'}</span>` : ''}</div>
        <div class="tiles">${health.metrics.map((m) => html`<div class="tile-stat">
          <span class="label">${m.label}</span><span class="value">${m.display}</span>
          <span class="delta ${STATUS[m.status][1]}">● ${STATUS[m.status][0]} · Target ${m.target}</span>
          <span class="delta">${m.next}</span></div>`)}</div>
        ${owner ? html`<div class="group"><div class="row"><span class="body"><span class="title">Emergency Fund Target</span><span class="sub">Months of essential spending to keep in cash</span></span>
          <button class="btn small" data-em="-1" aria-label="Fewer months">−</button><strong class="em-value" aria-live="polite">${data.emergencyMonths}</strong><button class="btn small" data-em="1" aria-label="More months">+</button></div></div>` : ''}
        ${NOTE}
      </section>

      <section class="section">
        <div class="section-head"><h2>Cash Flow</h2>${f.low ? html`<span class="caps">Lowest ${money(f.low.balance, { short: true })} · ${short(f.low.date)}</span>` : ''}</div>
        ${f.basis === 'no-chequing' ? html`<div class="group"><div class="row"><span class="body"><span class="title">Add a chequing account to see where it’s heading.</span></span></div></div>` : html`
          ${f.warning?.level === 'danger' ? html`<div class="form-error">${icon('circle-alert')}<span>Chequing may go below $0 around ${short(f.warning.date)}. Move money in, or move a bill, before then.</span></div>` : ''}
          ${f.warning?.level === 'watch' ? html`<p class="text-warn">Chequing gets low, under $100, around ${short(f.warning.date)}.</p>` : ''}
          <div class="card"><div id="cf-chart"></div></div>
          <p class="section-foot">${f.basis === 'full'
            ? `Bills and paydays, repeating payments Finta noticed, and a typical day from your recent history (about ${money(f.typical.out, { short: true })} out and ${money(f.typical.in, { short: true })} in).`
            : 'Bills and repeating payments only. Once there are 30 days of history, everyday spending is included too.'}</p>
          ${f.events.length ? html`<div class="group-label">Coming Up</div><div class="group">${f.events.map((e) => html`<div class="row">
            <span class="body"><span class="title">${e.name}</span><span class="sub">${relDay(e.date)}${e.source === 'detected' ? ' · repeats, noticed by Finta' : ''}</span></span>
            <span class="trail"><span class="amount ${e.direction === 'in' ? 'text-pos' : ''}">${e.direction === 'in' ? '+' : '−'}${money(e.amount)}</span></span></div>`)}</div>` : ''}`}
        ${NOTE}
      </section>

      <section class="section">
        <div class="section-head"><h2>Fees & Interest</h2><span class="caps">${money(fees.total)} in 12 months</span></div>
        ${fees.byKind.length ? html`<div class="group">${fees.byKind.map((k) => html`<div class="row"><span class="body"><span class="title">${k.label}</span>
          <span class="sub">${k.kind === 'fx' ? 'Estimated from purchases in other currencies' : `${k.count} ${k.count === 1 ? 'charge' : 'charges'}`}</span></span><span class="trail"><span class="amount">${money(k.amount)}</span></span></div>`)}</div>`
          : html`<div class="group"><div class="row"><span class="body"><span class="title">No bank fees or interest in the last 12 months.</span></span></div></div>`}
        ${fees.suggestions.length ? html`<div class="group-label">Ways to Pay Less</div><div class="group">${fees.suggestions.map((s) => html`<div class="row"><span class="body"><span class="title">${s.text}</span></span></div>`)}</div>` : ''}
        ${NOTE}
      </section>

      <section class="section">
        <div class="section-head"><h2>Tax Year</h2><a href="/api/advisor/tax/${year}.csv?scope=${getScope()}" download>Export CSV</a></div>
        <div class="group">${fSelect('tax_year', 'Year', years, year, { data: 'data-year' })}</div>
        ${tax.estimate ? html`<p class="text-warn">Finta doesn’t have the official ${year} limits yet, so it uses the latest year it knows.</p>` : ''}
        ${tax.people.map((p) => html`
          <div class="group-label">${p.name}</div>
          <div class="group">
            ${TOTALS.map(([k, label]) => html`<div class="row"><span class="body"><span class="title">${label}</span></span><span class="trail"><span class="amount">${money(p.totals[k])}</span></span></div>`)}
            ${p.contributions.map((c) => html`<div class="row"><span class="body"><span class="title">${PLAN[c.kind]} contributions: ${money(c.amount)}</span>
              <span class="sub">${year} limit ${money(c.limit, { short: true })}${c.remaining != null ? ` · ${money(c.remaining)} of your room left` : ' · enter your room from your CRA notice'}</span></span>
              ${p.user_id === S.user.id || owner ? html`<input class="room-input" inputmode="decimal" data-room="${c.kind}" data-user="${p.user_id}" value="${c.room != null ? (c.room / 100).toFixed(2) : ''}" placeholder="Room" aria-label="${PLAN[c.kind]} room for ${year}">` : ''}</div>`)}
            ${p.resp.contributed ? html`<div class="row"><span class="body"><span class="title">RESP contributions: ${money(p.resp.contributed)}</span><span class="sub">About ${money(p.resp.grant)} in government grant (CESG, 20% of the first $2,500)</span></span></div>` : ''}
          </div>`)}
        <p class="section-foot">RRSP counts contributions from March 2 to March 1 of the next year. Mark an investment account as RRSP, TFSA, FHSA or RESP to track it. Room comes from your CRA notice of assessment.</p>
        ${NOTE}
      </section>`);

    if (f.basis !== 'no-chequing' && f.points.length) {
      lines($('#cf-chart', v.el), {
        series: [
          { name: 'Chequing', cls: 'c-tint', points: f.points.map((p) => ({ x: p.date, y: p.balance })) },
          { name: '$0', cls: 'c-muted', points: f.points.map((p) => ({ x: p.date, y: 0 })) },
        ],
        caption: 'Chequing balance over the next 60 days', area: false, xFormat: { month: 'short', day: 'numeric' }, endLabel: false,
      });
    }
    sw.wire(v.el);
    $$('[data-em]', v.el).forEach((b) => b.addEventListener('click', async () => {
      const next = Math.min(24, Math.max(1, data.emergencyMonths + Number(b.dataset.em)));
      if (next === data.emergencyMonths) return;
      try { await api.patch('/api/advisor/settings', { emergency_months: next }); await load(); } catch (err) { toast(err.message, { error: true }); }
    }));
    $('[data-year]', v.el)?.addEventListener('change', async (e) => { year = Number(e.target.value); await load(); });
    $$('[data-room]', v.el).forEach((input) => input.addEventListener('change', async () => {
      const dollars = Number(String(input.value).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(dollars)) return;
      try {
        await api.put('/api/advisor/room', { user_id: Number(input.dataset.user), year, kind: input.dataset.room, room: Math.round(dollars * 100) });
        await load();
      } catch (err) { toast(err.message, { error: true }); }
    }));
  }

  await load();
}

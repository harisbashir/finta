// Canadian registered-plan limits by year, in cents. Update once a year.
//   TFSA: Government of Canada "TFSA dollar limits" ($7,000 for 2024–2026).
//   RRSP: CRA "MP, DB, RRSP, DPSP, ALDA, TFSA limits" ($32,490 for 2025, $33,810 for 2026).
//   FHSA: $8,000 a year, $40,000 lifetime since 2023. RESP: CESG is 20% of the first $2,500 a year.
const BY_YEAR = {
  2025: { tfsa: 700000, rrsp: 3249000 },
  2026: { tfsa: 700000, rrsp: 3381000 },
};
const LATEST = Math.max(...Object.keys(BY_YEAR).map(Number));

/** Limits for a tax year. Years after the newest known one reuse it and are marked as estimates. */
export function limitsFor(year) {
  const known = BY_YEAR[year];
  const base = known || BY_YEAR[Math.min(Math.max(year, Math.min(...Object.keys(BY_YEAR).map(Number))), LATEST)];
  return {
    year, ...base, fhsa: 800000, fhsaLifetime: 4000000, respGrantRate: 0.2, respGrantBase: 250000, estimate: !known,
  };
}

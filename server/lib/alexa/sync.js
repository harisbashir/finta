// Two-way list sync planner. Pure: compares Finta rows and Alexa items against the snapshot
// taken at the last sync and returns the actions that bring both sides together.
// Rules (see docs/superpowers/specs/2026-10-26-alexa-list-sync-design.md):
// one side changed → copy it over; both changed → Alexa wins; gone on one side → delete on the other.

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const sameName = (a, b) => norm(a) === norm(b);

/**
 * @param {{ finta: {id, name, checked, repeat}[], alexa: {itemId, name, checked, version}[],
 *           snapshots: {fintaId, itemId, name, checked, version}[], maxName?: number }} input
 */
export function plan({ finta, alexa, snapshots, maxName = 80 }) {
  const clean = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, maxName).trim();
  const fById = new Map(finta.map((r) => [r.id, r]));
  const aById = new Map(alexa.filter((i) => clean(i.name)).map((i) => [i.itemId, i]));
  const actions = [];
  const pull = (row, item) => (item.checked && !row.checked && row.repeat && row.repeat !== 'none')
    ? { op: 'finta.roll', fintaId: row.id, itemId: item.itemId, version: item.version, name: clean(item.name) }
    : { op: 'finta.update', fintaId: row.id, itemId: item.itemId, version: item.version, name: clean(item.name), checked: !!item.checked };

  const mappedF = new Set();
  const mappedA = new Set();
  for (const s of snapshots) {
    const row = fById.get(s.fintaId);
    const item = aById.get(s.itemId);
    if (row) mappedF.add(row.id);
    if (item) mappedA.add(item.itemId);
    if (!row && !item) { actions.push({ op: 'unlink', itemId: s.itemId }); continue; }
    if (!row) { actions.push({ op: 'alexa.delete', itemId: item.itemId, version: item.version }); continue; }
    if (!item) { actions.push({ op: 'finta.delete', fintaId: row.id, itemId: s.itemId }); continue; }
    const fChanged = !sameName(row.name, s.name) || !!row.checked !== !!s.checked;
    const aChanged = !sameName(item.name, s.name) || !!item.checked !== !!s.checked;
    if (aChanged) actions.push(pull(row, item));
    else if (fChanged) actions.push({ op: 'alexa.update', fintaId: row.id, itemId: item.itemId, version: item.version, name: row.name, checked: !!row.checked });
  }

  // Pair unmapped rows and items by name, one-to-one, preferring the same checked state.
  const freeA = alexa.filter((i) => aById.has(i.itemId) && !mappedA.has(i.itemId));
  const freeF = finta.filter((r) => !mappedF.has(r.id));
  const leftF = [];
  for (const row of freeF) {
    const candidates = freeA.filter((i) => !mappedA.has(i.itemId) && sameName(i.name, row.name));
    const item = candidates.find((i) => !!i.checked === !!row.checked) || candidates[0];
    if (!item) { leftF.push(row); continue; }
    mappedA.add(item.itemId);
    if (!!item.checked === !!row.checked) actions.push({ op: 'link', fintaId: row.id, itemId: item.itemId, version: item.version, name: row.name, checked: !!row.checked });
    else actions.push(pull(row, item));
  }
  for (const row of leftF) actions.push({ op: 'alexa.add', fintaId: row.id, name: row.name, checked: !!row.checked });
  for (const item of freeA) {
    if (!mappedA.has(item.itemId)) actions.push({ op: 'finta.add', itemId: item.itemId, version: item.version, name: clean(item.name), checked: !!item.checked });
  }
  return actions;
}

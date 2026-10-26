import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, sameName } from '../server/lib/alexa/sync.js';

const F = (id, name, checked = false, repeat = 'none') => ({ id, name, checked, repeat });
const A = (itemId, name, checked = false, version = 1) => ({ itemId, name, checked, version });
const S = (fintaId, itemId, name, checked = false, version = 1) => ({ fintaId, itemId, name, checked, version });
const sorted = (actions) => [...actions].sort((a, b) => (a.op + (a.itemId || '') + (a.fintaId || '')).localeCompare(b.op + (b.itemId || '') + (b.fintaId || '')));
const run = (finta, alexa, snapshots, maxName = 80) => sorted(plan({ finta, alexa, snapshots, maxName }));

test('sameName ignores case and extra spaces', () => {
  assert.ok(sameName(' Oat  Milk ', 'oat milk'));
  assert.ok(!sameName('milk', 'oat milk'));
});

test('nothing changed → no actions', () => {
  assert.deepEqual(run([F(1, 'milk')], [A('a', 'milk')], [S(1, 'a', 'milk')]), []);
});

test('Finta rename → alexa.update with snapshot version', () => {
  assert.deepEqual(run([F(1, 'oat milk')], [A('a', 'milk', false, 4)], [S(1, 'a', 'milk', false, 4)]),
    [{ op: 'alexa.update', fintaId: 1, itemId: 'a', version: 4, name: 'oat milk', checked: false }]);
});

test('Finta tick → alexa.update checked', () => {
  assert.deepEqual(run([F(1, 'milk', true)], [A('a', 'milk')], [S(1, 'a', 'milk')]),
    [{ op: 'alexa.update', fintaId: 1, itemId: 'a', version: 1, name: 'milk', checked: true }]);
});

test('Alexa tick → finta.update', () => {
  assert.deepEqual(run([F(1, 'milk')], [A('a', 'milk', true, 2)], [S(1, 'a', 'milk')]),
    [{ op: 'finta.update', fintaId: 1, itemId: 'a', version: 2, name: 'milk', checked: true }]);
});

test('both changed → Alexa wins', () => {
  assert.deepEqual(run([F(1, 'oat milk')], [A('a', 'milk', true, 2)], [S(1, 'a', 'milk')]),
    [{ op: 'finta.update', fintaId: 1, itemId: 'a', version: 2, name: 'milk', checked: true }]);
});

test('Finta row gone → alexa.delete', () => {
  assert.deepEqual(run([], [A('a', 'milk', false, 3)], [S(1, 'a', 'milk')]),
    [{ op: 'alexa.delete', itemId: 'a', version: 3 }]);
});

test('Alexa item gone → finta.delete', () => {
  assert.deepEqual(run([F(1, 'milk')], [], [S(1, 'a', 'milk')]),
    [{ op: 'finta.delete', fintaId: 1, itemId: 'a' }]);
});

test('both gone → unlink', () => {
  assert.deepEqual(run([], [], [S(1, 'a', 'milk')]), [{ op: 'unlink', itemId: 'a' }]);
});

test('case-only change on Alexa → no actions', () => {
  assert.deepEqual(run([F(1, 'milk')], [A('a', 'Milk', false, 2)], [S(1, 'a', 'milk')]), []);
});

test('first sync matches by name, adds the rest both ways', () => {
  assert.deepEqual(run([F(1, 'milk'), F(2, 'eggs')], [A('a', 'Milk', false, 5), A('b', 'bread', false, 7)], []), [
    { op: 'alexa.add', fintaId: 2, name: 'eggs', checked: false },
    { op: 'finta.add', itemId: 'b', version: 7, name: 'bread', checked: false },
    { op: 'link', fintaId: 1, itemId: 'a', version: 5, name: 'milk', checked: false },
  ]);
});

test('duplicate names pair one-to-one', () => {
  assert.deepEqual(run([F(1, 'milk')], [A('a', 'milk'), A('b', 'milk')], []), [
    { op: 'finta.add', itemId: 'b', version: 1, name: 'milk', checked: false },
    { op: 'link', fintaId: 1, itemId: 'a', version: 1, name: 'milk', checked: false },
  ]);
});

test('matching prefers the same checked state', () => {
  assert.deepEqual(run([F(1, 'milk', true)], [A('a', 'milk', false), A('b', 'milk', true)], []), [
    { op: 'finta.add', itemId: 'a', version: 1, name: 'milk', checked: false },
    { op: 'link', fintaId: 1, itemId: 'b', version: 1, name: 'milk', checked: true },
  ]);
});

test('repeating task ticked on Alexa → finta.roll', () => {
  assert.deepEqual(run([F(1, 'water plants', false, 'weekly')], [A('a', 'water plants', true, 2)], [S(1, 'a', 'water plants')]),
    [{ op: 'finta.roll', fintaId: 1, itemId: 'a', version: 2, name: 'water plants' }]);
});

test('long Alexa name is trimmed to maxName', () => {
  const [a] = run([], [A('a', 'x'.repeat(100))], []);
  assert.equal(a.op, 'finta.add');
  assert.equal(a.name.length, 80);
});

test('blank Alexa name is ignored', () => {
  assert.deepEqual(run([], [A('a', '   ')], []), []);
});

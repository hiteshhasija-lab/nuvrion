import test from 'node:test';
import assert from 'node:assert/strict';
import { parseView, parseCreate, parseChange, parseExportNote, describeView, ViewError, LIMITS, SORT_KEYS } from '../src/view-rules.js';

// What a saved view may hold: the filters and the sort of the inventory, nothing else, each cleaned or refused.
const refused = (fn, pattern) => assert.throws(fn, error => error instanceof ViewError && (!pattern || pattern.test(error.message)), String(pattern));

test('a view is cleaned: text is trimmed, an empty field is none, a sort needs a column, and a direction means nothing without one', () => {
  assert.deepEqual(parseView({}), { search: '', platform: '', power: null, health: null, tag: null, sortKey: null, sortDirection: 'asc' });
  assert.deepEqual(parseView({ search: '  web  ', platform: 'vmware_esxi', power: 'running', health: 'needs-attention', tag: ' env=prod ', sortKey: 'memory', sortDirection: 'desc' }),
    { search: 'web', platform: 'vmware_esxi', power: 'running', health: 'needs-attention', tag: 'env=prod', sortKey: 'memory', sortDirection: 'desc' });
  assert.deepEqual(parseView({ platform: '', power: '', sortKey: '', sortDirection: 'desc' }), { search: '', platform: '', power: null, health: null, tag: null, sortKey: null, sortDirection: 'asc' });
  for (const key of SORT_KEYS) assert.equal(parseView({ sortKey: key }).sortKey, key);
});

test('what a view may not hold is refused, not ignored: unknown fields, odd words, unknown sort columns, control characters, too much text', () => {
  for (const bad of [null, [], 'x', { extra: 1 }, { platform: 'VMware' }, { platform: 'a b' }, { power: 5 }, { health: '1x' }, { sortKey: 'color' }, { sortDirection: 'sideways', sortKey: 'name' }, { search: 'x'.repeat(LIMITS.searchMax + 1) }, { tag: 'x'.repeat(LIMITS.tagMax + 1) }, { search: 'a\u0000b' }, { tag: 'a‮b' }]) refused(() => parseView(bad));
});

test('a new view needs a name; a change needs something to change; names are cleaned', () => {
  assert.deepEqual(parseCreate({ name: ' Web servers ', view: { search: 'web' } }), { name: 'Web servers', view: parseView({ search: 'web' }) });
  for (const bad of [null, {}, { name: '', view: {} }, { name: 'x'.repeat(LIMITS.nameMax + 1), view: {} }, { name: 'a\u0007', view: {} }, { name: 'ok' }, { name: 'ok', view: {}, extra: 1 }]) refused(() => parseCreate(bad));
  assert.deepEqual(parseChange({ name: ' New ' }), { name: 'New' }); assert.deepEqual(parseChange({ view: { tag: 'a' } }), { view: parseView({ tag: 'a' }) });
  for (const bad of [{}, null, { nope: 1 }, { name: '' }, { view: 5 }]) refused(() => parseChange(bad));
});

test('a note that an export happened carries only how big it was', () => {
  assert.deepEqual(parseExportNote({ count: 12, columns: 14, view: { power: 'running' } }), { count: 12, columns: 14, view: parseView({ power: 'running' }) });
  assert.deepEqual(parseExportNote({ count: 0 }), { count: 0, columns: null, view: null });
  for (const bad of [null, {}, { count: -1 }, { count: 1.5 }, { count: 2_000_000 }, { count: 1, columns: 0 }, { count: 1, columns: 101 }, { count: 1, extra: true }, { count: 1, view: { sortKey: 'x' } }]) refused(() => parseExportNote(bad));
});

test('a view is described in words', () => {
  assert.equal(describeView(parseView({})), 'everything, unsorted');
  assert.equal(describeView(parseView({ power: 'running', platform: 'vmware_esxi', tag: 'env=prod', search: 'web', sortKey: 'memory', sortDirection: 'desc' }), { platformLabel: key => ({ vmware_esxi: 'VMware ESXi' })[key] }), 'running, VMware ESXi, tag env=prod, search “web”, sorted by memory (descending)');
  assert.equal(describeView(parseView({ sortKey: 'name' })), 'sorted by name (ascending)');
});

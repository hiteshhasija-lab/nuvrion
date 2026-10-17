import test from 'node:test';
import assert from 'node:assert/strict';
import { TAG_LIMITS, TagError, normaliseKey, normaliseValue, parseTagOperation, planTagChanges, providerTags, parseTagFilter, matchesTagFilter } from '../src/tag-rules.js';

// What a tag may look like and what a request changes. Both stores use these functions, so these tests are the definition of the behaviour.
const ID = '3f2b8c1e-5a47-4d3e-9b0a-1c2d3e4f5a6b', ID2 = '4a3c9d2f-6b58-4e4f-8c1b-2d3e4f5a6b7c';
const refuses = (run, pattern, code = 'NUV_TAG_REQUEST_INVALID') => assert.throws(run, error => error instanceof TagError && error.code === code && pattern.test(error.message), String(pattern));

test('keys are lower case, trimmed, limited to letters, digits and . _ : / -, must start with a letter or digit, and may not use a reserved prefix', () => {
  assert.equal(normaliseKey('  Env '), 'env');
  assert.equal(normaliseKey('cost-center/eu.west_1:a'), 'cost-center/eu.west_1:a');
  for (const bad of ['', '   ', null, undefined]) refuses(() => normaliseKey(bad), /needs a key/);
  for (const bad of ['has space', 'ünïcode', '-leading', '.dot', 'semi;colon', 'a=b', 'quote"d', '<b>']) refuses(() => normaliseKey(bad), /may use only/, 'NUV_TAG_REQUEST_INVALID');
  refuses(() => normaliseKey('k'.repeat(TAG_LIMITS.keyLength + 1)), /at most 64/);
  assert.equal(normaliseKey('k'.repeat(TAG_LIMITS.keyLength)).length, 64);
  for (const prefix of ['nuvrion:x', 'AWS:Name', 'azure:y', 'vmware:z', 'microsoft:w']) refuses(() => normaliseKey(prefix), /reserved/);
  assert.equal(normaliseKey('nuvrionx'), 'nuvrionx', 'only the prefix with the colon is reserved');
});

test('values are trimmed, may be empty or contain spaces and any letters, and may not contain control or invisible formatting characters', () => {
  assert.equal(normaliseValue('  hello world  '), 'hello world');
  assert.equal(normaliseValue(undefined), ''); assert.equal(normaliseValue(null), ''); assert.equal(normaliseValue(''), '');
  assert.equal(normaliseValue('Zürich — 東京 <ok> & "quoted"'), 'Zürich — 東京 <ok> & "quoted"', 'markup is stored as text; showing it is the page’s job');
  for (const bad of ['a\u0000b', 'a\nb', 'a\tb', 'a​b', 'a‮b', 'a b', 'a b']) refuses(() => normaliseValue(bad), /control or invisible/);
  refuses(() => normaliseValue('v'.repeat(TAG_LIMITS.valueLength + 1)), /at most 128/);
  assert.equal(normaliseValue('v'.repeat(TAG_LIMITS.valueLength)).length, 128);
});

test('a request is validated and normalised: ids are unique and lower case, keys lower case, set values trimmed', () => {
  const parsed = parseTagOperation({ resourceIds: [ID.toUpperCase(), ID, ID2], set: [{ key: 'Env', value: ' prod ' }, { key: 'flag' }], remove: ['Old'] });
  assert.deepEqual(parsed, { resourceIds: [ID, ID2], set: [{ key: 'env', value: 'prod' }, { key: 'flag', value: '' }], remove: ['old'] });
  assert.deepEqual(parseTagOperation({ resourceIds: [ID], remove: ['x'] }).set, [], 'remove alone is a request');
  assert.deepEqual(parseTagOperation({ resourceIds: [ID], set: [{ key: 'x', value: 1 }] }).set, [{ key: 'x', value: '1' }], 'a number is stored as its text');
});

test('a request that is not well formed is refused with a reason, and a request with nothing in it is refused', () => {
  const ok = { resourceIds: [ID], set: [{ key: 'a', value: 'b' }] };
  for (const bad of [null, undefined, 'text', 5, [], true]) refuses(() => parseTagOperation(bad), /JSON object/);
  refuses(() => parseTagOperation({ ...ok, extra: 1 }), /Unknown field: extra/);
  refuses(() => parseTagOperation({ set: ok.set }), /at least one resource/);
  refuses(() => parseTagOperation({ ...ok, resourceIds: [] }), /at least one resource/);
  refuses(() => parseTagOperation({ ...ok, resourceIds: 'x' }), /at least one resource/);
  refuses(() => parseTagOperation({ ...ok, resourceIds: ['nope'] }), /resource identifiers/);
  refuses(() => parseTagOperation({ ...ok, resourceIds: [5] }), /resource identifiers/);
  refuses(() => parseTagOperation({ ...ok, set: 'x' }), /must be lists/);
  refuses(() => parseTagOperation({ ...ok, remove: {} }), /must be lists/);
  refuses(() => parseTagOperation({ resourceIds: [ID] }), /Nothing to change/);
  refuses(() => parseTagOperation({ resourceIds: [ID], set: [], remove: [] }), /Nothing to change/);
  refuses(() => parseTagOperation({ ...ok, set: [null] }), /an object with a key/);
  refuses(() => parseTagOperation({ ...ok, set: [['k', 'v']] }), /an object with a key/);
  refuses(() => parseTagOperation({ ...ok, remove: [5] }), /must be a key/);
  refuses(() => parseTagOperation({ ...ok, set: [{ key: 'a' }, { key: 'A' }] }), /set twice/);
  refuses(() => parseTagOperation({ ...ok, set: [{ key: 'a' }], remove: ['A'] }), /both set and removed/);
});

test('the size limits of a request are enforced at the edge', () => {
  const ids = n => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(parseTagOperation({ resourceIds: ids(200), set: [{ key: 'a' }] }).resourceIds.length, 200);
  refuses(() => parseTagOperation({ resourceIds: ids(201), set: [{ key: 'a' }] }), /at most 200 resources/);
  const many = n => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: '' }));
  assert.equal(parseTagOperation({ resourceIds: [ID], set: many(20) }).set.length, 20);
  refuses(() => parseTagOperation({ resourceIds: [ID], set: many(21) }), /at most 20 tags/);
  refuses(() => parseTagOperation({ resourceIds: [ID], remove: many(21).map(item => item.key) }), /at most 20 tags/);
});

const existing = (entries = {}) => new Map(Object.entries(entries).map(([id, tags]) => [id, new Map(Object.entries(tags))]));

test('a plan says, for each resource, what is added, what changes value, what is removed and what the tags are afterwards', () => {
  const plan = planTagChanges(existing({ [ID]: { env: 'prod', team: 'core', old: 'x' } }), parseTagOperation({ resourceIds: [ID, ID2], set: [{ key: 'env', value: 'staging' }, { key: 'team', value: 'core' }, { key: 'new', value: '1' }], remove: ['old', 'absent'] }));
  assert.deepEqual(plan[0], { resourceId: ID, added: [{ key: 'new', value: '1' }], changed: [{ key: 'env', from: 'prod', value: 'staging' }], removed: [{ key: 'old', value: 'x' }],
    after: [{ key: 'env', value: 'staging' }, { key: 'new', value: '1' }, { key: 'team', value: 'core' }], changedAnything: true });
  assert.deepEqual(plan[1].added.map(tag => tag.key), ['env', 'team', 'new'], 'additions are listed in the order they were asked for');
  assert.deepEqual(plan[1].after.map(tag => tag.key), ['env', 'new', 'team'], 'the tags afterwards are sorted by key');
  assert.deepEqual(plan[1].removed, [], 'removing a tag the resource does not have is not a change');
});

test('setting what is already there, or removing what is not, changes nothing; a plan never touches the tags it was given', () => {
  const before = existing({ [ID]: { env: 'prod' } });
  const plan = planTagChanges(before, parseTagOperation({ resourceIds: [ID], set: [{ key: 'env', value: 'prod' }], remove: ['gone'] }));
  assert.equal(plan[0].changedAnything, false);
  planTagChanges(before, parseTagOperation({ resourceIds: [ID], set: [{ key: 'env', value: 'other' }] }));
  assert.equal(before.get(ID).get('env'), 'prod');
});

test('no resource may end up with more than 50 tags, and a request that would push any one over changes none', () => {
  const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, '']));
  const room = { [ID2]: { a: '1' } };
  refuses(() => planTagChanges(existing({ [ID]: full, ...room }), parseTagOperation({ resourceIds: [ID2, ID], set: [{ key: 'one-more' }] })), /at most 50 tags/, 'NUV_TAG_LIMIT_EXCEEDED');
  assert.equal(planTagChanges(existing({ [ID]: full }), parseTagOperation({ resourceIds: [ID], set: [{ key: 'k0', value: 'changed' }] }))[0].after.length, 50, 'changing a value at the limit is fine');
  assert.equal(planTagChanges(existing({ [ID]: full }), parseTagOperation({ resourceIds: [ID], set: [{ key: 'swap' }], remove: ['k0'] }))[0].after.length, 50, 'swapping one for another is fine');
});

test('provider tags come from the resource attributes as read-only entries, sorted, tolerant of anything else', () => {
  assert.deepEqual(providerTags({ tags: { Name: 'web', env: 'prod', empty: '' } }), [{ key: 'Name', value: 'web', source: 'provider' }, { key: 'empty', value: '', source: 'provider' }, { key: 'env', value: 'prod', source: 'provider' }].sort((a, b) => (a.key < b.key ? -1 : 1)));
  for (const odd of [undefined, null, {}, { tags: null }, { tags: 'x' }, { tags: ['a'] }, { tags: 5 }]) assert.deepEqual(providerTags(odd), []);
  assert.deepEqual(providerTags({ tags: { a: 5, b: null } }), [{ key: 'a', value: '5', source: 'provider' }, { key: 'b', value: '', source: 'provider' }]);
  assert.equal(providerTags({ tags: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'])) }).length, 200, 'a hostile provider cannot send an unbounded list');
  assert.equal(providerTags({ tags: { k: 'v'.repeat(1000) } })[0].value.length, 256);
});

test('a tag filter is "key" (any value) or "key=value" (that value); keys compare in lower case, values exactly; an empty key is refused', () => {
  assert.deepEqual(parseTagFilter('Env'), { key: 'env' });
  assert.deepEqual(parseTagFilter('ENV=Prod '), { key: 'env', value: 'Prod' });
  assert.deepEqual(parseTagFilter('env='), { key: 'env', value: '' }, 'env= means the empty value');
  assert.deepEqual(parseTagFilter('a=b=c'), { key: 'a', value: 'b=c' });
  for (const bad of ['', '=x', '  ', undefined]) refuses(() => parseTagFilter(bad), /needs a key/);
  const tags = [{ key: 'Env', value: 'prod', source: 'provider' }, { key: 'team', value: '', source: 'nuvrion' }];
  assert.equal(matchesTagFilter(tags, parseTagFilter('env')), true);
  assert.equal(matchesTagFilter(tags, parseTagFilter('env=prod')), true);
  assert.equal(matchesTagFilter(tags, parseTagFilter('env=PROD')), false, 'values are exact');
  assert.equal(matchesTagFilter(tags, parseTagFilter('team=')), true);
  assert.equal(matchesTagFilter(tags, parseTagFilter('missing')), false);
});

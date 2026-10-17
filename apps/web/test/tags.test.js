import test from 'node:test';
import assert from 'node:assert/strict';
import { tagText, tagChipsHtml, tagFilterOptions, matchesTagSpec, tagFilterOptionsHtml, tagDialogModel, tagDialogHtml, tagOperationBody, tagResultText, MAX_CHIPS } from '../tags.js';

// How tags are shown and filtered in the console. Values come from people and from providers, so every one of them must come out as text.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const own = (key, value = '') => ({ key, value, source: 'nuvrion' }), prov = (key, value = '') => ({ key, value, source: 'provider' });
const vm = (id, tags = [], extra = {}) => ({ id, name: `vm-${id}`, providerType: 'vmware_vsphere', tags, ...extra });
const HOSTILE = '"><img src=x onerror=alert(1)>';

test('a tag reads "key: value", or just the key when it has no value', () => {
  assert.equal(tagText(own('env', 'prod')), 'env: prod'); assert.equal(tagText(own('flag')), 'flag');
});

test('chips show the first three, count the rest with their names in the tooltip, mark provider tags, and show nothing for no tags', () => {
  const tags = [own('a', '1'), own('b'), prov('c', '3'), own('d', '4'), own('e', '5')];
  const html = tagChipsHtml(tags, { esc });
  assert.equal((html.match(/class="tag-chip /g) ?? []).length, MAX_CHIPS + 1, 'three tags and the "+2"');
  assert.match(html, /is-more" title="d: 4, e: 5">\+2</);
  assert.match(html, /is-provider" title="c: 3 \(reported by the provider\)"/);
  assert.equal(tagChipsHtml([], { esc }), ''); assert.equal(tagChipsHtml(undefined, { esc }), '');
  assert.ok(!/\+\d/.test(tagChipsHtml([own('a'), own('b'), own('c')], { esc })), 'exactly three needs no "+"');
});

test('hostile keys and values (from a provider or from a person) never become markup in chips, filters or the dialog', () => {
  const resources = [vm('1', [prov(HOSTILE, HOSTILE), own('safe', HOSTILE)], { name: HOSTILE })];
  const pieces = [tagChipsHtml(resources[0].tags, { esc }), tagFilterOptionsHtml(tagFilterOptions(resources), HOSTILE, { esc }), tagDialogHtml(resources, { esc, keysInUse: [HOSTILE] })];
  for (const html of pieces) { assert.ok(!html.includes('<img'), 'no element was created'); assert.ok(!html.includes(HOSTILE), 'only the escaped form appears'); }
});

test('the filter offers each key (any value) and, for keys with a few values, each value, with the number of VMs; empty values and big value sets are not listed', () => {
  const resources = [vm('1', [own('env', 'prod'), own('team', 'core')]), vm('2', [own('env', 'staging'), prov('Env', 'prod')]), vm('3', [own('only', 'x'), own('flag')])];
  const options = Object.fromEntries(tagFilterOptions(resources).map(o => [o.value, o]));
  assert.deepEqual(options.env, { value: 'env', label: 'env (any value)', count: 2 }, 'keys are merged case-insensitively and VMs counted once');
  assert.deepEqual(options['env=prod'], { value: 'env=prod', label: 'env = prod', count: 2 }, 'a provider tag counts');
  assert.equal(options['env=staging'].count, 1);
  assert.equal(options['team=core'].count, 1, 'a key with one value still offers that value');
  assert.ok(options.flag && !options['flag='], 'a tag without a value is offered as a key only');
  const many = Array.from({ length: 13 }, (_, i) => vm(`m${i}`, [own('k', `v${i}`)]));
  assert.deepEqual(tagFilterOptions(many).map(o => o.value), ['k'], 'a key with more than 12 values is offered as the key only');
  assert.deepEqual(tagFilterOptions([]), []);
  const html = tagFilterOptionsHtml(tagFilterOptions(resources), 'env=prod', { esc });
  assert.match(html, /^<option value="">All tags<\/option>/); assert.match(html, /<option value="env=prod" selected>env = prod · 2<\/option>/);
});

test('a filter matches like the server: key for any value, key=value for that value, keys in lower case, values exactly, provider tags included', () => {
  const r = vm('1', [own('Env', 'prod'), prov('Owner', 'Ann'), own('empty')]);
  for (const [spec, expected] of [['env', true], ['ENV', true], ['env=prod', true], ['env=Prod', false], ['owner=Ann', true], ['owner=ann', false], ['empty=', true], ['empty', true], ['missing', false], ['env=staging', false], ['', true], [null, true]]) {
    assert.equal(matchesTagSpec(r, spec), expected, String(spec));
  }
  assert.equal(matchesTagSpec(vm('2'), 'env'), false); assert.equal(matchesTagSpec({ id: 3 }, 'env'), false, 'a resource with no tags field');
});

test('the dialog model counts how many of the selected VMs carry each tag and shows provider tags only for a single VM', () => {
  const selected = [vm('1', [own('env', 'prod'), prov('Owner', 'Ann')]), vm('2', [own('env', 'prod'), own('team', 'core')]), vm('3', [own('env', 'staging')])];
  const model = tagDialogModel(selected);
  assert.deepEqual(model.own, [{ key: 'env', value: 'prod', count: 2 }, { key: 'env', value: 'staging', count: 1 }, { key: 'team', value: 'core', count: 1 }]);
  assert.deepEqual(model.provider, []); assert.equal(model.total, 3);
  assert.deepEqual(tagDialogModel([selected[0]]).provider, [prov('Owner', 'Ann')]);
  assert.deepEqual(tagDialogModel([]), { total: 0, own: [], provider: [] });
});

test('the dialog names what it will change, offers Remove with a name that starts with its visible text, and lists the keys already in use', () => {
  const selected = [vm('1', [own('env', 'prod')]), vm('2', [own('env', 'prod'), own('team', 'core')])];
  const html = tagDialogHtml(selected, { esc, keysInUse: ['env', 'team'] });
  assert.match(html, /<h2 id="tag-title">2 virtual machines<\/h2>/);
  assert.match(html, /env: prod<\/span><small>on all 2<\/small>/); assert.match(html, /team: core<\/span><small>on 1 of 2<\/small>/);
  assert.match(html, /data-tag-remove="env" aria-label="Remove tag env from all 2 virtual machines">Remove</, 'the accessible name starts with the visible word (WCAG 2.5.3)');
  assert.match(html, /Set on 2 virtual machines/); assert.match(html, /<datalist id="tag-keys"><option value="env"><\/option><option value="team"><\/option>/);
  const single = tagDialogHtml([vm('1', [own('env', 'prod'), prov('Name', 'web')], { providerType: 'azure' })], { esc });
  assert.match(single, /<h2 id="tag-title">vm-1<\/h2>/); assert.match(single, /Set on this virtual machine/);
  assert.match(single, /Reported by the provider[\s\S]*These come from Azure and are changed there[\s\S]*Name: web/);
  assert.ok(!/<small>on /.test(single), 'a single VM does not say "on all 1"');
  assert.match(tagDialogHtml([vm('1')], { esc }), /No tags set by Nuvrion yet/);
});

test('a role that can only look sees the tags but no Remove button and no form', () => {
  const html = tagDialogHtml([vm('1', [own('env', 'prod')])], { esc, canEdit: false });
  assert.ok(!html.includes('data-tag-remove') && !html.includes('tag-key') && !html.includes('<form'));
  assert.match(html, /can see tags but not change them/); assert.match(html, /env: prod/);
});

test('the request body carries only what is asked, and the result text says what happened', () => {
  assert.deepEqual(tagOperationBody(['a'], { set: [{ key: 'env', value: 'prod' }] }), { resourceIds: ['a'], set: [{ key: 'env', value: 'prod' }] });
  assert.deepEqual(tagOperationBody(['a', 'b'], { remove: ['env'] }), { resourceIds: ['a', 'b'], remove: ['env'] });
  assert.equal(tagResultText({ count: 3, changedCount: 3 }, { set: [{ key: 'env', value: 'prod' }] }), 'Tag env: prod set on 3 virtual machines.');
  assert.equal(tagResultText({ count: 1, changedCount: 1 }, { set: [{ key: 'flag', value: '' }] }), 'Tag flag set on 1 virtual machine.');
  assert.equal(tagResultText({ count: 2, changedCount: 2 }, { remove: ['env'] }), 'Tag env removed on 2 virtual machines.');
  assert.equal(tagResultText({ count: 2, changedCount: 0 }, { remove: ['env'] }), 'Nothing changed: 2 virtual machines already had it that way.');
});

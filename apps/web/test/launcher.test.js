import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommands, scoreCommand, rankCommands, rememberCommand, moveActive, shellHtml, resultsHtml, statusText, LIMIT, RECENT_MAX } from '../launcher.js';

// The command launcher: what a person may be offered (never more than their permissions allow), how typed letters find it, how the list is moved and written, and that nothing from the
// server is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const ADMIN = ['resource.view', 'resource.operate', 'resource.tag', 'schedule.manage', 'connection.view', 'connection.manage', 'audit.view', 'identity.manage', 'alert.manage', 'platform.manage'];
const AUDITOR = ['resource.view', 'connection.view', 'audit.view'];
const estate = { machines: [{ id: 'm1', name: 'nuvrion-app-01', detail: 'VMware ESXi · running' }, { id: 'm2', name: 'nuvrion-db-01', detail: 'VMware ESXi · stopped' }], objects: [{ id: 'o1', name: 'datastore2', kind: 'datastore', detail: 'Datastore · ESXi 8' }, { id: 'o2', name: 'esx-mock-01.lab.example', kind: 'host', detail: 'Host · ESXi 8' }], views: [{ id: 'v1', name: 'Running web servers', detail: 'running, search “web”' }] };
const ids = list => list.map(command => command.id);
const top = (commands, query) => rankCommands(commands, query)[0]?.id;

test('a person is offered only what their permissions allow: the pages, the dialogs to create things, the machines, the infrastructure and their views', () => {
  const admin = buildCommands({ permissions: ADMIN, ...estate });
  for (const id of ['page:overview', 'page:users', 'page:connections', 'monitor:audit', 'action:new-connection', 'action:new-alert-rule', 'action:new-webhook', 'action:new-schedule', 'action:export', 'action:sign-out', 'view:v1', 'infra:o1', 'vm:m1', 'vm:m2']) assert.ok(ids(admin).includes(id), id);
  const auditor = ids(buildCommands({ permissions: AUDITOR, ...estate }));
  for (const id of ['page:overview', 'page:capacity', 'page:connections', 'monitor:audit', 'action:export', 'action:save-view', 'action:sign-out', 'vm:m1']) assert.ok(auditor.includes(id), id);
  for (const id of ['page:users', 'action:new-connection', 'action:new-alert-rule', 'action:new-webhook', 'action:new-schedule']) assert.equal(auditor.includes(id), false, `${id} is not offered to someone who may not do it`);
  assert.equal(ids(buildCommands({ permissions: ['resource.view'] })).includes('page:connections'), false);
  assert.deepEqual(buildCommands(), buildCommands({ permissions: [] }).slice(0, buildCommands().length));
});

test('every command says where it goes: a page, a tab, a machine, an object, a view or a dialog; none performs an operation on a machine', () => {
  const commands = buildCommands({ permissions: ADMIN, ...estate });
  const kinds = new Set(commands.map(command => command.run.type));
  assert.deepEqual([...kinds].sort(), ['action', 'infrastructure', 'machine', 'monitor', 'view', 'view-apply']);
  assert.deepEqual(commands.find(command => command.id === 'vm:m1').run, { type: 'machine', id: 'm1' });
  assert.deepEqual(commands.find(command => command.id === 'monitor:tasks').run, { type: 'monitor', tab: 'tasks' });
  const actions = commands.filter(command => command.run.type === 'action').map(command => command.run.action);
  assert.deepEqual(actions.sort(), ['export', 'new-alert-rule', 'new-connection', 'new-schedule', 'new-webhook', 'refresh', 'save-view', 'sessions', 'sign-out', 'theme-dark', 'theme-light', 'theme-system']);
  assert.ok(actions.every(action => !/start|stop|power|restart|delete|revoke/.test(action)), 'a power operation or a deletion is never one keystroke away');
  assert.equal(new Set(ids(commands)).size, commands.length, 'identifiers are unique');
});

test('letters find things: the start of a word counts most, every word typed must be found, and part of a name is enough', () => {
  const commands = buildCommands({ permissions: ADMIN, ...estate });
  assert.equal(top(commands, 'over'), 'page:overview');
  assert.equal(top(commands, 'cap'), 'page:capacity');
  assert.equal(top(commands, 'sched'), 'page:schedules');
  assert.equal(top(commands, 'users'), 'page:users');
  assert.equal(top(commands, 'audit'), 'monitor:audit');
  assert.equal(top(commands, 'webhook'), 'action:new-webhook');
  assert.equal(top(commands, 'app-01'), 'vm:m1');
  assert.equal(top(commands, 'db'), 'vm:m2');
  assert.equal(top(commands, 'datastore2'), 'infra:o1');
  assert.equal(top(commands, 'running web'), 'view:v1');
  assert.ok(ids(rankCommands(commands, 'new')).includes('action:new-schedule'));
  assert.deepEqual(ids(rankCommands(commands, 'new alert')).slice(0, 1), ['action:new-alert-rule']);
  assert.equal(top(commands, 'ALERT RULES'), 'page:alert-rules', 'case does not matter');
  assert.equal(top(commands, 'forecast'), 'page:capacity', 'a word in the keywords finds the page');
});

test('a few letters in order find a name when no word starts with them; words that match nothing find nothing; nothing typed finds nothing to score', () => {
  const commands = buildCommands({ permissions: ADMIN, ...estate });
  assert.equal(top(commands, 'nvdb'), 'vm:m2', 'n, v, d, b in order within nuvrion-db-01');
  assert.deepEqual(rankCommands(commands, 'zzzqqq'), []);
  assert.deepEqual(rankCommands(commands, 'overview zzzqqq'), [], 'every word must be found');
  assert.equal(scoreCommand('', commands[0]) > 0, true);
  assert.equal(scoreCommand('xyz', { title: 'Overview', detail: '', keywords: '' }), 0);
  assert.ok(scoreCommand('sch', { title: 'Schedules', detail: '', keywords: '' }) > scoreCommand('sch', { title: 'Alert rules', detail: '', keywords: 'schedule' }));
  assert.ok(scoreCommand('over', { title: 'Overview', detail: '', keywords: '' }) > scoreCommand('over', { title: 'Hovercraft', detail: '', keywords: '' }), 'the start of a word beats the middle of one');
});

test('results are limited, best first, and with the same score the pages come before machines', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `web-${String(i).padStart(2, '0')}`, detail: '' }));
  const commands = buildCommands({ permissions: ADMIN, machines: many });
  assert.equal(rankCommands(commands, 'web').length, LIMIT);
  assert.equal(rankCommands(commands, 'web-0').length, LIMIT);
  assert.deepEqual(rankCommands(commands, 'web-39').map(command => command.id), ['vm:m39']);
  assert.equal(rankCommands(commands, 'web', { limit: 3 }).length, 3);
  const tie = [{ id: 'b', group: 'Virtual machines', title: 'x one', detail: '', keywords: '', run: {} }, { id: 'a', group: 'Go to', title: 'x two', detail: '', keywords: '', run: {} }];
  assert.deepEqual(ids(rankCommands(tie, 'x')), ['a', 'b']);
});

test('with nothing typed the box shows what was used lately, then the pages', () => {
  const commands = buildCommands({ permissions: ADMIN, ...estate });
  const none = rankCommands(commands, '', { recent: [] });
  assert.ok(none.every(command => command.group === 'Go to')); assert.equal(none[0].id, 'page:overview'); assert.equal(none.length, LIMIT);
  const lately = rankCommands(commands, '   ', { recent: ['vm:m2', 'action:export', 'page:users', 'gone:forever'] });
  assert.deepEqual(ids(lately).slice(0, 3), ['vm:m2', 'action:export', 'page:users']); assert.ok(lately.slice(0, 3).every(command => command.recent));
  assert.equal(ids(lately).filter(id => id === 'page:users').length, 1, 'once');
  assert.ok(!ids(lately).includes('gone:forever'), 'something that no longer exists is dropped');
  assert.deepEqual(rankCommands([], ''), []);
});

test('the recent list keeps the newest first, once each, and no more than five', () => {
  let recent = [];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) recent = rememberCommand(recent, id);
  assert.deepEqual(recent, ['f', 'e', 'd', 'c', 'b']); assert.equal(recent.length, RECENT_MAX);
  assert.deepEqual(rememberCommand(recent, 'c'), ['c', 'f', 'e', 'd', 'b']);
});

test('the arrow keys move through the options and wrap round; Home and End go to the ends; an empty list has no position', () => {
  assert.deepEqual([moveActive(-1, 3, 'ArrowDown'), moveActive(0, 3, 'ArrowDown'), moveActive(2, 3, 'ArrowDown'), moveActive(0, 3, 'ArrowUp'), moveActive(2, 3, 'ArrowUp'), moveActive(-1, 3, 'ArrowUp')], [0, 1, 0, 2, 1, 2]);
  assert.deepEqual([moveActive(1, 5, 'Home'), moveActive(1, 5, 'End'), moveActive(1, 5, 'x'), moveActive(0, 0, 'ArrowDown')], [0, 4, 1, -1]);
});

test('the box is a combobox with a listbox of options, one of them active, and a status for assistive technology', () => {
  const shell = shellHtml({ hint: 'Ctrl+K opens this box' });
  assert.match(shell, /role="combobox"[^>]*aria-controls="launcher-list"[^>]*aria-autocomplete="list"/); assert.match(shell, /<ul id="launcher-list" class="launcher-list" role="listbox"/); assert.match(shell, /role="status" aria-live="polite"/); assert.match(shell, /<label class="sr-only" for="launcher-input">/);
  const html = resultsHtml([{ title: 'Overview', detail: '', group: 'Go to' }, { title: 'nuvrion-app-01', detail: 'VMware ESXi · running', group: 'Virtual machines', recent: true }], 1, { esc });
  assert.match(html, /id="launcher-option-0" class="launcher-option" role="option" aria-selected="false"/); assert.match(html, /id="launcher-option-1" class="launcher-option is-active" role="option" aria-selected="true"/);
  assert.match(html, /<span class="launcher-group">Go to<\/span>/); assert.match(html, /<span class="launcher-group">Recent<\/span>/); assert.match(html, /<small class="launcher-detail">VMware ESXi · running<\/small>/);
  assert.match(resultsHtml([], -1, { esc }), /Nothing matches/);
  assert.deepEqual([statusText([], 'x'), statusText([{}], 'x'), statusText([{}, {}], ''), statusText([{}, {}], 'ab')], ['No results.', '1 result. Use the arrow keys and Enter.', '2 results, recent and pages. Use the arrow keys and Enter.', '2 results. Use the arrow keys and Enter.']);
});

test('nothing from the server is put in the box unescaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(resultsHtml([{ title: evil, detail: evil, group: evil }], 0, { esc }), /<img/);
});

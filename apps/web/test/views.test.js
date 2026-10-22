import test from 'node:test';
import assert from 'node:assert/strict';
import { currentView, applyView, sameView, describeView, viewsMenuHtml, viewsButtonLabel, saveViewDialogHtml, viewProblem, csvCell, toCsv, exportFileName, exportRow, EXPORT_COLUMNS } from '../views.js';

// Saved views and the CSV export: that the filters of the list become a view and back, when a view counts as changed, what the menu and the dialog say, and that a file opens in a
// spreadsheet as data and never as a formula.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const platformLabel = key => ({ vmware_esxi: 'VMware ESXi' })[key] ?? key;
const saved = (over = {}) => ({ id: 'v1', name: 'Running web', rowVersion: 1, view: { search: 'web', platform: 'vmware_esxi', power: 'running', health: null, tag: null, sortKey: 'memory', sortDirection: 'desc' }, ...over });

test('the filters of the list become a view, and a view becomes the filters of the list', () => {
  const view = currentView({ search: '  web ', platform: 'vmware_esxi', drill: { power: 'running', health: null, tag: 'env=prod' }, sort: { key: 'memory', direction: 'desc' } });
  assert.deepEqual(view, { search: 'web', platform: 'vmware_esxi', power: 'running', health: null, tag: 'env=prod', sortKey: 'memory', sortDirection: 'desc' });
  assert.deepEqual(applyView(view), { search: 'web', platform: 'vmware_esxi', drill: { power: 'running', health: null, tag: 'env=prod' }, sort: { key: 'memory', direction: 'desc' } });
  assert.deepEqual(currentView(), { search: '', platform: '', power: null, health: null, tag: null, sortKey: null, sortDirection: 'asc' });
  assert.deepEqual(applyView(currentView()), { search: '', platform: '', drill: null, sort: null }, 'nothing set means nothing to restore');
  assert.equal(currentView({ sort: { key: 'name', direction: 'sideways' } }).sortDirection, 'asc');
});

test('a view counts as changed when the list is filtered or sorted differently, and a sort direction means nothing without a column', () => {
  const base = saved().view;
  assert.equal(sameView(base, { ...base }), true);
  assert.equal(sameView(base, { ...base, search: ' WEB ' }), true, 'search is compared without case or edge spaces');
  for (const change of [{ search: 'db' }, { platform: '' }, { power: 'stopped' }, { health: 'healthy' }, { tag: 'env' }, { sortKey: 'name' }, { sortDirection: 'asc' }]) assert.equal(sameView(base, { ...base, ...change }), false, JSON.stringify(change));
  assert.equal(sameView({ ...base, sortKey: null, sortDirection: 'desc' }, { ...base, sortKey: null, sortDirection: 'asc' }), true);
});

test('a view is described in words', () => {
  assert.equal(describeView(saved().view, { platformLabel }), 'running, VMware ESXi, search “web”, sorted by memory (descending)');
  assert.equal(describeView(currentView()), 'everything, unsorted');
});

test('the Views menu lists the views with what each filters, marks the one in use, and offers to save, update, rename and delete it', () => {
  const current = saved().view;
  const html = viewsMenuHtml([saved(), saved({ id: 'v2', name: 'Stopped', view: { ...current, power: 'stopped' } })], { active: saved(), current, full: false }, { esc, platformLabel });
  assert.match(html, /data-view-apply="v1" aria-current="true"><strong>Running web<\/strong><small>running, VMware ESXi, search “web”/); assert.match(html, /data-view-apply="v2"><strong>Stopped<\/strong>/);
  assert.match(html, /data-view-save>Save current view…/); assert.match(html, /data-view-update="v1" disabled>Update “Running web” to the current filters/, 'nothing to update while the list matches the view');
  assert.match(html, /data-view-rename="v1">Rename/); assert.match(html, /data-view-delete="v1">Delete/);
  const changed = viewsMenuHtml([saved()], { active: saved(), current: { ...current, power: 'stopped' }, full: false }, { esc, platformLabel });
  assert.doesNotMatch(changed, /data-view-update="v1" disabled/); assert.match(changed, /Running web \(changed\)/);
  const empty = viewsMenuHtml([], { active: null, current, full: false }, { esc, platformLabel });
  assert.match(empty, /No saved views yet/); assert.doesNotMatch(empty, /data-view-update|data-view-rename|data-view-delete/);
  assert.match(viewsMenuHtml(Array.from({ length: 20 }, (_, i) => saved({ id: `v${i}`, name: `V${i}` })), { active: null, current, full: true }, { esc, platformLabel }), /You keep 20 views[\s\S]*data-view-save disabled/);
});

test('the button says which view is in use and whether the list has moved away from it', () => {
  const current = saved().view;
  assert.deepEqual([viewsButtonLabel(null, current), viewsButtonLabel(saved(), current), viewsButtonLabel(saved(), { ...current, search: 'x' })], ['Views', 'Views: Running web', 'Views: Running web (changed)']);
});

test('the dialog for saving a view says what will be saved; renaming asks only for the name; an empty name is refused before any request', () => {
  const html = saveViewDialogHtml({ mode: 'new', description: 'running, VMware ESXi' }, { esc });
  assert.match(html, /Save current view/); assert.match(html, /<strong>running, VMware ESXi<\/strong>/); assert.match(html, /Save view/);
  const rename = saveViewDialogHtml({ mode: 'rename', name: 'Old' }, { esc });
  assert.match(rename, /Rename view/); assert.match(rename, /value="Old"/); assert.doesNotMatch(rename, /will remember|A saved view remembers/);
  assert.match(saveViewDialogHtml({ mode: 'new', description: 'x', error: 'Nope' }, { esc }), /role="alert">Nope</);
  assert.deepEqual([viewProblem(''), viewProblem('   '), viewProblem('x'.repeat(61)), viewProblem('Fine')], ['Give the view a name.', 'Give the view a name.', 'The name may have at most 60 characters.', null]);
});

test('a CSV cell is quoted when it must be, and a text a spreadsheet would run as a formula is shown as text', () => {
  assert.deepEqual(['plain', 'a,b', 'say "hi"', 'two\nlines', ' padded ', '', null, undefined, 5, 0, 1.5, NaN].map(csvCell), ['plain', '"a,b"', '"say ""hi"""', '"two\nlines"', '" padded "', '', '', '', '5', '0', '1.5', '']);
  for (const formula of ['=SUM(A1:A9)', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) assert.ok(csvCell(formula).replace(/^"/, '').startsWith("'"), JSON.stringify(formula));
  assert.equal(csvCell('=HYPERLINK("http://evil","click")'), `"'=HYPERLINK(""http://evil"",""click"")"`, 'the formula is neutralised and still quoted');
  assert.equal(csvCell(-5), '-5', 'a real negative number is a number, not a formula');
  assert.equal(csvCell('vm-01'), 'vm-01'); assert.equal(csvCell('a=b'), 'a=b', 'only a leading sign starts a formula');
});

test('the file has a byte-order mark, a header, CRLF between lines, and the rows as given', () => {
  const csv = toCsv([['web-01', 'VMware ESXi', 'a,b'], ['=cmd', 'x', 'y']], ['Name', 'Platform', 'Note']);
  assert.equal(csv, "﻿Name,Platform,Note\r\nweb-01,VMware ESXi,\"a,b\"\r\n'=cmd,x,y\r\n");
  assert.equal(toCsv([]), `﻿${EXPORT_COLUMNS.join(',')}\r\n`, 'an empty list is the header alone');
  assert.equal(EXPORT_COLUMNS.length, 18);
});

test('the file name says what and when', () => {
  assert.equal(exportFileName(new Date(2026, 9, 23, 9, 5)), 'nuvrion-inventory-20261023-0905.csv');
});

test('a virtual machine becomes a row in the order of the columns, with units, placement and tags written out', () => {
  const resource = { name: 'web-01', lastSeenAt: '2026-10-23T09:00:00Z', attributes: { guestOs: 'Ubuntu 22.04', privateIps: ['10.0.0.9'], publicIps: ['8.8.8.8'] }, tags: [{ key: 'env', value: 'prod' }, { key: 'pci', value: '' }] };
  const row = exportRow(resource, { platform: 'VMware ESXi', connection: 'ESXi 8', power: 'running', health: 'Normal', hostname: 'web-01.lab', metric: { cpuUsageMhz: 1200, cpuUtilizationPercent: 12.34, memoryUsedBytes: 4 * 1024 ** 3, memoryUtilizationPercent: 50.06 }, storageBytes: 40 * 1024 ** 3,
    placement: [{ label: 'Host', objects: [{ name: 'esx-1' }] }, { label: 'Datastores', objects: [{ name: 'ds1' }, { name: 'ds2' }] }, { label: 'Networks', objects: [{ name: 'VLAN 10' }] }] });
  assert.equal(row.length, EXPORT_COLUMNS.length);
  assert.deepEqual(row, ['web-01', 'VMware ESXi', 'ESXi 8', 'running', 'Normal', 'Ubuntu 22.04', 'web-01.lab', '10.0.0.9', 1200, 12.3, 4, 50.1, 40, 'esx-1', 'ds1; ds2', 'VLAN 10', 'env=prod; pci', '2026-10-23T09:00:00Z']);
  const bare = exportRow({ name: 'x', attributes: {} }, {});
  assert.deepEqual(bare.slice(2, 17), ['', '', '', '', '', '', null, null, null, null, null, '', '', '', ''], 'what is not reported is left empty, not written as zero');
});

test('nothing from the server is put in the menu or the dialog unescaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = viewsMenuHtml([saved({ name: evil, view: { ...saved().view, search: evil, tag: evil } })], { active: saved({ name: evil }), current: saved().view, full: false }, { esc, platformLabel }) + saveViewDialogHtml({ mode: 'new', name: evil, description: evil, error: evil }, { esc });
  assert.doesNotMatch(html, /<img/);
});

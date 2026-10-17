import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFactHtml, buildIndex, treeHtml, detailHtml, placementRows, placementRowsHtml, placementSearchText, vmsOn, vmCountUnder, formatBytes } from '../infrastructure.js';

// The Infrastructure page joins what providers report (hosts, datastores, networks) to the placement each VM reports, by identifier within one connection. It must never
// pair objects of different connections that happen to share a native id, must say when what it shows is stale, and must turn every provider-supplied name into text.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const ctx = { esc, when: value => `at ${value}`, powerOf: vm => vm.attributes?.powerState ?? 'unknown', labelOf: connection => `label of ${connection.providerType}` };

let counter = 0;
const object = (connectionId, kind, nativeId, name, parentNativeId = null, attributes = {}, extra = {}) => ({ id: `obj-${++counter}`, connectionId, kind, nativeId, name, parentNativeId, attributes, lifecycleState: 'active', lastSeenAt: '2026-10-17T10:00:00Z', ...extra });
const vm = (id, connectionId, placement, name = `vm ${id}`) => ({ id, connectionId, name, attributes: { powerState: 'running' }, providerMetadata: placement ? { placement } : {} });
const connection = (id, name, extra = {}) => ({ id, name, providerType: 'vmware_vsphere', status: 'active', healthState: 'healthy', ...extra });

function fixture() {
  const objects = [
    object('c1', 'datacenter', 'dc', 'DC One'),
    object('c1', 'cluster', 'cl', 'Cluster A', 'dc'),
    object('c1', 'host', 'h1', 'esx-01', 'cl', { connectionState: 'connected', cpuMhz: 20000, cpuUsageMhz: 5000, memoryBytes: 2 ** 36, memoryUsageBytes: 2 ** 35 }),
    object('c1', 'host', 'h2', 'esx-02', 'cl', { connectionState: 'disconnected' }),
    object('c1', 'datastore', 'ds1', 'datastore1', 'dc', { type: 'VMFS', capacityBytes: 1000, freeBytes: 250 }),
    object('c1', 'network', 'n1', 'VLAN 10', 'dc', { type: 'standard' }),
    // the same native ids on another connection: must never be mixed up with the first
    object('c2', 'host', 'h1', 'other-host'),
    object('c2', 'datastore', 'ds1', 'other-datastore')
  ];
  const resources = [
    vm('v1', 'c1', { hostNativeId: 'h1', datastoreNativeIds: ['ds1'], networkNativeIds: ['n1'] }),
    vm('v2', 'c1', { hostNativeId: 'h1', datastoreNativeIds: ['ds1'], networkNativeIds: [] }),
    vm('v3', 'c2', { hostNativeId: 'h1', datastoreNativeIds: ['ds1'] }),
    vm('v4', 'c1', null)
  ];
  return { objects, resources, connections: [connection('c1', 'vCenter'), connection('c2', 'ESXi lab'), connection('c3', 'Azure prod', { providerType: 'azure' })] };
}

test('placement is joined within one connection: the same native id on two connections is two different objects', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  const h1 = objects.find(o => o.connectionId === 'c1' && o.nativeId === 'h1'), other = objects.find(o => o.connectionId === 'c2' && o.nativeId === 'h1');
  assert.deepEqual(vmsOn(index, h1).map(v => v.id), ['v1', 'v2']);
  assert.deepEqual(vmsOn(index, other).map(v => v.id), ['v3']);
  assert.deepEqual(vmsOn(index, objects.find(o => o.nativeId === 'ds1' && o.connectionId === 'c1')).map(v => v.id), ['v1', 'v2']);
});

test('VMs under a cluster or datacenter are counted once, through their hosts', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  assert.equal(vmCountUnder(index, objects[1]), 2);
  assert.equal(vmCountUnder(index, objects[0]), 2, 'a datacenter counts the VMs on the hosts below it');
  assert.equal(vmCountUnder(index, objects[3]), 0);
});

test('the tree groups hosts under their cluster, datastores and networks under the datacenter, and names connections that report nothing', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections), html = treeHtml(index, null, ctx);
  for (const text of ['DC One', 'Cluster A', 'esx-01', 'esx-02', 'datastore1', 'VLAN 10', 'vCenter', 'ESXi lab']) assert.ok(html.includes(text), text);
  assert.match(html, /Datastores · 1/);
  assert.match(html, /Not reported by this kind of connection: Azure prod/);
  assert.ok(html.indexOf('DC One') < html.indexOf('Cluster A') && html.indexOf('Cluster A') < html.indexOf('esx-01'));
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 0);
  assert.equal((treeHtml(index, objects[2].id, ctx).match(/aria-current="true"/g) ?? []).length, 1);
});

test('an empty estate says so instead of drawing an empty tree', () => {
  const html = treeHtml(buildIndex([], [], [connection('c1', 'vCenter')]), null, ctx);
  assert.match(html, /No infrastructure reported yet/);
  assert.doesNotMatch(html, /infra-tree/);
});

test('objects a deleted connection left behind are not shown', () => {
  const { objects, resources, connections } = fixture();
  const index = buildIndex(objects.map(o => (o.connectionId === 'c2' ? { ...o, lifecycleState: 'deleted' } : o)), resources, connections);
  assert.equal(index.objects.length, 6);
  assert.doesNotMatch(treeHtml(index, null, ctx), /other-host/);
});

test('a host shows its usage, its VMs and the datastores and networks they use', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  const html = detailHtml(index, objects[2].id, ctx);
  assert.match(html, /esx-01/);
  assert.match(html, /CPU[\s\S]*25%/);
  assert.match(html, /Memory[\s\S]*50%/);
  assert.match(html, /Virtual machines · 2/);
  assert.match(html, /vm v1/);
  assert.match(html, /Datastores used[\s\S]*datastore1/);
  assert.match(html, /Networks used[\s\S]*VLAN 10/);
  assert.doesNotMatch(html, /other-datastore/, 'a datastore of another connection is never listed');
});

test('a datastore shows used space; one with no capacity reported shows no bar', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  assert.match(detailHtml(index, objects[4].id, ctx), /Space used[\s\S]*75%/);
  const bare = buildIndex([object('c1', 'datastore', 'x', 'bare')], [], connections);
  assert.doesNotMatch(detailHtml(bare, bare.objects[0].id, ctx), /usage-bar/);
});

test('usage is clamped to 0–100% so a provider’s odd numbers cannot draw a bar outside its box', () => {
  const over = buildIndex([object('c1', 'host', 'h', 'h', null, { cpuMhz: 100, cpuUsageMhz: 900 })], [], [connection('c1', 'vC')]);
  assert.match(detailHtml(over, over.objects[0].id, ctx), /width:100%/);
});

test('what is shown says when it is stale: an unreachable connection or an object the provider no longer reports', () => {
  const { objects, resources, connections } = fixture();
  const down = buildIndex(objects, resources, connections.map(c => (c.id === 'c1' ? { ...c, healthState: 'critical' } : c)));
  assert.match(detailHtml(down, objects[2].id, ctx), /cannot be reached; this is what was last seen/);
  assert.match(treeHtml(down, null, ctx), /unreachable · last known/);
  const gone = buildIndex(objects.map(o => (o.id === objects[2].id ? { ...o, lifecycleState: 'missing' } : o)), resources, connections);
  assert.match(detailHtml(gone, objects[2].id, ctx), /no longer reports this host/);
  assert.match(treeHtml(gone, null, ctx), /missing/);
});

test('a selection that no longer exists says so', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  assert.match(detailHtml(index, 'obj-gone', ctx), /no longer reported/);
  assert.match(detailHtml(index, 'connection:nope', ctx), /no longer there/);
  assert.match(detailHtml(index, null, ctx), /Select something in the tree/);
});

test('a connection shows how many of each kind it reports', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  const html = detailHtml(index, 'connection:c1', ctx);
  assert.match(html, /Hosts<\/dt><dd>2/);
  assert.match(html, /Datastores<\/dt><dd>1/);
});

test('a VM’s detail names its host, datastores and networks, and nothing when the provider said nothing', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  const rows = placementRows(resources[0], index);
  assert.deepEqual(rows.map(r => [r.label, r.objects.map(o => o.name)]), [['Host', ['esx-01']], ['Datastores', ['datastore1']], ['Networks', ['VLAN 10']]]);
  assert.deepEqual(placementRows(resources[3], index), []);
  assert.equal(placementRowsHtml(resources[3], index, { esc }), '');
  const html = placementRowsHtml(resources[0], index, { esc });
  assert.ok(html.includes(`<dt>Host</dt><dd><button type="button" class="text-button" data-infra-open="${objects[2].id}">esx-01</button>`));
  assert.deepEqual(placementRows(resources[1], index).map(r => r.label), ['Host', 'Datastores'], 'a VM with no network reported has no Networks row');
});

test('the inventory search finds a VM by its host, datastore or network name', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  assert.match(placementSearchText(resources[0], index).toLowerCase(), /esx-01.*datastore1.*vlan 10/);
  assert.equal(placementSearchText(resources[3], index), '');
  assert.doesNotMatch(placementSearchText(resources[2], index), /esx-01/, 'the host of another connection is not this VM’s host');
});

test('names that came from a provider are escaped everywhere', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const objects = [object('c1', 'datacenter', 'dc', evil), object('c1', 'host', 'h', evil, 'dc', { product: evil }), object('c1', 'datastore', 'd', evil, 'dc', { url: evil })];
  const resources = [vm('v', 'c1', { hostNativeId: 'h', datastoreNativeIds: ['d'] }, evil)];
  const index = buildIndex(objects, resources, [connection('c1', evil)]);
  for (const html of [treeHtml(index, null, ctx), detailHtml(index, objects[1].id, ctx), detailHtml(index, objects[2].id, ctx), detailHtml(index, 'connection:c1', ctx), placementRowsHtml(resources[0], index, { esc })]) {
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  }
});

test('sizes are written in the unit a person would use', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2 ** 40), '1 TB');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(NaN), '—');
});

test('the one-line host fact names the host, and is empty when the provider said nothing', () => {
  const { objects, resources, connections } = fixture(), index = buildIndex(objects, resources, connections);
  assert.ok(hostFactHtml(resources[0], index, { esc }).includes(`data-infra-open="${objects[2].id}">esx-01</button>`));
  assert.equal(hostFactHtml(resources[3], index, { esc }), '');
});

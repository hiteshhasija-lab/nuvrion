import test from 'node:test';
import assert from 'node:assert/strict';
import { powerGroup, healthGroup, summarizeEstate, recentAlerts, matchesDrill, drillIsEmpty, estateHealthHtml, providerOverviewHtml, recentAlertsHtml, drillChipsHtml, POWER_GROUPS, HEALTH_GROUPS } from '../dashboard.js';

// The Overview's counts and the lists they open are made from the same grouping, so they cannot disagree; the HTML says only what the numbers say and turns anything
// that came from a provider into text.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const vm = (id, { power = 'running', health = 'healthy', type = 'vmware_vsphere', connectionId = 'c1', unreachable = false } = {}) => ({ id, providerType: type, connectionId, healthState: health, attributes: { powerState: power }, unreachable });
const context = (extra = {}) => ({
  platformKey: r => (r.providerType === 'vmware_vsphere' ? (r.connectionId === 'esxi' ? 'vmware_esxi' : 'vmware_vcenter') : r.providerType),
  displayPower: r => (r.unreachable ? 'unreachable' : r.attributes.powerState), isUnreachable: r => r.unreachable, ...extra
});

test('power states collapse into six groups; any state in transition is "changing", anything unrecognised is "unknown"', () => {
  assert.deepEqual(['running', 'stopped', 'suspended', 'unreachable'].map(powerGroup), ['running', 'stopped', 'suspended', 'unreachable']);
  for (const state of ['rebooting', 'shutdown-pending', 'poweroff-override', 'powering-off', 'powering-on', 'suspending']) assert.equal(powerGroup(state), 'changing', state);
  for (const state of [undefined, null, '', 'paused-by-aliens']) assert.equal(powerGroup(state), 'unknown');
});

test('a VM is healthy only when its provider says so and can be reached; "unknown" is not "needs attention"', () => {
  assert.equal(healthGroup({ healthState: 'healthy' }), 'healthy');
  assert.equal(healthGroup({ healthState: 'healthy' }, true), 'unknown', 'an unreachable connection’s last report is not good news');
  for (const state of ['warning', 'critical', 'degraded', 'unhealthy']) assert.equal(healthGroup({ healthState: state }), 'attention', state);
  for (const state of [undefined, null, 'unknown']) assert.equal(healthGroup({ healthState: state }), 'unknown');
});

test('the estate is counted by power, by health and by platform; ESXi and vCenter are separate platforms; every group adds up to the total', () => {
  const resources = [vm('a'), vm('b', { power: 'stopped' }), vm('c', { health: 'critical' }), vm('d', { connectionId: 'esxi' }), vm('e', { type: 'vmware_workstation', unreachable: true }), vm('f', { power: 'powering-on' })];
  const summary = summarizeEstate(resources, context({ connections: [
    { id: 'c1', providerType: 'vmware_vsphere', healthState: 'healthy', lastSuccessAt: '2026-10-17T01:00:00Z' },
    { id: 'esxi', providerType: 'vmware_vsphere', healthState: 'critical', lastSuccessAt: '2026-10-16T01:00:00Z' },
    { id: 'w', providerType: 'vmware_workstation', healthState: 'critical' },
    { id: 'gone', providerType: 'aws', healthState: 'healthy', status: 'deleted' }] }));
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.power, { running: 3, stopped: 1, suspended: 0, changing: 1, unreachable: 1, unknown: 0 });
  assert.deepEqual(summary.health, { healthy: 4, attention: 1, unknown: 1 });
  assert.equal(Object.values(summary.power).reduce((a, b) => a + b), 6); assert.equal(Object.values(summary.health).reduce((a, b) => a + b), 6);
  const byKey = Object.fromEntries(summary.platforms.map(p => [p.key, p]));
  assert.deepEqual(Object.keys(byKey).sort(), ['vmware_esxi', 'vmware_vcenter', 'vmware_workstation'], 'a deleted connection adds no platform');
  assert.deepEqual([byKey.vmware_vcenter.vmCount, byKey.vmware_vcenter.running, byKey.vmware_vcenter.attention], [4, 2, 1]);
  assert.deepEqual(byKey.vmware_esxi.connections, { total: 1, healthy: 0, down: 1, other: 0 });
  assert.equal(byKey.vmware_workstation.unreachable, 1);
  assert.equal(byKey.vmware_vcenter.lastSyncAt, '2026-10-17T01:00:00Z');
  assert.deepEqual(summary.platforms.map(p => p.key), ['vmware_vcenter', 'vmware_esxi', 'vmware_workstation'], 'largest first, then by name');
});

test('a provider with a connection and no VMs yet still appears; an empty estate is an empty summary', () => {
  const summary = summarizeEstate([], context({ connections: [{ id: 'x', providerType: 'aws', healthState: 'healthy' }] }));
  assert.equal(summary.total, 0); assert.deepEqual(summary.platforms.map(p => [p.key, p.vmCount, p.connections.total]), [['aws', 0, 1]]);
  assert.equal(summarizeEstate([], context()).platforms.length, 0);
});

test('recent alerts: open ones first (critical before warning), then recovered ones, newest first within each, limited', () => {
  const a = (id, severity, status, lastSeenAt) => ({ id, severity, status, lastSeenAt });
  const ordered = recentAlerts([a('rec-new', 'critical', 'recovered', '2026-10-17T05:00Z'), a('warn-new', 'warning', 'active', '2026-10-17T04:00Z'), a('crit-old', 'critical', 'active', '2026-10-16T01:00Z'),
    a('crit-new', 'critical', 'acknowledged', '2026-10-17T03:00Z'), a('rec-old', 'warning', 'recovered', '2026-10-15T00:00Z')], 4).map(x => x.id);
  assert.deepEqual(ordered, ['crit-new', 'crit-old', 'warn-new', 'rec-new']);
  assert.deepEqual(recentAlerts([], 5), []);
  assert.equal(recentAlerts(Array.from({ length: 20 }, (_, i) => a(i, 'warning', 'recovered', `2026-10-${10 + (i % 9)}T00:00Z`))).length, 5);
});

test('the drill-down filter keeps exactly the VMs the Overview counted under that power or health group', () => {
  const resources = [vm('a'), vm('b', { power: 'stopped' }), vm('c', { health: 'critical' }), vm('d', { unreachable: true }), vm('e', { power: 'rebooting' })];
  const ctx = context(), summary = summarizeEstate(resources, ctx);
  for (const group of POWER_GROUPS) assert.equal(resources.filter(r => matchesDrill(r, { power: group.key }, ctx)).length, summary.power[group.key], `power ${group.key}`);
  for (const group of HEALTH_GROUPS) assert.equal(resources.filter(r => matchesDrill(r, { health: group.key }, ctx)).length, summary.health[group.key], `health ${group.key}`);
  assert.deepEqual(resources.filter(r => matchesDrill(r, { power: 'running', health: 'attention' }, ctx)).map(r => r.id), ['c'], 'both together narrow it');
  assert.equal(resources.filter(r => matchesDrill(r, null, ctx)).length, 5); assert.equal(resources.filter(r => matchesDrill(r, {}, ctx)).length, 5);
  assert.deepEqual([drillIsEmpty(null), drillIsEmpty({}), drillIsEmpty({ power: 'running' })], [true, true, false]);
});

test('the estate breakdown: one button per non-empty group with its count in the name, no button for an empty group, bar widths add up to 100', () => {
  const summary = summarizeEstate([vm('a'), vm('b'), vm('c', { power: 'stopped' })], context());
  const html = estateHealthHtml(summary, { esc });
  assert.match(html, /data-drill-power="running"[^>]*>(?:(?!<\/button>).)*Running(?:(?!<\/button>).)*<strong>2<\/strong><span class="sr-only"> virtual machines\. Show them in the inventory\.<\/span>/s, 'the name reads "Running 2 virtual machines. Show them…", with the count once');
  assert.match(html, /data-drill-power="stopped"[^>]*>(?:(?!<\/button>).)*<strong>1<\/strong><span class="sr-only"> virtual machine\. Show them/s);
  assert.ok(!/<button[^>]*breakdown-row[^>]*aria-label/.test(html), 'a button is named by its visible text, not by an aria-label that rewords it (WCAG 2.5.3)');
  assert.ok(!html.includes('data-drill-power="suspended"'), 'an empty group is not a button');
  assert.match(html, /breakdown-zero[^>]*>.*Suspended.*<strong>0<\/strong>/s);
  const widths = [...html.matchAll(/style="width:([\d.]+)%"/g)].map(m => Number(m[1]));
  assert.ok(Math.abs(widths.slice(0, 2).reduce((a, b) => a + b) - 100) < 0.05, 'power bar');
  assert.match(estateHealthHtml(summarizeEstate([], context()), { esc }), /No inventory yet/);
});

test('the provider cards name the platform, count VMs and connections, and open the inventory on that platform', () => {
  const summary = summarizeEstate([vm('a'), vm('b', { connectionId: 'esxi', unreachable: true })], context({ connections: [
    { id: 'c1', providerType: 'vmware_vsphere', healthState: 'healthy', lastSuccessAt: '2026-10-17T01:00:00Z' }, { id: 'esxi', providerType: 'vmware_vsphere', healthState: 'critical' }] }));
  const html = providerOverviewHtml(summary, { esc, labelOf: key => ({ vmware_vcenter: 'VMware vSphere / vCenter', vmware_esxi: 'VMware ESXi' })[key] ?? key, when: v => `at ${v}` });
  assert.match(html, /data-drill-platform="vmware_vcenter"/); assert.match(html, /data-drill-platform="vmware_esxi"/);
  assert.ok(!/<button[^>]*provider-card[^>]*aria-label/.test(html), 'named by its visible text'); assert.match(html, /<span class="sr-only">Show them in the inventory\.<\/span>/);
  assert.match(html, /1 connection healthy/); assert.match(html, /1 of 1 connection unreachable/); assert.match(html, /1 unreachable/);
  assert.match(html, /Last sync at 2026-10-17T01:00:00Z/); assert.match(html, /Not synced yet/);
  assert.match(providerOverviewHtml(summarizeEstate([], context()), { esc, labelOf: x => x, when: x => x }), /No providers connected/);
});

test('the alert list shows severity, connection, a plain reason and status, links to the alert history, and never lets a name become markup', () => {
  const HOSTILE = '"><img src=x onerror=alert(1)>';
  const badge = value => `<span class="badge">${esc(value)}</span>`;
  const html = recentAlertsHtml([{ severity: 'critical', status: 'active', errorCode: HOSTILE, occurrenceCount: 3, lastSeenAt: '2026-10-17T00:00Z', connectionId: 'x' }],
    { esc, when: v => `at ${v}`, badge, reasonOf: code => `reason ${code}`, connectionNameOf: () => HOSTILE });
  assert.ok(!html.includes('<img') && !html.includes(HOSTILE), 'escaped');
  assert.ok(html.includes(esc(HOSTILE)));
  assert.match(html, /data-drill-alerts="true"/); assert.match(html, /seen 3 times/); assert.match(html, /is-open/);
  assert.ok(!/aria-label/.test(html), 'named by its visible text'); assert.match(html, /<span class="sr-only">Open the alert history\.<\/span>/);
  assert.match(recentAlertsHtml([], { esc, when: x => x, badge, reasonOf: x => x, connectionNameOf: x => x }), /No alerts/);
  assert.ok(!recentAlertsHtml([{ severity: 'warning', status: 'recovered', errorCode: 'X', occurrenceCount: 1 }], { esc, when: x => x, badge, reasonOf: x => x, connectionNameOf: () => 'n' }).includes('is-open'), 'a recovered alert is not styled as open');
});

test('the filter chips say what is applied, each can be removed, and nothing is shown when nothing is filtered', () => {
  const html = drillChipsHtml({ power: 'running', health: 'attention' }, { esc });
  assert.match(html, /Power: Running/); assert.match(html, /Health: Needs attention/);
  assert.match(html, /aria-label="Remove filter Power: Running"><span aria-hidden="true">✕<\/span>/);
  assert.match(html, /data-clear-drill="power"/); assert.match(html, /data-clear-drill="health"/); assert.match(html, /data-clear-drill="all"/);
  const tagged = drillChipsHtml({ tag: 'env=prod' }, { esc });
  assert.match(tagged, /Tag: env = prod/); assert.match(tagged, /data-clear-drill="tag"/); assert.equal(drillIsEmpty({ tag: 'env' }), false, 'a tag alone is a filter');
  assert.equal(drillChipsHtml(null, { esc }), ''); assert.equal(drillChipsHtml({}, { esc }), '');
});

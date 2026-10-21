import test from 'node:test';
import assert from 'node:assert/strict';
import { bellLabel, countText, notificationsHtml, openAlertsHtml, resolvedAlertsHtml, rulesHtml, ruleDialogHtml, previewHtml, ruleRequestBody, ruleProblem, ruleSummary, formatValue } from '../alerts.js';

// The bell, the alert tables, the rule table and the rule dialog: what each says and offers to whom, that new things are marked as new, and that nothing a server sent
// is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const when = value => `at ${value}`;
const badge = value => `<span class="badge ${value}">${esc(value)}</span>`;
const ctx = { esc, when, badge };
const metrics = [
  { key: 'vm.cpu_percent', kind: 'vm', label: 'Virtual machine CPU use', unit: '%', max: 100 },
  { key: 'datastore.used_percent', kind: 'datastore', label: 'Datastore space used', unit: '%', max: 100 },
  { key: 'datastore.free_gb', kind: 'datastore', label: 'Datastore free space', unit: 'GB', max: 10000000 }
];
const alert = (over = {}) => ({ id: 'a1', ruleName: 'Busy', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, severity: 'critical', targetName: 'vm one', value: 95.456, status: 'active', firstSeenAt: '2026-10-17T10:00:00Z', lastSeenAt: '2026-10-17T10:05:00Z', acknowledgedAt: null, resolvedAt: null, resolvedReason: null, ...over });
const rule = (over = {}) => ({ id: 'r1', name: 'Busy VMs', description: '', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, durationMinutes: 10, severity: 'warning', connectionId: null, enabled: true, rowVersion: 1, openAlertCount: 0, summary: 'Virtual machine CPU use above 90% for 10 minutes', ...over });

test('values and rules are written with their units', () => {
  assert.equal(formatValue(metrics, 'vm.cpu_percent', 95.456), '95.46%'); assert.equal(formatValue(metrics, 'datastore.free_gb', 12.5), '12.5 GB'); assert.equal(formatValue(metrics, 'unknown', 3), '3');
  assert.equal(ruleSummary(metrics, rule()), 'Virtual machine CPU use above 90% for 10 minutes');
  assert.equal(ruleSummary(metrics, rule({ metric: 'datastore.free_gb', comparison: 'below', threshold: 100, durationMinutes: 0 })), 'Datastore free space below 100 GB');
});

test('the bell says how many are new, to assistive technology as well as by sight', () => {
  assert.equal(bellLabel(0), 'Notifications, none new'); assert.equal(bellLabel(1), 'Notifications, 1 new one'); assert.equal(bellLabel(3), 'Notifications, 3 new ones');
  assert.deepEqual([countText(4), countText(99), countText(100), countText(1234)], ['4', '99', '99+', '99+']);
});

test('the feed marks what is new since the person last read, offers Mark all as read only when something is new, and links to the page', () => {
  const feed = { unreadCount: 1, lastReadAt: '2026-10-17T10:03:00Z', items: [
    { id: 'a1:fired', kind: 'fired', at: '2026-10-17T10:05:00Z', source: 'threshold', severity: 'critical', title: 'vm one', detail: 'Busy: 95%' },
    { id: 'c1:resolved', kind: 'resolved', at: '2026-10-17T09:00:00Z', source: 'connection', severity: 'warning', title: 'ESXi lab', detail: 'Connection recovered' }] };
  const html = notificationsHtml(feed, ctx);
  assert.equal((html.match(/notify-item is-new/g) ?? []).length, 1, 'only the event after the last read is new');
  assert.match(html, /<span class="sr-only"> \(new\)<\/span>/); assert.match(html, /Resolved · Connection recovered/); assert.match(html, /at 2026-10-17T10:05:00Z/); assert.match(html, /· connection<\/small>/);
  assert.match(html, /data-notifications-read>Mark all as read/); assert.match(html, /data-go="alert-rules"/);
  assert.match(notificationsHtml({ ...feed, unreadCount: 0 }, ctx), /data-notifications-read disabled/);
  assert.equal((notificationsHtml({ items: feed.items, unreadCount: 2, lastReadAt: null }, ctx).match(/is-new/g) ?? []).length, 2, 'a person who never read sees everything as new');
  assert.match(notificationsHtml({ items: [], unreadCount: 0, lastReadAt: null }, ctx), /Nothing to report/);
});

test('open alerts show severity, target, rule, value against the limit, and offer Acknowledge only to those who may', () => {
  const rows = openAlertsHtml([alert(), alert({ id: 'a2', status: 'acknowledged', acknowledgedAt: '2026-10-17T10:06:00Z', targetName: 'vm two' })], metrics, { ...ctx, canAcknowledge: true });
  assert.match(rows, /vm one<\/strong><small class="block">Busy/); assert.match(rows, /95\.46%<small class="block">limit above 90%/);
  assert.match(rows, /data-alert-acknowledge="a1">Acknowledge<span class="sr-only"> alert for vm one<\/span>/);
  assert.doesNotMatch(rows, /data-alert-acknowledge="a2"/); assert.match(rows, /Acknowledged · at 2026-10-17T10:06:00Z/);
  assert.doesNotMatch(openAlertsHtml([alert()], metrics, { ...ctx, canAcknowledge: false }), /data-alert-acknowledge/);
  assert.match(openAlertsHtml([], metrics, { ...ctx, canAcknowledge: true }), /No open alerts/);
});

test('resolved alerts say how they ended', () => {
  const rows = resolvedAlertsHtml([alert({ status: 'resolved', resolvedAt: '2026-10-17T10:30:00Z', resolvedReason: 'cleared' }), alert({ id: 'a2', status: 'resolved', resolvedAt: '2026-10-17T10:31:00Z', resolvedReason: 'rule_deleted' })], metrics, ctx);
  assert.match(rows, /Back within the limit/); assert.match(rows, /Rule deleted/); assert.match(rows, /at 2026-10-17T10:00:00Z → at 2026-10-17T10:30:00Z/);
  assert.match(resolvedAlertsHtml([], metrics, ctx), /Nothing has resolved yet/);
});

test('the rule table offers changes only to those who may, names each button for its rule, and says which rules are off', () => {
  const rows = rulesHtml([rule({ openAlertCount: 2 }), rule({ id: 'r2', name: 'Off rule', enabled: false }), rule({ id: 'r3', name: 'Scoped', connectionId: 'c1', description: 'only the lab' })], metrics, { ...ctx, canManage: true, connectionName: id => `connection ${id}` });
  assert.match(rows, /<span class="badge bad">2 open<\/span>/); assert.match(rows, /turned off/); assert.match(rows, /connection c1/); assert.match(rows, /All connections/); assert.match(rows, /only the lab/);
  assert.match(rows, /data-alert-rule-toggle="r1">Turn off<span class="sr-only"> rule Busy VMs<\/span>/); assert.match(rows, /data-alert-rule-toggle="r2">Turn on/);
  for (const action of ['edit', 'delete']) assert.match(rows, new RegExp(`data-alert-rule-${action}="r1"`));
  const readOnly = rulesHtml([rule()], metrics, { ...ctx, canManage: false, connectionName: () => '' });
  assert.doesNotMatch(readOnly, /data-alert-rule-(edit|delete|toggle)/); assert.match(readOnly, /Virtual machine CPU use above 90%/);
  assert.match(rulesHtml([], metrics, { ...ctx, canManage: true, connectionName: () => '' }), /Choose “New rule”/); assert.match(rulesHtml([], metrics, { ...ctx, canManage: false, connectionName: () => '' }), /An administrator can add rules/);
});

test('the rule dialog groups metrics by kind, starts with sensible values, shows an existing rule’s values, and has a check button', () => {
  const create = ruleDialogHtml({ metrics, connections: [{ id: 'c1', name: 'Lab' }] }, { esc });
  assert.match(create, /New alert rule/); assert.match(create, /<optgroup label="Virtual machines">/); assert.match(create, /<optgroup label="Datastores">/);
  assert.match(create, /id="alert-rule-threshold"[^>]*value="90"/); assert.match(create, /id="alert-rule-duration"[^>]*value="5"/); assert.match(create, />Create rule<\/button>/);
  assert.match(create, /<option value="c1">Lab<\/option>/); assert.match(create, /id="alert-rule-check"/); assert.match(create, /id="alert-rule-unit" class="alert-unit">%/);
  const edit = ruleDialogHtml({ rule: rule({ name: 'Mine', metric: 'datastore.free_gb', comparison: 'below', threshold: 100, durationMinutes: 0, severity: 'critical', connectionId: 'c1', enabled: false, description: 'about space' }), metrics, connections: [{ id: 'c1', name: 'Lab' }] }, { esc });
  assert.match(edit, /<h2 id="alert-rule-title">Mine<\/h2>/); assert.match(edit, /<option value="datastore.free_gb" selected>/); assert.match(edit, /<option value="below" selected>/); assert.match(edit, /<option value="critical" selected>/);
  assert.match(edit, /<option value="c1" selected>/); assert.doesNotMatch(edit, /id="alert-rule-enabled"[^>]*checked/); assert.match(edit, /value="about space"/); assert.match(edit, />Save changes<\/button>/); assert.match(edit, />GB<\/span>/);
  assert.match(ruleDialogHtml({ metrics, connections: [], error: 'The name is taken.' }, { esc }), /id="alert-rule-error" class="tag-error" role="alert">The name is taken\./);
});

test('a preview says what matches now, strongest first, with the number that could not be measured', () => {
  const html = previewHtml({ summary: 's', metric: 'datastore.used_percent', evaluated: 3, unmeasured: 1, matches: [{ id: '1', name: 'ds2', value: 90.25 }] }, { esc, metrics });
  assert.match(html, /1 match right now/); assert.match(html, /3 things measured, 1 without a recent measurement/); assert.match(html, /ds2: 90\.25%/);
  assert.match(previewHtml({ evaluated: 2, unmeasured: 0, matches: [] }, { esc, metrics }), /Nothing matches right now/);
  const many = previewHtml({ metric: 'vm.cpu_percent', evaluated: 9, unmeasured: 0, matches: Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `vm${i}`, value: 99 })) }, { esc, metrics });
  assert.match(many, /8 matches right now/); assert.match(many, /and 3 more/); assert.equal((many.match(/<li>vm/g) ?? []).length, 5);
});

test('the request is built from the fields and checked for what a round trip would refuse', () => {
  const body = ruleRequestBody({ name: ' Busy ', description: ' d ', metric: 'vm.cpu_percent', comparison: 'above', threshold: '85.5', durationMinutes: '10', severity: 'warning', connectionId: '', enabled: true });
  assert.deepEqual(body, { name: 'Busy', description: 'd', metric: 'vm.cpu_percent', comparison: 'above', threshold: 85.5, durationMinutes: 10, severity: 'warning', connectionId: null, enabled: true });
  assert.equal(ruleProblem(body, metrics), null);
  assert.match(ruleProblem({ ...body, name: '' }, metrics), /name/); assert.match(ruleProblem({ ...body, threshold: NaN }, metrics), /number/); assert.match(ruleProblem(ruleRequestBody({ ...body, threshold: '' }), metrics), /number/);
  assert.match(ruleProblem({ ...body, threshold: 101 }, metrics), /0 to 100 \(a percentage\)/);
  assert.equal(ruleProblem({ ...body, metric: 'datastore.free_gb', threshold: 5000 }, metrics), null, 'free space in GB may go well past 100');
  assert.match(ruleProblem({ ...body, durationMinutes: 1.5 }, metrics), /whole number of minutes/); assert.match(ruleProblem({ ...body, durationMinutes: 2000 }, metrics), /0 to 1440/);
  assert.equal(ruleRequestBody({ name: 'x', metric: 'm', comparison: 'above', threshold: '1', durationMinutes: '', severity: 'warning', connectionId: 'c1' }).durationMinutes, 0);
});

test('whatever a server sends is escaped: names, rules, connections, descriptions and errors', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const feed = { unreadCount: 1, lastReadAt: null, items: [{ id: 'x', kind: 'fired', at: evil, source: 'threshold', severity: 'warning', title: evil, detail: evil }] };
  for (const html of [notificationsHtml(feed, ctx), openAlertsHtml([alert({ targetName: evil, ruleName: evil })], metrics, { ...ctx, canAcknowledge: true }), resolvedAlertsHtml([alert({ targetName: evil, ruleName: evil, resolvedAt: evil })], metrics, ctx),
    rulesHtml([rule({ name: evil, description: evil, summary: evil, connectionId: 'c1' })], metrics, { ...ctx, canManage: true, connectionName: () => evil }),
    ruleDialogHtml({ rule: rule({ name: evil, description: evil }), metrics, connections: [{ id: 'c1', name: evil }], error: evil }, { esc }), previewHtml({ metric: 'vm.cpu_percent', evaluated: 1, unmeasured: 0, matches: [{ id: '1', name: evil, value: 1 }] }, { esc, metrics })]) {
    assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
  }
});

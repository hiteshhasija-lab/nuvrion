import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertService } from '../src/alert-service.js';

// The local (file-backed) alert store: rules, the alerts they raise through evaluations, acknowledging, the notification feed, and that all of it survives a restart.
const CONNECTION = '11111111-1111-4111-8111-111111111111';
const T0 = 1_800_000_000_000;
const good = { name: 'Busy VMs', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, severity: 'warning' };
const target = (id, value, observedAt = T0) => ({ kind: 'vm', id, name: `vm ${id}`, connectionId: CONNECTION, observedAt, values: { 'vm.cpu_percent': value } });
function clocked(options = {}) { const time = { now: T0 }; return { time, service: new AlertService({ clock: () => time.now, ...options }) }; }
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);

test('rules: created with defaults, named uniquely whatever the case, changed with a version, limited to a hundred, and listed with how many alerts they have open', async () => {
  const { service } = clocked();
  const rule = await service.createRule(good, 'user-1');
  assert.deepEqual([rule.name, rule.enabled, rule.durationMinutes, rule.rowVersion, rule.openAlertCount, rule.createdBy], ['Busy VMs', true, 0, 1, 0, 'user-1']);
  await refused(service.createRule({ ...good, name: 'busy vms' }), 'NUV_ALERT_RULE_EXISTS');
  await refused(service.createRule({ ...good, threshold: 500 }), 'NUV_ALERT_RULE_INVALID');
  const changed = await service.updateRule(rule.id, { threshold: 80 }, 1);
  assert.deepEqual([changed.threshold, changed.rowVersion, changed.name], [80, 2, 'Busy VMs']);
  await refused(service.updateRule(rule.id, { threshold: 70 }, 1), 'VERSION_CONFLICT');
  assert.equal(await service.updateRule('nope', { threshold: 70 }, 1), null);
  const second = await service.createRule({ ...good, name: 'Second' });
  await refused(service.updateRule(second.id, { name: 'BUSY VMS' }, 1), 'NUV_ALERT_RULE_EXISTS');
  assert.equal((await service.updateRule(rule.id, { name: 'Busy VMs' }, 2)).rowVersion, 3, 'a rule may keep its own name');
  assert.deepEqual((await service.listRules()).map(item => item.name), ['Busy VMs', 'Second']);
  for (let i = 0; i < 98; i++) await service.createRule({ ...good, name: `Rule ${i}` });
  await refused(service.createRule({ ...good, name: 'one too many' }), 'NUV_ALERT_RULE_LIMIT');
});

test('an evaluation fires an alert once, refreshes it while the condition holds, and resolves it when it stops; history is kept', async () => {
  const { service, time } = clocked();
  const rule = await service.createRule(good);
  let summary = await service.evaluate([target('t1', 95), target('t2', 50)]);
  assert.deepEqual([summary.fired, summary.refreshed, summary.resolved, summary.rules], [1, 0, 0, 1]);
  let alerts = await service.listAlerts();
  assert.deepEqual([alerts.length, alerts[0].status, alerts[0].targetName, alerts[0].value, alerts[0].ruleName, alerts[0].severity], [1, 'active', 'vm t1', 95, 'Busy VMs', 'warning']);
  assert.equal((await service.listRules())[0].openAlertCount, 1);
  time.now += 60_000;
  summary = await service.evaluate([target('t1', 97, time.now)]);
  assert.deepEqual([summary.fired, summary.refreshed], [0, 1], 'still one alert');
  alerts = await service.listAlerts();
  assert.deepEqual([alerts.length, alerts[0].value, alerts[0].firstSeenAt === new Date(T0).toISOString(), alerts[0].lastSeenAt], [1, 97, true, new Date(T0 + 60_000).toISOString()]);
  time.now += 60_000;
  summary = await service.evaluate([target('t1', 20, time.now)]);
  assert.equal(summary.resolved, 1);
  assert.deepEqual(await service.listAlerts(), [], 'nothing open');
  const history = await service.listAlerts({ status: 'resolved' });
  assert.deepEqual([history.length, history[0].resolvedReason, history[0].resolvedAt], [1, 'cleared', new Date(T0 + 120_000).toISOString()]);
  time.now += 60_000;
  await service.evaluate([target('t1', 99, time.now)]);
  assert.equal((await service.listAlerts({ status: 'all' })).length, 2, 'it fires again as a new alert: the old one stays as history');
  assert.ok(rule.id);
});

test('a duration is waited for through the evaluations, and the wait survives a gap in the data but not a recovery', async () => {
  const { service, time } = clocked();
  await service.createRule({ ...good, durationMinutes: 5 });
  assert.equal((await service.evaluate([target('t1', 95, time.now)])).fired, 0);
  time.now += 3 * 60_000;
  assert.equal((await service.evaluate([target('t1', 95, time.now)])).fired, 0);
  time.now += 3 * 60_000;
  assert.equal((await service.evaluate([target('t1', 95, time.now)])).fired, 1, 'six minutes since it began to hold');
  const other = clocked();
  await other.service.createRule({ ...good, durationMinutes: 5 });
  await other.service.evaluate([target('t1', 95, other.time.now)]);
  other.time.now += 4 * 60_000;
  await other.service.evaluate([target('t1', 10, other.time.now)]);
  other.time.now += 2 * 60_000;
  assert.equal((await other.service.evaluate([target('t1', 95, other.time.now)])).fired, 0, 'it recovered in between: the wait began again');
});

test('acknowledging: an active alert becomes acknowledged by someone and stays open until it clears; a resolved one cannot be acknowledged', async () => {
  const { service, time } = clocked();
  await service.createRule(good);
  await service.evaluate([target('t1', 95)]);
  const [alert] = await service.listAlerts();
  const acknowledged = await service.acknowledge(alert.id, 'user-1');
  assert.deepEqual([acknowledged.status, acknowledged.acknowledgedBy, acknowledged.acknowledgedAt], ['acknowledged', 'user-1', new Date(T0).toISOString()]);
  assert.equal((await service.acknowledge(alert.id, 'user-2')).acknowledgedBy, 'user-1', 'acknowledging twice changes nothing');
  assert.equal((await service.listAlerts({ status: 'acknowledged' })).length, 1);
  time.now += 60_000;
  assert.equal((await service.evaluate([target('t1', 96, time.now)])).refreshed, 1, 'an acknowledged alert is refreshed, not duplicated');
  await service.evaluate([target('t1', 5, time.now)]);
  await refused(service.acknowledge(alert.id, 'user-1'), 'NUV_ALERT_RESOLVED');
  assert.equal(await service.acknowledge('nope', 'user-1'), null);
});

test('deleting or disabling a rule resolves its alerts, and an edit to the rule shows on its open alerts', async () => {
  const { service, time } = clocked();
  const rule = await service.createRule(good), second = await service.createRule({ ...good, name: 'Second', threshold: 10, severity: 'critical' });
  await service.evaluate([target('t1', 95)]);
  assert.equal((await service.listAlerts()).length, 2);
  time.now += 60_000;
  await service.updateRule(rule.id, { name: 'Renamed', severity: 'critical' }, 1);
  await service.evaluate([target('t1', 95, time.now)]);
  const renamed = (await service.listAlerts()).find(alert => alert.ruleName === 'Renamed');
  assert.deepEqual([renamed.severity, renamed.ruleId], ['critical', rule.id]);
  await service.updateRule(rule.id, { enabled: false }, 2);
  time.now += 60_000;
  assert.equal((await service.evaluate([target('t1', 95, time.now)])).resolved, 1);
  assert.deepEqual((await service.listAlerts({ status: 'resolved' })).map(alert => alert.resolvedReason), ['rule_disabled']);
  assert.deepEqual(await service.deleteRule(second.id), { deleted: 1, alertsResolved: 1 });
  assert.equal(await service.deleteRule(second.id), null);
  const history = await service.listAlerts({ status: 'resolved' });
  assert.deepEqual(history.map(alert => [alert.ruleName, alert.ruleId, alert.resolvedReason]).sort(), [['Renamed', rule.id, 'rule_disabled'], ['Second', null, 'rule_deleted']].sort(), 'history keeps the rule’s name after the rule is gone');
});

test('the notification feed counts what happened since the person last read it, and a person who never has sees the last day', async () => {
  const { service, time } = clocked();
  await service.createRule(good);
  assert.deepEqual(await service.notifications('user-1'), { items: [], unreadCount: 0, lastReadAt: null });
  await service.evaluate([target('t1', 95)]);
  let feed = await service.notifications('user-1');
  assert.deepEqual([feed.items.map(event => event.kind), feed.unreadCount, feed.lastReadAt], [['fired'], 1, null]);
  assert.deepEqual(await service.markRead('user-1'), { lastReadAt: new Date(T0).toISOString() });
  assert.equal((await service.notifications('user-1')).unreadCount, 0);
  assert.equal((await service.notifications('user-2')).unreadCount, 1, 'reading is per person');
  time.now += 60_000;
  await service.evaluate([target('t1', 5, time.now)]);
  feed = await service.notifications('user-1');
  assert.deepEqual([feed.items.map(event => event.kind), feed.unreadCount], [['resolved', 'fired'], 1], 'the recovery is news');
  time.now += 3 * 24 * 60 * 60_000;
  assert.equal((await service.notifications('user-3')).unreadCount, 0, 'events older than a day are not new to someone who never looked');
});

test('everything survives a restart, including the clock a duration is waiting on being forgotten (it starts again)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nuvrion-alerts-'));
  try {
    const file = join(directory, 'alerts.json'), first = clocked({ file });
    const rule = await first.service.createRule(good, 'user-1');
    await first.service.evaluate([target('t1', 95)]);
    await first.service.markRead('user-1');
    const second = clocked({ file });
    assert.deepEqual((await second.service.listRules()).map(item => [item.id, item.openAlertCount]), [[rule.id, 1]]);
    assert.equal((await second.service.listAlerts()).length, 1);
    assert.equal((await second.service.notifications('user-1')).lastReadAt, new Date(T0).toISOString());
    assert.equal((await second.service.evaluate([target('t1', 96)])).refreshed, 1, 'the open alert is recognised after the restart');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

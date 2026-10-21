import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresAlertService } from '../src/postgres-alert-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production alert store against a real PostgreSQL, as the restricted application role: the same behaviour as the file-backed store, plus what only a database can get wrong
// (simultaneous evaluations, alerts surviving the deletion of their rule as history, the tables refusing what the rules refuse).
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const time = { now: 1_800_000_000_000 };
const service = db ? new PostgresAlertService(db.pool, { clock: () => time.now }) : null;
after(async () => { await db?.drop(); });
const good = { name: 'Busy VMs', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, severity: 'warning' };
let CONNECTION;
const target = (id, value, observedAt = time.now) => ({ kind: 'vm', id, name: `vm ${id.slice(0, 4)}`, connectionId: CONNECTION, observedAt, values: { 'vm.cpu_percent': value } });
const T1 = randomUUID(), T2 = randomUUID();
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);
beforeEach(async () => {
  if (!db) return;
  await db.adminPool.query('TRUNCATE monitoring.alerts, monitoring.notification_reads; DELETE FROM monitoring.alert_rules');
  service.clock = () => time.now; time.now += 3_600_000;
  CONNECTION = randomUUID();
  await db.adminPool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, $2, 'vmware_vsphere', 'esxi', 'enabled', 'healthy')", [CONNECTION, `c ${CONNECTION.slice(0, 6)}`]);
});

test('PostgreSQL: rules are created with defaults, unique by name whatever the case, changed with a version, and listed with their open alerts', database, async () => {
  const rule = await service.createRule(good, null);
  assert.deepEqual([rule.name, rule.enabled, rule.durationMinutes, rule.rowVersion, rule.openAlertCount, rule.threshold], ['Busy VMs', true, 0, 1, 0, 90]);
  await refused(service.createRule({ ...good, name: 'busy vms' }), 'NUV_ALERT_RULE_EXISTS');
  await refused(service.createRule({ ...good, name: 'No such connection', connectionId: randomUUID() }), 'NUV_ALERT_RULE_INVALID');
  const changed = await service.updateRule(rule.id, { threshold: 80, connectionId: CONNECTION }, 1);
  assert.deepEqual([changed.threshold, changed.rowVersion, changed.connectionId], [80, 2, CONNECTION]);
  await refused(service.updateRule(rule.id, { threshold: 70 }, 1), 'VERSION_CONFLICT');
  assert.equal(await service.updateRule(randomUUID(), { threshold: 70 }, 1), null); assert.equal(await service.updateRule('not-a-uuid', { threshold: 70 }, 1), null);
  const second = await service.createRule({ ...good, name: 'Second' });
  await refused(service.updateRule(second.id, { name: 'BUSY VMS' }, 1), 'NUV_ALERT_RULE_EXISTS');
  assert.deepEqual((await service.listRules()).map(item => item.name), ['Busy VMs', 'Second']);
  assert.equal(await service.getRule('not-a-uuid'), null); assert.equal((await service.getRule(rule.id)).name, 'Busy VMs');
});

test('PostgreSQL: an evaluation fires an alert once, refreshes it while it holds, resolves it when it stops, and a durations is waited for', database, async () => {
  await service.createRule(good);
  let summary = await service.evaluate([target(T1, 95), target(T2, 50)]);
  assert.deepEqual([summary.fired, summary.refreshed, summary.resolved, summary.rules], [1, 0, 0, 1]);
  let [alert] = await service.listAlerts();
  assert.deepEqual([alert.status, alert.targetKind, alert.value, alert.ruleName, alert.firstSeenAt], ['active', 'vm', 95, 'Busy VMs', new Date(time.now).toISOString()]);
  time.now += 60_000;
  summary = await service.evaluate([target(T1, 97)]);
  assert.deepEqual([summary.fired, summary.refreshed], [0, 1]);
  [alert] = await service.listAlerts();
  assert.deepEqual([alert.value, alert.lastSeenAt], [97, new Date(time.now).toISOString()]);
  time.now += 60_000;
  assert.equal((await service.evaluate([target(T1, 20)])).resolved, 1);
  assert.deepEqual(await service.listAlerts(), []);
  assert.deepEqual((await service.listAlerts({ status: 'resolved' })).map(item => item.resolvedReason), ['cleared']);
  const sustained = await service.createRule({ ...good, name: 'Sustained', metric: 'vm.memory_percent', durationMinutes: 5 });
  const memory = (id, value) => ({ ...target(id, 0), values: { 'vm.memory_percent': value } });
  assert.equal((await service.evaluate([memory(T2, 95)])).fired, 0);
  time.now += 6 * 60_000;
  assert.equal((await service.evaluate([memory(T2, 95)])).fired, 1);
  assert.ok(sustained.id);
});

test('PostgreSQL: two evaluations at the same moment raise one alert, not two', database, async () => {
  await service.createRule(good);
  const results = await Promise.all(Array.from({ length: 6 }, () => service.evaluate([target(T1, 95), target(T2, 96)])));
  assert.equal((await service.listAlerts()).length, 2, 'one open alert per rule and target');
  assert.equal(results.reduce((sum, item) => sum + item.fired, 0), 2, 'and exactly two firings among the six evaluations');
});

test('PostgreSQL: the table allows one open alert per rule and target, and none of the rules’ forbidden values', database, async () => {
  const rule = await service.createRule(good);
  await service.evaluate([target(T1, 95)]);
  const insert = (status, values = {}) => db.adminPool.query("INSERT INTO monitoring.alerts(rule_id, rule_name, metric, comparison, threshold, severity, target_kind, target_id, target_name, value, status, first_seen_at, last_seen_at) VALUES($1,'x','vm.cpu_percent','above',1,$2,$3,$4,'x',1,$5,now(),now())", [rule.id, values.severity ?? 'warning', values.kind ?? 'vm', values.target ?? T1, status]);
  await assert.rejects(insert('active'), error => error.code === '23505', 'a second open alert for the same rule and target');
  await insert('resolved');
  await assert.rejects(insert('active', { target: T2, severity: 'urgent' }), error => error.code === '23514');
  await assert.rejects(insert('active', { target: T2, kind: 'network' }), error => error.code === '23514');
  await assert.rejects(insert('sleeping', { target: T2 }), error => error.code === '23514');
  await assert.rejects(db.adminPool.query("INSERT INTO monitoring.alert_rules(name, metric, comparison, threshold, severity) VALUES('bad','vm.cpu_percent','sideways',1,'warning')"), error => error.code === '23514');
  await assert.rejects(db.adminPool.query("INSERT INTO monitoring.alert_rules(name, metric, comparison, threshold, severity, duration_minutes) VALUES('bad2','vm.cpu_percent','above',1,'warning',2000)"), error => error.code === '23514');
});

test('PostgreSQL: acknowledging, and what deleting or disabling a rule does to its alerts, which stay as history under the rule’s name', database, async () => {
  const rule = await service.createRule(good), second = await service.createRule({ ...good, name: 'Second', threshold: 10 });
  await service.evaluate([target(T1, 95)]);
  const [first] = (await service.listAlerts()).filter(alert => alert.ruleName === 'Busy VMs');
  const user = randomUUID();   // acknowledged_by is a plain column: no account is needed to be named
  const acknowledged = await service.acknowledge(first.id, user);
  assert.deepEqual([acknowledged.status, acknowledged.acknowledgedBy], ['acknowledged', user]);
  assert.equal((await service.acknowledge(first.id, null)).acknowledgedBy, user);
  assert.equal(await service.acknowledge(randomUUID(), user), null); assert.equal(await service.acknowledge('nope', user), null);
  await service.updateRule(rule.id, { enabled: false }, 1);
  time.now += 60_000;
  assert.equal((await service.evaluate([target(T1, 95)])).resolved, 1, 'disabling resolved the acknowledged alert');
  await refused(service.acknowledge(first.id, user), 'NUV_ALERT_RESOLVED');
  assert.deepEqual(await service.deleteRule(second.id), { deleted: 1, alertsResolved: 1 });
  assert.equal(await service.deleteRule(second.id), null);
  const history = await service.listAlerts({ status: 'resolved' });
  assert.deepEqual(history.map(alert => [alert.ruleName, alert.resolvedReason]).sort(), [['Busy VMs', 'rule_disabled'], ['Second', 'rule_deleted']]);
  assert.equal(history.find(alert => alert.ruleName === 'Second').ruleId, null, 'the rule is gone, the alert is not');
  assert.equal((await db.adminPool.query('SELECT count(*)::int n FROM monitoring.alerts')).rows[0].n, 2);
});

test('PostgreSQL: the notification feed counts what happened since the person last read it, per person', database, async () => {
  const people = [randomUUID(), randomUUID()];
  for (const id of people) await db.adminPool.query("INSERT INTO identity.users(user_id, username, normalized_username, display_name, status, password_hash) VALUES($1, $2, $2, 'Reader', 'active', 'x')", [id, `reader.${id.slice(0, 8)}`]);
  await service.createRule(good);
  assert.deepEqual(await service.notifications(people[0]), { items: [], unreadCount: 0, lastReadAt: null });
  await service.evaluate([target(T1, 95)]);
  assert.deepEqual([(await service.notifications(people[0])).unreadCount, (await service.notifications(people[0])).items.map(event => event.kind)], [1, ['fired']]);
  const read = await service.markRead(people[0]);
  assert.equal(read.lastReadAt, new Date(time.now).toISOString());
  assert.equal((await service.notifications(people[0])).unreadCount, 0);
  assert.equal((await service.notifications(people[1])).unreadCount, 1, 'reading is per person');
  time.now += 60_000;
  await service.evaluate([target(T1, 5)]);
  const feed = await service.notifications(people[0]);
  assert.deepEqual([feed.items.map(event => event.kind), feed.unreadCount], [['resolved', 'fired'], 1]);
});

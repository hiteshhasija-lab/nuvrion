import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, parseRule, mergeRule, describeRule, describeValue, collectTargets, planEvaluation, previewRule, feedFromAlerts, conditionHolds, STALE_AFTER_MS, AlertError } from '../src/alert-rules.js';

// When an alert fires and when it clears is decided here, for both stores. The rules are about time and about not believing what was not measured.
const CONNECTION = '11111111-1111-4111-8111-111111111111';
const good = { name: 'Busy VMs', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, severity: 'warning' };
const refused = (work, pattern) => assert.throws(work, error => error instanceof AlertError && (!pattern || pattern.test(error.message)), String(work).slice(0, 80));

test('a rule is validated: known metric, comparison and severity, a threshold inside the metric’s range, a whole duration, a connection id or none', () => {
  assert.deepEqual(parseRule(good), { ...good, description: '', durationMinutes: 0, connectionId: null, enabled: true });
  assert.deepEqual(parseRule({ ...good, name: '  Padded  ', description: ' d ', durationMinutes: 15, connectionId: CONNECTION.toUpperCase(), enabled: false }), { ...good, name: 'Padded', description: 'd', durationMinutes: 15, connectionId: CONNECTION, enabled: false });
  for (const bad of [null, [], 'x', { ...good, metric: 'vm.disk_percent' }, { ...good, metric: undefined }, { ...good, comparison: 'equal' }, { ...good, severity: 'urgent' }, { ...good, name: '   ' }, { ...good, name: 'x'.repeat(101) },
    { ...good, description: 'x'.repeat(301) }, { ...good, threshold: '90' }, { ...good, threshold: NaN }, { ...good, threshold: -1 }, { ...good, threshold: 101 }, { ...good, durationMinutes: 1.5 }, { ...good, durationMinutes: -1 },
    { ...good, durationMinutes: 1441 }, { ...good, connectionId: 'not-a-uuid' }, { ...good, enabled: 'yes' }, { ...good, extra: 1 }, { ...good, name: 'a\u0000b' }, { ...good, name: 'a‮b' }]) refused(() => parseRule(bad));
  assert.doesNotThrow(() => parseRule({ ...good, metric: 'datastore.free_gb', comparison: 'below', threshold: 5000 }), 'free space in GB may go well past 100');
  refused(() => parseRule({ ...good, metric: 'datastore.free_gb', threshold: 10_000_001 }));
});

test('a change replaces only the fields given and is validated as a whole', () => {
  const rule = { id: 'r1', ...parseRule(good) };
  assert.equal(mergeRule(rule, { threshold: 70 }).threshold, 70);
  assert.equal(mergeRule(rule, { threshold: 70 }).name, 'Busy VMs');
  assert.equal(mergeRule(rule, { enabled: false }).enabled, false);
  refused(() => mergeRule(rule, {}), /Nothing to change/); refused(() => mergeRule(rule, { threshold: 700 })); refused(() => mergeRule(rule, { id: 'x' }), /Unknown field/); refused(() => mergeRule(rule, null));
  refused(() => mergeRule({ ...rule, metric: 'datastore.free_gb', threshold: 5000 }, { metric: 'vm.cpu_percent' }), /threshold/);
});

test('a rule and a value are described in words', () => {
  assert.equal(describeRule({ ...good, durationMinutes: 10 }), 'Virtual machine CPU use above 90% for 10 minutes');
  assert.equal(describeRule({ ...good, durationMinutes: 1 }), 'Virtual machine CPU use above 90% for 1 minute');
  assert.equal(describeRule({ ...good, metric: 'datastore.free_gb', comparison: 'below', threshold: 100, durationMinutes: 0 }), 'Datastore free space below 100 GB');
  assert.equal(describeValue('vm.cpu_percent', 91.456), '91.46%'); assert.equal(describeValue('datastore.free_gb', 12.5), '12.5 GB');
});

const vm = (id, over = {}) => ({ id, name: `vm ${id}`, resourceType: 'virtual_machine', lifecycleState: 'active', connectionId: CONNECTION, ...over });
const sample = (resourceId, over = {}) => ({ resourceId, observedAt: new Date(1_800_000_000_000).toISOString(), cpuUtilizationPercent: 50, memoryUtilizationPercent: 60, ...over });
const NOW = 1_800_000_000_000;

test('targets are measured from the latest samples and the infrastructure: percentages, free space in GB, nothing invented for what is not reported', () => {
  const targets = collectTargets({
    connections: [{ id: CONNECTION, status: 'active' }],
    resources: [vm('a'), vm('b'), vm('c', { lifecycleState: 'deleted' }), vm('d', { connectionId: 'gone' }), vm('e')],
    metrics: [sample('a', { cpuUtilizationPercent: 91 }), sample('b', { cpuUtilizationPercent: null, memoryUtilizationPercent: undefined }), sample('c'), sample('d'), sample('e', { observedAt: 'nonsense' })],
    infrastructure: [
      { id: 'h1', kind: 'host', name: 'esx-1', connectionId: CONNECTION, lifecycleState: 'active', observedAt: new Date(NOW).toISOString(), attributes: { cpuMhz: 20000, cpuUsageMhz: 5000, memoryBytes: 100, memoryUsageBytes: 150 } },
      { id: 'h2', kind: 'host', name: 'esx-2', connectionId: CONNECTION, lifecycleState: 'active', observedAt: new Date(NOW).toISOString(), attributes: {} },
      { id: 'd1', kind: 'datastore', name: 'ds1', connectionId: CONNECTION, lifecycleState: 'active', observedAt: new Date(NOW).toISOString(), attributes: { capacityBytes: 1000 * 1024 ** 3, freeBytes: 250 * 1024 ** 3 } },
      { id: 'd2', kind: 'datastore', name: 'ds2', connectionId: CONNECTION, lifecycleState: 'missing', observedAt: new Date(NOW).toISOString(), attributes: { capacityBytes: 10, freeBytes: 1 } },
      { id: 'n1', kind: 'network', name: 'vlan', connectionId: CONNECTION, lifecycleState: 'active', observedAt: new Date(NOW).toISOString(), attributes: {} }
    ]
  });
  const byId = Object.fromEntries(targets.map(target => [target.id, target]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'd1', 'h1', 'h2'], 'deleted machines, machines of a deleted connection, a sample with no time, missing objects and networks are not measured');
  assert.deepEqual(byId.a.values, { 'vm.cpu_percent': 91, 'vm.memory_percent': 60 });
  assert.deepEqual(byId.b.values, {}, 'a measurement that is not reported is absent, not zero');
  assert.deepEqual(byId.h1.values, { 'host.cpu_percent': 25, 'host.memory_percent': 100 }, 'use is capped at 100%');
  assert.deepEqual(byId.h2.values, {});
  assert.equal(byId.d1.values['datastore.used_percent'], 75); assert.equal(byId.d1.values['datastore.free_gb'], 250);
});

test('the days until a datastore is full are measured from its forecast: only when the forecast is trusted, "no end in sight" when it is not filling, nothing when unknown', () => {
  const datastore = id => ({ id, kind: 'datastore', name: id, connectionId: CONNECTION, lifecycleState: 'active', observedAt: new Date(NOW).toISOString(), attributes: { capacityBytes: 1000, freeBytes: 500 } });
  const forecasts = new Map([
    ['filling', { status: 'growing', confidence: 'high', daysUntilFull: 12.5 }], ['flat', { status: 'stable', confidence: 'medium' }], ['guess', { status: 'growing', confidence: 'low', daysUntilFull: 3 }],
    ['new', { status: 'insufficient', confidence: null }], ['full', { status: 'full', confidence: 'high', daysUntilFull: 0 }]
  ]);
  const targets = collectTargets({ connections: [{ id: CONNECTION, status: 'active' }], infrastructure: ['filling', 'flat', 'guess', 'new', 'full', 'unknown'].map(datastore), forecasts });
  const days = Object.fromEntries(targets.map(target => [target.id, target.values['datastore.days_until_full']]));
  assert.deepEqual(days, { filling: 12.5, flat: 3650, guess: undefined, new: undefined, full: 0, unknown: undefined });
  assert.equal(collectTargets({ connections: [{ id: CONNECTION, status: 'active' }], infrastructure: [datastore('x')] })[0].values['datastore.days_until_full'], undefined, 'no forecasts given: nothing is reported');
  assert.doesNotThrow(() => parseRule({ name: 'Filling', metric: 'datastore.days_until_full', comparison: 'below', threshold: 14, severity: 'warning' }));
  assert.throws(() => parseRule({ name: 'Too long', metric: 'datastore.days_until_full', comparison: 'below', threshold: 4000, severity: 'warning' }));
  assert.equal(describeRule({ name: 'x', metric: 'datastore.days_until_full', comparison: 'below', threshold: 14, durationMinutes: 0 }), 'Datastore days until full below 14 days');
});

const rule = (over = {}) => ({ id: 'r1', name: 'Busy', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, durationMinutes: 0, severity: 'warning', connectionId: null, enabled: true, ...over });
const target = (id, value, over = {}) => ({ kind: 'vm', id, name: id, connectionId: CONNECTION, observedAt: NOW, values: { 'vm.cpu_percent': value }, ...over });
const alert = (over = {}) => ({ id: 'a1', ruleId: 'r1', targetId: 't1', status: 'active', ...over });

test('a condition that holds fires at once with no duration, is refreshed while it holds, and clears when it stops', () => {
  let plan = planEvaluation({ rules: [rule()], targets: [target('t1', 95), target('t2', 50)], open: [], now: NOW });
  assert.deepEqual(plan.fire.map(item => [item.target.id, item.value]), [['t1', 95]]);
  assert.deepEqual([plan.refresh.length, plan.resolve.length], [0, 0]);
  plan = planEvaluation({ rules: [rule()], targets: [target('t1', 97)], open: [alert()], now: NOW });
  assert.deepEqual([plan.fire.length, plan.refresh.length, plan.refresh[0].value], [0, 1, 97], 'no second alert for the same target');
  plan = planEvaluation({ rules: [rule()], targets: [target('t1', 40)], open: [alert()], now: NOW });
  assert.deepEqual(plan.resolve.map(item => [item.alert.id, item.reason]), [['a1', 'cleared']]);
  assert.equal(conditionHolds(rule({ threshold: 90 }), 90), false, 'above means strictly above'); assert.equal(conditionHolds(rule({ comparison: 'below', threshold: 10 }), 10), false);
  assert.equal(conditionHolds(rule({ comparison: 'below', threshold: 10 }), 9.9), true);
});

test('a duration must hold for the whole time: the clock starts when it first holds, restarts if it stops, and a blip does nothing', () => {
  const sustained = rule({ durationMinutes: 10 });
  let pending = new Map();
  const step = (value, at, over = {}) => { const plan = planEvaluation({ rules: [sustained], targets: [target('t1', value, { observedAt: at })], open: over.open ?? [], pending, now: at }); pending = plan.pending; return plan; };
  assert.equal(step(95, NOW).fire.length, 0, 'it has only just begun to hold');
  assert.equal(step(95, NOW + 5 * 60_000).fire.length, 0);
  assert.equal(step(40, NOW + 6 * 60_000).fire.length, 0, 'it stopped: the clock is dropped');
  assert.equal(pending.size, 0);
  assert.equal(step(95, NOW + 7 * 60_000).fire.length, 0, 'and starts again');
  assert.equal(step(95, NOW + 16 * 60_000).fire.length, 0, 'nine minutes: not yet');
  assert.equal(step(95, NOW + 17 * 60_000).fire.length, 1, 'ten minutes since it began to hold again');
});

test('measurements older than ten minutes, or not reported, are not believed: nothing fires and nothing clears, and a waiting clock is kept', () => {
  const old = NOW - STALE_AFTER_MS - 1;
  let plan = planEvaluation({ rules: [rule()], targets: [target('t1', 99, { observedAt: old })], open: [], now: NOW });
  assert.deepEqual([plan.fire.length, plan.stale], [0, 1]);
  plan = planEvaluation({ rules: [rule()], targets: [target('t1', 10, { observedAt: old })], open: [alert()], now: NOW });
  assert.deepEqual([plan.resolve.length, plan.stale], [0, 1], 'an old low reading does not clear an alert');
  plan = planEvaluation({ rules: [rule()], targets: [target('t1', undefined, {})], open: [alert()], now: NOW });
  assert.deepEqual([plan.fire.length, plan.resolve.length, plan.refresh.length], [0, 0, 0], 'not reported is not zero');
  const since = new Map([['r1\nt1', NOW - 5 * 60_000]]);
  plan = planEvaluation({ rules: [rule({ durationMinutes: 10 })], targets: [target('t1', 99, { observedAt: old })], open: [], pending: since, now: NOW });
  assert.equal(plan.pending.get('r1\nt1'), NOW - 5 * 60_000, 'the clock waits through a gap in the data');
  assert.equal(planEvaluation({ rules: [rule()], targets: [target('t1', 99, { observedAt: NOW - STALE_AFTER_MS })], open: [], now: NOW }).fire.length, 1, 'exactly ten minutes old is still fresh');
});

test('a rule applies to its kind of target and, if it names one, its connection only', () => {
  const other = '22222222-2222-4222-8222-222222222222';
  const targets = [target('t1', 95), target('t2', 95, { connectionId: other }), { kind: 'host', id: 'h1', name: 'h1', connectionId: CONNECTION, observedAt: NOW, values: { 'host.cpu_percent': 99 } }];
  assert.deepEqual(planEvaluation({ rules: [rule()], targets, open: [], now: NOW }).fire.map(item => item.target.id), ['t1', 't2'], 'a VM rule does not look at hosts');
  assert.deepEqual(planEvaluation({ rules: [rule({ connectionId: CONNECTION })], targets, open: [], now: NOW }).fire.map(item => item.target.id), ['t1']);
  assert.deepEqual(planEvaluation({ rules: [rule({ metric: 'host.cpu_percent' })], targets, open: [], now: NOW }).fire.map(item => item.target.id), ['h1']);
});

test('alerts end when their rule is disabled or deleted, when their target is gone, or when the rule no longer covers it', () => {
  const open = [alert(), alert({ id: 'a2', ruleId: 'gone', targetId: 't1' }), alert({ id: 'a3', targetId: 'vanished' })];
  const plan = planEvaluation({ rules: [rule({ enabled: false }), rule({ id: 'r2', enabled: false })], targets: [target('t1', 95)], open, now: NOW });
  assert.deepEqual(Object.fromEntries(plan.resolve.map(item => [item.alert.id, item.reason])), { a1: 'rule_disabled', a2: 'rule_deleted', a3: 'rule_disabled' });
  const live = planEvaluation({ rules: [rule()], targets: [target('t1', 95)], open: [alert({ targetId: 'vanished' }), alert({ id: 'a4', targetId: 't1' })], now: NOW });
  assert.deepEqual(live.resolve.map(item => [item.alert.id, item.reason]), [['a1', 'target_gone']]);
  assert.deepEqual(live.refresh.map(item => item.alert.id), ['a4']);
  const narrowed = planEvaluation({ rules: [rule({ connectionId: '22222222-2222-4222-8222-222222222222' })], targets: [target('t1', 95)], open: [alert({ targetId: 't1' })], now: NOW });
  assert.deepEqual(narrowed.resolve.map(item => item.reason), ['scope_changed']);
});

test('a preview says what a rule would match now, strongest first, and how many could not be measured', () => {
  const targets = [target('t1', 95), target('t2', 99), target('t3', 10), target('t4', undefined), target('t5', 99, { observedAt: NOW - STALE_AFTER_MS - 5 })];
  const preview = previewRule(rule(), targets, NOW);
  assert.deepEqual(preview.matches.map(item => item.id), ['t2', 't1']); assert.deepEqual([preview.evaluated, preview.unmeasured], [3, 2]);
  assert.deepEqual(previewRule(rule({ comparison: 'below', threshold: 60 }), targets, NOW).matches.map(item => item.id), ['t3']);
});

test('the notification feed has one event for an alert firing and one for it resolving, newest first', () => {
  const alerts = [
    { id: 'a1', ruleName: 'Busy', metric: 'vm.cpu_percent', targetName: 'vm one', severity: 'critical', value: 95.5, firstSeenAt: '2026-10-17T10:00:00Z', resolvedAt: '2026-10-17T10:30:00Z' },
    { id: 'a2', ruleName: 'Full', metric: 'datastore.used_percent', targetName: 'ds1', severity: 'warning', value: 88, firstSeenAt: '2026-10-17T10:10:00Z', resolvedAt: null }
  ];
  const feed = feedFromAlerts(alerts);
  assert.deepEqual(feed.map(event => [event.id, event.kind]), [['a1:resolved', 'resolved'], ['a2:fired', 'fired'], ['a1:fired', 'fired']]);
  assert.equal(feed[1].detail, 'Full: 88%'); assert.equal(feed[0].detail, 'Busy: back to normal'); assert.equal(feedFromAlerts(alerts, 2).length, 2);
  assert.ok(Object.keys(METRICS).length >= 6);
});

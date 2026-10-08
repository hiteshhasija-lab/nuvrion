import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryScheduler } from '../src/discovery-scheduler.js';

const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'NUV_ESXI_UNREACHABLE' });

function build({ connections, discover = async () => { throw refused(); }, ...options }) {
  const calls = { discover: [], failures: [], syncs: [] };
  const store = {
    list: async () => connections,
    recordFailure: async (id, code, delay) => { calls.failures.push({ id, code, delay }); },
    recordSync: async (id, count) => { calls.syncs.push({ id, count }); },
    recordDiagnostic: async () => {}
  };
  const scheduler = new DiscoveryScheduler({
    connections: store,
    inventory: { synchronize: async () => ({ discovered: 0 }), list: async () => [] },
    provider: { discover: async connection => { calls.discover.push(connection.id); return discover(connection); } },
    reconciler: { reconcileConnection: async () => ({}) },
    intervalMs: 5000,
    onError: () => {},
    ...options
  });
  return { scheduler, calls };
}

test('backoff doubles from the discovery interval up to the cap', () => {
  const { scheduler } = build({ connections: [], backoffMaxMs: 120000 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(n => scheduler.backoffDelay(n)), [5000, 10000, 20000, 40000, 80000, 120000, 120000]);
});

test('backoff stays at the cap after tens of thousands of failures', () => {
  const { scheduler } = build({ connections: [] });
  assert.equal(scheduler.backoffDelay(73420), 120000);
  assert.equal(scheduler.backoffDelay(0), 5000);
});

test('a failed run schedules the next attempt from the connection\'s failure count', async () => {
  const connection = { id: 'a', status: 'enabled', consecutiveFailures: 4, nextRetryAt: null };
  const { scheduler, calls } = build({ connections: [connection] });
  await scheduler.run();
  // four earlier failures plus this one: 5000 * 2^4
  assert.deepEqual(calls.failures, [{ id: 'a', code: 'NUV_ESXI_UNREACHABLE', delay: 80000 }]);
});

test('connections still inside their backoff window are not polled', async () => {
  const future = new Date(Date.now() + 60000).toISOString(), past = new Date(Date.now() - 1000).toISOString();
  const connections = [
    { id: 'waiting', status: 'enabled', consecutiveFailures: 9, nextRetryAt: future },
    { id: 'due', status: 'enabled', consecutiveFailures: 9, nextRetryAt: past },
    { id: 'fresh', status: 'enabled', consecutiveFailures: 0, nextRetryAt: null },
    { id: 'off', status: 'deleted', consecutiveFailures: 0, nextRetryAt: null }
  ];
  const { scheduler, calls } = build({ connections });
  await scheduler.run();
  assert.deepEqual(calls.discover.sort(), ['due', 'fresh']);
});

test('a successful poll after backoff records the sync that clears it', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const { scheduler, calls } = build({
    connections: [{ id: 'back', status: 'enabled', consecutiveFailures: 50, nextRetryAt: past }],
    discover: async () => []
  });
  await scheduler.run();
  assert.deepEqual(calls.syncs, [{ id: 'back', count: 0 }]);
  assert.deepEqual(calls.failures, []);
});

test('manual discover() ignores the backoff window', async () => {
  const connection = { id: 'm', status: 'enabled', consecutiveFailures: 50, nextRetryAt: new Date(Date.now() + 60000).toISOString() };
  const { scheduler, calls } = build({ connections: [connection], discover: async () => [] });
  await scheduler.discover(connection);
  assert.deepEqual(calls.discover, ['m']);
});

// Only a running VM has measurements. A stopped or suspended VM reports empty or zero values (the Workstation agent does so every heartbeat), and recording them
// every few seconds fills the history with points that say nothing: 100 rows per VM every 10 minutes.
import { PerformanceService } from '../../monitoring/src/performance-service.js';

test('performance samples are recorded for running VMs only', async () => {
  const connection = { id: 'c1', status: 'enabled', consecutiveFailures: 0, nextRetryAt: null, providerType: 'vmware_workstation' };
  const metrics = { cpuUsageMhz: 800, memoryUsedBytes: 1024, cpuUtilizationPercent: 5, source: 'workstation_agent' };
  const emptyMetrics = { cpuUsageMhz: null, memoryUsedBytes: 0, source: 'workstation_agent' };
  const observation = (nativeId, powerState, m) => ({ resourceType: 'virtual_machine', nativeId, name: nativeId, attributes: { powerState }, metrics: m });
  const observations = [observation('on', 'running', metrics), observation('off', 'stopped', emptyMetrics), observation('paused', 'suspended', emptyMetrics), observation('odd', 'unknown', emptyMetrics), observation('booting', 'starting', emptyMetrics)];
  const resources = observations.map((o, i) => ({ id: `r${i}`, nativeId: o.nativeId }));
  const performance = new PerformanceService();
  const { scheduler } = build({ connections: [connection], discover: async () => observations, performance, inventory: { synchronize: async () => ({ discovered: observations.length }), list: async () => resources } });
  const summary = await scheduler.discover(connection);
  assert.equal(summary.metricsRecorded, 1, 'one sample, for the running VM');
  assert.equal(performance.history('r0').length, 1);
  for (const id of ['r1', 'r2', 'r3', 'r4']) assert.equal(performance.history(id).length, 0, `${id} (${observations[Number(id.slice(1))].attributes.powerState}) has no samples`);
  await scheduler.discover(connection);
  assert.equal(performance.history('r0').length, 2, 'the running VM keeps being sampled on every run');
});

test('a running VM with no measurements, and a provider that sends none, record nothing and fail nothing', async () => {
  const connection = { id: 'c1', status: 'enabled', consecutiveFailures: 0, nextRetryAt: null, providerType: 'aws' };
  const observations = [{ resourceType: 'virtual_machine', nativeId: 'a', name: 'a', attributes: { powerState: 'running' } }, { resourceType: 'virtual_machine', nativeId: 'b', name: 'b' }];
  const { scheduler } = build({ connections: [connection], discover: async () => observations, performance: new PerformanceService(), inventory: { synchronize: async () => ({ discovered: 2 }), list: async () => [{ id: 'ra', nativeId: 'a' }, { id: 'rb', nativeId: 'b' }] } });
  assert.equal((await scheduler.discover(connection)).metricsRecorded, 0);
});

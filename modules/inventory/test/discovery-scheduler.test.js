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

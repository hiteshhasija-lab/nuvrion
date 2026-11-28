import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService, retentionPoliciesFromEnv, RETENTION_TABLES, SAMPLE_TABLES } from '../src/retention-service.js';

const NOW = Date.parse('2026-10-06T00:00:00Z');
const day = 86_400_000;

// A fake pool that answers each DELETE with the next scripted row count and records the parameters it was given.
function fakePool(counts) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: counts.length ? counts.shift() : 0 }; } };
}
const policy = overrides => ({ ...RETENTION_TABLES[0], days: 30, ...overrides });

test('environment defaults are 30 days for discovery runs, 90 for health events, 7 for metric samples and 90 for capacity samples', () => {
  const policies = retentionPoliciesFromEnv({});
  assert.deepEqual(policies.map(p => [p.name, p.days]), [['discovery_runs', 30], ['health_events', 90], ['metric_samples', 7], ['capacity_samples', 90]]);
});

test('environment overrides apply, 0 disables, and junk falls back to the default', () => {
  const policies = retentionPoliciesFromEnv({ NUVRION_RETENTION_DISCOVERY_DAYS: '7', NUVRION_RETENTION_HEALTH_EVENTS_DAYS: 'abc' });
  assert.deepEqual(policies.slice(0, 2).map(p => p.days), [7, 90]);
  assert.equal(retentionPoliciesFromEnv({ NUVRION_RETENTION_DISCOVERY_DAYS: '0' })[0].days, 0);
  assert.equal(retentionPoliciesFromEnv({ NUVRION_RETENTION_DISCOVERY_DAYS: '-5' })[0].days, 30);
});

test('the metric-sample age is the one the performance service uses, and junk falls back to 7 days', () => {
  const age = value => retentionPoliciesFromEnv({ NUVRION_METRIC_RETENTION_MS: value }).find(p => p.name === 'metric_samples').days;
  assert.equal(age(String(2 * day)), 2);
  assert.equal(age(String(day / 2)), 0.5);
  for (const junk of ['abc', '0', '-5']) assert.equal(age(junk), 7, junk);
});

test('a sample table keeps nothing past its age: the delete is by age alone, in batches', async () => {
  const pool = fakePool([5000, 7]);
  const service = new RetentionService({ pool, policies: [{ ...SAMPLE_TABLES[0], days: 7 }], now: () => NOW, keepRecent: 100, batchSize: 5000 });
  assert.deepEqual(await service.run(), { metric_samples: 5007 });
  const [{ sql, params }] = pool.calls;
  assert.equal(params[0].toISOString(), new Date(NOW - 7 * day).toISOString());
  assert.deepEqual(params.slice(1), [5000]);
  assert.match(sql, /DELETE FROM monitoring\.vm_metric_samples WHERE sample_id IN \(SELECT sample_id FROM monitoring\.vm_metric_samples WHERE observed_at < \$1 LIMIT \$2\)/);
  assert.doesNotMatch(sql, /row_number/, 'the keep-the-newest rule of the history tables must not apply to samples');
});

test('the cutoff is now minus the policy age, and the newest rows per connection are protected', async () => {
  const pool = fakePool([12]);
  const service = new RetentionService({ pool, policies: [policy({ days: 30 })], now: () => NOW, keepRecent: 100, batchSize: 5000 });
  const results = await service.run();
  assert.deepEqual(results, { discovery_runs: 12 });
  const [{ sql, params }] = pool.calls;
  assert.equal(params[0].toISOString(), new Date(NOW - 30 * day).toISOString());
  assert.deepEqual(params.slice(1), [100, 5000]);
  assert.match(sql, /PARTITION BY connection_id ORDER BY started_at DESC/);
  assert.match(sql, /rn > \$2/);
});

test('a full batch triggers another batch until a short one', async () => {
  const pool = fakePool([5000, 5000, 1234]);
  const service = new RetentionService({ pool, policies: [policy()], now: () => NOW, batchSize: 5000 });
  assert.deepEqual(await service.run(), { discovery_runs: 11234 });
  assert.equal(pool.calls.length, 3);
});

test('disabled policies are skipped and nothing is queried', async () => {
  const pool = fakePool([]);
  const service = new RetentionService({ pool, policies: [policy({ days: 0 })], now: () => NOW });
  assert.deepEqual(await service.run(), {});
  assert.equal(pool.calls.length, 0);
});

test('one table failing is reported and does not stop the next table', async () => {
  const errors = [], pruned = [];
  let call = 0;
  const pool = { query: async () => { if (call++ === 0) throw new Error('boom'); return { rowCount: 3 }; } };
  const service = new RetentionService({ pool, policies: RETENTION_TABLES.map(t => ({ ...t, days: 30 })), now: () => NOW, onError: (error, p) => errors.push(`${p.name}:${error.message}`), onPruned: (name, rows) => pruned.push([name, rows]) });
  const results = await service.run();
  assert.deepEqual(errors, ['discovery_runs:boom']);
  assert.deepEqual(pruned, [['health_events', 3]]);
  assert.deepEqual(results, { health_events: 3 });
});

test('overlapping runs are refused while one is in progress', async () => {
  let release;
  const pool = { query: () => new Promise(resolve => { release = () => resolve({ rowCount: 0 }); }) };
  const service = new RetentionService({ pool, policies: [policy()], now: () => NOW });
  const first = service.run();
  assert.equal(await service.run(), null);
  release(); await first;
});

test('table and column names must be plain identifiers', () => {
  assert.throws(() => new RetentionService({ pool: fakePool([]), policies: [policy({ table: 'inventory.discovery_runs; DROP TABLE x' })] }), /RETENTION_INVALID_IDENTIFIER/);
});

test('start and close leave no timers running', () => {
  const service = new RetentionService({ pool: fakePool([]), policies: [policy()], startDelayMs: 10_000, intervalMs: 10_000 });
  service.start(); service.start();
  assert.ok(service.timer && service.firstRun);
  service.close();
  assert.equal(service.timer, null);
});

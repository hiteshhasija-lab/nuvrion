import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresPerformanceService } from '../src/postgres-performance-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production metrics store against a real PostgreSQL: which samples are kept, how history and "latest" are read back, how
// old samples are pruned, and what the database itself refuses.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const service = db ? new PostgresPerformanceService(db.pool, { retentionMs: 60 * 60_000 }) : null;
after(async () => { await db?.drop(); });

let connection, a, b;
const seedResource = async (nativeId, resourceType = 'virtual_machine') => {
  const id = randomUUID();
  await db.pool.query("INSERT INTO inventory.resources(resource_id, connection_id, resource_type, native_id, name, lifecycle_state, health_state, observed_at, first_seen_at, last_seen_at, row_version) VALUES($1, $2, $3, $4, $4, 'active', 'healthy', now(), now(), now(), 1)", [id, connection.id, resourceType, nativeId]);
  return id;
};
beforeEach(async () => {
  if (!db) return;
  await db.pool.query('TRUNCATE monitoring.vm_metric_samples, inventory.resources, connections.provider_connections CASCADE');
  const id = randomUUID();
  await db.pool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, 'Lab', 'vmware_workstation', 'workstation_agent', 'enabled', 'healthy')", [id]);
  connection = { id };
  a = await seedResource('a.vmx'); b = await seedResource('b.vmx');
});
const at = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const obs = (nativeId, metrics, over = {}) => ({ resourceType: 'virtual_machine', nativeId, metrics, ...over });
const count = async () => (await db.pool.query('SELECT count(*)::int AS n FROM monitoring.vm_metric_samples')).rows[0].n;

test('recording stores a sample for each known resource that reported metrics, and reports how many', database, async () => {
  const recorded = await service.record(connection, [
    obs('a.vmx', { observedAt: at(1), cpuUtilizationPercent: 18.5, cpuUsageMhz: 1200.25, memoryUtilizationPercent: 42.3, memoryUsedBytes: 3633546854, memoryActiveBytes: 1000, storageUsedBytes: 5e10, networkRxBytesPerSec: 1500, networkTxBytesPerSec: 900, source: 'agent' }),
    { resourceType: 'virtual_machine', nativeId: 'b.vmx' },                              // no metrics: nothing to record
    obs('unknown.vmx', { cpuUtilizationPercent: 9 }),                                    // not in the inventory: skipped
    obs('a.vmx', { cpuUtilizationPercent: 7 }, { resourceType: 'host' })                 // same native id, other resource type: not that resource
  ]);
  assert.equal(recorded, 1);
  assert.equal(await count(), 1);
  const latest = await service.latest(a);
  assert.deepEqual({ ...latest, id: undefined, observedAt: undefined }, { id: undefined, resourceId: a, observedAt: undefined, cpuUtilizationPercent: 18.5, cpuUsageMhz: 1200.25, memoryUtilizationPercent: 42.3, memoryUsedBytes: 3633546854, memoryActiveBytes: 1000, storageUsedBytes: 5e10, networkRxBytesPerSec: 1500, networkTxBytesPerSec: 900, source: 'agent' });
  assert.equal(typeof latest.cpuUtilizationPercent, 'number', 'numeric columns come back as numbers, not strings');
  assert.equal(await service.latest(b), null);
});

test('values the provider did not report are stored as unknown, never as zero', database, async () => {
  await service.record(connection, [obs('a.vmx', { cpuUtilizationPercent: null, memoryUtilizationPercent: '', memoryUsedBytes: true, cpuUsageMhz: undefined, storageUsedBytes: 0, networkRxBytesPerSec: 0 })]);
  const s = await service.latest(a);
  assert.deepEqual([s.cpuUtilizationPercent, s.memoryUtilizationPercent, s.memoryUsedBytes, s.cpuUsageMhz], [null, null, null, null]);
  assert.deepEqual([s.storageUsedBytes, s.networkRxBytesPerSec], [0, 0], 'a reported zero is kept');
});

test('fractional byte counts and out-of-range values do not make the recording fail', database, async () => {
  await service.record(connection, [obs('a.vmx', { memoryUsedBytes: 1234.6, storageUsedBytes: 5000.5, networkRxBytesPerSec: 12.5, networkTxBytesPerSec: 0.2, cpuUtilizationPercent: 250, memoryUtilizationPercent: -3 })]);
  const s = await service.latest(a);
  assert.deepEqual([s.memoryUsedBytes, s.storageUsedBytes, s.networkRxBytesPerSec, s.networkTxBytesPerSec], [1235, 5001, 13, 0]);
  assert.deepEqual([s.cpuUtilizationPercent, s.memoryUtilizationPercent], [null, null]);
});

test('the database itself refuses an impossible sample, even if the normalisation were bypassed', database, async () => {
  const insert = over => db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, cpu_utilization_percent, memory_used_bytes, source) VALUES($1, $2, now(), $3, $4, 'test')", [randomUUID(), a, over.cpu ?? 10, over.memory ?? 100]);
  await assert.rejects(() => insert({ cpu: 101 }), error => error.code === '23514');
  await assert.rejects(() => insert({ memory: -1 }), error => error.code === '23514');
  await assert.rejects(() => db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, source) VALUES($1, $2, now(), 'test')", [randomUUID(), randomUUID()]), error => error.code === '23503', 'a sample needs a real resource');
  assert.equal(await count(), 0);
});

test('history is oldest first, limited to the window, and only for that resource', database, async () => {
  for (const minutes of [50, 40, 30, 20, 10]) await service.record(connection, [obs('a.vmx', { observedAt: at(minutes), cpuUtilizationPercent: minutes }), obs('b.vmx', { observedAt: at(minutes), cpuUtilizationPercent: 1 })]);
  assert.deepEqual((await service.history(a, { since: at(45) })).map(s => s.cpuUtilizationPercent), [40, 30, 20, 10]);
  assert.equal((await service.history(b, { since: at(60) })).length, 5);
  assert.deepEqual(await service.history(randomUUID()), []);
  assert.equal((await service.history(a)).length, 5, 'the default window is the last 24 hours');
  assert.deepEqual((await service.history(a, { since: at(60), limit: 100 })).map(s => s.cpuUtilizationPercent), [50, 40, 30, 20, 10], 'under the limit, every sample is returned');
});

// Production has about 3,300 samples per VM in 24 hours and the console asks for at most 500, so a limited history is the normal case.
const fill = (resourceId, count, spanMinutes) => db.pool.query(
  "INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, cpu_utilization_percent, source) SELECT gen_random_uuid(), $1, now() - ($3::int * interval '1 minute') * (1 - i::numeric / $2), (i % 100), 'bulk' FROM generate_series(0, $2 - 1) AS i",
  [resourceId, count, spanMinutes]);

test('a limited history covers the whole window and ends with the newest sample, never just the start of it', database, async () => {
  await fill(a, 3000, 24 * 60);                       // 3000 samples over the last 24 hours
  const all = (await db.pool.query('SELECT observed_at FROM monitoring.vm_metric_samples WHERE resource_id = $1 ORDER BY observed_at', [a])).rows.map(r => r.observed_at.getTime());
  const history = await service.history(a, { since: at(24 * 60 + 5), limit: 500 });
  assert.ok(history.length <= 500 && history.length >= 400, `about the limit, got ${history.length}`);
  const times = history.map(s => new Date(s.observedAt).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y), 'oldest first');
  assert.equal(new Set(times).size, times.length, 'no sample twice');
  assert.equal(times.at(-1), all.at(-1), 'the last sample IS the newest one');
  assert.ok(times[0] - all[0] < 5 * 60_000 * 1.5, 'it starts near the start of the window, not hours in');
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(Math.max(...gaps) < 24 * 60 * 60_000 / 500 * 3, 'samples are spread evenly across the window');
});

test('when the slices come out one more than the limit, the oldest slice is dropped, never the newest sample', database, async () => {
  // 101 samples one second apart over exactly 100 seconds, limit 10: the slices are 10 seconds wide, so the window splits into 11 of them.
  await db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, cpu_utilization_percent, source) SELECT gen_random_uuid(), $1, now() - (100 - i) * interval '1 second', i, 'edge' FROM generate_series(0, 100) AS i", [a]);
  const history = await service.history(a, { since: at(10), limit: 10 });
  assert.ok(history.length <= 10, `at most the limit, got ${history.length}`);
  assert.equal(history.at(-1).cpuUtilizationPercent, 100, 'the newest sample is always the last one');
  const times = history.map(s => new Date(s.observedAt).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

test('the metrics a console shows as "current" come from the newest sample even for a 7-day view', database, async () => {
  await fill(a, 5000, 7 * 24 * 60);
  const newest = (await db.pool.query('SELECT max(observed_at) AS t FROM monitoring.vm_metric_samples WHERE resource_id = $1', [a])).rows[0].t.getTime();
  const history = await service.history(a, { since: at(7 * 24 * 60 + 5), limit: 500 });
  assert.equal(new Date(history.at(-1).observedAt).getTime(), newest);
  assert.ok(history.length <= 500);
});

test('the limit is kept between 1 and 2000, and a limit of 1 gives the newest sample', database, async () => {
  await fill(a, 3000, 24 * 60);
  assert.equal((await service.history(a, { since: at(24 * 60 + 5), limit: 5000 })).length <= 2000, true);
  assert.equal((await service.history(a, { since: at(24 * 60 + 5), limit: 5000 })).length >= 1500, true, 'a high limit is capped at 2000, not ignored');
  const one = await service.history(a, { since: at(24 * 60 + 5), limit: 0 });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], await service.latest(a), 'limit 0 is raised to 1 and gives the newest sample');
  assert.equal((await service.history(a, { since: at(24 * 60 + 5), limit: -7 })).length, 1);
  assert.equal((await service.history(a, { since: at(24 * 60 + 5), limit: 'many' })).length, 1);
});

test('latest gives the newest sample, whatever order they were recorded in', database, async () => {
  await service.record(connection, [obs('a.vmx', { observedAt: at(5), cpuUtilizationPercent: 3 })]);
  await service.record(connection, [obs('a.vmx', { observedAt: at(20), cpuUtilizationPercent: 1 })]);   // arrives later but is older
  assert.equal((await service.latest(a)).cpuUtilizationPercent, 3);
  assert.equal(await service.latest(randomUUID()), null);
});

test('latestForResources gives one sample per resource, the newest, and leaves out resources without samples', database, async () => {
  const c = await seedResource('c.vmx');
  await service.record(connection, [obs('a.vmx', { observedAt: at(10), cpuUtilizationPercent: 1 }), obs('b.vmx', { observedAt: at(10), cpuUtilizationPercent: 2 })]);
  await service.record(connection, [obs('a.vmx', { observedAt: at(2), cpuUtilizationPercent: 3 })]);
  const latest = await service.latestForResources([a, b, c, randomUUID()]);
  assert.deepEqual(latest.map(s => [s.resourceId, s.cpuUtilizationPercent]).sort(), [[a, 3], [b, 2]].sort());
  assert.deepEqual(await service.latestForResources([]), []);
  assert.deepEqual(await service.latestForResources(undefined), []);
});

test('samples older than the retention period are pruned: on request, and after every recording', database, async () => {
  await db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, cpu_utilization_percent, source) VALUES($1, $2, now() - interval '3 hours', 1, 'old'), ($3, $2, now() - interval '30 minutes', 2, 'recent')", [randomUUID(), a, randomUUID()]);
  assert.equal(await service.prune(), 1, 'prune reports how many it removed');
  assert.equal(await count(), 1);
  await db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, cpu_utilization_percent, source) VALUES($1, $2, now() - interval '2 hours', 9, 'old')", [randomUUID(), a]);
  await service.record(connection, [obs('b.vmx', { cpuUtilizationPercent: 4 })]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM monitoring.vm_metric_samples WHERE source = 'old'")).rows[0].n, 0, 'recording pruned the stale sample');
  assert.equal(await count(), 2);
  assert.equal(await service.prune(Date.now() + 3 * 60 * 60_000), 2, 'a later "now" removes everything older than an hour before it');
});

test('the default retention is seven days', database, async () => {
  const week = new PostgresPerformanceService(db.pool);
  await db.pool.query("INSERT INTO monitoring.vm_metric_samples(sample_id, resource_id, observed_at, source) VALUES($1, $2, now() - interval '6 days', 'inside'), ($3, $2, now() - interval '8 days', 'outside')", [randomUUID(), a, randomUUID()]);
  assert.equal(await week.prune(), 1);
  assert.equal((await db.pool.query('SELECT source FROM monitoring.vm_metric_samples')).rows[0].source, 'inside');
});

test('deleting a resource deletes its samples with it', database, async () => {
  await service.record(connection, [obs('a.vmx', { cpuUtilizationPercent: 1 }), obs('b.vmx', { cpuUtilizationPercent: 2 })]);
  await db.pool.query('DELETE FROM inventory.resources WHERE resource_id = $1', [a]);
  assert.equal(await count(), 1);
  assert.equal(await service.latest(a), null);
});

test('recording from several discoveries at once loses no sample', database, async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => service.record(connection, [obs('a.vmx', { observedAt: at(i + 1), cpuUtilizationPercent: i }), obs('b.vmx', { observedAt: at(i + 1), cpuUtilizationPercent: i })])));
  assert.equal(await count(), 20);
  assert.equal((await service.history(a, { since: at(30) })).length, 10);
});

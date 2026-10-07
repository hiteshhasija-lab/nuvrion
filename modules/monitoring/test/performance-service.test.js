import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceService, normalizeMetricSample } from '../src/performance-service.js';

const RESOURCE = '00000000-0000-4000-8000-000000000001';
const sample = metric => normalizeMetricSample(RESOURCE, metric);

test('a metric sample keeps valid numbers and records where it came from', () => {
  const s = sample({ observedAt: '2026-10-06T12:00:00.000Z', cpuUtilizationPercent: 18.5, cpuUsageMhz: 1200.25, memoryUtilizationPercent: 42.3, memoryUsedBytes: 3633546854, memoryActiveBytes: 1000, storageUsedBytes: 5e10, networkRxBytesPerSec: 1500, networkTxBytesPerSec: 900, source: 'esxi' });
  assert.deepEqual({ ...s, id: undefined }, { id: undefined, resourceId: RESOURCE, observedAt: '2026-10-06T12:00:00.000Z', cpuUtilizationPercent: 18.5, cpuUsageMhz: 1200.25, memoryUtilizationPercent: 42.3, memoryUsedBytes: 3633546854, memoryActiveBytes: 1000, storageUsedBytes: 5e10, networkRxBytesPerSec: 1500, networkTxBytesPerSec: 900, source: 'esxi' });
  assert.match(s.id, /^[0-9a-f-]{36}$/);
});

test('a missing observation time becomes now, and the source defaults to provider and is cut to 32 characters', () => {
  const before = Date.now(), s = sample({});
  assert.ok(Date.parse(s.observedAt) >= before - 5 && Date.parse(s.observedAt) <= Date.now() + 5);
  assert.equal(s.source, 'provider');
  assert.equal(sample({ source: 'x'.repeat(50) }).source.length, 32);
});

test('a value that is out of range or not a number is recorded as unknown, never clamped or guessed', () => {
  const s = sample({ cpuUtilizationPercent: 101, memoryUtilizationPercent: -1, memoryUsedBytes: -5, storageUsedBytes: 'lots', networkRxBytesPerSec: NaN, networkTxBytesPerSec: Infinity, cpuUsageMhz: {} });
  for (const field of ['cpuUtilizationPercent', 'memoryUtilizationPercent', 'memoryUsedBytes', 'storageUsedBytes', 'networkRxBytesPerSec', 'networkTxBytesPerSec', 'cpuUsageMhz']) assert.equal(s[field], null, field);
  assert.equal(sample({ cpuUtilizationPercent: 0 }).cpuUtilizationPercent, 0, 'a real zero is kept');
  assert.equal(sample({ cpuUtilizationPercent: 100 }).cpuUtilizationPercent, 100, 'the limits themselves are valid');
  assert.equal(sample({ cpuUtilizationPercent: '12.5' }).cpuUtilizationPercent, 12.5, 'a numeric string is accepted');
});

test('"not reported" stays unknown: null, an empty string and a boolean are not turned into 0 or 1', () => {
  const s = sample({ cpuUtilizationPercent: null, memoryUtilizationPercent: '', memoryUsedBytes: true, storageUsedBytes: false, networkRxBytesPerSec: '   ', cpuUsageMhz: undefined });
  for (const field of ['cpuUtilizationPercent', 'memoryUtilizationPercent', 'memoryUsedBytes', 'storageUsedBytes', 'networkRxBytesPerSec', 'cpuUsageMhz']) assert.equal(s[field], null, `${field} must be unknown, not a number`);
});

test('byte counts are whole numbers, because they are stored as integers; percentages and MHz keep their decimals', () => {
  const s = sample({ memoryUsedBytes: 1234.6, memoryActiveBytes: 99.4, storageUsedBytes: 5000.5, networkRxBytesPerSec: 12.5, networkTxBytesPerSec: 0.4, cpuUtilizationPercent: 33.333, cpuUsageMhz: 812.75 });
  assert.deepEqual([s.memoryUsedBytes, s.memoryActiveBytes, s.storageUsedBytes, s.networkRxBytesPerSec, s.networkTxBytesPerSec], [1235, 99, 5001, 13, 0]);
  assert.deepEqual([s.cpuUtilizationPercent, s.cpuUsageMhz], [33.333, 812.75]);
});

// ---- the in-memory service (used outside production) ----
const connection = { id: 'c1' };
const resources = [{ id: 'r-a', nativeId: 'a' }, { id: 'r-b', nativeId: 'b' }];
const at = (minutesAgo, now = Date.now()) => new Date(now - minutesAgo * 60_000).toISOString();

test('recording keeps samples only for known resources that reported metrics', async () => {
  const service = new PerformanceService();
  const recorded = await service.record(connection, [{ nativeId: 'a', metrics: { cpuUtilizationPercent: 5 } }, { nativeId: 'b' }, { nativeId: 'unknown', metrics: { cpuUtilizationPercent: 9 } }], resources);
  assert.equal(recorded.length, 1);
  assert.equal(service.latest('r-a').cpuUtilizationPercent, 5);
  assert.equal(service.latest('r-b'), null);
});

test('history is oldest first, limited to the window and to between 1 and 2000 samples, and per resource', async () => {
  const service = new PerformanceService();
  for (const minutes of [50, 40, 30, 20, 10]) await service.record(connection, [{ nativeId: 'a', metrics: { observedAt: at(minutes), cpuUtilizationPercent: minutes } }, { nativeId: 'b', metrics: { observedAt: at(minutes), cpuUtilizationPercent: 1 } }], resources);
  assert.deepEqual(service.history('r-a', { since: at(45) }).map(s => s.cpuUtilizationPercent), [40, 30, 20, 10]);
  assert.deepEqual(service.history('r-a', { since: at(60), limit: 2 }).map(s => s.cpuUtilizationPercent), [20, 10], 'the newest samples when limited');
  assert.equal(service.history('r-a', { since: at(60), limit: 0 }).length, 1, 'a limit below 1 is raised to 1');
  assert.equal(service.history('r-b', { since: at(60) }).length, 5);
  assert.deepEqual(service.history('nobody'), []);
});

test('latest and latestForResources give the newest sample of each resource', async () => {
  const service = new PerformanceService();
  await service.record(connection, [{ nativeId: 'a', metrics: { observedAt: at(10), cpuUtilizationPercent: 1 } }, { nativeId: 'b', metrics: { observedAt: at(10), cpuUtilizationPercent: 2 } }], resources);
  await service.record(connection, [{ nativeId: 'a', metrics: { observedAt: at(5), cpuUtilizationPercent: 3 } }], resources);
  assert.equal(service.latest('r-a').cpuUtilizationPercent, 3);
  assert.deepEqual(service.latestForResources(['r-a', 'r-b', 'r-none']).map(s => [s.resourceId, s.cpuUtilizationPercent]).sort(), [['r-a', 3], ['r-b', 2]]);
  assert.deepEqual(service.latestForResources([]), []);
});

test('samples older than the retention period are pruned, on request and after every recording', async () => {
  const service = new PerformanceService({ retentionMs: 60 * 60_000 });
  await service.record(connection, [{ nativeId: 'a', metrics: { observedAt: at(120), cpuUtilizationPercent: 1 } }, { nativeId: 'a', metrics: { observedAt: at(30), cpuUtilizationPercent: 2 } }], [{ id: 'r-a', nativeId: 'a' }]);
  assert.deepEqual(service.history('r-a', { since: at(300) }).map(s => s.cpuUtilizationPercent), [2], 'the two-hour-old sample went when the new one was recorded');
  assert.equal(service.prune(Date.now() + 2 * 60 * 60_000), 1, 'prune reports how many it removed');
  assert.equal(service.latest('r-a'), null);
});

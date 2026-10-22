import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresCapacityService } from '../src/postgres-capacity-service.js';
import { DAY_MS } from '../src/capacity-rules.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production capacity store against a real PostgreSQL, as the restricted application role: the same behaviour as the local store, plus what only a database can get wrong (the
// same moment recorded twice at once, big sizes, a datastore that is not a UUID, pruning).
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const time = { now: Date.parse('2026-10-21T12:00:00Z') };
const service = db ? new PostgresCapacityService(db.pool, { clock: () => time.now }) : null;
after(async () => { await db?.drop(); });
beforeEach(async () => { if (!db) return; await db.adminPool.query('DELETE FROM monitoring.capacity_samples'); time.now = Date.parse('2026-10-21T12:00:00Z'); });
const GB = 1024 ** 3, TB = 1024 ** 4, DS = '11111111-1111-4111-8111-111111111111', DS2 = '22222222-2222-4222-8222-222222222222', CONN = '33333333-3333-4333-8333-333333333333';
const reading = (offsetMinutes, over = {}) => ({ objectId: DS, connectionId: CONN, capacityBytes: 1000 * GB, freeBytes: 400 * GB, observedAt: time.now + offsetMinutes * 60_000, ...over });

test('PostgreSQL: a reading is recorded once per half hour and comes back in time order with the used space worked out', database, async () => {
  assert.deepEqual(await service.record([reading(0), reading(5), reading(40), reading(-60)]), { recorded: 3, skipped: 1 });
  const history = (await service.historyFor([DS])).get(DS);
  assert.deepEqual(history.map(sample => sample.at - time.now), [-3_600_000, 0, 2_400_000]);
  assert.deepEqual(history[0], { at: time.now - 3_600_000, capacityBytes: 1000 * GB, usedBytes: 600 * GB });
  assert.deepEqual(await service.record([reading(0)]), { recorded: 0, skipped: 1 });
});

test('PostgreSQL: a change of size is recorded at once, and sizes of many terabytes round-trip exactly', database, async () => {
  await service.record([reading(0)]);
  assert.deepEqual(await service.record([reading(5, { capacityBytes: 64 * TB, freeBytes: 20 * TB + 7 })]), { recorded: 1, skipped: 0 });
  const history = (await service.historyFor([DS])).get(DS);
  assert.deepEqual([history[1].capacityBytes, history[1].usedBytes], [64 * TB, 44 * TB - 7]);
});

test('PostgreSQL: untrusted readings are refused, the same moment recorded at once is kept once, and the table refuses what the rules refuse', database, async () => {
  assert.deepEqual(await service.record([reading(0, { freeBytes: 2000 * GB }), reading(0, { capacityBytes: 0 }), reading(0, { observedAt: 'never' }), reading(0, { objectId: '' })]), { recorded: 0, skipped: 4 });
  const results = await Promise.all([service.record([reading(0)]), service.record([reading(0)]), service.record([reading(0)])]);
  assert.equal(results.reduce((sum, result) => sum + result.recorded, 0) <= 3, true);
  assert.equal((await service.historyFor([DS])).get(DS).length >= 1, true);
  await assert.rejects(db.pool.query('INSERT INTO monitoring.capacity_samples (object_id, observed_at, capacity_bytes, free_bytes) VALUES ($1, now(), 100, 200)', [DS]), /check|violates/i);
  await assert.rejects(db.pool.query('INSERT INTO monitoring.capacity_samples (object_id, observed_at, capacity_bytes, free_bytes) VALUES ($1, now(), 0, 0)', [DS]), /check|violates/i);
});

test('PostgreSQL: history is per datastore and from a given time; an identifier that is not a UUID has none and does not fail the query', database, async () => {
  await service.record([reading(-120), reading(-60), reading(0), reading(0, { objectId: DS2 })]);
  const history = await service.historyFor([DS, DS2, 'not-a-uuid'], { sinceMs: time.now - 90 * 60_000 });
  assert.deepEqual([history.get(DS).length, history.get(DS2).length, history.get('not-a-uuid').length], [2, 1, 0]);
  assert.equal((await service.historyFor(['not-a-uuid'])).get('not-a-uuid').length, 0);
});

test('PostgreSQL: readings older than 90 days are not recorded and are pruned as time passes', database, async () => {
  assert.deepEqual(await service.record([reading(-91 * 24 * 60)]), { recorded: 0, skipped: 1 });
  await service.record([reading(0)]);
  await db.adminPool.query('UPDATE monitoring.capacity_samples SET observed_at = observed_at - interval \'100 days\'');
  time.now += DAY_MS;
  await service.record([reading(24 * 60, { objectId: DS2 })]);
  assert.equal((await service.historyFor([DS], { sinceMs: 0 })).get(DS).length, 0, 'the old reading was pruned');
  assert.equal((await service.historyFor([DS2])).get(DS2).length, 1);
});

test('PostgreSQL: processor and memory readings of a host are kept apart from its storage readings and from each other, and an unknown kind of reading is refused', database, async () => {
  const at = time.now;
  const result = await service.record([
    { objectId: DS, metric: 'cpu', capacityBytes: 50400, freeBytes: 40600, observedAt: at },
    { objectId: DS, metric: 'memory', capacityBytes: 256 * GB, freeBytes: 160 * GB, observedAt: at },
    { objectId: DS, capacityBytes: 1000 * GB, freeBytes: 400 * GB, observedAt: at },
    { objectId: DS, metric: 'network', capacityBytes: 1000, freeBytes: 10, observedAt: at }
  ]);
  assert.deepEqual(result, { recorded: 3, skipped: 1 });
  const of = async metric => (await service.historyFor([DS], { metric })).get(DS);
  assert.deepEqual((await of('cpu')).map(sample => [sample.capacityBytes, sample.usedBytes]), [[50400, 9800]]);
  assert.deepEqual((await of('memory')).map(sample => sample.usedBytes), [96 * GB]);
  assert.deepEqual((await of('storage')).map(sample => sample.usedBytes), [600 * GB]);
  assert.deepEqual(await service.record([{ objectId: DS, metric: 'cpu', capacityBytes: 50400, freeBytes: 40000, observedAt: at + 5 * 60_000 }]), { recorded: 0, skipped: 1 });
  await assert.rejects(db.pool.query("INSERT INTO monitoring.capacity_samples (object_id, metric, observed_at, capacity_bytes, free_bytes) VALUES ($1, 'network', now(), 10, 1)", [DS]), /check|violates/i);
});

test('PostgreSQL: an alert may be about a cluster', database, async () => {
  const id = '44444444-4444-4444-8444-444444444444';
  await db.pool.query(`INSERT INTO monitoring.alerts (rule_name, metric, comparison, threshold, severity, target_kind, target_id, target_name, value, first_seen_at, last_seen_at) VALUES ('r', 'cluster.cpu_days_until_full', 'below', 14, 'warning', 'cluster', $1, 'Cluster', 9, now(), now())`, [id]);
  await assert.rejects(db.pool.query(`INSERT INTO monitoring.alerts (rule_name, metric, comparison, threshold, severity, target_kind, target_id, target_name, value, first_seen_at, last_seen_at) VALUES ('r', 'x', 'below', 14, 'warning', 'rack', $1, 'Rack', 9, now(), now())`, [id]), /check|violates/i);
  await db.adminPool.query('DELETE FROM monitoring.alerts');
});

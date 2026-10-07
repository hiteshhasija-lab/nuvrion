import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RETENTION_TABLES, RetentionService, retentionPoliciesFromEnv } from '../src/retention-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The pruning job against a real PostgreSQL: what it deletes, what it must never delete, in batches, with the real window-function query.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
after(async () => { await db?.drop(); });

const NOW = Date.parse('2026-10-06T00:00:00Z');
const DAY = 86_400_000;
const seedConnection = async () => {
  const id = randomUUID();
  await db.pool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, $2, 'vmware_workstation', 'workstation_agent', 'enabled', 'healthy')", [id, `Lab ${id.slice(0, 8)}`]);
  return id;
};
// n rows for a connection, the i-th (1 = newest) `startDay + (i - 1) * stepDays` days before NOW.
const runs = (connection, n, { startDay = 1, stepDays = 1 } = {}) => db.pool.query(
  "INSERT INTO inventory.discovery_runs(discovery_run_id, connection_id, status, started_at) SELECT gen_random_uuid(), $1, 'completed', $2::timestamptz - (($3::numeric + (i - 1) * $4::numeric) * interval '1 day') FROM generate_series(1, $5::int) AS i",
  [connection, new Date(NOW).toISOString(), startDay, stepDays, n]);
const events = (connection, n, { startDay = 1, stepDays = 1 } = {}) => db.pool.query(
  "INSERT INTO connections.health_events(event_id, connection_id, check_type, outcome, duration_ms, checked_at) SELECT gen_random_uuid(), $1, 'scheduled_discovery', 'succeeded', 5, $2::timestamptz - (($3::numeric + (i - 1) * $4::numeric) * interval '1 day') FROM generate_series(1, $5::int) AS i",
  [connection, new Date(NOW).toISOString(), startDay, stepDays, n]);
const count = async (table, connection) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table} ${connection ? 'WHERE connection_id = $1' : ''}`, connection ? [connection] : [])).rows[0].n;
const service = (over = {}) => new RetentionService({ pool: db.pool, policies: RETENTION_TABLES.map(t => ({ ...t, days: t.name === 'discovery_runs' ? 30 : 90 })), now: () => NOW, ...over });
const both = (discoveryRuns, healthEvents = 0) => ({ discovery_runs: discoveryRuns, health_events: healthEvents });
beforeEach(async () => { if (db) await db.pool.query('TRUNCATE inventory.discovery_runs, connections.health_events'); });

test('old rows beyond the newest 100 per connection are deleted; the newest 100 stay even when they are older than the cutoff', database, async () => {
  const c = await seedConnection();
  await runs(c, 250);                               // 1 to 250 days old
  const results = await service().run();
  assert.equal(results.discovery_runs, 150, 'ranks 101 to 250, all older than 30 days');
  assert.equal(await count('inventory.discovery_runs', c), 100);
  const oldest = (await db.pool.query('SELECT min(started_at) AS t FROM inventory.discovery_runs')).rows[0].t.getTime();
  assert.equal(Math.round((NOW - oldest) / DAY), 100, 'what is left is exactly the newest 100, the oldest of them 100 days old');
});

test('a connection that has been dead for months keeps its history, so it still shows how it last failed', database, async () => {
  const dead = await seedConnection(), live = await seedConnection();
  await runs(dead, 20, { startDay: 200 });          // 20 runs, all 200+ days old
  await runs(live, 150);
  await service().run();
  assert.equal(await count('inventory.discovery_runs', dead), 20, 'under the keep limit, so nothing goes however old');
  assert.ok(await count('inventory.discovery_runs', live) <= 100 + 30, 'the busy one is trimmed');
});

test('recent rows are never deleted, however many there are', database, async () => {
  const c = await seedConnection();
  await runs(c, 150, { startDay: 0.01, stepDays: 0.05 });   // 150 runs within the last week
  assert.deepEqual(await service().run(), both(0));
  assert.equal(await count('inventory.discovery_runs', c), 150);
});

test('each connection is trimmed on its own: one connection\'s rows never push another\'s out', database, async () => {
  const a = await seedConnection(), b = await seedConnection();
  await runs(a, 120, { startDay: 40 });             // all older than the cutoff
  await runs(b, 120, { startDay: 40 });
  await service().run();
  assert.equal(await count('inventory.discovery_runs', a), 100);
  assert.equal(await count('inventory.discovery_runs', b), 100);
});

test('the cutoff is strict: a row exactly at the cutoff is kept, one a moment older goes', database, async () => {
  const c = await seedConnection();
  await runs(c, 100, { startDay: 1, stepDays: 0.04 });   // the newest 100 rows, all within 5 days: protected by the keep limit
  const cutoff = new Date(NOW - 30 * DAY);
  await db.pool.query("INSERT INTO inventory.discovery_runs(discovery_run_id, connection_id, status, started_at) VALUES(gen_random_uuid(), $1, 'completed', $2), (gen_random_uuid(), $1, 'completed', $3)", [c, cutoff, new Date(cutoff.getTime() - 1000)]);
  assert.deepEqual(await service().run(), both(1));
  const left = (await db.pool.query('SELECT started_at FROM inventory.discovery_runs WHERE connection_id = $1 AND started_at <= $2', [c, cutoff])).rows.map(r => r.started_at.getTime());
  assert.ok(left.includes(cutoff.getTime()), 'the row exactly at the cutoff stayed');
  assert.ok(!left.includes(cutoff.getTime() - 1000), 'the older one was deleted');
});

test('rows with identical times are still trimmed to exactly the keep limit', database, async () => {
  const c = await seedConnection();
  await db.pool.query("INSERT INTO inventory.discovery_runs(discovery_run_id, connection_id, status, started_at) SELECT gen_random_uuid(), $1, 'completed', $2 FROM generate_series(1, 150)", [c, new Date(NOW - 60 * DAY)]);
  assert.deepEqual(await service().run(), both(50));
  assert.equal(await count('inventory.discovery_runs', c), 100);
});

test('both history tables are pruned in one run with their own ages, and each reports what it removed', database, async () => {
  const c = await seedConnection(), reported = [];
  await runs(c, 130, { startDay: 31 });             // 31 to 160 days old: past the 30-day policy
  await events(c, 130, { startDay: 31 });           // the same ages: only those past 90 days are due
  const results = await service({ onPruned: (name, rows) => reported.push([name, rows]) }).run();
  assert.deepEqual(results, both(30, 30), 'ranks 101 to 130 are old enough in both');
  assert.equal(await count('connections.health_events', c), 100);
  assert.deepEqual(reported, [['discovery_runs', 30], ['health_events', 30]]);
  const events2 = await seedConnection();
  await events(events2, 150, { startDay: 91 });     // all older than 90 days
  assert.deepEqual((await service().run()).health_events, 50, 'the newest 100 are kept even though all 150 are past the policy');
});

test('a large backlog is deleted in batches until nothing is left to delete', database, async () => {
  const c = await seedConnection();
  await db.pool.query("INSERT INTO inventory.discovery_runs(discovery_run_id, connection_id, status, started_at) SELECT gen_random_uuid(), $1, 'completed', $2::timestamptz - (i * interval '1 minute') FROM generate_series(1, 12100) AS i", [c, new Date(NOW - 60 * DAY).toISOString()]);
  const started = Date.now();
  assert.deepEqual(await service().run(), both(12000), 'the default batch is 5000, so 5000 + 5000 + 2000');
  assert.equal(await count('inventory.discovery_runs', c), 100);
  assert.ok(Date.now() - started < 20_000, 'a first run over a large backlog finishes quickly');
});

test('an exact multiple of the batch size ends with an empty batch, and loses nothing', database, async () => {
  const c = await seedConnection(), seen = [];
  await runs(c, 100 + 40, { startDay: 31 });
  const counting = new RetentionService({ pool: { query: async (sql, params) => { const r = await db.pool.query(sql, params); seen.push(r.rowCount); return r; } }, policies: [{ ...RETENTION_TABLES[0], days: 30 }], now: () => NOW, batchSize: 20 });
  assert.deepEqual(await counting.run(), { discovery_runs: 40 });
  assert.deepEqual(seen, [20, 20, 0], 'two full batches, then one that finds nothing');
  assert.equal(await count('inventory.discovery_runs', c), 100);
});

test('a second run finds nothing more to delete, and a disabled policy deletes nothing', database, async () => {
  const c = await seedConnection();
  await runs(c, 200, { startDay: 31 });
  assert.equal((await service().run()).discovery_runs, 100);
  assert.deepEqual(await service().run(), both(0));
  await runs(c, 50, { startDay: 400 });
  const off = new RetentionService({ pool: db.pool, policies: RETENTION_TABLES.map(t => ({ ...t, days: 0 })), now: () => NOW });
  assert.deepEqual(await off.run(), {});
  assert.equal(await count('inventory.discovery_runs', c), 150, 'nothing deleted while it is turned off');
});

test('two instances pruning the same data at the same moment never delete into the protected rows, and cause no error', database, async () => {
  const c = await seedConnection(), errors = [];
  await runs(c, 3000, { startDay: 31, stepDays: 0.01 });
  await Promise.all([service({ batchSize: 500, onError: e => errors.push(e.message) }).run(), service({ batchSize: 500, onError: e => errors.push(e.message) }).run()]);
  assert.deepEqual(errors.filter(message => !/deadlock/i.test(message)), [], 'no error other than a possible deadlock between the two');
  assert.ok(await count('inventory.discovery_runs', c) >= 100, 'the newest 100 are never touched, even when two jobs overlap');
  await service().run();
  assert.equal(await count('inventory.discovery_runs', c), 100, 'a later run settles any leftover to exactly the newest 100');
});

test('the policies built from the environment work against the real tables', database, async () => {
  const c = await seedConnection();
  await runs(c, 120, { startDay: 8 });              // 8 to 127 days old
  const policies = retentionPoliciesFromEnv({ NUVRION_RETENTION_DISCOVERY_DAYS: '7', NUVRION_RETENTION_HEALTH_EVENTS_DAYS: '0' });
  const job = new RetentionService({ pool: db.pool, policies, now: () => NOW });
  assert.deepEqual(await job.run(), { discovery_runs: 20 });
});

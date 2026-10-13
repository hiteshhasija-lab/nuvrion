import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessService } from '../src/readiness-service.js';
import { latestMigrationVersion } from '../src/migrations.js';

// What makes the platform ready: a database that has recorded the newest migration that ships, a healthy broker, a running worker, the agent sweeper.
const healthy = { status: 'healthy' };
const store = ({ version = '0029', fail = false } = {}) => ({ status: 'healthy', pool: { query: async sql => {
  if (fail) throw new Error('connection refused');
  if (/schema_migrations/.test(sql)) return { rows: [{ version }] };
  return { rows: [{ '?column?': 1 }] };
} } });
const service = (over = {}) => new ReadinessService({ production: true, store: store(), broker: healthy, worker: healthy, agentMaintenance: { timer: {} }, requiredMigration: '0029', ...over });

test('it will not be built without the required migration, so a forgotten constant cannot pass for a check', () => {
  for (const bad of [undefined, null, '', '29', 'latest', '00029']) assert.throws(() => service({ requiredMigration: bad }), /required migration/);
});

test('ready when the newest recorded migration is the required one, or a later one', async () => {
  assert.deepEqual(await service().check(), { status: 'ready', components: { database: 'healthy', broker: 'healthy', worker: 'healthy', agentMaintenance: 'healthy', migrations: 'current' }, issues: [] });
  assert.equal((await service({ store: store({ version: '0030' }) }).check()).status, 'ready');
});

test('not ready when the database has not recorded the required migration, and it says what it has', async () => {
  const result = await service({ store: store({ version: '0028' }) }).check();
  assert.equal(result.status, 'not_ready');
  assert.equal(result.components.migrations, 'outdated');
  assert.deepEqual(result.issues, ['Required migration 0029 is not applied (newest recorded: 0028).']);
});

test('an empty ledger is not ready either (a database from before the ledger)', async () => {
  const result = await service({ store: store({ version: null }) }).check();
  assert.equal(result.status, 'not_ready');
  assert.match(result.issues[0], /newest recorded: none/);
});

test('a database that cannot be reached marks the store unhealthy', async () => {
  const unreachable = store({ fail: true });
  const result = await service({ store: unreachable }).check();
  assert.equal(result.status, 'not_ready');
  assert.equal(result.components.database, 'unhealthy');
  assert.equal(unreachable.status, 'unhealthy');
  assert.deepEqual(result.issues, ['Database readiness check failed.']);
});

test('an unhealthy broker, a stopped worker and a stopped agent sweeper each make it not ready', async () => {
  const result = await service({ broker: { status: 'unhealthy' }, worker: { status: 'stopped' }, agentMaintenance: { timer: null } }).check();
  assert.equal(result.status, 'not_ready');
  assert.deepEqual(result.issues, ['Task broker is not healthy.', 'Worker is not healthy.', 'Agent maintenance scheduler is not running.']);
});

test('outside production the database is not consulted', async () => {
  let queried = false;
  const result = await service({ production: false, store: { pool: { query: async () => { queried = true; return { rows: [] }; } } } }).check();
  assert.equal(queried, false);
  assert.equal(result.status, 'ready');
});

test('the API is wired to the newest migration that ships, not to a constant', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../../../apps/api/src/server.js', import.meta.url), 'utf8');
  assert.match(server, /requiredMigration:\s*latestMigrationVersion\(\)/);
  assert.doesNotMatch(server, /requiredMigration:\s*'\d{4}'/);
  assert.match(latestMigrationVersion(), /^\d{4}$/);
});

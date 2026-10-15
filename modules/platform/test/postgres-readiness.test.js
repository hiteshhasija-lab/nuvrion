import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessService } from '../src/readiness-service.js';
import { latestMigrationVersion, migrationVersions } from '../src/migrations.js';
import { applyMigrations, createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The ledger against a real PostgreSQL: migrations record themselves, and readiness follows the ledger.
const database = { skip: skipDatabaseTests };
const healthy = { status: 'healthy' };
const readinessFor = db => new ReadinessService({ production: true, store: { status: 'healthy', pool: db.pool }, broker: healthy, worker: healthy, agentMaintenance: { timer: {} }, requiredMigration: latestMigrationVersion() });

test('after every migration the ledger holds each of them, with the checksum of its file, and the platform is ready', database, async () => {
  const db = await createTestDatabase();
  try {
    const rows = (await db.pool.query('SELECT version, description, checksum FROM platform.schema_migrations ORDER BY version')).rows;
    assert.deepEqual(rows.map(row => row.version), migrationVersions());
    assert.ok(rows.every(row => row.description && row.checksum));
    assert.equal((await readinessFor(db).check()).status, 'ready');
  } finally { await db.drop(); }
});

test('a database one migration behind is not ready until that migration is applied, and applying it twice changes nothing', database, async () => {
  const db = await createTestDatabase({ migrate: false });
  try {
    const versions = migrationVersions();
    const last = Number(versions.at(-1));
    await applyMigrations(db.pool, { upTo: last - 1 });
    const before = await readinessFor(db).check();
    assert.equal(before.status, 'not_ready');
    assert.equal(before.components.migrations, 'outdated');
    await applyMigrations(db.pool, { from: last });
    assert.equal((await readinessFor(db).check()).status, 'ready');
    const count = Number((await db.pool.query('SELECT count(*) FROM platform.schema_migrations')).rows[0].count);
    await applyMigrations(db.pool, { from: last });
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM platform.schema_migrations')).rows[0].count), count, 'idempotent');
  } finally { await db.drop(); }
});

test('removing the newest row from the ledger makes the platform not ready again', database, async () => {
  const db = await createTestDatabase();
  try {
    await db.adminPool.query('DELETE FROM platform.schema_migrations WHERE version = $1', [latestMigrationVersion()]);   // the application role cannot write the ledger
    const result = await readinessFor(db).check();
    assert.equal(result.status, 'not_ready');
    assert.match(result.issues[0], /not applied/);
  } finally { await db.drop(); }
});

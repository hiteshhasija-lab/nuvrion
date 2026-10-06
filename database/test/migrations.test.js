import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyMigrations, createTestDatabase, databaseRequired, migrationFiles, skipDatabaseTests } from '../test-support/test-database.js';

const database = { skip: skipDatabaseTests };
const databases = [];
const fresh = async options => { const db = await createTestDatabase(options); databases.push(db); return db; };
after(async () => { for (const db of databases) await db.drop(); });

test('the database tests are not silently skipped where they are required (CI)', () => {
  if (databaseRequired) assert.ok(!skipDatabaseTests, `NUVRION_REQUIRE_DATABASE_TESTS=1 but ${skipDatabaseTests}`);
});

test('migrations are numbered 0001, 0002, … with no gaps or duplicates', async () => {
  const files = await migrationFiles();
  assert.ok(files.length > 0);
  files.forEach((file, index) => assert.equal(file.slice(0, 4), String(index + 1).padStart(4, '0'), `${file} is out of sequence`));
});

test('every migration applies, in order, to an empty PostgreSQL database', database, async () => {
  const db = await fresh({ migrate: false });
  const applied = await applyMigrations(db.pool);
  assert.deepEqual(applied, await migrationFiles());
});

test('the tables and indexes the code relies on exist after a clean install', database, async () => {
  const { pool } = await fresh();
  const tables = (await pool.query("SELECT table_schema || '.' || table_name AS name FROM information_schema.tables")).rows.map(row => row.name);
  for (const table of ['operations.tasks', 'operations.task_attempts', 'operations.task_leases', 'operations.outbox_messages', 'audit.audit_events', 'identity.users', 'connections.provider_connections']) {
    assert.ok(tables.includes(table), `${table} is missing`);
  }
  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'operations'")).rows.map(row => row.indexname);
  for (const index of ['ux_tasks_idempotency', 'ix_tasks_status_queued', 'ix_tasks_retry_due', 'ix_outbox_unpublished']) {
    assert.ok(indexes.includes(index), `${index} is missing`);
  }
});

test('the schema itself refuses an unknown task status and a repeated idempotency key', database, async () => {
  const { pool } = await fresh();
  const insert = (status, hash) => pool.query(
    'INSERT INTO operations.tasks(task_id, operation, status, target_id, correlation_id, queued_at, idempotency_key_hash) VALUES($1, $2, $3, $4, $5, now(), $6)',
    [randomUUID(), 'start', status, 'vm-1', randomUUID(), hash]
  );
  await assert.rejects(() => insert('exploded', 'a'.repeat(64)), error => error.code === '23514', 'check constraint on status');
  await insert('queued', 'b'.repeat(64));
  await assert.rejects(() => insert('queued', 'b'.repeat(64)), error => error.code === '23505', 'unique idempotency key');
});

test('upgrading from an earlier release keeps existing task data and applies the later migrations', database, async () => {
  const { pool } = await fresh({ migrate: false });
  await applyMigrations(pool, { upTo: 5 });
  const id = randomUUID();
  await pool.query(
    "INSERT INTO operations.tasks(task_id, operation, status, target_id, correlation_id, queued_at) VALUES($1, 'stop', 'queued', 'vm-old', $2, now())",
    [id, randomUUID()]
  );
  await applyMigrations(pool, { from: 6 });
  const row = (await pool.query('SELECT * FROM operations.tasks WHERE task_id = $1', [id])).rows[0];
  assert.equal(row.operation, 'stop');
  assert.equal(row.retry_at, null, 'columns added later start empty');
  assert.equal(row.target_type, 'virtual_machine', 'columns added later take their defaults');
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestDatabase, skipDatabaseTests, applicationTestRole } from '../test-support/test-database.js';

// The application connects as a login role that belongs to the nuvrion_app group role (migration 0031), never as the owner. These tests pin what that role may
// and may not do, against a real PostgreSQL, so a table added later without the grants (or a change that quietly widens them) shows up here.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
after(async () => { await db?.drop(); });

const APPLICATION_SCHEMAS = ['agents', 'connections', 'identity', 'inventory', 'monitoring', 'operations'];
const tables = async () => (await db.adminPool.query(
  `SELECT schemaname || '.' || tablename AS name, schemaname FROM pg_tables WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema' ORDER BY 1`)).rows;
const can = async (role, table, privilege) => (await db.adminPool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, table, privilege])).rows[0].ok;

test('the application group role is not a superuser and cannot create databases, roles or log in by itself', database, async () => {
  const group = (await db.adminPool.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'nuvrion_app'")).rows[0];
  assert.deepEqual(group, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: false, rolreplication: false, rolbypassrls: false });
});

test('every table is either an operational table (read and write), the append-only audit trail, or the read-only migration ledger', database, async () => {
  const all = await tables();
  assert.ok(all.length >= 28, 'the schema has its tables');
  for (const { name, schemaname } of all) {
    const rights = { select: await can('nuvrion_app', name, 'SELECT'), insert: await can('nuvrion_app', name, 'INSERT'), update: await can('nuvrion_app', name, 'UPDATE'),
      delete: await can('nuvrion_app', name, 'DELETE'), truncate: await can('nuvrion_app', name, 'TRUNCATE'), references: await can('nuvrion_app', name, 'REFERENCES'), trigger: await can('nuvrion_app', name, 'TRIGGER') };
    const expected = APPLICATION_SCHEMAS.includes(schemaname) ? { select: true, insert: true, update: true, delete: true }
      : schemaname === 'audit' ? { select: true, insert: true, update: false, delete: false }
      : schemaname === 'platform' ? { select: true, insert: false, update: false, delete: false }
      : assert.fail(`${name} is in a schema (${schemaname}) that the application role has no rule for; extend migration 0031 and this test`);
    assert.deepEqual({ select: rights.select, insert: rights.insert, update: rights.update, delete: rights.delete }, expected, name);
    assert.deepEqual([rights.truncate, rights.references, rights.trigger], [false, false, false], `${name}: no truncate, references or trigger rights`);
  }
});

test('the login role the services run as can use the application but cannot change the audit trail, the ledger or the schema', database, async () => {
  const me = (await db.pool.query('SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super')).rows[0];
  assert.deepEqual(me, { who: applicationTestRole, super: false });
  await db.pool.query("INSERT INTO audit.audit_events(audit_event_id, occurred_at, actor_type, actor_id, action, target_type, target_id, correlation_id, outcome, detail) VALUES (gen_random_uuid(), now(), 'system', NULL, 'role.test', 'platform', NULL, gen_random_uuid(), 'succeeded', '{}')");
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM audit.audit_events WHERE action = 'role.test'")).rows[0].count), 1);
  const refused = async sql => assert.rejects(db.pool.query(sql), error => error.code === '42501', `${sql} must be refused with insufficient_privilege (got ${'?'})`);
  await refused("UPDATE audit.audit_events SET outcome = 'failed' WHERE action = 'role.test'");
  await refused("DELETE FROM audit.audit_events WHERE action = 'role.test'");
  await refused("INSERT INTO platform.schema_migrations(version, description, checksum) VALUES ('9999', 'x', 'y')");
  await refused("DELETE FROM platform.schema_migrations");
  await refused('CREATE TABLE operations.should_not_exist(id int)');
  await refused('DROP TABLE operations.tasks');
  await refused('ALTER TABLE operations.tasks ADD COLUMN sneaky int');
  await refused('CREATE SCHEMA sneaky');
  await refused("COPY (SELECT 1) TO PROGRAM 'true'");
  await refused("SELECT pg_read_file('/etc/passwd')");
  await refused("CREATE ROLE sneaky LOGIN");
  assert.equal(Number((await db.adminPool.query("SELECT count(*) FROM audit.audit_events WHERE action = 'role.test'")).rows[0].count), 1, 'the audit row is still there');
});

test('a table that a later migration adds is usable by the application, with the same rule for its schema, without another grant', database, async () => {
  await db.adminPool.query('CREATE TABLE operations.later_table (id int PRIMARY KEY, note text)');
  await db.adminPool.query('CREATE TABLE audit.later_audit_table (id int PRIMARY KEY)');
  try {
    assert.deepEqual([await can('nuvrion_app', 'operations.later_table', 'SELECT'), await can('nuvrion_app', 'operations.later_table', 'DELETE')], [true, true]);
    assert.deepEqual([await can('nuvrion_app', 'audit.later_audit_table', 'INSERT'), await can('nuvrion_app', 'audit.later_audit_table', 'UPDATE')], [true, false]);
    await db.pool.query("INSERT INTO operations.later_table VALUES (1, 'x')");
  } finally {
    await db.adminPool.query('DROP TABLE operations.later_table');
    await db.adminPool.query('DROP TABLE audit.later_audit_table');
  }
});

test('the migration is repeatable: applying it again changes no right and records nothing twice', database, async () => {
  const sql = await readFile(new URL('../migrations/0031_application_role.sql', import.meta.url), 'utf8');
  const count = async () => Number((await db.adminPool.query("SELECT count(*) FROM platform.schema_migrations WHERE version = '0031'")).rows[0].count);
  const before = await count();
  await db.adminPool.query(sql);
  await db.adminPool.query(sql);
  assert.equal(await count(), before);
  assert.equal(await can('nuvrion_app', 'audit.audit_events', 'UPDATE'), false);
  assert.equal(await can('nuvrion_app', 'operations.tasks', 'UPDATE'), true);
});

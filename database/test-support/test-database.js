import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

// Real-PostgreSQL test support. Point NUVRION_TEST_DATABASE_URL at a server whose user may create databases
// (a normal PostgreSQL connection URL for the `postgres` database). Each test file gets its own throwaway database with
// every migration applied in order, and drops it afterwards, so tests never touch each other or any real data.
// Without the variable the database tests are skipped; CI sets NUVRION_REQUIRE_DATABASE_TESTS=1 so that a
// missing database fails the build instead of silently skipping.
export const adminUrl = process.env.NUVRION_TEST_DATABASE_URL ?? null;
export const databaseRequired = process.env.NUVRION_REQUIRE_DATABASE_TESTS === '1';
export const skipDatabaseTests = adminUrl ? false : 'NUVRION_TEST_DATABASE_URL is not set (no PostgreSQL to test against)';

const migrationsDir = new URL('../migrations/', import.meta.url);

export async function migrationFiles() {
  return (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
}

export async function applyMigrations(queryable, { from = 1, upTo = Infinity } = {}) {
  const files = [];
  for (const file of await migrationFiles()) {
    const number = Number(file.slice(0, 4));
    if (number < from) continue;
    if (number > upTo) break;
    files.push(file);
  }
  return withClusterLock(async () => {   // migration 0031 creates a role: see withClusterLock
    for (const file of files) await queryable.query(await readFile(new URL(file, migrationsDir), 'utf8'));
    return files;
  });
}

async function withAdmin(work) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

// Roles belong to the server, not to a database, so test files that each migrate a database of their own race when they create the same role (a second CREATE ROLE
// fails with a unique violation on pg_authid, not with "already exists"). An advisory lock only excludes others in the same database, so the lock is taken in the
// database every test file connects to first, and is held by a connection of its own for as long as the work takes; closing that connection releases it.
async function withClusterLock(work) {
  if (!adminUrl) return work();
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7310031)');
    return await work();
  } finally { await client.end(); }
}

// The role the services run as in these tests: a member of the application group role that migration 0031 defines, which is what the API connects as in
// production. Running every PostgreSQL test through it means a query that needs a right the application does not have fails here, not in production.
// It also gets TRUNCATE (tests clear tables between cases; the application never truncates), which is the only extra it holds.
export const applicationTestRole = 'nuvrion_app_test';
const applicationTestPassword = 'test-only'; // secret-scan:allow (fake test credential)

async function provisionApplicationRole(adminPool, databaseName) {
  const client = await adminPool.connect();
  try {
    return await withClusterLock(async () => {   // several test processes share the server and the role
      const group = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'nuvrion_app'");
      if (!group.rowCount) return false;                       // an older schema: no application role to run as
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${applicationTestRole}') THEN
          CREATE ROLE ${applicationTestRole} LOGIN PASSWORD '${applicationTestPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE IN ROLE nuvrion_app;
        END IF;
      END $$`);
      await client.query(`GRANT nuvrion_app TO ${applicationTestRole}`);
      await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${applicationTestRole}`);
      const schemas = (await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema','public')")).rows.map(row => row.nspname);
      for (const schema of schemas) await client.query(`GRANT TRUNCATE ON ALL TABLES IN SCHEMA ${schema} TO ${applicationTestRole}`);
      return true;
    });
  } finally { client.release(); }
}

// Creates an empty database; `migrate: false` leaves it empty for the migration tests themselves, and then `pool` is the owner's pool (they apply migrations
// through it). With migrations applied, `pool` and `connectionString` are the application role's, and `adminPool` is the owner's, for what only an owner may do.
export async function createTestDatabase({ migrate = true, poolSize = 20 } = {}) {
  const name = `nuvrion_test_${randomBytes(6).toString('hex')}`;
  await withAdmin(client => client.query(`CREATE DATABASE ${name}`));
  const adminDatabaseUrl = new URL(adminUrl);
  adminDatabaseUrl.pathname = `/${name}`;
  const { default: pg } = await import('pg');
  const adminPool = new pg.Pool({ connectionString: adminDatabaseUrl.toString(), max: poolSize });
  let dropping = false;
  // While the database is being dropped, a connection that is still closing is told 'terminating connection due to administrator command'. That is expected, and
  // without a listener the error escapes and the test runner blames whichever test happened to open that connection. Any other pool error is still reported.
  const quiet = pool => pool.on('error', error => { if (!dropping) console.error(`test database pool error: ${error.message}`); });
  quiet(adminPool);
  let pool = adminPool, connectionString = adminDatabaseUrl.toString(), restricted = null;
  try {
    if (migrate) {
      await applyMigrations(adminPool);
      if (await provisionApplicationRole(adminPool, name)) {
        const url = new URL(adminDatabaseUrl);
        url.username = applicationTestRole;
        url.password = applicationTestPassword;
        connectionString = url.toString();
        restricted = new pg.Pool({ connectionString, max: poolSize });
        quiet(restricted);
        pool = restricted;
      }
    }
  } catch (error) {
    await restricted?.end();
    await adminPool.end();
    await withAdmin(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    throw error;
  }
  return {
    name,
    pool,
    adminPool,
    connectionString,
    adminConnectionString: adminDatabaseUrl.toString(),
    async drop() {
      dropping = true;
      await restricted?.end();
      await adminPool.end();
      await withAdmin(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    }
  };
}

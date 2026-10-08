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
  const applied = [];
  for (const file of await migrationFiles()) {
    const number = Number(file.slice(0, 4));
    if (number < from) continue;
    if (number > upTo) break;
    await queryable.query(await readFile(new URL(file, migrationsDir), 'utf8'));
    applied.push(file);
  }
  return applied;
}

async function withAdmin(work) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

// Creates an empty database; `migrate: false` leaves it empty for the migration tests themselves.
export async function createTestDatabase({ migrate = true, poolSize = 20 } = {}) {
  const name = `nuvrion_test_${randomBytes(6).toString('hex')}`;
  await withAdmin(client => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url.toString(), max: poolSize });
  let dropping = false;
  // While the database is being dropped, a connection that is still closing is told 'terminating connection due to administrator command'. That is expected, and
  // without a listener the error escapes and the test runner blames whichever test happened to open that connection. Any other pool error is still reported.
  pool.on('error', error => { if (!dropping) console.error(`test database pool error: ${error.message}`); });
  try {
    if (migrate) await applyMigrations(pool);
  } catch (error) {
    await pool.end();
    await withAdmin(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    throw error;
  }
  return {
    name,
    pool,
    connectionString: url.toString(),
    async drop() {
      dropping = true;
      await pool.end();
      await withAdmin(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    }
  };
}

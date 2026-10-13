# Database

`migrations/` holds the numbered, transactional PostgreSQL migrations (`0001_…sql`, `0002_…sql`, …). Production applies the
migration named by each release's manifest (see `deploy/README.md`); the tests below apply all of them to an empty database.

## The migration ledger

`platform.schema_migrations` records which migrations have been applied (version, description, SHA-256 of the file, time). Migration `0029` recorded
`0001`–`0028` and created the habit: **every migration from `0029` on ends with an `INSERT INTO platform.schema_migrations ... ON CONFLICT DO NOTHING` for its own
version** (`tools/check-migrations.js`, run in CI, fails otherwise, and also fails on a gap or duplicate number). The API reports itself ready only when the ledger's
newest version is at least the newest migration file that ships in the image (`modules/platform/src/migrations.js`); the version is read from the files, so there is
no constant to forget. A release names the migration it applies in its manifest (`requiredMigration`); `deploy/assemble-release.sh` refuses a change file that names
anything but the newest migration of the release commit.

## Database tests

`database/test/` and `modules/tasks/test/postgres-task-store.test.js` run against a real PostgreSQL server:

- every migration applies in order to an empty database, and an older schema upgrades with its data intact;
- the production task store (`PostgresTaskStore`) keeps its guarantees: one task per idempotency key, a task is claimed by
  exactly one worker, finished tasks stay final, expired leases are recovered, retries wait until due, and a failed
  step rolls the whole change back.

They need a server whose user may create databases. Each test file creates and drops its own throwaway database.

```bash
export NUVRION_TEST_DATABASE_URL=<connection URL of the server's "postgres" database>
npm test
```

Without `NUVRION_TEST_DATABASE_URL` these tests are skipped and the rest of the suite runs normally. CI sets it, plus
`NUVRION_REQUIRE_DATABASE_TESTS=1`, which turns "no database" into a failure instead of a skip. CI uses a throwaway
`postgres:16-alpine` container, the version production runs. Never point the variable at a real Nuvrion database.

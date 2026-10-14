# Restoring Nuvrion from a backup

This guide describes how to bring the platform back from the backups the upgrade script takes, what you must check
before you call a restore good, and what is **not** yet automated. It was written from the code and from the one
rehearsal that has been run (12 October 2026, on a separate host); steps that have not been rehearsed are marked.

## What a backup is

Every deploy (`deploy/upgrade-nuvrion.sh`) writes a directory `~/nuvrion-upgrades/backups/<UTC timestamp>/` on the
production host, before it changes anything:

| File | What it is |
|---|---|
| `nuvrion.dump` | `pg_dump -Fc` (PostgreSQL custom format) of the `nuvrion` database, taken inside the `nuvrion-postgres` container |
| `nuvrion-api.env` | The API's environment file (mode 600). It holds the configuration **and the encryption keys** |
| `nuvrion-lab-root-ca.pem` | The root certificate the platform trusts for the lab |

The last five backups are kept. Three facts follow from this, and they are the reason backups are still listed as an
open item:

1. **A backup exists only when a release is deployed.** The recovery point is the time of the last deploy, not
   "minutes ago". There is no scheduled backup yet.
2. **The backup is on the same host as the database.** Losing the host loses both.
3. **The encryption keys are beside the dump.** Connection credentials and agent secrets in the database are encrypted;
   without the keys in `nuvrion-api.env` (`NUVRION_ENCRYPTION_KEYS` and `NUVRION_MASTER_KEY`, with
   `NUVRION_ACTIVE_ENCRYPTION_KEY_ID` naming the active key) a restored database cannot decrypt them. Keep an
   independent copy of those keys somewhere that is not the backup directory.

The deploy script does **not** yet produce a backup manifest or a stored checksum. `tools/backup-manifest.js` exists
(see "Checking a backup" below) and is tested, but nothing calls it at deploy time.

## Restoring

Restore into a **new, empty PostgreSQL 16**. For a drill, never restore on top of production.

1. **Choose the backup** and copy `nuvrion.dump` and `nuvrion-api.env` to the machine doing the restore. They contain
   production data and secrets: use an encrypted channel and delete the copies afterwards.
2. **Start an empty PostgreSQL 16** (the production image is `postgres:16-alpine`) with a database and user whose names
   match `NUVRION_DATABASE_NAME` and `NUVRION_DATABASE_USER` in the env file (the API reaches the database through
   `NUVRION_DATABASE_URL`, and the password is `POSTGRES_PASSWORD`), and confirm it is empty:
   ```bash
   psql -U <user> -d <db> -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"
   ```
   The answer must be `0`.
3. **Restore the dump:**
   ```bash
   pg_restore -U <user> -d <db> --no-owner --no-privileges nuvrion.dump
   ```
   The 12 October rehearsal restored a dump of about 35 MB in 4.3 seconds. Its evidence file records timings, not the exact
   command line, so the flags above are the standard form and were not re-run when this guide was written.
4. **Check the schema is what you think it is.** From v0.1.174 the database records its own migrations:
   ```sql
   select count(*), max(version) from platform.schema_migrations;   -- 29 rows, 0029 as of v0.1.174
   ```
   If the backup is older than the release you are going to run, the newer migrations in `database/migrations/` must
   be applied in order before the API starts (the upgrade script does this on a normal deploy). Each migration from
   0029 onward records itself in that table, so the ledger tells you exactly where the restored database stands.
5. **Start the API against the restored database** using the env file from the same backup (so the keys match), and
   wait for readiness:
   ```bash
   curl -s https://<host>/api/v1/readiness      # 200 and "ready"; 503 names what is not ready
   ```
   Readiness reports not ready if the newest migration is not in the ledger, so a restore that stopped half way is
   caught here.
6. **Reconcile what was in flight.** A task that was running when the backup was taken is picked up by the periodic
   task recovery once its lease has expired: if the provider had already accepted the operation it goes to
   `verification_required` (it is never executed a second time), otherwise it is queued again. Review those tasks,
   then run discovery for each connection so inventory is current. Connections that were healthy should show healthy
   again within a few minutes; agents reconnect on their own if the API URL and certificate are unchanged.
7. **Do not trust the restore until it has been exercised:** sign in, open the inventory, open one VM, and run one
   harmless operation against a lab VM.

## Checking a backup before you rely on it

```bash
export NUVRION_BACKUP_INTEGRITY_KEY=<key kept separately from the backup>
node tools/backup-manifest.js create nuvrion.dump nuvrion.dump.manifest.json     # at backup time
node tools/backup-manifest.js verify nuvrion.dump nuvrion.dump.manifest.json     # before a restore
```

The manifest records the dump's SHA-256, size, schema version and creation time, authenticated with the integrity key.
`verify` fails if the dump was altered or if it is for a different schema version than the code you are about to run.
Because the key must be kept apart from the backup, a manifest kept beside the dump proves integrity only against
accidental damage, not against someone who can also write the manifest.

## The recovery gate

`tools/evaluate-recovery-drill.js <evidence.json> [report.json]` turns a drill into a pass or a named list of blockers
(`modules/platform/src/recovery-drill-gate.js`). Evidence has format `nuvrion-recovery-drill/v1` and must show, as
booleans, that: the manifest was authenticated, the checksum verified, the schema compatible, the target proven empty,
the restore completed, migrations applied, readiness passed, discovery completed, verification-required tasks were
reconciled, the audit trail was verified, secrets were restored through their independent path, and the drill was
isolated from production. It must also show `lostTasks` and `duplicateOperations` of 0 and carry an evidence
reference. The thresholds are an **RTO of at most 3,600 s** and an **RPO of at most 900 s**, and the evidence must be
no older than seven days.

## What the one rehearsal showed (12 October 2026)

- The 11 October backup restored into an empty PostgreSQL 16 on a separate host (NOVAAPP02) and the application ran
  from the v0.1.169 code: **214 seconds** from start to a ready, validated copy.
- The gate returned **blocked**, correctly: no manifest, no stored checksum, the key sat beside the dump, discovery
  was not run, and the recovery point was about 19 hours old against the 15-minute threshold.
- Everything created for the drill was removed afterwards and the host matched its recorded baseline.

## Still open

- Scheduled backups (not only at deploy time) and a copy that does not live on the production host.
- Calling `tools/backup-manifest.js` from the deploy script, and storing the checksum with the backup.
- A restore that runs as an automated test instead of by hand.
- An approved RPO and RTO. The gate's 900 s and 3,600 s are defaults, not commitments.

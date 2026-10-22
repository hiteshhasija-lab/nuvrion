# Restoring Nuvrion from a backup

This guide describes how to bring the platform back from a backup, what you must check before you call a restore good,
and what is **not** yet automated. It was written from the code and from the one rehearsal that has been run (12 October
2026, on a separate host); steps that have not been rehearsed are marked.

Since 17 October 2026 there are two kinds of backup. **Scheduled backups** are taken every hour, restored into a scratch
database to prove they work, encrypted, signed and copied to the owner's computer; they are described in
[backups.md](backups.md), and `node tools/backup.js decrypt latest <folder>` turns one into the `nuvrion.dump` and the
`config/` folder that the steps below use. **Pre-upgrade backups** (this page's next section) are taken by the upgrade
script just before each release and stay on the host.

## What a pre-upgrade backup is

Every deploy (`deploy/upgrade-nuvrion.sh`) writes a directory `~/nuvrion-upgrades/backups/<UTC timestamp>/` on the
production host, before it changes anything:

| File | What it is |
|---|---|
| `nuvrion.dump` | `pg_dump -Fc` (PostgreSQL custom format) of the `nuvrion` database, taken inside the `nuvrion-postgres` container |
| `nuvrion-api.env` | The API's environment file (mode 600). It holds the configuration **and the encryption keys** |
| `nuvrion-lab-root-ca.pem` | The root certificate the platform trusts for the lab |

The last five backups are kept. Three facts about these backups were the findings of the first rehearsal; the scheduled
backups ([backups.md](backups.md)) close them, these do not:

1. **A pre-upgrade backup exists only when a release is deployed.** The recovery point is the time of the last deploy.
   (Scheduled backups are hourly.)
2. **It is on the same host as the database.** (Scheduled backups are copied to the owner's computer.)
3. **The encryption keys are beside the dump.** Connection credentials and agent secrets in the database are encrypted;
   without the keys in `nuvrion-api.env` (`NUVRION_ENCRYPTION_KEYS` and `NUVRION_MASTER_KEY`, with
   `NUVRION_ACTIVE_ENCRYPTION_KEY_ID` naming the active key) a restored database cannot decrypt them. The agent signing
   key pair (`agent-signing-private.pem`) is **not** in this backup at all. (Scheduled backups carry both, encrypted to a key
   that never touches the host.)

The deploy script does **not** produce a manifest or a stored checksum for these. The scheduled backups carry a signed
manifest; `tools/backup-manifest.js` (see "Checking a backup" below) is the older, single-file form.

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
   The 12 October rehearsal restored a dump of about 35 MB in 4.3 seconds; the 22 October rehearsal ran exactly this command
   (with `--exit-on-error`, from the dump inside the throwaway PostgreSQL container) on a 29 MB dump: 3.1 seconds, exit 0, no errors.
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

## The second rehearsal (22 October 2026)

The newest hourly set (`20261022T160120Z`, 33 minutes old) was verified and decrypted on the owner's computer, copied over SSH to NOVAAPP02 (a different host, x86_64) and restored into an empty
`postgres:16-alpine` (16.15) on a private podman network with no published ports; the release 0.1.198 source then ran in `node:24.21.0-bookworm-slim` against it with a throwaway
`rabbitmq:3.13-alpine`, in the production profile. Everything was removed afterwards and NOVAAPP02 matched its recorded baseline.

- **Authentic and intact**: the signature, every checksum and the evidence archive passed `node tools/backup.js verify` (51 sets, 77 releases); the decrypted dump had the same SHA-256 on both machines.
- **Restored in 3.1 s**; the counts equal the restore check the production host recorded in the signed manifest: 41 migrations (latest 0041), 40 tables, 3 users, 4 connections, 77 resources, 4,761 tasks,
  10,661 audit events, 2 agents.
- **Ready about 160 s** after the restore began: `/api/v1/readiness` returned ready (database, broker, worker and agent maintenance healthy, migrations current).
- **Keys**: taken from the encrypted configuration of the same set, they opened the credentials of all three live connections and the active agent's secret.
- **Used**: a drill-only administrator created on the copy read 77 VMs, 3 connections, 8 infrastructure objects, tasks and the audit trail through the API.
- The recovery gate returned **blocked**, with two blockers (five in October): **discovery was not completed** (ESXi 7 and ESXi 8 refused connections and the Workstation agent was offline, because the lab was
  powered down) and **the recovery point was 2,019 s** against the 900 s threshold (an hourly backup cannot meet it).
- Not exercised: the original administrator's password hash (its password was not available; not asked for), recovery of a stranded task (none was in flight: all 4,761 tasks were final), and the switch to the
  restricted application role. The evidence is `Nuvrion-Recovery-Drill-2026-10-22-evidence.json` and `-report.json`, kept beside the status document.

## Closed on 17 October 2026

- Scheduled backups (hourly) and a copy that does not live on the production host (the owner's computer), each with a signed
  manifest and a stored checksum for every file; the keys (env file and agent signing keys) are in the backup, encrypted to a
  key the host does not hold.
- A restore that runs automatically: every scheduled backup is restored into a scratch database on the host and its
  migrations, tables and row counts are recorded in the signed manifest before the set counts as a backup.
- Release evidence is kept off the host without an expiry ([backups.md](backups.md)).

## Still open

- **The recovery point.** Backups are hourly, so the gate's 900 s RPO is not met (an hour at best, more while the owner's
  computer is off). Meeting it needs continuous WAL archiving.
- **Discovery after a restore.** The 22 October rehearsal restored a scheduled-backup set and ran the application on it, but could not complete discovery because the lab was powered down. Repeat it with
  the lab on (the Workstation agent must be pointed at the copy, or the copy's Workstation connection will stay offline; the ESXi connections need only the hosts to be up); the gate needs it.
- **A second copy of the recovery private key** that is not on the owner's computer, made by the owner.
- An approved RPO and RTO. The gate's 900 s and 3,600 s are defaults, not commitments.

# Backup and restore runbook

Use `deploy/backup-postgres.sh` with an existing directory on encrypted storage. The command creates a PostgreSQL custom-format dump plus a restrictive-permission manifest authenticated with `NUVRION_BACKUP_INTEGRITY_KEY`.

Restore is intentionally guarded. Set `NUVRION_RESTORE_DATABASE_URL` to a newly created empty recovery database and run `deploy/restore-postgres.sh <dump> <manifest>`. The script authenticates the manifest, verifies schema compatibility, size, and SHA-256, then refuses any non-empty target.

After restoration, apply outstanding migrations, start Nuvrion, require `/api/v1/readiness` to report `ready`, reconcile all verification-required tasks, and run provider discovery before promoting the recovered database. Test this process regularly in an isolated environment. Store the integrity key separately from backup media and retain it under the same recovery controls as the platform master key.

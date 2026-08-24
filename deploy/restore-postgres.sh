#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then echo "Usage: restore-postgres.sh <backup-file> <manifest-file>" >&2; exit 64; fi
: "${NUVRION_RESTORE_DATABASE_URL:?NUVRION_RESTORE_DATABASE_URL is required and must target an empty recovery database}"
: "${NUVRION_BACKUP_INTEGRITY_KEY:?NUVRION_BACKUP_INTEGRITY_KEY is required}"
backup_path=$1
manifest_path=$2
node tools/backup-manifest.js verify "$backup_path" "$manifest_path"
existing=$(psql "$NUVRION_RESTORE_DATABASE_URL" -Atqc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")
if [ "$existing" -ne 0 ]; then echo "Restore target is not empty; refusing to overwrite it." >&2; exit 65; fi
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$NUVRION_RESTORE_DATABASE_URL" "$backup_path"
echo "Restore completed. Run migrations/readiness checks and provider reconciliation before promotion."

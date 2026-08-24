#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 1 ]; then echo "Usage: backup-postgres.sh <existing-encrypted-output-directory>" >&2; exit 64; fi
output_dir=$1
if [ ! -d "$output_dir" ]; then echo "Output directory must already exist on encrypted storage." >&2; exit 65; fi
: "${NUVRION_DATABASE_URL:?NUVRION_DATABASE_URL is required}"
: "${NUVRION_BACKUP_INTEGRITY_KEY:?NUVRION_BACKUP_INTEGRITY_KEY is required}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_path="$output_dir/nuvrion-$stamp.dump"
manifest_path="$backup_path.manifest.json"
pg_dump --format=custom --no-owner --no-privileges --file="$backup_path" "$NUVRION_DATABASE_URL"
node tools/backup-manifest.js create "$backup_path" "$manifest_path"
echo "Backup and authenticated manifest created: $backup_path"

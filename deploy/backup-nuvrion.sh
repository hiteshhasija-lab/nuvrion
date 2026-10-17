#!/usr/bin/env bash
# Scheduled backup of Nuvrion on its host (docs/backups.md). A systemd user timer runs it every hour.
#
#   backup-nuvrion.sh                       take a backup set now
#   backup-nuvrion.sh --init RECOVERY_CERT  one-time set-up: install the recovery certificate and create the signing key; prints the signing public key
#   backup-nuvrion.sh --status              print the status of the last run
#
# A set (~/nuvrion-backups/<UTC time>/) holds:
#   nuvrion.dump.cms        pg_dump -Fc of the database, encrypted to the recovery certificate
#   nuvrion-config.tar.cms  the env file (with the encryption keys), the agent signing keys, the CA, the TLS certificate and key, the Caddyfile: encrypted the same way
#   manifest.json, manifest.sig   what the set holds, the result of restoring the dump into a scratch database, and an Ed25519 signature over it
#   COMPLETE                written last
# plus, for the newest few sets only, the plain nuvrion.dump (a fast local restore). The recovery PRIVATE key is never on this host; the signing key never leaves it.
# Exits non-zero (so systemd marks the run failed) if any step fails, and leaves no half-written set behind.
set -Eeuo pipefail

backup_root="${NUVRION_BACKUP_ROOT:-$HOME/nuvrion-backups}"
config_dir="${NUVRION_CONFIG_DIR:-$HOME/.config/nuvrion}"
signing_key="${NUVRION_BACKUP_SIGNING_KEY:-$config_dir/backup-signing-private.pem}"
recovery_cert="${NUVRION_BACKUP_RECOVERY_CERT:-$config_dir/backup-recovery-cert.pem}"
postgres_container="${NUVRION_POSTGRES_CONTAINER:-nuvrion-postgres}"
database_user="${NUVRION_DATABASE_USER:-nuvrion}"
database_name="${NUVRION_DATABASE_NAME:-nuvrion}"
api_container="${NUVRION_API_CONTAINER:-nuvrion-api}"
keep_plain="${NUVRION_BACKUP_KEEP_PLAIN:-6}"      # sets that keep a plain dump on the host
keep_sets="${NUVRION_BACKUP_KEEP_SETS:-48}"       # sets kept on the host (the owner’s machine keeps its own, longer, history)
host_name="${NUVRION_BACKUP_HOST_NAME:-NOVAAPP01}"
openssl_bin="${NUVRION_OPENSSL:-openssl}"
# files of ~/.config/nuvrion that make up the platform’s configuration; the first three are required
required_config="nuvrion-api-final.env agent-signing-private.pem nuvrion-lab-root-ca.pem"
optional_config="agent-signing-public.pem Caddyfile run-nuvrion-api.sh tls"

log() { echo "backup: $*"; }
die() { echo "backup: $*" >&2; exit 1; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size_of() { wc -c < "$1" | tr -d ' '; }

case "${1:-}" in
  --init)
    cert="${2:-}"; [[ -f "$cert" ]] || die "usage: backup-nuvrion.sh --init RECOVERY_CERTIFICATE.pem"
    "$openssl_bin" x509 -in "$cert" -noout >/dev/null 2>&1 || die "$cert is not a certificate"
    mkdir -p "$config_dir" "$backup_root"; chmod 700 "$backup_root"
    install -m 644 "$cert" "$recovery_cert"
    if [[ ! -f "$signing_key" ]]; then
      ( umask 077; "$openssl_bin" genpkey -algorithm ed25519 -out "$signing_key" )
      log "created the signing key $signing_key"
    fi
    chmod 600 "$signing_key"
    echo "Signing public key (give it to the machine that pulls the backups):"
    "$openssl_bin" pkey -in "$signing_key" -pubout
    exit 0 ;;
  --status)
    cat "$backup_root/status.json" 2>/dev/null || die "no successful backup yet"
    if [[ -f "$backup_root/last-failure.json" ]]; then echo "last failure:"; cat "$backup_root/last-failure.json"; fi
    exit 0 ;;
  "") ;;
  *) die "unknown argument $1" ;;
esac

[[ -f "$signing_key" && -f "$recovery_cert" ]] || die "not set up: run backup-nuvrion.sh --init RECOVERY_CERTIFICATE.pem first"
mkdir -p "$backup_root"; chmod 700 "$backup_root"

# one run at a time (mkdir is atomic; a lock left by a dead run is taken over)
lock="$backup_root/.lock"
if ! mkdir "$lock" 2>/dev/null; then
  other="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ -n "$other" ]] && kill -0 "$other" 2>/dev/null; then log "another backup is running (pid $other); skipping"; exit 0; fi
  rm -rf "$lock"; mkdir "$lock"
fi
echo $$ > "$lock/pid"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set_dir="$backup_root/$timestamp"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuvrion-backup.XXXXXX")"
scratch_db="nuvrion_restorecheck_$(echo "$timestamp" | tr 'A-Z' 'a-z')"
scratch_created=false
started_at="$(date +%s)"

cleanup() {
  local code=$?
  if $scratch_created; then podman exec "$postgres_container" dropdb -U "$database_user" --if-exists "$scratch_db" >/dev/null 2>&1 || true; fi
  rm -rf "$work" "$lock"
  if [[ $code -ne 0 ]]; then
    rm -rf "$set_dir"
    printf '{"failedAt":"%s","attempt":"%s","exitCode":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$timestamp" "$code" > "$backup_root/last-failure.json" || true
    echo "backup: FAILED (exit $code); nothing was kept for $timestamp" >&2
  fi
}
trap cleanup EXIT

mkdir -m 700 "$set_dir"

# 1. the configuration the platform cannot be rebuilt without
present=""
for name in $required_config; do [[ -e "$config_dir/$name" ]] || die "required file missing: $config_dir/$name"; present="$present $name"; done
for name in $optional_config; do if [[ -e "$config_dir/$name" ]]; then present="$present $name"; fi; done
# shellcheck disable=SC2086
( cd "$config_dir" && tar -cf "$work/nuvrion-config.tar" $present )

# 2. the database
log "dumping $database_name"
podman exec "$postgres_container" pg_dump -U "$database_user" -d "$database_name" -Fc > "$set_dir/nuvrion.dump"
[[ -s "$set_dir/nuvrion.dump" ]] || die "the dump is empty"

# 3. prove it restores: into a scratch database on the same server, then drop it
log "restoring it into a scratch database to check it"
check_started="$(date +%s)"
podman exec "$postgres_container" dropdb -U "$database_user" --if-exists "$scratch_db" >/dev/null 2>&1 || true
podman exec "$postgres_container" createdb -U "$database_user" "$scratch_db"
scratch_created=true
podman exec -i "$postgres_container" pg_restore -U "$database_user" -d "$scratch_db" --exit-on-error < "$set_dir/nuvrion.dump" > /dev/null 2> "$work/restore.err" \
  || die "restoring the dump into $scratch_db failed: $(head -c 400 "$work/restore.err")"
counts="$(podman exec "$postgres_container" psql -U "$database_user" -d "$scratch_db" -Atq -c "select json_build_object(
  'migrations', (select count(*) from platform.schema_migrations),
  'latest', (select max(version) from platform.schema_migrations),
  'tables', (select count(*) from information_schema.tables where table_schema in ('agents','audit','connections','identity','inventory','monitoring','operations','platform') and table_type = 'BASE TABLE'),
  'users', (select count(*) from identity.users),
  'connections', (select count(*) from connections.provider_connections),
  'resources', (select count(*) from inventory.resources),
  'tasks', (select count(*) from operations.tasks),
  'auditEvents', (select count(*) from audit.audit_events),
  'agents', (select count(*) from agents.workstation_agents))")"
podman exec "$postgres_container" dropdb -U "$database_user" --if-exists "$scratch_db" >/dev/null 2>&1 && scratch_created=false || true
check_json="$(jq -c -n --argjson counts "$counts" --argjson seconds "$(( $(date +%s) - check_started ))" '{passed: true, seconds: $seconds} + $counts')"
jq -e '.migrations > 0 and .tables > 0' <<< "$check_json" >/dev/null || die "the restored copy has no migrations or no tables: $check_json"

# 4. encrypt what leaves the host
dump_plain_sha="$(sha256_of "$set_dir/nuvrion.dump")"; dump_plain_size="$(size_of "$set_dir/nuvrion.dump")"
config_plain_sha="$(sha256_of "$work/nuvrion-config.tar")"; config_plain_size="$(size_of "$work/nuvrion-config.tar")"
"$openssl_bin" smime -encrypt -binary -aes-256-cbc -outform DER -in "$set_dir/nuvrion.dump" -out "$set_dir/nuvrion.dump.cms" "$recovery_cert"
"$openssl_bin" smime -encrypt -binary -aes-256-cbc -outform DER -in "$work/nuvrion-config.tar" -out "$set_dir/nuvrion-config.tar.cms" "$recovery_cert"

# 5. the manifest and its signature
application_version="$(podman exec "$api_container" cat /opt/nuvrion/RELEASE_VERSION 2>/dev/null | tr -d '[:space:]' || true)"
files_json="$(jq -n \
  --arg dumpSha "$(sha256_of "$set_dir/nuvrion.dump.cms")" --argjson dumpSize "$(size_of "$set_dir/nuvrion.dump.cms")" --arg dumpPlainSha "$dump_plain_sha" --argjson dumpPlainSize "$dump_plain_size" \
  --arg cfgSha "$(sha256_of "$set_dir/nuvrion-config.tar.cms")" --argjson cfgSize "$(size_of "$set_dir/nuvrion-config.tar.cms")" --arg cfgPlainSha "$config_plain_sha" --argjson cfgPlainSize "$config_plain_size" \
  '[{name: "nuvrion.dump.cms", sizeBytes: $dumpSize, sha256: $dumpSha, plaintextSha256: $dumpPlainSha, plaintextSizeBytes: $dumpPlainSize},
    {name: "nuvrion-config.tar.cms", sizeBytes: $cfgSize, sha256: $cfgSha, plaintextSha256: $cfgPlainSha, plaintextSizeBytes: $cfgPlainSize}]')"
jq -n --arg createdAt "$created_at" --arg host "$host_name" --arg version "${application_version:-unknown}" --arg db "$database_name" --argjson files "$files_json" --argjson check "$check_json" \
  --arg recovery "$("$openssl_bin" x509 -in "$recovery_cert" -noout -fingerprint -sha256 | cut -d= -f2)" \
  '{format: "nuvrion-backup/1", createdAt: $createdAt, host: $host, applicationVersion: $version, database: $db, recoveryCertificateSha256: $recovery, files: $files, restoreCheck: $check}' > "$set_dir/manifest.json"
"$openssl_bin" pkeyutl -sign -inkey "$signing_key" -rawin -in "$set_dir/manifest.json" -out "$set_dir/manifest.sig"
"$openssl_bin" pkey -in "$signing_key" -pubout -out "$work/signing-public.pem"
"$openssl_bin" pkeyutl -verify -pubin -inkey "$work/signing-public.pem" -rawin -in "$set_dir/manifest.json" -sigfile "$set_dir/manifest.sig" >/dev/null || die "the signature just made does not verify"
: > "$set_dir/COMPLETE"
chmod 600 "$set_dir"/*

# 6. retention on the host: complete sets only, newest first
sets="$(for d in "$backup_root"/[0-9]*T[0-9]*Z; do if [[ -f "$d/COMPLETE" ]]; then basename "$d"; fi; done | sort -r)"
index=0
for name in $sets; do
  index=$((index + 1))
  if [[ $index -gt $keep_sets ]]; then rm -rf "${backup_root:?}/$name"; continue; fi
  if [[ $index -gt $keep_plain ]]; then rm -f "$backup_root/$name/nuvrion.dump"; fi
done

printf '{"ok":true,"lastSuccessAt":"%s","lastSet":"%s","applicationVersion":"%s","dumpBytes":%s,"seconds":%s}\n' \
  "$created_at" "$timestamp" "${application_version:-unknown}" "$dump_plain_size" "$(( $(date +%s) - started_at ))" > "$backup_root/status.json.new"
mv "$backup_root/status.json.new" "$backup_root/status.json"
rm -f "$backup_root/last-failure.json"
log "done: $timestamp ($(size_of "$set_dir/nuvrion.dump.cms") bytes of dump, restore check passed in $(jq -r .seconds <<< "$check_json") s)"

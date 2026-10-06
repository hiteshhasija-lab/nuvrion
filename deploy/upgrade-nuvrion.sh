#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: upgrade-nuvrion.sh RELEASE_DIRECTORY [--check] [--yes]

  --check  Verify the release and host without making changes.
  --yes    Skip the interactive deployment confirmation.
EOF
}

release_dir=""
check_only=false
assume_yes=false
for argument in "$@"; do
  case "$argument" in
    --check) check_only=true ;;
    --yes) assume_yes=true ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $argument" >&2; usage >&2; exit 2 ;;
    *) if [[ -n "$release_dir" ]]; then echo "Only one release directory may be supplied." >&2; exit 2; fi; release_dir="$argument" ;;
  esac
done

[[ -n "$release_dir" ]] || { usage >&2; exit 2; }
release_dir="$(cd "$release_dir" && pwd -P)"
manifest="$release_dir/release-manifest.json"
checksums="$release_dir/SHA256SUMS.txt"

for command_name in podman curl sha256sum tar sed grep date mktemp install seq sleep systemctl jq; do
  command -v "$command_name" >/dev/null || { echo "Required command is unavailable: $command_name" >&2; exit 1; }
done
[[ -f "$manifest" && -f "$checksums" ]] || { echo "The release manifest or checksum file is missing." >&2; exit 1; }

json_string() {
  local key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$manifest" | head -n 1
}

version="$(json_string version)"
server_artifact="$(json_string artifact)"
required_migration="$(json_string requiredMigration)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "The release version is invalid." >&2; exit 1; }
[[ "$server_artifact" == "Nuvrion-Server-Overlay-$version.tar.gz" ]] || { echo "The declared server artifact is invalid." >&2; exit 1; }
[[ "$required_migration" =~ ^[0-9]{4}$ ]] || { echo "The required migration is invalid." >&2; exit 1; }
[[ -f "$release_dir/$server_artifact" ]] || { echo "The server artifact is missing." >&2; exit 1; }
if tar -tzf "$release_dir/$server_artifact" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The server archive contains an unsafe path." >&2
  exit 1
fi

echo "Verifying release payloads..."
(cd "$release_dir" && sha256sum -c SHA256SUMS.txt)

api_container="${NUVRION_API_CONTAINER:-nuvrion-api}"
postgres_container="${NUVRION_POSTGRES_CONTAINER:-nuvrion-postgres}"
pod_name="${NUVRION_POD_NAME:-nuvrion-lab}"
environment_file="${NUVRION_ENV_FILE:-/home/hiteshhasija/.config/nuvrion/nuvrion-api-final.env}"
ca_file="${NUVRION_CA_FILE:-/home/hiteshhasija/.config/nuvrion/nuvrion-lab-root-ca.pem}"
upgrade_root="${NUVRION_UPGRADE_ROOT:-/home/hiteshhasija/nuvrion-upgrades}"
base_image="${NUVRION_BASE_IMAGE:-localhost/nuvrion:base-arm64}"
database_user="${NUVRION_DATABASE_USER:-nuvrion}"
database_name="${NUVRION_DATABASE_NAME:-nuvrion}"
agent_signing_private_key_file="${NUVRION_AGENT_SIGNING_PRIVATE_KEY_FILE:-/home/hiteshhasija/.config/nuvrion/agent-signing-private.pem}"
agent_signing_public_key_file="${NUVRION_AGENT_SIGNING_PUBLIC_KEY_FILE:-/home/hiteshhasija/.config/nuvrion/agent-signing-public.pem}"
# nuvrion-api's actual `podman run` invocation lives in a wrapper script
# (~/.config/nuvrion/run-nuvrion-api.sh), not inline in this unit's ExecStart= — that split
# exists because `podman generate systemd` serializes multi-line env values (the two PEM
# signing keys) as literal two-character `\n` escapes, and systemd's ExecStart= is never
# passed through a shell, so it can't un-escape them back into real newlines. The wrapper
# re-reads both PEM files fresh via `$(cat ...)` on every start instead. It already targets
# the movable `localhost/nuvrion:stable` tag, so this script only needs to move that tag and
# let systemd do the actual container swap — not duplicate the wrapper's own run invocation.
systemd_service="${NUVRION_SYSTEMD_SERVICE:-container-nuvrion-api.service}"
stable_image="localhost/nuvrion:stable"
# The stable-release record is written by this script after every validated deploy; nothing edits it by hand.
# If the record is missing (e.g. a rebuilt host), it is seeded from the copy tracked in git (deploy/STABLE-RELEASE.json
# in the ~/nuvrion clone), which also carries the pipeline notes.
stable_record="${NUVRION_STABLE_RECORD:-$upgrade_root/STABLE-RELEASE.json}"
stable_seed="${NUVRION_STABLE_SEED:-/home/hiteshhasija/nuvrion/deploy/STABLE-RELEASE.json}"

podman container exists "$api_container" || { echo "The active API container was not found." >&2; exit 1; }
podman container exists "$postgres_container" || { echo "The PostgreSQL container was not found." >&2; exit 1; }
podman pod exists "$pod_name" || { echo "The Nuvrion pod was not found." >&2; exit 1; }
[[ -f "$environment_file" && -f "$ca_file" ]] || { echo "The Nuvrion environment file or CA certificate is missing." >&2; exit 1; }
[[ -f "$agent_signing_private_key_file" && -f "$agent_signing_public_key_file" ]] || { echo "The agent signing key files are missing (these are NOT in the env file — PEM values don't survive --env-file)." >&2; exit 1; }
podman image exists "$base_image" || { echo "The base image is unavailable: $base_image" >&2; exit 1; }
systemctl --user is-active --quiet "$systemd_service" || { echo "The systemd unit is not active: $systemd_service" >&2; exit 1; }

current_image="$(podman inspect "$api_container" --format '{{.Image}}')"
current_status="$(podman inspect "$api_container" --format '{{.State.Status}}')"
[[ "$current_status" == "running" ]] || { echo "The active API container is not running." >&2; exit 1; }

echo "Preflight passed for Nuvrion v$version."
if $check_only; then
  echo "No changes were made."
  exit 0
fi
if ! $assume_yes; then
  read -r -p "Upgrade the active Nuvrion API to v$version? Type the version to continue: " confirmation
  [[ "$confirmation" == "$version" ]] || { echo "Upgrade cancelled."; exit 1; }
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$upgrade_root/backups/$timestamp"
mkdir -p "$backup_dir" "$upgrade_root/builds"
chmod 700 "$upgrade_root" "$upgrade_root/backups" "$backup_dir" "$upgrade_root/builds"
build_dir="$(mktemp -d "$upgrade_root/builds/v${version}.XXXXXX")"
rollback_image="localhost/nuvrion:rollback-$timestamp"
target_image="localhost/nuvrion:$version"
new_container_started=false

wait_for_health() {
  local attempt validated=false
  for attempt in $(seq 1 30); do
    local health
    health="$(podman exec "$api_container" node -e "fetch('http://127.0.0.1:4100/api/v1/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
    if grep -q '"status":"healthy"' <<<"$health" \
      && grep -q "\"version\":\"$version\"" <<<"$health"; then
      validated=true
      break
    fi
    sleep 1
  done
  $validated
}

record_stable_release() {
  local base="$stable_record" temporary
  if [[ ! -f "$base" ]]; then base="$stable_seed"; fi
  temporary="$(mktemp "$stable_record.XXXXXX")"
  { if [[ -f "$base" ]]; then cat "$base"; else echo '{}'; fi; } | jq \
    --arg version "$version" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg image "$target_image" \
    --arg dir "$release_dir" --arg rollback "$rollback_image" \
    --arg commit "$(jq -r '.sourceBaselineCommit // empty' "$manifest")" \
    --arg reason "$(jq -r '.change.summary // empty' "$manifest")" \
    '. + {stableVersion:$version,markedStableAt:$at,markedBy:"upgrade-nuvrion.sh",image:$image,releaseDirectory:$dir,sourceBaselineCommit:$commit,reason:$reason,rollbackImage:$rollback}' \
    > "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 644 "$temporary"
  mv "$temporary" "$stable_record"
}

# Version tags (localhost/nuvrion:X.Y.Z) other than the newest $1 and the one just deployed. Reads tags on stdin.
stale_version_tags() {
  grep -E '^localhost/nuvrion:[0-9]+\.[0-9]+\.[0-9]+$' | sort -t: -k2 -V -r | tail -n +"$(($1 + 1))" | grep -vxF "$target_image" || true
}

# Each deploy leaves a build directory, older version tags and unused build layers behind; on a small disk they add up.
# Rollback images, the running container's image and the :stable tag are never touched. Failed deploys keep their build
# directory for a week for diagnosis.
cleanup_after_deploy() {
  local tag
  rm -rf "$build_dir"
  find "$upgrade_root/builds" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  while IFS= read -r tag; do
    if [[ -n "$tag" ]]; then podman rmi "$tag" >/dev/null 2>&1 || true; fi
  done < <(podman images --format '{{.Repository}}:{{.Tag}}' | stale_version_tags 5)
  podman image prune -f >/dev/null 2>&1 || true
  echo "Cleaned up build files and unused images. Free disk: $(df -h --output=avail "$upgrade_root" | tail -n 1 | tr -d ' ')"
}

rollback() {
  local exit_code=$?
  if $new_container_started; then
    echo "Validation failed. Restoring the prior API image..." >&2
    podman tag "$rollback_image" "$stable_image"
    systemctl --user restart "$systemd_service" >/dev/null 2>&1 || true
    echo "The prior API image was restored. Database backup: $backup_dir/nuvrion.dump" >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

echo "Creating database and configuration backups..."
podman exec "$postgres_container" pg_dump -U "$database_user" -d "$database_name" -Fc > "$backup_dir/nuvrion.dump"
install -m 600 "$environment_file" "$backup_dir/nuvrion-api.env"
install -m 600 "$ca_file" "$backup_dir/nuvrion-lab-root-ca.pem"
podman tag "$current_image" "$rollback_image"

echo "Pruning old backups (keeping the last 5)..."
mapfile -t stale_backups < <(ls -1 "$upgrade_root/backups" | sort | head -n -5)
for stale in "${stale_backups[@]:-}"; do
  [[ -n "$stale" ]] && rm -rf "$upgrade_root/backups/$stale"
done

echo "Pruning old pre-upgrade rollback images (keeping the last 5)..."
mapfile -t stale_rollback_tags < <(podman images --format '{{.Repository}}:{{.Tag}}' | grep '^localhost/nuvrion:rollback-' | sort | head -n -5)
for stale_tag in "${stale_rollback_tags[@]:-}"; do
  [[ -n "$stale_tag" ]] && podman rmi "$stale_tag" >/dev/null 2>&1 || true
done

echo "Preparing and building v$version..."
tar -xzf "$release_dir/$server_artifact" -C "$build_dir"
containerfile="$build_dir/Containerfile.overlay"
[[ -f "$containerfile" ]] || { echo "The overlay Containerfile is missing." >&2; false; }
migration_files=("$build_dir/database/migrations/${required_migration}_"*.sql)
[[ ${#migration_files[@]} -eq 1 && -f "${migration_files[0]}" ]] || { echo "Migration $required_migration is missing or ambiguous." >&2; false; }
migration_file="${migration_files[0]}"
podman build --build-arg "BASE_IMAGE=$base_image" --build-arg "RELEASE_VERSION=$version" \
  -f "$containerfile" -t "$target_image" "$build_dir"

echo "Applying migration $required_migration..."
podman cp "$migration_file" "$postgres_container:/tmp/nuvrion-release-migration.sql"
podman exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" \
  -f /tmp/nuvrion-release-migration.sql

echo "Replacing the active API container via systemd..."
podman tag "$target_image" "$stable_image"
new_container_started=true
systemctl --user restart "$systemd_service"

echo "Validating health, readiness, and release version..."
wait_for_health || { echo "The upgraded API did not pass validation." >&2; false; }

new_container_started=false
trap - ERR
echo "Nuvrion v$version is healthy and ready."
echo "Backup: $backup_dir"
echo "Rollback image: $rollback_image"
# Best effort: a failure to write the record must never fail an upgrade that already passed validation.
if record_stable_release; then echo "Recorded v$version as the stable release in $stable_record"; else echo "Warning: could not update $stable_record; record v$version by hand." >&2; fi
if ! cleanup_after_deploy; then echo "Warning: post-deploy cleanup failed; disk space was not reclaimed." >&2; fi

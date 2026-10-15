#!/usr/bin/env bash
# Switches the Nuvrion API from the database owner role to a login role of its own, a member of the nuvrion_app group (migration 0031).
#
#   deploy/application-role.sh            run on the platform host, after a release that contains migration 0031 has been applied
#
# The owner role stays what migrations, backups and the upgrade script use. The API gets a role that can read and write rows and nothing else: it cannot
# create or drop anything, cannot change or delete audit events, cannot write the migration ledger, and cannot read server files or run commands.
# No secret is printed: the password is generated here, sent to PostgreSQL on stdin and written to the env file (mode 600). Everything is verified through
# the one PostgreSQL rule that checks passwords (the pod address), and the previous configuration is restored if any step fails.
#
# Environment (defaults suit the lab host): NUVRION_ENV_FILE, NUVRION_APPLICATION_ROLE (default nuvrion_api), NUVRION_API_UNIT, NUVRION_API_CONTAINER,
# NUVRION_POSTGRES_CONTAINER, NUVRION_DATABASE_NAME.
set -uo pipefail
umask 077

env_file="${NUVRION_ENV_FILE:-$HOME/.config/nuvrion/nuvrion-api-final.env}"
role="${NUVRION_APPLICATION_ROLE:-nuvrion_api}"
api_unit="${NUVRION_API_UNIT:-container-nuvrion-api.service}"
api_container="${NUVRION_API_CONTAINER:-nuvrion-api}"
postgres_container="${NUVRION_POSTGRES_CONTAINER:-nuvrion-postgres}"
database="${NUVRION_DATABASE_NAME:-nuvrion}"
owner_role="${NUVRION_OWNER_ROLE:-nuvrion}"

say() { printf '%s\n' "$*"; }

# Prints the env file with the user and password of NUVRION_DATABASE_URL replaced and every other line untouched.
# usage: rewrite_database_url FILE USER PASSWORD
rewrite_database_url() {
  local file="$1" user="$2" password="$3"
  awk -v user="$user" -v password="$password" '
    /^NUVRION_DATABASE_URL=/ {
      value = substr($0, index($0, "=") + 1)
      if (match(value, /^[a-z]+:\/\/[^@]*@/)) {
        scheme = value; sub(/:\/\/.*/, "", scheme)
        rest = substr(value, RLENGTH + 1)
        $0 = "NUVRION_DATABASE_URL=" scheme "://" user ":" password "@" rest
      }
    }
    { print }' "$file"
}

main() {
  [[ "$role" =~ ^[a-z][a-z0-9_]{2,30}$ ]] || { say "FAILED: the role name must be 3 to 31 characters of a-z, 0-9 and _"; return 1; }
  [[ -f "$env_file" ]] || { say "FAILED: $env_file does not exist"; return 1; }
  command -v podman >/dev/null && command -v openssl >/dev/null || { say "FAILED: podman and openssl are required"; return 1; }

  psql_owner() { podman exec -i "$postgres_container" psql -U "$owner_role" -d "$database" -At -v ON_ERROR_STOP=1 -q "$@" 2>/dev/null; }
  group_present="$(printf "SELECT 1 FROM pg_roles WHERE rolname = 'nuvrion_app';\n" | psql_owner)"
  [[ "$group_present" == "1" ]] || { say "FAILED: the nuvrion_app group role does not exist; apply a release that contains migration 0031 first"; return 1; }
  if [[ "$(printf "SELECT 1 FROM pg_roles WHERE rolname = 'nuvrion_app' AND NOT rolsuper AND NOT rolcanlogin;\n" | psql_owner)" != "1" ]]; then
    say "FAILED: nuvrion_app is not the expected unprivileged group role"; return 1
  fi
  existed="$(printf "SELECT 1 FROM pg_roles WHERE rolname = '%s';\n" "$role" | psql_owner)"

  backup="$(mktemp -d "$(dirname "$env_file")/application-role-backup.XXXXXX")" || { say "FAILED: could not make a backup directory"; return 1; }
  cp -p "$env_file" "$backup/env" || { say "FAILED: could not back up the env file"; return 1; }
  say "backup made (directory mode 700)"

  password="$(openssl rand -hex 24)"  # secret-scan:allow (generated here at run time)
  [[ "${#password}" -eq 48 ]] || { say "FAILED: could not generate a password"; return 1; }

  rollback() {
    say "ROLLING BACK: $1"
    cp -p "$backup/env" "$env_file"
    systemctl --user restart "$api_unit" >/dev/null 2>&1
    if [[ "$existed" != "1" ]]; then printf "DROP ROLE IF EXISTS %s;\n" "$role" | psql_owner && say "role removed again"; fi
    say "the previous configuration is back; $backup is kept for you to look at and remove"
    return 1
  }

  # the role: created (or its password reset and membership ensured), as the owner
  role_statement="DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END \$\$;
ALTER ROLE %s WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT nuvrion_app TO %s;"  # secret-scan:allow (a statement template; the password is filled in at run time and goes to psql on stdin)
  printf "%s\n" "$(printf "$role_statement" "$role" "$role" "$role" "$password" "$role")" | psql_owner || { say "FAILED: PostgreSQL refused to create the role; nothing else was changed"; rm -rf "$backup"; return 1; }
  say "login role $role ready and a member of nuvrion_app"

  # proof through the pod address, which is the rule that checks the password
  host_ip="$(podman exec "$postgres_container" sh -c 'hostname -i' 2>/dev/null | awk '{print $1}')"
  [[ -n "$host_ip" ]] || rollback "could not determine the pod address"  || return 1
  as_role() { PGPASSWORD="$password" PGCONNECT_TIMEOUT=5 podman exec -e PGPASSWORD -e PGCONNECT_TIMEOUT "$postgres_container" psql -h "$host_ip" -U "$role" -d "$database" -At "$@" 2>&1; }
  [[ "$(as_role -c 'select current_user')" == "$role" ]] || { rollback "the new role could not log in over the pod address"; return 1; }
  [[ "$(as_role -c 'select rolsuper from pg_roles where rolname = current_user')" == "f" ]] || { rollback "the new role is a superuser"; return 1; }
  as_role -c 'select count(*) from identity.users' >/dev/null 2>&1 || { rollback "the new role cannot read the application tables"; return 1; }
  if as_role -c 'create table operations.must_not_exist(id int)' 2>&1 | grep -q -i 'permission denied'; then :; else rollback "the new role could create a table"; return 1; fi
  say "verified over the pod address: logs in, is not a superuser, reads the application tables, cannot create objects"

  # the env file: only NUVRION_DATABASE_URL changes
  rewrite_database_url "$env_file" "$role" "$password" > "$env_file.new" && chmod 600 "$env_file.new" && mv -f "$env_file.new" "$env_file" || { rollback "could not write the env file"; return 1; }
  grep -q "^NUVRION_DATABASE_URL=[a-z]*://$role:" "$env_file" || { rollback "the env file does not name the new role"; return 1; }
  [[ "$(stat -c %a "$env_file")" == "600" ]] || { rollback "the env file is not mode 600"; return 1; }
  say "env file updated: the API will connect as $role"

  systemctl --user restart "$api_unit" || { rollback "the API did not restart"; return 1; }
  ok=0
  for _ in $(seq 1 45); do
    health="$(podman exec "$api_container" node -e "fetch('http://127.0.0.1:4100/api/v1/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
    if grep -q '"status":"healthy"' <<<"$health"; then ok=1; break; fi
    sleep 2
  done
  [[ "$ok" == 1 ]] || { rollback "the API did not become healthy within 90 seconds"; return 1; }
  ready="$(podman exec "$api_container" node -e "fetch('http://127.0.0.1:4100/api/v1/readiness').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
  grep -q '"status":"ready"' <<<"$ready" || { rollback "readiness is not ready"; return 1; }
  say "API healthy and ready"

  # what the API's own database session is (the name only)
  session_user="$(podman exec "$api_container" node --input-type=module -e "
    import pg from 'pg';
    const c = new pg.Client({ connectionString: process.env.NUVRION_DATABASE_URL }); await c.connect();
    const r = await c.query('select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s');
    process.stdout.write(r.rows[0].u + ' ' + r.rows[0].s); await c.end();" 2>/dev/null)"
  [[ "$session_user" == "$role f" ]] || { rollback "the API's database session is '$session_user', not $role"; return 1; }
  say "the API's database session runs as $role (not a superuser)"

  rm -rf "$backup" && say "backup removed"
  say "DONE"
}

if [[ "${APPLICATION_ROLE_SOURCE_ONLY:-0}" != "1" ]]; then main "$@"; fi

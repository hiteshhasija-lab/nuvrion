import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throw-away host for the backup script: a configuration directory, a stand-in for the podman commands that talk to PostgreSQL, a recovery key pair (the private
// half stays outside the "host"), and a runner for the real script.
export const script = new URL('../backup-nuvrion.sh', import.meta.url).pathname;
export const capable = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    const run = (...args) => spawnSync('openssl', args, { cwd: probe, encoding: 'utf8' });
    if (run('genpkey', '-algorithm', 'ed25519', '-out', 'k.pem').status !== 0) return false;
    writeFileSync(join(probe, 'm'), 'x');
    return run('pkeyutl', '-sign', '-inkey', 'k.pem', '-rawin', '-in', 'm', '-out', 's').status === 0 && spawnSync('jq', ['--version']).status === 0;
  } finally { rmSync(probe, { recursive: true, force: true }); }
})();
export const skip = capable ? false : 'needs OpenSSL 3 (Ed25519 with -rawin) and jq';

const FAKE_PODMAN = `#!/usr/bin/env bash
# stand-in for: podman exec [-i] CONTAINER COMMAND...
[[ "$1" == exec ]] && shift; [[ "$1" == -i ]] && shift; shift   # container
cmd="$1"; shift
echo "$cmd $*" >> "$FAKE_LOG"
case "$cmd" in
  cat) [[ -n "\${FAKE_NO_VERSION:-}" ]] && exit 1; echo "0.1.186" ;;
  pg_dump) head -c 3000 /dev/urandom | base64 | sed '1s/^/PGDMP-fake /' ;;
  createdb) [[ -n "\${FAKE_CREATE_FAIL:-}" ]] && { echo "createdb failed" >&2; exit 1; }; exit 0 ;;
  dropdb) exit 0 ;;
  pg_restore) input="$(cat)"; if [[ -n "\${FAKE_RESTORE_FAIL:-}" || "\${input:0:10}" != "PGDMP-fake" ]]; then echo "pg_restore: error: could not restore" >&2; exit 1; fi; exit 0 ;;
  psql) counts="\${FAKE_COUNTS:-}"; if [[ -z "$counts" ]]; then counts='{"migrations":31,"latest":"0031","tables":28,"users":8,"connections":4,"resources":77,"tasks":4757,"auditEvents":10581,"agents":2}'; fi; echo "$counts" ;;
  *) echo "unexpected podman command: $cmd" >&2; exit 99 ;;
esac
`;

export function environment() {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-backup-test-'));
  const config = join(root, 'config'), backups = join(root, 'backups'), bin = join(root, 'bin');
  for (const dir of [config, bin, join(config, 'tls')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, 'nuvrion-api-final.env'), 'NUVRION_MASTER_KEY=very-secret-master-key-value\nPOSTGRES_PASSWORD=very-secret-db-password\n'); // secret-scan:allow (fake test values)
  writeFileSync(join(config, 'agent-signing-private.pem'), '-----BEGIN PRIVATE KEY-----\nfake-agent-signing-key\n-----END PRIVATE KEY-----\n'); // secret-scan:allow (fake test value, not a key)
  writeFileSync(join(config, 'agent-signing-public.pem'), 'fake public key\n');
  writeFileSync(join(config, 'nuvrion-lab-root-ca.pem'), 'fake ca\n');
  writeFileSync(join(config, 'Caddyfile'), 'example.test { }\n');
  writeFileSync(join(config, 'tls', 'site.key'), 'fake tls key\n');
  writeFileSync(join(config, 'ignored.bak-20260920'), 'not part of the bundle\n');
  writeFileSync(join(bin, 'podman'), FAKE_PODMAN); chmodSync(join(bin, 'podman'), 0o755);
  const log = join(root, 'podman.log'); writeFileSync(log, '');
  // the recovery key pair belongs to the owner’s machine; only the certificate is given to the host
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'recovery-key.pem'), '-out', join(root, 'recovery-cert.pem'), '-days', '30', '-subj', '/CN=test-recovery'], { encoding: 'utf8' });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NUVRION_BACKUP_ROOT: backups, NUVRION_CONFIG_DIR: config, FAKE_LOG: log };
  const run = (args = [], extra = {}) => spawnSync('bash', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, config, backups, log, env, run, recoveryCert: join(root, 'recovery-cert.pem'), recoveryKey: join(root, 'recovery-key.pem') };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync, cpSync, chmodSync, statSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environment, skip } from '../test-support/backup-environment.js';

// tools/backup.js is what the owner runs. Here it works on a set the real host script produced (really encrypted, really signed): it must verify it, decrypt it
// only with the right key, and refuse anything that has been touched.
const tool = new URL('../../tools/backup.js', import.meta.url).pathname;

function ownerWorld(e) {
  const initResult = e.run(['--init', e.recoveryCert]);
  assert.equal(initResult.status, 0, initResult.stderr);
  const publicKey = initResult.stdout.slice(initResult.stdout.indexOf('-----BEGIN PUBLIC KEY-----'));
  assert.equal(e.run().status, 0);
  const name = readdirSync(e.backups).find(entry => /^\d{8}T\d{6}Z$/.test(entry));
  const destination = join(e.root, 'Backup'), sets = join(destination, 'NOVAAPP01', 'sets', name);
  mkdirSync(sets, { recursive: true });
  for (const file of ['manifest.json', 'manifest.sig', 'COMPLETE', 'nuvrion.dump.cms', 'nuvrion-config.tar.cms']) cpSync(join(e.backups, name, file), join(sets, file));
  const publicKeyFile = join(e.root, 'host-signing-public.pem'); writeFileSync(publicKeyFile, publicKey);
  const configFile = join(e.root, 'owner-config.json');
  writeFileSync(configFile, JSON.stringify({ host: 'h.example', user: 'owner', destination, signingPublicKeyFile: publicKeyFile, recoveryKeyFile: e.recoveryKey, maxAgeHours: 100000 }));
  const run = (args, extra = {}) => spawnSync('node', [tool, ...args], { env: { ...process.env, NUVRION_BACKUP_CONFIG: configFile, ...extra }, encoding: 'utf8' });
  return { name, sets, destination, run, hostPlainDump: join(e.backups, name, 'nuvrion.dump') };
}
const withOwner = (work) => { const e = environment(); try { return work(e, ownerWorld(e)); } finally { rmSync(e.root, { recursive: true, force: true }); } };

test('verify passes on a good set and reports its age; an empty archive of evidence is fine', { skip }, () => withOwner((e, o) => {
  const result = o.run(['verify']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 backup sets held, the newest \d{8}T\d{6}Z/);
  assert.match(result.stdout, /0 releases in the evidence archive/);
  assert.match(result.stdout, /All checks passed/);
}));

test('verify fails when a file of a set is changed, and when the newest set is older than allowed', { skip }, () => withOwner((e, o) => {
  chmodSync(o.sets, 0o700); chmodSync(join(o.sets, 'nuvrion.dump.cms'), 0o600);
  writeFileSync(join(o.sets, 'nuvrion.dump.cms'), 'tampered');
  const result = o.run(['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NUV_BACKUP_SIZE_MISMATCH/);
}));

test('verify fails when the newest set is too old', { skip }, () => withOwner((e, o) => {
  const configFile = join(e.root, 'owner-config.json'), config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, maxAgeHours: -1 }));
  const result = o.run(['verify']);
  assert.equal(result.status, 1); assert.match(result.stderr, /hours old; the limit is -1/);
}));

test('decrypt writes the dump and the configuration, identical to what the host held, and refuses a wrong key or a damaged set', { skip }, () => withOwner((e, o) => {
  const out = join(e.root, 'restore');
  const result = o.run(['decrypt', 'latest', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(out, 'nuvrion.dump')), readFileSync(o.hostPlainDump));
  assert.match(readFileSync(join(out, 'config', 'nuvrion-api-final.env'), 'utf8'), /NUVRION_MASTER_KEY=very-secret-master-key-value/);
  assert.equal(statSync(join(out, 'nuvrion.dump')).mode & 0o777, 0o600);
  // another key cannot read it
  const other = join(e.root, 'other-key.pem');
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', other, '-out', join(e.root, 'other-cert.pem'), '-days', '2', '-subj', '/CN=other'], { encoding: 'utf8' });
  const configFile = join(e.root, 'owner-config.json'), config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, recoveryKeyFile: other }));
  const wrong = o.run(['decrypt', 'latest', join(e.root, 'restore2')]);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /could not decrypt/);
  // a damaged set is not decrypted at all
  writeFileSync(configFile, JSON.stringify(config));
  chmodSync(o.sets, 0o700); chmodSync(join(o.sets, 'manifest.json'), 0o600);
  writeFileSync(join(o.sets, 'manifest.json'), '{}');
  const damaged = o.run(['decrypt', 'latest', join(e.root, 'restore3')]);
  assert.equal(damaged.status, 1); assert.match(damaged.stderr, /did not pass its checks, so it is not decrypted/);
  assert.ok(!existsSync(join(e.root, 'restore3', 'nuvrion.dump')));
  assert.equal(o.run(['decrypt', 'no-such-set', join(e.root, 'restore4')]).status, 1);
}));

test('init creates the recovery key and the configuration once and never replaces a key; host-key stores only a public key', { skip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'nuvrion-home-'));
  try {
    const run = (args, extra = {}) => spawnSync('node', [tool, ...args], { env: { ...process.env, HOME: home, NUVRION_BACKUP_CONFIG: '', ...extra }, encoding: 'utf8' });
    const destination = join(home, 'Backup');
    const first = run(['init', '--host', 'h.example', '--user', 'owner', '--identity', '~/.ssh/key', '--destination', destination]);
    assert.equal(first.status, 0, first.stderr);
    const key = join(home, '.config', 'nuvrion-backup', 'recovery-key.pem');
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.match(first.stdout, /NOT on this computer and NOT in iCloud/);
    const config = JSON.parse(readFileSync(join(home, '.config', 'nuvrion-backup', 'config.json'), 'utf8'));
    assert.deepEqual([config.host, config.user, config.destination], ['h.example', 'owner', destination]);
    const before = readFileSync(key);
    const second = run(['init', '--host', 'h.example', '--user', 'owner', '--destination', destination]);
    assert.equal(second.status, 1); assert.match(second.stderr, /already exists/);
    assert.deepEqual(readFileSync(key), before, 'the key is untouched');
    writeFileSync(join(home, 'private.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    assert.equal(run(['host-key', join(home, 'private.pem')]).status, 1, 'a private key is not accepted as the host’s public key');
    writeFileSync(join(home, 'public.pem'), 'noise\n-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n');
    assert.equal(run(['host-key', join(home, 'public.pem')]).status, 0);
    assert.match(readFileSync(join(home, '.config', 'nuvrion-backup', 'host-signing-public.pem'), 'utf8'), /^-----BEGIN PUBLIC KEY-----/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

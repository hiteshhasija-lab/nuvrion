import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkBackupSet } from '../../modules/platform/src/backup-set.js';

// deploy/backup-nuvrion.sh runs on the host from a timer. These tests run the real script with the real openssl, tar and jq, and a stand-in for the podman
// commands that talk to PostgreSQL, against a throw-away configuration directory: what it writes, what it encrypts, what it signs, what it refuses, what it
// leaves behind when it fails, and how it prunes.
import { environment, skip } from '../test-support/backup-environment.js';
const withEnvironment = async (work) => { const e = environment(); try { return await work(e); } finally { rmSync(e.root, { recursive: true, force: true }); } };
const initialised = e => { const result = e.run(['--init', e.recoveryCert]); assert.equal(result.status, 0, result.stderr); return result.stdout.slice(result.stdout.indexOf('-----BEGIN PUBLIC KEY-----')); };
const sets = e => readdirSync(e.backups).filter(name => /^\d{8}T\d{6}Z$/.test(name)).sort();

test('--init installs the certificate, creates the signing key once, prints the public key, and refuses a file that is not a certificate', { skip }, () => withEnvironment(e => {
  const publicKey = initialised(e);
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/);
  assert.equal(statSync(join(e.config, 'backup-signing-private.pem')).mode & 0o777, 0o600);
  const before = readFileSync(join(e.config, 'backup-signing-private.pem'), 'utf8');
  assert.equal(initialised(e), publicKey, 'running it again prints the same key');
  assert.equal(readFileSync(join(e.config, 'backup-signing-private.pem'), 'utf8'), before, 'and does not replace the signing key');
  writeFileSync(join(e.root, 'junk.pem'), 'not a certificate');
  assert.notEqual(e.run(['--init', join(e.root, 'junk.pem')]).status, 0);
}));

test('a backup writes an encrypted, signed, complete set that the owner’s machine can verify and decrypt', { skip }, () => withEnvironment(async e => {
  const publicKeyPem = initialised(e);
  const result = e.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const [name] = sets(e), dir = join(e.backups, name);
  assert.deepEqual(readdirSync(dir).sort(), ['COMPLETE', 'manifest.json', 'manifest.sig', 'nuvrion-config.tar.cms', 'nuvrion.dump', 'nuvrion.dump.cms']);
  assert.deepEqual(await checkBackupSet(dir, { publicKeyPem }), [], 'the manifest, the signature, every checksum and the restore check are good');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'nuvrion-backup/1');
  assert.deepEqual([manifest.restoreCheck.passed, manifest.restoreCheck.migrations, manifest.restoreCheck.tables], [true, 31, 28]);
  assert.equal(manifest.applicationVersion, '0.1.186', 'the version the running container reports');
  // decrypt as the owner would, and check the plain hashes the manifest records
  const decrypt = file => spawnSync('openssl', ['smime', '-decrypt', '-binary', '-inform', 'DER', '-in', join(dir, file), '-inkey', e.recoveryKey], { maxBuffer: 1 << 26 });
  const dump = decrypt('nuvrion.dump.cms'), config = decrypt('nuvrion-config.tar.cms');
  assert.equal(dump.status, 0); assert.equal(config.status, 0);
  assert.deepEqual(dump.stdout, readFileSync(join(dir, 'nuvrion.dump')));
  const byName = Object.fromEntries(manifest.files.map(file => [file.name, file]));
  assert.equal(byName['nuvrion.dump.cms'].plaintextSizeBytes, dump.stdout.length);
  const listing = spawnSync('tar', ['-t'], { input: config.stdout, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(entry => entry.replace(/\/$/, '')).sort();
  assert.deepEqual(listing, ['Caddyfile', 'agent-signing-private.pem', 'agent-signing-public.pem', 'nuvrion-api-final.env', 'nuvrion-lab-root-ca.pem', 'tls', 'tls/site.key'], 'the configuration, and not the .bak copy');
  assert.equal(readFileSync(join(e.backups, 'status.json'), 'utf8').includes('"ok":true'), true);
  assert.ok(!existsSync(join(e.backups, '.lock')), 'the lock is released');
  assert.equal(readFileSync(e.log, 'utf8').split('\n').filter(line => /^(createdb|dropdb)/.test(line)).length >= 2, true, 'the scratch database was created and dropped');
}));

test('nothing readable leaves the host: the encrypted files hold none of the secrets, and only the plain dump of this host is kept in clear', { skip }, () => withEnvironment(e => {
  initialised(e);
  assert.equal(e.run().status, 0);
  const dir = join(e.backups, sets(e)[0]);
  for (const file of ['nuvrion.dump.cms', 'nuvrion-config.tar.cms', 'manifest.json']) {
    const text = readFileSync(join(dir, file)).toString('latin1');
    for (const secret of ['very-secret-master-key-value', 'very-secret-db-password', 'fake-agent-signing-key', 'fake tls key']) assert.ok(!text.includes(secret), `${file} does not contain ${secret}`);
  }
}));

test('a dump that does not restore leaves no set, records the failure, drops the scratch database and exits non-zero', { skip }, () => withEnvironment(e => {
  initialised(e);
  const result = e.run([], { FAKE_RESTORE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring the dump .* failed/);
  assert.deepEqual(sets(e), [], 'no half-written set is left');
  assert.match(readFileSync(join(e.backups, 'last-failure.json'), 'utf8'), /"exitCode":1/);
  assert.ok(readFileSync(e.log, 'utf8').split('\n').some(line => line.startsWith('dropdb') && line.includes('nuvrion_restorecheck_')), 'the scratch database is dropped');
  assert.ok(!existsSync(join(e.backups, '.lock')));
  assert.equal(e.run().status, 0, 'the next run succeeds');
  assert.ok(!existsSync(join(e.backups, 'last-failure.json')), 'and clears the failure');
}));

test('a restored copy with no tables is refused even if pg_restore succeeded', { skip }, () => withEnvironment(e => {
  initialised(e);
  const result = e.run([], { FAKE_COUNTS: '{"migrations":0,"latest":null,"tables":0}' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no migrations or no tables/); assert.deepEqual(sets(e), []);
}));

test('a missing required configuration file, or a host that was never set up, stops the run before anything is dumped', { skip }, () => withEnvironment(e => {
  assert.match(e.run().stderr, /not set up/);
  initialised(e);
  rmSync(join(e.config, 'agent-signing-private.pem'));
  const result = e.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /required file missing/);
  assert.ok(!readFileSync(e.log, 'utf8').includes('pg_dump'), 'no dump was taken');
}));

test('a second run while one is in progress skips; a lock left by a dead run is taken over', { skip }, () => withEnvironment(e => {
  initialised(e);
  mkdirSync(join(e.backups, '.lock'), { recursive: true }); writeFileSync(join(e.backups, '.lock', 'pid'), String(process.pid));
  const skipped = e.run();
  assert.equal(skipped.status, 0); assert.match(skipped.stdout, /another backup is running/); assert.deepEqual(sets(e), []);
  writeFileSync(join(e.backups, '.lock', 'pid'), '999999');
  assert.equal(e.run().status, 0); assert.equal(sets(e).length, 1);
}));

test('the host keeps a plain dump for the newest sets only and complete sets for the newest N; incomplete directories are left alone', { skip }, () => withEnvironment(e => {
  initialised(e);
  const old = ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', '20260104T000000Z'];
  for (const name of old) { mkdirSync(join(e.backups, name)); writeFileSync(join(e.backups, name, 'COMPLETE'), ''); writeFileSync(join(e.backups, name, 'nuvrion.dump'), 'plain'); writeFileSync(join(e.backups, name, 'nuvrion.dump.cms'), 'enc'); }
  mkdirSync(join(e.backups, '20260105T000000Z')); writeFileSync(join(e.backups, '20260105T000000Z', 'nuvrion.dump'), 'half written, no COMPLETE');
  assert.equal(e.run([], { NUVRION_BACKUP_KEEP_SETS: '3', NUVRION_BACKUP_KEEP_PLAIN: '2' }).status, 0);
  const kept = sets(e);
  assert.deepEqual(kept.filter(name => name !== '20260105T000000Z').length, 3, 'three complete sets remain');
  assert.ok(!kept.includes('20260101T000000Z') && !kept.includes('20260102T000000Z'), 'the oldest complete sets are gone');
  assert.ok(existsSync(join(e.backups, '20260105T000000Z', 'nuvrion.dump')), 'an incomplete directory is not touched by retention');
  const plain = kept.filter(name => existsSync(join(e.backups, name, 'nuvrion.dump')) && existsSync(join(e.backups, name, 'COMPLETE')));
  assert.equal(plain.length, 2, 'two sets keep a plain dump');
  assert.ok(existsSync(join(e.backups, '20260104T000000Z', 'nuvrion.dump.cms')), 'the encrypted dump of a set that lost its plain dump stays');
}));

test('a container that cannot report its version is recorded as unknown, not guessed, and does not stop the backup', { skip }, () => withEnvironment(async e => {
  initialised(e);
  assert.equal(e.run([], { FAKE_NO_VERSION: '1' }).status, 0);
  const dir = join(e.backups, sets(e)[0]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).applicationVersion, 'unknown');
}));

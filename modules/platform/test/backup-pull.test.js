import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullBackups, PULLED_FILES, removeSet } from '../src/backup-pull.js';
import { normaliseConfig, BackupConfigError } from '../src/backup-config.js';
import { sha256, BACKUP_FORMAT } from '../src/backup-set.js';
import { fakeRemote } from '../test-support/fake-remote.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const SECRET_PLAIN = 'the plain dump that must never be fetched';

function hostSet(remoteRoot, name, { tamper = false, signWith = privateKey, incomplete = false } = {}) {
  const dir = join(remoteRoot, 'nuvrion-backups', name);
  mkdirSync(dir, { recursive: true });
  const files = { 'nuvrion.dump.cms': Buffer.from(`encrypted dump ${name}`), 'nuvrion-config.tar.cms': Buffer.from(`encrypted config ${name}`) };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, 'nuvrion.dump'), SECRET_PLAIN);
  const created = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`;
  const manifest = Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, createdAt: created, files: Object.entries(files).map(([file, bytes]) => ({ name: file, sizeBytes: bytes.length, sha256: sha256(bytes) })), restoreCheck: { passed: true, migrations: 31, tables: 28 } }));
  writeFileSync(join(dir, 'manifest.json'), manifest);
  writeFileSync(join(dir, 'manifest.sig'), sign(null, manifest, signWith));
  if (tamper) writeFileSync(join(dir, 'nuvrion.dump.cms'), 'changed after signing');
  if (!incomplete) writeFileSync(join(dir, 'COMPLETE'), '');
}

async function withWorld(work) {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-pull-')), remoteRoot = join(root, 'remote'), destination = join(root, 'Backup');
  mkdirSync(remoteRoot);
  const config = normaliseConfig({ host: 'host.example', user: 'owner', destination });
  try { return await work({ root, remoteRoot, destination, config, sets: () => readdirSync(join(destination, 'NOVAAPP01', 'sets')).sort() }); } finally {
    await removeSet(root);
  }
}
const NOW = new Date('2026-10-17T05:30:00Z');

test('new complete sets are pulled, checked and filed read-only; the plain dump is never fetched', async () => withWorld(async w => {
  hostSet(w.remoteRoot, '20261017T040000Z'); hostSet(w.remoteRoot, '20261017T050000Z');
  const remote = fakeRemote(w.remoteRoot);
  const result = await pullBackups({ config: w.config, run: remote.run, publicKeyPem, now: NOW });
  assert.equal(result.error, null);
  assert.deepEqual(result.pulled.sort(), ['20261017T040000Z', '20261017T050000Z']);
  assert.deepEqual(w.sets(), ['20261017T040000Z', '20261017T050000Z']);
  for (const name of w.sets()) {
    const dir = join(w.destination, 'NOVAAPP01', 'sets', name);
    assert.deepEqual(readdirSync(dir).sort(), [...PULLED_FILES].sort());
    assert.ok(!existsSync(join(dir, 'nuvrion.dump')), 'the plain dump was not copied');
    assert.equal(statSync(join(dir, 'manifest.json')).mode & 0o222, 0, 'files are read-only');
  }
  assert.deepEqual([result.newestSet, result.ageHours, result.stale], ['20261017T050000Z', 0.5, false]);
  assert.equal(JSON.parse(readFileSync(join(w.destination, 'NOVAAPP01', 'status.json'), 'utf8')).newestSet, '20261017T050000Z');
}));

test('a second pull fetches only sets it does not have', async () => withWorld(async w => {
  hostSet(w.remoteRoot, '20261017T040000Z');
  await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot).run, publicKeyPem, now: NOW });
  hostSet(w.remoteRoot, '20261017T050000Z');
  const remote = fakeRemote(w.remoteRoot);
  const result = await pullBackups({ config: w.config, run: remote.run, publicKeyPem, now: NOW });
  assert.deepEqual(result.pulled, ['20261017T050000Z']);
  assert.equal(remote.calls.filter(call => call[0] === 'rsync').length, 1);
}));

test('a tampered set, a set signed by another key and an interrupted set are never filed; the first two are quarantined with the reasons', async () => withWorld(async w => {
  hostSet(w.remoteRoot, '20261017T030000Z', { tamper: true });
  hostSet(w.remoteRoot, '20261017T040000Z', { signWith: generateKeyPairSync('ed25519').privateKey });
  hostSet(w.remoteRoot, '20261017T050000Z', { incomplete: true });
  hostSet(w.remoteRoot, '20261017T052000Z');
  const result = await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot).run, publicKeyPem, now: NOW });
  assert.deepEqual(w.sets(), ['20261017T052000Z'], 'only the good set is filed');
  assert.deepEqual(result.quarantined.map(q => [q.name, q.problems]), [['20261017T040000Z', ['NUV_BACKUP_SIGNATURE_INVALID']], ['20261017T030000Z', ['NUV_BACKUP_SIZE_MISMATCH']]]);
  const held = readdirSync(join(w.destination, 'NOVAAPP01', 'quarantine'));
  assert.equal(held.length, 2);
  assert.ok(existsSync(join(w.destination, 'NOVAAPP01', 'quarantine', held[0], 'problems.json')));
}));

test('an unreachable host is reported, nothing already held is lost, and an old newest set is flagged stale', async () => withWorld(async w => {
  hostSet(w.remoteRoot, '20261017T010000Z');
  await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot).run, publicKeyPem, now: NOW });
  const result = await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot, { failList: true }).run, publicKeyPem, now: new Date('2026-10-17T09:00:00Z') });
  assert.match(result.error, /could not list the backups/);
  assert.deepEqual(w.sets(), ['20261017T010000Z']);
  assert.equal(result.stale, true); assert.equal(result.ageHours, 8);
}));

test('a failed transfer is reported and leaves nothing half-filed', async () => withWorld(async w => {
  hostSet(w.remoteRoot, '20261017T040000Z'); hostSet(w.remoteRoot, '20261017T050000Z');
  const result = await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot, { failRsyncFor: '20261017T050000Z' }).run, publicKeyPem, now: NOW });
  assert.match(result.error, /rsync of 20261017T050000Z failed/);
  assert.deepEqual(w.sets(), ['20261017T040000Z']);
  assert.deepEqual(readdirSync(join(w.destination, 'NOVAAPP01', 'incoming')), []);
}));

test('retention removes the sets that fall out of the policy, even though they are read-only', async () => withWorld(async w => {
  w.config.retention = { hourly: 2, daily: 0, weekly: 0 };
  for (const name of ['20261017T030000Z', '20261017T040000Z', '20261017T050000Z']) hostSet(w.remoteRoot, name);
  const result = await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot).run, publicKeyPem, now: NOW });
  assert.deepEqual(w.sets(), ['20261017T040000Z', '20261017T050000Z']);
  assert.equal(result.setsKept, 2);
  hostSet(w.remoteRoot, '20261017T052000Z');
  const second = await pullBackups({ config: w.config, run: fakeRemote(w.remoteRoot).run, publicKeyPem, now: NOW });
  assert.deepEqual(second.removed, ['20261017T040000Z']);
  assert.deepEqual(w.sets(), ['20261017T050000Z', '20261017T052000Z']);
}));

test('the configuration refuses unsafe values: shell metacharacters, parent paths, relative destinations and anything under ~/.config', () => {
  const ok = { host: 'h.example', user: 'owner', destination: '/Users/x/Backup' };
  assert.equal(normaliseConfig(ok).remoteBackupRoot, 'nuvrion-backups');
  for (const bad of [{ host: 'h; rm -rf /' }, { user: '$(whoami)' }, { remoteBackupRoot: '../etc' }, { remoteBackupRoot: 'a b' }, { remoteReleases: '/abs' }, { destination: 'relative/path' }, { destination: `${process.env.HOME}/.config/backups` }]) {
    assert.throws(() => normaliseConfig({ ...ok, ...bad }), BackupConfigError, JSON.stringify(bad));
  }
});

test('optional settings have safe defaults and can be overridden', () => {
  const ok = { host: 'h.example', user: 'owner', destination: '/Users/x/Backup' };
  const defaults = normaliseConfig(ok);
  assert.deepEqual([defaults.immutable, defaults.maxAgeHours, defaults.retention], [true, 3, { hourly: 48, daily: 30, weekly: 26 }]);
  const custom = normaliseConfig({ ...ok, immutable: false, maxAgeHours: 6, retention: { hourly: 10 } });
  assert.deepEqual([custom.immutable, custom.maxAgeHours, custom.retention], [false, 6, { hourly: 10, daily: 30, weekly: 26 }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBackupSet, retentionPlan, setTime, ageHours, sha256, BackupSetError, BACKUP_FORMAT } from '../src/backup-set.js';

// A backup set is trusted only if its manifest carries the host’s signature, every file matches the manifest, the set is complete and the host restored it.
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey }; };
const host = pair();

function makeSet({ name = '20261017T031500Z', mutate = () => {}, key = host, complete = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-set-')), dir = join(root, name);
  mkdirSync(dir);
  const files = { 'nuvrion.dump.cms': Buffer.from('encrypted dump'), 'nuvrion-config.tar.cms': Buffer.from('encrypted config') };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  const manifest = {
    format: BACKUP_FORMAT, createdAt: '2026-10-17T03:15:00Z', host: 'NOVAAPP01', applicationVersion: '0.1.186',
    files: Object.entries(files).map(([file, bytes]) => ({ name: file, sizeBytes: bytes.length, sha256: sha256(bytes) })),
    restoreCheck: { passed: true, migrations: 31, latest: '0031', tables: 28 }
  };
  const context = { manifest, dir, files };
  mutate(context);
  const bytes = Buffer.from(JSON.stringify(context.manifest));
  writeFileSync(join(dir, 'manifest.json'), bytes);
  writeFileSync(join(dir, 'manifest.sig'), sign(null, bytes, key.privateKey));
  if (complete) writeFileSync(join(dir, 'COMPLETE'), '');
  return { root, dir };
}
const codes = async options => { const { root, dir } = makeSet(options); try { return (await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).map(problem => problem.code); } finally { rmSync(root, { recursive: true, force: true }); } };

test('a complete, signed set whose files match its manifest has no problems', async () => {
  assert.deepEqual(await codes({}), []);
});

test('a set signed by another key, or with a changed manifest, is refused', async () => {
  assert.deepEqual(await codes({ key: pair() }), ['NUV_BACKUP_SIGNATURE_INVALID']);
  const { root, dir } = makeSet();
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.applicationVersion = '9.9.9';
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.deepEqual((await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).map(problem => problem.code), ['NUV_BACKUP_SIGNATURE_INVALID']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed, shortened, missing or extra file is reported', async () => {
  const { root, dir } = makeSet();
  try {
    const problems = async () => (await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).map(problem => problem.code);
    writeFileSync(join(dir, 'nuvrion.dump.cms'), Buffer.from('encrypted dumq'));
    assert.deepEqual(await problems(), ['NUV_BACKUP_CHECKSUM_MISMATCH']);
    writeFileSync(join(dir, 'nuvrion.dump.cms'), Buffer.from('short'));
    assert.deepEqual(await problems(), ['NUV_BACKUP_SIZE_MISMATCH']);
    rmSync(join(dir, 'nuvrion.dump.cms'));
    assert.deepEqual(await problems(), ['NUV_BACKUP_FILE_MISSING']);
    writeFileSync(join(dir, 'nuvrion.dump.cms'), Buffer.from('encrypted dump'));
    writeFileSync(join(dir, 'smuggled.cms'), 'x');
    assert.deepEqual(await problems(), ['NUV_BACKUP_UNLISTED_FILE']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted set, a missing manifest or signature, and a manifest that is not JSON are each reported', async () => {
  assert.deepEqual(await codes({ complete: false }), ['NUV_BACKUP_INCOMPLETE']);
  const { root, dir } = makeSet();
  try {
    rmSync(join(dir, 'manifest.sig'));
    assert.ok((await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).some(problem => problem.code === 'NUV_BACKUP_SIGNATURE_MISSING'));
    rmSync(join(dir, 'manifest.json'));
    assert.ok((await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).some(problem => problem.code === 'NUV_BACKUP_MANIFEST_MISSING'));
    writeFileSync(join(dir, 'manifest.json'), 'not json');
    assert.ok((await checkBackupSet(dir, { publicKeyPem: host.publicKeyPem })).some(problem => problem.code === 'NUV_BACKUP_MANIFEST_INVALID'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a set the host could not restore is not trusted, and neither is one that restored nothing', async () => {
  assert.deepEqual(await codes({ mutate: c => { c.manifest.restoreCheck = { passed: false }; } }), ['NUV_BACKUP_RESTORE_CHECK']);
  assert.deepEqual(await codes({ mutate: c => { delete c.manifest.restoreCheck; } }), ['NUV_BACKUP_RESTORE_CHECK']);
  assert.deepEqual(await codes({ mutate: c => { c.manifest.restoreCheck = { passed: true, migrations: 0, tables: 28 }; } }), ['NUV_BACKUP_RESTORE_CHECK']);
});

test('a manifest that omits a required file, names an unsafe file, has another format or another time is refused', async () => {
  assert.ok((await codes({ mutate: c => { c.manifest.files = c.manifest.files.filter(file => file.name !== 'nuvrion-config.tar.cms'); } })).includes('NUV_BACKUP_FILE_NOT_LISTED'));
  assert.ok((await codes({ mutate: c => { c.manifest.files.push({ name: '../../etc/passwd', sizeBytes: 1, sha256: 'x' }); } })).includes('NUV_BACKUP_FILE_NAME'));
  assert.ok((await codes({ mutate: c => { c.manifest.format = 'other/9'; } })).includes('NUV_BACKUP_FORMAT'));
  assert.ok((await codes({ mutate: c => { c.manifest.createdAt = '2026-10-16T03:15:00Z'; } })).includes('NUV_BACKUP_NAME_MISMATCH'));
});

const hourly = (startName, count) => Array.from({ length: count }, (_, i) => { const t = new Date(setTime(startName).getTime() - i * 3_600_000).toISOString(); return `${t.slice(0, 4)}${t.slice(5, 7)}${t.slice(8, 10)}T${t.slice(11, 13)}${t.slice(14, 16)}${t.slice(17, 19)}Z`; });

test('retention keeps the newest 48 hourly sets, then one per day for 30 days, then one per week for 26 weeks', () => {
  const names = hourly('20261017T030000Z', 24 * 400);   // 400 days of hourly sets
  const { keep, remove } = retentionPlan(names);
  assert.deepEqual(keep.slice(0, 48), names.slice(0, 48), 'the newest 48 are all kept');
  const rest = keep.slice(48);
  const days = new Set(rest.map(name => name.slice(0, 8)));
  assert.equal(rest.length, days.size, 'beyond the first 48 there is at most one set per day');
  assert.ok(keep.length <= 48 + 30 + 26 + 1 && keep.length >= 48 + 30 + 20, `kept ${keep.length}`);
  assert.equal(keep.length + remove.length, names.length);
  assert.ok(keep.includes(names[0]) && !remove.includes(names[0]));
  assert.ok(remove.includes(names.at(-1)), 'the oldest set of 400 days is gone');
});

test('retention keeps everything when there is little, ignores names that are not sets, and does not choke on none', () => {
  const few = hourly('20261017T030000Z', 5);
  assert.deepEqual(retentionPlan(few).remove, []);
  assert.deepEqual(retentionPlan([...few, 'incoming', 'notes.txt', '2026']).keep, few);
  assert.deepEqual(retentionPlan([]), { keep: [], remove: [] });
});

test('set names are times, and an invalid name is an error', () => {
  assert.equal(setTime('20261017T031500Z').toISOString(), '2026-10-17T03:15:00.000Z');
  assert.throws(() => setTime('../x'), BackupSetError);
  assert.equal(ageHours('20261017T031500Z', new Date('2026-10-17T05:45:00Z')), 2.5);
});

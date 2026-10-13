import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupManifest, verifyBackupManifest, BackupManifestError } from '../src/backup-manifest.js';
import { latestMigrationVersion } from '../src/migrations.js';

// The backup manifest authenticates a database backup and says which schema it holds. Its default schema version follows the migrations that ship
// (it was a constant, 0018, long after the schema moved on).
const key = 'k'.repeat(40);
const bytes = Buffer.from('a backup');

test('a manifest records size, digest and, by default, the newest schema version that ships', () => {
  const manifest = createBackupManifest({ backupBytes: bytes, integrityKey: key });
  assert.equal(manifest.payload.schemaVersion, latestMigrationVersion());
  assert.equal(manifest.payload.sizeBytes, bytes.length);
  assert.match(manifest.payload.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyBackupManifest({ backupBytes: bytes, manifest, integrityKey: key }).schemaVersion, latestMigrationVersion());
});

test('a backup of an older schema is refused unless that schema is explicitly accepted', () => {
  const manifest = createBackupManifest({ backupBytes: bytes, integrityKey: key, schemaVersion: '0028' });
  assert.throws(() => verifyBackupManifest({ backupBytes: bytes, manifest, integrityKey: key }), error => error instanceof BackupManifestError && error.code === 'NUV_BACKUP_SCHEMA_INCOMPATIBLE');
  assert.equal(verifyBackupManifest({ backupBytes: bytes, manifest, integrityKey: key, requiredSchemaVersion: '0028' }).schemaVersion, '0028');
});

test('changed bytes, a changed manifest, a wrong key and a short key are each refused', () => {
  const manifest = createBackupManifest({ backupBytes: bytes, integrityKey: key });
  const code = run => { try { run(); } catch (error) { return error.code; } return null; };
  assert.equal(code(() => verifyBackupManifest({ backupBytes: Buffer.from('a backuq'), manifest, integrityKey: key })), 'NUV_BACKUP_CHECKSUM_MISMATCH', 'same size, other content');
  assert.equal(code(() => verifyBackupManifest({ backupBytes: Buffer.from('another'), manifest, integrityKey: key })), 'NUV_BACKUP_SIZE_MISMATCH', 'other size');
  const edited = { ...manifest, payload: { ...manifest.payload, sizeBytes: 1 } };
  assert.equal(code(() => verifyBackupManifest({ backupBytes: bytes, manifest: edited, integrityKey: key })), 'NUV_BACKUP_SIGNATURE_INVALID');
  assert.equal(code(() => verifyBackupManifest({ backupBytes: bytes, manifest, integrityKey: 'z'.repeat(40) })), 'NUV_BACKUP_SIGNATURE_INVALID');
  assert.equal(code(() => createBackupManifest({ backupBytes: bytes, integrityKey: 'short' })), 'NUV_BACKUP_KEY_INVALID');
  assert.equal(code(() => verifyBackupManifest({ backupBytes: bytes, manifest: {}, integrityKey: key })), 'NUV_BACKUP_MANIFEST_INVALID');
});

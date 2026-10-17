// Scheduled backups of Nuvrion, as they are checked after they have left the host.
//
// A backup set is a directory named for its UTC time (20261017T031500Z) with the files deploy/backup-nuvrion.sh wrote:
//   nuvrion.dump.cms           the pg_dump -Fc, encrypted to the recovery certificate (only the owner of the recovery key can read it)
//   nuvrion-config.tar.cms     the env file, the agent signing keys, the CA, the TLS certificate and key and the Caddyfile, encrypted the same way
//   manifest.json              what the set holds (sizes, SHA-256 of the encrypted files and of the plain ones), the schema it was taken at and the result of
//                              restoring it into a scratch database on the host
//   manifest.sig               an Ed25519 signature over the exact bytes of manifest.json, made with a key that lives only on the host
//   COMPLETE                   written last: a set without it was interrupted
// Nothing in a set can be read without the recovery key, and nothing can be changed without the manifest no longer matching its signature or its files.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const BACKUP_FORMAT = 'nuvrion-backup/1';
export const SET_NAME = /^\d{8}T\d{6}Z$/;
export const REQUIRED_FILES = ['nuvrion.dump.cms', 'nuvrion-config.tar.cms'];

export class BackupSetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// 20261017T031500Z -> Date
export function setTime(name) {
  if (!SET_NAME.test(name)) throw new BackupSetError('NUV_BACKUP_SET_NAME', `Not a backup set name: ${String(name).slice(0, 40)}`);
  return new Date(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`);
}

export function signatureIsValid({ manifestBytes, signature, publicKeyPem }) {
  try { return verify(null, manifestBytes, createPublicKey(publicKeyPem), signature); } catch { return false; }
}

// Everything that can be wrong with one set, as a list of { code, message } (empty: the set is good). `files` is an object { name: Buffer-or-path reader } so
// the caller decides how bytes are read; here a directory is read through readFile and stat.
export async function checkBackupSet(directory, { publicKeyPem, name = directory.split('/').pop() } = {}) {
  const problems = [], add = (code, message) => problems.push({ code, message });
  let manifestBytes, signature, manifest = null;
  try { await stat(join(directory, 'COMPLETE')); } catch { add('NUV_BACKUP_INCOMPLETE', 'The set has no COMPLETE marker: it was interrupted.'); }
  try { manifestBytes = await readFile(join(directory, 'manifest.json')); } catch { add('NUV_BACKUP_MANIFEST_MISSING', 'manifest.json is missing.'); }
  try { signature = await readFile(join(directory, 'manifest.sig')); } catch { add('NUV_BACKUP_SIGNATURE_MISSING', 'manifest.sig is missing.'); }
  if (manifestBytes) {
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { add('NUV_BACKUP_MANIFEST_INVALID', 'manifest.json is not JSON.'); }
  }
  if (manifestBytes && signature && !signatureIsValid({ manifestBytes, signature, publicKeyPem })) add('NUV_BACKUP_SIGNATURE_INVALID', 'The manifest does not match its signature (or the signing key is not the host’s).');
  if (!manifest) return problems;

  if (manifest.format !== BACKUP_FORMAT) add('NUV_BACKUP_FORMAT', `Unknown format ${JSON.stringify(manifest.format)}.`);
  if (SET_NAME.test(name) && manifest.createdAt && Math.abs(new Date(manifest.createdAt) - setTime(name)) > 60_000) add('NUV_BACKUP_NAME_MISMATCH', 'The set’s name and the time in its manifest disagree.');
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  for (const required of REQUIRED_FILES) if (!listed.some(file => file.name === required)) add('NUV_BACKUP_FILE_NOT_LISTED', `${required} is not listed in the manifest.`);
  for (const file of listed) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(file.name))) { add('NUV_BACKUP_FILE_NAME', `Unsafe file name in the manifest: ${String(file.name).slice(0, 40)}`); continue; }
    let bytes;
    try { bytes = await readFile(join(directory, file.name)); } catch { add('NUV_BACKUP_FILE_MISSING', `${file.name} is listed but missing.`); continue; }
    if (bytes.length !== file.sizeBytes) add('NUV_BACKUP_SIZE_MISMATCH', `${file.name} has ${bytes.length} bytes, the manifest says ${file.sizeBytes}.`);
    else if (sha256(bytes) !== file.sha256) add('NUV_BACKUP_CHECKSUM_MISMATCH', `${file.name} does not match its recorded SHA-256.`);
  }
  let present = [];
  try { present = (await readdir(directory)).filter(entry => /\.cms$/.test(entry)); } catch { /* reported above */ }
  for (const entry of present) if (!listed.some(file => file.name === entry)) add('NUV_BACKUP_UNLISTED_FILE', `${entry} is in the set but not in the manifest.`);
  const check = manifest.restoreCheck;
  if (!check || check.passed !== true) add('NUV_BACKUP_RESTORE_CHECK', 'The host did not restore this set into a scratch database successfully.');
  else if (!(check.migrations > 0) || !(check.tables > 0)) add('NUV_BACKUP_RESTORE_CHECK', 'The restore check restored no migrations or no tables.');
  return problems;
}

// Which sets to keep: the newest `hourly`, then the newest of each UTC day for `daily` days, then the newest of each ISO week for `weekly` weeks.
// Only sets that passed the check should be given here, so a damaged set never counts as one of the kept.
export function retentionPlan(names, { hourly = 48, daily = 30, weekly = 26 } = {}) {
  const sorted = names.filter(name => SET_NAME.test(name)).sort().reverse();
  const keep = new Set(sorted.slice(0, hourly));
  const day = name => name.slice(0, 8);
  const isoWeek = name => {
    const date = setTime(name), thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
    return `${thursday.getUTCFullYear()}-W${String(Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
  };
  const older = sorted.slice(hourly);
  const days = [...new Set(older.map(day))].slice(0, daily);
  for (const d of days) keep.add(older.find(name => day(name) === d));
  const weeks = [...new Set(older.map(isoWeek))].slice(0, weekly);
  for (const w of weeks) keep.add(older.find(name => isoWeek(name) === w));
  return { keep: [...keep].sort().reverse(), remove: sorted.filter(name => !keep.has(name)) };
}

export function ageHours(name, now = new Date()) { return (now - setTime(name)) / 3_600_000; }

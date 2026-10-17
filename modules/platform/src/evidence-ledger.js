// The archive of release evidence kept off the host (docs/backups.md).
//
// CI keeps a release's evidence for 90 days and the host keeps release directories that anyone with the account can change. The archive copies the evidence of
// every release (manifest, checksums, SBOMs, signed attestation bundles, scan reports, the release archive) to a folder the owner controls and records what it
// copied in a ledger, one JSON line per release. Each line carries the hash of the line before it, so a line that is edited, removed from the middle or put out of
// order breaks every hash after it. The last line’s hash is the head: writing it down somewhere else (the status document, a message to yourself) also catches the
// removal of the newest lines.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const GENESIS = '0'.repeat(64);
export const LEDGER_FORMAT = 'nuvrion-evidence/1';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const body = ({ format, seq, version, collectedAt, files, previousHash }) => JSON.stringify({ format, seq, version, collectedAt, files, previousHash });

// files: [{ name, sizeBytes, sha256, inChecksumList }] sorted by name
export function makeEntry(previous, { version, collectedAt = new Date().toISOString(), files }) {
  const entry = {
    format: LEDGER_FORMAT, seq: previous ? previous.seq + 1 : 1, version, collectedAt,
    files: [...files].sort((a, b) => (a.name < b.name ? -1 : 1)), previousHash: previous ? previous.hash : GENESIS
  };
  return { ...entry, hash: sha256(body(entry)) };
}

export function parseLedger(text) {
  return String(text).split('\n').filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Ledger line ${index + 1} is not JSON.`); }
  });
}

export const serialiseEntry = entry => `${JSON.stringify(entry)}\n`;

// Problems in the chain itself.
export function verifyChain(entries) {
  const problems = [];
  let previous = null;
  entries.forEach((entry, index) => {
    const where = `entry ${index + 1} (${entry?.version ?? '?'})`;
    if (entry.format !== LEDGER_FORMAT) problems.push(`${where}: unknown format`);
    if (entry.seq !== index + 1) problems.push(`${where}: sequence number ${entry.seq}, expected ${index + 1}`);
    if (entry.previousHash !== (previous ? previous.hash : GENESIS)) problems.push(`${where}: does not follow the entry before it`);
    if (entry.hash !== sha256(body(entry))) problems.push(`${where}: its content does not match its hash`);
    if (entries.slice(0, index).some(other => other.version === entry.version)) problems.push(`${where}: the version appears twice`);
    previous = entry;
  });
  return problems;
}

// Problems in the files on disk: each recorded file must exist, in the version’s folder, with the recorded size and hash.
export async function verifyFiles(root, entries) {
  const problems = [];
  for (const entry of entries) {
    for (const file of entry.files) {
      let bytes;
      try { bytes = await readFile(join(root, `v${entry.version}`, file.name)); } catch { problems.push(`v${entry.version}/${file.name}: missing`); continue; }
      if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) problems.push(`v${entry.version}/${file.name}: changed since it was archived`);
    }
  }
  return problems;
}

export async function folderExists(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
export { sha256 as hashBytes };

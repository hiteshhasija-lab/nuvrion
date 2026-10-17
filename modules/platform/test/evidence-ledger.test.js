import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntry, verifyChain, verifyFiles, parseLedger, serialiseEntry, hashBytes, GENESIS } from '../src/evidence-ledger.js';

// The ledger is a hash chain: an entry that is edited, removed from the middle, repeated or put out of order breaks the chain.
const file = (name, content) => ({ name, sizeBytes: Buffer.byteLength(content), sha256: hashBytes(content), inChecksumList: true });
function chain(versions) {
  const entries = [];
  for (const version of versions) entries.push(makeEntry(entries.at(-1) ?? null, { version, collectedAt: `2026-10-1${entries.length}T00:00:00Z`, files: [file('release-manifest.json', `manifest ${version}`), file('SHA256SUMS.txt', `sums ${version}`)] }));
  return entries;
}

test('a chain of entries verifies, the first follows the genesis hash and each follows the one before', () => {
  const entries = chain(['0.1.184', '0.1.185', '0.1.186']);
  assert.deepEqual(verifyChain(entries), []);
  assert.equal(entries[0].previousHash, GENESIS);
  assert.equal(entries[2].previousHash, entries[1].hash);
  assert.deepEqual(entries.map(entry => entry.seq), [1, 2, 3]);
});

test('an edited entry, a removed middle entry, a reordering, a repeated version and a forged hash are each detected', () => {
  const entries = chain(['0.1.184', '0.1.185', '0.1.186']);
  const edited = structuredClone(entries); edited[1].files[0].sha256 = 'f'.repeat(64);
  assert.ok(verifyChain(edited).some(p => /does not match its hash/.test(p)));
  assert.ok(verifyChain([entries[0], entries[2]]).length > 0, 'removing the middle one');
  assert.ok(verifyChain([entries[1], entries[0], entries[2]]).length > 0, 'reordering');
  const repeated = [...entries, makeEntry(entries[2], { version: '0.1.184', files: [] })];
  assert.ok(verifyChain(repeated).some(p => /appears twice/.test(p)));
  const forged = structuredClone(entries); forged[1].version = '0.1.999';
  assert.ok(verifyChain(forged).length > 0);
  assert.deepEqual(verifyChain(entries), [], 'the originals were not touched by the checks above');
});

test('an entry rewritten with a correctly recomputed hash still breaks the chain, because the next entry points at the old hash', () => {
  const entries = chain(['0.1.184', '0.1.185', '0.1.186']);
  const rewritten = makeEntry(entries[0], { version: '0.1.185', collectedAt: entries[1].collectedAt, files: [file('release-manifest.json', 'a forged manifest'), file('SHA256SUMS.txt', 'forged sums')] });
  assert.deepEqual(verifyChain([entries[0], rewritten]), [], 'on its own the rewritten entry is internally consistent');
  const problems = verifyChain([entries[0], rewritten, entries[2]]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /entry 3 \(0\.1\.186\): does not follow the entry before it/);
});

test('removing the newest entry is not a chain error: the head hash is what catches it, so it is separately visible', () => {
  const entries = chain(['0.1.184', '0.1.185', '0.1.186']);
  assert.deepEqual(verifyChain(entries.slice(0, 2)), []);
  assert.notEqual(entries[1].hash, entries[2].hash);
});

test('ledger text round-trips line by line', () => {
  const entries = chain(['0.1.184', '0.1.185']);
  assert.deepEqual(parseLedger(entries.map(serialiseEntry).join('')), entries);
  assert.deepEqual(parseLedger(''), []);
  assert.throws(() => parseLedger('{"a":1}\nnot json\n'), /line 2/);
});

test('files on disk are checked against the ledger: missing and changed files are reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-evidence-'));
  try {
    const entries = chain(['0.1.185']);
    mkdirSync(join(root, 'v0.1.185'));
    writeFileSync(join(root, 'v0.1.185', 'release-manifest.json'), 'manifest 0.1.185');
    writeFileSync(join(root, 'v0.1.185', 'SHA256SUMS.txt'), 'sums 0.1.185');
    assert.deepEqual(await verifyFiles(root, entries), []);
    writeFileSync(join(root, 'v0.1.185', 'SHA256SUMS.txt'), 'sums 0.1.186');
    assert.deepEqual(await verifyFiles(root, entries), ['v0.1.185/SHA256SUMS.txt: changed since it was archived']);
    rmSync(join(root, 'v0.1.185', 'release-manifest.json'));
    assert.deepEqual(await verifyFiles(root, entries), ['v0.1.185/SHA256SUMS.txt: changed since it was archived', 'v0.1.185/release-manifest.json: missing']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

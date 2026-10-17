import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveEvidence, verifyArchive, parseChecksumList } from '../src/evidence-archive.js';
import { removeSet } from '../src/backup-pull.js';
import { normaliseConfig } from '../src/backup-config.js';
import { hashBytes } from '../src/evidence-ledger.js';
import { fakeRemote } from '../test-support/fake-remote.js';

// The archive copies the evidence of each release to the owner’s machine, refuses a release whose files do not match its own checksum list, never copies the heavy
// payloads, only ever appends to the ledger, and notices when the archive is changed afterwards.
function release(remoteRoot, version, { corrupt = null, noManifest = false, extra = {} } = {}) {
  const dir = join(remoteRoot, 'nuvrion-upgrades', 'releases', `Nuvrion-v${version}`);
  mkdirSync(dir, { recursive: true });
  const files = { 'release-manifest.json': `manifest ${version}`, 'nuvrion-sbom.cdx.json': `sbom ${version}`, 'sbom.attestation.sigstore.json': `attestation ${version}`, 'RELEASE-NOTES.md': `notes ${version}`, ...extra };
  if (noManifest) delete files['release-manifest.json'];
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), name === corrupt ? 'altered on the host' : content);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), Object.entries(files).map(([name, content]) => `${hashBytes(content)}  ${name}`).join('\n') + '\n');
  writeFileSync(join(dir, `Nuvrion-Image-${version}.tar`), 'a 360 MB image archive');
  writeFileSync(join(dir, 'nuvrion-workstation-agent-0.1.51-lab.1.exe'), 'a 43 MB executable');
  mkdirSync(join(dir, 'nested'));
  return dir;
}
async function withWorld(work) {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-evidence-')), remoteRoot = join(root, 'remote'), destination = join(root, 'Backup');
  mkdirSync(remoteRoot);
  const protectCalls = [];
  const protect = async (path, options = {}) => { protectCalls.push([path.replace(root, ''), options.appendOnly === true]); };
  try { return await work({ root, remoteRoot, destination, config: normaliseConfig({ host: 'h.example', user: 'owner', destination }), protectCalls, protect, archive: dest => join(dest, 'evidence') }); } finally { await removeSet(root); }
}
const NOW = new Date('2026-10-17T06:00:00Z');

test('releases are archived oldest first, without the image archive or the executable, and read-only', async () => withWorld(async w => {
  release(w.remoteRoot, '0.1.186'); release(w.remoteRoot, '0.1.99'); release(w.remoteRoot, '0.1.100');
  const result = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  assert.equal(result.error, null);
  assert.deepEqual(result.archived, ['0.1.99', '0.1.100', '0.1.186'], 'ordered as version numbers, not text');
  const folder = join(w.destination, 'evidence', 'v0.1.186');
  assert.deepEqual(readdirSync(folder).sort(), ['RELEASE-NOTES.md', 'SHA256SUMS.txt', 'nuvrion-sbom.cdx.json', 'release-manifest.json', 'sbom.attestation.sigstore.json']);
  assert.equal(statSync(join(folder, 'release-manifest.json')).mode & 0o222, 0);
  assert.deepEqual(await verifyArchive(w.destination), { entries: 3, head: result.head, problems: [] });
  assert.ok(w.protectCalls.some(([path, appendOnly]) => path.endsWith('LEDGER.jsonl') && appendOnly), 'the ledger is marked append-only where the platform can');
  assert.ok(w.protectCalls.some(([path]) => path.endsWith('/evidence/v0.1.186')), 'and each release folder immutable');
}));

test('a second run adds only new releases and the chain continues from the head', async () => withWorld(async w => {
  release(w.remoteRoot, '0.1.185');
  const first = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  release(w.remoteRoot, '0.1.186');
  const second = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  assert.deepEqual(second.archived, ['0.1.186']);
  assert.notEqual(second.head, first.head);
  const lines = readFileSync(join(w.destination, 'evidence', 'LEDGER.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[1].previousHash, lines[0].hash);
  assert.equal((await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect })).archived.length, 0);
}));

test('a release whose files do not match its own SHA256SUMS.txt is refused and not recorded; one without a manifest is skipped', async () => withWorld(async w => {
  release(w.remoteRoot, '0.1.184', { corrupt: 'nuvrion-sbom.cdx.json' }); release(w.remoteRoot, '0.1.183', { noManifest: true }); release(w.remoteRoot, '0.1.185');
  const result = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  assert.deepEqual(result.archived, ['0.1.185']);
  assert.match(result.refused[0].reason, /nuvrion-sbom\.cdx\.json/);
  assert.equal(result.skipped[0].version, '0.1.183');
  assert.ok(!existsSync(join(w.destination, 'evidence', 'v0.1.184')));
  assert.deepEqual(readdirSync(join(w.destination, 'evidence', '.incoming')), [], 'nothing is left half-fetched');
}));

test('a damaged ledger stops the run before anything is added; a changed or deleted archived file is found by the verification', async () => withWorld(async w => {
  release(w.remoteRoot, '0.1.185'); release(w.remoteRoot, '0.1.186');
  await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  const file = join(w.destination, 'evidence', 'v0.1.185', 'release-manifest.json');
  chmodSync(join(w.destination, 'evidence', 'v0.1.185'), 0o700); chmodSync(file, 0o600);
  writeFileSync(file, 'rewritten later');
  assert.deepEqual((await verifyArchive(w.destination)).problems, ['v0.1.185/release-manifest.json: changed since it was archived']);
  const ledger = join(w.destination, 'evidence', 'LEDGER.jsonl');
  const text = readFileSync(ledger, 'utf8');
  writeFileSync(ledger, text.replace('"version":"0.1.186"', '"version":"0.1.999"'));
  release(w.remoteRoot, '0.1.187');
  const result = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot).run, now: NOW, protect: w.protect });
  assert.match(result.error, /the ledger is damaged, nothing was added/);
  assert.deepEqual(result.archived, []);
  assert.ok((await verifyArchive(w.destination)).problems.some(problem => /does not match its hash/.test(problem)));
}));

test('an unreachable host or a failed transfer is reported and archives nothing partial', async () => withWorld(async w => {
  release(w.remoteRoot, '0.1.185'); release(w.remoteRoot, '0.1.186');
  assert.match((await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot, { failList: true }).run, now: NOW, protect: w.protect })).error, /could not list the releases/);
  const result = await archiveEvidence({ config: w.config, run: fakeRemote(w.remoteRoot, { failRsyncFor: 'Nuvrion-v0.1.186' }).run, now: NOW, protect: w.protect });
  assert.deepEqual(result.archived, ['0.1.185']);
  assert.match(result.error, /rsync of Nuvrion-v0.1.186 failed/);
}));

test('SHA256SUMS.txt lines are parsed, including the binary-mode asterisk, and junk lines are ignored', () => {
  const sums = parseChecksumList(`${'a'.repeat(64)}  one.json\n${'b'.repeat(64)} *two.json\nnot a checksum line\n\n`);
  assert.deepEqual([...sums], [['one.json', 'a'.repeat(64)], ['two.json', 'b'.repeat(64)]]);
});

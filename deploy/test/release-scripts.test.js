import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The release scripts decide what may reach the host. These tests run the supply-chain section of upgrade-nuvrion.sh (extracted from the
// script, so the test cannot drift from it) against release directories that are complete, incomplete and tampered with, and check that
// assemble-release.sh refuses bad input before it contacts anything.
const upgradeScript = readFileSync(new URL('./../upgrade-nuvrion.sh', import.meta.url), 'utf8');
const start = upgradeScript.indexOf("if jq -e '.supplyChain'");
const end = upgradeScript.indexOf('\nfi\n', start) + 4;
assert.ok(start > 0 && end > start, 'the supply-chain section was not found in the upgrade script');
const section = upgradeScript.slice(start, end);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const EVIDENCE = ['nuvrion-sbom.cdx.json', 'nuvrion-build-provenance.json', 'image-scan.json', 'image-scan-summary.json', 'build-provenance.attestation.sigstore.json', 'sbom.attestation.sigstore.json'];

function release({ supplyChain = true, scan = { status: 'passed', blocking: 0, accepted: [] }, drop = [], uncovered = [], tamperArchive = false, evidenceDigest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-release-'));
  const archive = 'Nuvrion-Server-Overlay-0.1.171.tar.gz', bytes = Buffer.from('archive');
  writeFileSync(join(dir, archive), tamperArchive ? Buffer.from('another archive') : bytes);
  const files = { [archive]: bytes };
  for (const name of EVIDENCE) { const content = name === 'image-scan-summary.json' ? JSON.stringify(scan) : `{"file":"${name}"}`; if (!drop.includes(name)) writeFileSync(join(dir, name), content); files[name] = Buffer.from(content); }
  const manifest = { version: '0.1.171', server: { artifact: archive, sha256: sha(bytes) }, ...(supplyChain ? { supplyChain: { archiveSha256: evidenceDigest ?? sha(bytes), files: EVIDENCE } } : {}) };
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'SHA256SUMS.txt'), Object.entries(files).filter(([name]) => !uncovered.includes(name)).map(([name, content]) => `${sha(content)}  ${name}`).join('\n') + '\n');
  return dir;
}
const check = dir => spawnSync('bash', ['-c', `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; server_artifact="Nuvrion-Server-Overlay-0.1.171.tar.gz"\n${section}`], { env: { ...process.env, D: dir }, encoding: 'utf8' });
const withRelease = (options, assertions) => { const dir = release(options); try { assertions(check(dir)); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('a release with complete, consistent supply-chain evidence passes and says what it holds', () => {
  withRelease({}, result => { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Supply-chain evidence present and consistent.*passed, 0 blocking, 0 accepted/); });
});

test('a release without the evidence section is accepted with a notice (releases before v0.1.171)', () => {
  withRelease({ supplyChain: false }, result => { assert.equal(result.status, 0); assert.match(result.stderr, /carries no supply-chain evidence/); });
});

test('evidence that describes another archive is refused', () => {
  withRelease({ tamperArchive: true }, result => { assert.equal(result.status, 1); assert.match(result.stderr, /does not describe this server archive/); });
});

test('evidence recorded for a different archive than the one declared is refused, even when the archive itself matches its declared digest', () => {
  withRelease({ evidenceDigest: 'f'.repeat(64) }, result => { assert.equal(result.status, 1); assert.match(result.stderr, /does not describe this server archive/); });
});

test('a missing evidence file is refused, whichever one it is', () => {
  for (const name of EVIDENCE) withRelease({ drop: [name] }, result => { assert.equal(result.status, 1, name); assert.match(result.stderr, new RegExp(`missing: ${name.replace(/\./g, '\\.')}`)); });
});

test('an evidence file that the checksum list does not cover is refused', () => {
  withRelease({ uncovered: ['image-scan.json'] }, result => { assert.equal(result.status, 1); assert.match(result.stderr, /not covered by SHA256SUMS\.txt: image-scan\.json/); });
});

test('a release whose image scan did not pass, or has blocking findings, is refused', () => {
  withRelease({ scan: { status: 'blocked', blocking: 3, accepted: [] } }, result => { assert.equal(result.status, 1); assert.match(result.stderr, /image scan of this release did not pass/); });
  withRelease({ scan: { status: 'passed', blocking: 1, accepted: [] } }, result => assert.equal(result.status, 1));
  withRelease({ scan: { status: 'blocked', blocking: 0, accepted: [] } }, result => assert.equal(result.status, 1));   // a blocked status with no counted findings
});

test('the assemble script refuses a malformed version, commit or change file before contacting anything', () => {
  const script = new URL('./../assemble-release.sh', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-assemble-'));
  try {
    const change = join(dir, 'change.json');
    writeFileSync(change, '{}');
    const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
    assert.equal(run('1.2.3', 'a'.repeat(40), change).status, 2);
    assert.match(run('0.1.x', 'a'.repeat(40), change).stderr, /VERSION must look like/);
    assert.match(run('0.1.171', 'abc', change).stderr, /40-character commit/);
    assert.match(run('0.1.171', 'a'.repeat(40), join(dir, 'missing.json')).stderr, /change file does not exist/);
    mkdirSync(join(dir, 'exists'));
    assert.match(run('0.1.171', 'a'.repeat(40), change, join(dir, 'exists')).stderr, /already exists/);
    assert.equal(run('0.1.171').status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

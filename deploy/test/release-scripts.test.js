import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync, realpathSync } from 'node:fs';
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

// ---- a release that carries the image CI built: the preflight, and the loading of the image ----
const sectionBetween = (startMarker, endMarker) => { const a = upgradeScript.indexOf(startMarker), b = upgradeScript.indexOf(endMarker, a); assert.ok(a > 0 && b > a, `${startMarker} not found`); return upgradeScript.slice(a, b + endMarker.length); };
const preflight = sectionBetween('image_archive="$(jq -r', '\nfi\n');
const loader = sectionBetween('load_ci_image() {', '\n}\n');
const ID = 'a'.repeat(64);

function imageRelease({ archiveName = 'Nuvrion-Image-0.1.173.tar', id = ID, tamper = false, uncovered = false, missing = false, noArchive = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-image-release-'));
  const bytes = Buffer.from('image archive');
  if (!missing) writeFileSync(join(dir, archiveName), tamper ? Buffer.from('other bytes') : bytes);
  const server = { artifact: 'Nuvrion-Server-Overlay-0.1.173.tar.gz', ...(noArchive ? {} : { imageArchive: { file: archiveName, sha256: sha(bytes), imageId: id } }) };
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ version: '0.1.173', server }));
  writeFileSync(join(dir, 'SHA256SUMS.txt'), uncovered ? '' : `${sha(bytes)}  ${archiveName}\n`);
  return dir;
}
const runPreflight = (dir, { baseImage = true } = {}) => spawnSync('bash', ['-c', `set -Eeuo pipefail\npodman() { ${baseImage ? 'return 0' : 'return 1'}; }\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; version="0.1.173"; base_image="localhost/nuvrion:base-arm64"\n${preflight}\necho "image_archive=[$image_archive]"`], { env: { ...process.env, D: dir }, encoding: 'utf8' });
const withImageRelease = (options, run, check) => { const dir = imageRelease(options); try { check(runPreflight(dir, run)); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('a release with an image archive passes the preflight without needing a base image on the host', () => {
  withImageRelease({}, { baseImage: false }, result => { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /image_archive=\[Nuvrion-Image-0\.1\.173\.tar\]/); });
});

test('a release without an image archive still needs the base image it will build on', () => {
  withImageRelease({ noArchive: true }, { baseImage: true }, result => { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /image_archive=\[\]/); });
  withImageRelease({ noArchive: true }, { baseImage: false }, result => { assert.equal(result.status, 1); assert.match(result.stderr, /base image is unavailable/); });
});

test('an image archive that is missing, misnamed, malformed, uncovered or does not match its digest is refused', () => {
  for (const [label, options, pattern] of [
    ['missing', { missing: true }, /missing or malformed/],
    ['misnamed', { archiveName: 'Nuvrion-Image-9.9.9.tar' }, /missing or malformed/],
    ['bad id', { id: 'not-an-id' }, /missing or malformed/],
    ['not in the checksum list', { uncovered: true }, /not covered by SHA256SUMS/],
    ['bytes differ from the manifest', { tamper: true }, /does not match the digest/]
  ]) withImageRelease(options, {}, result => { assert.equal(result.status, 1, label); assert.match(result.stderr, pattern, label); });
});

function runLoader({ loaded = 'Loaded image: localhost/nuvrion:ci-image', id = `sha256:${ID}`, version = '0.1.173' } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'nuvrion-loader-')), 'calls.log');
  const script = `set -Eeuo pipefail
podman() { case "$1" in
  load) printf '%s' "$FAKE_LOADED" ;;
  image) printf '%s\\n' "$FAKE_ID" ;;
  tag|rmi) echo "$*" >> "$LOG" ;;
  run) printf '%s' "$FAKE_VERSION" ;;
esac; }
${loader}
load_ci_image /releases/image.tar ${ID} localhost/nuvrion:0.1.173 0.1.173
echo done`;
  const result = spawnSync('bash', ['-c', script], { env: { ...process.env, FAKE_LOADED: loaded, FAKE_ID: id, FAKE_VERSION: version, LOG: log }, encoding: 'utf8' });
  let calls = ''; try { calls = readFileSync(log, 'utf8'); } catch { /* nothing was tagged */ }
  rmSync(join(log, '..'), { recursive: true, force: true });
  return { ...result, calls };
}

test('the CI image is loaded, tagged for the release, and the CI tag removed, when its id and version are the expected ones', () => {
  const result = runLoader();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /done/);
  assert.match(result.calls, /tag localhost\/nuvrion:ci-image localhost\/nuvrion:0\.1\.173/);
  assert.match(result.calls, /rmi localhost\/nuvrion:ci-image/);
});

test('an image whose id is not the one the release names is refused before it is tagged', () => {
  const result = runLoader({ id: `sha256:${'b'.repeat(64)}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the image the release names/);
  assert.equal(result.calls, '', 'nothing was tagged');
});

test('an image that reports another release version is refused', () => {
  const result = runLoader({ version: '0.1.172' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reports release 0\.1\.172, not 0\.1\.173/);
});

test('an archive that loads nothing is refused', () => {
  const result = runLoader({ loaded: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not load/);
});

// ---- the agent executable a release carries -----------------------------------------------------------------------------------------------------
const agentStart = upgradeScript.indexOf('agent_file="$(jq -r');
const agentEnd = upgradeScript.indexOf('\nfi\n', upgradeScript.indexOf('Agent executable $agent_version is present')) + 4;
assert.ok(agentStart > 0 && agentEnd > agentStart, 'the agent preflight section was not found in the upgrade script');
const agentPreflight = upgradeScript.slice(agentStart, agentEnd);
const publishStart = upgradeScript.indexOf('agent_share_dir="${NUVRION_AGENT_SHARE_DIR');
const publishEnd = upgradeScript.indexOf('\n}\n', publishStart) + 3;
assert.ok(publishStart > 0 && publishEnd > publishStart, 'the agent publish function was not found in the upgrade script');
const agentPublish = upgradeScript.slice(publishStart, publishEnd);

function agentRelease({ withAgent = true, version = '0.1.60-lab.1', content = Buffer.concat([Buffer.from('MZ'), Buffer.from('a-windows-agent-build')]), name, uncovered = false, tamper = false, sizeLies = false, digestLies = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-agent-release-'));
  const file = name ?? `nuvrion-workstation-agent-${version}.exe`;
  const manifest = { version: '0.1.178' };
  if (withAgent) {
    writeFileSync(join(dir, file), tamper ? Buffer.concat([content, Buffer.from('!')]) : content);
    manifest.agent = { version, file: `nuvrion-workstation-agent-${version}.exe`, sha256: digestLies ? 'f'.repeat(64) : sha(content), sizeBytes: sizeLies ? content.length + 1 : content.length };
  }
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'SHA256SUMS.txt'), withAgent && !uncovered ? `${sha(content)}  ${file}\n` : '\n');
  return dir;
}
const runAgentPreflight = dir => spawnSync('bash', ['-c', `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"\n${agentPreflight}\necho "agent_file=[$agent_file] agent_sha=[$agent_sha]"`], { env: { ...process.env, D: dir }, encoding: 'utf8' });
const withAgentRelease = (options, assertions) => { const dir = agentRelease(options); try { assertions(runAgentPreflight(dir), dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('a release carrying a verified agent executable passes the preflight and says it will be published', () => {
  withAgentRelease({}, result => { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Agent executable 0\.1\.60-lab\.1 is present and verified/); assert.match(result.stdout, /agent_file=\[nuvrion-workstation-agent-0\.1\.60-lab\.1\.exe\]/); });
});

test('a release without an agent executable is unaffected', () => {
  withAgentRelease({ withAgent: false }, result => { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /agent_file=\[\]/); assert.doesNotMatch(result.stdout, /Agent executable/); });
});

test('an agent executable that is missing, misnamed, uncovered, altered, mis-sized or not a Windows executable is refused', () => {
  for (const [label, options, pattern] of [
    ['file missing', { name: 'something-else.exe' }, /missing or malformed/],
    ['not in the checksum list', { uncovered: true }, /not covered by SHA256SUMS/],
    ['bytes differ from the manifest', { tamper: true }, /does not match the digest and size/],
    ['size differs', { sizeLies: true }, /does not match the digest and size/],
    ['digest differs', { digestLies: true }, /does not match the digest and size/],
    ['not an executable', { content: Buffer.from('#!/bin/sh\necho not an exe') }, /not a Windows executable/],
    ['bad version in the name', { version: 'latest' }, /missing or malformed/]
  ]) withAgentRelease(options, result => { assert.equal(result.status, 1, label); assert.match(result.stderr, pattern, label); });
});

test('publishing puts the executable where the platform serves it, by its digest, and leaves an intake record for the API', () => {
  const share = mkdtempSync(join(tmpdir(), 'nuvrion-share-')), dir = agentRelease({});
  try {
    const script = `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; version=0.1.178\n${agentPreflight}\n${agentPublish}\npublish_agent_build\npublish_agent_build\necho published`;
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, D: dir, NUVRION_AGENT_SHARE_DIR: share }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
    const published = readFileSync(join(share, 'agent-artifacts', manifest.agent.sha256));
    assert.equal(sha(published), manifest.agent.sha256);
    const intake = JSON.parse(readFileSync(join(share, 'agent-intake', `${manifest.agent.sha256}.json`), 'utf8'));
    assert.deepEqual([intake.format, intake.version, intake.sha256, intake.sizeBytes, intake.release], ['nuvrion-agent-intake/1', '0.1.60-lab.1', manifest.agent.sha256, manifest.agent.sizeBytes, '0.1.178']);
    const left = spawnSync('bash', ['-c', `ls -A "${join(share, 'agent-artifacts')}" "${join(share, 'agent-intake')}"`], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(left, /\.publish-|\.tmp/, 'no temporary file is left behind, and publishing twice is harmless');
    // the API runs as another user inside its container and writes to these directories too
    const mode = path => (statSync(path).mode & 0o777).toString(8);
    assert.deepEqual([mode(share), mode(join(share, 'agent-artifacts')), mode(join(share, 'agent-intake'))], ['777', '777', '777']);
  } finally { rmSync(share, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('an agent version that is already on the platform is not published again; a new version is', () => {
  const share = mkdtempSync(join(tmpdir(), 'nuvrion-share-')), dir = agentRelease({});
  try {
    mkdirSync(join(share, 'agent-intake', 'imported'), { recursive: true });
    mkdirSync(join(share, 'agent-artifacts'), { recursive: true });
    const run = () => spawnSync('bash', ['-c', `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; version=0.1.180\n${agentPreflight}\n${agentPublish}\npublish_agent_build`],
      { env: { ...process.env, D: dir, NUVRION_AGENT_SHARE_DIR: share }, encoding: 'utf8' });
    const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
    // imported earlier under another digest (a rebuild of the same source): nothing new is stored and no record is left for the platform to refuse
    writeFileSync(join(share, 'agent-intake', 'imported', `${'9'.repeat(64)}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: manifest.agent.version, sha256: '9'.repeat(64), sizeBytes: 1 }, null, 2));
    const skipped = run();
    assert.equal(skipped.status, 10, 'the function says "nothing to do" with its own status, which the caller turns into a message');
    assert.match(upgradeScript, /10\) echo "Agent \$agent_version is already on the platform; not published again\."/);
    assert.deepEqual(spawnSync('bash', ['-c', `ls -A "${join(share, 'agent-artifacts')}" "${join(share, 'agent-intake')}"`], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ').trim().split(' ').filter(name => name.endsWith('.exe') || name.length === 64 || name.endsWith('.json') && name !== `${'9'.repeat(64)}.json`), []);
    // another version was imported, not this one: it is published
    rmSync(join(share, 'agent-intake', 'imported', `${'9'.repeat(64)}.json`));
    writeFileSync(join(share, 'agent-intake', 'imported', `${'8'.repeat(64)}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.1-lab.1', sha256: '8'.repeat(64), sizeBytes: 1 }));
    const published = run();
    assert.equal(published.status, 0, published.stderr);
    assert.ok(readFileSync(join(share, 'agent-artifacts', manifest.agent.sha256)).length > 0);
  } finally { rmSync(share, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('published files take the label of their directory, and are copied rather than installed (SELinux would give install the home-directory label)', () => {
  assert.doesNotMatch(agentPublish.replace(/^\s*#.*$/gm, ''), /\binstall\s+-/, 'install sets the default SELinux context, which the API container cannot read');
  const share = mkdtempSync(join(tmpdir(), 'nuvrion-share-')), dir = agentRelease({}), bin = mkdtempSync(join(tmpdir(), 'nuvrion-bin-'));
  try {
    writeFileSync(join(bin, 'chcon'), '#!/bin/sh\necho "$@" >> "$CHCON_LOG"\n', { mode: 0o755 });
    const log = join(bin, 'chcon.log');
    const script = `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; version=0.1.178\n${agentPreflight}\n${agentPublish}\npublish_agent_build`;
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CHCON_LOG: log, D: dir, NUVRION_AGENT_SHARE_DIR: share }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8')), calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [`--reference=${join(share, 'agent-artifacts')} ${join(share, 'agent-artifacts', manifest.agent.sha256)}`, `--reference=${join(share, 'agent-intake')} ${join(share, 'agent-intake', `${manifest.agent.sha256}.json`)}`]);
  } finally { rmSync(share, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});

test('a release without an agent publishes nothing', () => {
  const share = mkdtempSync(join(tmpdir(), 'nuvrion-share-')), dir = agentRelease({ withAgent: false });
  try {
    const script = `set -Eeuo pipefail\nmanifest="$D/release-manifest.json"; checksums="$D/SHA256SUMS.txt"; release_dir="$D"; version=0.1.178\n${agentPreflight}\n${agentPublish}\npublish_agent_build\necho published`;
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, D: dir, NUVRION_AGENT_SHARE_DIR: share }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(spawnSync('bash', ['-c', `ls -A "${share}"`], { encoding: 'utf8' }).stdout.trim(), '');
  } finally { rmSync(share, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('the upgrade script says what happened to the agent build: published, already on the platform, or could not be published', () => {
  const from = upgradeScript.indexOf('published=0'), to = upgradeScript.indexOf('esac', from) + 4;
  assert.ok(from > 0 && to > from, 'the publish outcome section was not found in the upgrade script');
  const block = upgradeScript.slice(from, to);
  const run = status => spawnSync('bash', ['-c', `agent_version=0.1.9\npublish_agent_build() { return ${status}; }\n${block}`], { encoding: 'utf8' });
  const published = run(0), already = run(10), failed = run(1);
  assert.match(published.stdout, /Published agent 0\.1\.9 to the platform/);
  assert.match(already.stdout, /Agent 0\.1\.9 is already on the platform; not published again\./);
  assert.doesNotMatch(already.stdout, /Published agent/, 'a skipped build is not also reported as published');
  assert.match(failed.stderr, /Warning: could not publish the agent executable/);
  assert.doesNotMatch(failed.stdout, /Published agent|already on the platform/);
});

// ---- deploy/application-role.sh ---------------------------------------------------------------------------------------------------------------------
const roleScript = new URL('./../application-role.sh', import.meta.url).pathname;
const sourceRole = body => spawnSync('bash', ['-c', `APPLICATION_ROLE_SOURCE_ONLY=1 source "${roleScript}"; ${body}`], { encoding: 'utf8' });

test('the application-role script changes only the user and password of the database URL, in any scheme, and leaves every other line alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-role-'));
  try {
    const file = join(dir, 'env');
    const original = ['NODE_ENV=production', 'POSTGRES_USER=nuvrion', 'POSTGRES_PASSWORD=ownerpass', 'NUVRION_DATABASE_URL=postgresql://nuvrion:ownerpass@127.0.0.1:5432/nuvrion', 'NUVRION_BROKER_URL=amqp://u:p@127.0.0.1:5672', // secret-scan:allow (fake test credentials)
       'NUVRION_DATABASE_URL_NOTE=keep'].join('\n') + '\n';
    writeFileSync(file, original);
    const result = sourceRole(`rewrite_database_url "${file}" nuvrion_api abc123def`);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n'), before = original.trimEnd().split('\n');
    assert.deepEqual(lines.filter((line, index) => line !== before[index]), ['NUVRION_DATABASE_URL=postgresql://nuvrion_api:abc123def@127.0.0.1:5432/nuvrion']);   // secret-scan:allow (fake test credential)
    assert.equal(lines.length, before.length);
    writeFileSync(file, 'NUVRION_DATABASE_URL=postgres://owner:old@db.example:6543/app\n');   // secret-scan:allow (fake test credential)
    assert.equal(sourceRole(`rewrite_database_url "${file}" nuvrion_api newpw`).stdout.trim(), 'NUVRION_DATABASE_URL=postgres://nuvrion_api:newpw@db.example:6543/app');   // secret-scan:allow (fake test credential)
    writeFileSync(file, 'NODE_ENV=production\n');
    assert.equal(sourceRole(`rewrite_database_url "${file}" nuvrion_api newpw`).stdout, 'NODE_ENV=production\n', 'no URL, nothing invented');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the application-role script refuses a bad role name and a missing env file before touching anything', () => {
  const run = env => spawnSync('bash', [roleScript], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const badName = run({ NUVRION_APPLICATION_ROLE: 'Bad-Name; DROP ROLE x', NUVRION_ENV_FILE: '/nonexistent' });
  assert.equal(badName.status, 1);
  assert.match(badName.stdout, /role name must be 3 to 31 characters/);
  const missing = run({ NUVRION_APPLICATION_ROLE: 'nuvrion_api', NUVRION_ENV_FILE: '/nonexistent/env' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /does not exist/);
});

test('the application-role script never prints the password it generates, and writes it only to the env file and to PostgreSQL on stdin', () => {
  const text = readFileSync(roleScript, 'utf8');
  const lines = text.split('\n').filter(line => !line.trim().startsWith('#'));
  assert.equal(lines.some(line => /(say|echo|printf '%s\\n')\s.*\$\{?password\b/.test(line) && !/ALTER ROLE/.test(line)), false, 'no line prints the password');
  assert.match(text, /psql_owner \|\| \{ say "FAILED: PostgreSQL refused/, 'the statement carrying the password goes to psql on stdin and its errors are discarded');
  assert.match(text, /podman exec -e PGPASSWORD/, 'the password reaches podman through the environment, not a command line');
});

test('the application-role script judges a refused statement from its captured output, so a long refusal that closes the pipe early is still a refusal', () => {
  // the function under test runs under pipefail in the real script; the fake role prints a refusal and more, and exits non-zero as psql does on an error
  const refused = sourceRole(`set -o pipefail; as_role() { printf 'ERROR:  permission denied for schema operations\\n'; for i in $(seq 1 5000); do echo "padding $i"; done; return 3; }; statement_is_refused 'create table x(id int)'`);
  assert.equal(refused.status, 0, refused.stderr);
  const allowed = sourceRole(`set -o pipefail; as_role() { printf 'CREATE TABLE\\n'; return 0; }; statement_is_refused 'create table x(id int)'`);
  assert.equal(allowed.status, 1, 'a statement that succeeded is not a refusal');
  const otherError = sourceRole(`set -o pipefail; as_role() { printf 'ERROR:  syntax error at or near "x"\\n'; return 3; }; statement_is_refused 'create table x(id int)'`);
  assert.equal(otherError.status, 1, 'an error that is not a permission error does not prove the role is restricted');
  // and the script no longer pipes a role statement into grep -q
  assert.doesNotMatch(readFileSync(roleScript, 'utf8'), /as_role[^\n]*\|\s*grep\s+-q/);
});

test('the application-role script compares what the API reports about its own session with the words it makes the API report', () => {
  const text = readFileSync(roleScript, 'utf8');
  const reported = [...text.matchAll(/'(superuser|not-superuser)'/g)].map(match => match[1]);
  assert.deepEqual(reported.sort(), ['not-superuser', 'superuser'], 'the API session prints one of two words');
  assert.match(text, /\[\[ "\$session_user" == "\$role not-superuser" \]\]/, 'and the script expects the unprivileged one (a boolean from the driver is false, not f)');
});

// ---- freeing disk: heavy payloads of old releases go, their evidence stays ----------------------------------------------------------------------------------------
const pruneStart = upgradeScript.indexOf('prune_release_payloads() {');
const pruneEnd = upgradeScript.indexOf('\n}\n', pruneStart) + 3;
assert.ok(pruneStart > 0 && pruneEnd > pruneStart, 'the release payload pruning function was not found in the upgrade script');
const pruneFunction = upgradeScript.slice(pruneStart, pruneEnd);
const HEAVY = version => [`Nuvrion-Image-${version}.tar`, 'nuvrion-workstation-agent-0.1.51-lab.1.exe'];
const KEPT = version => [`Nuvrion-Server-Overlay-${version}.tar.gz`, 'release-manifest.json', 'SHA256SUMS.txt', 'RELEASE-NOTES.md', 'nuvrion-sbom.cdx.json', 'image-sbom.cdx.json', 'build-provenance.attestation.sigstore.json', 'sbom.attestation.sigstore.json', 'image-scan.json', 'image-scan-summary.json'];

function releasesTree(versions, { stableVersion = null, noStableRecord = false, extra = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-upgrades-'));
  mkdirSync(join(root, 'releases'));
  for (const version of versions) {
    const dir = join(root, 'releases', `Nuvrion-v${version}`);
    mkdirSync(dir);
    for (const name of [...HEAVY(version), ...KEPT(version)]) writeFileSync(join(dir, name), `${name} of ${version}`);
  }
  if (!noStableRecord && stableVersion) writeFileSync(join(root, 'STABLE-RELEASE.json'), JSON.stringify({ stableVersion, releaseDirectory: join(root, 'releases', `Nuvrion-v${stableVersion}`) }));
  extra(root);
  return root;
}
const present = (root, version, name) => { try { statSync(join(root, 'releases', `Nuvrion-v${version}`, name)); return true; } catch { return false; } };
function prune(root, { keep = 5, applied = null, stableRecord = join(root, 'STABLE-RELEASE.json') } = {}) {
  const releaseDir = applied ? realpathSync(join(root, 'releases', `Nuvrion-v${applied}`)) : '';   // the script resolves release_dir with pwd -P
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\nupgrade_root="$ROOT"; stable_record="$STABLE"; release_dir="$APPLIED"\n${pruneFunction}\nprune_release_payloads ${keep}`],
    { env: { ...process.env, ROOT: root, STABLE: stableRecord, APPLIED: releaseDir }, encoding: 'utf8' });
}
const allVersions = ['0.1.99', '0.1.100', '0.1.101', '0.1.102', '0.1.103', '0.1.104', '0.1.105', '0.1.106'];
const withTree = (versions, options, assertions) => { const root = releasesTree(versions, options); try { assertions(root); } finally { rmSync(root, { recursive: true, force: true }); } };

test('the newest five releases keep their payloads; older ones lose the image archive and the agent executable but keep every evidence file', () => {
  withTree(allVersions, { stableVersion: '0.1.106' }, root => {
    const result = prune(root, { applied: '0.1.106' });
    assert.equal(result.status, 0, result.stderr);
    for (const version of ['0.1.106', '0.1.105', '0.1.104', '0.1.103', '0.1.102']) for (const name of HEAVY(version)) assert.ok(present(root, version, name), `${version} ${name} is kept`);
    for (const version of ['0.1.101', '0.1.100', '0.1.99']) {
      for (const name of HEAVY(version)) assert.ok(!present(root, version, name), `${version} ${name} is removed`);
      for (const name of KEPT(version)) assert.ok(present(root, version, name), `${version} ${name} is kept`);
    }
  });
});

test('versions are ordered as numbers: 0.1.99 is older than 0.1.100', () => {
  withTree(['0.1.99', '0.1.100'], { stableVersion: '0.1.100' }, root => {
    assert.equal(prune(root, { keep: 1, applied: '0.1.100' }).status, 0);
    assert.ok(present(root, '0.1.100', HEAVY('0.1.100')[0]));
    assert.ok(!present(root, '0.1.99', HEAVY('0.1.99')[0]));
  });
});

test('the stable release and the release just applied keep their payloads however old they are', () => {
  withTree(allVersions, { stableVersion: '0.1.99' }, root => {
    assert.equal(prune(root, { keep: 2, applied: '0.1.100' }).status, 0);
    for (const version of ['0.1.99', '0.1.100']) for (const name of HEAVY(version)) assert.ok(present(root, version, name), `${version} ${name} is kept`);
    for (const version of ['0.1.101', '0.1.102', '0.1.103', '0.1.104']) for (const name of HEAVY(version)) assert.ok(!present(root, version, name), `${version} ${name} is removed`);
    for (const version of ['0.1.105', '0.1.106']) for (const name of HEAVY(version)) assert.ok(present(root, version, name), `${version} ${name} is kept (newest two)`);
  });
});

test('the stable release is protected when the release directory is reached through a relative or symlinked path', () => {
  withTree(allVersions, { stableVersion: '0.1.99', extra: root => spawnSync('ln', ['-s', join(root, 'releases'), join(root, 'releases-link')]) }, root => {
    writeFileSync(join(root, 'STABLE-RELEASE.json'), JSON.stringify({ releaseDirectory: join(root, 'releases-link', 'Nuvrion-v0.1.99') }));
    assert.equal(prune(root, { keep: 2, applied: '0.1.106' }).status, 0);
    assert.ok(present(root, '0.1.99', HEAVY('0.1.99')[0]), 'the stable release is recognised through the symlink');
  });
});

test('it only touches the two payload types inside release directories', () => {
  withTree(allVersions, { stableVersion: '0.1.106', extra: root => {
    mkdirSync(join(root, 'builds')); writeFileSync(join(root, 'builds', 'Nuvrion-Image-0.1.1.tar'), 'x');
    writeFileSync(join(root, 'releases', 'Nuvrion-Image-0.1.1.tar'), 'x');
    mkdirSync(join(root, 'releases', 'notes')); writeFileSync(join(root, 'releases', 'notes', 'Nuvrion-Image-0.1.2.tar'), 'x');
    mkdirSync(join(root, 'releases', 'Nuvrion-v0.1.99', 'nested')); writeFileSync(join(root, 'releases', 'Nuvrion-v0.1.99', 'nested', 'Nuvrion-Image-0.1.3.tar'), 'x');
    writeFileSync(join(root, 'upgrade-nuvrion.sh'), 'x');
  } }, root => {
    assert.equal(prune(root, { applied: '0.1.106' }).status, 0);
    for (const path of ['builds/Nuvrion-Image-0.1.1.tar', 'releases/Nuvrion-Image-0.1.1.tar', 'releases/notes/Nuvrion-Image-0.1.2.tar', 'releases/Nuvrion-v0.1.99/nested/Nuvrion-Image-0.1.3.tar', 'upgrade-nuvrion.sh']) {
      assert.doesNotThrow(() => statSync(join(root, path)), `${path} is untouched`);
    }
  });
});

test('it is harmless without a stable record, with fewer releases than the limit, with no releases directory, and when run twice', () => {
  withTree(allVersions, { noStableRecord: true }, root => {
    assert.equal(prune(root, { applied: '0.1.106' }).status, 0);
    assert.equal(prune(root, { applied: '0.1.106' }).status, 0, 'a second run changes nothing and does not fail');
    assert.ok(!present(root, '0.1.99', HEAVY('0.1.99')[0]));
  });
  withTree(['0.1.1', '0.1.2'], { stableVersion: '0.1.2' }, root => {
    assert.equal(prune(root, { applied: '0.1.2' }).status, 0);
    for (const version of ['0.1.1', '0.1.2']) assert.ok(present(root, version, HEAVY(version)[0]), `${version} is within the limit`);
  });
  const empty = mkdtempSync(join(tmpdir(), 'nuvrion-upgrades-'));
  try { assert.equal(prune(empty, { applied: null, stableRecord: join(empty, 'missing.json') }).status, 0, 'no releases directory at all'); } finally { rmSync(empty, { recursive: true, force: true }); }
  withTree(allVersions, { stableVersion: '0.1.106' }, root => {
    writeFileSync(join(root, 'STABLE-RELEASE.json'), '{ not json');
    assert.equal(prune(root, { applied: '0.1.106' }).status, 0, 'a damaged stable record does not stop the clean-up');
  });
});

test('the clean-up cannot make a deploy fail or roll back: it ignores the pruning status, and runs in an if after the stable record is written', () => {
  const call = upgradeScript.indexOf('prune_release_payloads 5');
  assert.ok(call > 0 && upgradeScript.slice(call, call + 40).includes('|| true'));
  const recorded = upgradeScript.indexOf('Recorded v$version as the stable release'), cleanup = upgradeScript.indexOf('if ! cleanup_after_deploy');
  assert.ok(recorded > 0 && cleanup > recorded, 'cleanup_after_deploy is called after the stable release is recorded, and a failure of it is only a warning');
});

// ---- migrations: every one the database does not record is applied, not only the newest ----
// v0.1.199 carried 0042 and 0043; the script applied only 0043 and the new code failed on the missing column until 0042 was applied by hand.
const migrationFunctions = sectionBetween('# ---- migrations (begin)', '# ---- migrations (end)');
const migrationGuard = sectionBetween('pending="$(pending_migrations)"', '(the last is the release\'s newest, applied at every deploy; the others are not yet recorded in the database)."');
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i).padStart(4, '0'));

// An archive like the server overlay (migrations under database/migrations, with or without a leading ./) and a pretend database whose ledger holds `recorded`.
function migrationRun({ inArchive, recorded, required, prefix = '', ledgerFails = false, guard = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-migrations-'));
  try {
    mkdirSync(join(dir, 'tree', 'database', 'migrations'), { recursive: true });
    for (const version of inArchive) writeFileSync(join(dir, 'tree', 'database', 'migrations', `${version}_something.sql`), '-- migration\n');
    writeFileSync(join(dir, 'tree', 'database', 'README.md'), 'not a migration\n');
    writeFileSync(join(dir, 'tree', 'database', 'migrations', 'notes.txt'), 'not a migration\n');
    const made = spawnSync('tar', ['-czf', join(dir, 'Nuvrion-Server-Overlay-0.1.199.tar.gz'), '-C', join(dir, 'tree'), `${prefix}database`], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const script = `set -Eeuo pipefail
podman() { ${ledgerFails ? 'return 1' : 'printf "%s\\n" "$LEDGER"'}; }
release_dir="$D"; server_artifact=Nuvrion-Server-Overlay-0.1.199.tar.gz; required_migration=${required}
postgres_container=pg; database_user=u; database_name=d
${migrationFunctions}
${guard ? migrationGuard : 'pending_migrations'}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, D: dir, LEDGER: recorded.join('\n') } });
    return { ...result, versions: result.stdout.split('\n').filter(line => /^\d{4}$/.test(line)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a release that adds two migrations applies both, oldest first (the v0.1.199 case)', () => {
  const run = migrationRun({ inArchive: range(1, 43), recorded: range(1, 41), required: '0043' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.versions, ['0042', '0043']);
});

test('a migration missing from the ledger is applied even when a newer one is already recorded', () => {
  const run = migrationRun({ inArchive: range(1, 43), recorded: [...range(1, 41), '0043'], required: '0043' });
  assert.deepEqual(run.versions, ['0042', '0043'], 'the maximum recorded version must not hide a gap');
});

test('with everything recorded, only the newest is applied, as before', () => {
  assert.deepEqual(migrationRun({ inArchive: range(1, 43), recorded: range(1, 43), required: '0043' }).versions, ['0043']);
});

test('a migration newer than the one the release requires is left alone', () => {
  assert.deepEqual(migrationRun({ inArchive: range(1, 45), recorded: range(1, 41), required: '0043' }).versions, ['0042', '0043']);
});

test('an archive whose names start with ./ is read the same way, and files that are not migrations are ignored', () => {
  const run = migrationRun({ inArchive: range(1, 43), recorded: range(1, 41), required: '0043', prefix: './' });
  assert.deepEqual(run.versions, ['0042', '0043']);
});

test('a release whose archive lacks the migration it requires is refused', () => {
  const run = migrationRun({ inArchive: range(1, 42), recorded: range(1, 42), required: '0043' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no migration 0043/);
  assert.deepEqual(run.versions, []);
});

test('a database that cannot be asked what it has applied stops the upgrade instead of guessing', () => {
  const run = migrationRun({ inArchive: range(1, 43), recorded: [], required: '0043', ledgerFails: true });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.versions, []);
});

test('the preflight says what will be applied, and refuses a list so long that the ledger must be incomplete', () => {
  const ok = migrationRun({ inArchive: range(1, 43), recorded: range(1, 41), required: '0043', guard: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Migrations to apply, oldest first: 0042 0043 /);
  const refused = migrationRun({ inArchive: range(1, 43), recorded: range(1, 30), required: '0043', guard: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /13 migrations are pending, more than 10.*ledger looks incomplete/);
  assert.doesNotMatch(refused.stdout, /Migrations to apply/);
});

test('the upgrade applies every pending migration in order, each from the archive it unpacked, and stops at the first that fails', () => {
  assert.doesNotMatch(upgradeScript, /migration_file="\$\{migration_files\[0\]\}"/, 'the single-migration lookup is gone');
  const apply = sectionBetween('migration_files=()', 'done\n');
  assert.match(apply, /for migration in \$pending; do/);
  assert.match(upgradeScript, /for migration_file in "\$\{migration_files\[@\]\}"; do\n[\s\S]*?psql -v ON_ERROR_STOP=1[\s\S]*?\ndone/);
  assert.ok(upgradeScript.indexOf('pending="$(pending_migrations)"') < upgradeScript.indexOf('if $check_only; then'), '--check reports the migrations too');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildProvenanceError, createBuildProvenance, verifyBuildProvenance } from '../src/build-provenance.js';

const BASE = 'node:24-bookworm@sha256:' + 'a'.repeat(64);
const files = () => [{ path: 'package.json', bytes: Buffer.from('{}') }, { path: 'apps/api/server.js', bytes: Buffer.from('serve()') }, { path: 'package-lock.json', bytes: Buffer.from('lock') }];
const build = (over = {}) => createBuildProvenance({ version: '0.1.160', sourceRevision: 'c496121', baseImage: BASE, files: files(), builtAt: '2026-10-06T00:00:00.000Z', ...over });
const issues = fn => { try { fn(); } catch (error) { assert.ok(error instanceof BuildProvenanceError, 'throws a BuildProvenanceError'); assert.equal(error.code, 'NUV_BUILD_PROVENANCE_INVALID'); return error.issues.join(' | '); } assert.fail('expected the provenance to be refused'); };

test('provenance records the version, source revision, base image and a hash of every input file', () => {
  const manifest = build();
  assert.equal(manifest.format, 'nuvrion-build-provenance/v1');
  assert.equal(manifest.baseImage, BASE);
  assert.deepEqual(manifest.files.map(f => f.path), ['apps/api/server.js', 'package-lock.json', 'package.json'], 'sorted, so the order of discovery does not matter');
  assert.ok(manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.match(manifest.sourceTreeSha256, /^[0-9a-f]{64}$/);
});

test('the source-tree hash is stable for the same inputs, and changes with any content, path or file-set change', () => {
  const reference = build().sourceTreeSha256;
  assert.equal(build({ files: [...files()].reverse(), builtAt: '2030-01-01T00:00:00.000Z' }).sourceTreeSha256, reference);
  const edited = files(); edited[1] = { path: 'apps/api/server.js', bytes: Buffer.from('serve( )') };
  assert.notEqual(build({ files: edited }).sourceTreeSha256, reference, 'content');
  const renamed = files(); renamed[1] = { path: 'apps/api/main.js', bytes: Buffer.from('serve()') };
  assert.notEqual(build({ files: renamed }).sourceTreeSha256, reference, 'path');
  assert.notEqual(build({ files: files().slice(0, 2) }).sourceTreeSha256, reference, 'a file removed');
});

test('verification passes for the inputs it was made from, and reports what it checked', () => {
  const manifest = build();
  assert.deepEqual(verifyBuildProvenance(manifest, files()), { verified: true, version: '0.1.160', sourceRevision: 'c496121', sourceTreeSha256: manifest.sourceTreeSha256 });
});

test('verification fails when a file was modified, added or removed after the provenance was made', () => {
  const manifest = build();
  const modified = files(); modified[0] = { path: 'package.json', bytes: Buffer.from('{"x":1}') };
  assert.match(issues(() => verifyBuildProvenance(manifest, modified)), /does not match/);
  assert.match(issues(() => verifyBuildProvenance(manifest, [...files(), { path: 'apps/extra.js', bytes: Buffer.from('evil()') }])), /does not match/);
  assert.match(issues(() => verifyBuildProvenance(manifest, files().slice(1))), /does not match/);
});

test('verification fails when the recorded manifest itself was edited', () => {
  const manifest = build();
  assert.throws(() => verifyBuildProvenance({ ...manifest, sourceTreeSha256: '0'.repeat(64) }, files()), BuildProvenanceError);
  const forged = structuredClone(manifest); forged.files[0].sha256 = '1'.repeat(64);
  assert.throws(() => verifyBuildProvenance(forged, files()), BuildProvenanceError);
  assert.throws(() => verifyBuildProvenance({ ...manifest, baseImage: 'node:24-bookworm' }, files()), BuildProvenanceError, 'base image downgraded to a movable tag');
});

test('a base image must be pinned by digest, not by a movable tag', () => {
  assert.match(issues(() => build({ baseImage: 'node:24-bookworm' })), /immutable sha256 digest/);
  assert.match(issues(() => build({ baseImage: undefined })), /immutable sha256 digest/);
  assert.match(issues(() => build({ baseImage: 'node@sha256:abc' })), /immutable sha256 digest/);
});

test('the version must be a v0.1 build and the source revision a commit id', () => {
  assert.match(issues(() => build({ version: '1.0.0' })), /v0\.1 build/);
  assert.match(issues(() => build({ version: undefined })), /v0\.1 build/);
  assert.equal(build({ version: '0.1.0-ci.42' }).version, '0.1.0-ci.42');
  assert.match(issues(() => build({ sourceRevision: 'main' })), /immutable commit/);
  assert.match(issues(() => build({ sourceRevision: '' })), /immutable commit/);
});

test('input paths must be unique, relative and inside the tree', () => {
  const bad = path => issues(() => build({ files: [...files(), { path, bytes: Buffer.from('x') }] }));
  assert.match(bad('../outside.js'), /safe relative paths/);
  assert.match(bad('/etc/passwd'), /safe relative paths/);
  assert.match(bad('apps/../../x'), /safe relative paths/);
  assert.match(bad('package.json'), /safe relative paths/, 'duplicate');
  assert.match(issues(() => build({ files: [] })), /safe relative paths/, 'nothing to record');
  assert.equal(build({ files: [{ path: 'apps\\api\\x.js', bytes: Buffer.from('x') }] }).files[0].path, 'apps/api/x.js', 'Windows separators are normalised');
});

// The provenance covers the repository's own files. A packager installed for a local build (tools/agent-build/node_modules, with the symbolic links npm
// makes in .bin) is third-party code pinned by its lockfile, not a build input, and must not stop a release being assembled from a working copy.
test('the command-line tool ignores installed packages but still refuses a symbolic link among the real inputs', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-provenance-'));
  try {
    for (const folder of ['apps', 'modules', 'providers', 'contracts', 'database', 'tools/agent-build/node_modules/.bin']) mkdirSync(join(dir, folder), { recursive: true });
    for (const file of ['package.json', 'package-lock.json', 'Containerfile.overlay', 'tools/x.js', 'apps/a.js']) writeFileSync(join(dir, file), `${file}\n`);
    writeFileSync(join(dir, 'Containerfile.base'), `FROM docker.io/library/node@sha256:${'a'.repeat(64)}\n`);
    symlinkSync('../x', join(dir, 'tools/agent-build/node_modules/.bin/some-tool'));
    const script = new URL('../../../tools/create-build-provenance.js', import.meta.url).pathname;
    const env = { ...process.env, NUVRION_BUILD_VERSION: '0.1.0-test', NUVRION_SOURCE_REVISION: 'b'.repeat(40) };
    const created = spawnSync(process.execPath, [script, 'create', 'provenance.json'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const verified = spawnSync(process.execPath, [script, 'verify', 'provenance.json'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    symlinkSync('../x', join(dir, 'apps/link'));
    const refused = spawnSync(process.execPath, [script, 'create', 'provenance.json'], { cwd: dir, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Symbolic links are not allowed in build inputs: apps\/link/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

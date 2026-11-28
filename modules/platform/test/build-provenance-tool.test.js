import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command CI uses to record what an image was built from, and the one a release is checked with, run the way they run: in a checkout. A Finder file in a working copy
// (tools/.DS_Store) made the check of release 0.1.202 fail although every source file was the one CI built. Only that is forgiven.
const run = promisify(execFile);
const tool = fileURLToPath(new URL('../../../tools/create-build-provenance.js', import.meta.url));

async function checkout(t, { git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nuvrion-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  for (const path of ['package.json', 'package-lock.json', 'Containerfile.overlay', 'apps/api/server.js', 'modules/a/src/a.js', 'providers/p.js', 'contracts/c.yaml', 'database/migrations/0001.sql', 'tools/t.js']) await put(path, `// ${path}\n`);
  await put('Containerfile.base', `FROM node:24-bookworm-slim@sha256:${'a'.repeat(64)}\n`);
  const gitIn = (...args) => run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  const commit = async () => { await gitIn('add', '-A'); await gitIn('commit', '-q', '-m', 'source'); };
  if (git) { await put('.gitignore', '.DS_Store\n'); await gitIn('init', '-q'); await commit(); }
  const manifest = join(root, '..', `${root.split('/').pop()}.provenance.json`);
  t.after(() => rm(manifest, { force: true }));
  const provenance = command => run(process.execPath, [tool, command, manifest], { cwd: root, env: { PATH: process.env.PATH, NUVRION_BUILD_VERSION: '0.1.999', NUVRION_SOURCE_REVISION: 'b'.repeat(40) } });
  const recorded = async () => JSON.parse(await readFile(manifest, 'utf8'));
  return { put, gitIn, commit, provenance, recorded };
}
const refused = promise => assert.rejects(promise, error => /source tree does not match recorded build inputs/.test(error.stderr));

test('Finder files that git does not track are not part of the source, wherever they are', async t => {
  const { put, provenance, recorded } = await checkout(t);
  await provenance('create');
  const clean = await recorded();
  for (const path of ['tools/.DS_Store', 'apps/.DS_Store', 'modules/a/src/.DS_Store']) await put(path, 'Finder view settings');
  await provenance('verify');                                   // recorded on a clean checkout, checked on one Finder has visited
  await provenance('create');
  assert.deepEqual((await recorded()).files, clean.files);
  assert.equal((await recorded()).sourceTreeSha256, clean.sourceTreeSha256);
});

test('any other file that was not recorded still fails the check, and so does a changed one', async t => {
  const { put, provenance } = await checkout(t);
  await provenance('create');
  await put('tools/stray.txt', 'not part of the build CI saw');
  await refused(provenance('verify'));
  const other = await checkout(t);
  await other.provenance('create');
  await other.put('apps/api/server.js', '// changed\n');
  await refused(other.provenance('verify'));
  const named = await checkout(t);
  await named.provenance('create');
  await named.put('apps/x.DS_Store', 'only the exact name is forgiven');
  await refused(named.provenance('verify'));
});

test('a committed file of that name is source: it is recorded, and a change to it fails the check', async t => {
  const { put, gitIn, commit, provenance, recorded } = await checkout(t);
  await put('apps/.DS_Store', 'committed on purpose');
  await gitIn('add', '-f', 'apps/.DS_Store');
  await commit();
  await provenance('create');
  assert.ok((await recorded()).files.some(file => file.path === 'apps/.DS_Store'), 'nothing committed can be left out of the record');
  await put('apps/.DS_Store', 'changed afterwards');
  await refused(provenance('verify'));
});

test('outside a git checkout nothing is left out, because there is no way to tell what is source', async t => {
  const { put, provenance } = await checkout(t, { git: false });
  await provenance('create');
  await put('tools/.DS_Store', 'Finder view settings');
  await refused(provenance('verify'));
});

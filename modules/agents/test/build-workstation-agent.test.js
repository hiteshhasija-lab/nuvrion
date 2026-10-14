import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { agentVersionFromSource, outputName, buildAgent, smokeTest, DEFAULT_TARGET } from '../../../tools/build-workstation-agent.js';

async function fakeRepository(t, { version = '0.1.60-lab.1' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nuvrion-build-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  await put('apps/workstation-agent/src/agent-service.cjs', `'use strict';\nconst VERSION='${version}';\nrequire('ws');require('./self-upgrade.cjs');\n`);
  await put('apps/workstation-agent/src/self-upgrade.cjs', 'module.exports={};\n');
  await put('package.json', '{"name":"nuvrion","dependencies":{"ws":"8.21.0"}}\n');
  await put('node_modules/ws/package.json', '{"name":"ws","version":"8.21.0"}\n');
  await put('node_modules/ws/index.js', 'module.exports={};\n');
  await put('tools/agent-build/package-lock.json', JSON.stringify({ packages: { 'node_modules/@yao-pkg/pkg': { version: '5.12.1' } } }));
  await put('tools/agent-build/node_modules/@yao-pkg/pkg/lib-es5/bin.js', '// stand-in for the packager\n');
  return root;
}

// What the packager would do: write the output file named by --output.
const fakePackager = (content, seen = []) => async (file, args, options) => {
  const output = args[args.indexOf('--output') + 1];
  seen.push({ args, cwd: options.cwd, env: options.env, files: await readdir(join(options.cwd, 'apps/workstation-agent/src')), ws: await readdir(join(options.cwd, 'node_modules/ws')) });
  await writeFile(output, content);
  return { code: 0, stdout: '', stderr: '' };
};

test('the version is read from the one place the agent declares it, and anything else is refused', () => {
  assert.equal(agentVersionFromSource("'use strict';\nconst VERSION='0.1.50-lab.1';\n"), '0.1.50-lab.1');
  assert.equal(agentVersionFromSource("const VERSION='1.2.3';"), '1.2.3');
  assert.throws(() => agentVersionFromSource('const x = 1;'), /declare its version/);
  assert.throws(() => agentVersionFromSource("const VERSION='latest';"), /not a version number/);
  assert.equal(outputName('0.1.50-lab.1', DEFAULT_TARGET), 'nuvrion-workstation-agent-0.1.50-lab.1.exe');
  assert.equal(outputName('0.1.50-lab.1', 'node18-linux-x64'), 'nuvrion-workstation-agent-0.1.50-lab.1');
});

test('a build stages exactly the agent sources and ws, packages them, and records what it made', async t => {
  const repoRoot = await fakeRepository(t), outDir = await mkdtemp(join(tmpdir(), 'nuvrion-build-out-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(5000, 1)]), seen = [];
  const built = await buildAgent({ repoRoot, outDir, sourceRevision: 'a'.repeat(40), execute: fakePackager(bytes, seen), now: () => new Date('2026-10-14T12:00:00Z') });
  assert.equal(built.version, '0.1.60-lab.1');
  assert.equal(built.file, 'nuvrion-workstation-agent-0.1.60-lab.1.exe');
  assert.equal(built.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(built.sizeBytes, bytes.length);
  assert.deepEqual(seen[0].files.sort(), ['agent-service.cjs', 'self-upgrade.cjs']);
  assert.ok(seen[0].ws.includes('index.js'));
  assert.deepEqual(seen[0].args.slice(1, 5), ['apps/workstation-agent/src/agent-service.cjs', '--targets', DEFAULT_TARGET, '--output']);
  const record = JSON.parse(await readFile(join(outDir, 'agent-build.json'), 'utf8'));
  assert.deepEqual(record, { format: 'nuvrion-agent-build/1', version: '0.1.60-lab.1', file: built.file, sha256: built.sha256, sizeBytes: bytes.length, target: DEFAULT_TARGET,
    sourceRevision: 'a'.repeat(40), packager: { name: '@yao-pkg/pkg', version: '5.12.1' }, dependencies: { ws: '8.21.0' }, builtAt: '2026-10-14T12:00:00.000Z' });
  assert.deepEqual((await readdir(outDir)).sort(), ['agent-build.json', built.file], 'only the executable and its record are left in the output');
});

test('an offline build cannot reach the network for the packager\'s base binary', async t => {
  const repoRoot = await fakeRepository(t), outDir = await mkdtemp(join(tmpdir(), 'nuvrion-build-out-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const seen = [];
  await buildAgent({ repoRoot, outDir, offline: true, execute: fakePackager(Buffer.from('MZ-ok'), seen), env: {} });
  assert.match(seen[0].env.HTTPS_PROXY, /127\.0\.0\.1/);
});

test('a failed packager, an empty or non-Windows result, and a missing packager are all errors', async t => {
  const repoRoot = await fakeRepository(t), outDir = await mkdtemp(join(tmpdir(), 'nuvrion-build-out-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await assert.rejects(buildAgent({ repoRoot, outDir, execute: async () => ({ code: 1, stdout: '', stderr: 'boom: no base binary' }) }), /packager failed \(exit 1\).*no base binary/s);
  await assert.rejects(buildAgent({ repoRoot, outDir, execute: fakePackager(Buffer.alloc(0)) }), /empty file/);
  await assert.rejects(buildAgent({ repoRoot, outDir, execute: fakePackager(Buffer.from('ELF not windows')) }), /not a Windows executable/);
  await assert.rejects(buildAgent({ repoRoot, outDir, pkgBin: join(repoRoot, 'nowhere.js'), execute: fakePackager(Buffer.from('MZ')) }), /packager is not installed/);
  await rm(join(repoRoot, 'node_modules/ws'), { recursive: true });
  await assert.rejects(buildAgent({ repoRoot, outDir, execute: fakePackager(Buffer.from('MZ')) }), /ENOENT/);
});

test('the build leaves nothing of its working copy behind, whether it worked or not', async t => {
  const repoRoot = await fakeRepository(t), outDir = await mkdtemp(join(tmpdir(), 'nuvrion-build-out-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('nuvrion-agent-build-'));
  await buildAgent({ repoRoot, outDir, execute: fakePackager(Buffer.from('MZ-ok')) });
  await assert.rejects(buildAgent({ repoRoot, outDir, execute: async () => ({ code: 2, stdout: '', stderr: 'x' }) }));
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('nuvrion-agent-build-')), before);
});

test('the smoke test accepts only an executable that says it is healthy and names the built version', async () => {
  const say = (code, stdout) => async () => ({ code, stdout, stderr: '' });
  const ok = JSON.stringify({ event: 'agent.selfcheck', ok: true, version: '0.1.60-lab.1' });
  assert.deepEqual(await smokeTest('/x', '0.1.60-lab.1', say(0, `noise\n${ok}\n`)), { event: 'agent.selfcheck', ok: true, version: '0.1.60-lab.1' });
  await assert.rejects(smokeTest('/x', '0.1.61-lab.1', say(0, ok)), /expected version 0\.1\.61-lab\.1/);
  await assert.rejects(smokeTest('/x', '0.1.60-lab.1', say(0, '{"ok":false,"version":"0.1.60-lab.1"}')), /reported/);
  await assert.rejects(smokeTest('/x', '0.1.60-lab.1', say(0, 'not json')), /not JSON/);
  await assert.rejects(smokeTest('/x', '0.1.60-lab.1', say(3, '')), /exited 3/);
});

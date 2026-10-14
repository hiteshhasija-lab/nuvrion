// Packages the Workstation agent into one executable, the same way every time, and records what went into it.
//
//   node tools/build-workstation-agent.js --out agent-build --source-revision <commit>
//   node tools/build-workstation-agent.js --out agent-smoke --target node18-linux-x64 --smoke
//
// The packager (@yao-pkg/pkg) is installed from its own lockfile in tools/agent-build (CI: `npm ci --ignore-scripts` there). The agent's
// only runtime dependency, `ws`, is taken from the repository's installed node_modules. Output, in --out:
//   nuvrion-workstation-agent-<version>.exe    (a Windows target; other targets have no extension)
//   agent-build.json                           version, SHA-256, size, target, commit, packager and ws versions
// With --smoke the built program is run with --self-check and must report the version the source declares; that proves the packaging
// (module resolution, the embedded runtime, the version constant) on a platform CI can execute, which a Windows executable cannot be there.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET = 'node18-win-x64';
const AGENT_SOURCES = ['agent-service.cjs', 'self-upgrade.cjs'];

export function agentVersionFromSource(source) {
  const match = /^const VERSION='([^']+)';/m.exec(String(source));
  if (!match) throw new Error("The agent source does not declare its version as: const VERSION='...';");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(match[1])) throw new Error(`The agent version ${match[1]} is not a version number.`);
  return match[1];
}

export function outputName(version, target) {
  return `nuvrion-workstation-agent-${version}${/-win-/.test(target) ? '.exe' : ''}`;
}

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

// Runs a program, collecting its output; resolves with { code, stdout, stderr }.
export function run(file, args, { cwd, env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

export async function buildAgent({ repoRoot, outDir, target = DEFAULT_TARGET, pkgBin, sourceRevision = null, offline = false, execute = run, now = () => new Date(), env = process.env }) {
  const root = resolve(repoRoot), out = resolve(outDir);
  const sourceDirectory = join(root, 'apps/workstation-agent/src');
  const version = agentVersionFromSource(await readFile(join(sourceDirectory, 'agent-service.cjs'), 'utf8'));
  const packagerBin = pkgBin ?? join(root, 'tools/agent-build/node_modules/@yao-pkg/pkg/lib-es5/bin.js');
  await stat(packagerBin).catch(() => { throw new Error(`The packager is not installed (${packagerBin}). Run: npm ci --ignore-scripts in tools/agent-build`); });
  const wsDirectory = join(root, 'node_modules/ws');
  const wsVersion = JSON.parse(await readFile(join(wsDirectory, 'package.json'), 'utf8')).version;
  const packagerVersion = JSON.parse(await readFile(join(root, 'tools/agent-build/package-lock.json'), 'utf8')).packages['node_modules/@yao-pkg/pkg'].version;

  const stage = await mkdtemp(join(tmpdir(), 'nuvrion-agent-build-'));
  try {
    const project = join(stage, 'nuvrion');
    await mkdir(join(project, 'apps/workstation-agent/src'), { recursive: true });
    await mkdir(join(project, 'node_modules'), { recursive: true });
    for (const name of AGENT_SOURCES) await cp(join(sourceDirectory, name), join(project, 'apps/workstation-agent/src', name));
    await cp(join(root, 'package.json'), join(project, 'package.json'));
    await cp(wsDirectory, join(project, 'node_modules/ws'), { recursive: true, dereference: true });

    await mkdir(out, { recursive: true });
    const file = outputName(version, target), destination = join(out, file);
    const packagerEnvironment = { ...env, ...(offline ? { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } : {}) };
    const result = await execute(process.execPath, [packagerBin, 'apps/workstation-agent/src/agent-service.cjs', '--targets', target, '--output', destination],
      { cwd: project, env: packagerEnvironment });
    if (result.code !== 0) throw new Error(`The packager failed (exit ${result.code}): ${String(result.stderr || result.stdout).slice(-600)}`);

    const bytes = await readFile(destination);
    if (!bytes.length) throw new Error('The packager produced an empty file.');
    if (/-win-/.test(target) && !(bytes[0] === 0x4d && bytes[1] === 0x5a)) throw new Error('The output is not a Windows executable.');
    const record = {
      format: 'nuvrion-agent-build/1', version, file, sha256: sha256Of(bytes), sizeBytes: bytes.length, target, sourceRevision,
      packager: { name: '@yao-pkg/pkg', version: packagerVersion }, dependencies: { ws: wsVersion }, builtAt: now().toISOString()
    };
    await writeFile(join(out, 'agent-build.json'), `${JSON.stringify(record, null, 2)}\n`);
    return { ...record, path: destination };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// Runs the built program with --self-check and compares the version it reports with the one that was built.
export async function smokeTest(path, expectedVersion, execute = run) {
  const result = await execute(path, ['--self-check'], {});
  if (result.code !== 0) throw new Error(`--self-check exited ${result.code}: ${String(result.stderr || result.stdout).slice(-400)}`);
  const line = result.stdout.split('\n').map(item => item.trim()).filter(Boolean).pop() ?? '';
  let report;
  try { report = JSON.parse(line); } catch { throw new Error(`--self-check printed something that is not JSON: ${line.slice(0, 200)}`); }
  if (report.ok !== true || report.version !== expectedVersion) throw new Error(`--self-check reported ${JSON.stringify(report)}, expected version ${expectedVersion}.`);
  return report;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--smoke' || name === '--offline') { options[name.slice(2)] = true; continue; }
    if (!name.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Unexpected argument: ${name}`);
    options[name.slice(2)] = argv[index + 1]; index += 1;
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  if (!options.out) throw new Error('Usage: node tools/build-workstation-agent.js --out <directory> [--target node18-win-x64] [--source-revision <commit>] [--smoke] [--offline]');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const built = await buildAgent({ repoRoot, outDir: options.out, target: options.target ?? DEFAULT_TARGET, sourceRevision: options['source-revision'] ?? null, offline: Boolean(options.offline) });
  console.log(JSON.stringify({ event: 'agent.build', version: built.version, file: built.file, sha256: built.sha256, sizeBytes: built.sizeBytes, target: built.target }));
  if (options.smoke) {
    const report = await smokeTest(built.path, built.version);
    console.log(JSON.stringify({ event: 'agent.build.smoke', ok: true, version: report.version }));
  }
}

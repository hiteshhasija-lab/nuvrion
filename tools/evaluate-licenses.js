// Licence review of everything the project installs from a registry, as a gate.
//
//   node tools/evaluate-licenses.js [--policy deploy/license-policy.json] [--out evidence/license-report.json]
//
// Reads the root lockfile and the toolchain lockfiles (tools/agent-build, tools/static-analysis), takes each package's licence from the lockfile and, when it
// has none, from the package's own package.json if it is installed, and evaluates them against the policy (modules/platform/src/license-policy.js).
// Exit 1 when any package is not acceptable or the policy itself is malformed. The report lists every package with its scope and decision.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLicenses, normaliseLicense } from '../modules/platform/src/license-policy.js';

const LOCKFILES = [
  { directory: '.', scope: 'runtime', devScope: 'dev' },
  { directory: 'tools/agent-build', scope: 'toolchain: agent packager', devScope: 'toolchain: agent packager' },
  { directory: 'tools/static-analysis', scope: 'toolchain: static analysis', devScope: 'toolchain: static analysis' }
];

export function packageName(path) {
  const index = path.lastIndexOf('node_modules/');
  return index === -1 ? path : path.slice(index + 'node_modules/'.length);
}

export async function collectPackages(root, lockfiles = LOCKFILES) {
  const packages = [];
  for (const { directory, scope, devScope } of lockfiles) {
    const lockPath = join(root, directory, 'package-lock.json');
    if (!existsSync(lockPath)) continue;
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (path === '' || entry.link) continue;
      let license = normaliseLicense(entry.license ?? entry.licenses);
      if (!license) {
        try {
          const installed = JSON.parse(await readFile(join(root, directory, path, 'package.json'), 'utf8'));
          license = normaliseLicense(installed.license ?? installed.licenses);
        } catch { /* not installed here: the lockfile is all there is */ }
      }
      packages.push({ name: packageName(path), version: entry.version, license, scope: entry.dev || entry.devOptional ? devScope : scope });
    }
  }
  return packages;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
  const policyPath = resolve(root, option('--policy') ?? 'deploy/license-policy.json');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const report = evaluateLicenses(await collectPackages(root), policy);
  const out = option('--out');
  if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), `${JSON.stringify({ format: 'nuvrion-license-report/1', generatedAt: new Date().toISOString(), policy: policy.format ?? null, ...report }, null, 2)}\n`); }
  console.log(JSON.stringify({ status: report.status, packages: report.packages, byScope: report.byScope, accepted: report.accepted, licenses: report.licenses, findings: report.findings, policyProblems: report.policyProblems }));
  if (report.status !== 'passed') process.exitCode = 1;
}

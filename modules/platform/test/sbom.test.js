import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCycloneDxSbom, parseNpmComponents, parsePnpmComponents, verifyCycloneDxSbom } from '../src/sbom.js';

const packageJson = { name: 'demo', version: '1.2.3', dependencies: { alpha: '^1.0.0', '@scope/beta': '2.0.0' } };
const lock = {
  name: 'demo', version: '1.2.3', lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.2.3', dependencies: packageJson.dependencies },
    'node_modules/alpha': { version: '1.4.0', resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.4.0.tgz', integrity: 'sha512-AAEC' },
    'node_modules/@scope/beta': { version: '2.0.0', resolved: 'https://registry.npmjs.org/@scope/beta/-/beta-2.0.0.tgz', integrity: 'sha512-AwQF' },
    'node_modules/alpha/node_modules/gamma': { version: '0.9.0', resolved: 'https://registry.npmjs.org/gamma/-/gamma-0.9.0.tgz', integrity: 'sha512-BgcI' },
    'node_modules/native-x64': { version: '1.0.0', optional: true, integrity: 'sha512-CQoL' },
    'node_modules/tester': { version: '9.9.9', dev: true, integrity: 'sha512-DA0O' },
    'node_modules/linked': { link: true, resolved: '../elsewhere' }
  }
};
const lockText = JSON.stringify(lock);
const sbom = (over = {}) => createCycloneDxSbom({ lockText, packageJson, sourceRevision: 'abc1234', generatedAt: '2026-10-06T00:00:00.000Z', ...over });

test('npm lockfile: production packages are listed, including nested ones; development-only entries and links are not', () => {
  const names = parseNpmComponents(lockText).map(c => `${c.name}@${c.version}`);
  assert.deepEqual(names, ['@scope/beta@2.0.0', 'alpha@1.4.0', 'gamma@0.9.0', 'native-x64@1.0.0']);
});

test('npm lockfile: optional packages are marked, and an unsupported lockfile version is refused', () => {
  assert.equal(parseNpmComponents(lockText).find(c => c.name === 'native-x64').optional, true);
  assert.throws(() => parseNpmComponents({ lockfileVersion: 1, packages: {} }), /NUV_SBOM_LOCKFILE_UNSUPPORTED/);
  assert.throws(() => parseNpmComponents('{}'), /NUV_SBOM_LOCKFILE_UNSUPPORTED/);
});

test('components carry package-url identifiers, hex hashes and the optional scope', () => {
  const byName = Object.fromEntries(sbom().components.map(c => [c.name, c]));
  assert.equal(byName['@scope/beta'].purl, 'pkg:npm/%40scope/beta@2.0.0');
  assert.equal(byName.alpha.purl, 'pkg:npm/alpha@1.4.0');
  assert.deepEqual(byName.alpha.hashes, [{ alg: 'SHA-512', content: '000102' }], 'base64 integrity becomes hex, as CycloneDX requires');
  assert.equal(byName['native-x64'].scope, 'optional');
  assert.equal(byName.alpha.scope, undefined);
});

test('the document describes the application and its direct dependencies', () => {
  const doc = sbom();
  assert.equal(doc.bomFormat, 'CycloneDX');
  assert.equal(doc.specVersion, '1.6');
  assert.equal(doc.metadata.component.purl, 'pkg:npm/demo@1.2.3');
  assert.deepEqual(doc.dependencies, [{ ref: 'pkg:npm/demo@1.2.3', dependsOn: ['pkg:npm/%40scope/beta@2.0.0', 'pkg:npm/alpha@1.4.0'] }]);
  assert.equal(doc.metadata.properties.find(p => p.name === 'nuvrion:sourceRevision').value, 'abc1234');
  assert.equal(doc.metadata.properties.find(p => p.name === 'nuvrion:lockfileFormat').value, 'package-lock.json/v3');
});

test('the same lockfile always gives the same fingerprint, whatever the time or revision', () => {
  const a = sbom(), b = sbom({ generatedAt: '2030-01-01T00:00:00.000Z', sourceRevision: 'ffff000' });
  const fingerprint = doc => doc.metadata.properties.find(p => p.name === 'nuvrion:productionDependencyFingerprint').value;
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(a.serialNumber, b.serialNumber);
  const changed = JSON.stringify({ ...lock, packages: { ...lock.packages, 'node_modules/alpha': { ...lock.packages['node_modules/alpha'], version: '1.4.1' } } });
  assert.notEqual(fingerprint(a), fingerprint(createCycloneDxSbom({ lockText: changed, packageJson })));
});

test('verification passes for a matching SBOM and fails when the SBOM or the lockfile is tampered with', () => {
  const good = sbom();
  assert.deepEqual(verifyCycloneDxSbom({ sbom: good, lockText, packageJson }), { verified: true, componentCount: 4, fingerprint: good.metadata.properties[1].value });
  const swapped = structuredClone(good); swapped.components[1].version = '1.4.1';
  assert.throws(() => verifyCycloneDxSbom({ sbom: swapped, lockText, packageJson }), /NUV_SBOM_VERIFICATION_FAILED/, 'component version changed');
  const dropped = structuredClone(good); dropped.components.pop();
  assert.throws(() => verifyCycloneDxSbom({ sbom: dropped, lockText, packageJson }), /NUV_SBOM_VERIFICATION_FAILED/, 'component removed');
  const rewired = structuredClone(good); rewired.dependencies[0].dependsOn = [];
  assert.throws(() => verifyCycloneDxSbom({ sbom: rewired, lockText, packageJson }), /NUV_SBOM_VERIFICATION_FAILED/, 'dependency graph changed');
  const newer = JSON.stringify({ ...lock, packages: { ...lock.packages, 'node_modules/extra': { version: '1.0.0', integrity: 'sha512-AAEC' } } });
  assert.throws(() => verifyCycloneDxSbom({ sbom: good, lockText: newer, packageJson }), /NUV_SBOM_VERIFICATION_FAILED/, 'lockfile moved on since the SBOM');
  assert.throws(() => verifyCycloneDxSbom({ sbom: { ...good, bomFormat: 'SPDX' }, lockText, packageJson }), /NUV_SBOM_VERIFICATION_FAILED/);
});

test('pnpm lockfiles are still understood', () => {
  const pnpm = ['lockfileVersion: 9.0', '', 'packages:', '', "  '@scope/pkg@1.0.0':", '    resolution: {integrity: sha512-AAEC}', '', '  left-pad@1.3.0:', '    resolution: {integrity: sha512-AwQF}', '', 'snapshots:', '', '  ignored@9.9.9: {}'].join('\n');
  assert.deepEqual(parsePnpmComponents(pnpm).map(c => `${c.name}@${c.version}`), ['@scope/pkg@1.0.0', 'left-pad@1.3.0']);
  const doc = createCycloneDxSbom({ lockText: pnpm, packageJson: { name: 'demo', version: '1.0.0' } });
  assert.equal(doc.metadata.properties.find(p => p.name === 'nuvrion:lockfileFormat').value, 'pnpm-lock.yaml/9.0');
  assert.equal(doc.components.length, 2);
});

// The repository's own lockfile: this is what stops an unpinned or unverifiable dependency from creeping in.
const repoLock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
const repoPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
test('the repository lockfile lists exactly the dependencies in package.json', () => {
  assert.deepEqual(repoLock.packages[''].dependencies, repoPackage.dependencies);
  assert.equal(repoLock.packages[''].devDependencies, undefined, 'there are no development dependencies to hide');
});

test('every locked package comes from the npm registry over HTTPS with a SHA-512 integrity hash', () => {
  const entries = Object.entries(repoLock.packages).filter(([path]) => path);
  assert.ok(entries.length > 50);
  for (const [path, entry] of entries) {
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${path} must resolve from the npm registry`);
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/, `${path} must carry an integrity hash`);
  }
});

test('an SBOM can be produced and verified from the repository lockfile', () => {
  const lockFile = readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8');
  const doc = createCycloneDxSbom({ lockText: lockFile, packageJson: repoPackage, sourceRevision: 'test' });
  assert.equal(doc.components.length, parseNpmComponents(lockFile).length);
  assert.ok(doc.components.every(c => c.hashes?.length === 1), 'every component has a hash');
  assert.equal(new Set(doc.components.map(c => c['bom-ref'])).size, doc.components.length, 'identifiers are unique');
  assert.equal(verifyCycloneDxSbom({ sbom: doc, lockText: lockFile, packageJson: repoPackage }).verified, true);
});

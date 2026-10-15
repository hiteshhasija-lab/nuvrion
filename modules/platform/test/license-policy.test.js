import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseExpression, evaluateLicenses, normaliseLicense } from '../src/license-policy.js';
import { collectPackages, packageName } from '../../../tools/evaluate-licenses.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const policy = (over = {}) => ({ allowed: ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause'], reviewed: [], declared: [], exceptions: [], ...over });
const pkg = (name, license, over = {}) => ({ name, version: '1.0.0', license, scope: 'runtime', ...over });
const verdict = (packages, p = policy()) => Object.fromEntries(evaluateLicenses(packages, p, { now: NOW }).rows.map(row => [row.name, row.status]));

test('licence expressions are read as SPDX: OR, AND, parentheses, WITH and a trailing plus', () => {
  assert.deepEqual(parseExpression('MIT'), { id: 'MIT' });
  assert.deepEqual(parseExpression('(MIT OR Apache-2.0)'), { any: [{ id: 'MIT' }, { id: 'Apache-2.0' }] });
  assert.deepEqual(parseExpression('MIT AND (ISC OR BSD-3-Clause)'), { all: [{ id: 'MIT' }, { any: [{ id: 'ISC' }, { id: 'BSD-3-Clause' }] }] });
  assert.deepEqual(parseExpression('GPL-2.0-only WITH Classpath-exception-2.0'), { id: 'GPL-2.0-only WITH Classpath-exception-2.0' });
  assert.deepEqual(parseExpression('Apache-2.0+'), { id: 'Apache-2.0' });
  for (const bad of ['', '   ', '(MIT', 'MIT OR', 'AND MIT', 'MIT AND OR ISC', 'MIT)']) assert.equal(parseExpression(bad), null, JSON.stringify(bad));
});

test('the old lockfile shapes (an object, a list) read as an expression', () => {
  assert.equal(normaliseLicense('MIT'), 'MIT');
  assert.equal(normaliseLicense({ type: 'MIT', url: 'x' }), 'MIT');
  assert.equal(normaliseLicense([{ type: 'MIT' }, { type: 'Apache-2.0' }]), '(MIT OR Apache-2.0)');
  assert.equal(normaliseLicense([{ type: 'MIT' }]), 'MIT');
  assert.equal(normaliseLicense(''), null);
  assert.equal(normaliseLicense(undefined), null);
});

test('an allowed licence passes; an OR passes when one branch is acceptable; an AND needs every part', () => {
  assert.deepEqual(verdict([pkg('a', 'MIT'), pkg('b', '(GPL-3.0-only OR MIT)'), pkg('c', '(MIT AND Apache-2.0)'), pkg('d', '(MIT AND GPL-3.0-only)'), pkg('e', '(ISC OR BSD-3-Clause)')]),
    { a: 'allowed', b: 'allowed', c: 'allowed', d: 'blocked', e: 'allowed' });
});

test('a denied or unknown licence blocks, and so do a missing and an unreadable one', () => {
  const report = evaluateLicenses([pkg('gpl', 'GPL-3.0-only'), pkg('agpl', 'AGPL-3.0-or-later'), pkg('lgpl', 'LGPL-2.1'), pkg('nc', 'CC-BY-NC-4.0'), pkg('unknown', 'Acme-1.0'),
    pkg('none', null), pkg('weird', 'MIT OR'), pkg('fine', 'MIT')], policy(), { now: NOW });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.findings.map(item => item.package).sort(), ['agpl', 'gpl', 'lgpl', 'nc', 'none', 'unknown', 'weird']);
  assert.match(report.findings.find(item => item.package === 'gpl').reason, /denied licence: GPL-3\.0-only/);
  assert.match(report.findings.find(item => item.package === 'none').reason, /no licence is declared/);
  assert.match(report.findings.find(item => item.package === 'weird').reason, /cannot be read/);
  assert.equal(verdict([pkg('fine', 'MIT')]).fine, 'allowed');
});

test('the deny list wins over the allow list, so a mistake in the allow list cannot let a copyleft licence in', () => {
  const p = policy({ allowed: ['MIT', 'LGPL-2.1', 'GPL-3.0-only'] });
  const report = evaluateLicenses([pkg('x', 'LGPL-2.1'), pkg('y', 'GPL-3.0-only'), pkg('z', 'MIT')], p, { now: NOW });
  assert.deepEqual(Object.fromEntries(report.rows.map(row => [row.name, row.status])), { x: 'blocked', y: 'blocked', z: 'allowed' });
  // an own deny list replaces the default, and can add to it
  const own = policy({ denied: ['Acme-*'], allowed: ['MIT', 'Acme-1.0'] });
  assert.equal(verdict([pkg('a', 'Acme-1.0')], own).a, 'blocked');
});

test('a licence accepted by name applies to that package only', () => {
  const p = policy({ reviewed: [{ license: 'MPL-2.0', packages: ['vendored-lib'], reason: 'used unmodified' }] });
  assert.deepEqual(verdict([pkg('vendored-lib', 'MPL-2.0'), pkg('another', 'MPL-2.0')], p), { 'vendored-lib': 'reviewed', another: 'blocked' });
  const withDenied = policy({ reviewed: [{ license: 'GPL-*', packages: ['x'], reason: 'nope' }] });
  assert.equal(verdict([pkg('x', 'GPL-3.0-only')], withDenied).x, 'blocked', 'a denied licence cannot be accepted by name');
});

test('an exception works for that package until its expiry and then blocks again, saying why', () => {
  const live = policy({ exceptions: [{ package: 'odd', reason: 'reviewed by the owner', expires: '2026-12-01' }] });
  assert.equal(verdict([pkg('odd', 'Acme-1.0')], live).odd, 'excepted');
  const expired = policy({ exceptions: [{ package: 'odd', reason: 'reviewed by the owner', expires: '2026-10-01' }] });
  const report = evaluateLicenses([pkg('odd', 'Acme-1.0')], expired, { now: NOW });
  assert.equal(report.status, 'blocked');
  assert.match(report.findings[0].reason, /the exception expired on 2026-10-01/);
});

test('a package without a licence in its lockfile entry uses the determination recorded for that exact version', () => {
  const p = policy({ declared: [{ package: 'helper', version: '0.0.7', license: 'MIT', source: 'its own package.json' }] });
  assert.equal(verdict([pkg('helper', null, { version: '0.0.7' })], p).helper, 'allowed');
  assert.equal(verdict([pkg('helper', null, { version: '0.0.8' })], p).helper, 'blocked', 'a new version has to be looked at again');
  const row = evaluateLicenses([pkg('helper', null, { version: '0.0.7' })], p, { now: NOW }).rows[0];
  assert.equal(row.license, 'MIT');
  assert.equal(row.licenseSource, 'its own package.json');
  assert.equal(verdict([pkg('helper', 'ISC', { version: '0.0.8' })], p).helper, 'allowed', 'a package that has a licence needs no determination');
});

test('a malformed policy entry blocks the run rather than being ignored', () => {
  for (const bad of [{ exceptions: [{ package: 'x', reason: 'r' }] }, { exceptions: [{ package: 'x', expires: '2027-01-01' }] }, { exceptions: [{ package: 'x', reason: 'r', expires: 'soon' }] },
    { reviewed: [{ license: 'MPL-2.0', packages: [] , reason: 'r' }] }, { reviewed: [{ license: 'MPL-2.0', packages: ['x'] }] }, { declared: [{ package: 'x', version: '1', license: 'MIT' }] },
    { exceptions: [{ package: 'x', reason: 'r', reviewedAt: '2026-01-01', expires: '2026-12-31' }] }]) {
    const report = evaluateLicenses([pkg('x', 'MIT')], policy(bad), { now: NOW });
    assert.equal(report.status, 'blocked', JSON.stringify(bad));
    assert.ok(report.policyProblems.length > 0, JSON.stringify(bad));
  }
});

test('packages are collected from lockfiles with their scope, scoped and nested names, and the installed licence when the lockfile has none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nuvrion-licenses-'));
  try {
    mkdirSync(join(root, 'node_modules/needs-fallback'), { recursive: true });
    writeFileSync(join(root, 'node_modules/needs-fallback/package.json'), JSON.stringify({ name: 'needs-fallback', licenses: [{ type: 'MIT' }] }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'root' },
      'node_modules/runtime-a': { version: '1.0.0', license: 'MIT' },
      'node_modules/@scope/pkg': { version: '2.0.0', license: 'ISC' },
      'node_modules/runtime-a/node_modules/nested': { version: '3.0.0', license: { type: 'BSD-3-Clause' } },
      'node_modules/dev-tool': { version: '1.0.0', license: 'MIT', dev: true },
      'node_modules/dev-or-optional': { version: '1.0.0', license: 'MIT', devOptional: true },
      'node_modules/needs-fallback': { version: '0.1.0' },
      'node_modules/no-licence-anywhere': { version: '0.1.0' },
      'node_modules/linked': { link: true, resolved: '../x' }
    } }));
    const packages = await collectPackages(root, [{ directory: '.', scope: 'runtime', devScope: 'dev' }]);
    const by = Object.fromEntries(packages.map(item => [item.name, item]));
    assert.deepEqual(Object.keys(by).sort(), ['@scope/pkg', 'dev-or-optional', 'dev-tool', 'needs-fallback', 'nested', 'no-licence-anywhere', 'runtime-a']);
    assert.deepEqual([by['runtime-a'].scope, by['dev-tool'].scope, by['dev-or-optional'].scope], ['runtime', 'dev', 'dev']);
    assert.equal(by['nested'].license, 'BSD-3-Clause');
    assert.equal(by['needs-fallback'].license, 'MIT');
    assert.equal(by['no-licence-anywhere'].license, null);
    assert.equal(packageName('node_modules/a/node_modules/@s/b'), '@s/b');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the repository itself passes its own licence policy, and a changed lockfile would have to', () => {
  const run = spawnSync(process.execPath, ['tools/evaluate-licenses.js'], { cwd: new URL('../../../', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'passed');
  assert.ok(report.packages >= 300, 'the runtime lockfile and both toolchain lockfiles are read');
  assert.ok(report.byScope.runtime >= 100 && report.byScope['toolchain: agent packager'] > 0 && report.byScope['toolchain: static analysis'] > 0);
  assert.deepEqual(report.findings, []);
});

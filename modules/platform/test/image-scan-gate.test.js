import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateImageScan, assertImageScanPassed, ImageScanGateError } from '../src/image-scan-gate.js';

// The policy that decides whether a scanned container image may ship: a HIGH or CRITICAL finding with a fix blocks; one with no fix is
// reported; an acceptance must carry a reason and a near expiry, and blocks again when it expires.
const NOW = Date.parse('2026-10-12T12:00:00Z');
const finding = (id, severity, pkg, fixedIn = null, installed = '1.0') => ({ VulnerabilityID: id, Severity: severity, PkgName: pkg, InstalledVersion: installed, ...(fixedIn ? { FixedVersion: fixedIn } : {}) });
const report = (...vulnerabilities) => ({ ArtifactName: 'nuvrion', CreatedAt: '2026-10-12T11:00:00Z', Results: [{ Target: 'nuvrion (debian 12.15)', Vulnerabilities: vulnerabilities }] });
const accept = (id, over = {}) => ({ id, packages: ['perl-base'], reason: 'perl is only here because dpkg needs it; nothing runs it', expires: '2026-10-26', ...over });
const evaluate = (r, options = {}) => evaluateImageScan(r, { now: NOW, ...options });

test('an image with nothing serious passes', () => {
  const result = evaluate(report(finding('CVE-1', 'MEDIUM', 'a', '2.0'), finding('CVE-2', 'LOW', 'b')));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.counts, { 'MEDIUM.fixed': 1, 'LOW.unfixed': 1 });
  assert.equal(result.blocking, 0);
});

test('a high or critical finding that has a fix blocks, and says what to upgrade to', () => {
  for (const severity of ['HIGH', 'CRITICAL']) {
    const result = evaluate(report(finding('CVE-2026-1', severity, 'perl-base', '5.36.0-7+deb12u4', '5.36.0-7+deb12u3')));
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.blockers.map(({ id, package: p, installed, fixedIn }) => [id, p, installed, fixedIn]), [['CVE-2026-1', 'perl-base', '5.36.0-7+deb12u3', '5.36.0-7+deb12u4']]);
  }
});

test('a high or critical finding with no fix is counted and reported but does not block', () => {
  const result = evaluate(report(finding('CVE-9', 'CRITICAL', 'zlib1g'), finding('CVE-10', 'HIGH', 'libx')));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.counts, { 'CRITICAL.unfixed': 1, 'HIGH.unfixed': 1 });
});

test('the same finding listed under two targets, or for two packages, is counted once per package', () => {
  const twice = { ...report(finding('CVE-3', 'HIGH', 'p', '2')), Results: [report(finding('CVE-3', 'HIGH', 'p', '2')).Results[0], report(finding('CVE-3', 'HIGH', 'p', '2')).Results[0]] };
  assert.equal(evaluate(twice).blockers.length, 1);
  assert.equal(evaluate(report(finding('CVE-3', 'HIGH', 'p', '2'), finding('CVE-3', 'HIGH', 'q', '2'))).blockers.length, 2);
});

test('an acceptance with a reason and a near expiry lets the finding through, and is listed', () => {
  const result = evaluate(report(finding('CVE-2026-1', 'HIGH', 'perl-base', '2')), { exceptions: [accept('CVE-2026-1')] });
  assert.equal(result.status, 'passed');
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].expiresAt, '2026-10-26T23:59:59.000Z');
});

test('an acceptance covers only the package it names, and only the finding it names', () => {
  const r = report(finding('CVE-2026-1', 'HIGH', 'perl-base', '2'), finding('CVE-2026-1', 'HIGH', 'libother', '2'), finding('CVE-2026-2', 'HIGH', 'perl-base', '2'));
  const result = evaluate(r, { exceptions: [accept('CVE-2026-1')] });
  assert.deepEqual(result.blockers.map(b => `${b.id}/${b.package}`).sort(), ['CVE-2026-1/libother', 'CVE-2026-2/perl-base']);
});

test('an acceptance that has expired blocks again, and says so', () => {
  const result = evaluate(report(finding('CVE-2026-1', 'HIGH', 'perl-base', '2')), { exceptions: [accept('CVE-2026-1', { expires: '2026-10-11' })] });
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers[0].note, /expired on 2026-10-11/);
});

test('an acceptance cannot be made permanent: a far expiry, a missing reason or a malformed entry is itself a problem', () => {
  const r = report(finding('CVE-2026-1', 'HIGH', 'perl-base', '2'));
  for (const bad of [accept('CVE-2026-1', { expires: '2027-12-31' }), accept('CVE-2026-1', { reason: 'ok' }), accept('CVE-2026-1', { expires: 'someday' }), accept('not-an-id')]) {
    const result = evaluate(r, { exceptions: [bad] });
    assert.equal(result.status, 'blocked', JSON.stringify(bad));
    assert.ok(result.problems.length >= 1 || result.blockers.length >= 1);
  }
});

test('an acceptance that no longer matches anything is reported so it can be removed', () => {
  const result = evaluate(report(finding('CVE-5', 'LOW', 'a')), { exceptions: [accept('CVE-2026-1')] });
  assert.equal(result.status, 'passed');
  assert.equal(result.staleExceptions.length, 1);
});

test('a report that is not a Trivy image report, or that is too old, does not pass', () => {
  for (const bad of [null, {}, { Results: 'none' }, 'text', []]) assert.equal(evaluate(bad).status, 'blocked');
  assert.equal(evaluate(report(), { maxReportAgeMs: 3_600_000 * 24 }).status, 'passed');
  const old = { ...report(), CreatedAt: '2026-10-01T00:00:00Z' };
  assert.equal(evaluate(old, { maxReportAgeMs: 3_600_000 * 24 }).status, 'blocked');
  assert.equal(evaluate({ Results: [] }, { maxReportAgeMs: 1000 }).status, 'blocked', 'no creation time');
});

test('assertImageScanPassed throws the report when blocked and returns it when passed', () => {
  assert.doesNotThrow(() => assertImageScanPassed(report(), { now: NOW }));
  assert.throws(() => assertImageScanPassed(report(finding('CVE-1', 'HIGH', 'x', '2')), { now: NOW }), error => error instanceof ImageScanGateError && error.report.blocking === 1);
});

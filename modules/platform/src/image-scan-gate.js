export class ImageScanGateError extends Error { constructor(report) { super('The container image scan did not pass.'); this.code = 'NUV_IMAGE_SCAN_FAILED'; this.report = report; } }

const DAY = 86_400_000;
const blocking = ['HIGH', 'CRITICAL'];

// Policy for a Trivy JSON report of a container image (trivy image --format json):
//  - a HIGH or CRITICAL finding that has a fixed version blocks, because the fix exists and the image can take it (bump the pinned base image);
//  - a finding with no fix yet is counted and reported, and does not block, because there is nothing to apply;
//  - a finding may be accepted for a short time by an entry in the exceptions file, which must say why and must expire soon, so that an
//    acceptance cannot become permanent by being forgotten (an expired entry blocks again).
export function evaluateImageScan(report, { exceptions = [], now = Date.now(), maxExceptionDays = 45, maxReportAgeMs = null } = {}) {
  const blockers = [], accepted = [], problems = [];
  if (!report || typeof report !== 'object' || !Array.isArray(report.Results)) {
    return finish({ status: 'blocked', problems: ['the scan report is not a Trivy image report (no Results list)'], counts: {}, blockers, accepted, staleExceptions: [] });
  }
  if (maxReportAgeMs !== null) {
    const created = Date.parse(report.CreatedAt ?? '');
    if (!Number.isFinite(created) || now - created > maxReportAgeMs || created > now + 300_000) problems.push('the scan report is stale or has no creation time');
  }

  const valid = new Map();
  for (const entry of Array.isArray(exceptions) ? exceptions : []) {
    const expires = Date.parse(`${entry?.expires ?? ''}T23:59:59Z`);
    if (!/^(CVE|GHSA)-[0-9A-Za-z-]+$/.test(entry?.id ?? '') || typeof entry?.reason !== 'string' || entry.reason.trim().length < 20 || !Number.isFinite(expires)) {
      problems.push(`exception ${JSON.stringify(entry?.id ?? null)} needs an id, a reason of at least 20 characters and an expiry date (YYYY-MM-DD)`);
      continue;
    }
    if (expires > now + maxExceptionDays * DAY) { problems.push(`exception ${entry.id} expires more than ${maxExceptionDays} days from now; accept a finding for a short time and renew it deliberately`); continue; }
    valid.set(entry.id, { ...entry, expiresAt: new Date(expires).toISOString(), expired: expires < now, used: false });
  }

  const counts = {};
  const seen = new Set();
  for (const result of report.Results) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      const severity = String(vulnerability.Severity ?? 'UNKNOWN').toUpperCase();
      const fixed = Boolean(vulnerability.FixedVersion);
      const key = `${severity}.${fixed ? 'fixed' : 'unfixed'}`;
      const identity = `${vulnerability.VulnerabilityID}|${vulnerability.PkgName}|${vulnerability.InstalledVersion}`;
      if (seen.has(identity)) continue;                // the same package can be listed under more than one target
      seen.add(identity);
      counts[key] = (counts[key] ?? 0) + 1;
      if (!blocking.includes(severity) || !fixed) continue;
      const exception = valid.get(vulnerability.VulnerabilityID);
      const finding = { id: vulnerability.VulnerabilityID, severity, package: vulnerability.PkgName, installed: vulnerability.InstalledVersion, fixedIn: vulnerability.FixedVersion, target: result.Target };
      if (exception && !exception.expired && (!exception.packages || exception.packages.includes(vulnerability.PkgName))) { exception.used = true; accepted.push({ ...finding, reason: exception.reason, expiresAt: exception.expiresAt }); }
      else blockers.push({ ...finding, ...(exception?.expired ? { note: `the exception expired on ${exception.expiresAt.slice(0, 10)}` } : {}) });
    }
  }
  const staleExceptions = [...valid.values()].filter(entry => !entry.used).map(entry => ({ id: entry.id, expiresAt: entry.expiresAt, note: entry.expired ? 'expired and no longer needed' : 'no longer matches a finding; remove it' }));
  return finish({ status: blockers.length || problems.length ? 'blocked' : 'passed', problems, counts, blockers, accepted, staleExceptions });
}

function finish(result) { return { ...result, blocking: result.blockers.length }; }

export function assertImageScanPassed(report, options) {
  const result = evaluateImageScan(report, options);
  if (result.status !== 'passed') throw new ImageScanGateError(result);
  return result;
}

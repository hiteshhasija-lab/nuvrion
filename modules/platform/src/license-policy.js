// Licence review of the packages the project depends on, as a rule that can fail a build. Every package in a lockfile must carry a licence, and each licence
// must be one the project has accepted: on the allow list, or accepted for that package by name with a reason (weak copyleft used as an unmodified
// dependency), or excepted for that package with a reason and an expiry. Strong-copyleft and non-commercial licences are denied outright.
// The licence of a package is taken from the lockfile, then from the package's own package.json when the lockfile has none; no licence at all is a finding.

const DENIED_DEFAULT = ['GPL-*', 'AGPL-*', 'LGPL-*', 'SSPL-*', 'BUSL-*', 'CC-BY-NC*', 'CC-BY-SA*', 'EUPL-*', 'OSL-*', 'UNLICENSED', 'SEE LICENSE*', 'PROPRIETARY'];
const MAX_EXCEPTION_DAYS = 120;

// SPDX licence expressions: identifiers joined by OR / AND, with parentheses and optional WITH exceptions. Returns a tree or null when it cannot be read.
export function parseExpression(text) {
  const parts = String(text ?? '').replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let position = 0;
  const peek = () => parts[position], take = () => parts[position++];
  function atom() {
    const part = take();
    if (part === undefined) throw new Error('unexpected end');
    if (part === '(') { const inner = or(); if (take() !== ')') throw new Error('missing )'); return inner; }
    if (part === ')' || /^(AND|OR|WITH)$/i.test(part)) throw new Error(`unexpected ${part}`);
    let id = part.replace(/\+$/, '');
    if (/^WITH$/i.test(peek() ?? '')) { take(); id = `${id} WITH ${take()}`; }
    return { id };
  }
  function and() { const parts = [atom()]; while (/^AND$/i.test(peek() ?? '')) { take(); parts.push(atom()); } return parts.length === 1 ? parts[0] : { all: parts }; }
  function or() { const parts = [and()]; while (/^OR$/i.test(peek() ?? '')) { take(); parts.push(and()); } return parts.length === 1 ? parts[0] : { any: parts }; }
  try { const tree = or(); return position === parts.length ? tree : null; } catch { return null; }
}

const matches = (pattern, id) => (pattern.endsWith('*') ? id.toUpperCase().startsWith(pattern.slice(0, -1).toUpperCase()) : id.toUpperCase() === pattern.toUpperCase());

// Whether a tree is acceptable under `accepts(id)`: any branch of an OR, every part of an AND.
function acceptable(tree, accepts) {
  if (tree.id) return accepts(tree.id);
  if (tree.any) return tree.any.some(part => acceptable(part, accepts));
  return tree.all.every(part => acceptable(part, accepts));
}
function identifiers(tree) { return tree.id ? [tree.id] : (tree.any ?? tree.all).flatMap(identifiers); }

export function normaliseLicense(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) { const parts = value.map(normaliseLicense).filter(Boolean); return parts.length ? parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})` : null; }
  if (typeof value === 'object') return normaliseLicense(value.type ?? value.name);
  return null;
}

/**
 * @param packages  [{ name, version, license, scope }]  (license already resolved: string or null)
 * @param policy    { allowed: [], reviewed: [{ license, packages: [], reason }], declared: [{ package, version, license, source }], exceptions: [{ package, license?, reason, expires }], denied?: [] }
 */
export function evaluateLicenses(packages, policy, { now = Date.now() } = {}) {
  const findings = [], accepted = { allowed: 0, reviewed: 0, excepted: 0 }, perLicense = {};
  const allowed = new Set((policy.allowed ?? []).map(id => id.toUpperCase()));
  const denied = policy.denied ?? DENIED_DEFAULT;
  const problems = [];

  for (const item of policy.exceptions ?? []) {
    const expires = Date.parse(item.expires ?? '');
    if (!item.package || !item.reason || Number.isNaN(expires)) problems.push(`an exception needs a package, a reason and an expiry date: ${JSON.stringify(item)}`);
    else if (item.reviewedAt && expires - Date.parse(item.reviewedAt) > MAX_EXCEPTION_DAYS * 86400000) problems.push(`the exception for ${item.package} runs longer than ${MAX_EXCEPTION_DAYS} days`);
  }
  for (const item of policy.reviewed ?? []) {
    if (!item.license || !item.reason || !Array.isArray(item.packages) || !item.packages.length) problems.push(`a reviewed licence needs the licence, a reason and the packages: ${JSON.stringify(item)}`);
  }

  for (const item of policy.declared ?? []) {
    if (!item.package || !item.version || !item.license || !item.source) problems.push(`a declared licence needs the package, its version, the licence and where it was read: ${JSON.stringify(item)}`);
  }

  const rows = packages.map(item => {
    // A package whose lockfile entry has no licence is read from a determination recorded in the policy, for that exact version.
    const declared = item.license ? null : (policy.declared ?? []).find(entry => entry.package === item.name && entry.version === item.version);
    const expression = item.license ? String(item.license) : declared ? String(declared.license) : null;
    const row = { name: item.name, version: item.version ?? null, scope: item.scope ?? 'runtime', license: expression, status: null, why: null, ...(declared ? { licenseSource: declared.source } : {}) };
    const record = (status, why = null) => { row.status = status; row.why = why; return row; };
    if (!expression) { findings.push({ package: item.name, scope: row.scope, reason: 'no licence is declared' }); return record('blocked', 'no licence is declared'); }
    const tree = parseExpression(expression);
    if (!tree) { findings.push({ package: item.name, scope: row.scope, license: expression, reason: 'the licence expression cannot be read' }); return record('blocked', 'unreadable licence expression'); }
    for (const id of identifiers(tree)) perLicense[id] = (perLicense[id] ?? 0) + 1;

    const exception = (policy.exceptions ?? []).find(entry => entry.package === item.name && (!entry.license || entry.license === expression) && Date.parse(entry.expires ?? '') > now);
    const expiredException = (policy.exceptions ?? []).find(entry => entry.package === item.name && (!entry.license || entry.license === expression) && !(Date.parse(entry.expires ?? '') > now));
    const isDenied = id => denied.some(pattern => matches(pattern, id));
    const isAllowed = id => allowed.has(id.toUpperCase());
    const isReviewed = id => (policy.reviewed ?? []).some(entry => matches(entry.license, id) && (entry.packages ?? []).includes(item.name));

    // an OR that offers an acceptable choice is acceptable even if another branch is not; an AND needs every part
    if (acceptable(tree, id => !isDenied(id) && isAllowed(id))) { accepted.allowed += 1; return record('allowed'); }
    if (acceptable(tree, id => !isDenied(id) && (isAllowed(id) || isReviewed(id)))) { accepted.reviewed += 1; return record('reviewed', 'accepted by name in the policy'); }
    if (exception) { accepted.excepted += 1; return record('excepted', exception.reason); }
    const deniedIds = identifiers(tree).filter(isDenied);
    const reason = deniedIds.length ? `denied licence: ${deniedIds.join(', ')}` : expiredException ? `the exception expired on ${expiredException.expires}` : `licence not accepted: ${expression}`;
    findings.push({ package: item.name, scope: row.scope, license: expression, reason });
    return record('blocked', reason);
  });

  const status = findings.length || problems.length ? 'blocked' : 'passed';
  const byScope = {};
  for (const row of rows) byScope[row.scope] = (byScope[row.scope] ?? 0) + 1;
  return { status, packages: rows.length, byScope, accepted, licenses: Object.fromEntries(Object.entries(perLicense).sort((a, b) => b[1] - a[1])), findings, policyProblems: problems, rows };
}

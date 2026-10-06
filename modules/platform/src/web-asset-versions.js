import { createHash } from 'node:crypto';

// The console loads its scripts and stylesheets as "/app.js?v=20261006-115". Browsers keep a file for as long as that URL stays the same,
// so a changed file needs a new version number. This records a hash of each versioned file next to the version it was released under,
// and reports a file that changed while still carrying the old version.
const REFERENCE = /([A-Za-z0-9._-]+\.(?:js|css))\?v=([0-9][0-9-]*)/g;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// sources: { 'index.html': '<text>', 'app.js': '<text>', ... } -> { 'app.js': ['20261006-115', ...] } for every versioned file mentioned anywhere
export function scanAssetReferences(sources) {
  const found = {};
  for (const text of Object.values(sources)) for (const [, file, version] of text.matchAll(REFERENCE)) (found[file] ??= new Set()).add(version);
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)).map(([file, versions]) => [file, [...versions]]));
}

// references: from scanAssetReferences; hashes: { file: sha256 of its current content }; lock: { file: { version, sha256 } }
export function assetVersionProblems({ references, hashes, lock }) {
  const problems = [];
  for (const [file, versions] of Object.entries(references)) {
    if (versions.length > 1) { problems.push(`${file} is referenced with different versions (${versions.join(', ')}); use one`); continue; }
    if (!(file in hashes)) { problems.push(`${file} has a version but the file does not exist`); continue; }
    const [version] = versions, recorded = lock[file];
    if (!recorded) problems.push(`${file} (version ${version}) is not recorded in asset-versions.lock.json; run node tools/update-web-asset-versions.js`);
    else if (recorded.version !== version) problems.push(`${file} is referenced as version ${version} but the lock records ${recorded.version}; run node tools/update-web-asset-versions.js`);
    else if (recorded.sha256 !== hashes[file]) problems.push(`${file} changed but is still version ${version}: browsers that already have it will keep the old copy. Give it a new ?v= number everywhere it is referenced, then run node tools/update-web-asset-versions.js`);
  }
  for (const file of Object.keys(lock)) if (!(file in references)) problems.push(`${file} is in the lock but no longer has a versioned reference; run node tools/update-web-asset-versions.js`);
  return problems;
}

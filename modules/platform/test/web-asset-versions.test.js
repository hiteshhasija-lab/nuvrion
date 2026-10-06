import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { assetVersionProblems, scanAssetReferences, sha256 } from '../src/web-asset-versions.js';

const references = { 'app.js': ['20261006-116'], 'styles.css': ['20261006-115'] };
const hashes = { 'app.js': sha256('code v1'), 'styles.css': sha256('css v1') };
const lock = { 'app.js': { version: '20261006-116', sha256: hashes['app.js'] }, 'styles.css': { version: '20261006-115', sha256: hashes['styles.css'] } };

test('references are found in the page and in scripts, grouped by file', () => {
  const found = scanAssetReferences({
    'index.html': '<script type="module" src="/app.js?v=20261006-116"></script><link rel="stylesheet" href="/styles.css?v=20261006-115">',
    'app.js': "import x from '/connection-issue.js?v=20261006-115'; const y = '/styles.css?v=20261006-115'; fetch('/api/v1/health?v=1')"
  });
  assert.deepEqual(found, { 'app.js': ['20261006-116'], 'connection-issue.js': ['20261006-115'], 'styles.css': ['20261006-115'] });
});

test('nothing is wrong when every file matches the version it was recorded under', () => {
  assert.deepEqual(assetVersionProblems({ references, hashes, lock }), []);
});

test('a file that changed but kept its version is reported: browsers would keep serving the old copy', () => {
  const problems = assetVersionProblems({ references, hashes: { ...hashes, 'app.js': sha256('code v2') }, lock });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /app\.js changed but is still version 20261006-116/);
});

test('bumping the version fixes it once the new version is recorded, and not before', () => {
  const bumped = { ...references, 'app.js': ['20261006-117'] }, changed = { ...hashes, 'app.js': sha256('code v2') };
  assert.match(assetVersionProblems({ references: bumped, hashes: changed, lock })[0], /referenced as version 20261006-117 but the lock records 20261006-116/);
  const recorded = { ...lock, 'app.js': { version: '20261006-117', sha256: changed['app.js'] } };
  assert.deepEqual(assetVersionProblems({ references: bumped, hashes: changed, lock: recorded }), []);
});

test('inconsistent versions, a missing file, an unrecorded file and a stale lock entry are all reported', () => {
  assert.match(assetVersionProblems({ references: { 'app.js': ['1', '2'] }, hashes, lock })[0], /different versions \(1, 2\)/);
  assert.match(assetVersionProblems({ references: { 'gone.js': ['1'] }, hashes, lock: {} })[0], /file does not exist/);
  assert.match(assetVersionProblems({ references, hashes, lock: {} })[0], /not recorded in asset-versions\.lock\.json/);
  assert.match(assetVersionProblems({ references: { 'app.js': references['app.js'] }, hashes, lock })[0], /styles\.css is in the lock but no longer has a versioned reference/);
});

// The repository itself: this is what catches a changed script that kept its ?v= number.
const webDir = new URL('../../../apps/web/', import.meta.url);
test('every versioned file in apps/web matches the version recorded for it', () => {
  const sources = Object.fromEntries(readdirSync(webDir).filter(name => /\.(js|html)$/.test(name)).map(name => [name, readFileSync(new URL(name, webDir), 'utf8')]));
  const found = scanAssetReferences(sources);
  assert.ok(Object.keys(found).length >= 6, 'the scan found the versioned files');
  const actual = Object.fromEntries(Object.keys(found).map(file => [file, sha256(readFileSync(new URL(file, webDir)))]));
  const recorded = JSON.parse(readFileSync(new URL('asset-versions.lock.json', webDir), 'utf8'));
  assert.deepEqual(assetVersionProblems({ references: found, hashes: actual, lock: recorded }), []);
});

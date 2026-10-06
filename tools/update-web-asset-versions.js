import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { scanAssetReferences, sha256 } from '../modules/platform/src/web-asset-versions.js';

// Records the hash of every versioned web file next to its version (apps/web/asset-versions.lock.json). It refuses to record a changed
// file under an unchanged version: bump the ?v= number first, everywhere the file is referenced.
const webDir = new URL('../apps/web/', import.meta.url), lockPath = new URL('asset-versions.lock.json', webDir);
const names = (await readdir(webDir)).filter(name => /\.(js|html)$/.test(name));
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(name, webDir), 'utf8')])));
const references = scanAssetReferences(sources), lock = existsSync(lockPath) ? JSON.parse(await readFile(lockPath, 'utf8')) : {}, next = {}, refused = [];
for (const [file, versions] of Object.entries(references)) {
  if (versions.length > 1) { refused.push(`${file} is referenced with different versions (${versions.join(', ')}); use one`); continue; }
  if (!existsSync(new URL(file, webDir))) { refused.push(`${file} has a version but the file does not exist`); continue; }
  const hash = sha256(await readFile(new URL(file, webDir))), [version] = versions;
  if (lock[file]?.version === version && lock[file].sha256 !== hash) refused.push(`${file} changed but is still version ${version}; bump its ?v= number first`);
  else next[file] = { version, sha256: hash };
}
if (refused.length) { console.error(refused.join('\n')); process.exitCode = 1; }
else { await writeFile(lockPath, JSON.stringify(next, null, 2) + '\n'); console.log(JSON.stringify({ status: 'recorded', files: Object.fromEntries(Object.entries(next).map(([file, { version }]) => [file, version])) })); }

// Copies the evidence of every release on the host to the owner’s machine and records it in a hash-chained ledger (modules/platform/src/evidence-ledger.js).
// The heavy payloads (the image archive, the agent executable) are not evidence and are not copied; everything else in a release directory is: the manifest, the
// checksum list, the SBOMs, the signed attestation bundles, the scan reports, the release notes and the release archive the attestations cover.
import { mkdir, readdir, readFile, rename, writeFile, appendFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeEntry, parseLedger, serialiseEntry, verifyChain, verifyFiles, hashBytes } from './evidence-ledger.js';
import { makeWritable, removeSet } from './backup-pull.js';
import { sshArguments, sshCommand } from './backup-config.js';

export const RELEASE_DIRECTORY = /^Nuvrion-v(\d+)\.(\d+)\.(\d+)$/;
export const NOT_EVIDENCE = ['Nuvrion-Image-*.tar', 'nuvrion-workstation-agent-*.exe'];
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const byVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

// "<sha256>  <name>" lines of SHA256SUMS.txt
export function parseChecksumList(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) { const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()); if (match) map.set(match[2], match[1]); }
  return map;
}

export async function listRemoteReleases(config, run) {
  const result = await run('ssh', [...sshArguments(config), `${config.user}@${config.host}`, `ls -1 ${config.remoteReleases}`]);
  if (result.code !== 0) throw new Error(`could not list the releases on ${config.host}: ${String(result.stderr).trim().slice(0, 300)}`);
  return result.stdout.split('\n').map(line => RELEASE_DIRECTORY.exec(line.trim())).filter(Boolean).map(match => ({ directory: match[0], version: `${match[1]}.${match[2]}.${match[3]}` }))
    .sort((a, b) => byVersion(a.version, b.version));
}

export async function readLedger(root) {
  try { return parseLedger(await readFile(join(root, 'LEDGER.jsonl'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// platformCommands: how to make files immutable (macOS: chflags). Injected; a no-op elsewhere.
export async function archiveEvidence({ config, run, now = new Date(), protect = async () => {} }) {
  const root = join(config.destination, 'evidence'), pending = join(root, '.incoming');
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const ledgerPath = join(root, 'LEDGER.jsonl');
  const summary = { archived: [], skipped: [], refused: [], error: null, head: null, entries: 0 };
  try {
    let entries = await readLedger(root);
    const chainProblems = verifyChain(entries);
    if (chainProblems.length) throw new Error(`the ledger is damaged, nothing was added: ${chainProblems[0]}`);
    const known = new Set(entries.map(entry => entry.version));
    for (const { directory, version } of await listRemoteReleases(config, run)) {
      if (known.has(version)) continue;
      const target = join(pending, `v${version}`);
      await removeSet(target);
      const fetched = await run('rsync', ['-a', '--partial', '--exclude=*/', ...NOT_EVIDENCE.map(pattern => `--exclude=${pattern}`), '-e', sshCommand(config),
        `${config.user}@${config.host}:${config.remoteReleases}/${directory}/`, `${target}/`]);
      if (fetched.code !== 0) { summary.error = `rsync of ${directory} failed: ${String(fetched.stderr).trim().slice(0, 300)}`; await removeSet(target); continue; }
      const names = (await readdir(target)).filter(name => FILE_NAME.test(name)).sort();
      if (!names.includes('release-manifest.json')) { summary.skipped.push({ version, reason: 'no release-manifest.json' }); await removeSet(target); continue; }
      const sums = names.includes('SHA256SUMS.txt') ? parseChecksumList(await readFile(join(target, 'SHA256SUMS.txt'), 'utf8')) : new Map();
      const files = [], mismatches = [];
      for (const name of names) {
        const bytes = await readFile(join(target, name)), digest = hashBytes(bytes);
        if (sums.has(name) && sums.get(name) !== digest) mismatches.push(name);
        files.push({ name, sizeBytes: bytes.length, sha256: digest, inChecksumList: sums.has(name) });
      }
      if (mismatches.length) { summary.refused.push({ version, reason: `does not match SHA256SUMS.txt: ${mismatches.join(', ')}` }); await removeSet(target); continue; }
      const entry = makeEntry(entries.at(-1) ?? null, { version, collectedAt: now.toISOString(), files });
      await rename(target, join(root, `v${version}`));
      for (const name of names) await chmod(join(root, `v${version}`, name), 0o400);
      await chmod(join(root, `v${version}`), 0o500);
      await protect(join(root, `v${version}`));
      await appendFile(ledgerPath, serialiseEntry(entry), { mode: 0o600 });
      await protect(ledgerPath, { appendOnly: true });
      entries = [...entries, entry];
      known.add(version);
      summary.archived.push(version);
    }
    summary.entries = entries.length;
    summary.head = entries.at(-1)?.hash ?? null;
  } catch (error) { summary.error = error.message; }
  await writeFile(join(root, 'status.json'), `${JSON.stringify({ checkedAt: now.toISOString(), ...summary }, null, 2)}\n`).catch(() => {});
  return summary;
}

// Everything that is wrong with the archive on disk: the chain, and every recorded file.
export async function verifyArchive(destination) {
  const root = join(destination, 'evidence'), entries = await readLedger(root);
  const problems = [...verifyChain(entries), ...(await verifyFiles(root, entries))];
  return { entries: entries.length, head: entries.at(-1)?.hash ?? null, problems };
}
export { makeWritable, stat };

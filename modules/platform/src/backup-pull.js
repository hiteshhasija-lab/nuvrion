// Pulls the backup sets of the host to the owner’s machine, checks each one, files the good ones, quarantines the bad ones and applies the retention policy.
// `run(command, args)` runs a program and resolves { code, stdout, stderr }; it is injected so the whole flow can be tested without a network.
import { mkdir, readdir, rename, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkBackupSet, retentionPlan, ageHours, SET_NAME } from './backup-set.js';
import { sshArguments, sshCommand } from './backup-config.js';

// what is fetched from a set: never the plain nuvrion.dump the host keeps for its own fast restores
export const PULLED_FILES = ['manifest.json', 'manifest.sig', 'COMPLETE', 'nuvrion.dump.cms', 'nuvrion-config.tar.cms'];

const exists = async path => { try { await stat(path); return true; } catch { return false; } };
export async function makeWritable(path) {
  let entries = [];
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  await chmod(path, 0o700);
  for (const entry of entries) { const child = join(path, entry.name); if (entry.isDirectory()) await makeWritable(child); else await chmod(child, 0o600).catch(() => {}); }
}
export async function removeSet(path) { await makeWritable(path); await rm(path, { recursive: true, force: true }); }

export async function listRemoteSets(config, run) {
  const remote = `cd ${config.remoteBackupRoot} && for d in [0-9]*T[0-9]*Z; do if [ -f "$d/COMPLETE" ]; then echo "$d"; fi; done`;
  const result = await run('ssh', [...sshArguments(config), `${config.user}@${config.host}`, remote]);
  if (result.code !== 0) throw new Error(`could not list the backups on ${config.host}: ${String(result.stderr).trim().slice(0, 300)}`);
  return result.stdout.split('\n').map(line => line.trim()).filter(name => SET_NAME.test(name)).sort().reverse();
}

export async function pullBackups({ config, run, publicKeyPem, now = new Date() }) {
  const base = join(config.destination, 'NOVAAPP01'), sets = join(base, 'sets'), incoming = join(base, 'incoming'), quarantine = join(base, 'quarantine');
  for (const dir of [sets, incoming, quarantine]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const summary = { checkedAt: now.toISOString(), pulled: [], quarantined: [], removed: [], error: null, newestSet: null, ageHours: null, setsKept: 0 };

  try {
    const remote = await listRemoteSets(config, run);
    const local = new Set((await readdir(sets)).filter(name => SET_NAME.test(name)));
    const wanted = retentionPlan(remote, config.retention).keep.filter(name => !local.has(name));
    for (const name of wanted) {
      const target = join(incoming, name);
      await removeSet(target);
      const fetched = await run('rsync', ['-a', '--partial', '-e', sshCommand(config), ...PULLED_FILES.map(file => `--include=${file}`), '--exclude=*',
        `${config.user}@${config.host}:${config.remoteBackupRoot}/${name}/`, `${target}/`]);
      if (fetched.code !== 0) { summary.error = `rsync of ${name} failed: ${String(fetched.stderr).trim().slice(0, 300)}`; await removeSet(target); continue; }
      const problems = await checkBackupSet(target, { publicKeyPem, name });
      if (problems.length) {
        const held = join(quarantine, `${name}-${now.toISOString().replace(/[:.]/g, '')}`);
        await rename(target, held);
        await writeFile(join(held, 'problems.json'), JSON.stringify(problems, null, 2));
        summary.quarantined.push({ name, problems: problems.map(problem => problem.code) });
        continue;
      }
      await rename(target, join(sets, name));
      await makeReadOnly(join(sets, name));
      summary.pulled.push(name);
    }
  } catch (error) { summary.error = error.message; }

  // retention over what is held locally (verified sets only: incoming and quarantine are separate)
  const held = (await readdir(sets)).filter(name => SET_NAME.test(name));
  const plan = retentionPlan(held, config.retention);
  for (const name of plan.remove) { await removeSet(join(sets, name)); summary.removed.push(name); }
  summary.setsKept = plan.keep.length;
  summary.newestSet = plan.keep[0] ?? null;
  summary.ageHours = summary.newestSet ? Math.round(ageHours(summary.newestSet, now) * 10) / 10 : null;
  summary.stale = summary.newestSet === null || summary.ageHours > config.maxAgeHours;
  await writeFile(join(base, 'status.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function makeReadOnly(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) await chmod(join(path, entry.name), 0o400);
  await chmod(path, 0o500);
}
export { exists };

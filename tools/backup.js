// The owner’s side of Nuvrion’s backups and release-evidence archive (docs/backups.md).
//
//   node tools/backup.js init --host H --user U --identity FILE [--destination DIR]   one-time: create the recovery key and certificate and the configuration
//   node tools/backup.js host-key FILE        store the signing public key that `backup-nuvrion.sh --init` printed on the host
//   node tools/backup.js pull                 pull new backup sets and new release evidence, check them, apply the retention policy (what the schedule runs)
//   node tools/backup.js verify               check every held set and the whole evidence archive; non-zero if anything is wrong or the newest set is too old
//   node tools/backup.js decrypt SET|latest OUTDIR   decrypt a set with the recovery key and check it against its manifest
//   node tools/backup.js status               what the last pull did
//   node tools/backup.js schedule install|remove   run `pull` every hour on this Mac (a launchd agent in ~/Library/LaunchAgents)
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../modules/platform/src/backup-config.js';
import { launchAgentPlist, LAUNCH_LABEL } from '../modules/platform/src/backup-schedule.js';
import { pullBackups } from '../modules/platform/src/backup-pull.js';
import { archiveEvidence, verifyArchive } from '../modules/platform/src/evidence-archive.js';
import { checkBackupSet, ageHours, sha256, SET_NAME } from '../modules/platform/src/backup-set.js';

const openssl = process.env.NUVRION_OPENSSL ?? 'openssl';
const configDirectory = dirname(DEFAULT_CONFIG_PATH);

function run(command, args, { input } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.once('error', error => resolve({ code: 127, stdout: '', stderr: error.message }));
    child.once('close', code => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), buffer: Buffer.concat(out) }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// macOS: the user-immutable flag on a release folder, the user-append-only flag on the ledger. Other systems get the read-only permissions only.
async function protect(path, { appendOnly = false } = {}) {
  if (process.platform !== 'darwin') return;
  const result = await run('chflags', appendOnly ? ['uappnd', path] : ['-R', 'uchg', path]);
  if (result.code !== 0) console.error(`could not protect ${path}: ${result.stderr.trim()}`);
}

function option(args, name) { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; }

async function init(args) {
  const host = option(args, 'host'), user = option(args, 'user'), identityFile = option(args, 'identity') ?? '~/.ssh/id_ed25519';
  const destination = option(args, 'destination') ?? join(process.cwd(), 'Backup');
  if (!host || !user) throw new Error('usage: backup.js init --host HOST --user USER [--identity KEYFILE] [--destination DIR]');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const key = join(configDirectory, 'recovery-key.pem'), certificate = join(configDirectory, 'recovery-cert.pem');
  if (existsSync(key)) throw new Error(`${key} already exists; it is the only key that can read your backups, so it is not replaced`);
  const made = await run(openssl, ['req', '-x509', '-newkey', 'rsa:4096', '-nodes', '-keyout', key, '-out', certificate, '-days', '7300', '-subj', '/CN=nuvrion-backup-recovery']);
  if (made.code !== 0) throw new Error(`openssl could not create the recovery key: ${made.stderr.trim()}`);
  await chmod(key, 0o600);
  await writeFile(DEFAULT_CONFIG_PATH, `${JSON.stringify({ host, user, identityFile, destination }, null, 2)}\n`, { mode: 0o600 });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  console.log(`Created ${key} (the recovery PRIVATE key), ${certificate} and ${DEFAULT_CONFIG_PATH}.`);
  console.log('\nBefore anything else, make a copy of the recovery private key that is NOT on this computer and NOT in iCloud (a password manager’s secure note, or a printed copy');
  console.log('in a safe). It is the only way to read a backup or recover the platform’s encryption keys; if this computer is lost, the backups are useless without it.');
  console.log(`\nNext, on the host:  backup-nuvrion.sh --init <${certificate} copied to the host>   then:  node tools/backup.js host-key <the public key it printed, saved to a file>`);
}

async function hostKey(args) {
  const file = args[0];
  if (!file) throw new Error('usage: backup.js host-key FILE');
  const pem = await readFile(file, 'utf8');
  if (!/^-----BEGIN PUBLIC KEY-----/m.test(pem)) throw new Error('that file does not contain a PEM public key');
  const config = await loadConfig();
  await mkdir(dirname(config.signingPublicKeyFile), { recursive: true });
  await writeFile(config.signingPublicKeyFile, pem.slice(pem.indexOf('-----BEGIN PUBLIC KEY-----')), { mode: 0o644 });
  console.log(`Stored the host’s signing public key in ${config.signingPublicKeyFile}`);
}

async function pull() {
  const config = await loadConfig(), publicKeyPem = await readFile(config.signingPublicKeyFile, 'utf8');
  const backups = await pullBackups({ config, run, publicKeyPem });
  const evidence = await archiveEvidence({ config, run, protect: config.immutable === false ? async () => {} : protect });
  console.log(JSON.stringify({ backups, evidence }, null, 2));
  const problems = [backups.error, evidence.error, backups.stale ? `the newest backup is ${backups.ageHours ?? '?'} hours old` : null, ...backups.quarantined.map(q => `${q.name} was quarantined: ${q.problems.join(', ')}`), ...evidence.refused.map(r => `v${r.version}: ${r.reason}`)].filter(Boolean);
  if (problems.length) { console.error(`\nNeeds attention:\n- ${problems.join('\n- ')}`); process.exitCode = 1; }
}

async function verify() {
  const config = await loadConfig(), publicKeyPem = await readFile(config.signingPublicKeyFile, 'utf8');
  const setsDirectory = join(config.destination, 'NOVAAPP01', 'sets');
  const names = existsSync(setsDirectory) ? (await readdir(setsDirectory)).filter(name => SET_NAME.test(name)).sort().reverse() : [];
  const problems = [];
  for (const name of names) for (const problem of await checkBackupSet(join(setsDirectory, name), { publicKeyPem, name })) problems.push(`${name}: ${problem.code} ${problem.message}`);
  const evidence = await verifyArchive(config.destination);
  problems.push(...evidence.problems.map(problem => `evidence ${problem}`));
  const age = names.length ? ageHours(names[0]) : null;
  if (age === null) problems.push('there is no backup set');
  else if (age > config.maxAgeHours) problems.push(`the newest backup (${names[0]}) is ${age.toFixed(1)} hours old; the limit is ${config.maxAgeHours}`);
  console.log(`${names.length} backup sets held${names.length ? `, the newest ${names[0]} (${age.toFixed(1)} hours old)` : ''}; ${evidence.entries} releases in the evidence archive${evidence.head ? `, head ${evidence.head}` : ''}`);
  if (problems.length) { console.error(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; } else console.log('All checks passed.');
}

async function decrypt(args) {
  const [which, outDirectory] = args;
  if (!which || !outDirectory) throw new Error('usage: backup.js decrypt SET|latest OUTDIR');
  const config = await loadConfig(), publicKeyPem = await readFile(config.signingPublicKeyFile, 'utf8');
  const setsDirectory = join(config.destination, 'NOVAAPP01', 'sets');
  const names = (await readdir(setsDirectory)).filter(name => SET_NAME.test(name)).sort().reverse();
  const name = which === 'latest' ? names[0] : which;
  if (!names.includes(name)) throw new Error(`no such set: ${which}`);
  const directory = join(setsDirectory, name);
  const problems = await checkBackupSet(directory, { publicKeyPem, name });
  if (problems.length) throw new Error(`${name} did not pass its checks, so it is not decrypted:\n- ${problems.map(p => p.message).join('\n- ')}`);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await mkdir(outDirectory, { recursive: true, mode: 0o700 });
  for (const [encrypted, plain] of [['nuvrion.dump.cms', 'nuvrion.dump'], ['nuvrion-config.tar.cms', 'nuvrion-config.tar']]) {
    const result = await run(openssl, ['smime', '-decrypt', '-binary', '-inform', 'DER', '-in', join(directory, encrypted), '-inkey', config.recoveryKeyFile]);
    if (result.code !== 0) throw new Error(`could not decrypt ${encrypted} with ${config.recoveryKeyFile}: ${result.stderr.trim()}`);
    const expected = manifest.files.find(file => file.name === encrypted).plaintextSha256;
    if (sha256(result.buffer) !== expected) throw new Error(`${plain} decrypted, but does not match the SHA-256 the host recorded`);
    await writeFile(join(outDirectory, plain), result.buffer, { mode: 0o600 });
  }
  await mkdir(join(outDirectory, 'config'), { recursive: true, mode: 0o700 });
  const untar = await run('tar', ['-xf', join(outDirectory, 'nuvrion-config.tar'), '-C', join(outDirectory, 'config')]);
  if (untar.code !== 0) throw new Error(`could not unpack the configuration: ${untar.stderr.trim()}`);
  console.log(`${name} decrypted and checked into ${outDirectory}: nuvrion.dump, nuvrion-config.tar and its unpacked config/. They are in the clear and contain secrets: delete them when the restore is done.`);
  console.log('Restore steps: docs/restore-guide.md');
}

async function status() {
  const config = await loadConfig();
  for (const file of [join(config.destination, 'NOVAAPP01', 'status.json'), join(config.destination, 'evidence', 'status.json')]) {
    console.log(`${file}\n${existsSync(file) ? await readFile(file, 'utf8') : '(none yet)'}`);
  }
}

async function schedule(args) {
  const agents = join(process.env.HOME, 'Library', 'LaunchAgents'), plistPath = join(agents, `${LAUNCH_LABEL}.plist`), domain = `gui/${process.getuid()}`;
  if (args[0] === 'remove') {
    await run('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`]);
    await rm(plistPath, { force: true });
    console.log('The hourly pull is removed.'); return;
  }
  if (args[0] !== 'install') throw new Error('usage: backup.js schedule install|remove');
  await loadConfig();   // refuse to schedule something that cannot run
  const log = join(process.env.HOME, 'Library', 'Logs', 'nuvrion-backup.log');
  await mkdir(agents, { recursive: true }); await mkdir(dirname(log), { recursive: true });
  const repository = join(dirname(new URL(import.meta.url).pathname), '..');
  await writeFile(plistPath, launchAgentPlist({ node: process.execPath, script: join(repository, 'tools', 'backup.js'), workingDirectory: repository,
    path: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), log }));
  await run('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`]);
  const loaded = await run('launchctl', ['bootstrap', domain, plistPath]);
  if (loaded.code !== 0) throw new Error(`launchctl could not load the job: ${loaded.stderr.trim()}`);
  console.log(`Scheduled: ${plistPath} runs \`backup.js pull\` every hour and at login; its output goes to ${log}.`);
  console.log('If the log shows "operation not permitted" for the Backup folder, give node access in System Settings → Privacy & Security → Files and Folders (Desktop Folder) or Full Disk Access.');
}

const commands = { init, 'host-key': hostKey, pull, verify, decrypt, status, schedule };
const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) { console.error('usage: node tools/backup.js <init|host-key|pull|verify|decrypt|status|schedule> …  (see the header of this file)'); process.exit(2); }
try { await commands[command](rest); } catch (error) { console.error(`backup: ${error.message}`); process.exitCode = 1; }

'use strict';
// Platform-driven upgrade of the Workstation agent.
//
// The platform stages a deployment for an agent (a signed manifest naming the new executable, its size and its SHA-256). This module is
// what makes the agent act on it. It is deliberately conservative: every step fails closed, nothing is replaced until the new executable
// has been verified and has run its own self-check, and the previous executable is kept so that an agent that does not come up healthy
// is rolled back by a watchdog that runs from that previous executable.
//
//   poll -> verify the signed manifest against the key pinned in bootstrap.json -> refuse anything that is not a newer version
//        -> download (size capped, SHA-256 checked) -> `new.exe --self-check` -> swap (old kept as .old) -> report "ready"
//        -> exit; the watchdog (`.old --upgrade-watchdog`) starts the new agent and waits for it to write the health flag
//        -> the new agent writes the flag after its first successful heartbeat and reports "installed"
//        -> no flag within the deadline: the watchdog restores the old executable and the old agent reports "rolled_back".
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFile, spawn } = require('node:child_process');

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const HEALTH_DEADLINE_MS = 180000;
const MAX_UNREPORTED_ATTEMPTS = 60;
const STATE_FILE = 'upgrade-state.json';
const OK_FLAG_FILE = 'upgrade-ok.flag';
const ROLLED_BACK_FILE = 'upgrade-rolled-back.json';

class UpgradeError extends Error { constructor(code, message) { super(message); this.code = code; } }

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? ''));
  if (!match) throw new UpgradeError('NUV_AGENT_UPGRADE_VERSION_INVALID', `"${value}" is not a version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
// Compares major.minor.patch only; a suffix such as "-lab.1" is not part of the order, so a release must raise the patch number.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  return 0;
}

// The manifest is signed by the platform (Ed25519 over the manifest's JSON). The key that counts is the one pinned in bootstrap.json,
// never the one that arrives with the deployment.
// A key that was copied without its BEGIN/END lines, or whose line breaks were stored as the two characters \n, is still the same key.
function normalizePem(value, label = 'PUBLIC KEY') {
  let text = String(value ?? '').replace(/\\n/g, '\n').trim();
  if (text && !/-----BEGIN /.test(text)) {
    const body = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(body)) text = `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
  }
  return text;
}

function verifyRelease(release, publicKeyPem) {
  if (!publicKeyPem) throw new UpgradeError('NUV_AGENT_UPGRADE_KEY_NOT_PINNED', 'No upgrade signing key is pinned in bootstrap.json (upgradeTrustedPublicKey), so this agent will not install an upgrade.');
  const manifest = release?.manifest;
  if (!manifest || typeof manifest !== 'object' || typeof release.signature !== 'string') throw new UpgradeError('NUV_AGENT_UPGRADE_MANIFEST_INVALID', 'The upgrade release has no signed manifest.');
  let valid = false;
  const pinned = normalizePem(publicKeyPem);
  try { valid = crypto.verify(null, Buffer.from(JSON.stringify(manifest)), pinned, Buffer.from(release.signature, 'base64url')); } catch { valid = false; }
  if (!valid) throw new UpgradeError('NUV_AGENT_UPGRADE_SIGNATURE_INVALID', 'The upgrade manifest is not signed by the pinned key.');
  parseVersion(manifest.version);
  if (!/^https:\/\//.test(String(manifest.artifactUrl ?? ''))) throw new UpgradeError('NUV_AGENT_UPGRADE_URL_INVALID', 'The upgrade artifact URL is not HTTPS.');
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sha256 ?? ''))) throw new UpgradeError('NUV_AGENT_UPGRADE_DIGEST_INVALID', 'The upgrade checksum is not a SHA-256.');
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 || manifest.sizeBytes > MAX_ARTIFACT_BYTES) throw new UpgradeError('NUV_AGENT_UPGRADE_SIZE_INVALID', `The upgrade size must be between 1 and ${MAX_ARTIFACT_BYTES} bytes.`);
  return manifest;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } }
function removeQuietly(file) { try { fs.rmSync(file, { force: true }); return true; } catch { return false; } }

// Streams the artifact to `destination`, counting and hashing as it goes. The size limit is enforced while streaming, not after.
// Redirects are followed only to HTTPS and the agent's credential is sent only to the platform's own origin.
function download({ url, destination, expectedBytes, apiOrigin, ca, headers = {}, get = https.get, maxRedirects = 3, idleMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const attempt = (target, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(target); } catch { return reject(new UpgradeError('NUV_AGENT_UPGRADE_URL_INVALID', 'The upgrade artifact URL is not valid.')); }
      if (parsed.protocol !== 'https:') return reject(new UpgradeError('NUV_AGENT_UPGRADE_URL_INVALID', 'The upgrade artifact is not served over HTTPS.'));
      const samePlatform = parsed.origin === apiOrigin;
      const options = { headers: samePlatform ? { ...headers } : {}, ...(samePlatform && ca ? { ca } : {}), rejectUnauthorized: true };
      const request = get(parsed, options, response => {
        const status = response.statusCode;
        if ([301, 302, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new UpgradeError('NUV_AGENT_UPGRADE_DOWNLOAD_FAILED', 'The upgrade artifact redirected too many times.'));
          return attempt(new URL(response.headers.location, parsed).toString(), redirectsLeft - 1);
        }
        if (status !== 200) { response.resume(); return reject(new UpgradeError('NUV_AGENT_UPGRADE_DOWNLOAD_FAILED', `The upgrade artifact download returned HTTP ${status}.`)); }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared !== expectedBytes) { response.resume(); return reject(new UpgradeError('NUV_AGENT_UPGRADE_SIZE_MISMATCH', 'The upgrade artifact size does not match its signed manifest.')); }
        const hash = crypto.createHash('sha256'), out = fs.createWriteStream(destination, { mode: 0o700 });
        let bytes = 0, failed = false;
        // The file is removed only once the stream has closed: a stream that has not finished opening would otherwise create it after the removal.
        const fail = error => {
          if (failed) return;
          failed = true; response.destroy();
          const finish = () => { removeQuietly(destination); reject(error); };
          if (out.closed) finish(); else { out.once('close', finish); out.destroy(); }
        };
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > expectedBytes) return fail(new UpgradeError('NUV_AGENT_UPGRADE_SIZE_MISMATCH', 'The upgrade artifact is larger than its signed manifest says.'));
          hash.update(chunk); out.write(chunk);
        });
        response.on('error', error => fail(new UpgradeError('NUV_AGENT_UPGRADE_DOWNLOAD_FAILED', error.message)));
        response.on('end', () => {
          if (failed) return;
          out.end(() => resolve({ bytes, sha256: hash.digest('hex') }));
        });
      });
      request.setTimeout(idleMs, () => request.destroy(new Error('The upgrade artifact download stalled.')));
      request.on('error', error => reject(error instanceof UpgradeError ? error : new UpgradeError('NUV_AGENT_UPGRADE_DOWNLOAD_FAILED', error.message)));
    };
    attempt(url, maxRedirects);
  });
}

// The new executable must run, and say it is the version the signed manifest names, before anything is replaced.
function selfCheck(executable, expectedVersion, { run = execFile, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    run(executable, ['--self-check'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new UpgradeError('NUV_AGENT_UPGRADE_SELF_CHECK_FAILED', `The new agent did not pass its self-check: ${error.message}`));
      let result = null;
      try { result = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { result = null; }
      if (!result || result.ok !== true) return reject(new UpgradeError('NUV_AGENT_UPGRADE_SELF_CHECK_FAILED', 'The new agent did not report a successful self-check.'));
      if (result.version !== expectedVersion) return reject(new UpgradeError('NUV_AGENT_UPGRADE_SELF_CHECK_FAILED', `The new agent reports version ${result.version}, not ${expectedVersion}.`));
      resolve(result);
    });
  });
}

// Windows lets a running executable be renamed but not replaced, so the swap is two renames, and the first is undone if the second fails.
function swapExecutable({ executable, staged, backup }) {
  if (fs.existsSync(backup) && !removeQuietly(backup)) throw new UpgradeError('NUV_AGENT_UPGRADE_SWAP_FAILED', `The previous backup ${backup} could not be removed.`);
  try { fs.renameSync(executable, backup); } catch (error) { throw new UpgradeError('NUV_AGENT_UPGRADE_SWAP_FAILED', `The running agent could not be set aside: ${error.message}`); }
  try { fs.renameSync(staged, executable); } catch (error) {
    try { fs.renameSync(backup, executable); } catch { /* the original is still at `backup`; the message says so */ }
    throw new UpgradeError('NUV_AGENT_UPGRADE_SWAP_FAILED', `The new agent could not be put in place: ${error.message}`);
  }
}

function createUpgrader({ root, executable, currentVersion, config, api, log = () => {}, download: downloadFn = download, selfCheck: selfCheckFn = selfCheck,
  startWatchdog, exit = code => process.exit(code), now = () => Date.now(), healthDeadlineMs = HEALTH_DEADLINE_MS }) {
  const statePath = path.join(root, STATE_FILE), okFlagPath = path.join(root, OK_FLAG_FILE), rolledBackPath = path.join(root, ROLLED_BACK_FILE);
  const backup = `${executable}.old`, staged = `${executable}.new`, partial = `${executable}.part`;
  const base = () => `/api/v1/agents/${config.identity.agentId}/upgrades`;
  let busy = false;

  // A terminal result is never lost: if it cannot be reported now it is kept in the state file and sent on a later poll.
  async function report(deploymentId, status, detail = null, rollbackVersion = null) {
    const body = { status, ...(detail ? { detail: String(detail).slice(0, 500) } : {}), ...(rollbackVersion ? { rollbackVersion } : {}) };
    try { await api.post(`${base()}/${deploymentId}/report`, body); return true; } catch (error) {
      log('agent.upgrade.report_failed', { deploymentId, status, code: error.code, message: String(error.message).slice(0, 200) });
      return false;
    }
  }
  async function reportTerminal(deploymentId, status, detail, rollbackVersion = null) {
    if (await report(deploymentId, status, detail, rollbackVersion)) { removeQuietly(statePath); return true; }
    writeJsonAtomic(statePath, { phase: 'unreported', deploymentId, status, detail, rollbackVersion, at: new Date(now()).toISOString() });
    return false;
  }
  async function fail(deploymentId, error) {
    for (const file of [partial, staged]) removeQuietly(file);
    const code = error.code ?? 'NUV_AGENT_UPGRADE_FAILED';
    log('agent.upgrade.failed', { deploymentId, code, message: String(error.message).slice(0, 300) });
    await reportTerminal(deploymentId, 'failed', `${code}: ${error.message}`);
  }

  // Runs at start-up and on every poll: settles whatever an earlier run left behind.
  async function settle() {
    const rolledBack = readJson(rolledBackPath);
    if (rolledBack) {
      log('agent.upgrade.rolled_back', rolledBack);
      if (await report(rolledBack.deploymentId, 'rolled_back', rolledBack.reason, currentVersion)) { removeQuietly(rolledBackPath); removeQuietly(statePath); removeQuietly(okFlagPath); }
      return true;
    }
    const state = readJson(statePath);
    if (!state) return false;
    if (state.phase === 'unreported') {
      if (await report(state.deploymentId, state.status, state.detail, state.rollbackVersion)) { removeQuietly(statePath); return true; }
      // A platform that keeps refusing the report must not hold every later upgrade back for ever: after about an hour of polls the
      // result is given up on (logged, and the deployment is simply offered again), so the next poll looks at new work.
      const attempts = (state.attempts ?? 0) + 1;
      if (attempts >= MAX_UNREPORTED_ATTEMPTS) {
        log('agent.upgrade.report_abandoned', { deploymentId: state.deploymentId, status: state.status, attempts });
        removeQuietly(statePath);
        return false;
      }
      writeJsonAtomic(statePath, { ...state, attempts });
      return true;
    }
    if (state.phase === 'swapped') {
      if (currentVersion === state.toVersion) return true;   // the new agent: waiting for its first heartbeat (recordHealthy)
      // Running the old version while the state says the swap happened and no rollback was recorded: say so rather than leave it hanging.
      await reportTerminal(state.deploymentId, 'failed', `NUV_AGENT_UPGRADE_NOT_APPLIED: expected ${state.toVersion}, running ${currentVersion}`);
      return true;
    }
    return false;
  }

  // Called by the agent after its first successful heartbeat with the new version: this is the proof of health the watchdog waits for.
  async function recordHealthy() {
    const state = readJson(statePath);
    if (!state || state.phase !== 'swapped' || state.toVersion !== currentVersion) return false;
    fs.writeFileSync(okFlagPath, `${new Date(now()).toISOString()}\n`, { mode: 0o600 });
    log('agent.upgrade.healthy', { deploymentId: state.deploymentId, fromVersion: state.fromVersion, toVersion: state.toVersion });
    await reportTerminal(state.deploymentId, 'installed', `Upgraded from ${state.fromVersion} to ${state.toVersion}.`);
    return true;
  }

  async function apply(deployment) {
    const deploymentId = deployment.deploymentId;
    let manifest;
    try { manifest = verifyRelease(deployment.release, config.upgradeTrustedPublicKey); } catch (error) { return fail(deploymentId, error); }
    let order;
    try { order = compareVersions(manifest.version, currentVersion); } catch (error) { return fail(deploymentId, error); }
    if (manifest.version === currentVersion || order === 0) return reportTerminal(deploymentId, 'installed', `Already running ${currentVersion}.`);
    if (order < 0) return fail(deploymentId, new UpgradeError('NUV_AGENT_UPGRADE_NOT_NEWER', `${manifest.version} is not newer than the running ${currentVersion}; the agent does not downgrade.`));

    await report(deploymentId, 'downloading');
    let result;
    try {
      const origin = new URL(config.apiUrl).origin;
      const ca = config.caCertificatePath ? fs.readFileSync(config.caCertificatePath) : undefined;
      result = await downloadFn({ url: manifest.artifactUrl, destination: partial, expectedBytes: manifest.sizeBytes, apiOrigin: origin, ca, headers: { 'x-agent-id': config.identity.agentId, 'x-agent-secret': config.identity.secret } });
    } catch (error) { return fail(deploymentId, error); }
    if (result.bytes !== manifest.sizeBytes) return fail(deploymentId, new UpgradeError('NUV_AGENT_UPGRADE_SIZE_MISMATCH', 'The downloaded size does not match the signed manifest.'));
    if (result.sha256 !== manifest.sha256) return fail(deploymentId, new UpgradeError('NUV_AGENT_UPGRADE_CHECKSUM_MISMATCH', 'The downloaded file does not match the signed checksum.'));

    try {
      removeQuietly(staged);
      fs.renameSync(partial, staged);
      await selfCheckFn(staged, manifest.version);
      removeQuietly(okFlagPath);
      removeQuietly(rolledBackPath);
      swapExecutable({ executable, staged, backup });
    } catch (error) { return fail(deploymentId, error); }

    const state = { phase: 'swapped', deploymentId, fromVersion: currentVersion, toVersion: manifest.version, executable, backup, swappedAt: new Date(now()).toISOString(), healthDeadlineMs };
    writeJsonAtomic(statePath, state);
    await report(deploymentId, 'ready', `Verified ${manifest.version}; restarting.`);
    log('agent.upgrade.swapped', { deploymentId, fromVersion: currentVersion, toVersion: manifest.version });
    try { startWatchdog(state); } catch (error) {
      // The new executable is already in place and nothing will start it: put the old one back so the agent keeps running as it was.
      try { fs.renameSync(executable, `${executable}.failed`); fs.renameSync(backup, executable); } catch { /* best effort */ }
      removeQuietly(statePath);
      return fail(deploymentId, new UpgradeError('NUV_AGENT_UPGRADE_RESTART_FAILED', `The restart could not be arranged: ${error.message}`));
    }
    exit(0);
    return true;
  }

  // One poll. Never throws: an upgrade problem must not take the agent's other loops down.
  async function poll() {
    if (busy) return 'busy';
    busy = true;
    try {
      if (await settle()) return 'settling';
      const response = await api.get(base());
      const deployment = (response.items ?? [])[0];
      if (!deployment) return 'idle';
      await apply(deployment);
      return 'applied';
    } catch (error) {
      log('agent.upgrade.poll_failed', { code: error.code, message: String(error.message).slice(0, 200) });
      return 'error';
    } finally { busy = false; }
  }

  return { poll, recordHealthy, settle, apply };
}

// ---- the watchdog: runs from the previous executable (`<exe>.old --upgrade-watchdog <state file>`) ---------------------------------
async function runWatchdog({ statePath, parentPid, isAlive, startAgent, killAgent, sleep, now = () => Date.now(), log = () => {}, parentWaitMs = 60000 }) {
  const state = readJson(statePath);
  if (!state || state.phase !== 'swapped') { log('agent.upgrade.watchdog_idle', {}); return 'idle'; }
  const root = path.dirname(state.executable), okFlag = path.join(root, OK_FLAG_FILE), rolledBack = path.join(root, ROLLED_BACK_FILE);
  const parentDeadline = now() + parentWaitMs;
  while (parentPid && isAlive(parentPid) && now() < parentDeadline) await sleep(250);
  await startAgent();
  const deadline = now() + (state.healthDeadlineMs ?? HEALTH_DEADLINE_MS);
  while (now() < deadline) {
    if (fs.existsSync(okFlag)) { log('agent.upgrade.watchdog_healthy', { toVersion: state.toVersion }); return 'healthy'; }
    await sleep(2000);
  }
  // The new agent did not prove it was healthy: stop it, put the previous executable back and start that.
  await killAgent();
  await sleep(2000);
  let restored = true;
  try { fs.copyFileSync(state.executable, `${state.executable}.failed`); } catch { /* keep going: restoring matters more */ }
  try { fs.copyFileSync(state.backup, state.executable); } catch (error) { restored = false; log('agent.upgrade.restore_failed', { message: error.message }); }
  writeJsonAtomic(rolledBack, { deploymentId: state.deploymentId, fromVersion: state.fromVersion, toVersion: state.toVersion, restored, at: new Date(now()).toISOString(),
    reason: `The new agent ${state.toVersion} did not report healthy within ${Math.round((state.healthDeadlineMs ?? HEALTH_DEADLINE_MS) / 1000)} seconds.` });
  await startAgent();
  log('agent.upgrade.watchdog_rolled_back', { toVersion: state.toVersion, restored });
  return 'rolled_back';
}

// Real process control for the watchdog and for starting it; kept apart so the logic above is testable.
function windowsProcessControl({ executable, run = execFile, spawnProcess = spawn }) {
  const image = path.basename(executable);
  return {
    isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
    // Started directly, not through the scheduled task: the task is configured to ignore a new run while it is still "running", and
    // the old agent's launcher (and this watchdog, a child of the old agent) can keep it in that state, which would swallow the
    // start and end in a pointless rollback. The watchdog runs in the user's interactive session, so the child does too, and the
    // agent's single-instance guard makes a concurrent start by the task harmless.
    startAgent: () => new Promise(resolve => {
      try { spawnProcess(executable, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* nothing more can be done from here */ }
      resolve();
    }),
    killAgent: () => new Promise(resolve => run('taskkill', ['/F', '/IM', image], { windowsHide: true }, () => resolve())),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}
function launchWatchdog(state, { spawnProcess = spawn, parentPid = process.pid } = {}) {
  const child = spawnProcess(state.backup, ['--upgrade-watchdog', path.join(path.dirname(state.executable), STATE_FILE), String(parentPid)],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

module.exports = { UpgradeError, MAX_ARTIFACT_BYTES, HEALTH_DEADLINE_MS, STATE_FILE, OK_FLAG_FILE, ROLLED_BACK_FILE, MAX_UNREPORTED_ATTEMPTS, compareVersions, normalizePem, verifyRelease, download, selfCheck,
  swapExecutable, createUpgrader, runWatchdog, windowsProcessControl, launchWatchdog };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const U = require('../src/self-upgrade.cjs');

const NEW_BYTES = Buffer.from('NEW-AGENT-BYTES-0.1.50');
const NEW_SHA = createHash('sha256').update(NEW_BYTES).digest('hex');
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const keypair = () => { const pair = generateKeyPairSync('ed25519'); return { pub: pair.publicKey.export({ type: 'spki', format: 'pem' }), priv: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
const signedRelease = (key, over = {}) => {
  const manifest = { releaseId: 'rel-1', version: '0.1.50-lab.1', artifactUrl: 'https://platform.test/api/v1/agent-upgrades/artifacts/' + NEW_SHA, sha256: NEW_SHA, sizeBytes: NEW_BYTES.length, signingKeyId: 'abcd', createdAt: '2026-10-14T00:00:00.000Z', ...over };
  return { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), key.priv).toString('base64url') };
};

function setup(t, { currentVersion = '0.1.49-lab.1', pinned = true, key = keypair(), downloadResult, selfCheckError = null, watchdogError = null, apiGetError = null, reportError = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvrion-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'nuvrion-workstation-agent.exe');
  fs.writeFileSync(executable, 'OLD-AGENT-BYTES');
  const reports = [], logs = [], watchdogs = [], exits = [];
  const state = { items: [], reportFails: reportError };
  const api = {
    get: async p => { if (apiGetError) throw apiGetError; return { items: state.items }; },
    post: async (p, body) => { if (state.reportFails && state.reportFails(body)) throw Object.assign(new Error('network down'), { code: 'ECONNRESET' }); reports.push({ path: p, ...body }); return {}; },
  };
  const download = async ({ destination, expectedBytes, headers }) => {
    if (downloadResult instanceof Error) throw downloadResult;
    const bytes = downloadResult?.bytesOverride ?? NEW_BYTES;
    fs.writeFileSync(destination, bytes);
    return { bytes: downloadResult?.reportedBytes ?? bytes.length, sha256: downloadResult?.sha256 ?? createHash('sha256').update(bytes).digest('hex'), sawHeaders: headers };
  };
  const selfCheck = async (file, version) => {
    if (selfCheckError) throw selfCheckError;
    assert.equal(fs.readFileSync(file, 'utf8'), NEW_BYTES.toString(), 'the self-check must run on the downloaded file');
    return { ok: true, version };
  };
  const config = { apiUrl: 'https://platform.test', identity: { agentId: AGENT_ID, secret: 'agent-secret' /* secret-scan:allow (fake test credential) */ }, ...(pinned ? { upgradeTrustedPublicKey: key.pub } : {}) };
  const upgrader = U.createUpgrader({ root, executable, currentVersion, config, api, log: (event, detail) => logs.push({ event, ...detail }), download, selfCheck,
    startWatchdog: s => { if (watchdogError) throw watchdogError; watchdogs.push(s); }, exit: code => exits.push(code), now: () => Date.parse('2026-10-14T01:00:00Z') });
  const deploy = (release, id = 'dep-1') => { state.items = [{ deploymentId: id, agentId: AGENT_ID, releaseId: release.manifest.releaseId, status: 'staged', release }]; return id; };
  return { root, executable, reports, logs, watchdogs, exits, upgrader, key, deploy, state, files: () => fs.readdirSync(root).sort(), read: f => fs.readFileSync(path.join(root, f), 'utf8') };
}
const lastReport = ctx => ctx.reports[ctx.reports.length - 1];

// ---- versions -------------------------------------------------------------------------------------------------------------------
test('versions are compared on major.minor.patch and a suffix such as -lab.1 is ignored', () => {
  assert.equal(U.compareVersions('0.1.50-lab.1', '0.1.49-lab.1'), 1);
  assert.equal(U.compareVersions('0.1.49-lab.1', '0.1.50'), -1);
  assert.equal(U.compareVersions('0.1.49-lab.2', '0.1.49-lab.1'), 0);
  assert.equal(U.compareVersions('0.2.0', '0.1.99'), 1);
  assert.equal(U.compareVersions('1.0.0', '0.99.99'), 1);
  for (const bad of ['', 'abc', '0.1', null, undefined]) assert.throws(() => U.compareVersions(bad, '0.1.1'), e => e.code === 'NUV_AGENT_UPGRADE_VERSION_INVALID');
});

// ---- the signed manifest --------------------------------------------------------------------------------------------------------
test('a release signed by the pinned key is accepted', () => {
  const key = keypair();
  assert.equal(U.verifyRelease(signedRelease(key), key.pub).version, '0.1.50-lab.1');
});

test('a release is refused when no key is pinned, whatever the platform says', () => {
  assert.throws(() => U.verifyRelease(signedRelease(keypair()), null), e => e.code === 'NUV_AGENT_UPGRADE_KEY_NOT_PINNED');
  assert.throws(() => U.verifyRelease(signedRelease(keypair()), ''), e => e.code === 'NUV_AGENT_UPGRADE_KEY_NOT_PINNED');
});

test('a release signed by a different key, or altered after signing, is refused', () => {
  const real = keypair(), attacker = keypair();
  assert.throws(() => U.verifyRelease(signedRelease(attacker), real.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
  const tampered = signedRelease(real); tampered.manifest.sha256 = 'f'.repeat(64);
  assert.throws(() => U.verifyRelease(tampered, real.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
  const resized = signedRelease(real); resized.manifest.artifactUrl = 'https://evil.test/agent.exe';
  assert.throws(() => U.verifyRelease(resized, real.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
  assert.throws(() => U.verifyRelease({ manifest: signedRelease(real).manifest, signature: 'not-a-signature' }, real.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
});

test('a pinned key whose line breaks were stored as \\n escapes is still the same key; a different key is still refused', () => {
  const key = keypair(), attacker = keypair();
  const escaped = key.pub.trim().replace(/\r?\n/g, '\\n');
  assert.ok(!escaped.includes('\n') && escaped.includes('\\n'));
  assert.equal(U.verifyRelease(signedRelease(key), escaped).version, '0.1.50-lab.1');
  assert.equal(U.verifyRelease(signedRelease(key), key.pub.replace(/\n/g, '\r\n')).version, '0.1.50-lab.1', 'CRLF line breaks (a Windows here-string) are fine too');
  assert.throws(() => U.verifyRelease(signedRelease(attacker), escaped), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
});

test('a pinned key copied without its BEGIN and END lines is read as the same key', () => {
  const key = keypair(), attacker = keypair();
  const bare = key.pub.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  assert.ok(!bare.includes('-'));
  assert.equal(U.verifyRelease(signedRelease(key), bare).version, '0.1.50-lab.1');
  assert.equal(U.verifyRelease(signedRelease(key), `  ${bare}\r\n`).version, '0.1.50-lab.1');
  assert.throws(() => U.verifyRelease(signedRelease(attacker), bare), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
  assert.throws(() => U.verifyRelease(signedRelease(key), 'not a key at all !!'), e => e.code === 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID');
});

test('a correctly signed release with unusable fields is still refused', () => {
  const key = keypair();
  assert.throws(() => U.verifyRelease(signedRelease(key, { artifactUrl: 'http://platform.test/a.exe' }), key.pub), e => e.code === 'NUV_AGENT_UPGRADE_URL_INVALID');
  assert.throws(() => U.verifyRelease(signedRelease(key, { sha256: 'xyz' }), key.pub), e => e.code === 'NUV_AGENT_UPGRADE_DIGEST_INVALID');
  assert.throws(() => U.verifyRelease(signedRelease(key, { sizeBytes: U.MAX_ARTIFACT_BYTES + 1 }), key.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIZE_INVALID');
  assert.throws(() => U.verifyRelease(signedRelease(key, { sizeBytes: 0 }), key.pub), e => e.code === 'NUV_AGENT_UPGRADE_SIZE_INVALID');
  assert.throws(() => U.verifyRelease(signedRelease(key, { version: 'latest' }), key.pub), e => e.code === 'NUV_AGENT_UPGRADE_VERSION_INVALID');
  assert.throws(() => U.verifyRelease({}, key.pub), e => e.code === 'NUV_AGENT_UPGRADE_MANIFEST_INVALID');
});

// ---- the happy path -------------------------------------------------------------------------------------------------------------
test('a verified newer release is downloaded, checked, swapped in, reported ready, and the old executable is kept', async t => {
  const ctx = setup(t);
  ctx.deploy(signedRelease(ctx.key));
  assert.equal(await ctx.upgrader.poll(), 'applied');
  assert.deepEqual(ctx.reports.map(r => r.status), ['downloading', 'ready']);
  assert.equal(ctx.read('nuvrion-workstation-agent.exe'), NEW_BYTES.toString(), 'the new executable is in place');
  assert.equal(ctx.read('nuvrion-workstation-agent.exe.old'), 'OLD-AGENT-BYTES', 'the previous executable is kept for the watchdog');
  const state = JSON.parse(ctx.read('upgrade-state.json'));
  assert.equal(state.phase, 'swapped'); assert.equal(state.fromVersion, '0.1.49-lab.1'); assert.equal(state.toVersion, '0.1.50-lab.1');
  assert.equal(ctx.watchdogs.length, 1, 'the watchdog is launched exactly once');
  assert.deepEqual(ctx.exits, [0], 'the agent exits so the new one can start');
  assert.ok(!ctx.files().some(f => f.endsWith('.part') || f.endsWith('.new')), 'no partial or staged file is left');
});

test('the artifact is requested with the agent credential', async t => {
  const ctx = setup(t);
  let seen = null;
  const upgrader = U.createUpgrader({ root: ctx.root, executable: ctx.executable, currentVersion: '0.1.49-lab.1',
    config: { apiUrl: 'https://platform.test', identity: { agentId: AGENT_ID, secret: 'agent-secret' /* secret-scan:allow (fake test credential) */ }, upgradeTrustedPublicKey: ctx.key.pub },
    api: { get: async () => ({ items: [] }), post: async () => ({}) },
    download: async args => { seen = args; fs.writeFileSync(args.destination, NEW_BYTES); return { bytes: NEW_BYTES.length, sha256: NEW_SHA }; },
    selfCheck: async () => ({ ok: true }), startWatchdog() {}, exit() {} });
  await upgrader.apply({ deploymentId: 'dep-9', release: signedRelease(ctx.key) });
  assert.equal(seen.apiOrigin, 'https://platform.test');
  assert.equal(seen.expectedBytes, NEW_BYTES.length);
  assert.equal(seen.headers['x-agent-secret'], 'agent-secret'); // secret-scan:allow (fake test credential)
  assert.equal(seen.headers['x-agent-id'], AGENT_ID, 'the platform route identifies the agent by this header');
});

// ---- every refusal leaves the running agent exactly as it was ---------------------------------------------------------------------
async function refused(t, options, mutate, code, { reported = ['failed'] } = {}) {
  const ctx = setup(t, options);
  ctx.deploy(mutate ? mutate(ctx) : signedRelease(ctx.key));
  await ctx.upgrader.poll();
  assert.equal(ctx.read('nuvrion-workstation-agent.exe'), 'OLD-AGENT-BYTES', 'the running executable must be untouched');
  assert.equal(ctx.watchdogs.length, 0); assert.deepEqual(ctx.exits, []);
  assert.deepEqual(ctx.reports.map(r => r.status).filter(s => s !== 'downloading'), reported);
  if (code) assert.match(lastReport(ctx).detail, new RegExp(code));
  assert.ok(!ctx.files().some(f => f.endsWith('.part') || f.endsWith('.new') || f.endsWith('.old')), 'no leftovers: ' + ctx.files().join(','));
  return ctx;
}

test('no pinned key: refused and reported, nothing downloaded', async t => {
  const ctx = await refused(t, { pinned: false }, null, 'NUV_AGENT_UPGRADE_KEY_NOT_PINNED');
  assert.ok(!ctx.reports.some(r => r.status === 'downloading'));
});
test('a manifest signed by another key: refused', t => refused(t, {}, () => signedRelease(keypair()), 'NUV_AGENT_UPGRADE_SIGNATURE_INVALID'));
test('an older release is refused: the agent does not downgrade', t => refused(t, { currentVersion: '0.1.60-lab.1' }, null, 'NUV_AGENT_UPGRADE_NOT_NEWER'));
test('a download that fails is reported and leaves nothing behind', t => refused(t, { downloadResult: Object.assign(new Error('HTTP 404'), { code: 'NUV_AGENT_UPGRADE_DOWNLOAD_FAILED' }) }, null, 'NUV_AGENT_UPGRADE_DOWNLOAD_FAILED'));
test('a download of the wrong size is refused', t => refused(t, { downloadResult: { reportedBytes: 5 } }, null, 'NUV_AGENT_UPGRADE_SIZE_MISMATCH'));
test('a download with the wrong checksum is refused', t => refused(t, { downloadResult: { sha256: 'a'.repeat(64) } }, null, 'NUV_AGENT_UPGRADE_CHECKSUM_MISMATCH'));
test('a new executable that fails its self-check is never swapped in', t => refused(t, { selfCheckError: Object.assign(new Error('exited 1'), { code: 'NUV_AGENT_UPGRADE_SELF_CHECK_FAILED' }) }, null, 'NUV_AGENT_UPGRADE_SELF_CHECK_FAILED'));

test('if the restart cannot be arranged the previous executable is put back and the failure is reported', async t => {
  const ctx = setup(t, { watchdogError: new Error('spawn EPERM') });
  ctx.deploy(signedRelease(ctx.key));
  await ctx.upgrader.poll();
  assert.equal(ctx.read('nuvrion-workstation-agent.exe'), 'OLD-AGENT-BYTES', 'the agent must keep running as it was');
  assert.equal(ctx.files().includes('upgrade-state.json'), false);
  assert.equal(lastReport(ctx).status, 'failed');
  assert.match(lastReport(ctx).detail, /NUV_AGENT_UPGRADE_RESTART_FAILED/);
  assert.deepEqual(ctx.exits, []);
});

test('a deployment for the version that is already running is reported installed without downloading anything', async t => {
  const ctx = setup(t, { currentVersion: '0.1.50-lab.1' });
  ctx.deploy(signedRelease(ctx.key));
  await ctx.upgrader.poll();
  assert.deepEqual(ctx.reports.map(r => r.status), ['installed']);
  assert.equal(ctx.read('nuvrion-workstation-agent.exe'), 'OLD-AGENT-BYTES');
});

// ---- the new agent proves it is healthy -----------------------------------------------------------------------------------------
function swappedState(ctx, over = {}) {
  fs.writeFileSync(path.join(ctx.root, 'upgrade-state.json'), JSON.stringify({ phase: 'swapped', deploymentId: 'dep-1', fromVersion: '0.1.49-lab.1', toVersion: '0.1.50-lab.1',
    executable: ctx.executable, backup: ctx.executable + '.old', ...over }));
}

test('the upgraded agent writes the health flag and reports installed after its first heartbeat', async t => {
  const ctx = setup(t, { currentVersion: '0.1.50-lab.1' });
  swappedState(ctx);
  assert.equal(await ctx.upgrader.recordHealthy(), true);
  assert.ok(ctx.files().includes('upgrade-ok.flag'), 'the watchdog is waiting for this file');
  assert.equal(lastReport(ctx).status, 'installed');
  assert.equal(ctx.files().includes('upgrade-state.json'), false, 'the upgrade is finished');
});

test('recordHealthy does nothing for an agent that is not the upgraded one, or when no upgrade is in progress', async t => {
  const ctx = setup(t, { currentVersion: '0.1.49-lab.1' });
  assert.equal(await ctx.upgrader.recordHealthy(), false);
  swappedState(ctx);
  assert.equal(await ctx.upgrader.recordHealthy(), false);
  assert.ok(!ctx.files().includes('upgrade-ok.flag'));
  assert.deepEqual(ctx.reports, []);
});

test('a terminal result that cannot be reported is kept and sent on a later poll, never lost', async t => {
  const ctx = setup(t, { currentVersion: '0.1.50-lab.1' });
  ctx.state.reportFails = body => body.status === 'installed';
  swappedState(ctx);
  await ctx.upgrader.recordHealthy();
  assert.equal(JSON.parse(ctx.read('upgrade-state.json')).phase, 'unreported');
  assert.ok(ctx.files().includes('upgrade-ok.flag'), 'the agent is healthy whether or not the platform heard about it');
  ctx.state.reportFails = null;
  assert.equal(await ctx.upgrader.poll(), 'settling');
  assert.equal(lastReport(ctx).status, 'installed');
  assert.equal(ctx.files().includes('upgrade-state.json'), false);
});

test('a result the platform keeps refusing is given up on after a bounded number of polls, so later upgrades are not held back', async t => {
  const ctx = setup(t, { currentVersion: '0.1.50-lab.1' });
  ctx.state.reportFails = () => true;
  fs.writeFileSync(path.join(ctx.root, 'upgrade-state.json'), JSON.stringify({ phase: 'unreported', deploymentId: 'dep-1', status: 'failed', detail: 'x', rollbackVersion: null }));
  for (let poll = 1; poll < U.MAX_UNREPORTED_ATTEMPTS; poll += 1) {
    assert.equal(await ctx.upgrader.poll(), 'settling', `poll ${poll} is still retrying`);
    assert.ok(ctx.files().includes('upgrade-state.json'));
  }
  assert.equal(JSON.parse(ctx.read('upgrade-state.json')).attempts, U.MAX_UNREPORTED_ATTEMPTS - 1);
  assert.notEqual(await ctx.upgrader.poll(), 'settling', 'the limit is reached: the poll goes on to look for new work');
  assert.equal(ctx.files().includes('upgrade-state.json'), false, 'the stale result is dropped');
});

test('after a rollback the restored agent reports rolled_back with the version it is running', async t => {
  const ctx = setup(t, { currentVersion: '0.1.49-lab.1' });
  swappedState(ctx);
  fs.writeFileSync(path.join(ctx.root, 'upgrade-rolled-back.json'), JSON.stringify({ deploymentId: 'dep-1', fromVersion: '0.1.49-lab.1', toVersion: '0.1.50-lab.1', reason: 'did not report healthy' }));
  await ctx.upgrader.poll();
  assert.equal(lastReport(ctx).status, 'rolled_back');
  assert.equal(lastReport(ctx).rollbackVersion, '0.1.49-lab.1');
  assert.deepEqual(ctx.files().filter(f => f.startsWith('upgrade-')), [], 'markers are cleared once reported');
});

test('an old agent that finds a swapped state it is not part of reports the upgrade as not applied', async t => {
  const ctx = setup(t, { currentVersion: '0.1.49-lab.1' });
  swappedState(ctx);
  await ctx.upgrader.poll();
  assert.equal(lastReport(ctx).status, 'failed');
  assert.match(lastReport(ctx).detail, /NUV_AGENT_UPGRADE_NOT_APPLIED/);
});

test('while an upgrade is settling no new deployment is started, and overlapping polls do nothing', async t => {
  const ctx = setup(t, { currentVersion: '0.1.50-lab.1' });
  swappedState(ctx);
  ctx.deploy(signedRelease(ctx.key, { version: '0.1.60-lab.1' }));
  assert.equal(await ctx.upgrader.poll(), 'settling');
  assert.deepEqual(ctx.reports, []);
  const slow = setup(t);
  let release;
  slow.upgrader = U.createUpgrader({ root: slow.root, executable: slow.executable, currentVersion: '0.1.49-lab.1', config: { apiUrl: 'https://platform.test', identity: { agentId: AGENT_ID, secret: 'x' } },
    api: { get: () => new Promise(resolve => { release = () => resolve({ items: [] }); }), post: async () => ({}) } });
  const first = slow.upgrader.poll();
  // a second poll must return at once; without the guard it would wait on the platform too, so bound the wait instead of hanging
  const second = await Promise.race([slow.upgrader.poll(), new Promise(resolve => setTimeout(() => resolve('waited on the platform'), 100))]);
  assert.equal(second, 'busy');
  release(); assert.equal(await first, 'idle');
});

test('a platform that cannot be reached is an ordinary poll error, never an exception', async t => {
  const ctx = setup(t, { apiGetError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.equal(await ctx.upgrader.poll(), 'error');
  assert.ok(ctx.logs.some(l => l.event === 'agent.upgrade.poll_failed'));
});

// ---- the swap ---------------------------------------------------------------------------------------------------------------------
test('the swap sets the running executable aside, puts the new one in place and replaces an older backup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvrion-swap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [executable, staged, backup] = ['a.exe', 'a.exe.new', 'a.exe.old'].map(n => path.join(root, n));
  fs.writeFileSync(executable, 'CURRENT'); fs.writeFileSync(staged, 'NEXT'); fs.writeFileSync(backup, 'STALE');
  U.swapExecutable({ executable, staged, backup });
  assert.equal(fs.readFileSync(executable, 'utf8'), 'NEXT'); assert.equal(fs.readFileSync(backup, 'utf8'), 'CURRENT'); assert.equal(fs.existsSync(staged), false);
});

test('if the new executable cannot be put in place the original is restored', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvrion-swap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [executable, staged, backup] = ['a.exe', 'missing.new', 'a.exe.old'].map(n => path.join(root, n));
  fs.writeFileSync(executable, 'CURRENT');
  assert.throws(() => U.swapExecutable({ executable, staged, backup }), e => e.code === 'NUV_AGENT_UPGRADE_SWAP_FAILED');
  assert.equal(fs.readFileSync(executable, 'utf8'), 'CURRENT', 'the agent must still be there');
});

// ---- the download -----------------------------------------------------------------------------------------------------------------
function fakeGet(routes, seen = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {}; request.destroy = error => { if (error) request.emit('error', error); };
    seen.push({ url: String(url), headers: options.headers, ca: options.ca, rejectUnauthorized: options.rejectUnauthorized });
    const route = routes[String(url)];
    setImmediate(() => {
      if (!route) return request.emit('error', new Error('no route ' + url));
      const response = Readable.from(route.chunks ?? [], { objectMode: false });
      response.statusCode = route.status ?? 200; response.headers = route.headers ?? {};
      callback(response);
    });
    return request;
  };
}
function dest(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvrion-dl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'artifact.part'); }

test('a download is streamed to disk and returns its size and SHA-256', async t => {
  const destination = dest(t), seen = [];
  const url = 'https://platform.test/a';
  const result = await U.download({ url, destination, expectedBytes: NEW_BYTES.length, apiOrigin: 'https://platform.test', ca: Buffer.from('CA'), headers: { 'x-agent-secret': 's' }, // secret-scan:allow (fake test credential)
    get: fakeGet({ [url]: { chunks: [NEW_BYTES.subarray(0, 5), NEW_BYTES.subarray(5)], headers: { 'content-length': String(NEW_BYTES.length) } } }, seen) });
  assert.deepEqual(result, { bytes: NEW_BYTES.length, sha256: NEW_SHA });
  assert.deepEqual(fs.readFileSync(destination), NEW_BYTES);
  assert.equal(seen[0].headers['x-agent-secret'], 's', 'the platform gets the agent credential'); // secret-scan:allow (fake test credential)
  assert.equal(seen[0].rejectUnauthorized, true);
  assert.deepEqual(seen[0].ca, Buffer.from('CA'));
});

test('a file larger than its signed size is cut off while streaming and removed', async t => {
  const destination = dest(t), url = 'https://platform.test/a';
  await assert.rejects(U.download({ url, destination, expectedBytes: 4, apiOrigin: 'https://platform.test', get: fakeGet({ [url]: { chunks: [Buffer.from('0123'), Buffer.from('4567')] } }) }),
    e => e.code === 'NUV_AGENT_UPGRADE_SIZE_MISMATCH');
  assert.equal(fs.existsSync(destination), false);
});

test('a declared length that differs from the signed size is refused before any byte is written', async t => {
  const destination = dest(t), url = 'https://platform.test/a';
  await assert.rejects(U.download({ url, destination, expectedBytes: 10, apiOrigin: 'https://platform.test',
    get: fakeGet({ [url]: { chunks: [Buffer.alloc(10)], headers: { 'content-length': '999' } } }) }), e => e.code === 'NUV_AGENT_UPGRADE_SIZE_MISMATCH');
  assert.equal(fs.existsSync(destination), false);
});

test('a non-200 answer, a plain-HTTP URL and a redirect to plain HTTP are refused', async t => {
  const url = 'https://platform.test/a';
  await assert.rejects(U.download({ url, destination: dest(t), expectedBytes: 1, apiOrigin: 'https://platform.test', get: fakeGet({ [url]: { status: 404 } }) }), e => e.code === 'NUV_AGENT_UPGRADE_DOWNLOAD_FAILED');
  await assert.rejects(U.download({ url: 'http://platform.test/a', destination: dest(t), expectedBytes: 1, apiOrigin: 'https://platform.test', get: fakeGet({}) }), e => e.code === 'NUV_AGENT_UPGRADE_URL_INVALID');
  await assert.rejects(U.download({ url, destination: dest(t), expectedBytes: 1, apiOrigin: 'https://platform.test',
    get: fakeGet({ [url]: { status: 302, headers: { location: 'http://elsewhere.test/a' } } }) }), e => e.code === 'NUV_AGENT_UPGRADE_URL_INVALID');
});

test('the agent credential and the lab CA are never sent to another origin, even by redirect', async t => {
  const seen = [], first = 'https://platform.test/a', second = 'https://downloads.example/agent.exe';
  const result = await U.download({ url: first, destination: dest(t), expectedBytes: NEW_BYTES.length, apiOrigin: 'https://platform.test', ca: Buffer.from('CA'), headers: { 'x-agent-secret': 's' }, // secret-scan:allow (fake test credential)
    get: fakeGet({ [first]: { status: 302, headers: { location: second } }, [second]: { chunks: [NEW_BYTES], headers: { 'content-length': String(NEW_BYTES.length) } } }, seen) });
  assert.equal(result.sha256, NEW_SHA);
  assert.equal(seen[0].headers['x-agent-secret'], 's'); // secret-scan:allow (fake test credential)
  assert.deepEqual(seen[1].headers, {}); assert.equal(seen[1].ca, undefined);
});

test('a redirect loop is stopped', async t => {
  const url = 'https://platform.test/a';
  await assert.rejects(U.download({ url, destination: dest(t), expectedBytes: 1, apiOrigin: 'https://platform.test', maxRedirects: 2,
    get: fakeGet({ [url]: { status: 302, headers: { location: url } } }) }), e => e.code === 'NUV_AGENT_UPGRADE_DOWNLOAD_FAILED');
});

// ---- the self-check ---------------------------------------------------------------------------------------------------------------
test('the self-check accepts the right version and refuses a failure, bad output or another version', async () => {
  const run = (stdout, error = null) => (file, args, options, callback) => { assert.deepEqual(args, ['--self-check']); callback(error, stdout); };
  const ok = JSON.stringify({ event: 'agent.selfcheck', ok: true, version: '0.1.50-lab.1' });
  assert.deepEqual(await U.selfCheck('new.exe', '0.1.50-lab.1', { run: run(ok + '\n') }), { event: 'agent.selfcheck', ok: true, version: '0.1.50-lab.1' });
  for (const [stdout, error] of [[ok, new Error('exit 1')], ['not json', null], [JSON.stringify({ ok: false, version: '0.1.50-lab.1' }), null], [JSON.stringify({ ok: true, version: '0.1.51-lab.1' }), null]]) {
    await assert.rejects(U.selfCheck('new.exe', '0.1.50-lab.1', { run: run(stdout, error) }), e => e.code === 'NUV_AGENT_UPGRADE_SELF_CHECK_FAILED');
  }
});

test('the agent executable answers --self-check with its version and exits 0 before taking any lock', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'agent-service.cjs'), '--self-check'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(answer.ok, true); assert.equal(answer.event, 'agent.selfcheck'); assert.match(answer.version, /^\d+\.\d+\.\d+/);
});

// ---- the watchdog -----------------------------------------------------------------------------------------------------------------
function watchdogFixture(t, { healthyAfterSleeps = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvrion-wd-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'agent.exe'), backup = executable + '.old', statePath = path.join(root, 'upgrade-state.json');
  fs.writeFileSync(executable, 'NEW-AGENT'); fs.writeFileSync(backup, 'OLD-AGENT');
  fs.writeFileSync(statePath, JSON.stringify({ phase: 'swapped', deploymentId: 'dep-1', fromVersion: '0.1.49-lab.1', toVersion: '0.1.50-lab.1', executable, backup, healthDeadlineMs: 10000 }));
  let clock = 0, sleeps = 0; const events = [];
  const deps = {
    statePath, parentPid: 4242, now: () => clock, log: (event, detail) => events.push(event),
    isAlive: () => clock < 1000, startAgent: async () => { events.push('start'); }, killAgent: async () => { events.push('kill'); },
    sleep: async ms => { clock += ms; sleeps += 1; if (healthyAfterSleeps !== null && sleeps >= healthyAfterSleeps) fs.writeFileSync(path.join(root, 'upgrade-ok.flag'), 'ok'); },
  };
  return { root, executable, backup, deps, events, read: f => fs.readFileSync(path.join(root, f), 'utf8') };
}

test('the watchdog waits for the old agent to exit, starts the new one and finishes once the health flag appears', async t => {
  const ctx = watchdogFixture(t, { healthyAfterSleeps: 8 });
  assert.equal(await U.runWatchdog(ctx.deps), 'healthy');
  assert.deepEqual(ctx.events.filter(e => e === 'start' || e === 'kill'), ['start']);
  assert.equal(fs.readFileSync(ctx.executable, 'utf8'), 'NEW-AGENT', 'a healthy upgrade keeps the new executable');
  assert.equal(fs.existsSync(path.join(ctx.root, 'upgrade-rolled-back.json')), false);
});

test('without the health flag the watchdog stops the new agent, restores the previous executable and starts it', async t => {
  const ctx = watchdogFixture(t);
  assert.equal(await U.runWatchdog(ctx.deps), 'rolled_back');
  assert.deepEqual(ctx.events.filter(e => e === 'start' || e === 'kill'), ['start', 'kill', 'start']);
  assert.equal(fs.readFileSync(ctx.executable, 'utf8'), 'OLD-AGENT', 'the previous executable is back in place');
  assert.equal(fs.readFileSync(ctx.executable + '.failed', 'utf8'), 'NEW-AGENT', 'the failed one is kept for diagnosis');
  const marker = JSON.parse(ctx.read('upgrade-rolled-back.json'));
  assert.equal(marker.deploymentId, 'dep-1'); assert.equal(marker.restored, true); assert.match(marker.reason, /0\.1\.50-lab\.1 did not report healthy/);
});

test('a watchdog with nothing to do exits without starting anything', async t => {
  const ctx = watchdogFixture(t);
  fs.writeFileSync(path.join(ctx.root, 'upgrade-state.json'), JSON.stringify({ phase: 'unreported' }));
  assert.equal(await U.runWatchdog(ctx.deps), 'idle');
  assert.deepEqual(ctx.events.filter(e => e === 'start' || e === 'kill'), []);
});

test('the watchdog is launched from the previous executable with the state file and the parent pid', () => {
  const calls = [];
  U.launchWatchdog({ backup: '/opt/agent.exe.old', executable: '/opt/agent.exe' }, { parentPid: 77, spawnProcess: (file, args, options) => { calls.push({ file, args, options }); return { unref() {} }; } });
  assert.equal(calls[0].file, '/opt/agent.exe.old');
  assert.deepEqual(calls[0].args, ['--upgrade-watchdog', path.join('/opt', 'upgrade-state.json'), '77']);
  assert.equal(calls[0].options.detached, true); assert.equal(calls[0].options.stdio, 'ignore');
});

test('process control starts the agent executable directly (not through the scheduled task) and kills it by image name', async () => {
  const runs = [], spawned = [];
  const control = U.windowsProcessControl({ executable: 'C:\\x\\agent.exe', run: (file, args, o, cb) => { runs.push([file, ...args]); cb(null); },
    spawnProcess: (file, args, options) => { spawned.push({ file, args, options }); return { unref() {} }; } });
  await control.startAgent();
  assert.equal(runs.length, 0, 'schtasks must not be used: an IgnoreNew task would swallow the start');
  assert.equal(spawned[0].file, 'C:\\x\\agent.exe');
  assert.deepEqual(spawned[0].args, []);
  assert.equal(spawned[0].options.detached, true); assert.equal(spawned[0].options.windowsHide, true);
  const kills = [];
  await U.windowsProcessControl({ executable: path.win32.join('C:\\x', 'agent.exe'), run: (file, args, o, cb) => { kills.push([file, ...args]); cb(null); } }).killAgent();
  assert.deepEqual(kills[0], ['taskkill', '/F', '/IM', path.basename('C:\\x\\agent.exe')]);
});

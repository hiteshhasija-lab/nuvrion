import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentUpgradeService } from '../src/agent-upgrade-service.js';
import { AgentArtifactStore } from '../src/agent-artifact-store.js';
import { AgentPlatformSettings, normalizeOrigin, AgentSettingsError } from '../src/agent-platform-settings.js';
import { importAgentBuilds } from '../src/agent-build-importer.js';

const exe = text => Buffer.concat([Buffer.from('MZ'), Buffer.from(text)]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function world(t, { address = 'https://nuvrion.lab.sps' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nuvrion-importer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, 'agent-artifacts'), intake = join(root, 'agent-intake');
  await mkdir(artifacts, { recursive: true }); await mkdir(intake, { recursive: true });
  const store = new AgentArtifactStore({ directory: artifacts }), upgrades = new AgentUpgradeService(), settings = new AgentPlatformSettings({ file: join(root, 'agent-settings.json') });
  if (address) await settings.setPublicBaseUrl(address);
  const events = [];
  const publish = async (version, bytes, { name, over = {} } = {}) => {
    const sha256 = digest(bytes);
    await writeFile(join(artifacts, sha256), bytes);
    await writeFile(join(intake, name ?? `${sha256}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version, sha256, sizeBytes: bytes.length, release: '0.1.178', ...over }));
    return sha256;
  };
  const run = () => importAgentBuilds({ intakeDirectory: intake, store, upgrades, settings, record: async event => { events.push(event); } });
  return { root, artifacts, intake, store, upgrades, settings, publish, run, events, names: folder => readdir(folder ? join(intake, folder) : intake).catch(() => []) };
}

test('a published build is registered once, as a signed release at the address agents use, and its record is filed', async t => {
  const w = await world(t), bytes = exe('agent 0.1.61');
  const sha256 = await w.publish('0.1.61-lab.1', bytes);
  const first = await w.run();
  assert.deepEqual(first.imported.map(item => [item.version, item.sha256]), [['0.1.61-lab.1', sha256]]);
  const release = w.upgrades.releaseByVersion('0.1.61-lab.1');
  assert.equal(release.manifest.artifactUrl, `https://nuvrion.lab.sps/api/v1/agent-upgrades/artifacts/${sha256}`);
  assert.equal(release.manifest.sizeBytes, bytes.length);
  assert.equal(verify(null, Buffer.from(JSON.stringify(release.manifest)), w.upgrades.publicKey, Buffer.from(release.signature, 'base64url')), true, 'the release is signed by the platform key');
  assert.deepEqual(await w.names(), ['imported']);
  assert.deepEqual(await w.names('imported'), [`${sha256}.json`]);
  assert.deepEqual(w.events.map(event => [event.outcome, event.version, event.fromRelease]), [['succeeded', '0.1.61-lab.1', '0.1.178']]);
  const second = await w.run();
  assert.deepEqual([second.imported.length, second.rejected.length, second.waiting], [0, 0, 0]);
  assert.equal(w.upgrades.listReleases().length, 1, 'running again registers nothing more');
});

test('without the address agents use, records wait where they are; once it is set they are imported', async t => {
  const w = await world(t, { address: null }), sha256 = await w.publish('0.1.62-lab.1', exe('agent 0.1.62'));
  const waiting = await w.run();
  assert.deepEqual([waiting.waiting, waiting.imported.length], [1, 0]);
  assert.deepEqual(await w.names(), [`${sha256}.json`]);
  assert.equal(w.upgrades.listReleases().length, 0);
  await w.settings.setPublicBaseUrl('https://platform.example:8443');
  const done = await w.run();
  assert.equal(done.imported.length, 1);
  assert.match(w.upgrades.releaseByVersion('0.1.62-lab.1').manifest.artifactUrl, /^https:\/\/platform\.example:8443\/api\/v1\//);
});

test('a version that is already registered with the same bytes is simply filed; with different bytes it is refused', async t => {
  const w = await world(t), bytes = exe('agent 0.1.63');
  const sha256 = digest(bytes);
  await writeFile(join(w.artifacts, sha256), bytes);
  w.upgrades.registerRelease({ version: '0.1.63-lab.1', artifactUrl: `https://nuvrion.lab.sps/api/v1/agent-upgrades/artifacts/${sha256}`, sha256, sizeBytes: bytes.length });
  await w.publish('0.1.63-lab.1', bytes);
  const same = await w.run();
  assert.deepEqual([same.alreadyKnown, same.imported.length, same.rejected.length], [['0.1.63-lab.1'], 0, 0]);
  assert.equal(w.upgrades.listReleases().length, 1);
  const different = await w.publish('0.1.63-lab.1', exe('another build with the same version'));
  const refused = await w.run();
  assert.match(refused.rejected[0].reason, /already registered with a different executable/);
  assert.deepEqual(await w.names('rejected'), [`${different}.json`, `${different}.json.reason.txt`]);
  assert.equal(w.upgrades.listReleases().length, 1, 'nothing was registered for it');
});

test('a record or file that is not what it claims is refused, filed with the reason, and registers nothing', async t => {
  const w = await world(t);
  await writeFile(join(w.intake, `${'1'.repeat(64)}.json`), '{ not json');
  await writeFile(join(w.intake, `${'2'.repeat(64)}.json`), JSON.stringify({ format: 'something-else', version: '0.1.64-lab.1', sha256: '2'.repeat(64), sizeBytes: 5 }));
  await writeFile(join(w.intake, `${'3'.repeat(64)}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: 'latest', sha256: '3'.repeat(64), sizeBytes: 5 }));
  await writeFile(join(w.intake, `${'4'.repeat(64)}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.64-lab.1', sha256: '5'.repeat(64), sizeBytes: 5 }));   // named for another digest
  await writeFile(join(w.intake, `${'6'.repeat(64)}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.64-lab.1', sha256: '6'.repeat(64), sizeBytes: 5 }));   // no file
  const wrong = exe('real bytes'), wrongSha = digest(wrong);
  await writeFile(join(w.artifacts, wrongSha), wrong);
  await writeFile(join(w.intake, `${wrongSha}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.64-lab.1', sha256: wrongSha, sizeBytes: wrong.length + 1 }));   // wrong size
  const shell = Buffer.from('#!/bin/sh\necho not an exe'), shellSha = digest(shell);
  await writeFile(join(w.artifacts, shellSha), shell);
  await writeFile(join(w.intake, `${shellSha}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.64-lab.1', sha256: shellSha, sizeBytes: shell.length }));   // not MZ
  const corrupt = exe('swapped on disk'), corruptSha = '7'.repeat(64);
  await writeFile(join(w.artifacts, corruptSha), corrupt);
  await writeFile(join(w.intake, `${corruptSha}.json`), JSON.stringify({ format: 'nuvrion-agent-intake/1', version: '0.1.64-lab.1', sha256: corruptSha, sizeBytes: corrupt.length }));   // bytes do not hash to the name
  const result = await w.run();
  assert.equal(result.imported.length, 0);
  assert.equal(result.rejected.length, 8);
  assert.equal(w.upgrades.listReleases().length, 0);
  assert.deepEqual((await w.names()).sort(), ['rejected']);
  assert.equal((await w.names('rejected')).length, 16, 'each refused record is kept with its reason');
  assert.ok(w.events.every(event => event.outcome === 'failed'));
});

test('a record whose file name is not its digest is refused even when the executable it names is perfectly good', async t => {
  const w = await world(t);
  await w.publish('0.1.66-lab.1', exe('agent 0.1.66'), { name: 'renamed-by-someone.json' });
  const result = await w.run();
  assert.equal(result.imported.length, 0);
  assert.match(result.rejected[0].reason, /not a well-formed agent build record/);
  assert.equal(w.upgrades.listReleases().length, 0);
});

test('a failure that is not the record\'s fault leaves it in place to be tried again', async t => {
  const w = await world(t), sha256 = await w.publish('0.1.65-lab.1', exe('agent 0.1.65'));
  const original = w.upgrades.registerRelease.bind(w.upgrades);
  w.upgrades.registerRelease = () => { throw new Error('the database is unavailable'); };
  const failed = await w.run();
  assert.deepEqual([failed.imported.length, failed.rejected.length], [0, 0]);
  assert.deepEqual(await w.names(), [`${sha256}.json`]);
  w.upgrades.registerRelease = original;
  assert.equal((await w.run()).imported.length, 1);
});

test('no intake directory is not an error, and a record whose name or content is odd cannot reach outside the directory', async t => {
  const w = await world(t);
  await rm(w.intake, { recursive: true });
  assert.deepEqual(await w.run(), { imported: [], alreadyKnown: [], rejected: [], waiting: 0 });
  await mkdir(w.intake, { recursive: true });
  await writeFile(join(w.intake, 'notes.txt'), 'not a record');
  assert.deepEqual((await w.run()).rejected, [], 'only .json files are looked at');
  assert.equal(await readFile(join(w.intake, 'notes.txt'), 'utf8'), 'not a record');
});

test('the address agents use must be an https origin; it is stored and read back, and a damaged file reads as unset', async t => {
  assert.equal(normalizeOrigin('https://nuvrion.lab.sps'), 'https://nuvrion.lab.sps');
  assert.equal(normalizeOrigin(' https://nuvrion.lab.sps/ '), 'https://nuvrion.lab.sps');
  assert.equal(normalizeOrigin('https://10.0.0.100:8443'), 'https://10.0.0.100:8443');
  for (const bad of ['http://nuvrion.lab.sps', 'nuvrion.lab.sps', 'https://nuvrion.lab.sps/api', 'https://nuvrion.lab.sps/?x=1', 'https://user:pw@nuvrion.lab.sps', '', null]) {
    assert.throws(() => normalizeOrigin(bad), error => error instanceof AgentSettingsError && error.code === 'NUV_AGENT_UPGRADE_URL_INVALID', String(bad));
  }
  const w = await world(t, { address: null });
  assert.deepEqual(await w.settings.get(), { publicBaseUrl: null, updatedAt: null, updatedBy: null });
  const saved = await w.settings.setPublicBaseUrl('https://nuvrion.lab.sps/', { by: 'admin' });
  assert.deepEqual([saved.publicBaseUrl, saved.updatedBy], ['https://nuvrion.lab.sps', 'admin']);
  assert.equal((await w.settings.get()).publicBaseUrl, 'https://nuvrion.lab.sps');
  await writeFile(w.settings.file, '{ damaged');
  assert.equal((await w.settings.get()).publicBaseUrl, null);
  assert.deepEqual((await readdir(w.root)).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('a stored executable is verified for presence, size, digest and type', async t => {
  const w = await world(t), bytes = exe('verify me'), sha256 = digest(bytes);
  await assert.rejects(w.store.verify(sha256, { sizeBytes: bytes.length }), error => error.code === 'NUV_AGENT_ARTIFACT_MISSING');
  await writeFile(join(w.artifacts, sha256), bytes);
  assert.equal(await w.store.verify(sha256, { sizeBytes: bytes.length }), true);
  await assert.rejects(w.store.verify(sha256, { sizeBytes: bytes.length + 1 }), error => error.code === 'NUV_AGENT_ARTIFACT_SIZE_MISMATCH');
  await assert.rejects(w.store.verify('not-a-digest', { sizeBytes: 1 }), error => error.code === 'NUV_AGENT_ARTIFACT_INVALID');
});

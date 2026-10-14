import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { PostgresAgentUpgradeService } from '../src/postgres-agent-upgrade-service.js';
import { PostgresAgentRegistry } from '../src/postgres-agent-registry.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// Agent upgrades against a real PostgreSQL: signed release manifests, staging for one agent, delivery, and results that can only
// move forward and stop at the first final outcome.
const database = { skip: skipDatabaseTests };
const keys = generateKeyPairSync('ed25519');
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const db = skipDatabaseTests ? null : await createTestDatabase();
const upgrades = db ? new PostgresAgentUpgradeService(db.pool, { privateKeyPem, publicKeyPem }) : null;
const registry = db ? new PostgresAgentRegistry(db.pool, { masterKey: 'agent-upgrade-test-master-key' }) : null; // secret-scan:allow (fake test key)
after(async () => { await db?.drop(); });
beforeEach(async () => { if (db) await db.pool.query('TRUNCATE agents.upgrade_deployments, agents.upgrade_releases, agents.commands, agents.enrollment_tokens, agents.workstation_agents CASCADE'); });

const agent = async name => { const { token } = await registry.createEnrollmentToken({}); return (await registry.enroll({ token, name, version: '0.1.46' })).agentId; };
const release = (over = {}) => upgrades.registerRelease({ version: '0.1.47', artifactUrl: 'https://downloads.example.invalid/agent-0.1.47.nuvpkg', sha256: 'a'.repeat(64), sizeBytes: 4096, ...over });
const rejects = (work, code) => assert.rejects(work, error => error.code === code, code);
const count = async table => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('a release is registered with a signed manifest that verifies with the trusted public key and with nothing else', database, async () => {
  const { manifest, signature } = await release({ sha256: 'AB'.repeat(32) });
  assert.equal(manifest.sha256, 'ab'.repeat(32), 'the digest is stored in lower case');
  assert.match(manifest.signingKeyId, /^[0-9a-f]{16}$/);
  assert.equal(manifest.signingKeyId, upgrades.signingKeyId);
  const canonical = Buffer.from(JSON.stringify(manifest));
  assert.equal(verify(null, canonical, publicKeyPem, Buffer.from(signature, 'base64url')), true);
  const stranger = generateKeyPairSync('ed25519').publicKey;
  assert.equal(verify(null, canonical, stranger, Buffer.from(signature, 'base64url')), false, 'another key cannot verify it');
  assert.equal(verify(null, Buffer.from(JSON.stringify({ ...manifest, sizeBytes: 1 })), publicKeyPem, Buffer.from(signature, 'base64url')), false, 'a changed manifest fails');
  const stored = (await db.pool.query('SELECT * FROM agents.upgrade_releases')).rows[0];
  assert.deepEqual([stored.release_id, stored.version, Number(stored.size_bytes)], [manifest.releaseId, '0.1.47', 4096]);
});

test('a release needs an HTTPS address, a SHA-256 digest and a positive whole size; a refused release leaves nothing', database, async () => {
  await rejects(() => release({ artifactUrl: 'http://example.invalid/a.nuvpkg' }), 'NUV_AGENT_UPGRADE_URL_INVALID');
  await rejects(() => release({ artifactUrl: undefined }), 'NUV_AGENT_UPGRADE_URL_INVALID');
  for (const bad of [{ sha256: 'short' }, { sha256: 'g'.repeat(64) }, { sha256: undefined }, { sizeBytes: 0 }, { sizeBytes: -5 }, { sizeBytes: 1.5 }, { sizeBytes: '4096' }]) await rejects(() => release(bad), 'NUV_AGENT_UPGRADE_DIGEST_INVALID');
  assert.equal(await count('agents.upgrade_releases'), 0);
});

test('without both signing keys the service refuses to start', database, async () => {
  assert.throws(() => new PostgresAgentUpgradeService(db.pool, { privateKeyPem }), /signing private and public keys are required/);
  assert.throws(() => new PostgresAgentUpgradeService(db.pool), /signing private and public keys are required/);
});

test('staging gives one agent a deployment of a known release, with the release and the key to verify it', database, async () => {
  const id = await agent('A'), { manifest, signature } = await release();
  const staged = await upgrades.stage(id, manifest.releaseId);
  assert.deepEqual([staged.agentId, staged.releaseId, staged.status, staged.completedAt], [id, manifest.releaseId, 'staged', null]);
  assert.deepEqual(staged.release, { manifest, signature });
  assert.equal(staged.trustedPublicKey, publicKeyPem);
  await rejects(() => upgrades.stage(id, randomUUID()), 'NUV_AGENT_RELEASE_NOT_FOUND');
  await assert.rejects(() => upgrades.stage(randomUUID(), manifest.releaseId), error => error.code === '23503', 'the database refuses a deployment for an agent that does not exist');
  assert.equal(await count('agents.upgrade_deployments'), 1);
});

test('an agent is offered its own unfinished deployments, oldest first, with verifiable releases', database, async () => {
  const a = await agent('A'), b = await agent('B');
  const one = await release({ version: '0.1.47' }), two = await release({ version: '0.1.48' }), three = await release({ version: '0.1.49' });
  const first = await upgrades.stage(a, one.manifest.releaseId), second = await upgrades.stage(a, two.manifest.releaseId), done = await upgrades.stage(a, three.manifest.releaseId);
  await upgrades.stage(b, one.manifest.releaseId);
  await upgrades.report(a, done.deploymentId, { status: 'installed' });
  await upgrades.report(a, second.deploymentId, { status: 'downloading' });
  const pending = await upgrades.pending(a);
  assert.deepEqual(pending.map(d => [d.deploymentId, d.status]), [[first.deploymentId, 'staged'], [second.deploymentId, 'downloading']]);
  assert.ok(pending.every(d => verify(null, Buffer.from(JSON.stringify(d.release.manifest)), d.trustedPublicKey, Buffer.from(d.release.signature, 'base64url'))), 'each offered release verifies');
  assert.equal((await upgrades.pending(b)).length, 1, "another agent's deployments are not mixed in");
  assert.deepEqual(await upgrades.pending(randomUUID()), []);
});

test('results move a deployment forward and record when it finished, with a rollback version and detail', database, async () => {
  const id = await agent('A'), { manifest } = await release(), { deploymentId } = await upgrades.stage(id, manifest.releaseId);
  for (const status of ['downloading', 'ready']) {
    const step = await upgrades.report(id, deploymentId, { status });
    assert.deepEqual([step.status, step.completedAt], [status, null], `${status} is not final`);
  }
  const failed = await upgrades.report(id, deploymentId, { status: 'rolled_back', rollbackVersion: '0.1.46', detail: { reason: 'service did not start' } });
  assert.deepEqual([failed.status, failed.rollbackVersion, failed.detail], ['rolled_back', '0.1.46', { reason: 'service did not start' }]);
  assert.ok(failed.completedAt);
  assert.deepEqual((await upgrades.get(deploymentId)).status, 'rolled_back');
  assert.equal(await upgrades.get(randomUUID()), null);
});

test('a plain-text failure message, the way the agent reports it, is stored and read back as text', database, async () => {
  const id = await agent('A'), { manifest } = await release(), { deploymentId } = await upgrades.stage(id, manifest.releaseId);
  const message = 'The upgrade manifest is not signed by the pinned key.';
  const failed = await upgrades.report(id, deploymentId, { status: 'failed', detail: message });
  assert.deepEqual([failed.status, failed.detail], ['failed', message]);
  assert.equal((await upgrades.get(deploymentId)).detail, message);
  const { manifest: second } = await release(), staged = await upgrades.stage(id, second.releaseId);
  const awkward = await upgrades.report(id, staged.deploymentId, { status: 'failed', detail: '{"not": json' });
  assert.equal(awkward.detail, '{"not": json', 'text that looks like broken JSON is still just text');
});

test('releases and one agent\'s deployments can be listed, newest first, with the version of each', database, async () => {
  const a = await agent('A'), b = await agent('B');
  const first = await release({ version: '0.1.60', sha256: '1'.repeat(64) });
  await new Promise(resolve => setTimeout(resolve, 10));   // releases are ordered by their creation time, to the millisecond
  const second = await release({ version: '0.1.61', sha256: '2'.repeat(64) });
  assert.deepEqual((await upgrades.listReleases()).map(item => item.manifest.version), ['0.1.61', '0.1.60'], 'newest first');
  assert.equal((await upgrades.listReleases({ limit: 1 })).length, 1);
  assert.equal((await upgrades.release(first.manifest.releaseId)).manifest.sha256, '1'.repeat(64));
  assert.equal(await upgrades.release(randomUUID()), null);
  const one = await upgrades.stage(a, first.manifest.releaseId);
  await upgrades.report(a, one.deploymentId, { status: 'installed', detail: 'Upgraded.' });
  const two = await upgrades.stage(a, second.manifest.releaseId);
  await upgrades.stage(b, second.manifest.releaseId);
  const history = await upgrades.listDeployments(a);
  assert.deepEqual(history.map(item => [item.deploymentId, item.status, item.version, item.sha256]), [[two.deploymentId, 'staged', '0.1.61', '2'.repeat(64)], [one.deploymentId, 'installed', '0.1.60', '1'.repeat(64)]]);
  assert.equal(history[1].detail, 'Upgraded.');
  assert.equal((await upgrades.listDeployments(b)).length, 1, "another agent's deployments are not mixed in");
  assert.deepEqual(await upgrades.listDeployments(randomUUID()), []);
  assert.equal((await upgrades.listDeployments(a, { limit: 1 })).length, 1);
});

test('cancelling an unfinished deployment ends it as failed with the reason, and a finished one cannot be cancelled', database, async () => {
  const id = await agent('A'), { manifest } = await release();
  const { deploymentId } = await upgrades.stage(id, manifest.releaseId);
  const cancelled = await upgrades.cancel(id, deploymentId, { detail: 'Cancelled by an operator named admin.' });
  assert.deepEqual([cancelled.status, cancelled.detail], ['failed', 'Cancelled by an operator named admin.']);
  assert.ok(cancelled.completedAt);
  assert.deepEqual(await upgrades.pending(id), [], 'the agent is not offered it any more');
  await rejects(() => upgrades.cancel(id, deploymentId), 'NUV_AGENT_UPGRADE_TERMINAL');
  await rejects(() => upgrades.cancel(id, randomUUID()), 'NUV_AGENT_DEPLOYMENT_NOT_FOUND');
  const other = await agent('B'), again = await upgrades.stage(other, manifest.releaseId);
  await rejects(() => upgrades.cancel(id, again.deploymentId), 'NUV_AGENT_DEPLOYMENT_NOT_FOUND');   // another agent's deployment is not yours to cancel
});

test('a final result is final: nothing can change it, and a wrong agent or unknown deployment is refused', database, async () => {
  const a = await agent('A'), b = await agent('B'), { manifest } = await release(), { deploymentId } = await upgrades.stage(a, manifest.releaseId);
  await rejects(() => upgrades.report(a, deploymentId, { status: 'exploded' }), 'NUV_AGENT_UPGRADE_STATUS_INVALID');
  await rejects(() => upgrades.report(b, deploymentId, { status: 'installed' }), 'NUV_AGENT_DEPLOYMENT_NOT_FOUND');
  await rejects(() => upgrades.report(a, randomUUID(), { status: 'installed' }), 'NUV_AGENT_DEPLOYMENT_NOT_FOUND');
  assert.equal((await upgrades.get(deploymentId)).status, 'staged', 'refused reports change nothing');
  await upgrades.report(a, deploymentId, { status: 'installed' });
  for (const status of ['failed', 'downloading', 'installed']) await rejects(() => upgrades.report(a, deploymentId, { status }), 'NUV_AGENT_UPGRADE_TERMINAL');
  assert.equal((await upgrades.get(deploymentId)).status, 'installed');
});

test('conflicting final results sent at the same moment: exactly one is recorded, every round', database, async () => {
  const id = await agent('A'), { manifest } = await release();
  for (let round = 0; round < 6; round++) {
    const { deploymentId } = await upgrades.stage(id, manifest.releaseId);
    const results = await Promise.allSettled(['installed', 'failed', 'rolled_back', 'installed', 'failed', 'rolled_back'].map(status => upgrades.report(id, deploymentId, { status })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, `round ${round}`);
    for (const failed of results.filter(r => r.status === 'rejected')) assert.equal(failed.reason.code, 'NUV_AGENT_UPGRADE_TERMINAL');
  }
});

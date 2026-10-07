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

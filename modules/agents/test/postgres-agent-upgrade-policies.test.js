import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';
import { PostgresAgentRegistry } from '../src/postgres-agent-registry.js';
import { PostgresAgentUpgradeService } from '../src/postgres-agent-upgrade-service.js';
import { PostgresAgentUpgradePolicies } from '../src/postgres-agent-upgrade-policies.js';
import { AgentPolicyError } from '../src/agent-upgrade-policies.js';
import { runAutoUpgradeCycle } from '../src/agent-auto-upgrade.js';

// Automatic-upgrade policies and the cycle that acts on them, against a real PostgreSQL: the table's own checks, replacing a policy, removal with the
// agent, and the cycle staging through the production service.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const keys = generateKeyPairSync('ed25519');
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const policies = db ? new PostgresAgentUpgradePolicies(db.pool) : null;
const upgrades = db ? new PostgresAgentUpgradeService(db.pool, { privateKeyPem, publicKeyPem }) : null;
const registry = db ? new PostgresAgentRegistry(db.pool, { masterKey: 'agent-policy-test-master-key' }) : null; // secret-scan:allow (fake test key)
after(async () => { await db?.drop(); });
beforeEach(async () => { if (db) await db.pool.query('TRUNCATE agents.upgrade_policies, agents.upgrade_deployments, agents.upgrade_releases, agents.commands, agents.enrollment_tokens, agents.workstation_agents CASCADE'); });

const agent = async (name, version = '0.1.50') => { const { token } = await registry.createEnrollmentToken({}); return (await registry.enroll({ token, name, version })).agentId; };

test('a policy is stored, read back, replaced as a whole, and listed', database, async () => {
  const id = await agent('A');
  assert.equal(await policies.get(id), null);
  const saved = await policies.set(id, { autoUpgrade: true, windowStart: '22:00', windowEnd: '05:30', windowTimezone: 'America/Chicago' }, { by: 'admin' });
  assert.deepEqual([saved.agentId, saved.autoUpgrade, saved.windowStart, saved.windowEnd, saved.windowTimezone, saved.updatedBy], [id, true, '22:00', '05:30', 'America/Chicago', 'admin']);
  assert.deepEqual(await policies.get(id), saved);
  const replaced = await policies.set(id, { autoUpgrade: false }, { by: 'other' });
  assert.deepEqual([replaced.autoUpgrade, replaced.windowStart, replaced.windowEnd, replaced.windowTimezone, replaced.updatedBy], [false, null, null, 'UTC', 'other']);
  assert.equal((await policies.list()).length, 1);
  const second = await agent('B');
  await policies.set(second, { autoUpgrade: true });
  assert.equal((await policies.list()).length, 2);
});

test('an invalid policy is refused before the database, and the table refuses what the code would not', database, async () => {
  const id = await agent('A');
  await assert.rejects(() => policies.set(id, { autoUpgrade: true, windowStart: '01:00' }), error => error instanceof AgentPolicyError);
  await assert.rejects(() => policies.set(id, { autoUpgrade: 'yes' }), error => error instanceof AgentPolicyError);
  assert.equal((await policies.list()).length, 0);
  await assert.rejects(() => db.pool.query("INSERT INTO agents.upgrade_policies(agent_id,auto_upgrade,window_start) VALUES($1,true,'01:00')", [id]), /check/i, 'one end of a window is refused by the table');
  await assert.rejects(() => db.pool.query("INSERT INTO agents.upgrade_policies(agent_id,window_start,window_end) VALUES($1,'24:00','01:00')", [id]), /check/i, 'an impossible time is refused by the table');
  await assert.rejects(() => db.pool.query('INSERT INTO agents.upgrade_policies(agent_id) VALUES($1)', [randomUUID()]), /foreign key|violates/i, 'a policy needs an agent');
});

test('a policy goes with its agent', database, async () => {
  const id = await agent('A');
  await policies.set(id, { autoUpgrade: true });
  await db.pool.query('DELETE FROM agents.workstation_agents WHERE agent_id=$1', [id]);
  assert.equal((await policies.list()).length, 0);
});

test('the cycle, with the production services, stages the newest build once for an agent that is behind, and lists unfinished upgrades across agents', database, async () => {
  const id = await agent('A', '0.1.50'), other = await agent('B', '0.1.50');
  const release = await upgrades.registerRelease({ version: '0.1.51-lab.1', artifactUrl: 'https://nuvrion.example/api/v1/agent-upgrades/artifacts/' + 'e'.repeat(64), sha256: 'e'.repeat(64), sizeBytes: 4096 });
  const store = { has: async sha => sha === 'e'.repeat(64) };
  await policies.set(id, { autoUpgrade: true });
  const agents = { agent: async agentId => ({ id: agentId, status: 'online', version: '0.1.50' }) };
  const events = [];
  const result = await runAutoUpgradeCycle({ agents, upgrades, policies, store, record: async event => { events.push(event); } });
  assert.deepEqual(result.staged.map(item => [item.agentId, item.version]), [[id, '0.1.51-lab.1']]);
  const unfinished = await upgrades.listUnfinished();
  assert.deepEqual(unfinished.map(item => [item.agentId, item.releaseId, item.status]), [[id, release.manifest.releaseId, 'staged']]);
  await policies.set(other, { autoUpgrade: true });
  assert.equal((await runAutoUpgradeCycle({ agents, upgrades, policies, store })).staged.length, 0, 'the second agent waits for the first');
  await upgrades.report(id, unfinished[0].deploymentId, { status: 'installed' });
  assert.deepEqual(await upgrades.listUnfinished(), []);
  void events;
});

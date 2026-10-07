import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PostgresAgentRegistry } from '../src/postgres-agent-registry.js';
import { verifyAgentCommand } from '../src/agent-registry.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production agent registry against a real PostgreSQL: single-use enrollment, secrets kept encrypted, signed commands,
// delivery and replay protection, expiry, revocation and secret rotation. agent-registry.test.js covers the same rules in memory.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const registry = db ? new PostgresAgentRegistry(db.pool, { masterKey: 'agent-registry-test-master-key' }) : null; // secret-scan:allow (fake test key)
after(async () => { await db?.drop(); });
beforeEach(async () => { if (db) await db.pool.query('TRUNCATE agents.commands, agents.enrollment_tokens, agents.workstation_agents CASCADE'); });

const sha = value => createHash('sha256').update(value).digest('hex');
const enrolled = async (name = 'TECHY', version = '0.1.46') => {
  const { token } = await registry.createEnrollmentToken({});
  return { token, ...(await registry.enroll({ token, name, version })) };
};
const rejects = (work, code, label) => assert.rejects(work, error => error.code === code, label ?? code);
const row = async (table, where, ...params) => (await db.pool.query(`SELECT * FROM ${table} WHERE ${where}`, params)).rows[0];
const count = async (table, where = 'true', ...params) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;
const expire = commandId => db.pool.query("UPDATE agents.commands SET expires_at = now() - interval '1 second' WHERE command_id = $1", [commandId]);

test('an enrollment token works exactly once, and only its hash is stored', database, async () => {
  const { token } = await registry.createEnrollmentToken({});
  assert.equal((await db.pool.query('SELECT token_hash FROM agents.enrollment_tokens')).rows[0].token_hash, sha(token));
  assert.equal((await db.pool.query('SELECT * FROM agents.enrollment_tokens')).rows.some(r => JSON.stringify(r).includes(token)), false, 'the token itself is not stored');
  assert.ok((await registry.enroll({ token, name: 'A' })).secret);
  await rejects(() => registry.enroll({ token, name: 'B' }), 'NUV_AGENT_ENROLLMENT_INVALID');
  assert.equal(await count('agents.workstation_agents'), 1);
});

test('agents racing to enroll with one token, round after round: exactly one gets in each time', database, async () => {
  // Several rounds on purpose: in the first the pool's connections are still being opened, which hides an overlap.
  for (let round = 0; round < 8; round++) {
    const { token } = await registry.createEnrollmentToken({});
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => registry.enroll({ token, name: `Racer ${round}.${i}` })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, `round ${round}: one winner`);
    for (const failed of results.filter(r => r.status === 'rejected')) assert.equal(failed.reason.code, 'NUV_AGENT_ENROLLMENT_INVALID');
  }
  assert.equal(await count('agents.workstation_agents'), 8, 'one agent per token');
});

test('an expired, guessed, empty or missing token is refused', database, async () => {
  const { token } = await registry.createEnrollmentToken({});
  await db.pool.query("UPDATE agents.enrollment_tokens SET expires_at = now() - interval '1 second'");
  await rejects(() => registry.enroll({ token, name: 'Late' }), 'NUV_AGENT_ENROLLMENT_INVALID', 'expired');
  for (const bad of ['guess', '', undefined, null, 42]) await rejects(() => registry.enroll({ token: bad, name: 'X' }), 'NUV_AGENT_ENROLLMENT_INVALID', `token ${JSON.stringify(bad)}`);
  assert.equal(await count('agents.workstation_agents'), 0);
});

test('the agent secret is shown once and kept only as a hash and as ciphertext; listings never reveal it', database, async () => {
  const { agentId, secret } = await enrolled('  Padded  ');
  const stored = await row('agents.workstation_agents', 'agent_id = $1', agentId);
  assert.equal(stored.secret_hash, sha(secret));
  assert.equal(stored.secret_ciphertext.toString('utf8').includes(secret), false);
  assert.equal(JSON.stringify(await registry.list()).includes(secret), false);
  assert.equal(JSON.stringify(await registry.agent(agentId)).includes(stored.secret_hash), false);
  assert.equal((await registry.agent(agentId)).name, 'Padded', 'the name is trimmed');
  const unnamed = await (async () => { const { token } = await registry.createEnrollmentToken({}); return registry.enroll({ token, name: '   ' }); })();
  assert.equal((await registry.agent(unnamed.agentId)).name, 'Workstation agent', 'a blank name gets a default');
});

test('an agent authenticates with its own secret only', database, async () => {
  const a = await enrolled('A'), b = await enrolled('B');
  assert.ok(await registry.authenticate(a.agentId, a.secret));
  for (const [id, secret] of [[a.agentId, b.secret], [a.agentId, 'wrong'], [a.agentId, ''], [a.agentId, undefined], [randomUUID(), a.secret]]) assert.equal(await registry.authenticate(id, secret), null, `${id === a.agentId ? 'agent A' : 'unknown agent'} with ${JSON.stringify(secret)}`);
});

test('a heartbeat needs valid credentials, brings the agent online and records its version, inventory and diagnostics', database, async () => {
  const { agentId, secret } = await enrolled();
  await rejects(() => registry.heartbeat(agentId, 'wrong', { version: '9.9.9' }), 'NUV_AGENT_AUTH_FAILED');
  await db.pool.query("UPDATE agents.workstation_agents SET status = 'offline'");
  const updated = await registry.heartbeat(agentId, secret, { version: '0.1.47', inventory: [{ name: 'vm-a', nativeId: 'a.vmx' }], diagnostics: { cpu: 3 } });
  assert.deepEqual([updated.status, updated.version], ['online', '0.1.47']);
  assert.deepEqual(updated.inventory, [{ name: 'vm-a', nativeId: 'a.vmx' }]);
  assert.deepEqual(updated.diagnostics, { cpu: 3 });
  assert.equal(updated.compatibility.agentVersion, '0.1.47');
  const later = await registry.heartbeat(agentId, secret, { inventory: [] });
  assert.equal(later.version, '0.1.47', 'an omitted version is kept');
  assert.deepEqual(later.diagnostics, { cpu: 3 }, 'omitted diagnostics are kept');
  assert.deepEqual(later.inventory, []);
});

test('commands are signed over their whole payload with the agent secret, exactly as the agent verifies them', database, async () => {
  const { agentId, secret } = await enrolled();
  const envelope = await registry.createCommand(agentId, { operation: 'start', targetId: 'D:\\VMs\\A\\A.vmx' });
  assert.equal(envelope.payload.agentId, agentId);
  assert.equal(verifyAgentCommand(secret, envelope), true);
  assert.equal(envelope.signature, createHmac('sha256', secret).update(JSON.stringify(envelope.payload)).digest('base64url'));
  assert.ok(Date.parse(envelope.payload.expiresAt) > Date.parse(envelope.payload.issuedAt));
  for (const change of [{ operation: 'stop' }, { targetId: 'other.vmx' }, { nonce: 'x'.repeat(22) }, { agentId: randomUUID() }, { expiresAt: '2099-01-01T00:00:00.000Z' }]) {
    assert.equal(verifyAgentCommand(secret, { ...envelope, payload: { ...envelope.payload, ...change } }), false, `tampered ${Object.keys(change)}`);
  }
  assert.equal(verifyAgentCommand('another-secret', envelope), false);
  const second = await registry.createCommand(agentId, { operation: 'start', targetId: 'D:\\VMs\\A\\A.vmx' });
  assert.notEqual(second.payload.commandId, envelope.payload.commandId);
  assert.notEqual(second.payload.nonce, envelope.payload.nonce, 'every command has its own nonce');
});

test('unknown operations, unknown agents and revoked agents cannot be given commands', database, async () => {
  const { agentId } = await enrolled();
  await rejects(() => registry.createCommand(agentId, { operation: 'format_disk', targetId: 'x' }), 'NUV_OPERATION_INVALID');
  await rejects(() => registry.createCommand(randomUUID(), { operation: 'start', targetId: 'x' }), 'NUV_AGENT_NOT_FOUND');
  await registry.revoke(agentId);
  await rejects(() => registry.createCommand(agentId, { operation: 'start', targetId: 'x' }), 'NUV_AGENT_NOT_FOUND', 'revoked');
  assert.equal(await count('agents.commands'), 0);
});

test('only queued, unexpired commands are delivered, oldest first, and an agent sees only its own', database, async () => {
  const a = await enrolled('A'), b = await enrolled('B');
  const first = await registry.createCommand(a.agentId, { operation: 'start', targetId: '1' });
  const second = await registry.createCommand(a.agentId, { operation: 'stop', targetId: '2' });
  const stale = await registry.createCommand(a.agentId, { operation: 'pause', targetId: '3' });
  await registry.createCommand(b.agentId, { operation: 'start', targetId: 'for-b' });
  await expire(stale.payload.commandId);
  const pending = await registry.pending(a.agentId, a.secret);
  assert.deepEqual(pending.map(c => c.payload.commandId), [first.payload.commandId, second.payload.commandId]);
  assert.ok(pending.every(c => verifyAgentCommand(a.secret, c)), 'delivered commands carry valid signatures');
  await registry.acknowledge(a.agentId, a.secret, first.payload.commandId, { status: 'completed' });
  assert.deepEqual((await registry.pending(a.agentId, a.secret)).map(c => c.payload.commandId), [second.payload.commandId], 'a command with a result is no longer offered');
  await rejects(() => registry.pending(a.agentId, 'wrong'), 'NUV_AGENT_AUTH_FAILED');
  assert.equal((await registry.pending(b.agentId, b.secret)).length, 1);
});

test('a result closes a command once: replays, wrong agents, unknown commands and bad statuses are refused', database, async () => {
  const a = await enrolled('A'), b = await enrolled('B');
  const { payload } = await registry.createCommand(a.agentId, { operation: 'start', targetId: 'vm' });
  await rejects(() => registry.acknowledge(a.agentId, 'wrong', payload.commandId, { status: 'completed' }), 'NUV_AGENT_AUTH_FAILED');
  await rejects(() => registry.acknowledge(a.agentId, a.secret, randomUUID(), { status: 'completed' }), 'NUV_AGENT_COMMAND_NOT_FOUND');
  await rejects(() => registry.acknowledge(b.agentId, b.secret, payload.commandId, { status: 'completed' }), 'NUV_AGENT_COMMAND_NOT_FOUND', "another agent's command");
  await rejects(() => registry.acknowledge(a.agentId, a.secret, payload.commandId, { status: 'maybe' }), 'NUV_AGENT_RESULT_INVALID');
  assert.equal((await registry.command(payload.commandId)).status, 'queued', 'refused attempts leave the command queued');
  const done = await registry.acknowledge(a.agentId, a.secret, payload.commandId, { status: 'failed', result: { code: 'X', message: 'no' } });
  assert.deepEqual([done.status, done.result.code], ['failed', 'X']);
  assert.ok(done.completedAt);
  await rejects(() => registry.acknowledge(a.agentId, a.secret, payload.commandId, { status: 'completed' }), 'NUV_AGENT_COMMAND_REPLAYED');
  assert.equal((await registry.command(payload.commandId)).status, 'failed', 'a replay cannot change the recorded outcome');
});

test('an agent reporting the same command result several times at once: only the first counts, every round', database, async () => {
  const a = await enrolled();
  for (let round = 0; round < 6; round++) {
    const { payload } = await registry.createCommand(a.agentId, { operation: 'start', targetId: `vm-${round}` });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => registry.acknowledge(a.agentId, a.secret, payload.commandId, { status: i % 2 ? 'completed' : 'failed' })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, `round ${round}`);
    for (const failed of results.filter(r => r.status === 'rejected')) assert.equal(failed.reason.code, 'NUV_AGENT_COMMAND_REPLAYED');
  }
});

test('the sweep marks silent agents offline and rejects commands that expired undelivered', database, async () => {
  const quiet = await enrolled('Quiet'), chatty = await enrolled('Chatty');
  const old = await registry.createCommand(quiet.agentId, { operation: 'start', targetId: 'vm' });
  await registry.createCommand(chatty.agentId, { operation: 'start', targetId: 'vm' });
  await expire(old.payload.commandId);
  await db.pool.query("UPDATE agents.workstation_agents SET last_heartbeat_at = now() - interval '10 minutes' WHERE name = 'Quiet'");
  const result = await registry.sweep({ offlineAfterMs: 120_000 });
  assert.deepEqual([result.offline, result.expiredCommands], [1, 1]);
  assert.equal((await registry.agent(quiet.agentId)).status, 'offline');
  assert.equal((await registry.agent(chatty.agentId)).status, 'online');
  const expired = await registry.command(old.payload.commandId);
  assert.deepEqual([expired.status, expired.result.code], ['rejected', 'NUV_AGENT_COMMAND_EXPIRED']);
  assert.deepEqual(await registry.pending(chatty.agentId, chatty.secret).then(p => p.length), 1, 'the live command is untouched');
  assert.deepEqual([(await registry.sweep()).offline, (await registry.sweep()).expiredCommands], [0, 0], 'a second sweep finds nothing new');
});

test('revoking an agent ends its access and rejects its queued commands, leaving finished ones alone', database, async () => {
  const { agentId, secret } = await enrolled();
  const finished = await registry.createCommand(agentId, { operation: 'start', targetId: 'a' });
  await registry.acknowledge(agentId, secret, finished.payload.commandId, { status: 'completed' });
  const queued = await registry.createCommand(agentId, { operation: 'stop', targetId: 'b' });
  const revoked = await registry.revoke(agentId, { reason: 'host retired' });
  assert.deepEqual([revoked.status, revoked.revocationReason], ['revoked', 'host retired']);
  assert.ok(revoked.revokedAt);
  assert.equal(await registry.authenticate(agentId, secret), null);
  await rejects(() => registry.heartbeat(agentId, secret, {}), 'NUV_AGENT_AUTH_FAILED');
  const rejected = await registry.command(queued.payload.commandId);
  assert.deepEqual([rejected.status, rejected.result.code], ['rejected', 'NUV_AGENT_REVOKED']);
  assert.equal((await registry.command(finished.payload.commandId)).status, 'completed');
  await rejects(() => registry.revoke(randomUUID()), 'NUV_AGENT_NOT_FOUND');
  assert.equal((await registry.revoke(agentId)).status, 'revoked', 'revoking again is harmless');
});

test('rotating the secret stops the old one at once, and later commands are signed with the new one', database, async () => {
  const { agentId, secret } = await enrolled();
  const before = await registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  const rotated = await registry.rotateSecret(agentId);
  assert.notEqual(rotated.secret, secret);
  assert.ok(rotated.rotatedAt);
  assert.equal(await registry.authenticate(agentId, secret), null);
  assert.ok(await registry.authenticate(agentId, rotated.secret));
  const after = await registry.createCommand(agentId, { operation: 'stop', targetId: 'vm' });
  assert.equal(verifyAgentCommand(rotated.secret, after), true);
  assert.equal(verifyAgentCommand(secret, after), false);
  const pending = await registry.pending(agentId, rotated.secret);
  assert.ok(pending.every(c => verifyAgentCommand(rotated.secret, c)), 'commands issued before the rotation are re-signed for delivery');
  assert.ok(pending.some(c => c.payload.commandId === before.payload.commandId));
  await rejects(() => registry.rotateSecret(randomUUID()), 'NUV_AGENT_NOT_FOUND');
  await registry.revoke(agentId);
  await rejects(() => registry.rotateSecret(agentId), 'NUV_AGENT_NOT_FOUND', 'a revoked agent cannot be rotated back to life');
});

test('a queued command can be superseded once; a finished one cannot', database, async () => {
  const { agentId, secret } = await enrolled();
  const a = await registry.createCommand(agentId, { operation: 'start', targetId: 'vm' }), b = await registry.createCommand(agentId, { operation: 'start', targetId: 'vm2' });
  assert.equal(await registry.supersedeCommand(a.payload.commandId, { replacementOperation: 'power_off' }), true);
  assert.equal((await registry.command(a.payload.commandId)).result.code, 'NUV_AGENT_COMMAND_SUPERSEDED');
  assert.equal(await registry.supersedeCommand(a.payload.commandId), false, 'already superseded');
  await registry.acknowledge(agentId, secret, b.payload.commandId, { status: 'completed' });
  assert.equal(await registry.supersedeCommand(b.payload.commandId), false, 'already finished');
  assert.equal(await registry.supersedeCommand(randomUUID()), false);
});

test('the console password is derived per VM from the agent secret, and a revoked agent has none', database, async () => {
  const { agentId } = await enrolled();
  const one = await registry.consoleCredential(agentId, 'D:\\VMs\\a.vmx'), again = await registry.consoleCredential(agentId, 'D:\\VMs\\a.vmx'), other = await registry.consoleCredential(agentId, 'D:\\VMs\\b.vmx');
  assert.equal(one.password, again.password);
  assert.notEqual(one.password, other.password);
  await registry.revoke(agentId);
  await rejects(() => registry.consoleCredential(agentId, 'D:\\VMs\\a.vmx'), 'NUV_AGENT_NOT_FOUND');
});

test('agents are listed by name with their compatibility, and an unknown agent is null', database, async () => {
  await enrolled('Zulu', '0.1.46'); await enrolled('Alpha', '0.0.9');
  const listed = await registry.list();
  assert.deepEqual(listed.map(a => a.name), ['Alpha', 'Zulu']);
  assert.equal(listed[0].compatibility.compatible, false, 'a version below the minimum is flagged');
  assert.equal(listed[1].compatibility.compatible, true);
  assert.equal(await registry.agent(randomUUID()), null);
});

test('without a master key the registry refuses to start', database, async () => {
  const saved = process.env.NUVRION_MASTER_KEY; delete process.env.NUVRION_MASTER_KEY;
  try { assert.throws(() => new PostgresAgentRegistry(db.pool), /NUVRION_MASTER_KEY is required/); } finally { if (saved !== undefined) process.env.NUVRION_MASTER_KEY = saved; }
});

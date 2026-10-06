import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AgentRegistry, verifyAgentCommand } from '../src/agent-registry.js';

const NOW = Date.parse('2026-10-06T00:00:00Z');
function enrolled(registry = new AgentRegistry()) {
  const { token } = registry.createEnrollmentToken({ createdBy: 'admin' });
  const agent = registry.enroll({ token, name: 'TECHY', version: '0.1.46' });
  return { registry, ...agent };
}
const clone = value => JSON.parse(JSON.stringify(value));

test('an enrollment token works exactly once', () => {
  const registry = new AgentRegistry();
  const { token } = registry.createEnrollmentToken({ createdBy: 'admin' });
  assert.ok(registry.enroll({ token, name: 'A' }).secret);
  assert.throws(() => registry.enroll({ token, name: 'B' }), e => e.code === 'NUV_AGENT_ENROLLMENT_INVALID');
});

test('an enrollment token expires', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const registry = new AgentRegistry();
  const { token } = registry.createEnrollmentToken({ createdBy: 'admin', ttlMs: 600_000 });
  t.mock.timers.tick(600_001);
  assert.throws(() => registry.enroll({ token, name: 'A' }), e => e.code === 'NUV_AGENT_ENROLLMENT_INVALID');
});

test('guessed, empty or missing tokens are refused', () => {
  const registry = new AgentRegistry();
  registry.createEnrollmentToken({ createdBy: 'admin' });
  for (const token of ['guess', '', undefined, null, 'PASTE_TOKEN_HERE']) {
    assert.throws(() => registry.enroll({ token, name: 'A' }), e => e.code === 'NUV_AGENT_ENROLLMENT_INVALID', String(token));
  }
});

test('an agent authenticates with its own secret only', () => {
  const { registry, agentId, secret } = enrolled();
  const other = enrolled(registry);
  assert.ok(registry.authenticate(agentId, secret));
  assert.equal(registry.authenticate(agentId, 'wrong'), null);
  assert.equal(registry.authenticate(agentId, other.secret), null, "another agent's secret");
  assert.equal(registry.authenticate('unknown-id', secret), null);
  assert.equal(registry.authenticate(agentId, undefined), null);
});

test('a heartbeat needs valid credentials and keeps the agent online', () => {
  const { registry, agentId, secret } = enrolled();
  assert.throws(() => registry.heartbeat(agentId, 'wrong', { inventory: [] }), e => e.code === 'NUV_AGENT_AUTH_FAILED');
  const result = registry.heartbeat(agentId, secret, { version: '0.1.46', inventory: [{ id: 'vm-1' }] });
  assert.equal(result.status, 'online');
  assert.equal(registry.agent(agentId).inventory.length, 1);
});

test('commands are signed over their whole payload and verify with the agent secret', () => {
  const { registry, agentId, secret } = enrolled();
  const envelope = registry.createCommand(agentId, { operation: 'start', targetId: 'D:\\VMs\\A\\A.vmx', requestedBy: 'admin' });
  assert.equal(envelope.payload.agentId, agentId);
  assert.equal(verifyAgentCommand(secret, envelope), true);
  assert.ok(envelope.payload.nonce.length >= 16);
  assert.ok(Date.parse(envelope.payload.expiresAt) > Date.parse(envelope.payload.issuedAt));
});

test('tampering with any payload field, the signature, or the secret fails verification', () => {
  const { registry, agentId, secret } = enrolled();
  const envelope = registry.createCommand(agentId, { operation: 'stop', targetId: 'vm-a' });
  for (const [field, value] of [['operation', 'power_off'], ['targetId', 'vm-b'], ['expiresAt', '2099-01-01T00:00:00.000Z'], ['nonce', 'AAAA'], ['agentId', 'someone-else'], ['commandId', 'other']]) {
    const forged = clone(envelope); forged.payload[field] = value;
    assert.equal(verifyAgentCommand(secret, forged), false, `changed ${field}`);
  }
  const noSignature = clone(envelope); delete noSignature.signature;
  assert.equal(verifyAgentCommand(secret, noSignature), false);
  assert.equal(verifyAgentCommand(secret, { ...envelope, signature: 'x'.repeat(envelope.signature.length) }), false);
  assert.equal(verifyAgentCommand('not-the-secret', envelope), false);
});

test('a command signed by another agent secret is rejected', () => {
  const a = enrolled(), b = enrolled(a.registry);
  const forAgentA = a.registry.createCommand(a.agentId, { operation: 'start', targetId: 'vm' });
  assert.equal(verifyAgentCommand(b.secret, forAgentA), false);
});

test('every command has its own identity and nonce', () => {
  const { registry, agentId } = enrolled();
  const a = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' }), b = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  assert.notEqual(a.payload.commandId, b.payload.commandId);
  assert.notEqual(a.payload.nonce, b.payload.nonce);
});

test('unknown operations and unknown agents are refused when creating commands', () => {
  const { registry, agentId } = enrolled();
  assert.throws(() => registry.createCommand(agentId, { operation: 'format_disk', targetId: 'vm' }), e => e.code === 'NUV_OPERATION_INVALID');
  assert.throws(() => registry.createCommand('missing', { operation: 'start', targetId: 'vm' }), e => e.code === 'NUV_AGENT_NOT_FOUND');
});

test('only queued, unexpired commands are delivered, and a delivered result closes the command', () => {
  const { registry, agentId, secret } = enrolled();
  const { payload } = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  const pending = registry.pending(agentId, secret);
  assert.equal(pending.length, 1);
  assert.equal(verifyAgentCommand(secret, pending[0]), true);
  registry.acknowledge(agentId, secret, payload.commandId, { status: 'completed', result: { code: 'NUV_OK' } });
  assert.equal(registry.pending(agentId, secret).length, 0, 'a completed command is never offered again');
});

test('replay: a command that already has a result cannot be acknowledged again', () => {
  const { registry, agentId, secret } = enrolled();
  const { payload } = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  registry.acknowledge(agentId, secret, payload.commandId, { status: 'completed' });
  assert.throws(() => registry.acknowledge(agentId, secret, payload.commandId, { status: 'completed' }), e => e.code === 'NUV_AGENT_COMMAND_REPLAYED');
  assert.throws(() => registry.acknowledge(agentId, secret, payload.commandId, { status: 'failed' }), e => e.code === 'NUV_AGENT_COMMAND_REPLAYED', 'cannot flip the outcome either');
});

test('acknowledging needs the right agent, a known command and a valid status', () => {
  const a = enrolled(), b = enrolled(a.registry);
  const { payload } = a.registry.createCommand(a.agentId, { operation: 'start', targetId: 'vm' });
  assert.throws(() => a.registry.acknowledge(a.agentId, 'wrong', payload.commandId, { status: 'completed' }), e => e.code === 'NUV_AGENT_AUTH_FAILED');
  assert.throws(() => a.registry.acknowledge(b.agentId, b.secret, payload.commandId, { status: 'completed' }), e => e.code === 'NUV_AGENT_COMMAND_NOT_FOUND', "another agent cannot answer for this one");
  assert.throws(() => a.registry.acknowledge(a.agentId, a.secret, 'missing', { status: 'completed' }), e => e.code === 'NUV_AGENT_COMMAND_NOT_FOUND');
  assert.throws(() => a.registry.acknowledge(a.agentId, a.secret, payload.commandId, { status: 'maybe' }), e => e.code === 'NUV_AGENT_RESULT_INVALID');
});

test('expiry: commands not delivered in time are rejected by the sweep and not offered', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { registry, agentId, secret } = enrolled();
  const { payload } = registry.createCommand(agentId, { operation: 'start', targetId: 'vm', ttlMs: 60_000 });
  t.mock.timers.tick(61_000);
  assert.equal(registry.pending(agentId, secret).length, 0);
  registry.sweep({ now: Date.now() });
  const command = registry.command(payload.commandId);
  assert.equal(command.status, 'rejected');
  assert.equal(command.result.code, 'NUV_AGENT_COMMAND_EXPIRED');
});

test('a silent agent is marked offline by the sweep', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { registry, agentId } = enrolled();
  t.mock.timers.tick(121_000);
  registry.sweep({ now: Date.now(), offlineAfterMs: 120_000 });
  assert.equal(registry.agent(agentId).status, 'offline');
});

test('revoking an agent ends its access and cancels its queued commands', () => {
  const { registry, agentId, secret } = enrolled();
  const { payload } = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  registry.revoke(agentId, { reason: 'host re-imaged' });
  assert.equal(registry.authenticate(agentId, secret), null);
  assert.throws(() => registry.heartbeat(agentId, secret, {}), e => e.code === 'NUV_AGENT_AUTH_FAILED');
  assert.equal(registry.command(payload.commandId).result.code, 'NUV_AGENT_REVOKED');
  assert.throws(() => registry.rotateSecret(agentId), e => e.code === 'NUV_AGENT_NOT_FOUND');
  assert.throws(() => registry.consoleCredential(agentId, 'x.vmx'), e => e.code === 'NUV_AGENT_NOT_FOUND');
});

test('rotating the secret invalidates the old one; later commands use the new one', () => {
  const { registry, agentId, secret } = enrolled();
  const rotated = registry.rotateSecret(agentId);
  assert.notEqual(rotated.secret, secret);
  assert.equal(registry.authenticate(agentId, secret), null);
  assert.ok(registry.authenticate(agentId, rotated.secret));
  const envelope = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  assert.equal(verifyAgentCommand(secret, envelope), false, 'the old secret no longer verifies new commands');
  assert.equal(verifyAgentCommand(rotated.secret, envelope), true);
});

test('the signature is a plain HMAC-SHA256 over the JSON payload (the contract the agent relies on)', () => {
  const { registry, agentId, secret } = enrolled();
  const envelope = registry.createCommand(agentId, { operation: 'start', targetId: 'vm' });
  const expected = createHmac('sha256', secret).update(JSON.stringify(envelope.payload)).digest('base64url');
  assert.equal(envelope.signature, expected);
});

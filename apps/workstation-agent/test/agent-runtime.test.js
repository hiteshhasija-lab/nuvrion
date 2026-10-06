import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../../../modules/agents/src/agent-registry.js';
import { WorkstationAgentRuntime } from '../src/agent-runtime.js';

const NOW = Date.parse('2026-10-06T00:00:00Z');
// The registry and the runtime share one mocked clock so command lifetimes are exact.
function fixture(t, { executor } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const registry = new AgentRegistry();
  const { token } = registry.createEnrollmentToken({ createdBy: 'admin' });
  const { agentId, secret } = registry.enroll({ token, name: 'TECHY' });
  const time = { advance: ms => t.mock.timers.tick(ms) }, executed = [];
  const runtime = new WorkstationAgentRuntime({
    agentId, secret, clock: () => Date.now(),
    executor: executor ?? { execute: async (operation, targetId) => { executed.push([operation, targetId]); return { code: 'NUV_DONE' }; } }
  });
  return { registry, agentId, secret, runtime, time, executed, issue: (over = {}) => registry.createCommand(agentId, { operation: 'start', targetId: 'vm-a', ...over }) };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('a valid command is executed and its result reported', async (t) => {
  const { runtime, issue, executed } = fixture(t);
  const result = await runtime.accept(issue({ operation: 'stop', targetId: 'D:\\VMs\\A.vmx' }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(executed, [['stop', 'D:\\VMs\\A.vmx']]);
});

test('a command addressed to a different agent is refused and not executed', async (t) => {
  const { runtime, registry, executed } = fixture(t);
  const { token } = registry.createEnrollmentToken({ createdBy: 'admin' });
  const other = registry.enroll({ token, name: 'OTHER' });
  await rejects(runtime.accept(registry.createCommand(other.agentId, { operation: 'start', targetId: 'vm' })), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
  assert.equal(executed.length, 0);
});

test('a tampered command is refused and not executed', async (t) => {
  const { runtime, issue, executed } = fixture(t);
  const envelope = issue({ operation: 'start' });
  envelope.payload.operation = 'power_off';
  await rejects(runtime.accept(envelope), 'NUV_AGENT_COMMAND_TAMPERED');
  await rejects(runtime.accept({ ...issue(), signature: 'forged' }), 'NUV_AGENT_COMMAND_TAMPERED');
  assert.equal(executed.length, 0);
});

test('an expired command is refused and not executed', async (t) => {
  const { runtime, issue, time, executed } = fixture(t);
  const envelope = issue({ ttlMs: 60_000 });
  time.advance(60_001);
  await rejects(runtime.accept(envelope), 'NUV_AGENT_COMMAND_EXPIRED');
  assert.equal(executed.length, 0);
});

test('a command is accepted until the moment it expires', async (t) => {
  const { runtime, issue, time } = fixture(t);
  const envelope = issue({ ttlMs: 60_000 });
  time.advance(59_999);
  assert.equal((await runtime.accept(envelope)).status, 'completed');
});

test('replay: the same command is executed only once', async (t) => {
  const { runtime, issue, executed } = fixture(t);
  const envelope = issue();
  await runtime.accept(envelope);
  await rejects(runtime.accept(envelope), 'NUV_AGENT_COMMAND_REPLAYED');
  await rejects(runtime.accept(structuredClone(envelope)), 'NUV_AGENT_COMMAND_REPLAYED');
  assert.equal(executed.length, 1);
});

test('missing or malformed envelopes are refused', async (t) => {
  const { runtime } = fixture(t);
  await rejects(runtime.accept(undefined), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
  await rejects(runtime.accept({}), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
  await rejects(runtime.accept({ payload: {} }), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
});

test('a failing executor is reported as a failed result with its code, not thrown', async (t) => {
  const { runtime, issue } = fixture(t, { executor: { execute: async () => { throw Object.assign(new Error('VM is locked'), { code: 'NUV_VM_LOCKED' }); } } });
  const result = await runtime.accept(issue());
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.result, { code: 'NUV_VM_LOCKED', message: 'VM is locked' });
});

test('a failed command is still consumed: it cannot be replayed to retry it', async (t) => {
  const { runtime, issue } = fixture(t, { executor: { execute: async () => { throw new Error('nope'); } } });
  const envelope = issue();
  assert.equal((await runtime.accept(envelope)).status, 'failed');
  await rejects(runtime.accept(envelope), 'NUV_AGENT_COMMAND_REPLAYED');
});

test('heartbeats carry the agent identity, version, inventory and time', (t) => {
  const { runtime, agentId } = fixture(t);
  const beat = runtime.heartbeat({ version: '0.1.46', inventory: [{ id: 'vm' }] });
  assert.equal(beat.agentId, agentId);
  assert.equal(beat.observedAt, new Date(NOW).toISOString());
});

// The deployed agent (agent-service.cjs) has its own command admission with the same guarantees; see agent-service-commands.test.js.

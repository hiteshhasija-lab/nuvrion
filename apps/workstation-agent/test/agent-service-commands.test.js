import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AgentRegistry } from '../../../modules/agents/src/agent-registry.js';

// Tests the command path of the deployed agent (agent-service.cjs), as opposed to the reference runtime class.
const agent = createRequire(import.meta.url)('../src/agent-service.cjs');
const NOW = Date.parse('2026-10-06T00:00:00Z');

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  agent.clearCommandLedger();
  const registry = new AgentRegistry();
  const enroll = () => registry.enroll({ token: registry.createEnrollmentToken({ createdBy: 'admin' }).token, name: 'TECHY' });
  const mine = enroll(), other = enroll();
  const config = { identity: { agentId: mine.agentId, secret: mine.secret } };
  return { registry, config, mine, other, issue: (over = {}, to = mine.agentId) => registry.createCommand(to, { operation: 'start', targetId: 'D:\\VMs\\A\\A.vmx', ...over }) };
}
const counted = (result = { code: 'NUV_DONE' }) => { const run = async () => { run.calls++; if (result instanceof Error) throw result; return result; }; run.calls = 0; return run; };
const rejectsWith = (promise, code) => assert.rejects(promise, e => e.code === code);
const captureLog = () => { const lines = [], write = process.stdout.write; process.stdout.write = chunk => { lines.push(String(chunk)); return true; }; return { lines, stop: () => { process.stdout.write = write; } }; };

test('a valid command is admitted and returns its payload', (t) => {
  const { config, issue } = fixture(t);
  const envelope = issue({ operation: 'stop' });
  assert.deepEqual(agent.validateCommandEnvelope(config, envelope), envelope.payload);
});

test('a command addressed to another agent is refused', (t) => {
  const { config, issue, other } = fixture(t);
  assert.throws(() => agent.validateCommandEnvelope(config, issue({}, other.agentId)), e => e.code === 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
});

test('missing, empty or malformed envelopes are refused', (t) => {
  const { config } = fixture(t);
  for (const bad of [undefined, null, {}, { payload: {} }, { payload: { agentId: 'x' } }]) {
    assert.throws(() => agent.validateCommandEnvelope(config, bad), e => e.code === 'NUV_AGENT_COMMAND_WRONG_RECIPIENT', JSON.stringify(bad));
  }
});

test('a tampered payload or signature is refused', (t) => {
  const { config, issue } = fixture(t);
  const forged = issue(); forged.payload.operation = 'power_off';
  assert.throws(() => agent.validateCommandEnvelope(config, forged), e => e.code === 'NUV_AGENT_COMMAND_TAMPERED');
  assert.throws(() => agent.validateCommandEnvelope(config, { ...issue(), signature: 'forged' }), e => e.code === 'NUV_AGENT_COMMAND_TAMPERED');
  const unsigned = issue(); delete unsigned.signature;
  assert.throws(() => agent.validateCommandEnvelope(config, unsigned), e => e.code === 'NUV_AGENT_COMMAND_TAMPERED');
});

test('a command signed with a different secret is refused', (t) => {
  const { config, issue } = fixture(t);
  assert.throws(() => agent.validateCommandEnvelope({ identity: { ...config.identity, secret: 'rotated-away' } }, issue()), e => e.code === 'NUV_AGENT_COMMAND_TAMPERED'); // secret-scan:allow (fake test credential)
});

test('a command is valid until the instant it expires', (t) => {
  const { config, issue } = fixture(t);
  const envelope = issue({ ttlMs: 60_000 });
  t.mock.timers.tick(59_999);
  assert.ok(agent.validateCommandEnvelope(config, envelope));
  t.mock.timers.tick(1);
  assert.throws(() => agent.validateCommandEnvelope(config, envelope), e => e.code === 'NUV_AGENT_COMMAND_EXPIRED');
});

test('each command runs at most once: a second delivery gets the original result without running again', async (t) => {
  const { config, issue } = fixture(t);
  const run = counted({ code: 'NUV_DONE', n: 1 }), envelope = issue();
  const first = await agent.executeOnce(config, envelope, run);
  const second = await agent.executeOnce(config, structuredClone(envelope), run);
  assert.deepEqual(first, { code: 'NUV_DONE', n: 1 });
  assert.deepEqual(second, first);
  assert.equal(run.calls, 1);
});

test('simultaneous deliveries of one command share a single run', async (t) => {
  const { config, issue } = fixture(t);
  const run = counted(), envelope = issue();
  await Promise.all([agent.executeOnce(config, envelope, run), agent.executeOnce(config, envelope, run), agent.executeOnce(config, envelope, run)]);
  assert.equal(run.calls, 1);
});

test('a failed command is consumed: redelivery returns the same failure and does not retry the operation', async (t) => {
  const { config, issue } = fixture(t);
  const run = counted(Object.assign(new Error('VM is locked'), { code: 'NUV_VM_LOCKED' })), envelope = issue();
  await rejectsWith(agent.executeOnce(config, envelope, run), 'NUV_VM_LOCKED');
  await rejectsWith(agent.executeOnce(config, envelope, run), 'NUV_VM_LOCKED');
  assert.equal(run.calls, 1);
});

test('different commands each run once, even for the same VM and operation', async (t) => {
  const { config, issue } = fixture(t);
  const run = counted();
  await agent.executeOnce(config, issue(), run); await agent.executeOnce(config, issue(), run);
  assert.equal(run.calls, 2);
});

test('refused commands never reach the operation and are not remembered', async (t) => {
  const { config, issue, other } = fixture(t);
  const run = counted(), forged = issue(); forged.payload.operation = 'power_off';
  await rejectsWith(agent.executeOnce(config, issue({}, other.agentId), run), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
  await rejectsWith(agent.executeOnce(config, forged, run), 'NUV_AGENT_COMMAND_TAMPERED');
  const expired = issue({ ttlMs: 1000 }); t.mock.timers.tick(1001);
  await rejectsWith(agent.executeOnce(config, expired, run), 'NUV_AGENT_COMMAND_EXPIRED');
  assert.equal(run.calls, 0);
  assert.equal(agent.commandLedgerSize(), 0);
});

test('the ledger forgets a command once it has expired plus a grace period, so it cannot grow without bound', async (t) => {
  const { config, issue } = fixture(t);
  await agent.executeOnce(config, issue({ ttlMs: 60_000 }), counted());
  assert.equal(agent.commandLedgerSize(), 1);
  t.mock.timers.tick(60_000 + 4 * 60_000);
  await agent.executeOnce(config, issue({ ttlMs: 60_000 }), counted());
  assert.equal(agent.commandLedgerSize(), 2, 'still inside the grace period');
  t.mock.timers.tick(2 * 60_000);
  await agent.executeOnce(config, issue({ ttlMs: 60_000 }), counted());
  assert.equal(agent.commandLedgerSize(), 2, 'the first command has been pruned');
});

test('a lost acknowledgement is safe: the redelivered command is acknowledged with the original result and does not run again', async (t) => {
  const { config, issue } = fixture(t);
  const run = counted({ code: 'NUV_DONE' }), envelope = issue(), acknowledged = [];
  const executeCommand = command => agent.executeOnce(config, command, run);
  let networkUp = false;
  const acknowledge = async (command, status, result) => { if (!networkUp) throw new Error('network down'); acknowledged.push([command.payload.commandId, status, result]); };
  await assert.rejects(() => agent.runCommandBatch([envelope], { executeCommand, acknowledge }), /network down/);
  networkUp = true;
  const [redelivered] = await agent.runCommandBatch([envelope], { executeCommand, acknowledge });
  assert.equal(run.calls, 1, 'the operation ran once');
  assert.equal(redelivered.status, 'completed');
  assert.deepEqual(acknowledged, [[envelope.payload.commandId, 'completed', { code: 'NUV_DONE' }]]);
});

test('the deployed execute() applies the checks before any operation runs', async (t) => {
  const { config, issue, other } = fixture(t);
  const forged = issue(); forged.payload.targetId = 'D:\\VMs\\Other\\Other.vmx';
  await rejectsWith(agent.execute(config, issue({}, other.agentId)), 'NUV_AGENT_COMMAND_WRONG_RECIPIENT');
  await rejectsWith(agent.execute(config, forged), 'NUV_AGENT_COMMAND_TAMPERED');
  const expired = issue({ ttlMs: 1000 }); t.mock.timers.tick(1001);
  await rejectsWith(agent.execute(config, expired), 'NUV_AGENT_COMMAND_EXPIRED');
});

test('the deployed execute() runs a command once and logs a redelivery', async (t) => {
  const { config, issue } = fixture(t);
  // a media request with a malformed target fails inside the operation, after admission, without touching VMware
  const envelope = issue({ operation: 'media.browse', targetId: '{not json' });
  const log = captureLog();
  try {
    await rejectsWith(agent.execute(config, envelope), 'NUV_MEDIA_REQUEST_INVALID');
    assert.equal(log.lines.filter(l => l.includes('agent.command.duplicate')).length, 0);
    await rejectsWith(agent.execute(config, envelope), 'NUV_MEDIA_REQUEST_INVALID');
  } finally { log.stop(); }
  const duplicates = log.lines.filter(l => l.includes('agent.command.duplicate'));
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0], new RegExp(envelope.payload.commandId));
});

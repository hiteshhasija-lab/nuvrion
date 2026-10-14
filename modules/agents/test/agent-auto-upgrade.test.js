import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentUpgradeService } from '../src/agent-upgrade-service.js';
import { AgentArtifactStore } from '../src/agent-artifact-store.js';
import { AgentUpgradePolicies, normalizePolicy, isWithinWindow, AgentPolicyError } from '../src/agent-upgrade-policies.js';
import { runAutoUpgradeCycle } from '../src/agent-auto-upgrade.js';
import { isNewerAgentVersion, parseAgentVersion } from '../src/agent-versions.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

async function world(t, { agentList = [{ id: A, version: '0.1.50-lab.1', status: 'online' }] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nuvrion-auto-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentArtifactStore({ directory }), upgrades = new AgentUpgradeService(), policies = new AgentUpgradePolicies();
  const registry = new Map(agentList.map(agent => [agent.id, { name: agent.id.slice(0, 4), ...agent }]));
  const agents = { agent: async id => registry.get(id) ?? null };
  const events = [];
  let clock = new Date('2026-10-14T15:00:00Z');
  const noticed = new Set();
  const w = {
    store, upgrades, policies, agents, registry, events, noticed,
    setNow: value => { clock = new Date(value); },
    build: async (version, { file = true } = {}) => {
      const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.from(`agent ${version}`)]), sha256 = createHash('sha256').update(bytes).digest('hex');
      if (file) await writeFile(join(directory, sha256), bytes);
      return upgrades.registerRelease({ version, artifactUrl: `https://nuvrion.example/api/v1/agent-upgrades/artifacts/${sha256}`, sha256, sizeBytes: bytes.length });
    },
    on: (agentId, over = {}) => policies.set(agentId, { autoUpgrade: true, ...over }),
    cycle: () => runAutoUpgradeCycle({ agents, upgrades, policies, store, now: () => clock, noticed, record: async event => { events.push(event); } })
  };
  return w;
}

test('versions are compared as the agent compares them', () => {
  assert.deepEqual(parseAgentVersion('0.1.51-lab.1'), [0, 1, 51]);
  assert.equal(isNewerAgentVersion('0.1.51-lab.1', '0.1.50-lab.1'), true);
  assert.equal(isNewerAgentVersion('0.1.50-lab.2', '0.1.50-lab.1'), false);
  assert.equal(isNewerAgentVersion('0.1.9', '0.1.10'), false);
  assert.equal(isNewerAgentVersion('x', '0.1.1'), false);
});

test('a policy needs a true/false switch, both ends of a window or neither, valid times and a known time zone', () => {
  assert.deepEqual(normalizePolicy({ autoUpgrade: true }), { autoUpgrade: true, windowStart: null, windowEnd: null, windowTimezone: 'UTC' });
  assert.deepEqual(normalizePolicy({ autoUpgrade: false, windowStart: '22:00', windowEnd: '05:30', windowTimezone: 'America/Chicago' }),
    { autoUpgrade: false, windowStart: '22:00', windowEnd: '05:30', windowTimezone: 'America/Chicago' });
  for (const bad of [null, {}, { autoUpgrade: 'yes' }, { autoUpgrade: true, windowStart: '22:00' }, { autoUpgrade: true, windowEnd: '05:00' }, { autoUpgrade: true, windowStart: '25:00', windowEnd: '05:00' },
    { autoUpgrade: true, windowStart: '2200', windowEnd: '0500' }, { autoUpgrade: true, windowStart: '01:00', windowEnd: '02:00', windowTimezone: 'Mars/Olympus' }]) {
    assert.throws(() => normalizePolicy(bad), error => error instanceof AgentPolicyError && error.code === 'NUV_AGENT_UPGRADE_POLICY_INVALID', JSON.stringify(bad));
  }
});

test('a window is judged in its own time zone, may cross midnight, and no window means always', () => {
  const policy = (windowStart, windowEnd, windowTimezone = 'UTC') => ({ windowStart, windowEnd, windowTimezone });
  assert.equal(isWithinWindow({}, new Date('2026-10-14T12:00:00Z')), true);
  assert.equal(isWithinWindow(policy('01:00', '05:00'), new Date('2026-10-14T03:00:00Z')), true);
  assert.equal(isWithinWindow(policy('01:00', '05:00'), new Date('2026-10-14T05:00:00Z')), false, 'the end is exclusive');
  assert.equal(isWithinWindow(policy('01:00', '05:00'), new Date('2026-10-14T00:59:00Z')), false);
  assert.equal(isWithinWindow(policy('22:00', '05:00'), new Date('2026-10-14T23:30:00Z')), true, 'crosses midnight: evening');
  assert.equal(isWithinWindow(policy('22:00', '05:00'), new Date('2026-10-14T04:00:00Z')), true, 'crosses midnight: morning');
  assert.equal(isWithinWindow(policy('22:00', '05:00'), new Date('2026-10-14T12:00:00Z')), false);
  assert.equal(isWithinWindow(policy('08:00', '08:00'), new Date('2026-10-14T20:00:00Z')), true, 'equal ends are the whole day');
  // 03:00 UTC on 14 October is 22:00 the evening before in Chicago (CDT, UTC-5)
  assert.equal(isWithinWindow(policy('21:00', '23:00', 'America/Chicago'), new Date('2026-10-14T03:00:00Z')), true);
  assert.equal(isWithinWindow(policy('21:00', '23:00', 'UTC'), new Date('2026-10-14T03:00:00Z')), false);
});

test('an agent with automatic upgrades on, online and behind, gets the newest build on the platform, as an ordinary staged deployment', async t => {
  const w = await world(t);
  await w.build('0.1.51-lab.1'); const newest = await w.build('0.1.52-lab.1');
  await w.on(A);
  const result = await w.cycle();
  assert.deepEqual(result.staged.map(item => [item.agentId, item.version]), [[A, '0.1.52-lab.1']]);
  const pending = w.upgrades.pending(A);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].release.manifest.releaseId, newest.manifest.releaseId);
  assert.deepEqual(w.events.map(event => [event.action, event.agentId, event.outcome, event.detail.version]), [['agent.upgrade_auto_staged', A, 'succeeded', '0.1.52-lab.1']]);
  const again = await w.cycle();
  assert.deepEqual([again.staged.length, again.skipped[0].reason], [0, 'another_upgrade_in_progress'], 'running again does not stage it twice');
});

test('nothing happens for an agent without the switch, an offline or revoked one, one that is current or ahead, or when no build is on the platform', async t => {
  const w = await world(t, { agentList: [{ id: A, version: '0.1.50-lab.1', status: 'offline' }, { id: B, version: '0.1.52-lab.1', status: 'online' }] });
  assert.deepEqual((await w.cycle()).staged, [], 'nothing enabled');
  await w.on(A); await w.on(B);
  assert.deepEqual((await w.cycle()).staged, [], 'no build at all');
  await w.build('0.1.51-lab.1');
  const result = await w.cycle();
  assert.deepEqual(result.staged, [], 'A is offline, B is ahead of the build');
  assert.deepEqual(result.skipped, [{ agentId: A, reason: 'agent_not_online' }]);
  await w.policies.set(A, { autoUpgrade: false });
  w.registry.get(A).status = 'online';
  assert.deepEqual((await w.cycle()).staged, [], 'switched off');
  w.registry.get(A).status = 'revoked';
  await w.on(A);
  assert.deepEqual((await w.cycle()).staged, [], 'revoked');
});

test('a build whose file is not on the platform is never offered; the newest one that is there is', async t => {
  const w = await world(t);
  await w.build('0.1.51-lab.1'); await w.build('0.1.53-lab.1', { file: false });
  await w.on(A);
  assert.deepEqual((await w.cycle()).staged.map(item => item.version), ['0.1.51-lab.1']);
});

test('only inside the window, in the policy\'s time zone', async t => {
  const w = await world(t);
  await w.build('0.1.51-lab.1');
  await w.on(A, { windowStart: '01:00', windowEnd: '05:00', windowTimezone: 'America/Chicago' });
  w.setNow('2026-10-14T15:00:00Z');   // 10:00 in Chicago
  const outside = await w.cycle();
  assert.deepEqual([outside.staged.length, outside.skipped[0].reason], [0, 'outside_window']);
  w.setNow('2026-10-14T08:00:00Z');   // 03:00 in Chicago
  assert.equal((await w.cycle()).staged.length, 1);
});

test('one upgrade in flight across all agents; the next agent goes only when the first has finished', async t => {
  const w = await world(t, { agentList: [{ id: A, version: '0.1.50-lab.1', status: 'online' }, { id: B, version: '0.1.50-lab.1', status: 'online' }] });
  await w.build('0.1.51-lab.1');
  await w.on(A); await w.on(B);
  const first = await w.cycle();
  assert.deepEqual(first.staged.map(item => item.agentId), [A], 'only one agent per cycle');
  assert.equal((await w.cycle()).staged.length, 0, 'while it is unfinished nobody else is started');
  w.upgrades.report(A, first.staged[0].deploymentId, { status: 'installed' });
  w.registry.get(A).version = '0.1.51-lab.1';
  const next = await w.cycle();
  assert.deepEqual(next.staged.map(item => item.agentId), [B]);
});

test('a build that failed, was rolled back or was cancelled on an agent is not tried again, is reported once, and a newer build is', async t => {
  const w = await world(t);
  const bad = await w.build('0.1.51-lab.1');
  await w.on(A);
  const first = await w.cycle();
  w.upgrades.report(A, first.staged[0].deploymentId, { status: 'rolled_back', rollbackVersion: '0.1.50-lab.1', detail: 'did not report healthy' });
  const blocked = await w.cycle();
  assert.deepEqual([blocked.staged.length, blocked.skipped[0].reason], [0, 'previous_attempt_failed']);
  await w.cycle(); await w.cycle();
  assert.equal(w.events.filter(event => event.action === 'agent.upgrade_auto_blocked').length, 1, 'said once, not every cycle');
  assert.equal(w.events.find(event => event.action === 'agent.upgrade_auto_blocked').outcome, 'warning');
  const fixed = await w.build('0.1.52-lab.1');
  const retry = await w.cycle();
  assert.deepEqual(retry.staged.map(item => item.version), ['0.1.52-lab.1']);
  assert.notEqual(retry.staged[0].version, bad.manifest.version);
  // an operator cancelling counts the same: a person decided against it
  w.upgrades.cancel(A, retry.staged[0].deploymentId, { detail: 'Cancelled by admin.' });
  assert.deepEqual((await w.cycle()).staged, []);
  void fixed;
});

test('the stored policy is returned as given and replaced as a whole', async () => {
  const policies = new AgentUpgradePolicies();
  assert.equal(await policies.get(A), null);
  const saved = await policies.set(A, { autoUpgrade: true, windowStart: '01:00', windowEnd: '05:00', windowTimezone: 'America/Chicago' }, { by: 'admin' });
  assert.deepEqual([saved.agentId, saved.autoUpgrade, saved.windowStart, saved.updatedBy], [A, true, '01:00', 'admin']);
  const replaced = await policies.set(A, { autoUpgrade: false });
  assert.deepEqual([replaced.autoUpgrade, replaced.windowStart, replaced.windowEnd, replaced.windowTimezone], [false, null, null, 'UTC']);
  assert.equal((await policies.list()).length, 1);
});

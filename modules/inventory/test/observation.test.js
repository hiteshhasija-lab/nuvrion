import test from 'node:test';
import assert from 'node:assert/strict';
import { assessObservation, presentResource, AGENT_STALE_AFTER_MS } from '../src/observation.js';

// A VM's stored power state is only as good as the last time its provider answered. These rules decide when it is a memory rather than an observation.
const NOW = Date.parse('2026-10-08T16:00:00Z');
const vm = (over = {}) => ({ resourceType: 'virtual_machine', lifecycleState: 'active', providerType: 'vmware_workstation', attributes: { powerState: 'running' }, providerMetadata: { agentVersion: '0.1.46', toolsStatus: 'Running' }, ...over });
const agentSeen = secondsAgo => ({ providerMetadata: { agentVersion: '0.1.46', toolsStatus: 'Running', agentObservedAt: new Date(NOW - secondsAgo * 1000).toISOString() } });
const enabled = resource => resource.capabilities.filter(c => c.enabled).map(c => c.operation).sort();

test('a healthy connection with a recent report is live', () => {
  assert.deepEqual(assessObservation(vm(agentSeen(5)), { healthState: 'healthy' }, NOW), { state: 'live', reason: null });
  assert.deepEqual(assessObservation(vm(), null, NOW), { state: 'live', reason: null }, 'a connection that cannot be looked up is not assumed unhealthy');
  assert.deepEqual(assessObservation(vm(), { healthState: 'unknown' }, NOW), { state: 'live', reason: null }, 'a connection that has not been checked yet is not assumed unhealthy');
  assert.deepEqual(assessObservation(vm(), { healthState: 'degraded' }, NOW), { state: 'live', reason: null });
});

test('a critical or unhealthy connection makes what we know stale, and says why', () => {
  assert.deepEqual(assessObservation(vm(), { healthState: 'critical', lastErrorCode: 'NUV_AGENT_OFFLINE' }, NOW), { state: 'stale', reason: 'NUV_AGENT_OFFLINE' });
  assert.deepEqual(assessObservation(vm(), { healthState: 'unhealthy' }, NOW), { state: 'stale', reason: 'connection_unhealthy' });
});

test('an agent that has not reported for more than two minutes makes it stale, exactly at the limit it is still live', () => {
  assert.equal(AGENT_STALE_AFTER_MS, 120_000);
  assert.equal(assessObservation(vm(agentSeen(120)), { healthState: 'healthy' }, NOW).state, 'live');
  assert.deepEqual(assessObservation(vm(agentSeen(121)), { healthState: 'healthy' }, NOW), { state: 'stale', reason: 'no_recent_agent_update' });
  assert.equal(assessObservation(vm({ providerMetadata: { agentObservedAt: 'not a date' } }), { healthState: 'healthy' }, NOW).state, 'live', 'an unreadable time is not treated as old');
});

test('only virtual machines have an observation status', () => {
  assert.equal(assessObservation({ resourceType: 'host', attributes: {} }, { healthState: 'critical' }, NOW).state, 'live');
});

test('a stale VM is presented with an unknown power state, its last known state, and every power operation available', () => {
  const live = presentResource(vm(), { healthState: 'healthy' }, NOW);
  assert.deepEqual([live.attributes.powerState, live.attributes.lastKnownPowerState, live.observation.state], ['running', undefined, 'live']);
  assert.deepEqual(enabled(live), ['pause', 'power_off', 'reboot_guest', 'restart', 'stop']);
  const stale = presentResource(vm(), { healthState: 'critical', lastErrorCode: 'NUV_AGENT_OFFLINE' }, NOW);
  assert.deepEqual([stale.attributes.powerState, stale.attributes.lastKnownPowerState, stale.observation], ['unknown', 'running', { state: 'stale', reason: 'NUV_AGENT_OFFLINE' }]);
  assert.deepEqual(enabled(stale), ['pause', 'power_off', 'reboot_guest', 'restart', 'start', 'stop']);
  assert.match(stale.capabilities.find(c => c.operation === 'start').advisory, /last known: running/);
});

test('presenting a resource does not change the resource it was given', () => {
  const original = vm();
  presentResource(original, { healthState: 'critical' }, NOW);
  assert.equal(original.attributes.powerState, 'running');
  assert.equal(original.observation, undefined);
});

test('a VM whose state was already unknown stays unknown without inventing a last known value', () => {
  const resource = presentResource(vm({ attributes: { powerState: 'unknown' } }), { healthState: 'critical' }, NOW);
  assert.deepEqual([resource.attributes.powerState, resource.attributes.lastKnownPowerState], ['unknown', undefined]);
});

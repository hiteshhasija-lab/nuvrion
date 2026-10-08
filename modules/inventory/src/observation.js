import { evaluateCapabilities } from './resource-capabilities.js';

// How current is what we know about a VM? The power state stored for a VM is only as good as the last time its provider answered. When the connection is critical or
// unhealthy (the lab or the host is off, the network is down, the agent is offline) or the agent has not reported for two minutes, the stored state is a memory, not
// an observation: the VM may have been started, stopped or paused by someone else since. In that case the state is reported as "unknown" (the last known value is kept
// beside it) and the power operations stay available, so a person is never locked out of acting by a state that is probably out of date; the provider is asked to do
// the work and the result is verified, as always.
export const AGENT_STALE_AFTER_MS = 120_000;
const UNREACHABLE = ['critical', 'unhealthy'];

export function assessObservation(resource, connection, now = Date.now()) {
  if (resource.resourceType !== 'virtual_machine') return { state: 'live', reason: null };
  if (connection && UNREACHABLE.includes(connection.healthState)) return { state: 'stale', reason: connection.lastErrorCode ?? 'connection_unhealthy' };
  const agentObservedAt = resource.providerMetadata?.agentObservedAt;
  if (agentObservedAt) {
    const age = now - Date.parse(agentObservedAt);
    if (Number.isFinite(age) && age > AGENT_STALE_AFTER_MS) return { state: 'stale', reason: 'no_recent_agent_update' };
  }
  return { state: 'live', reason: null };
}

// The resource as the API presents it: its observation status, the power state as "unknown" when stale (with the last known value kept), and the operations it allows.
export function presentResource(resource, connection, now = Date.now()) {
  const observation = assessObservation(resource, connection, now);
  const stale = observation.state === 'stale' && resource.attributes?.powerState && resource.attributes.powerState !== 'unknown';
  const presented = { ...resource, observation, ...(stale ? { attributes: { ...resource.attributes, powerState: 'unknown', lastKnownPowerState: resource.attributes.powerState } } : {}) };
  return { ...presented, capabilities: evaluateCapabilities(presented) };
}

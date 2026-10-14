import { isNewerAgentVersion } from './agent-versions.js';
import { isWithinWindow } from './agent-upgrade-policies.js';

// Upgrades agents whose administrator turned automatic upgrades on, when a newer build is on the platform. The rules are what keeps this safe to leave
// running:
//   - only agents with the policy switched on, and only online ones
//   - one upgrade in flight across all agents, so a bad build can never take out more than one
//   - only inside the agent's time window, when it has one
//   - never a build that already failed, was rolled back or was cancelled on that agent: it is left for a person to look at (reported once)
//   - the newest build only, and only if it is really on the platform
// Every upgrade it stages is the same signed, verified, self-reverting upgrade a person would start from the console.
export async function runAutoUpgradeCycle({ agents, upgrades, policies, store, now = () => new Date(), record = async () => {}, noticed = new Set() }) {
  const result = { staged: [], skipped: [] };
  const enabled = (await policies.list()).filter(policy => policy.autoUpgrade);
  if (!enabled.length) return result;

  const unfinished = await upgrades.listUnfinished();
  if (unfinished.length) { result.skipped.push({ reason: 'another_upgrade_in_progress' }); return result; }

  let newest = null;
  for (const release of await upgrades.listReleases({ limit: 200 })) {
    if (!(await store.has(release.manifest.sha256))) continue;
    if (!newest || isNewerAgentVersion(release.manifest.version, newest.manifest.version)) newest = release;
  }
  if (!newest) return result;

  for (const policy of enabled) {
    const agent = await agents.agent(policy.agentId);
    if (!agent || agent.status !== 'online') { result.skipped.push({ agentId: policy.agentId, reason: 'agent_not_online' }); continue; }
    if (!isNewerAgentVersion(newest.manifest.version, agent.version)) continue;
    if (!isWithinWindow(policy, now())) { result.skipped.push({ agentId: agent.id, reason: 'outside_window' }); continue; }

    const history = await upgrades.listDeployments(agent.id, { limit: 100 });
    if (history.some(item => item.releaseId === newest.manifest.releaseId && ['failed', 'rolled_back'].includes(item.status))) {
      result.skipped.push({ agentId: agent.id, reason: 'previous_attempt_failed' });
      const key = `${agent.id}:${newest.manifest.releaseId}`;
      if (!noticed.has(key)) {
        noticed.add(key);
        await record({ action: 'agent.upgrade_auto_blocked', agentId: agent.id, outcome: 'warning', detail: { version: newest.manifest.version, reason: 'This build already failed, was rolled back or was cancelled on this agent; automatic upgrades will not try it again.' } });
      }
      continue;
    }

    const deployment = await upgrades.stage(agent.id, newest.manifest.releaseId);
    result.staged.push({ agentId: agent.id, deploymentId: deployment.deploymentId, version: newest.manifest.version });
    await record({ action: 'agent.upgrade_auto_staged', agentId: agent.id, outcome: 'succeeded', detail: { deploymentId: deployment.deploymentId, releaseId: newest.manifest.releaseId, version: newest.manifest.version, from: agent.version } });
    break;   // one at a time: the next agent is considered after this upgrade has finished
  }
  return result;
}

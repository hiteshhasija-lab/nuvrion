export class AgentPolicyError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimeZone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

export function normalizePolicy(input) {
  if (!input || typeof input !== 'object' || typeof input.autoUpgrade !== 'boolean') throw new AgentPolicyError('NUV_AGENT_UPGRADE_POLICY_INVALID', 'autoUpgrade must be true or false.');
  const start = input.windowStart ?? null, end = input.windowEnd ?? null;
  if ((start === null) !== (end === null)) throw new AgentPolicyError('NUV_AGENT_UPGRADE_POLICY_INVALID', 'Give both ends of the time window, or neither.');
  if (start !== null && (!TIME.test(String(start)) || !TIME.test(String(end)))) throw new AgentPolicyError('NUV_AGENT_UPGRADE_POLICY_INVALID', 'Times are written HH:MM, 24 hours.');
  const timezone = input.windowTimezone ?? 'UTC';
  if (typeof timezone !== 'string' || !validTimeZone(timezone)) throw new AgentPolicyError('NUV_AGENT_UPGRADE_POLICY_INVALID', 'The time zone is not a known IANA time zone, such as America/Chicago.');
  return { autoUpgrade: input.autoUpgrade, windowStart: start, windowEnd: end, windowTimezone: timezone };
}

// Whether `date` falls inside the policy's window, in the policy's time zone. No window means always. A window whose end is earlier than its start
// crosses midnight, and one whose end equals its start is the whole day.
export function isWithinWindow(policy, date = new Date()) {
  if (!policy?.windowStart || !policy?.windowEnd) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: policy.windowTimezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const minutes = Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
  const at = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = at(policy.windowStart), end = at(policy.windowEnd);
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// In memory (development, tests); production uses PostgresAgentUpgradePolicies with the same behaviour.
export class AgentUpgradePolicies {
  #policies = new Map();
  async get(agentId) { const value = this.#policies.get(agentId); return value ? { ...value } : null; }
  async list() { return [...this.#policies.values()].map(value => ({ ...value })).sort((a, b) => a.agentId.localeCompare(b.agentId)); }
  async set(agentId, input, { by = null } = {}) {
    const policy = { agentId, ...normalizePolicy(input), updatedAt: new Date().toISOString(), updatedBy: by };
    this.#policies.set(agentId, policy);
    return { ...policy };
  }
}

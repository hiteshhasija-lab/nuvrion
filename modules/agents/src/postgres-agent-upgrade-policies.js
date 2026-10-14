import { normalizePolicy } from './agent-upgrade-policies.js';

const fromRow = row => row ? { agentId: row.agent_id, autoUpgrade: row.auto_upgrade, windowStart: row.window_start, windowEnd: row.window_end, windowTimezone: row.window_timezone,
  updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by } : null;

export class PostgresAgentUpgradePolicies {
  constructor(pool) { this.pool = pool; }
  async get(agentId) { return fromRow((await this.pool.query('SELECT * FROM agents.upgrade_policies WHERE agent_id=$1', [agentId])).rows[0]); }
  async list() { return (await this.pool.query('SELECT * FROM agents.upgrade_policies ORDER BY agent_id')).rows.map(fromRow); }
  async set(agentId, input, { by = null } = {}) {
    const policy = normalizePolicy(input);
    const row = (await this.pool.query(
      `INSERT INTO agents.upgrade_policies(agent_id,auto_upgrade,window_start,window_end,window_timezone,updated_by) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id) DO UPDATE SET auto_upgrade=EXCLUDED.auto_upgrade, window_start=EXCLUDED.window_start, window_end=EXCLUDED.window_end,
         window_timezone=EXCLUDED.window_timezone, updated_at=now(), updated_by=EXCLUDED.updated_by RETURNING *`,
      [agentId, policy.autoUpgrade, policy.windowStart, policy.windowEnd, policy.windowTimezone, by])).rows[0];
    return fromRow(row);
  }
}

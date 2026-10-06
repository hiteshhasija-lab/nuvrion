// Age-based pruning for the two history tables that otherwise grow without bound. (Metric samples already prune
// themselves in PostgresPerformanceService.record.) Rows are deleted in small batches so a first run over a large
// backlog never holds a long lock, and each connection always keeps its newest `keepRecent` rows regardless of age,
// so a connection that has been dead for months still shows how it last failed.
const IDENTIFIER = /^[a-z_]+(\.[a-z_]+)?$/;

export const RETENTION_TABLES = [
  { name: 'discovery_runs', table: 'inventory.discovery_runs', key: 'discovery_run_id', time: 'started_at', group: 'connection_id' },
  { name: 'health_events', table: 'connections.health_events', key: 'event_id', time: 'checked_at', group: 'connection_id' }
];

// NUVRION_RETENTION_DISCOVERY_DAYS (default 30) and NUVRION_RETENTION_HEALTH_EVENTS_DAYS (default 90); 0 turns that table off.
export function retentionPoliciesFromEnv(env = process.env) {
  const days = (value, fallback) => { const parsed = Number(value ?? fallback); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; };
  return RETENTION_TABLES.map(table => ({
    ...table,
    days: table.name === 'discovery_runs' ? days(env.NUVRION_RETENTION_DISCOVERY_DAYS, 30) : days(env.NUVRION_RETENTION_HEALTH_EVENTS_DAYS, 90)
  }));
}

export class RetentionService {
  constructor({ pool, policies, intervalMs = 6 * 60 * 60_000, startDelayMs = 60_000, batchSize = 5000, keepRecent = 100, now = () => Date.now(), onPruned = () => {}, onError = () => {} }) {
    for (const policy of policies) for (const field of [policy.table, policy.key, policy.time, policy.group]) {
      if (!IDENTIFIER.test(field)) throw new Error(`RETENTION_INVALID_IDENTIFIER: ${field}`);
    }
    Object.assign(this, { pool, policies, intervalMs, startDelayMs, batchSize, keepRecent, now, onPruned, onError });
    this.timer = null; this.firstRun = null; this.running = false;
  }

  async prunePolicy(policy, cutoff) {
    const { table, key, time, group } = policy;
    const sql = `WITH doomed AS (
      SELECT k FROM (SELECT ${key} AS k, ${time} AS t, row_number() OVER (PARTITION BY ${group} ORDER BY ${time} DESC) AS rn FROM ${table}) ranked
      WHERE t < $1 AND rn > $2 LIMIT $3)
      DELETE FROM ${table} WHERE ${key} IN (SELECT k FROM doomed)`;
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(sql, [cutoff, this.keepRecent, this.batchSize]);
      total += rowCount;
      if (rowCount < this.batchSize) return total;
    }
  }

  async run() {
    if (this.running) return null;
    this.running = true;
    const results = {};
    try {
      for (const policy of this.policies) {
        if (!(policy.days > 0)) continue;
        try {
          const pruned = await this.prunePolicy(policy, new Date(this.now() - policy.days * 86_400_000));
          results[policy.name] = pruned;
          if (pruned) this.onPruned(policy.name, pruned);
        } catch (error) { this.onError(error, policy); }
      }
      return results;
    } finally { this.running = false; }
  }

  start() {
    if (this.timer) return;
    this.firstRun = setTimeout(() => this.run(), this.startDelayMs);
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.firstRun.unref?.(); this.timer.unref?.();
  }

  close() {
    clearTimeout(this.firstRun); clearInterval(this.timer);
    this.timer = null; this.firstRun = null;
  }
}

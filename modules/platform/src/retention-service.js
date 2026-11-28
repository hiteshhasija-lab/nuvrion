// Age-based pruning for the history tables that otherwise grow without bound. Rows are deleted in small batches so a first run over a large
// backlog never holds a long lock. In the two history tables each connection always keeps its newest `keepRecent` rows regardless of age,
// so a connection that has been dead for months still shows how it last failed. The two sample tables keep nothing past their age: the
// services that record samples also delete old ones, but only while something is being recorded, so with every connection down the old
// samples stayed for ever until this job took them too.
import { RETENTION_DAYS as CAPACITY_RETENTION_DAYS } from '../../monitoring/src/capacity-rules.js';

const IDENTIFIER = /^[a-z_]+(\.[a-z_]+)?$/;

export const RETENTION_TABLES = [
  { name: 'discovery_runs', table: 'inventory.discovery_runs', key: 'discovery_run_id', time: 'started_at', group: 'connection_id' },
  { name: 'health_events', table: 'connections.health_events', key: 'event_id', time: 'checked_at', group: 'connection_id' }
];

// keepRecent 0: only age decides. capacity_samples has no single-column key, so its rows are picked by their physical address.
export const SAMPLE_TABLES = [
  { name: 'metric_samples', table: 'monitoring.vm_metric_samples', key: 'sample_id', time: 'observed_at', group: 'resource_id', keepRecent: 0 },
  { name: 'capacity_samples', table: 'monitoring.capacity_samples', key: 'ctid', time: 'observed_at', group: 'object_id', keepRecent: 0 }
];

// NUVRION_RETENTION_DISCOVERY_DAYS (default 30) and NUVRION_RETENTION_HEALTH_EVENTS_DAYS (default 90); 0 turns that table off. Metric samples follow
// NUVRION_METRIC_RETENTION_MS (default 7 days), the age the performance service itself uses, and capacity samples are kept as long as the forecasts need them.
export function retentionPoliciesFromEnv(env = process.env) {
  const days = (value, fallback) => { const parsed = Number(value ?? fallback); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; };
  const metricMs = Number(env.NUVRION_METRIC_RETENTION_MS ?? 7 * 86_400_000);
  const ages = {
    discovery_runs: days(env.NUVRION_RETENTION_DISCOVERY_DAYS, 30),
    health_events: days(env.NUVRION_RETENTION_HEALTH_EVENTS_DAYS, 90),
    metric_samples: Number.isFinite(metricMs) && metricMs > 0 ? metricMs / 86_400_000 : 7,
    capacity_samples: CAPACITY_RETENTION_DAYS
  };
  return [...RETENTION_TABLES, ...SAMPLE_TABLES].map(table => ({ ...table, days: ages[table.name] }));
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
    const keepRecent = policy.keepRecent ?? this.keepRecent;
    // with nothing to keep there is no need to rank every row of a large table
    const sql = keepRecent === 0 ? `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${time} < $1 LIMIT $2)` : `WITH doomed AS (
      SELECT k FROM (SELECT ${key} AS k, ${time} AS t, row_number() OVER (PARTITION BY ${group} ORDER BY ${time} DESC) AS rn FROM ${table}) ranked
      WHERE t < $1 AND rn > $2 LIMIT $3)
      DELETE FROM ${table} WHERE ${key} IN (SELECT k FROM doomed)`;
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(sql, keepRecent === 0 ? [cutoff, this.batchSize] : [cutoff, keepRecent, this.batchSize]);
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

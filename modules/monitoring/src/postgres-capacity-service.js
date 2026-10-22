// Datastore capacity samples in PostgreSQL: the same interface as CapacityService (the local mode); what is worth keeping and what a forecast says is decided by capacity-rules.js.
import { DAY_MS, METRICS, RETENTION_DAYS, SAMPLE_INTERVAL_MS, sanitizeReading } from './capacity-rules.js';

export class PostgresCapacityService {
  #lastPruneAt = 0;
  constructor(pool, { clock = Date.now, intervalMs = SAMPLE_INTERVAL_MS, retentionDays = RETENTION_DAYS } = {}) {
    this.pool = pool; this.clock = clock; this.intervalMs = intervalMs; this.retentionMs = retentionDays * DAY_MS;
  }

  async record(points) {
    let recorded = 0, skipped = 0;
    const cutoff = this.clock() - this.retentionMs;
    for (const point of points) {
      const reading = sanitizeReading(point), metric = point.metric ?? 'storage';
      if (!METRICS.includes(metric) || !reading || !point.objectId || reading.at < cutoff) { skipped++; continue; }
      // kept unless a reading of the same size is already within the interval (a change of size is always kept)
      const result = await this.pool.query(
        `INSERT INTO monitoring.capacity_samples (object_id, metric, observed_at, connection_id, capacity_bytes, free_bytes)
         SELECT $1, $7::text, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM monitoring.capacity_samples WHERE object_id = $1 AND metric = $7::text AND capacity_bytes = $4 AND observed_at > $2::timestamptz - make_interval(secs => $6) AND observed_at < $2::timestamptz + make_interval(secs => $6))
         ON CONFLICT (object_id, metric, observed_at) DO NOTHING`,
        [point.objectId, new Date(reading.at), point.connectionId ?? null, reading.capacityBytes, reading.freeBytes, this.intervalMs / 1000, metric]);
      if (result.rowCount) recorded++; else skipped++;
    }
    if (this.clock() - this.#lastPruneAt > 3_600_000) {
      this.#lastPruneAt = this.clock();
      await this.pool.query('DELETE FROM monitoring.capacity_samples WHERE observed_at < $1', [new Date(cutoff)]);
    }
    return { recorded, skipped };
  }

  async historyFor(objectIds, { sinceMs = 0, metric = 'storage' } = {}) {
    const out = new Map(objectIds.map(id => [id, []]));
    const ids = objectIds.filter(id => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return out;
    const result = await this.pool.query(
      'SELECT object_id, observed_at, capacity_bytes, free_bytes FROM monitoring.capacity_samples WHERE object_id = ANY($1::uuid[]) AND metric = $3 AND observed_at >= $2 ORDER BY object_id, observed_at',
      [ids, new Date(sinceMs), metric]);
    for (const row of result.rows) {
      const capacityBytes = Number(row.capacity_bytes);
      out.get(row.object_id)?.push({ at: new Date(row.observed_at).getTime(), capacityBytes, usedBytes: capacityBytes - Number(row.free_bytes) });
    }
    return out;
  }
}

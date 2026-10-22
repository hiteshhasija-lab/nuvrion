// Datastore capacity samples in a local file (the mode without PostgreSQL): the same interface as PostgresCapacityService. What is worth keeping and what a forecast says is decided
// by capacity-rules.js.
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DAY_MS, METRICS, RETENTION_DAYS, SAMPLE_INTERVAL_MS, sanitizeReading, worthKeeping } from './capacity-rules.js';

const keyOf = (objectId, metric) => (metric === 'storage' ? objectId : `${objectId}#${metric}`);   // storage keeps the key it always had, so an existing file is read as before

export class CapacityService {
  #samples = new Map();   // objectId -> [{ at, capacityBytes, usedBytes, connectionId }] ascending
  #file; #clock; #intervalMs; #retentionMs;
  constructor({ file = null, clock = Date.now, intervalMs = SAMPLE_INTERVAL_MS, retentionDays = RETENTION_DAYS } = {}) {
    this.#file = file; this.#clock = clock; this.#intervalMs = intervalMs; this.#retentionMs = retentionDays * DAY_MS;
    if (file && existsSync(file)) {
      try { for (const [id, list] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).samples ?? {})) this.#samples.set(id, list); } catch { /* an unreadable file starts a new history */ }
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ samples: Object.fromEntries(this.#samples) }), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  // points: [{ objectId, metric ('storage' by default, or 'cpu' or 'memory'), connectionId, capacityBytes, freeBytes, observedAt }]. Readings that cannot be trusted, or that are too close to one already kept, are skipped.
  async record(points) {
    let recorded = 0, skipped = 0;
    const cutoff = this.#clock() - this.#retentionMs;
    for (const point of points) {
      const reading = sanitizeReading(point), metric = point.metric ?? 'storage';
      const list = this.#samples.get(keyOf(point.objectId, metric)) ?? [];
      if (!METRICS.includes(metric) || !reading || !point.objectId || reading.at < cutoff || !worthKeeping(reading, list, this.#intervalMs)) { skipped++; continue; }
      list.push({ at: reading.at, capacityBytes: reading.capacityBytes, usedBytes: reading.usedBytes, connectionId: point.connectionId ?? null });
      list.sort((a, b) => a.at - b.at);
      this.#samples.set(keyOf(point.objectId, metric), list);
      recorded++;
    }
    for (const [id, list] of this.#samples) {
      const kept = list.filter(sample => sample.at >= cutoff);
      if (kept.length) this.#samples.set(id, kept); else this.#samples.delete(id);
    }
    if (recorded) this.#persist();
    return { recorded, skipped };
  }

  // The samples of each object since `sinceMs`: Map(objectId -> [{ at, capacityBytes, usedBytes }]).
  async historyFor(objectIds, { sinceMs = 0, metric = 'storage' } = {}) {
    const out = new Map();
    for (const id of objectIds) out.set(id, (this.#samples.get(keyOf(id, metric)) ?? []).filter(sample => sample.at >= sinceMs).map(({ at, capacityBytes, usedBytes }) => ({ at, capacityBytes, usedBytes })));
    return out;
  }
}

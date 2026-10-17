// The infrastructure objects of each connection for the local (file-backed) mode. The same interface as PostgresInfrastructureService; the rules are in infrastructure-rules.js.
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normaliseReport } from './infrastructure-rules.js';

const clone = value => structuredClone(value);
export class InfrastructureService {
  #objects = new Map(); #file;
  constructor({ file = null } = {}) {
    this.#file = file;
    if (file && existsSync(file)) this.#objects = new Map(JSON.parse(readFileSync(file, 'utf8')).objects ?? []);
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, objects: [...this.#objects] }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  // The provider's report for one connection: what it sees now. Objects not in it become "missing". Throws InfrastructureError (and changes nothing) for a bad report.
  async synchronize(connection, report) {
    const objects = normaliseReport(report), observedAt = new Date().toISOString(), seen = new Set();
    let created = 0, updated = 0, missing = 0;
    for (const item of objects) {
      const key = `${connection.id}:${item.kind}:${item.nativeId}`, prior = this.#objects.get(key);
      seen.add(key);
      this.#objects.set(key, { id: prior?.id ?? randomUUID(), connectionId: connection.id, providerType: connection.providerType, ...item, lifecycleState: 'active',
        observedAt, firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, missingSince: null });
      prior ? updated++ : created++;
    }
    for (const [key, object] of this.#objects) {
      if (object.connectionId === connection.id && !seen.has(key) && object.lifecycleState === 'active') { object.lifecycleState = 'missing'; object.missingSince = observedAt; missing++; }
    }
    this.#persist();
    return { discovered: objects.length, created, updated, missing };
  }

  async list({ connectionId, kind, lifecycleState } = {}) {
    return [...this.#objects.values()].filter(object => (!connectionId || object.connectionId === connectionId) && (!kind || object.kind === kind) && (!lifecycleState || object.lifecycleState === lifecycleState))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map(clone);
  }

  async retireConnection(connectionId) {
    let retired = 0;
    for (const object of this.#objects.values()) if (object.connectionId === connectionId && object.lifecycleState !== 'deleted') { object.lifecycleState = 'deleted'; object.missingSince ??= new Date().toISOString(); retired++; }
    if (retired) this.#persist();
    return retired;
  }
}

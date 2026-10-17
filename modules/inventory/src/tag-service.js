// Nuvrion's own resource tags for the local (file-backed) mode. The same interface as PostgresTagService; the rules are in tag-rules.js.
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseTagOperation, planTagChanges } from './tag-rules.js';

export class TagService {
  #tags = new Map();   // resourceId -> Map key -> value
  #file;
  constructor({ file = null } = {}) {
    this.#file = file;
    if (file && existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      for (const [id, entries] of state.tags ?? []) this.#tags.set(id, new Map(entries));
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, tags: [...this.#tags].map(([id, map]) => [id, [...map]]) }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  // resourceIds -> Map resourceId -> [{ key, value, source: 'nuvrion' }] (resources without tags are absent)
  async forResources(resourceIds) {
    const result = new Map();
    for (const id of resourceIds) {
      const map = this.#tags.get(id);
      if (map?.size) result.set(id, [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value, source: 'nuvrion' })));
    }
    return result;
  }

  // body is validated here (parseTagOperation); the caller has checked that every resource exists. All or nothing.
  async apply(body) {
    const operation = parseTagOperation(body);
    const plan = planTagChanges(this.#tags, operation);
    for (const entry of plan) if (entry.changedAnything) {
      if (entry.after.length) this.#tags.set(entry.resourceId, new Map(entry.after.map(({ key, value }) => [key, value])));
      else this.#tags.delete(entry.resourceId);
    }
    if (plan.some(entry => entry.changedAnything)) this.#persist();
    return plan;
  }

  // Every key in use with its values and how many resources carry each: [{ key, resourceCount, values: [{ value, count }] }]
  async catalog() {
    const keys = new Map();
    for (const map of this.#tags.values()) for (const [key, value] of map) {
      const entry = keys.get(key) ?? { key, resourceCount: 0, values: new Map() };
      entry.resourceCount += 1; entry.values.set(value, (entry.values.get(value) ?? 0) + 1); keys.set(key, entry);
    }
    return [...keys.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(entry => ({ key: entry.key, resourceCount: entry.resourceCount,
      values: [...entry.values].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, count]) => ({ value, count })) }));
  }

  // Tags of a resource that no longer exists are not kept.
  async forget(resourceIds) {
    let removed = 0;
    for (const id of resourceIds) if (this.#tags.delete(id)) removed += 1;
    if (removed) this.#persist();
    return removed;
  }
}

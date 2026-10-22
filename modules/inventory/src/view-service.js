// Saved views in a local file (the mode without PostgreSQL): the same interface as PostgresViewService. A person sees and changes only their own views.
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { LIMITS, ViewError, parseChange, parseCreate } from './view-rules.js';

const clone = value => structuredClone(value);
const iso = ms => new Date(ms).toISOString();
const publicView = ({ userId, ...rest }) => clone(rest);

export class ViewService {
  #views = new Map(); #file; #clock;
  constructor({ file = null, clock = Date.now } = {}) {
    this.#file = file; this.#clock = clock;
    if (file && existsSync(file)) {
      try { for (const item of JSON.parse(readFileSync(file, 'utf8')).views ?? []) this.#views.set(item.id, item); } catch { /* an unreadable file starts again */ }
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ views: [...this.#views.values()] }), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
  #mine(userId) { return [...this.#views.values()].filter(item => item.userId === userId); }
  #checkName(userId, name, exceptId = null) {
    if (this.#mine(userId).some(item => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) throw new ViewError(`You already have a view named "${name}".`, 'NUV_VIEW_EXISTS');
  }

  async listViews(userId) { return this.#mine(userId).sort((a, b) => a.name.localeCompare(b.name)).map(publicView); }
  async getView(userId, id) { const item = this.#views.get(id); return item && item.userId === userId ? publicView(item) : null; }
  async createView(userId, input, now = this.#clock()) {
    const { name, view } = parseCreate(input);
    if (this.#mine(userId).length >= LIMITS.perPerson) throw new ViewError(`You may keep at most ${LIMITS.perPerson} views.`, 'NUV_VIEW_LIMIT');
    this.#checkName(userId, name);
    const item = { id: randomUUID(), userId, scope: 'inventory', name, view, rowVersion: 1, createdAt: iso(now), updatedAt: iso(now) };
    this.#views.set(item.id, item); this.#persist();
    return publicView(item);
  }
  async updateView(userId, id, patch, expectedVersion, now = this.#clock()) {
    const item = this.#views.get(id);
    if (!item || item.userId !== userId) return null;
    if (item.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const change = parseChange(patch);
    if (change.name !== undefined) this.#checkName(userId, change.name, id);
    Object.assign(item, change, { rowVersion: item.rowVersion + 1, updatedAt: iso(now) });
    this.#persist();
    return publicView(item);
  }
  async deleteView(userId, id) {
    const item = this.#views.get(id);
    if (!item || item.userId !== userId) return null;
    this.#views.delete(id); this.#persist();
    return { deleted: 1 };
  }
}

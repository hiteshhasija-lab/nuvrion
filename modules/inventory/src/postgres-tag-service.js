// Nuvrion's own resource tags in PostgreSQL (inventory.resource_tags, migration 0032). The same interface as TagService; the rules are in tag-rules.js.
import { parseTagOperation, planTagChanges } from './tag-rules.js';

export class PostgresTagService {
  constructor(pool) { this.pool = pool; }

  async forResources(resourceIds) {
    const result = new Map();
    if (!resourceIds.length) return result;
    const rows = (await this.pool.query('SELECT resource_id, tag_key, tag_value FROM inventory.resource_tags WHERE resource_id = ANY($1::uuid[]) ORDER BY tag_key', [resourceIds])).rows;
    for (const row of rows) {
      const list = result.get(row.resource_id) ?? [];
      list.push({ key: row.tag_key, value: row.tag_value, source: 'nuvrion' });
      result.set(row.resource_id, list);
    }
    return result;
  }

  // All or nothing, in one transaction; tag writes are serialised so two requests cannot together exceed a resource's limit.
  async apply(body) {
    const operation = parseTagOperation(body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nuvrion.resource_tags'))");
      const rows = (await client.query('SELECT resource_id, tag_key, tag_value FROM inventory.resource_tags WHERE resource_id = ANY($1::uuid[])', [operation.resourceIds])).rows;
      const existing = new Map();
      for (const row of rows) { const map = existing.get(row.resource_id) ?? new Map(); map.set(row.tag_key, row.tag_value); existing.set(row.resource_id, map); }
      const plan = planTagChanges(existing, operation);
      for (const entry of plan) {
        for (const { key, value } of [...entry.added, ...entry.changed]) {
          await client.query(`INSERT INTO inventory.resource_tags (resource_id, tag_key, tag_value) VALUES ($1, $2, $3)
            ON CONFLICT (resource_id, tag_key) DO UPDATE SET tag_value = EXCLUDED.tag_value, updated_at = now()`, [entry.resourceId, key, value]);
        }
        if (entry.removed.length) await client.query('DELETE FROM inventory.resource_tags WHERE resource_id = $1 AND tag_key = ANY($2::text[])', [entry.resourceId, entry.removed.map(item => item.key)]);
      }
      await client.query('COMMIT');
      return plan;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async catalog() {
    const rows = (await this.pool.query(`SELECT tag_key, tag_value, count(*)::int AS n FROM inventory.resource_tags GROUP BY tag_key, tag_value ORDER BY tag_key, tag_value`)).rows;
    const keys = new Map();
    for (const row of rows) {
      const entry = keys.get(row.tag_key) ?? { key: row.tag_key, resourceCount: 0, values: [] };
      entry.resourceCount += row.n; entry.values.push({ value: row.tag_value, count: row.n }); keys.set(row.tag_key, entry);
    }
    return [...keys.values()];
  }

  async forget() { return 0; }   // rows go with their resource (ON DELETE CASCADE)
}

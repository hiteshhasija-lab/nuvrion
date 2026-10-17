// The infrastructure objects of each connection in PostgreSQL (inventory.infrastructure_objects, migration 0033). The same interface as InfrastructureService.
import { normaliseReport } from './infrastructure-rules.js';

const map = row => ({ id: row.object_id, connectionId: row.connection_id, providerType: row.provider_type, kind: row.kind, nativeId: row.native_id, name: row.name, parentNativeId: row.parent_native_id,
  attributes: row.attributes, lifecycleState: row.lifecycle_state, observedAt: row.observed_at, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, missingSince: row.missing_since });
const SELECT = 'SELECT o.*, c.provider_type FROM inventory.infrastructure_objects o JOIN connections.provider_connections c ON c.connection_id = o.connection_id';

export class PostgresInfrastructureService {
  constructor(pool) { this.pool = pool; }

  async synchronize(connection, report) {
    const objects = normaliseReport(report), client = await this.pool.connect(), now = new Date();
    let created = 0, updated = 0;
    try {
      await client.query('BEGIN');
      for (const item of objects) {
        const result = await client.query(`INSERT INTO inventory.infrastructure_objects (connection_id, kind, native_id, name, parent_native_id, attributes, lifecycle_state, observed_at, first_seen_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, $7)
          ON CONFLICT (connection_id, kind, native_id) DO UPDATE SET name = EXCLUDED.name, parent_native_id = EXCLUDED.parent_native_id, attributes = EXCLUDED.attributes,
            lifecycle_state = 'active', missing_since = NULL, observed_at = EXCLUDED.observed_at, last_seen_at = EXCLUDED.last_seen_at
          RETURNING (xmax = 0) AS inserted`, [connection.id, item.kind, item.nativeId, item.name, item.parentNativeId, JSON.stringify(item.attributes), now]);
        result.rows[0].inserted ? created++ : updated++;
      }
      const seen = objects.map(item => `${item.kind}:${item.nativeId}`);
      const missing = (await client.query(`UPDATE inventory.infrastructure_objects SET lifecycle_state = 'missing', missing_since = $2
        WHERE connection_id = $1 AND lifecycle_state = 'active' AND NOT (kind || ':' || native_id = ANY($3::text[]))`, [connection.id, now, seen])).rowCount;
      await client.query('COMMIT');
      return { discovered: objects.length, created, updated, missing };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async list({ connectionId, kind, lifecycleState } = {}) {
    const rows = (await this.pool.query(`${SELECT} WHERE ($1::uuid IS NULL OR o.connection_id = $1) AND ($2::text IS NULL OR o.kind = $2) AND ($3::text IS NULL OR o.lifecycle_state = $3) ORDER BY o.kind, o.name`,
      [connectionId ?? null, kind ?? null, lifecycleState ?? null])).rows;
    return rows.map(map);
  }

  async retireConnection(connectionId) {
    return (await this.pool.query("UPDATE inventory.infrastructure_objects SET lifecycle_state = 'deleted', missing_since = COALESCE(missing_since, now()) WHERE connection_id = $1 AND lifecycle_state <> 'deleted'", [connectionId])).rowCount;
  }
}

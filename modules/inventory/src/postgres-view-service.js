// Saved views in PostgreSQL: the same interface as ViewService (the local mode). A person sees and changes only their own views.
import { LIMITS, ViewError, parseChange, parseCreate } from './view-rules.js';

const iso = value => (value ? new Date(value).toISOString() : null);
const UUID = /^[0-9a-f-]{36}$/i;
const COLUMNS = 'view_id,scope,name,view,row_version,created_at,updated_at';
const viewOf = row => ({ id: row.view_id, scope: row.scope, name: row.name, view: row.view, rowVersion: row.row_version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

export class PostgresViewService {
  constructor(pool, { clock = Date.now } = {}) { this.pool = pool; this.clock = clock; }

  async listViews(userId) { return (await this.pool.query(`SELECT ${COLUMNS} FROM inventory.saved_views WHERE user_id=$1 AND scope='inventory' ORDER BY lower(name)`, [userId])).rows.map(viewOf); }
  async getView(userId, id) {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM inventory.saved_views WHERE user_id=$1 AND view_id=$2`, [userId, id])).rows[0];
    return row ? viewOf(row) : null;
  }
  async createView(userId, input, now = this.clock()) {
    const { name, view } = parseCreate(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`saved_views:${userId}`]);
      if ((await client.query("SELECT count(*)::int n FROM inventory.saved_views WHERE user_id=$1 AND scope='inventory'", [userId])).rows[0].n >= LIMITS.perPerson) throw new ViewError(`You may keep at most ${LIMITS.perPerson} views.`, 'NUV_VIEW_LIMIT');
      const row = (await client.query(`INSERT INTO inventory.saved_views (user_id,name,view,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING ${COLUMNS}`, [userId, name, JSON.stringify(view), new Date(now)])).rows[0];
      await client.query('COMMIT');
      return viewOf(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') throw new ViewError(`You already have a view named "${name}".`, 'NUV_VIEW_EXISTS');
      throw error;
    } finally { client.release(); }
  }
  async updateView(userId, id, patch, expectedVersion, now = this.clock()) {
    const current = await this.getView(userId, id);
    if (!current) return null;
    if (current.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const change = parseChange(patch);
    const sets = ['row_version=row_version+1', 'updated_at=$3'], values = [userId, id, new Date(now)];
    if (change.name !== undefined) { values.push(change.name); sets.push(`name=$${values.length}`); }
    if (change.view !== undefined) { values.push(JSON.stringify(change.view)); sets.push(`view=$${values.length}`); }
    values.push(expectedVersion);
    try {
      const result = await this.pool.query(`UPDATE inventory.saved_views SET ${sets.join(',')} WHERE user_id=$1 AND view_id=$2 AND row_version=$${values.length} RETURNING ${COLUMNS}`, values);
      if (!result.rowCount) throw new Error('VERSION_CONFLICT');
      return viewOf(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new ViewError(`You already have a view named "${change.name}".`, 'NUV_VIEW_EXISTS');
      throw error;
    }
  }
  async deleteView(userId, id) {
    if (!UUID.test(id)) return null;
    const result = await this.pool.query('DELETE FROM inventory.saved_views WHERE user_id=$1 AND view_id=$2', [userId, id]);
    return result.rowCount ? { deleted: 1 } : null;
  }
}

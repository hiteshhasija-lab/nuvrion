// Threshold alerts in PostgreSQL: the same interface as AlertService (the local mode); what a rule is and when an alert fires or clears is decided by alert-rules.js.
import { AlertError, LIMITS, isOpen, parseRule, mergeRule, planEvaluation, feedFromAlerts } from './alert-rules.js';

const iso = value => (value ? new Date(value).toISOString() : null);
const RULE_COLUMNS = 'r.rule_id,r.name,r.description,r.metric,r.comparison,r.threshold,r.duration_minutes,r.severity,r.connection_id,r.enabled,r.row_version,r.created_by,r.created_at,r.updated_at';
const ruleOf = row => ({ id: row.rule_id, name: row.name, description: row.description, metric: row.metric, comparison: row.comparison, threshold: Number(row.threshold), durationMinutes: row.duration_minutes, severity: row.severity, connectionId: row.connection_id, enabled: row.enabled, rowVersion: row.row_version, createdBy: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const alertOf = row => ({ id: row.alert_id, ruleId: row.rule_id, ruleName: row.rule_name, metric: row.metric, comparison: row.comparison, threshold: Number(row.threshold), severity: row.severity, targetKind: row.target_kind, targetId: row.target_id, targetName: row.target_name, connectionId: row.connection_id, value: Number(row.value), status: row.status, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), acknowledgedAt: iso(row.acknowledged_at), acknowledgedBy: row.acknowledged_by, resolvedAt: iso(row.resolved_at), resolvedReason: row.resolved_reason });
const UNREAD_WINDOW_MS = 24 * 60 * 60_000;

export class PostgresAlertService {
  #pending = new Map();
  constructor(pool, { clock = Date.now } = {}) { this.pool = pool; this.clock = clock; }
  async #inTransaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  // ---- rules ----
  async listRules() {
    const result = await this.pool.query(`SELECT ${RULE_COLUMNS},(SELECT count(*)::int FROM monitoring.alerts a WHERE a.rule_id=r.rule_id AND a.status IN ('active','acknowledged')) open_count FROM monitoring.alert_rules r ORDER BY lower(r.name)`);
    return result.rows.map(row => ({ ...ruleOf(row), openAlertCount: row.open_count }));
  }
  async #oneRule(db, id) {
    const result = await db.query(`SELECT ${RULE_COLUMNS},(SELECT count(*)::int FROM monitoring.alerts a WHERE a.rule_id=r.rule_id AND a.status IN ('active','acknowledged')) open_count FROM monitoring.alert_rules r WHERE r.rule_id=$1`, [id]);
    return result.rows[0] ? { ...ruleOf(result.rows[0]), openAlertCount: result.rows[0].open_count } : null;
  }
  async getRule(id) { return /^[0-9a-f-]{36}$/i.test(id) ? this.#oneRule(this.pool, id) : null; }
  async createRule(input, userId = null) {
    const fields = parseRule(input);
    const id = await this.#inTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nuvrion.alert-rules'))");
      if ((await client.query('SELECT count(*)::int n FROM monitoring.alert_rules')).rows[0].n >= LIMITS.rules) throw new AlertError(`At most ${LIMITS.rules} alert rules may exist.`, 'NUV_ALERT_RULE_LIMIT');
      try {
        const result = await client.query('INSERT INTO monitoring.alert_rules(name,description,metric,comparison,threshold,duration_minutes,severity,connection_id,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING rule_id',
          [fields.name, fields.description, fields.metric, fields.comparison, fields.threshold, fields.durationMinutes, fields.severity, fields.connectionId, fields.enabled, userId]);
        return result.rows[0].rule_id;
      } catch (error) {
        if (error.code === '23505') throw new AlertError(`A rule named "${fields.name}" already exists.`, 'NUV_ALERT_RULE_EXISTS');
        if (error.code === '23503') throw new AlertError('That connection does not exist.');
        throw error;
      }
    });
    return this.#oneRule(this.pool, id);
  }
  async updateRule(id, patch, expectedVersion) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    let found = true;
    await this.#inTransaction(async client => {
      const current = (await client.query(`SELECT ${RULE_COLUMNS} FROM monitoring.alert_rules r WHERE r.rule_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) { found = false; return; }
      if (current.row_version !== expectedVersion) throw new Error('VERSION_CONFLICT');
      const fields = mergeRule(ruleOf(current), patch);
      try {
        await client.query('UPDATE monitoring.alert_rules SET name=$2,description=$3,metric=$4,comparison=$5,threshold=$6,duration_minutes=$7,severity=$8,connection_id=$9,enabled=$10,row_version=row_version+1,updated_at=now() WHERE rule_id=$1',
          [id, fields.name, fields.description, fields.metric, fields.comparison, fields.threshold, fields.durationMinutes, fields.severity, fields.connectionId, fields.enabled]);
      } catch (error) {
        if (error.code === '23505') throw new AlertError(`A rule named "${fields.name}" already exists.`, 'NUV_ALERT_RULE_EXISTS');
        if (error.code === '23503') throw new AlertError('That connection does not exist.');
        throw error;
      }
    });
    return found ? this.#oneRule(this.pool, id) : null;
  }
  async deleteRule(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.#inTransaction(async client => {
      const found = await client.query('SELECT 1 FROM monitoring.alert_rules WHERE rule_id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) return null;
      const resolved = await client.query("UPDATE monitoring.alerts SET status='resolved',resolved_at=$2,resolved_reason='rule_deleted' WHERE rule_id=$1 AND status IN ('active','acknowledged')", [id, new Date(this.clock())]);
      await client.query('DELETE FROM monitoring.alert_rules WHERE rule_id=$1', [id]);   // the alerts stay as history, no longer pointing at a rule
      for (const key of [...this.#pending.keys()]) if (key.startsWith(`${id}\n`)) this.#pending.delete(key);
      return { deleted: 1, alertsResolved: resolved.rowCount };
    });
  }

  // ---- alerts ----
  async listAlerts({ status = 'open', limit = 100 } = {}) {
    const where = status === 'open' ? "status IN ('active','acknowledged')" : status === 'all' ? 'true' : 'status = $2';
    const params = status === 'open' || status === 'all' ? [Math.min(500, Math.max(1, limit))] : [Math.min(500, Math.max(1, limit)), status];
    const result = await this.pool.query(`SELECT * FROM monitoring.alerts WHERE ${where} ORDER BY (status IN ('active','acknowledged')) DESC, last_seen_at DESC LIMIT $1`, params);
    return result.rows.map(alertOf);
  }
  async acknowledge(id, userId) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.#inTransaction(async client => {
      const row = (await client.query('SELECT * FROM monitoring.alerts WHERE alert_id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) return null;
      if (row.status === 'resolved') throw new AlertError('A resolved alert cannot be acknowledged.', 'NUV_ALERT_RESOLVED');
      if (row.status === 'active') {
        const updated = await client.query("UPDATE monitoring.alerts SET status='acknowledged',acknowledged_at=$2,acknowledged_by=$3 WHERE alert_id=$1 RETURNING *", [id, new Date(this.clock()), userId]);
        return alertOf(updated.rows[0]);
      }
      return alertOf(row);
    });
  }

  async evaluate(targets, now = this.clock()) {
    return this.#inTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nuvrion.alert-evaluation'))");   // one evaluation at a time, so two cannot both fire the same alert
      const rules = (await client.query(`SELECT ${RULE_COLUMNS} FROM monitoring.alert_rules r`)).rows.map(ruleOf);
      const open = (await client.query("SELECT * FROM monitoring.alerts WHERE status IN ('active','acknowledged') FOR UPDATE")).rows.map(alertOf);
      const plan = planEvaluation({ rules, targets, open, pending: this.#pending, now });
      this.#pending = plan.pending;
      const at = new Date(now);
      for (const { rule, target, value } of plan.fire) {
        await client.query(`INSERT INTO monitoring.alerts(rule_id,rule_name,metric,comparison,threshold,severity,target_kind,target_id,target_name,connection_id,value,status,first_seen_at,last_seen_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$12) ON CONFLICT DO NOTHING`, [rule.id, rule.name, rule.metric, rule.comparison, rule.threshold, rule.severity, target.kind, target.id, target.name, target.connectionId ?? null, value, at]);
      }
      for (const { alert, rule, target, value } of plan.refresh) {
        await client.query('UPDATE monitoring.alerts SET rule_name=$2,metric=$3,comparison=$4,threshold=$5,severity=$6,target_name=$7,value=$8,last_seen_at=$9 WHERE alert_id=$1', [alert.id, rule.name, rule.metric, rule.comparison, rule.threshold, rule.severity, target.name, value, at]);
      }
      for (const { alert, reason } of plan.resolve) {
        await client.query("UPDATE monitoring.alerts SET status='resolved',resolved_at=$2,resolved_reason=$3 WHERE alert_id=$1", [alert.id, at, reason]);
      }
      return { fired: plan.fire.length, refreshed: plan.refresh.length, resolved: plan.resolve.length, stale: plan.stale, rules: rules.filter(rule => rule.enabled).length, evaluatedAt: at.toISOString() };
    });
  }

  // ---- the notification centre ----
  async notifications(userId, { limit = 50 } = {}) {
    const read = (await this.pool.query('SELECT last_read_at FROM monitoring.notification_reads WHERE user_id=$1', [userId])).rows[0];
    const lastReadAt = read ? iso(read.last_read_at) : null, since = lastReadAt ?? new Date(this.clock() - UNREAD_WINDOW_MS).toISOString();
    const alerts = (await this.pool.query('SELECT * FROM monitoring.alerts ORDER BY last_seen_at DESC LIMIT 1000')).rows.map(alertOf);
    return { items: feedFromAlerts(alerts, Math.min(200, Math.max(1, limit))), unreadCount: feedFromAlerts(alerts, 2000).filter(event => event.at > since).length, lastReadAt };
  }
  async markRead(userId) {
    const lastReadAt = new Date(this.clock());
    await this.pool.query('INSERT INTO monitoring.notification_reads(user_id,last_read_at) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at', [userId, lastReadAt]);
    return { lastReadAt: lastReadAt.toISOString() };
  }
}
export { isOpen };

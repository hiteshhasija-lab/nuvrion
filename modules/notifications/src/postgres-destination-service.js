// Webhook destinations and their queue of deliveries in PostgreSQL: the same interface as DestinationService (the local mode). What a destination may be and how a result is judged are
// decided by webhook-rules.js. The address and the signing secret are sealed with the platform's key ring (the id of the destination is part of what is authenticated, so a sealed
// address cannot be moved to another destination) and never leave this class except to the sender.
import { randomUUID } from 'node:crypto';
import { keyringFromEnvironment } from '../../platform/src/keyring-cipher.js';
import { LIMITS, WebhookError, judge, parseChange, parseDestination, urlHint } from './webhook-rules.js';

const iso = value => (value ? new Date(value).toISOString() : null);
const context = id => `nuvrion:webhook-destination:${id}`;
const COLUMNS = 'd.destination_id,d.name,d.format,d.events,d.min_severity,d.enabled,d.active_since,d.url_hint,d.has_signing_secret,d.consecutive_failures,d.last_attempt_at,d.last_success_at,d.last_error,d.row_version,d.created_by,d.created_at,d.updated_at';
const destinationOf = row => ({ id: row.destination_id, name: row.name, format: row.format, events: row.events, minSeverity: row.min_severity, enabled: row.enabled, activeSince: iso(row.active_since), urlHint: row.url_hint, hasSigningSecret: row.has_signing_secret,
  consecutiveFailures: row.consecutive_failures, lastAttemptAt: iso(row.last_attempt_at), lastSuccessAt: iso(row.last_success_at), lastError: row.last_error, rowVersion: row.row_version, createdBy: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), pendingCount: row.pending_count ?? 0 });
const deliveryOf = row => ({ id: row.delivery_id, destinationId: row.destination_id, destinationName: row.destination_name, eventId: row.event_id, eventType: row.event_type, severity: row.severity, title: row.title, detail: row.detail, occurredAt: iso(row.occurred_at),
  status: row.status, attempts: row.attempts, nextAttemptAt: iso(row.next_attempt_at), claimedUntil: iso(row.claimed_until), responseStatus: row.response_status, error: row.error, durationMs: row.duration_ms, createdAt: iso(row.created_at), sentAt: iso(row.sent_at) });
const WITH_PENDING = `${COLUMNS},(SELECT count(*)::int FROM monitoring.webhook_deliveries x WHERE x.destination_id=d.destination_id AND x.status='pending') pending_count`;
const UUID = /^[0-9a-f-]{36}$/i;

export class PostgresDestinationService {
  constructor(pool, { clock = Date.now, cipher = null, policy = {} } = {}) { this.pool = pool; this.clock = clock; this.cipher = cipher ?? keyringFromEnvironment(process.env); this.policy = policy; }
  async #inTransaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  #seal(id, secrets) { const sealed = this.cipher.encrypt(secrets, { context: context(id) }); return [sealed.keyId, sealed.nonce, sealed.ciphertext, sealed.tag]; }

  async listDestinations() { return (await this.pool.query(`SELECT ${WITH_PENDING} FROM monitoring.webhook_destinations d ORDER BY lower(d.name)`)).rows.map(destinationOf); }
  async getDestination(id) {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query(`SELECT ${WITH_PENDING} FROM monitoring.webhook_destinations d WHERE d.destination_id=$1`, [id])).rows[0];
    return row ? destinationOf(row) : null;
  }
  async secretsOf(id) {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query('SELECT secret_key_id,secret_nonce,secret_ciphertext,secret_tag FROM monitoring.webhook_destinations WHERE destination_id=$1', [id])).rows[0];
    return row ? this.cipher.decrypt({ algorithm: 'aes-256-gcm', keyId: row.secret_key_id, nonce: row.secret_nonce, ciphertext: row.secret_ciphertext, tag: row.secret_tag }, { context: context(id) }) : null;
  }

  async createDestination(input, userId = null, now = this.clock()) {
    const fields = parseDestination(input, this.policy), id = randomUUID();
    try {
      await this.#inTransaction(async client => {
        await client.query('LOCK TABLE monitoring.webhook_destinations IN SHARE ROW EXCLUSIVE MODE');
        if ((await client.query('SELECT count(*)::int n FROM monitoring.webhook_destinations')).rows[0].n >= LIMITS.destinations) throw new WebhookError(`At most ${LIMITS.destinations} webhooks may exist.`, 'NUV_WEBHOOK_LIMIT');
        await client.query(`INSERT INTO monitoring.webhook_destinations (destination_id,name,format,events,min_severity,enabled,active_since,url_hint,secret_key_id,secret_nonce,secret_ciphertext,secret_tag,has_signing_secret,created_by,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$7,$7)`,
        [id, fields.name, fields.format, fields.events, fields.minSeverity, fields.enabled, new Date(now), urlHint(new URL(fields.url)), ...this.#seal(id, { url: fields.url, signingSecret: fields.signingSecret }), Boolean(fields.signingSecret), userId]);
      });
    } catch (error) {
      if (error.code === '23505') throw new WebhookError(`A webhook named "${fields.name}" already exists.`, 'NUV_WEBHOOK_EXISTS');
      throw error;
    }
    return this.getDestination(id);
  }
  async updateDestination(id, patch, expectedVersion, now = this.clock()) {
    const current = await this.getDestination(id);
    if (!current) return null;
    if (current.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const change = parseChange(patch, this.policy);
    const sets = ['row_version=row_version+1', 'updated_at=$2'], values = [id, new Date(now)];
    const set = (column, value) => { values.push(value); sets.push(`${column}=$${values.length}`); };
    if (change.name !== undefined) set('name', change.name);
    if (change.format !== undefined) set('format', change.format);
    if (change.events !== undefined) set('events', change.events);
    if (change.minSeverity !== undefined) set('min_severity', change.minSeverity);
    if (change.enabled !== undefined) { set('enabled', change.enabled); if (change.enabled && !current.enabled) set('active_since', new Date(now)); }   // events from the time it was off are not sent afterwards
    if (change.url !== undefined || change.signingSecret !== undefined) {
      const secrets = await this.secretsOf(id);
      if (change.url !== undefined) { secrets.url = change.url; set('url_hint', urlHint(new URL(change.url))); }
      if (change.signingSecret !== undefined) { secrets.signingSecret = change.signingSecret; set('has_signing_secret', Boolean(change.signingSecret)); }
      const [keyId, nonce, ciphertext, tag] = this.#seal(id, secrets);
      set('secret_key_id', keyId); set('secret_nonce', nonce); set('secret_ciphertext', ciphertext); set('secret_tag', tag);
    }
    values.push(expectedVersion);
    try {
      const result = await this.pool.query(`UPDATE monitoring.webhook_destinations SET ${sets.join(',')} WHERE destination_id=$1 AND row_version=$${values.length}`, values);
      if (!result.rowCount) throw new Error('VERSION_CONFLICT');
    } catch (error) {
      if (error.code === '23505') throw new WebhookError(`A webhook named "${change.name}" already exists.`, 'NUV_WEBHOOK_EXISTS');
      throw error;
    }
    return this.getDestination(id);
  }
  async deleteDestination(id) {
    if (!UUID.test(id)) return null;
    const result = await this.pool.query('DELETE FROM monitoring.webhook_destinations WHERE destination_id=$1', [id]);
    return result.rowCount ? { deleted: 1 } : null;
  }

  // ---- the queue ----
  async enqueue(destinationId, events, now = this.clock()) {
    let queued = 0;
    for (const event of events) {
      const result = await this.pool.query(
        `INSERT INTO monitoring.webhook_deliveries (destination_id,destination_name,event_id,event_type,severity,title,detail,occurred_at,next_attempt_at,created_at)
         SELECT d.destination_id,d.name,$2,$3,$4,$5,$6,$7,$8,$8 FROM monitoring.webhook_destinations d WHERE d.destination_id=$1
         ON CONFLICT (destination_id,event_id) DO NOTHING`,
        [destinationId, event.id, event.type, event.severity, event.title.slice(0, 300), event.detail.slice(0, 1000), new Date(event.at), new Date(now)]);
      queued += result.rowCount;
    }
    return queued;
  }
  async claimDue(limit = LIMITS.perTick, now = this.clock()) {
    return this.#inTransaction(async client => {
      const rows = (await client.query(
        `SELECT x.delivery_id FROM monitoring.webhook_deliveries x JOIN monitoring.webhook_destinations d ON d.destination_id=x.destination_id
         WHERE x.status='pending' AND x.next_attempt_at<=$1 AND (x.claimed_until IS NULL OR x.claimed_until<=$1) AND d.enabled
         ORDER BY x.next_attempt_at LIMIT $2 FOR UPDATE OF x SKIP LOCKED`, [new Date(now), limit])).rows;
      if (!rows.length) return [];
      const claimed = await client.query('UPDATE monitoring.webhook_deliveries SET claimed_until=$2 WHERE delivery_id=ANY($1::uuid[]) RETURNING *', [rows.map(row => row.delivery_id), new Date(now + 120_000)]);
      return claimed.rows.map(deliveryOf).sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
    });
  }
  async recordResult(deliveryId, result, now = this.clock()) {
    return this.#inTransaction(async client => {
      const row = (await client.query('SELECT * FROM monitoring.webhook_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId])).rows[0];
      if (!row) return null;
      const attempts = row.attempts + 1, verdict = judge(result, attempts);
      const updated = (await client.query(
        `UPDATE monitoring.webhook_deliveries SET attempts=$2,status=$3,claimed_until=NULL,response_status=$4,error=$5,duration_ms=$6,sent_at=$7,next_attempt_at=$8 WHERE delivery_id=$1 RETURNING *`,
        [deliveryId, attempts, verdict.status, result.status ?? null, result.ok ? null : (result.error ?? null), result.durationMs ?? null, verdict.status === 'sent' ? new Date(now) : null, verdict.status === 'pending' ? new Date(now + verdict.waitMs) : row.next_attempt_at])).rows[0];
      await this.#noteAttempt(client, row.destination_id, result, now);
      return deliveryOf(updated);
    });
  }
  async #noteAttempt(client, destinationId, result, now) {
    if (!destinationId) return;
    await client.query(
      `UPDATE monitoring.webhook_destinations SET last_attempt_at=$2,
         consecutive_failures=CASE WHEN $3 THEN 0 ELSE consecutive_failures+1 END,
         last_success_at=CASE WHEN $3 THEN $2 ELSE last_success_at END,
         last_error=CASE WHEN $3 THEN NULL ELSE $4 END WHERE destination_id=$1`, [destinationId, new Date(now), Boolean(result.ok), result.error ?? null]);
  }
  async recordTest(destinationId, event, result, now = this.clock()) {
    return this.#inTransaction(async client => {
      const destination = (await client.query('SELECT name FROM monitoring.webhook_destinations WHERE destination_id=$1', [destinationId])).rows[0];
      if (!destination) return null;
      const row = (await client.query(
        `INSERT INTO monitoring.webhook_deliveries (destination_id,destination_name,event_id,event_type,severity,title,detail,occurred_at,status,attempts,next_attempt_at,response_status,error,duration_ms,created_at,sent_at)
         VALUES ($1,$2,$3,'test',$4,$5,$6,$7,$8,1,$7,$9,$10,$11,$7,$12) RETURNING *`,
        [destinationId, destination.name, event.id, event.severity, event.title, event.detail, new Date(now), result.ok ? 'sent' : 'failed', result.status ?? null, result.ok ? null : (result.error ?? null), result.durationMs ?? null, result.ok ? new Date(now) : null])).rows[0];
      await this.#noteAttempt(client, destinationId, result, now);
      return deliveryOf(row);
    });
  }
  async listDeliveries({ destinationId = null, limit = 50 } = {}) {
    if (destinationId && !UUID.test(destinationId)) return [];
    const result = await this.pool.query('SELECT * FROM monitoring.webhook_deliveries WHERE ($1::uuid IS NULL OR destination_id=$1) ORDER BY created_at DESC, delivery_id LIMIT $2', [destinationId, Math.min(LIMITS.deliveriesKept, Math.max(1, limit))]);
    return result.rows.map(deliveryOf);
  }
  async prune(now = this.clock()) {
    const cutoff = new Date(now - LIMITS.retentionDays * 86_400_000);
    const old = await this.pool.query("DELETE FROM monitoring.webhook_deliveries WHERE status<>'pending' AND created_at<$1", [cutoff]);
    const extra = await this.pool.query(
      `DELETE FROM monitoring.webhook_deliveries WHERE delivery_id IN (SELECT delivery_id FROM (SELECT delivery_id,status,row_number() OVER (PARTITION BY destination_id ORDER BY created_at DESC) rn FROM monitoring.webhook_deliveries) ranked WHERE rn>$1 AND status<>'pending')`, [LIMITS.deliveriesKept]);
    return old.rowCount + extra.rowCount;
  }
}

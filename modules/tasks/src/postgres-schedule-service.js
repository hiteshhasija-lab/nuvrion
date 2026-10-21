// Scheduled operations in PostgreSQL: the same interface as ScheduleService (the local mode); what a schedule is and when it runs is decided by schedule-rules.js.
import { LIMITS, ScheduleError, isLate, mergeSchedule, nextRun, parseSchedule } from './schedule-rules.js';

const iso = value => (value ? new Date(value).toISOString() : null);
const dateOnly = value => (value ? (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)) : null);
const COLUMNS = 's.schedule_id,s.name,s.description,s.operation,s.target_kind,s.vm_ids,s.tag,s.connection_id,s.frequency,s.time_of_day,s.weekdays,s.run_date,s.time_zone,s.enabled,s.next_run_at,s.last_run_at,s.last_outcome,s.created_by,s.row_version,s.created_at,s.updated_at';
const scheduleOf = row => ({ id: row.schedule_id, name: row.name, description: row.description, operation: row.operation, targetKind: row.target_kind, vmIds: row.vm_ids, tag: row.tag, connectionId: row.connection_id, frequency: row.frequency, timeOfDay: row.time_of_day, weekdays: row.weekdays.map(Number), runDate: dateOnly(row.run_date), timeZone: row.time_zone, enabled: row.enabled, nextRunAt: iso(row.next_run_at), lastRunAt: iso(row.last_run_at), lastOutcome: row.last_outcome, createdBy: row.created_by, rowVersion: row.row_version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const runOf = row => ({ id: row.run_id, scheduleId: row.schedule_id, scheduleName: row.schedule_name, operation: row.operation, trigger: row.trigger, scheduledFor: iso(row.scheduled_for), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), outcome: row.outcome, matched: row.matched, submitted: row.submitted, skipped: row.skipped, failed: row.failed, details: row.details, detailsTruncated: row.details_truncated, error: row.error, requestedBy: row.requested_by });
const uuid = id => /^[0-9a-f-]{36}$/i.test(String(id));

export class PostgresScheduleService {
  constructor(pool, { clock = Date.now } = {}) { this.pool = pool; this.clock = clock; }
  async #inTransaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  #planNext(fields, now) {
    if (!fields.enabled) return null;
    const at = nextRun(fields, now);
    if (at === null) throw new ScheduleError('That time has already passed. Choose a time that is still ahead, or turn the schedule off.');
    return at;
  }
  async #lastRuns(db, ids) {
    if (!ids.length) return new Map();
    const result = await db.query('SELECT DISTINCT ON (schedule_id) * FROM operations.schedule_runs WHERE schedule_id = ANY($1) ORDER BY schedule_id, started_at DESC', [ids]);
    return new Map(result.rows.map(row => [row.schedule_id, runOf(row)]));
  }
  async listSchedules() {
    const rows = (await this.pool.query(`SELECT ${COLUMNS} FROM operations.schedules s ORDER BY lower(s.name)`)).rows, last = await this.#lastRuns(this.pool, rows.map(row => row.schedule_id));
    return rows.map(row => ({ ...scheduleOf(row), lastRun: last.get(row.schedule_id) ?? null }));
  }
  async getSchedule(id) {
    if (!uuid(id)) return null;
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM operations.schedules s WHERE s.schedule_id=$1`, [id])).rows[0];
    if (!row) return null;
    return { ...scheduleOf(row), lastRun: (await this.#lastRuns(this.pool, [id])).get(id) ?? null };
  }
  #values(fields, nextRunAt) {
    return [fields.name, fields.description, fields.operation, fields.targetKind, fields.vmIds, fields.tag, fields.connectionId, fields.frequency, fields.timeOfDay, fields.weekdays, fields.runDate, fields.timeZone, fields.enabled, nextRunAt === null ? null : new Date(nextRunAt)];
  }
  async createSchedule(input, userId = null, now = this.clock()) {
    const fields = parseSchedule(input), nextRunAt = this.#planNext(fields, now);
    const id = await this.#inTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nuvrion.schedules'))");
      if ((await client.query('SELECT count(*)::int n FROM operations.schedules')).rows[0].n >= LIMITS.schedules) throw new ScheduleError(`At most ${LIMITS.schedules} schedules may exist.`, 'NUV_SCHEDULE_LIMIT');
      try {
        return (await client.query('INSERT INTO operations.schedules(name,description,operation,target_kind,vm_ids,tag,connection_id,frequency,time_of_day,weekdays,run_date,time_zone,enabled,next_run_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING schedule_id', [...this.#values(fields, nextRunAt), userId])).rows[0].schedule_id;
      } catch (error) {
        if (error.code === '23505') throw new ScheduleError(`A schedule named "${fields.name}" already exists.`, 'NUV_SCHEDULE_EXISTS');
        if (error.code === '23503') throw new ScheduleError('That connection does not exist.');
        throw error;
      }
    });
    return this.getSchedule(id);
  }
  async updateSchedule(id, patch, expectedVersion, now = this.clock()) {
    if (!uuid(id)) return null;
    let found = true;
    await this.#inTransaction(async client => {
      const current = (await client.query(`SELECT ${COLUMNS} FROM operations.schedules s WHERE s.schedule_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) { found = false; return; }
      if (current.row_version !== expectedVersion) throw new Error('VERSION_CONFLICT');
      const fields = mergeSchedule(scheduleOf(current), patch), nextRunAt = this.#planNext(fields, now);
      try {
        await client.query('UPDATE operations.schedules SET name=$2,description=$3,operation=$4,target_kind=$5,vm_ids=$6,tag=$7,connection_id=$8,frequency=$9,time_of_day=$10,weekdays=$11,run_date=$12,time_zone=$13,enabled=$14,next_run_at=$15,row_version=row_version+1,updated_at=now() WHERE schedule_id=$1', [id, ...this.#values(fields, nextRunAt)]);
      } catch (error) {
        if (error.code === '23505') throw new ScheduleError(`A schedule named "${fields.name}" already exists.`, 'NUV_SCHEDULE_EXISTS');
        if (error.code === '23503') throw new ScheduleError('That connection does not exist.');
        throw error;
      }
    });
    return found ? this.getSchedule(id) : null;
  }
  async deleteSchedule(id) {
    if (!uuid(id)) return null;
    const result = await this.pool.query('DELETE FROM operations.schedules WHERE schedule_id=$1', [id]);   // the runs stay as history, under the schedule's name
    return result.rowCount ? { deleted: 1 } : null;
  }
  async claimDue(now = this.clock()) {
    return this.#inTransaction(async client => {
      const rows = (await client.query(`SELECT ${COLUMNS} FROM operations.schedules s WHERE s.enabled AND s.next_run_at <= $1 ORDER BY s.next_run_at FOR UPDATE SKIP LOCKED`, [new Date(now)])).rows;
      const claimed = [];
      for (const row of rows) {
        const schedule = scheduleOf(row), scheduledFor = Date.parse(schedule.nextRunAt), next = nextRun(schedule, now);
        claimed.push({ schedule, scheduledFor, late: isLate(scheduledFor, now) });
        await client.query('UPDATE operations.schedules SET next_run_at=$2, enabled=$3 WHERE schedule_id=$1', [schedule.id, next === null ? null : new Date(next), next !== null]);
      }
      return claimed;
    });
  }
  async recordRun(run) {
    return this.#inTransaction(async client => {
      const row = (await client.query(`INSERT INTO operations.schedule_runs(schedule_id,schedule_name,operation,trigger,scheduled_for,started_at,finished_at,outcome,matched,submitted,skipped,failed,details,details_truncated,error,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [run.scheduleId, run.scheduleName, run.operation, run.trigger, new Date(run.scheduledFor), new Date(run.startedAt), run.finishedAt ? new Date(run.finishedAt) : null, run.outcome, run.matched ?? 0, run.submitted ?? 0, run.skipped ?? 0, run.failed ?? 0, JSON.stringify(run.details ?? []), Boolean(run.detailsTruncated), run.error ?? null, run.requestedBy ?? null])).rows[0];
      if (run.scheduleId) {
        await client.query('UPDATE operations.schedules SET last_run_at=$2,last_outcome=$3 WHERE schedule_id=$1', [run.scheduleId, new Date(run.startedAt), run.outcome]);
        await client.query('DELETE FROM operations.schedule_runs WHERE schedule_id=$1 AND run_id NOT IN (SELECT run_id FROM operations.schedule_runs WHERE schedule_id=$1 ORDER BY started_at DESC LIMIT $2)', [run.scheduleId, LIMITS.runsKept]);
      }
      return runOf(row);
    });
  }
  async listRuns({ scheduleId = null, limit = 50 } = {}) {
    const max = Math.min(200, Math.max(1, limit));
    const result = scheduleId ? await this.pool.query('SELECT * FROM operations.schedule_runs WHERE schedule_id=$1 ORDER BY started_at DESC LIMIT $2', [scheduleId, max]) : await this.pool.query('SELECT * FROM operations.schedule_runs ORDER BY started_at DESC LIMIT $1', [max]);
    return result.rows.map(runOf);
  }
}

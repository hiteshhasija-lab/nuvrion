// Scheduled operations for the local (file-backed) mode: the schedules, when each next runs, and the history of what each run did. The same interface as PostgresScheduleService; what
// a schedule is and when it runs is decided by schedule-rules.js, which both use. Running the operations is not done here: the driver (the API) asks claimDue() what is due, runs it,
// and records the result with recordRun().
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { LIMITS, ScheduleError, isLate, mergeSchedule, nextRun, parseSchedule } from './schedule-rules.js';

const clone = value => structuredClone(value);
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export class ScheduleService {
  #schedules = new Map(); #runs = []; #file; #clock;
  constructor({ file = null, clock = Date.now } = {}) {
    this.#file = file; this.#clock = clock;
    if (file && existsSync(file)) { const state = JSON.parse(readFileSync(file, 'utf8')); this.#schedules = new Map(state.schedules ?? []); this.#runs = state.runs ?? []; }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, schedules: [...this.#schedules], runs: this.#runs }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
  #public(schedule) {
    const last = this.#runs.find(run => run.scheduleId === schedule.id);
    return { ...clone(schedule), lastRun: last ? clone(last) : null };
  }
  #checkName(name, exceptId = null) {
    if ([...this.#schedules.values()].some(item => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) throw new ScheduleError(`A schedule named "${name}" already exists.`, 'NUV_SCHEDULE_EXISTS');
  }
  // the next run for a schedule as it now is: none if it is off; an error if a "once" is already in the past and it is meant to run
  #planNext(fields, now) {
    if (!fields.enabled) return null;
    const at = nextRun(fields, now);
    if (at === null) throw new ScheduleError('That time has already passed. Choose a time that is still ahead, or turn the schedule off.');
    return at;
  }

  async listSchedules() { return [...this.#schedules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(item => this.#public(item)); }
  async getSchedule(id) { const schedule = this.#schedules.get(id); return schedule ? this.#public(schedule) : null; }
  async createSchedule(input, userId = null, now = this.#clock()) {
    const fields = parseSchedule(input);
    if (this.#schedules.size >= LIMITS.schedules) throw new ScheduleError(`At most ${LIMITS.schedules} schedules may exist.`, 'NUV_SCHEDULE_LIMIT');
    const nextRunAt = this.#planNext(fields, now), at = iso(now);
    this.#checkName(fields.name);
    const schedule = { id: randomUUID(), ...fields, nextRunAt: iso(nextRunAt), lastRunAt: null, lastOutcome: null, createdBy: userId, rowVersion: 1, createdAt: at, updatedAt: at };
    this.#schedules.set(schedule.id, schedule); this.#persist();
    return this.#public(schedule);
  }
  async updateSchedule(id, patch, expectedVersion, now = this.#clock()) {
    const schedule = this.#schedules.get(id);
    if (!schedule) return null;
    if (schedule.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const fields = mergeSchedule(schedule, patch);
    const nextRunAt = this.#planNext(fields, now);
    this.#checkName(fields.name, id);
    Object.assign(schedule, fields, { nextRunAt: iso(nextRunAt), rowVersion: schedule.rowVersion + 1, updatedAt: iso(now) });
    this.#persist();
    return this.#public(schedule);
  }
  async deleteSchedule(id) {
    if (!this.#schedules.delete(id)) return null;
    for (const run of this.#runs) if (run.scheduleId === id) run.scheduleId = null;   // the history stays, under the schedule's name
    this.#persist();
    return { deleted: 1 };
  }

  // The schedules that are due, each advanced to its next run in the same step so that it is claimed once. A run more than the grace period late is reported as late (the driver records
  // it as missed instead of running it). A "once" that has been claimed turns itself off.
  async claimDue(now = this.#clock()) {
    const claimed = [];
    for (const schedule of this.#schedules.values()) {
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
      const scheduledFor = Date.parse(schedule.nextRunAt), next = nextRun(schedule, now);
      claimed.push({ schedule: clone(schedule), scheduledFor, late: isLate(scheduledFor, now) });
      schedule.nextRunAt = iso(next);
      if (next === null) schedule.enabled = false;
    }
    if (claimed.length) this.#persist();
    return claimed;
  }

  async recordRun(run) {
    const record = { id: randomUUID(), error: null, details: [], detailsTruncated: false, ...clone(run) };
    record.scheduledFor = iso(record.scheduledFor);   // a time, as the PostgreSQL store returns it
    this.#runs.unshift(record);
    const schedule = record.scheduleId ? this.#schedules.get(record.scheduleId) : null;
    if (schedule) { schedule.lastRunAt = record.startedAt; schedule.lastOutcome = record.outcome; }
    const seen = new Map();
    this.#runs = this.#runs.filter(item => { const count = (seen.get(item.scheduleId ?? item.scheduleName) ?? 0) + 1; seen.set(item.scheduleId ?? item.scheduleName, count); return count <= LIMITS.runsKept; });
    this.#persist();
    return clone(record);
  }
  async listRuns({ scheduleId = null, limit = 50 } = {}) {
    return this.#runs.filter(run => !scheduleId || run.scheduleId === scheduleId).slice(0, Math.min(200, Math.max(1, limit))).map(clone);
  }
}

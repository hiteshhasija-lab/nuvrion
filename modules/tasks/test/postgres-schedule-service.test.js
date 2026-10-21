import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresScheduleService } from '../src/postgres-schedule-service.js';
import { LIMITS } from '../src/schedule-rules.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production schedule store against a real PostgreSQL, as the restricted application role: the same behaviour as the file-backed store, plus what only a database can get wrong
// (two drivers claiming the same due schedule, history kept after a schedule is deleted, the tables refusing what the rules refuse).
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const time = { now: Date.parse('2026-10-21T10:00:00Z') };
const service = db ? new PostgresScheduleService(db.pool, { clock: () => time.now }) : null;
after(async () => { await db?.drop(); });
const VM1 = '11111111-1111-4111-8111-111111111111';
const good = { name: 'Nightly off', operation: 'stop', targetKind: 'vms', vmIds: [VM1], frequency: 'daily', timeOfDay: '19:00', timeZone: 'UTC' };
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);
const run = (schedule, over = {}) => ({ scheduleId: schedule.id, scheduleName: schedule.name, operation: schedule.operation, trigger: 'schedule', scheduledFor: time.now, startedAt: new Date(time.now).toISOString(), finishedAt: new Date(time.now).toISOString(), outcome: 'completed', matched: 1, submitted: 1, skipped: 0, failed: 0, ...over });
beforeEach(async () => { if (!db) return; await db.adminPool.query('DELETE FROM operations.schedule_runs; DELETE FROM operations.schedules'); time.now = Date.parse('2026-10-21T10:00:00Z'); });

test('PostgreSQL: a schedule is created with its next run worked out, named uniquely, and changed with a version; weekdays, dates and tags round-trip', database, async () => {
  const created = await service.createSchedule(good, null);
  assert.deepEqual([created.name, created.enabled, created.nextRunAt, created.rowVersion, created.vmIds, created.weekdays, created.runDate, created.lastRun], ['Nightly off', true, '2026-10-21T19:00:00.000Z', 1, [VM1], [], null, null]);
  await refused(service.createSchedule({ ...good, name: 'nightly OFF' }), 'NUV_SCHEDULE_EXISTS');
  await refused(service.createSchedule({ ...good, name: 'No such connection', targetKind: 'tag', vmIds: undefined, tag: 'env', connectionId: randomUUID() }), 'NUV_SCHEDULE_INVALID');
  const weekly = await service.createSchedule({ name: 'Weekdays', operation: 'start', targetKind: 'tag', tag: 'Env=dev', frequency: 'weekly', weekdays: [5, 1], timeOfDay: '07:00', timeZone: 'Europe/London' });
  assert.deepEqual([weekly.weekdays, weekly.tag, weekly.vmIds, weekly.nextRunAt, weekly.timeZone], [[1, 5], 'env=dev', [], '2026-10-23T06:00:00.000Z', 'Europe/London']);
  const once = await service.createSchedule({ ...good, name: 'Once', frequency: 'once', runDate: '2026-10-30', timeOfDay: '12:00' });
  assert.deepEqual([once.runDate, once.nextRunAt], ['2026-10-30', '2026-10-30T12:00:00.000Z']);
  const changed = await service.updateSchedule(created.id, { timeOfDay: '20:30', operation: 'power_off' }, 1);
  assert.deepEqual([changed.timeOfDay, changed.operation, changed.nextRunAt, changed.rowVersion], ['20:30', 'power_off', '2026-10-21T20:30:00.000Z', 2]);
  await refused(service.updateSchedule(created.id, { timeOfDay: '21:00' }, 1), 'VERSION_CONFLICT');
  assert.equal(await service.updateSchedule(randomUUID(), { timeOfDay: '21:00' }, 1), null); assert.equal(await service.updateSchedule('nope', { timeOfDay: '21:00' }, 1), null);
  await refused(service.updateSchedule(created.id, { name: 'WEEKDAYS' }, 2), 'NUV_SCHEDULE_EXISTS');
  assert.deepEqual((await service.listSchedules()).map(item => item.name), ['Nightly off', 'Once', 'Weekdays']);
  assert.equal(await service.getSchedule('nope'), null);
});

test('PostgreSQL: turning a schedule off clears its next run; a time already past is refused; the limit holds', database, async () => {
  const created = await service.createSchedule(good);
  const off = await service.updateSchedule(created.id, { enabled: false }, 1);
  assert.deepEqual([off.enabled, off.nextRunAt], [false, null]);
  assert.equal((await service.updateSchedule(created.id, { enabled: true }, 2)).nextRunAt, '2026-10-21T19:00:00.000Z');
  await refused(service.createSchedule({ ...good, name: 'Past', frequency: 'once', runDate: '2026-10-20' }), 'NUV_SCHEDULE_INVALID');
  for (let i = 0; i < LIMITS.schedules - 1; i++) await db.adminPool.query("INSERT INTO operations.schedules(name, operation, target_kind, vm_ids, frequency, time_of_day, time_zone, enabled) VALUES($1,'stop','vms',ARRAY[$2::uuid],'daily','19:00','UTC',false)", [`Filler ${i}`, VM1]);
  await refused(service.createSchedule({ ...good, name: 'one too many' }), 'NUV_SCHEDULE_LIMIT');
});

test('PostgreSQL: a due schedule is claimed once and moved on; two drivers at the same moment claim it between them only once', database, async () => {
  const created = await service.createSchedule(good);
  assert.deepEqual(await service.claimDue(), []);
  time.now = Date.parse('2026-10-21T19:00:30Z');
  const results = await Promise.all(Array.from({ length: 5 }, () => service.claimDue()));
  const claimed = results.flat();
  assert.equal(claimed.length, 1, 'five drivers, one claim');
  assert.deepEqual([claimed[0].schedule.id, claimed[0].scheduledFor, claimed[0].late], [created.id, Date.parse('2026-10-21T19:00:00Z'), false]);
  assert.equal((await service.getSchedule(created.id)).nextRunAt, '2026-10-22T19:00:00.000Z');
  time.now = Date.parse('2026-10-22T19:20:00Z');
  assert.equal((await service.claimDue())[0].late, true);
  time.now = Date.parse('2026-10-25T09:00:00Z');
  assert.equal((await service.claimDue()).length, 1, 'after days off: one claim for the latest due time');
  assert.equal((await service.getSchedule(created.id)).nextRunAt, '2026-10-25T19:00:00.000Z');
});

test('PostgreSQL: a schedule that runs once turns itself off when claimed, and one that is off is never claimed', database, async () => {
  const once = await service.createSchedule({ ...good, name: 'Once', frequency: 'once', runDate: '2026-10-21' });
  const off = await service.createSchedule({ ...good, name: 'Off', enabled: false });
  time.now = Date.parse('2026-10-21T19:01:00Z');
  assert.deepEqual((await service.claimDue()).map(item => item.schedule.id), [once.id]);
  const after = await service.getSchedule(once.id);
  assert.deepEqual([after.enabled, after.nextRunAt], [false, null]);
  assert.equal((await service.getSchedule(off.id)).nextRunAt, null);
});

test('PostgreSQL: the history keeps what each run did, newest first, with its details; a schedule shows its latest; deleting a schedule keeps the history under its name; one schedule’s history is bounded', database, async () => {
  const first = await service.createSchedule(good), second = await service.createSchedule({ ...good, name: 'Second' });
  await service.recordRun(run(first, { startedAt: '2026-10-21T19:00:00.000Z' }));
  await service.recordRun(run(first, { startedAt: '2026-10-22T19:00:00.000Z', outcome: 'partial', failed: 1, details: [{ resourceId: VM1, name: 'vm', result: 'failed', detail: 'boom' }] }));
  await service.recordRun(run(second, { startedAt: '2026-10-22T19:05:00.000Z', outcome: 'missed', matched: 0, submitted: 0 }));
  assert.deepEqual((await service.listRuns()).map(item => [item.scheduleName, item.outcome]), [['Second', 'missed'], ['Nightly off', 'partial'], ['Nightly off', 'completed']]);
  assert.equal((await service.listRuns({ scheduleId: first.id })).length, 2); assert.equal((await service.listRuns({ limit: 1 })).length, 1);
  const shown = await service.getSchedule(first.id);
  assert.deepEqual([shown.lastRun.outcome, shown.lastRun.details[0].detail, shown.lastOutcome, shown.lastRunAt], ['partial', 'boom', 'partial', '2026-10-22T19:00:00.000Z']);
  assert.deepEqual(await service.deleteSchedule(first.id), { deleted: 1 });
  assert.equal(await service.deleteSchedule(first.id), null);
  assert.deepEqual((await service.listRuns()).filter(item => item.scheduleName === 'Nightly off').map(item => item.scheduleId), [null, null]);
  for (let i = 0; i < LIMITS.runsKept + 15; i++) await service.recordRun(run(second, { startedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 1000).toISOString() }));
  assert.equal((await service.listRuns({ scheduleId: second.id, limit: 200 })).length, LIMITS.runsKept);
});

test('PostgreSQL: the tables refuse what the rules refuse', database, async () => {
  const insert = over => db.adminPool.query('INSERT INTO operations.schedules(name, operation, target_kind, vm_ids, tag, frequency, time_of_day, weekdays, run_date, time_zone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [over.name ?? `row ${randomUUID().slice(0, 6)}`, over.operation ?? 'stop', over.kind ?? 'vms', over.vms ?? [VM1], over.tag ?? null, over.frequency ?? 'daily', over.time ?? '19:00', over.weekdays ?? [], over.date ?? null, 'UTC']);
  await insert({});
  for (const bad of [{ operation: 'delete' }, { kind: 'all' }, { frequency: 'hourly' }, { time: '25:00' }, { vms: [] }, { kind: 'tag', vms: [], tag: null }, { tag: 'env' }, { frequency: 'weekly' }, { frequency: 'weekly', weekdays: [1], date: '2026-10-21' }, { frequency: 'once' }, { weekdays: [1] }])
    await assert.rejects(insert(bad), error => error.code === '23514', JSON.stringify(bad));
  await assert.rejects(db.adminPool.query("INSERT INTO operations.schedule_runs(schedule_name, operation, trigger, scheduled_for, started_at, outcome) VALUES('x','stop','sometimes',now(),now(),'completed')"), error => error.code === '23514');
  await assert.rejects(db.adminPool.query("INSERT INTO operations.schedule_runs(schedule_name, operation, trigger, scheduled_for, started_at, outcome) VALUES('x','stop','manual',now(),now(),'exploded')"), error => error.code === '23514');
});

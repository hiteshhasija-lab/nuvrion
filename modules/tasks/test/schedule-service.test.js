import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleService } from '../src/schedule-service.js';
import { LIMITS } from '../src/schedule-rules.js';

// The local (file-backed) schedule store: creating and changing schedules, when each is due and claimed, the history of runs, and that all of it survives a restart.
const VM1 = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-21T10:00:00Z');
const good = { name: 'Nightly off', operation: 'stop', targetKind: 'vms', vmIds: [VM1], frequency: 'daily', timeOfDay: '19:00', timeZone: 'UTC' };
function clocked(options = {}) { const time = { now: T0 }; return { time, service: new ScheduleService({ clock: () => time.now, ...options }) }; }
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);
const run = (schedule, over = {}) => ({ scheduleId: schedule.id, scheduleName: schedule.name, operation: schedule.operation, trigger: 'schedule', scheduledFor: T0, startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0).toISOString(), outcome: 'completed', matched: 1, submitted: 1, skipped: 0, failed: 0, ...over });

test('a schedule is created with its next run worked out, named uniquely, limited to a hundred, and changed with a version', async () => {
  const { service } = clocked();
  const created = await service.createSchedule(good, 'user-1');
  assert.deepEqual([created.name, created.enabled, created.nextRunAt, created.rowVersion, created.createdBy, created.lastRun], ['Nightly off', true, '2026-10-21T19:00:00.000Z', 1, 'user-1', null]);
  await refused(service.createSchedule({ ...good, name: 'nightly OFF' }), 'NUV_SCHEDULE_EXISTS');
  await refused(service.createSchedule({ ...good, name: 'Bad', timeOfDay: '7pm' }), 'NUV_SCHEDULE_INVALID');
  const changed = await service.updateSchedule(created.id, { timeOfDay: '20:30', operation: 'power_off' }, 1);
  assert.deepEqual([changed.timeOfDay, changed.operation, changed.nextRunAt, changed.rowVersion], ['20:30', 'power_off', '2026-10-21T20:30:00.000Z', 2]);
  await refused(service.updateSchedule(created.id, { timeOfDay: '21:00' }, 1), 'VERSION_CONFLICT');
  assert.equal(await service.updateSchedule('nope', { timeOfDay: '21:00' }, 1), null);
  const second = await service.createSchedule({ ...good, name: 'Second' });
  await refused(service.updateSchedule(second.id, { name: 'NIGHTLY off' }, 1), 'NUV_SCHEDULE_EXISTS');
  assert.deepEqual((await service.listSchedules()).map(item => item.name), ['Nightly off', 'Second']);
  for (let i = 0; i < LIMITS.schedules - 2; i++) await service.createSchedule({ ...good, name: `Schedule ${i}` });
  await refused(service.createSchedule({ ...good, name: 'one too many' }), 'NUV_SCHEDULE_LIMIT');
});

test('turning a schedule off clears its next run and turning it on works it out again; a time that has already passed is refused', async () => {
  const { service } = clocked();
  const created = await service.createSchedule(good);
  const off = await service.updateSchedule(created.id, { enabled: false }, 1);
  assert.deepEqual([off.enabled, off.nextRunAt], [false, null]);
  const on = await service.updateSchedule(created.id, { enabled: true }, 2);
  assert.equal(on.nextRunAt, '2026-10-21T19:00:00.000Z');
  await refused(service.createSchedule({ ...good, name: 'Past', frequency: 'once', runDate: '2026-10-20' }), 'NUV_SCHEDULE_INVALID');
  const past = await service.createSchedule({ ...good, name: 'Past but off', frequency: 'once', runDate: '2026-10-20', enabled: false });
  assert.equal(past.nextRunAt, null);
  await refused(service.updateSchedule(past.id, { enabled: true }, 1), 'NUV_SCHEDULE_INVALID');
});

test('a due schedule is claimed once and moved on to its next run; one that is not yet due is left; a run too late is reported as late', async () => {
  const { service, time } = clocked();
  const created = await service.createSchedule(good);
  assert.deepEqual(await service.claimDue(), [], 'not due at 10:00');
  time.now = Date.parse('2026-10-21T19:00:30Z');
  const [claimed, ...rest] = await service.claimDue();
  assert.deepEqual([rest.length, claimed.schedule.id, claimed.scheduledFor, claimed.late], [0, created.id, Date.parse('2026-10-21T19:00:00Z'), false]);
  assert.deepEqual(await service.claimDue(), [], 'claimed: a second look finds nothing');
  assert.equal((await service.getSchedule(created.id)).nextRunAt, '2026-10-22T19:00:00.000Z');
  time.now = Date.parse('2026-10-22T19:20:00Z');
  const [late] = await service.claimDue();
  assert.equal(late.late, true, 'twenty minutes after its time: past the fifteen of grace');
  time.now = Date.parse('2026-10-25T09:00:00Z');   // Nuvrion was off for days: one claim, for the latest due time, and the next run is the first after now
  const caught = await service.claimDue();
  assert.deepEqual([caught.length, caught[0].late], [1, true]);
  assert.equal((await service.getSchedule(created.id)).nextRunAt, '2026-10-25T19:00:00.000Z');
});

test('a schedule that runs once turns itself off when it has been claimed, and a schedule that is off is never claimed', async () => {
  const { service, time } = clocked();
  const once = await service.createSchedule({ ...good, name: 'Once', frequency: 'once', runDate: '2026-10-21' });
  const off = await service.createSchedule({ ...good, name: 'Off', enabled: false });
  time.now = Date.parse('2026-10-21T19:01:00Z');
  const claimed = await service.claimDue();
  assert.deepEqual(claimed.map(item => item.schedule.id), [once.id]);
  const after = await service.getSchedule(once.id);
  assert.deepEqual([after.enabled, after.nextRunAt], [false, null]);
  assert.equal((await service.getSchedule(off.id)).nextRunAt, null);
});

test('the history keeps what each run did, newest first; a schedule shows its latest; deleting a schedule keeps its history under its name', async () => {
  const { service } = clocked();
  const first = await service.createSchedule(good), second = await service.createSchedule({ ...good, name: 'Second' });
  await service.recordRun(run(first, { startedAt: '2026-10-21T19:00:00.000Z' }));
  await service.recordRun(run(first, { startedAt: '2026-10-22T19:00:00.000Z', outcome: 'partial', failed: 1 }));
  await service.recordRun(run(second, { startedAt: '2026-10-22T19:05:00.000Z', details: [{ resourceId: VM1, name: 'vm', result: 'submitted', taskId: 't1' }] }));
  assert.deepEqual((await service.listRuns()).map(item => [item.scheduleName, item.outcome]), [['Second', 'completed'], ['Nightly off', 'partial'], ['Nightly off', 'completed']]);
  assert.equal((await service.listRuns({ scheduleId: first.id })).length, 2); assert.equal((await service.listRuns({ limit: 1 })).length, 1);
  const shown = await service.getSchedule(first.id);
  assert.deepEqual([shown.lastRun.outcome, shown.lastRunAt, shown.lastOutcome], ['partial', '2026-10-22T19:00:00.000Z', 'partial']);
  assert.deepEqual(await service.deleteSchedule(first.id), { deleted: 1 });
  assert.equal(await service.deleteSchedule(first.id), null);
  const kept = await service.listRuns();
  assert.deepEqual(kept.filter(item => item.scheduleName === 'Nightly off').map(item => item.scheduleId), [null, null], 'the history stays, no longer pointing at a schedule');
});

test('the history of one schedule is bounded', async () => {
  const { service } = clocked();
  const schedule = await service.createSchedule(good);
  for (let i = 0; i < LIMITS.runsKept + 20; i++) await service.recordRun(run(schedule, { startedAt: new Date(T0 + i * 1000).toISOString() }));
  assert.equal((await service.listRuns({ scheduleId: schedule.id, limit: 200 })).length, LIMITS.runsKept);
});

test('everything survives a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nuvrion-schedules-'));
  try {
    const file = join(directory, 'schedules.json'), first = clocked({ file });
    const schedule = await first.service.createSchedule(good, 'user-1');
    await first.service.recordRun(run(schedule));
    const second = clocked({ file });
    assert.deepEqual((await second.service.listSchedules()).map(item => [item.id, item.nextRunAt, item.lastRun?.outcome]), [[schedule.id, '2026-10-21T19:00:00.000Z', 'completed']]);
    assert.equal((await second.service.listRuns()).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

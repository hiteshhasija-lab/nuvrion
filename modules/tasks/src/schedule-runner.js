// Running schedules (docs/schedules.md). The runner decides what happens when a schedule is due or run by hand; the things it needs from the rest of the platform are passed in, so
// it can be tested with stand-ins and the clock moved by hand:
//   schedules        the store (claimDue, recordRun)
//   listResources()  the virtual machines
//   tagsOf()         resolves to a function resource -> [{ key, value }] (Nuvrion's tags and the provider's)
//   submit(resource, operation, { key, requestedBy })   asks the task engine for the operation: { result: 'submitted', taskId } | { result: 'skipped', detail } | { result: 'failed', detail }
//   requester(userId)  who the schedule runs as, { id, username }, or null when that person may no longer operate machines (gone, disabled, or without resource.operate)
//   audit(event)     writes an audit event; clock() the time in ms
// A schedule runs as the person who made it, with that person's permissions as they are at the time of the run, not as they were when it was made.
import { resolveTargets, summariseRun, OPERATIONS } from './schedule-rules.js';

export function createScheduleRunner({ schedules, listResources, tagsOf, submit, requester, audit = async () => {}, clock = Date.now, log = () => {} }) {
  let running = false;

  async function execute(schedule, { scheduledFor, trigger, requestedBy = null }) {
    const startedAt = clock(), who = requestedBy ?? (schedule.createdBy ? await requester(schedule.createdBy) : null);
    const base = { scheduleId: schedule.id, scheduleName: schedule.name, operation: schedule.operation, trigger, scheduledFor, startedAt: new Date(startedAt).toISOString(), requestedBy: who?.id ?? schedule.createdBy ?? null };
    let run;
    if (!who) {
      run = { ...base, finishedAt: new Date(clock()).toISOString(), outcome: 'error', matched: 0, submitted: 0, skipped: 0, failed: 0, details: [], detailsTruncated: false, error: 'The person who made this schedule can no longer operate machines, so it did nothing. Ask someone who can to make it again.' };
    } else {
      try {
        const resources = await listResources(), tags = await tagsOf(), { machines, gone } = resolveTargets(schedule, resources, tags);
        const results = [];
        for (const resource of machines) {
          let outcome;
          try { outcome = await submit(resource, schedule.operation, { key: `schedule:${schedule.id}:${trigger}:${scheduledFor}:${resource.id}`, requestedBy: who }); }
          catch (error) { outcome = { result: 'failed', detail: error.message }; }
          results.push({ resourceId: resource.id, name: resource.name, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.taskId ? { taskId: outcome.taskId } : {}) });
        }
        run = { ...base, finishedAt: new Date(clock()).toISOString(), ...summariseRun({ results, gone }), error: null };
      } catch (error) {
        run = { ...base, finishedAt: new Date(clock()).toISOString(), outcome: 'error', matched: 0, submitted: 0, skipped: 0, failed: 0, details: [], detailsTruncated: false, error: error.message };
      }
    }
    const recorded = await schedules.recordRun(run);
    await audit({ action: 'schedule.run', schedule, run: recorded, who });
    return recorded;
  }

  // Everything due now. A run that is more than the grace period late (Nuvrion was not running) is recorded as missed rather than run: a machine switched off at 19:00 should not be
  // switched off at 08:00 because the server came back then.
  async function runDue() {
    if (running) return [];
    running = true;
    try {
      const now = clock(), recorded = [];
      for (const { schedule, scheduledFor, late } of await schedules.claimDue(now)) {
        try {
          if (late) {
            const missed = await schedules.recordRun({ scheduleId: schedule.id, scheduleName: schedule.name, operation: schedule.operation, trigger: 'schedule', scheduledFor, startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), outcome: 'missed', matched: 0, submitted: 0, skipped: 0, failed: 0, details: [], detailsTruncated: false, error: null, requestedBy: schedule.createdBy ?? null });
            await audit({ action: 'schedule.run', schedule, run: missed, who: null });
            recorded.push(missed);
          } else recorded.push(await execute(schedule, { scheduledFor, trigger: 'schedule' }));
        } catch (error) { log(`schedule ${schedule.id} could not be run: ${error.message}`); }
      }
      return recorded;
    } finally { running = false; }
  }

  return { execute, runDue, operations: OPERATIONS };
}

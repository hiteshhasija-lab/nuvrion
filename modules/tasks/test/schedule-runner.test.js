import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleService } from '../src/schedule-service.js';
import { createScheduleRunner } from '../src/schedule-runner.js';

// What happens when a schedule is due or run by hand, with stand-ins for the platform and a clock moved by hand: who it runs as, which machines, that a request is made once, what
// is skipped and why, what a late run does, and that one broken machine does not stop the others.
const VM = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const T0 = Date.parse('2026-10-21T10:00:00Z');
const good = { name: 'Nightly off', operation: 'stop', targetKind: 'vms', vmIds: [VM(1), VM(2)], frequency: 'daily', timeOfDay: '19:00', timeZone: 'UTC' };
const vm = (n, extra = {}) => ({ id: VM(n), name: `vm${n}`, resourceType: 'virtual_machine', lifecycleState: 'active', connectionId: 'c1', ...extra });

function setup(over = {}) {
  const time = { now: T0 }, requests = [], audits = [], resources = over.resources ?? [vm(1), vm(2), vm(3)], tags = over.tags ?? {};
  const schedules = new ScheduleService({ clock: () => time.now });
  const runner = createScheduleRunner({
    schedules, clock: () => time.now, audit: async event => audits.push(event),
    listResources: over.listResources ?? (async () => resources), tagsOf: async () => resource => tags[resource.id] ?? [],
    requester: async userId => (over.allowed === false ? null : { id: userId, username: `user-${userId}` }),
    submit: over.submit ?? (async (resource, operation, context) => { requests.push({ resource: resource.id, operation, key: context.key, by: context.requestedBy.username }); return { result: 'submitted', taskId: `task-${requests.length}` }; })
  });
  return { time, schedules, runner, requests, audits };
}

test('a due schedule asks for the operation on each listed machine, as the person who made it, with a key that makes a repeat harmless', async () => {
  const { schedules, runner, requests, time, audits } = setup();
  const created = await schedules.createSchedule(good, 'u1');
  assert.deepEqual(await runner.runDue(), [], 'nothing is due at 10:00');
  time.now = Date.parse('2026-10-21T19:00:20Z');
  const [run] = await runner.runDue();
  assert.deepEqual([run.outcome, run.matched, run.submitted, run.trigger, run.scheduleName], ['completed', 2, 2, 'schedule', 'Nightly off']);
  assert.deepEqual(requests.map(item => [item.resource, item.operation, item.by]), [[VM(1), 'stop', 'user-u1'], [VM(2), 'stop', 'user-u1']]);
  assert.equal(new Set(requests.map(item => item.key)).size, 2); assert.match(requests[0].key, new RegExp(`^schedule:${created.id}:schedule:${Date.parse('2026-10-21T19:00:00Z')}:`));
  assert.deepEqual(run.details.map(item => [item.name, item.result, item.taskId]), [['vm1', 'submitted', 'task-1'], ['vm2', 'submitted', 'task-2']]);
  assert.deepEqual(await runner.runDue(), [], 'claimed: it does not run twice');
  assert.deepEqual([audits.length, audits[0].action, audits[0].run.outcome], [1, 'schedule.run', 'completed']);
  assert.equal((await schedules.getSchedule(created.id)).lastRun.outcome, 'completed');
});

test('machines already in the state asked for are skipped and the run says so; one that fails does not stop the others', async () => {
  const outcomes = { [VM(1)]: { result: 'skipped', detail: 'It is already off.' }, [VM(2)]: new Error('provider unreachable') };
  const { schedules, runner, time } = setup({ resources: [vm(1), vm(2), vm(3)], submit: async resource => { const outcome = outcomes[resource.id]; if (outcome instanceof Error) throw outcome; return outcome ?? { result: 'submitted', taskId: 't3' }; } });
  await schedules.createSchedule({ ...good, vmIds: [VM(1), VM(2), VM(3)] }, 'u1');
  time.now = Date.parse('2026-10-21T19:00:05Z');
  const [run] = await runner.runDue();
  assert.deepEqual([run.outcome, run.matched, run.submitted, run.skipped, run.failed], ['partial', 3, 1, 1, 1]);
  assert.deepEqual(run.details.map(item => [item.name, item.result, item.detail ?? null]), [['vm1', 'skipped', 'It is already off.'], ['vm2', 'failed', 'provider unreachable'], ['vm3', 'submitted', null]]);
});

test('listed machines that no longer exist are reported, and tagged schedules pick the machines that have the tag at the time of the run', async () => {
  const tags = { [VM(1)]: [{ key: 'env', value: 'dev' }], [VM(3)]: [{ key: 'env', value: 'dev' }] };
  const { schedules, runner, requests, time } = setup({ resources: [vm(1), vm(3), vm(4)], tags });
  await schedules.createSchedule({ ...good, name: 'Listed', vmIds: [VM(1), VM(9)] }, 'u1');
  await schedules.createSchedule({ name: 'By tag', operation: 'start', targetKind: 'tag', tag: 'env=dev', frequency: 'daily', timeOfDay: '19:00', timeZone: 'UTC' }, 'u1');
  time.now = Date.parse('2026-10-21T19:00:05Z');
  const runs = await runner.runDue();
  const listed = runs.find(run => run.scheduleName === 'Listed'), byTag = runs.find(run => run.scheduleName === 'By tag');
  assert.deepEqual([listed.matched, listed.submitted, listed.skipped, listed.details.at(-1).detail], [2, 1, 1, 'That machine is no longer there.']);
  assert.deepEqual([byTag.submitted, requests.filter(item => item.operation === 'start').map(item => item.resource)], [2, [VM(1), VM(3)]]);
  tags[VM(4)] = [{ key: 'env', value: 'dev' }];   // tagged afterwards: the next run includes it
  time.now = Date.parse('2026-10-22T19:00:05Z');
  assert.equal((await runner.runDue()).find(run => run.scheduleName === 'By tag').submitted, 3);
});

test('a run more than fifteen minutes late is recorded as missed and does nothing; the schedule carries on at its next time', async () => {
  const { schedules, runner, requests, time } = setup();
  const created = await schedules.createSchedule(good, 'u1');
  time.now = Date.parse('2026-10-22T08:00:00Z');   // Nuvrion was off overnight
  const [run] = await runner.runDue();
  assert.deepEqual([run.outcome, run.matched, requests.length], ['missed', 0, 0]);
  assert.equal((await schedules.getSchedule(created.id)).nextRunAt, '2026-10-22T19:00:00.000Z');
});

test('a schedule whose owner can no longer operate machines does nothing and says why; a run by hand uses the person who asked', async () => {
  const { schedules, runner, requests, time } = setup({ allowed: false });
  const created = await schedules.createSchedule(good, 'u1');
  time.now = Date.parse('2026-10-21T19:00:05Z');
  const [run] = await runner.runDue();
  assert.deepEqual([run.outcome, requests.length], ['error', 0]); assert.match(run.error, /can no longer operate machines/);
  const manual = await runner.execute(created, { scheduledFor: time.now, trigger: 'manual', requestedBy: { id: 'u2', username: 'olivia' } });
  assert.deepEqual([manual.outcome, manual.trigger, manual.submitted], ['completed', 'manual', 2]);
  assert.equal(requests[0].by, 'olivia'); assert.match(requests[0].key, /:manual:/);
});

test('a schedule that runs once runs once, and a failure inside the runner is recorded instead of escaping', async () => {
  const { schedules, runner, time } = setup();
  await schedules.createSchedule({ ...good, name: 'Once', frequency: 'once', runDate: '2026-10-21' }, 'u1');
  time.now = Date.parse('2026-10-21T19:00:05Z');
  assert.equal((await runner.runDue()).length, 1);
  time.now = Date.parse('2026-10-22T19:00:05Z');
  assert.deepEqual(await runner.runDue(), []);
  const broken = setup({ listResources: async () => { throw new Error('inventory unavailable'); } });
  await broken.schedules.createSchedule(good, 'u1');
  broken.time.now = Date.parse('2026-10-21T19:00:05Z');
  const [run] = await broken.runner.runDue();
  assert.equal(run.outcome, 'error'); assert.equal(run.error, 'inventory unavailable');
});

test('overlapping checks do not run a schedule twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { schedules, runner, time } = setup({ submit: async () => { await gate; return { result: 'submitted', taskId: 't' }; } });
  await schedules.createSchedule(good, 'u1');
  time.now = Date.parse('2026-10-21T19:00:05Z');
  const first = runner.runDue(), second = await runner.runDue();
  assert.deepEqual(second, [], 'a check that starts while another is running does nothing');
  release(); assert.equal((await first).length, 1);
});

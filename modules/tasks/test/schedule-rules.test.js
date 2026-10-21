import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, mergeSchedule, nextRun, nextRuns, localToUtc, isLate, describeWhen, describeTargets, describeSchedule, describeRun, resolveTargets, summariseRun, validTimeZone, LIMITS, ScheduleError } from '../src/schedule-rules.js';

// When a schedule runs, in its own time zone and through daylight-saving changes, which machines it covers, and how a run is summarised.
const VM1 = '11111111-1111-4111-8111-111111111111', VM2 = '22222222-2222-4222-8222-222222222222', CONNECTION = '33333333-3333-4333-8333-333333333333';
const daily = over => ({ name: 'Nightly off', operation: 'stop', targetKind: 'vms', vmIds: [VM1], frequency: 'daily', timeOfDay: '19:00', timeZone: 'UTC', ...over });
const refused = (work, pattern) => assert.throws(work, error => error instanceof ScheduleError && (!pattern || pattern.test(error.message)), String(work).slice(0, 80));
const iso = ms => new Date(ms).toISOString();

test('a schedule is validated: operation, targets, frequency, time, days, date, time zone, and that fields belong to the shape chosen', () => {
  assert.deepEqual(parseSchedule(daily()), { name: 'Nightly off', description: '', operation: 'stop', targetKind: 'vms', vmIds: [VM1], tag: null, connectionId: null, frequency: 'daily', timeOfDay: '19:00', weekdays: [], runDate: null, timeZone: 'UTC', enabled: true });
  const weekly = parseSchedule(daily({ frequency: 'weekly', weekdays: [5, 1, 1, 3], targetKind: 'tag', vmIds: undefined, tag: ' Env = dev ', connectionId: CONNECTION.toUpperCase(), timeZone: 'Europe/London', description: ' d ' }));
  assert.deepEqual([weekly.weekdays, weekly.tag, weekly.connectionId, weekly.vmIds, weekly.timeZone, weekly.description], [[1, 3, 5], 'env=dev', CONNECTION, [], 'Europe/London', 'd']);
  assert.equal(parseSchedule(daily({ frequency: 'once', runDate: '2026-10-21' })).runDate, '2026-10-21');
  assert.equal(parseSchedule(daily({ vmIds: [VM1, VM1.toUpperCase(), VM2] })).vmIds.length, 2, 'repeats collapse');
  assert.equal(parseSchedule({ ...daily(), timeZone: undefined }).timeZone, 'UTC', 'UTC unless told otherwise');
  const bad = [null, [], 'x', daily({ operation: 'delete' }), daily({ operation: undefined }), daily({ targetKind: 'all' }), daily({ frequency: 'hourly' }), daily({ timeOfDay: '7pm' }), daily({ timeOfDay: '24:00' }), daily({ timeOfDay: '19:60' }),
    daily({ timeZone: 'Mars/Olympus' }), daily({ timeZone: 5 }), daily({ name: '  ' }), daily({ name: 'x'.repeat(101) }), daily({ description: 'x'.repeat(301) }), daily({ name: 'a\u0000b' }), daily({ enabled: 'yes' }), daily({ extra: 1 }),
    daily({ vmIds: [] }), daily({ vmIds: undefined }), daily({ vmIds: ['nope'] }), daily({ vmIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }), daily({ tag: 'env' }),
    daily({ targetKind: 'tag', vmIds: undefined }), daily({ targetKind: 'tag', vmIds: undefined, tag: '' }), daily({ targetKind: 'tag', vmIds: undefined, tag: 'env', connectionId: 'nope' }), daily({ targetKind: 'tag', vmIds: [VM1], tag: 'env' }),
    daily({ connectionId: CONNECTION }), daily({ frequency: 'weekly' }), daily({ frequency: 'weekly', weekdays: [] }), daily({ frequency: 'weekly', weekdays: [7] }), daily({ frequency: 'weekly', weekdays: ['1'] }), daily({ weekdays: [1] }),
    daily({ frequency: 'once' }), daily({ frequency: 'once', runDate: '2026-02-30' }), daily({ frequency: 'once', runDate: '21/10/2026' }), daily({ runDate: '2026-10-21' })];
  for (const body of bad) refused(() => parseSchedule(body));
  assert.equal(validTimeZone('Asia/Kolkata'), true); assert.equal(validTimeZone('Nope/Zone'), false); assert.equal(validTimeZone(''), false);
});

test('a change replaces the fields given; fields that no longer apply are dropped instead of refused', () => {
  const existing = { id: 's1', ...parseSchedule(daily({ frequency: 'once', runDate: '2026-10-21' })) };
  const changed = mergeSchedule(existing, { frequency: 'daily' });
  assert.deepEqual([changed.frequency, changed.runDate], ['daily', null]);
  const weekly = mergeSchedule(changed, { frequency: 'weekly', weekdays: [1, 2] });
  assert.deepEqual(weekly.weekdays, [1, 2]);
  assert.deepEqual(mergeSchedule({ id: 's', ...weekly }, { frequency: 'daily' }).weekdays, []);
  const byTag = mergeSchedule({ id: 's', ...weekly }, { targetKind: 'tag', tag: 'env=dev', connectionId: CONNECTION });
  assert.deepEqual([byTag.targetKind, byTag.tag, byTag.vmIds, byTag.connectionId], ['tag', 'env=dev', [], CONNECTION]);
  assert.deepEqual([mergeSchedule({ id: 's', ...byTag }, { targetKind: 'vms', vmIds: [VM2] }).tag, mergeSchedule({ id: 's', ...byTag }, { targetKind: 'vms', vmIds: [VM2] }).connectionId], [null, null]);
  refused(() => mergeSchedule(existing, {}), /Nothing to change/); refused(() => mergeSchedule(existing, { id: 'x' }), /Unknown field/); refused(() => mergeSchedule(weekly, { weekdays: [9] })); refused(() => mergeSchedule({ id: 's', ...weekly }, { targetKind: 'vms', tag: 'x', vmIds: [VM1] }), /no tag/);
});

test('wall-clock times become instants in the schedule’s own time zone', () => {
  assert.equal(iso(localToUtc({ year: 2026, month: 10, day: 21, hour: 19, minute: 0 }, 'UTC')), '2026-10-21T19:00:00.000Z');
  assert.equal(iso(localToUtc({ year: 2026, month: 10, day: 21, hour: 19, minute: 0 }, 'Europe/London')), '2026-10-21T18:00:00.000Z', 'London is on summer time until 25 October');
  assert.equal(iso(localToUtc({ year: 2026, month: 12, day: 21, hour: 19, minute: 0 }, 'Europe/London')), '2026-12-21T19:00:00.000Z');
  assert.equal(iso(localToUtc({ year: 2026, month: 10, day: 21, hour: 9, minute: 0 }, 'Asia/Kolkata')), '2026-10-21T03:30:00.000Z');
  assert.equal(iso(localToUtc({ year: 2026, month: 10, day: 21, hour: 9, minute: 0 }, 'America/New_York')), '2026-10-21T13:00:00.000Z');
  assert.equal(iso(localToUtc({ year: 2026, month: 10, day: 21, hour: 9, minute: 0 }, 'Pacific/Auckland')), '2026-10-20T20:00:00.000Z', 'ahead of UTC: the previous day in UTC');
});

test('daylight saving: a time that happens twice runs once, at its first occurrence; a time that does not exist runs just after the gap', () => {
  const at = (day, hour, minute, zone, month = 10) => iso(localToUtc({ year: 2026, month, day, hour, minute }, zone));
  assert.equal(at(25, 1, 30, 'Europe/London'), '2026-10-25T00:30:00.000Z', 'clocks go back at 02:00 BST: 01:30 happens twice, the first is 00:30 UTC');
  assert.equal(at(29, 1, 30, 'Europe/London', 3), '2026-03-29T01:30:00.000Z', 'clocks go forward at 01:00 UTC: 01:30 does not exist, so it runs at 02:30 local, which is 01:30 UTC');
  assert.equal(at(8, 2, 30, 'America/New_York', 3), '2026-03-08T07:30:00.000Z', '02:30 does not exist: it runs at 03:30 EDT');
  assert.equal(at(1, 1, 30, 'America/New_York', 11), '2026-11-01T05:30:00.000Z', '01:30 happens twice: the first, in EDT');
  assert.equal(at(29, 0, 59, 'Europe/London', 3), '2026-03-29T00:59:00.000Z'); assert.equal(at(29, 3, 0, 'Europe/London', 3), '2026-03-29T02:00:00.000Z');
});

test('the next run of a daily schedule is today if it is still ahead, otherwise tomorrow, and keeps its local time through a clock change', () => {
  const schedule = parseSchedule(daily({ timeOfDay: '19:00', timeZone: 'Europe/London' }));
  assert.equal(iso(nextRun(schedule, Date.parse('2026-10-21T10:00:00Z'))), '2026-10-21T18:00:00.000Z');
  assert.equal(iso(nextRun(schedule, Date.parse('2026-10-21T18:00:00Z'))), '2026-10-22T18:00:00.000Z', 'strictly after: the moment itself is not "next"');
  assert.deepEqual(nextRuns(schedule, Date.parse('2026-10-24T12:00:00Z'), 3).map(iso), ['2026-10-24T18:00:00.000Z', '2026-10-25T19:00:00.000Z', '2026-10-26T19:00:00.000Z'], 'after the clocks go back, 19:00 is 19:00 UTC');
  const late = parseSchedule(daily({ timeOfDay: '23:30', timeZone: 'Pacific/Auckland' }));
  assert.equal(iso(nextRun(late, Date.parse('2026-10-21T10:00:00Z'))), '2026-10-21T10:30:00.000Z');
});

test('a weekly schedule runs on the chosen days only, a once-only schedule runs once, and a past date has no next run', () => {
  const weekdays = parseSchedule(daily({ frequency: 'weekly', weekdays: [1, 2, 3, 4, 5], timeOfDay: '07:00' }));
  assert.deepEqual(nextRuns(weekdays, Date.parse('2026-10-23T08:00:00Z'), 3).map(iso), ['2026-10-26T07:00:00.000Z', '2026-10-27T07:00:00.000Z', '2026-10-28T07:00:00.000Z'], 'Friday 23 October, after 07:00: the next is Monday');
  const sunday = parseSchedule(daily({ frequency: 'weekly', weekdays: [0], timeOfDay: '07:00' }));
  assert.equal(iso(nextRun(sunday, Date.parse('2026-10-25T08:00:00Z'))), '2026-11-01T07:00:00.000Z');
  const once = parseSchedule(daily({ frequency: 'once', runDate: '2026-10-30', timeOfDay: '12:00' }));
  assert.equal(iso(nextRun(once, Date.parse('2026-10-21T00:00:00Z'))), '2026-10-30T12:00:00.000Z');
  assert.equal(nextRun(once, Date.parse('2026-10-30T12:00:00Z')), null); assert.equal(nextRuns(once, Date.parse('2026-10-21T00:00:00Z'), 3).length, 1);
  const local = parseSchedule(daily({ frequency: 'weekly', weekdays: [1], timeOfDay: '00:30', timeZone: 'Asia/Kolkata' }));
  assert.equal(iso(nextRun(local, Date.parse('2026-10-21T00:00:00Z'))), '2026-10-25T19:00:00.000Z', 'Monday 00:30 in Kolkata is Sunday 19:00 UTC');
});

test('a run more than the grace period after its time is late', () => {
  assert.equal(isLate(1000, 1000 + 15 * 60_000), false); assert.equal(isLate(1000, 1001 + 15 * 60_000), true); assert.equal(isLate(1000, 900), false);
});

test('a schedule is described in words', () => {
  assert.equal(describeWhen(parseSchedule(daily())), 'every day at 19:00 (UTC)');
  assert.equal(describeWhen(parseSchedule(daily({ frequency: 'weekly', weekdays: [1, 2, 3, 4, 5], timeZone: 'Europe/London' }))), 'every weekday at 19:00 (Europe/London)');
  assert.equal(describeWhen(parseSchedule(daily({ frequency: 'weekly', weekdays: [0, 6] }))), 'every weekend at 19:00 (UTC)');
  assert.equal(describeWhen(parseSchedule(daily({ frequency: 'weekly', weekdays: [1, 4] }))), 'every Mon, Thu at 19:00 (UTC)');
  assert.equal(describeWhen(parseSchedule(daily({ frequency: 'once', runDate: '2026-10-30' }))), 'once on 2026-10-30 at 19:00 (UTC)');
  assert.equal(describeTargets(parseSchedule(daily())), '1 virtual machine'); assert.equal(describeTargets(parseSchedule(daily({ vmIds: [VM1, VM2] }))), '2 virtual machines');
  assert.equal(describeTargets(parseSchedule(daily({ targetKind: 'tag', vmIds: undefined, tag: 'env=dev' }))), 'machines tagged env=dev');
  assert.equal(describeSchedule(parseSchedule(daily({ operation: 'start', targetKind: 'tag', vmIds: undefined, tag: 'env=dev' }))), 'Power on: machines tagged env=dev, every day at 19:00 (UTC)');
});

const vm = (id, over = {}) => ({ id, name: `vm-${id.slice(0, 2)}`, resourceType: 'virtual_machine', lifecycleState: 'active', connectionId: CONNECTION, ...over });
test('machines are those listed (those that are gone are said to be), or those with the tag when the run happens, optionally within one connection', () => {
  const resources = [vm(VM1), vm(VM2, { lifecycleState: 'missing' }), vm('44444444-4444-4444-8444-444444444444', { connectionId: 'other' }), vm('55555555-5555-4555-8555-555555555555', { resourceType: 'datastore' })];
  const listed = resolveTargets(parseSchedule(daily({ vmIds: [VM1, VM2, '66666666-6666-4666-8666-666666666666'] })), resources);
  assert.deepEqual([listed.machines.map(item => item.id), listed.gone], [[VM1], [VM2, '66666666-6666-4666-8666-666666666666']]);
  const tags = { [VM1]: [{ key: 'env', value: 'dev' }], '44444444-4444-4444-8444-444444444444': [{ key: 'env', value: 'dev' }], '55555555-5555-4555-8555-555555555555': [{ key: 'env', value: 'dev' }], [VM2]: [{ key: 'env', value: 'dev' }] };
  const tagsOf = resource => tags[resource.id] ?? [];
  assert.deepEqual(resolveTargets(parseSchedule(daily({ targetKind: 'tag', vmIds: undefined, tag: 'env=dev' })), resources, tagsOf).machines.map(item => item.id), [VM1, '44444444-4444-4444-8444-444444444444'], 'active virtual machines only');
  assert.deepEqual(resolveTargets(parseSchedule(daily({ targetKind: 'tag', vmIds: undefined, tag: 'env=dev', connectionId: CONNECTION })), resources, tagsOf).machines.map(item => item.id), [VM1]);
  assert.equal(resolveTargets(parseSchedule(daily({ targetKind: 'tag', vmIds: undefined, tag: 'env=prod' })), resources, tagsOf).machines.length, 0);
  assert.equal(resolveTargets(parseSchedule(daily({ targetKind: 'tag', vmIds: undefined, tag: 'ENV' })), resources, tagsOf).machines.length, 2, 'a key alone matches any value, in any case');
});

test('a run is summarised: what was requested, skipped and failed, and the word for it', () => {
  const result = (resourceId, kind, detail) => ({ resourceId, name: resourceId, result: kind, detail });
  assert.deepEqual(Object.fromEntries(Object.entries(summariseRun({ results: [result('a', 'submitted'), result('b', 'submitted'), result('c', 'skipped', 'already off')] })).filter(([key]) => key !== 'details')), { outcome: 'completed', matched: 3, submitted: 2, skipped: 1, failed: 0, detailsTruncated: false });
  assert.equal(summariseRun({ results: [result('a', 'submitted'), result('b', 'failed')] }).outcome, 'partial');
  assert.equal(summariseRun({ results: [result('a', 'failed')] }).outcome, 'failed');
  assert.equal(summariseRun({ results: [result('a', 'skipped')] }).outcome, 'skipped');
  assert.equal(summariseRun({ results: [] }).outcome, 'skipped');
  const gone = summariseRun({ results: [result('a', 'submitted')], gone: ['x'] });
  assert.deepEqual([gone.matched, gone.skipped, gone.details.length, gone.details[1].detail], [2, 1, 2, 'That machine is no longer there.']);
  const many = summariseRun({ results: Array.from({ length: 150 }, (_, i) => result(`m${i}`, 'submitted')) });
  assert.deepEqual([many.details.length, many.detailsTruncated, many.submitted], [LIMITS.detailsKept, true, 150], 'the counts are complete, the detail list is bounded');
  assert.equal(describeRun({ outcome: 'completed', matched: 3, submitted: 2, skipped: 1, failed: 0 }), '2 requested, 1 skipped');
  assert.equal(describeRun({ outcome: 'partial', matched: 3, submitted: 1, skipped: 1, failed: 1 }), '1 requested, 1 skipped, 1 failed');
  assert.equal(describeRun({ outcome: 'skipped', matched: 0 }), 'No machines matched');
  assert.equal(describeRun({ outcome: 'missed' }), 'Missed: Nuvrion was not running at the time'); assert.equal(describeRun({ outcome: 'error', error: 'boom' }), 'Could not run: boom');
});

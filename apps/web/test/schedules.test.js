import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulesHtml, runsHtml, scheduleDialogHtml, previewHtml, scheduleRequestBody, scheduleProblem, visibility } from '../schedules.js';

// The schedule table, the run history, the dialog and the request it makes: what each says and offers to whom, which parts of the dialog apply to the choices made, that parts which do not
// apply are sent empty, and that nothing a server sent is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const when = value => `at ${value}`;
const badge = value => `<span class="badge ${value}">${esc(value)}</span>`;
const ctx = { esc, when, badge };
const operations = { start: 'Power on', stop: 'Shut down guest' };
const schedule = (over = {}) => ({ id: 's1', name: 'Stop at night', description: '', operation: 'stop', targetKind: 'vms', vmIds: ['m1'], tag: null, connectionId: null, frequency: 'daily', timeOfDay: '19:00', weekdays: [], runDate: null, timeZone: 'Europe/London', enabled: true, nextRunAt: '2026-10-22T18:00:00.000Z', rowVersion: 1, summary: 'Shut down guest: 1 virtual machine, every day at 19:00 (Europe/London)', lastRun: null, ...over });

test('the table shows each schedule with when it runs next and what happened last, and offers actions only to people who may manage them', () => {
  const last = { outcome: 'completed', startedAt: '2026-10-21T18:00:00Z', summary: '2 requested' };
  const html = schedulesHtml([schedule({ lastRun: last }), schedule({ id: 's2', name: 'Off one', enabled: false })], { ...ctx, canManage: true, canRun: true });
  assert.match(html, /Shut down guest: 1 virtual machine, every day at 19:00/); assert.match(html, /at 2026-10-22T18:00:00.000Z/); assert.match(html, /badge completed/); assert.match(html, /2 requested/); assert.match(html, /Not run yet/);
  assert.match(html, /turned off/); assert.match(html, /data-schedule-run="s1"/); assert.match(html, /data-schedule-toggle="s2">Turn on/); assert.match(html, /data-schedule-toggle="s1">Turn off/); assert.match(html, /data-schedule-edit="s1"/); assert.match(html, /data-schedule-delete="s1"/);
  assert.match(html, /sr-only"> schedule Stop at night/, 'each button says which schedule it is for');
  const readOnly = schedulesHtml([schedule()], { ...ctx, canManage: false, canRun: false });
  assert.doesNotMatch(readOnly, /<button/); assert.match(readOnly, /Stop at night/);
  assert.match(schedulesHtml([], { ...ctx, canManage: true }), /New schedule/); assert.match(schedulesHtml([], { ...ctx, canManage: false }), /Someone who may manage schedules/);
  assert.match(schedulesHtml([schedule({ targetKind: 'tag', tag: 'env=dev' })], { ...ctx, canManage: false }), /By tag/);
});

test('the history says what happened and why a machine was left alone, and shows only the first few reasons', () => {
  const run = { startedAt: '2026-10-21T18:00:00Z', scheduleName: 'Stop at night', trigger: 'manual', outcome: 'skipped', summary: '0 requested, 4 skipped', error: null, details: ['a', 'b', 'c', 'd'].map(name => ({ name, result: 'skipped', detail: 'Unavailable while power state is stopped.' })) };
  const html = runsHtml([run], ctx);
  assert.match(html, /Run by hand/); assert.match(html, /badge skipped/); assert.match(html, /0 requested, 4 skipped/); assert.equal((html.match(/Unavailable while power state is stopped/g) ?? []).length, 3);
  assert.doesNotMatch(runsHtml([{ ...run, details: [{ name: 'x', result: 'submitted', taskId: 't' }] }], ctx), /submitted/, 'what went well needs no note');
  assert.match(runsHtml([{ ...run, outcome: 'error', error: 'The creator can no longer operate machines.', details: [] }], ctx), /creator can no longer/);
  assert.match(runsHtml([], ctx), /Nothing has run yet/);
});

test('nothing a server sent is put in the page unescaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = schedulesHtml([schedule({ name: evil, summary: evil, description: evil, lastRun: { outcome: 'completed', startedAt: evil, summary: evil } })], { ...ctx, canManage: true, canRun: true })
    + runsHtml([{ startedAt: evil, scheduleName: evil, trigger: evil, outcome: 'failed', summary: evil, error: evil, details: [{ name: evil, result: evil, detail: evil }] }], ctx)
    + scheduleDialogHtml({ schedule: schedule({ name: evil, description: evil, tag: evil, targetKind: 'tag' }), operations, machines: [{ id: 'm1', name: evil }], connections: [{ id: 'c1', name: evil }], timeZones: [evil], error: evil }, ctx)
    + previewHtml({ nextRuns: [evil], matchedCount: 1, machines: [{ id: 'm1', name: evil }], goneCount: 0 }, ctx);
  assert.doesNotMatch(html, /<img/);
});

test('the dialog shows only the parts that apply: machines or tag, days of the week, a date', () => {
  assert.deepEqual(visibility({ targetKind: 'vms', frequency: 'daily' }), { machines: true, tag: false, weekdays: false, date: false });
  assert.deepEqual(visibility({ targetKind: 'tag', frequency: 'weekly' }), { machines: false, tag: true, weekdays: true, date: false });
  assert.deepEqual(visibility({ targetKind: 'vms', frequency: 'once' }), { machines: true, tag: false, weekdays: false, date: true });
  const machines = [{ id: 'm1', name: 'app-01' }, { id: 'm2', name: 'db-01' }];
  const fresh = scheduleDialogHtml({ operations, machines, connections: [], defaultZone: 'Asia/Kolkata' }, ctx);
  assert.match(fresh, /New schedule/); assert.match(fresh, /Create schedule/); assert.match(fresh, /value="Asia\/Kolkata"/); assert.match(fresh, /id="schedule-tag-box" class="tag-fields" hidden/); assert.match(fresh, /id="schedule-weekdays-box" hidden/); assert.match(fresh, /id="schedule-date-box" hidden/);
  assert.match(fresh, /0 machines chosen/);
  const weekly = scheduleDialogHtml({ schedule: schedule({ frequency: 'weekly', weekdays: [1, 3], vmIds: ['m2'] }), operations, machines, connections: [], timeZones: ['UTC'] }, ctx);
  assert.match(weekly, /Save changes/); assert.doesNotMatch(weekly, /id="schedule-weekdays-box" hidden/); assert.match(weekly, /name="weekdays" value="1" checked/); assert.match(weekly, /name="weekdays" value="2"><span>Tue/); assert.match(weekly, /name="vmIds" value="m2" checked/); assert.match(weekly, /1 machine chosen/);
  const gone = scheduleDialogHtml({ schedule: schedule({ vmIds: ['m1', 'zz'] }), operations, machines, connections: [] }, ctx);
  assert.match(gone, /name="vmIds" value="zz" checked/); assert.match(gone, /no longer there/);
  const tagged = scheduleDialogHtml({ schedule: schedule({ targetKind: 'tag', tag: 'env=dev', connectionId: 'c1', vmIds: [] }), operations, machines, connections: [{ id: 'c1', name: 'Lab' }] }, ctx);
  assert.match(tagged, /value="env=dev"/); assert.match(tagged, /<option value="c1" selected>Lab/); assert.match(tagged, /id="schedule-machines-box" hidden/);
});

test('the preview lists the next runs and the machines that would be covered', () => {
  const html = previewHtml({ nextRuns: ['a', 'b'], matchedCount: 22, machines: [{ id: '1', name: 'one' }, { id: '2', name: 'two' }], goneCount: 1 }, ctx);
  assert.match(html, /at a/); assert.match(html, /22 machines would be covered right now:<\/strong> one, two and 20 more/); assert.match(html, /1 listed machine no longer there/);
  assert.match(previewHtml({ nextRuns: [], matchedCount: 0, machines: [], goneCount: 0 }, ctx), /would not run again.*No machines would be covered/s);
});

test('the request sends only what applies, and empties the rest so a change of shape leaves nothing behind', () => {
  const values = { name: ' Stop ', description: ' x ', operation: 'stop', targetKind: 'vms', vmIds: ['m1'], tag: 'env=dev', connectionId: 'c1', frequency: 'weekly', timeOfDay: '07:00', weekdays: ['3', '1'], runDate: '2026-12-01', timeZone: ' UTC ', enabled: true };
  assert.deepEqual(scheduleRequestBody(values), { name: 'Stop', description: 'x', operation: 'stop', targetKind: 'vms', vmIds: ['m1'], tag: null, connectionId: null, frequency: 'weekly', timeOfDay: '07:00', weekdays: [1, 3], runDate: null, timeZone: 'UTC', enabled: true });
  assert.deepEqual(scheduleRequestBody({ ...values, targetKind: 'tag', frequency: 'once', connectionId: '' }), { name: 'Stop', description: 'x', operation: 'stop', targetKind: 'tag', vmIds: [], tag: 'env=dev', connectionId: null, frequency: 'once', timeOfDay: '07:00', weekdays: [], runDate: '2026-12-01', timeZone: 'UTC', enabled: true });
  assert.equal(scheduleRequestBody({ ...values, targetKind: 'tag', connectionId: 'c1' }).connectionId, 'c1');
});

test('checks that save a round trip say what is missing', () => {
  const good = scheduleRequestBody({ name: 'n', operation: 'stop', targetKind: 'vms', vmIds: ['m'], frequency: 'daily', timeOfDay: '07:00', timeZone: 'UTC', enabled: true });
  assert.equal(scheduleProblem(good), null);
  const cases = [[{ name: '' }, /name/], [{ vmIds: [] }, /machine/], [{ vmIds: Array.from({ length: 51 }, (_, i) => String(i)) }, /at most 50/], [{ targetKind: 'tag', vmIds: [], tag: '' }, /tag/], [{ timeOfDay: '' }, /time of day/], [{ frequency: 'weekly' }, /day of the week/], [{ frequency: 'once' }, /date/], [{ timeZone: '' }, /time zone/]];
  for (const [change, pattern] of cases) assert.match(scheduleProblem({ ...good, ...change }), pattern);
});

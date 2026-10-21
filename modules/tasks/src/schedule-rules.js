// Scheduled operations (docs/schedules.md): what a schedule may look like, when it next runs (in the schedule's own time zone, through daylight-saving changes), which machines it
// covers, and how a run is summarised. Pure functions, shared by both stores (the local file and PostgreSQL) so they cannot disagree about when a schedule runs.
//
// A schedule says: *this operation, on these machines, at this time, once or every day or on chosen days of the week*. The machines are either listed (at most 50) or chosen at the time
// of the run by a tag (every machine that has `env=dev`), so a machine tagged later is included and one that lost the tag is not. When it is time, the operation is requested for each
// machine exactly as if the schedule's owner had pressed the button, through the same task engine, so it is audited, limited by the same state rules (a machine that is already
// running is not "started" again: it is skipped and the run says so) and shows in the task history.

import { parseTagFilter, matchesTagFilter, TagError } from '../../inventory/src/tag-rules.js';

export const OPERATIONS = Object.freeze({
  start: 'Power on', stop: 'Shut down guest', power_off: 'Power off', pause: 'Suspend', reboot_guest: 'Restart guest OS', restart: 'Restart'
});
export const OPERATION_KEYS = Object.freeze(Object.keys(OPERATIONS));
export const FREQUENCIES = Object.freeze(['once', 'daily', 'weekly']);
export const LIMITS = Object.freeze({ schedules: 100, machines: 50, nameMax: 100, descriptionMax: 300, graceMinutes: 15, runsKept: 200, detailsKept: 100 });
export const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ScheduleError extends Error {
  constructor(message, code = 'NUV_SCHEDULE_INVALID') { super(message); this.code = code; }
}

const plainText = (raw, label, max, { required }) => {
  const text = String(raw ?? '').trim();
  if (!text && required) throw new ScheduleError(`A schedule needs a ${label}.`);
  if (text.length > max) throw new ScheduleError(`The ${label} may have at most ${max} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw new ScheduleError(`The ${label} may not contain control or invisible formatting characters.`);
  return text;
};

export function validTimeZone(name) {
  if (typeof name !== 'string' || !name || name.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
}

// ---- time in a time zone -----------------------------------------------------------------------------------------------------------------------------------------------
const formatters = new Map();
function partsOf(ms, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); formatters.set(timeZone, format); }
  const out = {};
  for (const part of format.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}
const offsetAt = (ms, timeZone) => { const p = partsOf(ms, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
const sameLocal = (ms, wanted, timeZone) => { const p = partsOf(ms, timeZone); return p.year === wanted.year && p.month === wanted.month && p.day === wanted.day && p.hour === wanted.hour && p.minute === wanted.minute; };

// The instant at which the wall clock of `timeZone` shows this date and time. When the clocks go back and the time happens twice, the first time; when they go forward and the time
// does not exist, the first instant after the gap (02:30 becomes 03:30, an hour later).
export function localToUtc(wanted, timeZone) {
  const guess = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const first = guess - offsetAt(guess, timeZone), second = guess - offsetAt(first, timeZone);
  const matches = [first, second, first - 3_600_000, first + 3_600_000, second - 3_600_000, second + 3_600_000].filter(candidate => sameLocal(candidate, wanted, timeZone));
  if (matches.length) return Math.min(...matches);
  return Math.max(first, second);
}
const localDay = (ms, timeZone) => { const p = partsOf(ms, timeZone); return { year: p.year, month: p.month, day: p.day }; };

// ---- validation ---------------------------------------------------------------------------------------------------------------------------------------------------------
const EDITABLE = ['name', 'description', 'operation', 'targetKind', 'vmIds', 'tag', 'connectionId', 'frequency', 'timeOfDay', 'weekdays', 'runDate', 'timeZone', 'enabled'];

export function parseSchedule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScheduleError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !EDITABLE.includes(key));
  if (unknown) throw new ScheduleError(`Unknown field: ${unknown.slice(0, 40)}.`);
  if (!OPERATION_KEYS.includes(body.operation)) throw new ScheduleError(`operation must be one of ${OPERATION_KEYS.join(', ')}.`);
  if (!['vms', 'tag'].includes(body.targetKind)) throw new ScheduleError('targetKind must be "vms" (listed machines) or "tag" (machines with a tag).');
  if (!FREQUENCIES.includes(body.frequency)) throw new ScheduleError('frequency must be "once", "daily" or "weekly".');
  if (typeof body.timeOfDay !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.timeOfDay)) throw new ScheduleError('timeOfDay must be a time as HH:MM, from 00:00 to 23:59.');
  const timeZone = body.timeZone ?? 'UTC';
  if (!validTimeZone(timeZone)) throw new ScheduleError('timeZone must be a time zone name such as Europe/London or UTC.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new ScheduleError('enabled must be true or false.');
  let vmIds = [], tag = null;
  if (body.targetKind === 'vms') {
    if (!Array.isArray(body.vmIds) || !body.vmIds.length) throw new ScheduleError('Choose at least one virtual machine.');
    if (body.vmIds.length > LIMITS.machines) throw new ScheduleError(`A schedule may list at most ${LIMITS.machines} machines; use a tag for more.`);
    if (body.vmIds.some(id => typeof id !== 'string' || !UUID.test(id))) throw new ScheduleError('vmIds must be machine identifiers.');
    vmIds = [...new Set(body.vmIds.map(id => id.toLowerCase()))];
    if (body.tag) throw new ScheduleError('A schedule of listed machines has no tag.');
  } else {
    if (typeof body.tag !== 'string') throw new ScheduleError('Give the tag, such as env or env=dev.');
    try { const filter = parseTagFilter(body.tag); tag = filter.value === undefined ? filter.key : `${filter.key}=${filter.value}`; } catch (error) { if (error instanceof TagError) throw new ScheduleError(error.message); throw error; }
    if (body.vmIds?.length) throw new ScheduleError('A schedule by tag does not list machines.');
  }
  const connectionId = body.connectionId ?? null;
  if (connectionId !== null && (typeof connectionId !== 'string' || !UUID.test(connectionId))) throw new ScheduleError('connectionId must be a connection identifier, or null for all connections.');
  if (connectionId && body.targetKind === 'vms') throw new ScheduleError('A connection narrows a schedule by tag; listed machines already name theirs.');
  let weekdays = [], runDate = null;
  if (body.frequency === 'weekly') {
    if (!Array.isArray(body.weekdays) || !body.weekdays.length || body.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new ScheduleError('Choose the days of the week (0 is Sunday, 6 is Saturday).');
    weekdays = [...new Set(body.weekdays)].sort((a, b) => a - b);
  } else if (body.weekdays?.length) throw new ScheduleError('Days of the week belong to a weekly schedule.');
  if (body.frequency === 'once') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.runDate ?? '');
    const date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (!match || date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) throw new ScheduleError('A schedule that runs once needs a date as YYYY-MM-DD.');
    runDate = body.runDate;
  } else if (body.runDate) throw new ScheduleError('A date belongs to a schedule that runs once.');
  return {
    name: plainText(body.name, 'name', LIMITS.nameMax, { required: true }), description: plainText(body.description, 'description', LIMITS.descriptionMax, { required: false }),
    operation: body.operation, targetKind: body.targetKind, vmIds, tag, connectionId: connectionId?.toLowerCase() ?? null, frequency: body.frequency, timeOfDay: body.timeOfDay, weekdays, runDate, timeZone, enabled: body.enabled ?? true
  };
}

export function mergeSchedule(existing, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ScheduleError('The request must be a JSON object.');
  const unknown = Object.keys(patch).find(key => !EDITABLE.includes(key));
  if (unknown) throw new ScheduleError(`Unknown field: ${unknown.slice(0, 40)}.`);
  if (!Object.keys(patch).length) throw new ScheduleError('Nothing to change.');
  const merged = { ...Object.fromEntries(EDITABLE.map(key => [key, existing[key]])), ...patch };
  // fields that do not apply to the new shape are dropped rather than refused, so changing "once" to "daily" does not need the date cleared by hand
  if (merged.targetKind === 'vms') merged.tag = patch.tag ?? null; else merged.vmIds = patch.vmIds ?? [];
  if (merged.frequency !== 'weekly') merged.weekdays = patch.weekdays ?? [];
  if (merged.frequency !== 'once') merged.runDate = patch.runDate ?? null;
  if (merged.targetKind === 'vms' && patch.connectionId === undefined) merged.connectionId = null;
  return parseSchedule(merged);
}

// ---- when ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The first run strictly after `afterMs` (ms), or null if there is none (a "once" that has passed).
export function nextRun(schedule, afterMs) {
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number), timeZone = schedule.timeZone;
  if (schedule.frequency === 'once') {
    const [year, month, day] = schedule.runDate.split('-').map(Number), at = localToUtc({ year, month, day, hour, minute }, timeZone);
    return at > afterMs ? at : null;
  }
  const today = localDay(afterMs, timeZone);
  for (let offset = 0; offset < 10; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (schedule.frequency === 'weekly' && !schedule.weekdays.includes(date.getUTCDay())) continue;
    const at = localToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, timeZone);
    if (at > afterMs) return at;
  }
  return null;
}
export function nextRuns(schedule, afterMs, count = 3) {
  const out = [];
  let from = afterMs;
  for (let i = 0; i < count; i++) { const at = nextRun(schedule, from); if (at === null) break; out.push(at); from = at; }
  return out;
}

export const isLate = (scheduledFor, now, graceMinutes = LIMITS.graceMinutes) => now - scheduledFor > graceMinutes * 60_000;

export function describeWhen(schedule) {
  const time = `${schedule.timeOfDay} (${schedule.timeZone})`;
  if (schedule.frequency === 'once') return `once on ${schedule.runDate} at ${time}`;
  if (schedule.frequency === 'daily') return `every day at ${time}`;
  const days = schedule.weekdays;
  const label = days.join() === '1,2,3,4,5' ? 'every weekday' : days.join() === '0,6' ? 'every weekend' : `every ${days.map(day => WEEKDAY_NAMES[day]).join(', ')}`;
  return `${label} at ${time}`;
}
export function describeTargets(schedule) {
  return schedule.targetKind === 'vms' ? `${schedule.vmIds.length} virtual machine${schedule.vmIds.length === 1 ? '' : 's'}` : `machines tagged ${schedule.tag}`;
}
export const describeSchedule = schedule => `${OPERATIONS[schedule.operation] ?? schedule.operation}: ${describeTargets(schedule)}, ${describeWhen(schedule)}`;

// ---- which machines -----------------------------------------------------------------------------------------------------------------------------------------------------
// resources: the virtual machines; tagsOf(resource) -> [{ key, value }]. Returns { machines: [resource], gone: [id] } (listed machines that no longer exist or are not active).
export function resolveTargets(schedule, resources, tagsOf = () => []) {
  const active = resources.filter(resource => (!resource.resourceType || resource.resourceType === 'virtual_machine') && resource.lifecycleState === 'active');
  if (schedule.targetKind === 'vms') {
    const wanted = new Set(schedule.vmIds), found = active.filter(resource => wanted.has(resource.id));
    return { machines: found, gone: schedule.vmIds.filter(id => !found.some(resource => resource.id === id)) };
  }
  const filter = parseTagFilter(schedule.tag);
  return { machines: active.filter(resource => (!schedule.connectionId || resource.connectionId === schedule.connectionId) && matchesTagFilter(tagsOf(resource), filter)), gone: [] };
}

// ---- a run --------------------------------------------------------------------------------------------------------------------------------------------------------------
// results: [{ resourceId, name, result: 'submitted' | 'skipped' | 'failed', detail?, taskId? }], gone: ids. Returns the summary stored with the run.
export function summariseRun({ results, gone = [] }) {
  const count = kind => results.filter(item => item.result === kind).length;
  const submitted = count('submitted'), skipped = count('skipped') + gone.length, failed = count('failed'), matched = results.length + gone.length;
  const outcome = failed > 0 ? (submitted > 0 ? 'partial' : 'failed') : submitted > 0 ? 'completed' : 'skipped';
  const details = [...results, ...gone.map(id => ({ resourceId: id, name: null, result: 'skipped', detail: 'That machine is no longer there.' }))];
  return { outcome, matched, submitted, skipped, failed, details: details.slice(0, LIMITS.detailsKept), detailsTruncated: details.length > LIMITS.detailsKept };
}

// The text a run shows in a list.
export function describeRun(run) {
  if (run.outcome === 'missed') return 'Missed: Nuvrion was not running at the time';
  if (run.outcome === 'error') return `Could not run: ${run.error ?? 'unknown error'}`;
  if (!run.matched) return 'No machines matched';
  const parts = [`${run.submitted} requested`];
  if (run.skipped) parts.push(`${run.skipped} skipped`);
  if (run.failed) parts.push(`${run.failed} failed`);
  return parts.join(', ');
}

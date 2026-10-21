// Scheduled operations in the console (docs/schedules.md): the schedule table, the recent runs, and the dialog that creates and changes a schedule. Pure functions, kept apart from app.js
// so they can be tested in node; app.js passes in `esc`, `when` and `badge` and puts the HTML in the page. The server decides what a schedule may be and when it runs; what is checked
// here only saves a round trip.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const WEEKDAYS = Object.freeze([[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]);
export const MAX_MACHINES = 50;

// Which parts of the dialog apply to the choices made so far.
export const visibility = ({ targetKind, frequency }) => ({ machines: targetKind !== 'tag', tag: targetKind === 'tag', weekdays: frequency === 'weekly', date: frequency === 'once' });

// ---- the schedules ------------------------------------------------------------------------------------------------------------------------------------------------------------
export function schedulesHtml(schedules, { esc, when, badge, canManage, canRun }) {
  if (!schedules.length) return `<tr><td colspan="5"><div class="empty compact"><strong>No schedules yet</strong><p>${canManage ? 'Choose “New schedule” to start, stop or restart machines at a time you set.' : 'Someone who may manage schedules can set machines to start, stop or restart at a time they choose.'}</p></div></td></tr>`;
  return schedules.map(schedule => {
    const last = schedule.lastRun;
    const lastCell = last ? `${badge(last.outcome)} <small>${esc(when(last.startedAt))}</small><small class="block">${esc(last.summary)}</small>` : '<small>Not run yet</small>';
    const next = schedule.enabled ? (schedule.nextRunAt ? esc(when(schedule.nextRunAt)) : '—') : '<span class="badge neutral">turned off</span>';
    const actions = canManage
      ? `${canRun ? `<button type="button" data-schedule-run="${esc(schedule.id)}">Run now<span class="sr-only"> schedule ${esc(schedule.name)}</span></button>` : ''}<button type="button" data-schedule-toggle="${esc(schedule.id)}">${schedule.enabled ? 'Turn off' : 'Turn on'}<span class="sr-only"> schedule ${esc(schedule.name)}</span></button><button type="button" data-schedule-edit="${esc(schedule.id)}">Edit<span class="sr-only"> schedule ${esc(schedule.name)}</span></button><button type="button" data-schedule-delete="${esc(schedule.id)}">Delete<span class="sr-only"> schedule ${esc(schedule.name)}</span></button>`
      : '';
    return `<tr data-schedule-row="${esc(schedule.id)}"><td><strong>${esc(schedule.name)}</strong><small class="block">${esc(schedule.summary)}</small>${schedule.description ? `<small class="block">${esc(schedule.description)}</small>` : ''}</td><td>${next}</td><td>${lastCell}</td><td>${schedule.targetKind === 'tag' ? 'By tag' : 'Listed machines'}</td><td class="row-actions right">${actions}</td></tr>`;
  }).join('');
}

const TRIGGERS = { schedule: 'On schedule', manual: 'Run by hand' };
export function runsHtml(runs, { esc, when, badge }) {
  if (!runs.length) return '<tr><td colspan="4"><div class="empty compact"><p>Nothing has run yet.</p></div></td></tr>';
  return runs.map(run => {
    const notes = (run.details ?? []).filter(item => item.result !== 'submitted').slice(0, 3).map(item => `<small class="block">${esc(item.name ?? 'A machine')}: ${esc(item.result)}${item.detail ? ` — ${esc(item.detail)}` : ''}</small>`).join('');
    const error = run.error ? `<small class="block">${esc(run.error)}</small>` : '';
    return `<tr><td>${esc(when(run.startedAt))}</td><td><strong>${esc(run.scheduleName)}</strong><small class="block">${esc(TRIGGERS[run.trigger] ?? run.trigger)}</small></td><td>${badge(run.outcome)}</td><td>${esc(run.summary)}${notes}${error}</td></tr>`;
  }).join('');
}

// ---- the dialog ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// schedule: null for a new one. operations: { key: label }. machines: [{ id, name }]. connections: [{ id, name }]. timeZones: names for the suggestions. defaultZone: the browser's.
export function scheduleDialogHtml({ schedule = null, operations, machines, connections, timeZones = [], defaultZone = 'UTC', error = '', preview = null }, { esc, when = value => value }) {
  const current = schedule ?? { name: '', description: '', operation: Object.keys(operations)[0] ?? 'start', targetKind: 'vms', vmIds: [], tag: '', connectionId: null, frequency: 'daily', timeOfDay: '19:00', weekdays: [1, 2, 3, 4, 5], runDate: '', timeZone: defaultZone, enabled: true };
  const show = visibility(current), chosen = new Set(current.vmIds ?? []);
  const known = new Set(machines.map(machine => machine.id));
  const missing = [...chosen].filter(id => !known.has(id));   // listed machines that are gone stay visible so that saving does not silently drop them
  const rows = [...machines.map(machine => ({ ...machine, gone: false })), ...missing.map(id => ({ id, name: 'A machine that is no longer there', gone: true }))];
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  return `<header><div><p class="eyebrow">SCHEDULE</p><h2 id="schedule-title">${esc(schedule ? schedule.name : 'New schedule')}</h2></div><button id="schedule-close" type="button">Close</button></header>
<p class="tag-help">Nuvrion asks for the operation as you would, at the time you choose, through the same task engine, so it is audited and obeys the same rules: a machine that is already running is not started again, it is skipped. It runs with the permissions you have at that time.</p>
<section class="tag-fields"><label>Name<input id="schedule-name" name="name" maxlength="100" autocomplete="off" required value="${esc(current.name)}" placeholder="Stop test machines at night"></label><label>Operation<select id="schedule-operation" name="operation">${Object.entries(operations).map(([key, label]) => option(key, label, key === current.operation)).join('')}</select></label></section>
<fieldset class="schedule-group"><legend>Which machines</legend>
<div class="schedule-choice" role="radiogroup" aria-label="How machines are chosen"><label class="account-check"><input type="radio" name="targetKind" value="vms"${current.targetKind === 'tag' ? '' : ' checked'}><span>Machines I choose</span></label><label class="account-check"><input type="radio" name="targetKind" value="tag"${current.targetKind === 'tag' ? ' checked' : ''}><span>Machines with a tag when it runs</span></label></div>
<div id="schedule-machines-box"${show.machines ? '' : ' hidden'}><label class="alert-wide">Find a machine<input id="schedule-machine-filter" type="search" autocomplete="off" placeholder="Filter the list"></label>
<div id="schedule-machine-list" class="schedule-machines" role="group" aria-label="Machines">${rows.length ? rows.map(machine => `<label class="account-check" data-machine-name="${esc(machine.name.toLowerCase())}"><input type="checkbox" name="vmIds" value="${esc(machine.id)}"${chosen.has(machine.id) ? ' checked' : ''}><span>${esc(machine.name)}</span></label>`).join('') : '<p class="empty-note">No virtual machines have been discovered yet.</p>'}</div>
<p class="tag-help" id="schedule-machine-count" aria-live="polite">${esc(plural(chosen.size, 'machine'))} chosen (at most ${MAX_MACHINES}).</p></div>
<div id="schedule-tag-box" class="tag-fields"${show.tag ? '' : ' hidden'}><label>Tag<input id="schedule-tag" name="tag" maxlength="100" autocomplete="off" value="${esc(current.tag ?? '')}" placeholder="env=dev"></label><label>In connection<select id="schedule-connection" name="connectionId"><option value="">All connections</option>${connections.map(connection => option(connection.id, connection.name, connection.id === current.connectionId)).join('')}</select></label><p class="tag-help">Use <code>env</code> for any value or <code>env=dev</code> for one. A machine tagged later is included; one that loses the tag is not.</p></div></fieldset>
<fieldset class="schedule-group"><legend>When</legend>
<section class="tag-fields"><label>How often<select id="schedule-frequency" name="frequency">${option('once', 'Once', current.frequency === 'once')}${option('daily', 'Every day', current.frequency === 'daily')}${option('weekly', 'On chosen days of the week', current.frequency === 'weekly')}</select></label><label>Time<input id="schedule-time" name="timeOfDay" type="time" required value="${esc(current.timeOfDay)}"></label></section>
<div id="schedule-date-box"${show.date ? '' : ' hidden'}><label class="alert-wide">Date<input id="schedule-date" name="runDate" type="date" value="${esc(current.runDate ?? '')}"></label></div>
<div id="schedule-weekdays-box"${show.weekdays ? '' : ' hidden'} role="group" aria-label="Days of the week" class="schedule-days">${WEEKDAYS.map(([number, label]) => `<label class="account-check"><input type="checkbox" name="weekdays" value="${number}"${(current.weekdays ?? []).includes(number) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div>
<label class="alert-wide">Time zone<input id="schedule-zone" name="timeZone" list="schedule-zones" autocomplete="off" required value="${esc(current.timeZone)}"><datalist id="schedule-zones">${timeZones.map(zone => `<option value="${esc(zone)}"></option>`).join('')}</datalist></label></fieldset>
<label class="alert-wide">Description (optional)<input id="schedule-description" name="description" maxlength="300" autocomplete="off" value="${esc(current.description ?? '')}"></label>
<label class="account-check"><input id="schedule-enabled" name="enabled" type="checkbox"${current.enabled ? ' checked' : ''}><span>Turn this schedule on</span></label>
<div id="schedule-preview" class="alert-preview" role="status">${preview ? previewHtml(preview, { esc, when }) : ''}</div>
<p id="schedule-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>
<p class="mfa-actions"><button id="schedule-check" type="button">Check when it would run</button><button id="schedule-save" type="submit" class="primary">${schedule ? 'Save changes' : 'Create schedule'}</button></p>`;
}

// preview: the answer of the preview call. when: formats a time.
export function previewHtml(preview, { esc, when = value => value }) {
  const found = preview.matchedCount;
  const runs = preview.nextRuns.length ? `<p><strong>Next runs</strong></p><ul>${preview.nextRuns.map(at => `<li>${esc(when(at))}</li>`).join('')}</ul>` : '<p><strong>It would not run again.</strong></p>';
  const names = preview.machines.map(machine => esc(machine.name)).join(', ');
  const more = found > preview.machines.length ? ` and ${found - preview.machines.length} more` : '';
  const gone = preview.goneCount ? ` ${plural(preview.goneCount, 'listed machine')} no longer there.` : '';
  return `${runs}<p>${found ? `<strong>${plural(found, 'machine')} would be covered right now:</strong> ${names}${more}.` : '<strong>No machines would be covered right now.</strong>'}${esc(gone)}</p>`;
}

// The request from the dialog's fields. Parts that do not apply are sent empty, so changing a schedule from machines to a tag (or from weekly to daily) leaves nothing behind.
export function scheduleRequestBody(values) {
  const tag = values.targetKind === 'tag';
  return {
    name: String(values.name ?? '').trim(), description: String(values.description ?? '').trim(), operation: values.operation, targetKind: tag ? 'tag' : 'vms',
    vmIds: tag ? [] : [...(values.vmIds ?? [])], tag: tag ? String(values.tag ?? '').trim() : null, connectionId: tag && values.connectionId ? values.connectionId : null,
    frequency: values.frequency, timeOfDay: values.timeOfDay, weekdays: values.frequency === 'weekly' ? [...(values.weekdays ?? [])].map(Number).sort((a, b) => a - b) : [],
    runDate: values.frequency === 'once' ? String(values.runDate ?? '') : null, timeZone: String(values.timeZone ?? '').trim(), enabled: Boolean(values.enabled)
  };
}

// Checks that only save a round trip; null when fine.
export function scheduleProblem(body) {
  if (!body.name) return 'Give the schedule a name.';
  if (body.targetKind === 'vms' && !body.vmIds.length) return 'Choose at least one machine.';
  if (body.targetKind === 'vms' && body.vmIds.length > MAX_MACHINES) return `A schedule may list at most ${MAX_MACHINES} machines; use a tag to cover more.`;
  if (body.targetKind === 'tag' && !body.tag) return 'Give the tag, such as env or env=dev.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.timeOfDay ?? '')) return 'Choose a time of day.';
  if (body.frequency === 'weekly' && !body.weekdays.length) return 'Choose at least one day of the week.';
  if (body.frequency === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(body.runDate ?? '')) return 'Choose the date it should run.';
  if (!body.timeZone) return 'Enter a time zone, such as Europe/London or UTC.';
  return null;
}

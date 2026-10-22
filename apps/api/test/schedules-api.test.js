import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scheduled operations over the real HTTP API (in-memory services, the mock provider): who may make schedules, what a schedule must look like, running one now requests the operation
// through the task engine as the person who asked (and skips what cannot be done in the machine's state), tags choose the machines when the run happens, and the history and audit.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Schedules-Test-Password-1!'; // secret-scan:allow (fake test credential)

describe('scheduled operations over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir, connectionId, app, db; const sessions = {};

  async function call(who, method, path, { body, version, csrf = 'valid' } = {}) {
    const headers = {};
    if (who) { headers.cookie = sessions[who].cookie; if (method !== 'GET') headers['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (version !== undefined) headers['if-match'] = `"${version}"`;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text };
  }
  async function login(name, username = name) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    const json = await response.json();
    sessions[name] = { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken };
    return { status: response.status, json };
  }
  async function addUser(username, role) {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await call('admin', 'PATCH', `/api/v1/users/${signup.user.id}`, { body: { status: 'active', roles: [role] }, version: signup.user.rowVersion });
    assert.equal(update.status, 200, update.text);
    await login(username);
  }
  const schedule = (over = {}) => ({ name: 'Stop the app', operation: 'stop', targetKind: 'vms', vmIds: [app.id], frequency: 'daily', timeOfDay: '19:00', timeZone: 'Europe/London', ...over });
  const create = (body, who = 'admin') => call(who, 'POST', '/api/v1/schedules', { body });
  const schedules = async () => (await call('admin', 'GET', '/api/v1/schedules')).json.items;
  const power = async name => (await call('admin', 'GET', '/api/v1/resources')).json.items.find(item => item.name === name).attributes.powerState;
  const settle = async (name, wanted) => { for (let i = 0; i < 100; i++) { if (await power(name) === wanted) return; await new Promise(resolve => setTimeout(resolve, 100)); } assert.equal(await power(name), wanted); };

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-schedules-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD, NUVRION_SCHEDULE_INTERVAL_MS: '3600000', NUVRION_ALERT_INTERVAL_MS: '3600000' });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await login('admin')).status, 200);
    const created = await call('admin', 'POST', '/api/v1/connections', { body: { name: 'Schedules lab', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' } } }); // secret-scan:allow (fake test credential)
    connectionId = created.json.id;
    assert.equal((await call('admin', 'POST', `/api/v1/connections/${connectionId}/discover`)).status, 200);
    const resources = (await call('admin', 'GET', '/api/v1/resources')).json.items;
    app = resources.find(item => item.name === 'nuvrion-app-01'); db = resources.find(item => item.name === 'nuvrion-db-01');
    await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('operators and administrators may make schedules; auditors may read them and nothing more; a schedule needs resource.operate behind it', async () => {
    const refused = await create(schedule({ name: 'Auditor tries' }), 'auditor1');
    assert.deepEqual([refused.status, refused.code], [403, 'NUV_PERMISSION_DENIED']);
    const made = await create(schedule(), 'operator1');
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.name, made.json.operation, made.json.enabled, made.json.rowVersion, made.json.createdBy === null, made.json.lastRun], ['Stop the app', 'stop', true, 1, false, null]);
    assert.match(made.json.summary, /^Shut down guest: 1 virtual machine, every day at 19:00 \(Europe\/London\)$/);
    assert.ok(Date.parse(made.json.nextRunAt) > Date.now() && Date.parse(made.json.nextRunAt) <= Date.now() + 25 * 3_600_000, 'the next run is within a day');
    const list = await call('auditor1', 'GET', '/api/v1/schedules');
    assert.deepEqual([list.json.items.map(item => item.name), Object.keys(list.json.operations)], [['Stop the app'], ['start', 'stop', 'power_off', 'pause', 'reboot_guest', 'restart']]);
    assert.equal((await call('admin', 'POST', '/api/v1/schedules', { body: schedule({ name: 'Bad CSRF' }), csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    const role = await call('admin', 'POST', '/api/v1/roles', { body: { name: 'scheduler_only', permissions: ['resource.view', 'schedule.manage'] } });
    assert.deepEqual([role.status, role.code], [422, 'NUV_ROLE_PERMISSION_DEPENDENCY'], 'schedule.manage without resource.operate is refused');
  });

  test('a schedule is judged by the rules: operation, targets, frequency, time, days, date, time zone, name, connection, and a time that has passed', async () => {
    const cases = [
      [schedule({ operation: 'delete' }), 422], [schedule({ targetKind: 'all' }), 422], [schedule({ frequency: 'hourly' }), 422], [schedule({ timeOfDay: '7pm' }), 422], [schedule({ timeZone: 'Mars/Olympus' }), 422],
      [schedule({ name: '  ' }), 422], [schedule({ vmIds: [] }), 422], [schedule({ vmIds: ['nope'] }), 422], [schedule({ frequency: 'weekly' }), 422], [schedule({ frequency: 'weekly', weekdays: [9] }), 422],
      [schedule({ frequency: 'once' }), 422], [schedule({ frequency: 'once', runDate: '2020-01-01' }), 422], [schedule({ extra: 1 }), 422],
      [schedule({ targetKind: 'tag', vmIds: undefined, tag: 'env', connectionId: '00000000-0000-4000-8000-0000000000aa' }), 422],
      [schedule({ name: 'stop the APP' }), 409]
    ];
    for (const [body, status] of cases) { const result = await create(body); assert.equal(result.status, status, `${JSON.stringify(body).slice(0, 160)} => ${result.text.slice(0, 160)}`); assert.equal(result.code, status === 409 ? 'NUV_SCHEDULE_EXISTS' : 'NUV_SCHEDULE_INVALID'); }
    for (const body of [null, [], 'x']) assert.equal((await call('admin', 'POST', '/api/v1/schedules', { body })).code, 'NUV_SCHEDULE_INVALID');
    assert.equal((await create(schedule({ name: 'Weekdays', frequency: 'weekly', weekdays: [1, 2, 3, 4, 5], timeOfDay: '07:30', operation: 'start', vmIds: [db.id] }))).status, 201);
    assert.equal((await create(schedule({ name: 'By tag in one connection', targetKind: 'tag', vmIds: undefined, tag: 'env=dev', connectionId }))).status, 201);
  });

  test('a preview says when a schedule would next run and which machines it would cover now, without saving it', async () => {
    const preview = await call('admin', 'POST', '/api/v1/schedules/preview', { body: schedule({ name: 'Preview', frequency: 'weekly', weekdays: [1], timeOfDay: '07:00', timeZone: 'Asia/Kolkata', vmIds: [app.id, db.id] }) });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.nextRuns.length, 3); assert.equal(preview.json.matchedCount, 2); assert.deepEqual(preview.json.machines.map(item => item.name).sort(), ['nuvrion-app-01', 'nuvrion-db-01']);
    assert.ok(preview.json.nextRuns.every(at => new Date(at).getUTCDay() === 1 && at.endsWith('T01:30:00.000Z')), 'Monday 07:00 in Kolkata is Monday 01:30 UTC');
    assert.equal((await schedules()).some(item => item.name === 'Preview'), false, 'a preview saves nothing');
    assert.equal((await call('admin', 'POST', '/api/v1/schedules/preview', { body: schedule({ timeOfDay: 'x' }) })).code, 'NUV_SCHEDULE_INVALID');
  });

  test('running a schedule now requests the operation through the task engine as the person who asked, and a second run finds the machine already stopped and skips it', async () => {
    const [stop] = (await schedules()).filter(item => item.name === 'Stop the app');
    assert.equal(await power('nuvrion-app-01'), 'running');
    const first = await call('operator1', 'POST', `/api/v1/schedules/${stop.id}/run`);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual([first.json.outcome, first.json.trigger, first.json.matched, first.json.submitted, first.json.summary], ['completed', 'manual', 1, 1, '1 requested']);
    assert.equal(first.json.details[0].name, 'nuvrion-app-01'); assert.ok(first.json.details[0].taskId);
    await settle('nuvrion-app-01', 'stopped');
    const tasks = (await call('admin', 'GET', '/api/v1/tasks')).json.items.filter(task => task.operation === 'stop');
    assert.equal(tasks.length, 1, 'one task, made by the schedule'); assert.equal(tasks[0].requestedBy?.username, 'operator1', 'as the person who ran it');
    const second = await call('operator1', 'POST', `/api/v1/schedules/${stop.id}/run`);
    assert.deepEqual([second.json.outcome, second.json.submitted, second.json.skipped, second.json.details[0].result, second.json.summary], ['skipped', 0, 1, 'skipped', '0 requested, 1 skipped']);
    assert.ok(second.json.details[0].detail, 'and says why');
    assert.equal((await call('auditor1', 'POST', `/api/v1/schedules/${stop.id}/run`)).code, 'NUV_PERMISSION_DENIED');
    assert.equal((await call('admin', 'POST', '/api/v1/schedules/00000000-0000-4000-8000-0000000000aa/run')).status, 404);
    const shown = (await schedules()).find(item => item.name === 'Stop the app');
    assert.deepEqual([shown.lastRun.outcome, shown.lastRun.summary, shown.nextRunAt === stop.nextRunAt], ['skipped', '0 requested, 1 skipped', true]);
  });

  test('a schedule by tag covers the machines that have the tag when it runs: tagging a machine afterwards brings it in', async () => {
    const byTag = await create(schedule({ name: 'Start the dev machines', operation: 'start', targetKind: 'tag', vmIds: undefined, tag: 'env=dev' }));
    assert.equal(byTag.status, 201, byTag.text);
    const none = await call('admin', 'POST', `/api/v1/schedules/${byTag.json.id}/run`);
    assert.deepEqual([none.json.outcome, none.json.matched, none.json.summary], ['skipped', 0, 'No machines matched']);
    assert.equal((await call('admin', 'POST', '/api/v1/tag-operations', { body: { resourceIds: [app.id], set: [{ key: 'env', value: 'dev' }] } })).status, 200);
    const run = await call('admin', 'POST', `/api/v1/schedules/${byTag.json.id}/run`);
    assert.deepEqual([run.json.outcome, run.json.matched, run.json.submitted, run.json.details[0].name], ['completed', 1, 1, 'nuvrion-app-01']);
    await settle('nuvrion-app-01', 'running');
    await call('admin', 'POST', '/api/v1/tag-operations', { body: { resourceIds: [app.id], remove: ['env'] } });
  });

  test('changing a schedule needs the current version and works out the next run again; turning it off clears it; the history survives deleting the schedule', async () => {
    const [stop] = (await schedules()).filter(item => item.name === 'Stop the app');
    const changed = await call('operator1', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { timeOfDay: '06:15', frequency: 'weekly', weekdays: [1, 3] }, version: stop.rowVersion });
    assert.deepEqual([changed.status, changed.json.timeOfDay, changed.json.weekdays, changed.json.rowVersion], [200, '06:15', [1, 3], 2]);
    assert.equal(new Date(changed.json.nextRunAt).getUTCDay() % 2, 1, 'a Monday or a Wednesday');
    assert.equal((await call('operator1', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { timeOfDay: '07:00' }, version: 1 })).status, 412);
    assert.equal((await call('operator1', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { timeOfDay: '07:00' } })).status, 428);
    assert.equal((await call('operator1', 'PATCH', '/api/v1/schedules/00000000-0000-4000-8000-0000000000aa', { body: { timeOfDay: '07:00' }, version: 1 })).status, 404);
    assert.equal((await call('operator1', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { timeOfDay: 'x' }, version: 2 })).code, 'NUV_SCHEDULE_INVALID');
    const clash = await call('admin', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { name: 'WEEKDAYS' }, version: 2 });
    assert.equal(clash.code, 'NUV_SCHEDULE_EXISTS', clash.text);
    const off = await call('operator1', 'PATCH', `/api/v1/schedules/${stop.id}`, { body: { enabled: false }, version: 2 });
    assert.deepEqual([off.json.enabled, off.json.nextRunAt], [false, null]);
    assert.equal((await call('auditor1', 'DELETE', `/api/v1/schedules/${stop.id}`)).code, 'NUV_PERMISSION_DENIED');
    assert.deepEqual((await call('operator1', 'DELETE', `/api/v1/schedules/${stop.id}`)).json, { deleted: 1 });
    assert.equal((await call('operator1', 'DELETE', `/api/v1/schedules/${stop.id}`)).status, 404);
    const history = (await call('auditor1', 'GET', '/api/v1/schedule-runs?limit=100')).json.items.filter(run => run.scheduleName === 'Stop the app');
    assert.deepEqual([history.length, history.every(run => run.scheduleId === null)], [2, true], 'the history stays under the schedule’s name');
    assert.equal((await call('admin', 'GET', '/api/v1/schedule-runs?scheduleId=00000000-0000-4000-8000-0000000000aa')).json.items.length, 0);
  });

  test('every step is in the audit history', async () => {
    const actions = new Set(((await call('admin', 'GET', '/api/v1/audit-events?limit=300&search=schedule.')).json.items ?? []).map(event => event.action));
    for (const action of ['schedule.created', 'schedule.updated', 'schedule.deleted', 'schedule.run']) assert.ok(actions.has(action), action);
  });
});

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Saved views of the inventory and the record of an export over the real HTTP API: anyone who may view resources keeps views of their own, nobody sees another person's, the rules of a
// view are enforced, and an export leaves a line in the audit history with who, how many rows and which filters.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Views-Test-Password-1!'; // secret-scan:allow (fake test credential)

describe('saved views over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir; const sessions = {};

  async function call(who, method, path, { body, csrf = 'valid', version } = {}) {
    const headers = {};
    if (who) { headers.cookie = sessions[who].cookie; if (method !== 'GET') headers['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (version !== undefined) headers['if-match'] = `"${version}"`;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text };
  }
  async function login(name) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
    const json = await response.json();
    sessions[name] = { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken };
  }
  async function addUser(username, role) {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await fetch(`${base}/api/v1/users/${signup.user.id}`, { method: 'PATCH', headers: { cookie: sessions.admin.cookie, 'x-csrf-token': sessions.admin.csrf, 'content-type': 'application/json', 'if-match': `"${signup.user.rowVersion}"` }, body: JSON.stringify({ status: 'active', roles: [role] }) });
    assert.equal(update.status, 200, await update.text());
    await login(username);
  }
  const view = { search: 'web', platform: 'vmware_esxi', power: 'running', sortKey: 'memory', sortDirection: 'desc' };

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-views-api-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_VIEWS_FILE: join(workDir, 'views.json'),
      NUVRION_BOOTSTRAP_PASSWORD: PASSWORD, NUVRION_SCHEDULE_INTERVAL_MS: '3600000', NUVRION_ALERT_INTERVAL_MS: '3600000' });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await login('admin'); await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('anyone who may view resources keeps views of their own; nobody else may, and a change needs the CSRF token', async () => {
    assert.equal((await call(null, 'GET', '/api/v1/saved-views')).status, 401);
    for (const who of ['admin', 'operator1', 'auditor1']) assert.deepEqual([(await call(who, 'GET', '/api/v1/saved-views')).status, (await call(who, 'GET', '/api/v1/saved-views')).json.limit], [200, 20], who);
    assert.equal((await call('admin', 'POST', '/api/v1/saved-views', { body: { name: 'No CSRF', view }, csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    assert.equal((await call('auditor1', 'POST', '/api/v1/saved-views', { body: { name: 'Auditor view', view } })).status, 201, 'a read-only role may keep its own views');
  });

  test('a view is saved with its filters, listed, renamed, re-saved with a version, and deleted', async () => {
    const made = await call('operator1', 'POST', '/api/v1/saved-views', { body: { name: 'Web servers', view } });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.name, made.json.rowVersion, made.json.view, made.json.scope], ['Web servers', 1, { search: 'web', platform: 'vmware_esxi', power: 'running', health: null, tag: null, sortKey: 'memory', sortDirection: 'desc' }, 'inventory']);
    assert.deepEqual((await call('operator1', 'GET', '/api/v1/saved-views')).json.items.map(item => item.name), ['Web servers']);
    const renamed = await call('operator1', 'PATCH', `/api/v1/saved-views/${made.json.id}`, { body: { name: 'Web tier' }, version: 1 });
    assert.deepEqual([renamed.status, renamed.json.name, renamed.json.rowVersion], [200, 'Web tier', 2]);
    const resaved = await call('operator1', 'PATCH', `/api/v1/saved-views/${made.json.id}`, { body: { view: { power: 'stopped', tag: 'env=prod' } }, version: 2 });
    assert.deepEqual([resaved.json.view.power, resaved.json.view.tag, resaved.json.view.search], ['stopped', 'env=prod', '']);
    assert.equal((await call('operator1', 'PATCH', `/api/v1/saved-views/${made.json.id}`, { body: { name: 'Stale' }, version: 1 })).status, 412);
    assert.equal((await call('operator1', 'PATCH', `/api/v1/saved-views/${made.json.id}`, { body: { name: 'No version' } })).status, 428);
    assert.deepEqual((await call('operator1', 'DELETE', `/api/v1/saved-views/${made.json.id}`)).json, { deleted: 1 });
    assert.equal((await call('operator1', 'DELETE', `/api/v1/saved-views/${made.json.id}`)).status, 404);
  });

  test('a person never sees, changes or deletes another person’s view, and two people may use the same name', async () => {
    const mine = await call('operator1', 'POST', '/api/v1/saved-views', { body: { name: 'Private', view } });
    assert.deepEqual((await call('auditor1', 'GET', '/api/v1/saved-views')).json.items.map(item => item.name), ['Auditor view'], 'only their own');
    assert.equal((await call('auditor1', 'PATCH', `/api/v1/saved-views/${mine.json.id}`, { body: { name: 'Stolen' }, version: 1 })).code, 'NUV_VIEW_NOT_FOUND');
    assert.equal((await call('admin', 'DELETE', `/api/v1/saved-views/${mine.json.id}`)).status, 404, 'not even an administrator');
    assert.equal((await call('auditor1', 'POST', '/api/v1/saved-views', { body: { name: 'private', view } })).status, 201);
    assert.equal((await call('operator1', 'GET', '/api/v1/saved-views')).json.items.find(item => item.id === mine.json.id).name, 'Private');
  });

  test('what a view may hold is enforced: a name is needed and unique for the person, the fields are known, at most twenty are kept', async () => {
    for (const body of [{ view }, { name: '', view }, { name: 'Bad sort', view: { sortKey: 'color' } }, { name: 'Bad field', view: { colour: 'red' } }, { name: 'Bad platform', view: { platform: 'VMware ESXi' } }, { name: 'x'.repeat(61), view }, { name: 'Extra', view, more: 1 }, null]) {
      const result = await call('admin', 'POST', '/api/v1/saved-views', { body });
      assert.deepEqual([result.status, result.code], [422, 'NUV_VIEW_INVALID'], JSON.stringify(body)?.slice(0, 80));
    }
    assert.equal((await call('admin', 'POST', '/api/v1/saved-views', { body: { name: 'Prod', view } })).status, 201);
    assert.equal((await call('admin', 'POST', '/api/v1/saved-views', { body: { name: 'PROD', view } })).code, 'NUV_VIEW_EXISTS');
    for (let i = 1; i < 20; i++) assert.equal((await call('admin', 'POST', '/api/v1/saved-views', { body: { name: `Filler ${i}`, view: {} } })).status, 201);
    assert.equal((await call('admin', 'POST', '/api/v1/saved-views', { body: { name: 'Twenty-first', view: {} } })).code, 'NUV_VIEW_LIMIT');
  });

  test('an export is recorded in the audit history with who, how many rows and which filters, and nothing else about the data', async () => {
    const note = await call('operator1', 'POST', '/api/v1/inventory-exports', { body: { count: 35, columns: 14, view: { power: 'running', platform: 'vmware_esxi', tag: 'env=prod', search: 'web' } } });
    assert.deepEqual([note.status, note.json.recorded, note.json.rows], [200, true, 35]);
    for (const body of [{}, { count: -1 }, { count: 'many' }, { count: 1, extra: 1 }, { count: 1, view: { sortKey: 'x' } }]) assert.equal((await call('operator1', 'POST', '/api/v1/inventory-exports', { body })).code, 'NUV_VIEW_INVALID');
    assert.equal((await call(null, 'POST', '/api/v1/inventory-exports', { body: { count: 1 } })).status, 401);
    assert.equal((await call('operator1', 'POST', '/api/v1/inventory-exports', { body: { count: 1 }, csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    const events = (await call('admin', 'GET', '/api/v1/audit-events?limit=50&search=inventory.exported')).json.items;
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].action, events[0].actorName, events[0].detail.rows, events[0].detail.columns, events[0].detail.format], ['inventory.exported', 'operator1', 35, 14, 'csv']);
    assert.equal(events[0].detail.filters, 'running, vmware_esxi, tag env=prod, search “web”');
  });
});

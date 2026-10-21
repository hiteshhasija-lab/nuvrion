import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Custom roles through the real HTTP API (in-memory services): who may create them, what a role may hold, that a change applies at once, that nobody can hand out more than
// they have, and that the built-in roles and the roles people hold are safe from deletion.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Roles-Test-Password-1!'; // secret-scan:allow (fake test credential)

describe('custom roles over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir; const sessions = {};

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
  async function login(username) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    const json = await response.json();
    return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken, user: json.user };
  }
  async function addUser(username, roles) {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await call('admin', 'PATCH', `/api/v1/users/${signup.user.id}`, { body: { status: 'active', roles }, version: signup.user.rowVersion });
    assert.equal(update.status, 200, update.text);
    sessions[username] = await login(username);
    return update.json;
  }
  const createRole = (who, body) => call(who, 'POST', '/api/v1/roles', { body });

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-roles-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sessions.admin = await login('admin');
    assert.equal(sessions.admin.status, 200);
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('the built-in roles are listed first, marked, and with the permissions they have always had (plus resource.tag for operators and administrators)', async () => {
    const result = await call('admin', 'GET', '/api/v1/roles');
    assert.equal(result.status, 200);
    const names = result.json.items.map(role => role.name);
    assert.deepEqual(names.slice(0, 3).sort(), ['auditor', 'operator', 'platform_admin']);
    assert.ok(result.json.items.slice(0, 3).every(role => role.system));
    const operator = result.json.items.find(role => role.name === 'operator');
    assert.deepEqual(operator.permissions, ['resource.view', 'resource.operate', 'resource.tag', 'connection.view']);
    assert.equal(result.json.items.find(role => role.name === 'platform_admin').userCount, 1);
    const catalogue = await call('admin', 'GET', '/api/v1/permissions');
    assert.deepEqual(catalogue.json.items.map(permission => permission.key).sort(), [...new Set(result.json.items.flatMap(role => role.permissions))].sort());
    assert.ok(catalogue.json.items.every(permission => permission.description.length > 10 && permission.group));
  });

  test('a custom role is created, listed, and gives its holder exactly its permissions — and a change applies on their next request', async () => {
    const created = await createRole('admin', { name: 'Tag Keeper', description: ' can tag, nothing else ', permissions: ['resource.tag', 'resource.view'] });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.name, 'tag_keeper');
    assert.equal(created.json.system, false);
    assert.equal(created.json.description, 'can tag, nothing else');
    assert.deepEqual(created.json.permissions, ['resource.view', 'resource.tag'], 'in the catalogue’s order, not the request’s');
    const user = await addUser('keeper1', ['tag_keeper']);
    assert.deepEqual(user.roles, ['tag_keeper']);
    assert.deepEqual([...user.permissions].sort(), ['resource.tag', 'resource.view']);
    // may reach the tag call (the request is then refused as invalid, not as forbidden); may not operate or read users
    const tag = await call('keeper1', 'POST', '/api/v1/tag-operations', { body: { resourceIds: [], set: [] } });
    assert.equal(tag.status, 422, 'the permission is enough to reach validation');
    assert.equal((await call('keeper1', 'POST', '/api/v1/mock/operations', { body: {} })).code, 'NUV_PERMISSION_DENIED');
    assert.equal((await call('keeper1', 'GET', '/api/v1/users')).code, 'NUV_PERMISSION_DENIED');
    assert.equal((await call('keeper1', 'GET', '/api/v1/roles')).code, 'NUV_PERMISSION_DENIED');
    // take resource.tag away: the same session is refused on its next request
    const changed = await call('admin', 'PATCH', '/api/v1/roles/tag_keeper', { body: { description: 'view only now', permissions: ['resource.view'] }, version: created.json.rowVersion });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.json.rowVersion, created.json.rowVersion + 1);
    assert.equal((await call('keeper1', 'POST', '/api/v1/tag-operations', { body: { resourceIds: [], set: [] } })).code, 'NUV_PERMISSION_DENIED');
    assert.equal((await call('admin', 'GET', '/api/v1/roles')).json.items.find(role => role.name === 'tag_keeper').userCount, 1);
  });

  test('a role request is judged by the rules: names, reserved names, unknown and missing permissions, duplicates and stale versions', async () => {
    const cases = [
      [{ name: 'x', permissions: ['resource.view'] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: '9lives', permissions: ['resource.view'] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'bad/name', permissions: ['resource.view'] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'Operator', permissions: ['resource.view'] }, 422, 'NUV_ROLE_RESERVED'],
      [{ name: 'empty_one', permissions: [] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'weird_one', permissions: ['resource.view', 'root'] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'needs_view', permissions: ['resource.operate'] }, 422, 'NUV_ROLE_PERMISSION_DEPENDENCY'],
      [{ name: 'needs_conn', permissions: ['resource.view', 'connection.manage'] }, 422, 'NUV_ROLE_PERMISSION_DEPENDENCY'],
      [{ name: 'extra_field', permissions: ['resource.view'], admin: true }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'long_desc', description: 'x'.repeat(201), permissions: ['resource.view'] }, 422, 'NUV_ROLE_INVALID'],
      [{ name: 'tag_keeper', permissions: ['resource.view'] }, 409, 'NUV_ROLE_EXISTS']
    ];
    for (const [body, status, code] of cases) {
      const result = await createRole('admin', body);
      assert.deepEqual([result.status, result.code], [status, code], JSON.stringify(body).slice(0, 80));
    }
    const stale = await call('admin', 'PATCH', '/api/v1/roles/tag_keeper', { body: { permissions: ['resource.view'] }, version: 1 });
    assert.equal(stale.status, 412);
    assert.equal((await call('admin', 'PATCH', '/api/v1/roles/tag_keeper', { body: { permissions: ['resource.view'] } })).status, 428);
    assert.equal((await call('admin', 'PATCH', '/api/v1/roles/nobody_here', { body: { permissions: ['resource.view'] }, version: 1 })).status, 404);
    assert.equal((await call('admin', 'DELETE', '/api/v1/roles/nobody_here')).status, 404);
  });

  test('the built-in roles cannot be changed or deleted', async () => {
    for (const name of ['platform_admin', 'operator', 'auditor']) {
      const patch = await call('admin', 'PATCH', `/api/v1/roles/${name}`, { body: { permissions: ['resource.view'] }, version: 1 });
      assert.deepEqual([patch.status, patch.code], [409, 'NUV_ROLE_SYSTEM'], name);
      const del = await call('admin', 'DELETE', `/api/v1/roles/${name}`);
      assert.deepEqual([del.status, del.code], [409, 'NUV_ROLE_SYSTEM'], name);
    }
  });

  test('a role someone holds cannot be deleted; once they hold another it can, and a deleted role cannot be given', async () => {
    const refused = await call('admin', 'DELETE', '/api/v1/roles/tag_keeper');
    assert.deepEqual([refused.status, refused.code], [409, 'NUV_ROLE_IN_USE']);
    assert.match(refused.json.detail ?? refused.text, /1 user holds this role/);
    const users = (await call('admin', 'GET', '/api/v1/users')).json.items, keeper = users.find(user => user.username === 'keeper1');
    assert.equal((await call('admin', 'PATCH', `/api/v1/users/${keeper.id}`, { body: { status: 'active', roles: ['auditor'] }, version: keeper.rowVersion })).status, 200);
    assert.equal((await call('admin', 'DELETE', '/api/v1/roles/tag_keeper')).status, 200);
    assert.ok(!(await call('admin', 'GET', '/api/v1/roles')).json.items.some(role => role.name === 'tag_keeper'));
    const again = await call('admin', 'PATCH', `/api/v1/users/${keeper.id}`, { body: { status: 'active', roles: ['tag_keeper'] }, version: keeper.rowVersion + 1 });
    assert.equal(again.status, 422, 'a role that does not exist cannot be given');
  });

  test('nobody can hand out more than they have: a role manager cannot create a role with, or grant, permissions beyond their own', async () => {
    const manager = await createRole('admin', { name: 'role_manager', permissions: ['resource.view', 'identity.manage'] });
    assert.equal(manager.status, 201, manager.text);
    await addUser('manager1', ['role_manager']);
    const mine = await createRole('manager1', { name: 'viewers', permissions: ['resource.view'] });
    assert.equal(mine.status, 201, 'a role within their own permissions is fine');
    for (const permissions of [['resource.view', 'resource.operate'], ['resource.view', 'platform.manage'], ['resource.view', 'identity.manage', 'audit.view']]) {
      const result = await createRole('manager1', { name: 'sneaky', permissions });
      assert.deepEqual([result.status, result.code], [403, 'NUV_ROLE_ESCALATION'], permissions.join());
    }
    const widen = await call('manager1', 'PATCH', '/api/v1/roles/viewers', { body: { permissions: ['resource.view', 'resource.operate'] }, version: mine.json.rowVersion });
    assert.deepEqual([widen.status, widen.code], [403, 'NUV_ROLE_ESCALATION']);
    // and cannot give a user a role they could not have themselves — including making themselves an administrator
    const users = (await call('manager1', 'GET', '/api/v1/users')).json.items, me = users.find(user => user.username === 'manager1');
    const promote = await call('manager1', 'PATCH', `/api/v1/users/${me.id}`, { body: { status: 'active', roles: ['platform_admin'] }, version: me.rowVersion });
    assert.deepEqual([promote.status, promote.code], [403, 'NUV_ROLE_ESCALATION']);
    const operatorRole = await call('manager1', 'PATCH', `/api/v1/users/${me.id}`, { body: { status: 'active', roles: ['operator'] }, version: me.rowVersion });
    assert.equal(operatorRole.code, 'NUV_ROLE_ESCALATION', 'operator has resource.operate, which they do not');
    const ok = await call('manager1', 'PATCH', `/api/v1/users/${me.id}`, { body: { status: 'active', roles: ['role_manager', 'viewers'] }, version: me.rowVersion });
    assert.equal(ok.status, 200, ok.text);
  });

  test('roles are changed only with a valid CSRF token, and every change is in the audit history', async () => {
    const wrong = await call('admin', 'POST', '/api/v1/roles', { body: { name: 'csrf_test', permissions: ['resource.view'] }, csrf: 'wrong' });
    assert.deepEqual([wrong.status, wrong.code], [403, 'NUV_CSRF_INVALID']);
    assert.ok(!(await call('admin', 'GET', '/api/v1/roles')).json.items.some(role => role.name === 'csrf_test'));
    const audit = await call('admin', 'GET', '/api/v1/audit-events?limit=200&search=identity.role');
    const actions = (audit.json.items ?? []).map(event => event.action);
    for (const action of ['identity.role_created', 'identity.role_updated', 'identity.role_deleted']) assert.ok(actions.includes(action), action);
  });
});

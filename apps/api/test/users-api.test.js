import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Creating accounts and passwords over the real HTTP API (in-memory services): an administrator makes an account, the person is held at "choose a new password" until they do,
// they change it themselves, an administrator can set a temporary one, and the rules around them (escalation, throttling, what is audited).
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Users-Test-Password-1!', INITIAL = 'Initial-Password-For-Ann-1!', CHOSEN = 'Ann-Chose-This-Password-9!', TEMPORARY = 'Temporary-Password-For-Ann-2!'; // secret-scan:allow (fake test credentials)

describe('creating accounts and passwords over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir; const sessions = {};

  async function call(who, method, path, { body, csrf = 'valid' } = {}) {
    const headers = {};
    if (who) { headers.cookie = sessions[who].cookie; if (method !== 'GET') headers['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text, headers: response.headers };
  }
  async function login(name, username = name, password = PASSWORD) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const json = await response.json();
    sessions[name] = { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken };
    return { status: response.status, json };
  }
  const create = (body, who = 'admin') => call(who, 'POST', '/api/v1/users', { body });
  const userOf = async username => (await call('admin', 'GET', '/api/v1/users')).json.items.find(user => user.username === username);

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-users-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await login('admin')).status, 200);
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('an administrator creates an account: it is active at once, must choose its own password by default, and can require two-step verification', async () => {
    const made = await create({ username: 'Ann.Example', displayName: ' Ann Example ', password: INITIAL, roles: ['auditor'] });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.username, made.json.displayName, made.json.status, made.json.roles, made.json.mustChangePassword, made.json.mfaRequired, made.json.mfaEnrolled], ['Ann.Example', 'Ann Example', 'active', ['auditor'], true, false, false]);
    assert.ok(made.headers.get('etag'));
    assert.equal(JSON.stringify(made.json).includes(INITIAL), false, 'the password is not echoed');
    assert.equal((await userOf('Ann.Example')).mustChangePassword, true);
    const strict = await create({ username: 'bob.example', displayName: 'Bob', password: INITIAL, roles: ['operator'], mustChangePassword: false, mfaRequired: true });
    assert.deepEqual([strict.status, strict.json.mustChangePassword, strict.json.mfaRequired], [201, false, true]);
    assert.equal((await login('bob', 'bob.example', INITIAL)).json.mfa.state, 'enrollment_required');
  });

  test('what an account must look like: username, display name, password length, roles that exist, no duplicates, nothing but booleans for the flags', async () => {
    const good = { username: 'carol.example', displayName: 'Carol', password: INITIAL, roles: ['operator'] };
    const cases = [
      [{ ...good, username: 'ab' }, 422, 'NUV_USER_INVALID'], [{ ...good, username: 'has space' }, 422, 'NUV_USER_INVALID'], [{ ...good, username: 5 }, 422, 'NUV_USER_INVALID'],
      [{ ...good, displayName: '   ' }, 422, 'NUV_USER_INVALID'], [{ ...good, displayName: 'n'.repeat(201) }, 422, 'NUV_USER_INVALID'], [{ ...good, displayName: undefined }, 422, 'NUV_USER_INVALID'],
      [{ ...good, password: 'short' }, 422, 'NUV_PASSWORD_TOO_SHORT'], [{ ...good, password: undefined }, 422, 'NUV_PASSWORD_TOO_SHORT'],
      [{ ...good, roles: [] }, 422, 'NUV_USER_INVALID'], [{ ...good, roles: undefined }, 422, 'NUV_USER_INVALID'], [{ ...good, roles: ['no_such_role'] }, 422, 'NUV_USER_INVALID'], [{ ...good, roles: [7] }, 422, 'NUV_USER_INVALID'],
      [{ ...good, mfaRequired: 'yes' }, 422, 'NUV_USER_INVALID'], [{ ...good, mustChangePassword: 1 }, 422, 'NUV_USER_INVALID'],
      [{ ...good, username: 'ANN.EXAMPLE' }, 409, 'NUV_USERNAME_EXISTS']
    ];
    for (const [body, status, code] of cases) { const result = await create(body); assert.deepEqual([result.status, result.code], [status, code], JSON.stringify(body).slice(0, 90)); }
    assert.equal(await userOf('carol.example'), undefined, 'none of those made an account');
    for (const body of [null, [], 'x', 5]) assert.equal((await call('admin', 'POST', '/api/v1/users', { body })).code, 'NUV_USER_INVALID');
  });

  test('a person with an initial password is held at "choose a new password" until they do; then the rest opens and the old password stops working', async () => {
    const signedIn = await login('ann', 'Ann.Example', INITIAL);
    assert.equal(signedIn.status, 200); assert.equal(signedIn.json.passwordChangeRequired, true); assert.deepEqual(signedIn.json.user.permissions, []);
    assert.equal((await call('ann', 'GET', '/api/v1/resources')).code, 'NUV_PASSWORD_CHANGE_REQUIRED');
    const me = await call('ann', 'GET', '/api/v1/auth/me');
    assert.equal(me.json.passwordChangeRequired, true);
    const wrong = await call('ann', 'POST', '/api/v1/auth/password', { body: { currentPassword: 'not it at all 1', newPassword: CHOSEN } }); // secret-scan:allow (fake test value)
    assert.deepEqual([wrong.status, wrong.code], [422, 'NUV_PASSWORD_INCORRECT']);
    assert.equal((await call('ann', 'POST', '/api/v1/auth/password', { body: { currentPassword: INITIAL, newPassword: 'short' } })).code, 'NUV_PASSWORD_TOO_SHORT');
    assert.equal((await call('ann', 'POST', '/api/v1/auth/password', { body: { currentPassword: INITIAL, newPassword: INITIAL } })).code, 'NUV_PASSWORD_UNCHANGED');
    assert.equal((await call('ann', 'POST', '/api/v1/auth/password', { body: { currentPassword: INITIAL, newPassword: CHOSEN }, csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    await login('ann-other', 'Ann.Example', INITIAL);
    const changed = await call('ann', 'POST', '/api/v1/auth/password', { body: { currentPassword: INITIAL, newPassword: CHOSEN } });
    assert.deepEqual([changed.status, changed.json], [200, { changed: true, otherSessionsEnded: 1 }]);
    assert.equal((await call('ann', 'GET', '/api/v1/resources')).status, 200, 'this session carries on, now with everything');
    assert.equal((await call('ann', 'GET', '/api/v1/auth/me')).json.passwordChangeRequired, false);
    assert.equal((await call('ann-other', 'GET', '/api/v1/auth/me')).status, 401, 'the other session ended');
    assert.equal((await login('again', 'Ann.Example', INITIAL)).status, 401, 'the initial password no longer works');
    assert.equal((await login('again', 'Ann.Example', CHOSEN)).json.passwordChangeRequired, false);
    assert.ok((await userOf('Ann.Example')).mustChangePassword === false);
  });

  test('anyone may change their own password later, from a normal session; wrong passwords are limited', async () => {
    await login('ann2', 'Ann.Example', CHOSEN);
    const NEXT = 'Ann-Chose-Another-One-3!'; // secret-scan:allow (fake test credential)
    for (let i = 0; i < 5; i++) assert.equal((await call('ann2', 'POST', '/api/v1/auth/password', { body: { currentPassword: 'wrong wrong wrong 1', newPassword: NEXT } })).code, 'NUV_PASSWORD_INCORRECT'); // secret-scan:allow (fake test value)
    const throttled = await call('ann2', 'POST', '/api/v1/auth/password', { body: { currentPassword: CHOSEN, newPassword: NEXT } });
    assert.deepEqual([throttled.status, throttled.code], [429, 'NUV_PASSWORD_THROTTLED'], 'the right password is not even tried once the wrong ones have run out');
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);
    assert.equal((await login('ann3', 'Ann.Example', CHOSEN)).status, 200, 'and the password was not changed');
  });

  test('an administrator sets a temporary password: the person is signed out everywhere, must replace it, and the administrator cannot do this to themselves', async () => {
    const ann = await userOf('Ann.Example');
    await login('ann4', 'Ann.Example', CHOSEN);
    const set = await call('admin', 'POST', `/api/v1/users/${ann.id}/password`, { body: { password: TEMPORARY } });
    assert.equal(set.status, 200, set.text); assert.equal(set.json.set, true); assert.ok(set.json.sessionsEnded >= 1);
    assert.equal((await call('ann4', 'GET', '/api/v1/auth/me')).status, 401);
    assert.equal((await login('ann5', 'Ann.Example', CHOSEN)).status, 401);
    const back = await login('ann5', 'Ann.Example', TEMPORARY);
    assert.equal(back.json.passwordChangeRequired, true);
    assert.equal((await call('admin', 'POST', `/api/v1/users/${ann.id}/password`, { body: { password: 'short' } })).code, 'NUV_PASSWORD_TOO_SHORT');
    assert.equal((await call('admin', 'POST', `/api/v1/users/${ann.id}/password`, { body: { password: TEMPORARY, mustChange: 'no' } })).code, 'NUV_USER_INVALID');
    assert.equal((await call('admin', 'POST', '/api/v1/users/00000000-0000-4000-8000-000000000000/password', { body: { password: TEMPORARY } })).status, 404);
    const self = await userOf('admin');
    assert.deepEqual([(await call('admin', 'POST', `/api/v1/users/${self.id}/password`, { body: { password: TEMPORARY } })).code], ['NUV_PASSWORD_USE_OWN_CHANGE']);
    assert.equal((await call('admin', 'GET', '/api/v1/users')).status, 200, 'the administrator’s own session is untouched');
    const kept = await call('admin', 'POST', `/api/v1/users/${ann.id}/password`, { body: { password: TEMPORARY, mustChange: false } });
    assert.equal(kept.status, 200);
    assert.equal((await login('ann6', 'Ann.Example', TEMPORARY)).json.passwordChangeRequired, false, 'mustChange: false leaves the person free to keep it');
  });

  test('nobody can hand out more than they have: a user manager cannot create an administrator', async () => {
    const role = await call('admin', 'POST', '/api/v1/roles', { body: { name: 'user_manager', permissions: ['resource.view', 'identity.manage'] } });
    assert.equal(role.status, 201, role.text);
    assert.equal((await create({ username: 'manager.example', displayName: 'Manager', password: INITIAL, roles: ['user_manager'], mustChangePassword: false })).status, 201);
    await login('manager', 'manager.example', INITIAL);
    const sneaky = await create({ username: 'sneaky.example', displayName: 'Sneaky', password: INITIAL, roles: ['platform_admin'] }, 'manager');
    assert.deepEqual([sneaky.status, sneaky.code], [403, 'NUV_ROLE_ESCALATION']);
    assert.equal((await create({ username: 'viewer.example', displayName: 'Viewer', password: INITIAL, roles: ['user_manager'] }, 'manager')).status, 201, 'a role within their own permissions is fine');
    assert.equal(await userOf('sneaky.example'), undefined);
  });

  test('every step is in the audit history, and no password is in it', async () => {
    const events = (await call('admin', 'GET', '/api/v1/audit-events?limit=500&search=identity.')).json.items ?? [], actions = new Set(events.map(event => event.action));
    for (const action of ['identity.user_created', 'identity.password_changed', 'identity.password_set']) assert.ok(actions.has(action), action);
    assert.ok(events.some(event => event.action === 'identity.password_changed' && event.outcome === 'failed'), 'wrong current passwords are recorded as failures');
    const text = JSON.stringify(events);
    for (const secret of [PASSWORD, INITIAL, CHOSEN, TEMPORARY]) assert.equal(text.includes(secret), false, 'no password in the audit history');
  });
});

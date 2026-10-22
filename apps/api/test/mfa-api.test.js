import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totpCode } from '../../../modules/identity/src/totp.js';
import { midStep } from '../../../modules/identity/test-support/totp-step.js';

// Two-factor sign-in through the real HTTP API (in-memory services): the sign-in in two steps, what a half-finished session may do, enrolment, backup codes, the lock-out,
// the policy and the administrator's reset. TOTP codes are computed with the real clock; the steps used by one person are strictly increasing (previous, current, next), which
// the one-use rule needs and the tolerance allows.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Mfa-Test-Password-1!'; // secret-scan:allow (fake test credential)
const at = (secret, steps) => totpCode(secret, Date.now() + steps * 30_000);

describe('two-factor sign-in over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir; const sessions = {};

  async function call(who, method, path, { body, version, csrf = 'valid' } = {}) {
    const headers = {};
    if (who) { headers.cookie = sessions[who].cookie; if (method !== 'GET') headers['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (version !== undefined) headers['if-match'] = `"${version}"`;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text, headers: response.headers };
  }
  async function login(name, username = name) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    const json = await response.json();
    sessions[name] = { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken };
    return { status: response.status, json };
  }
  async function addUser(username, role = 'operator') {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await call('admin', 'PATCH', `/api/v1/users/${signup.user.id}`, { body: { status: 'active', roles: [role] }, version: signup.user.rowVersion });
    assert.equal(update.status, 200, update.text);
    return update.json;
  }
  // a user with an authenticator, signed in and verified in the session named `name`
  async function enrolledUser(name, role = 'operator') {
    const user = await addUser(name, role);
    assert.equal((await login(name)).json.mfa.state, 'verified');
    const started = await call(name, 'POST', '/api/v1/auth/mfa/enrollment');
    assert.equal(started.status, 200, started.text);
    const confirmed = await call(name, 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: at(started.json.secret, -1) } });
    assert.equal(confirmed.status, 200, confirmed.text);
    return { user, secret: started.json.secret, backupCodes: confirmed.json.backupCodes };
  }

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-mfa-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await login('admin')).status, 200);
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('setting it up: a wrong code enrols nothing, the right one returns ten backup codes, and the secret comes back as a link an authenticator app can read', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    await addUser('ann');
    assert.equal((await login('ann')).json.mfa.state, 'verified');
    const status = await call('ann', 'GET', '/api/v1/auth/mfa');
    assert.deepEqual(status.json, { enrolled: false, enrolledAt: null, backupCodesRemaining: 0, required: false, state: 'verified' });
    const started = await call('ann', 'POST', '/api/v1/auth/mfa/enrollment');
    assert.equal(started.status, 200);
    assert.match(started.json.secret, /^[A-Z2-7]{32}$/); assert.equal(started.json.account, 'ann'); assert.equal(started.json.issuer, 'Nuvrion');
    assert.match(started.json.uri, new RegExp(`^otpauth://totp/Nuvrion:ann\\?secret=${started.json.secret}&issuer=Nuvrion`));
    const wrong = await call('ann', 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: '000000' } });
    assert.deepEqual([wrong.status, wrong.code], [422, 'NUV_MFA_CODE_INVALID']);
    assert.equal((await call('ann', 'GET', '/api/v1/auth/mfa')).json.enrolled, false);
    const bad = await call('ann', 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: 123456 } });
    assert.deepEqual([bad.status, bad.code], [422, 'NUV_MFA_REQUEST_INVALID']);
    const confirmed = await call('ann', 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: at(started.json.secret, -1) } });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.json.state, 'verified'); assert.equal(confirmed.json.backupCodes.length, 10);
    assert.deepEqual((await call('ann', 'GET', '/api/v1/auth/mfa')).json, { enrolled: true, enrolledAt: (await call('ann', 'GET', '/api/v1/auth/mfa')).json.enrolledAt, backupCodesRemaining: 10, required: false, state: 'verified' });
    assert.equal((await call('ann', 'GET', '/api/v1/resources')).status, 200, 'the session that set it up carries on');
    assert.equal((await call('ann', 'POST', '/api/v1/auth/mfa/enrollment')).code, 'NUV_MFA_ALREADY_ENROLLED');
    const users = (await call('admin', 'GET', '/api/v1/users')).json.items;
    assert.equal(users.find(user => user.username === 'ann').mfaEnrolled, true);
  });

  test('signing in then takes two steps: the password gives a session that can only finish signing in, and a code gives the rest', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    const { secret } = await enrolledUser('bob');
    const second = await login('bob2', 'bob');
    assert.equal(second.status, 200); assert.equal(second.json.mfa.state, 'verification_required'); assert.deepEqual(second.json.user.permissions, []);
    for (const path of ['/api/v1/resources', '/api/v1/connections', '/api/v1/tasks', '/api/v1/auth/sessions']) {
      const result = await call('bob2', 'GET', path);
      assert.deepEqual([result.status, result.code], [403, 'NUV_MFA_REQUIRED'], path);
    }
    const me = await call('bob2', 'GET', '/api/v1/auth/me');
    assert.equal(me.status, 200); assert.equal(me.json.mfa.state, 'verification_required'); assert.deepEqual(me.json.user.permissions, []);
    const wrong = await call('bob2', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '000000' } });
    assert.deepEqual([wrong.status, wrong.code], [422, 'NUV_MFA_CODE_INVALID']);
    assert.equal((await call('bob2', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '1', backupCode: 'x' } })).code, 'NUV_MFA_REQUEST_INVALID');
    assert.equal((await call('bob2', 'POST', '/api/v1/auth/mfa/verify', { body: {}, csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    const right = await call('bob2', 'POST', '/api/v1/auth/mfa/verify', { body: { code: at(secret, 0) } });
    assert.equal(right.status, 200, right.text); assert.deepEqual([right.json.state, right.json.method], ['verified', 'totp']);
    assert.equal((await call('bob2', 'GET', '/api/v1/resources')).status, 200);
    assert.ok((await call('bob2', 'GET', '/api/v1/auth/me')).json.user.permissions.includes('resource.view'));
    const third = await login('bob3', 'bob');
    const replay = await call('bob3', 'POST', '/api/v1/auth/mfa/verify', { body: { code: at(secret, 0) } });
    assert.equal(replay.code, 'NUV_MFA_CODE_INVALID', 'a code that was used is refused');
  });

  test('a backup code finishes signing in once, and the count falls; regenerating needs a code and replaces them; turning it off needs a code too', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    const { secret, backupCodes } = await enrolledUser('cora');
    await login('cora2', 'cora');
    const used = await call('cora2', 'POST', '/api/v1/auth/mfa/verify', { body: { backupCode: backupCodes[0].toUpperCase() } });
    assert.deepEqual([used.status, used.json.method, used.json.backupCodesRemaining], [200, 'backup', 9]);
    await login('cora3', 'cora');
    assert.equal((await call('cora3', 'POST', '/api/v1/auth/mfa/verify', { body: { backupCode: backupCodes[0] } })).code, 'NUV_MFA_CODE_INVALID');
    assert.equal((await call('cora3', 'POST', '/api/v1/auth/mfa/verify', { body: { backupCode: backupCodes[1] } })).json.backupCodesRemaining, 8);
    assert.equal((await call('cora3', 'POST', '/api/v1/auth/mfa/backup-codes', { body: { code: '000000' } })).code, 'NUV_MFA_CODE_INVALID');
    const fresh = await call('cora3', 'POST', '/api/v1/auth/mfa/backup-codes', { body: { code: at(secret, 0) } });
    assert.equal(fresh.status, 200, fresh.text); assert.equal(fresh.json.backupCodes.length, 10);
    assert.ok(fresh.json.backupCodes.every(code => !backupCodes.includes(code)));
    assert.equal((await call('cora3', 'GET', '/api/v1/auth/mfa')).json.backupCodesRemaining, 10);
    const refused = await call('cora3', 'POST', '/api/v1/auth/mfa/disable', { body: { code: '000000' } });
    assert.equal(refused.code, 'NUV_MFA_CODE_INVALID');
    const off = await call('cora3', 'POST', '/api/v1/auth/mfa/disable', { body: { code: at(secret, 1) } });
    assert.deepEqual([off.status, off.json], [200, { disabled: true }]);
    assert.equal((await login('cora4', 'cora')).json.mfa.state, 'verified', 'with it off, the password is enough again');
  });

  test('wrong codes: five end the sign-in, ten lock the account with a Retry-After, and a locked account refuses even the right code', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    const { secret } = await enrolledUser('dave');
    await login('dave2', 'dave');
    for (let i = 0; i < 4; i++) assert.equal((await call('dave2', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '000000' } })).code, 'NUV_MFA_CODE_INVALID');
    const ended = await call('dave2', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '000000' } });
    assert.deepEqual([ended.status, ended.code], [401, 'NUV_MFA_SESSION_REVOKED']);
    assert.equal((await call('dave2', 'GET', '/api/v1/auth/me')).status, 401, 'the session is gone');
    await login('dave3', 'dave');
    for (let i = 0; i < 4; i++) await call('dave3', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '111111' } });
    assert.equal((await call('dave3', 'POST', '/api/v1/auth/mfa/verify', { body: { code: '111111' } })).code, 'NUV_MFA_SESSION_REVOKED');
    await login('dave4', 'dave');
    const locked = await call('dave4', 'POST', '/api/v1/auth/mfa/verify', { body: { code: at(secret, 0) } });
    assert.deepEqual([locked.status, locked.code], [429, 'NUV_MFA_THROTTLED']);
    assert.ok(Number(locked.headers.get('retry-after')) > 800);
    assert.equal((await call('dave4', 'GET', '/api/v1/resources')).code, 'NUV_MFA_REQUIRED');
  });

  const userOf = async username => (await call('admin', 'GET', '/api/v1/users')).json.items.find(user => user.username === username);
  const requireFor = async (username, required, roles = ['operator']) => {
    const user = await userOf(username);
    return call('admin', 'PATCH', `/api/v1/users/${user.id}`, { body: { status: 'active', roles, mfaRequired: required }, version: user.rowVersion });
  };

  test('requiring it for a person: they must set it up at once (their open session too), nobody else is affected, they cannot turn it off, and an administrator’s reset ends their sessions but keeps the requirement', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    await addUser('erin'); await addUser('frank');
    assert.equal((await login('erin')).json.mfa.state, 'verified'); await login('frank');
    const bad = await call('admin', 'PATCH', `/api/v1/users/${(await userOf('erin')).id}`, { body: { status: 'active', roles: ['operator'], mfaRequired: 'yes' }, version: (await userOf('erin')).rowVersion });
    assert.deepEqual([bad.status, bad.code], [422, 'NUV_USER_UPDATE_INVALID']);
    const set = await requireFor('erin', true);
    assert.equal(set.status, 200, set.text); assert.equal(set.json.mfaRequired, true);
    assert.equal((await call('erin', 'GET', '/api/v1/resources')).code, 'NUV_MFA_REQUIRED', 'her open session is held at once');
    assert.equal((await call('frank', 'GET', '/api/v1/resources')).status, 200, 'frank is not affected');
    const state = (await call('erin', 'GET', '/api/v1/auth/mfa')).json;
    assert.deepEqual([state.state, state.required], ['enrollment_required', true]);
    const started = await call('erin', 'POST', '/api/v1/auth/mfa/enrollment');
    assert.equal(started.status, 200);
    const confirmed = await call('erin', 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: at(started.json.secret, -1) } });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.json.state, 'verified');
    assert.equal((await call('erin', 'GET', '/api/v1/resources')).status, 200);
    const off = await call('erin', 'POST', '/api/v1/auth/mfa/disable', { body: { code: at(started.json.secret, 0) } });
    assert.deepEqual([off.status, off.code], [409, 'NUV_MFA_REQUIRED_FOR_ACCOUNT']);
    const user = await userOf('erin');
    assert.deepEqual([user.mfaRequired, user.mfaEnrolled], [true, true]);
    const reset = await call('admin', 'DELETE', `/api/v1/users/${user.id}/mfa`);
    assert.deepEqual([reset.status, reset.json], [200, { reset: true }]);
    assert.equal((await call('erin', 'GET', '/api/v1/auth/me')).status, 401, 'the reset ended her sessions');
    assert.equal((await login('erin2', 'erin')).json.mfa.state, 'enrollment_required', 'she signs in with her password and must set it up again');
    assert.equal((await call('admin', 'DELETE', '/api/v1/users/00000000-0000-4000-8000-000000000000/mfa')).status, 404);
    const lifted = await requireFor('erin', false);
    assert.equal(lifted.json.mfaRequired, false);
    assert.equal((await call('erin2', 'GET', '/api/v1/resources')).status, 200, 'with the requirement lifted, her held session is free again');
  });

  test('requiring it for an administrator does not lock them out: they set it up with the password they have', async () => {
    await midStep();   // a code works once and lasts one step: begin the short sequence of uses early in a step
    const admin = await userOf('admin');
    try {
      const set = await call('admin', 'PATCH', `/api/v1/users/${admin.id}`, { body: { status: 'active', roles: ['platform_admin'], mfaRequired: true }, version: admin.rowVersion });
      assert.equal(set.status, 200, set.text);
      assert.equal((await call('admin', 'GET', '/api/v1/users')).code, 'NUV_MFA_REQUIRED');
      const started = await call('admin', 'POST', '/api/v1/auth/mfa/enrollment');
      assert.equal(started.status, 200);
      const confirmed = await call('admin', 'POST', '/api/v1/auth/mfa/enrollment/confirm', { body: { code: at(started.json.secret, -1) } });
      assert.equal(confirmed.status, 200);
      assert.equal((await call('admin', 'GET', '/api/v1/users')).status, 200);
    } finally {
      const now = await userOf('admin');
      await call('admin', 'PATCH', `/api/v1/users/${now.id}`, { body: { status: 'active', roles: ['platform_admin'], mfaRequired: false }, version: now.rowVersion });
      await call('admin', 'DELETE', `/api/v1/users/${now.id}/mfa`);
      assert.equal((await login('admin')).json.mfa.state, 'verified');
    }
  });

  test('every step is in the audit history, and no secret or code is in it', async () => {
    const audit = await call('admin', 'GET', '/api/v1/audit-events?limit=500&search=identity.mfa');
    const events = audit.json.items ?? [], actions = new Set(events.map(event => event.action));
    for (const action of ['identity.mfa_enrolled', 'identity.mfa_verified', 'identity.mfa_disabled', 'identity.mfa_backup_codes_regenerated', 'identity.mfa_requirement_changed', 'identity.mfa_reset']) assert.ok(actions.has(action), action);
    assert.ok(events.some(event => event.action === 'identity.mfa_verified' && event.outcome === 'failed'), 'wrong codes are recorded as failures');
    const text = JSON.stringify(events);
    assert.doesNotMatch(text, /[A-Z2-7]{32}/, 'no secret'); assert.doesNotMatch(text, /\b[a-z2-9]{5}-[a-z2-9]{5}\b/, 'no backup code');
    const logins = (await call('admin', 'GET', '/api/v1/audit-events?limit=500&search=identity.login')).json.items ?? [];
    assert.ok(logins.some(event => event.detail?.mfa === 'verification_required'), 'a sign-in that still needs a code says so');
  });
});

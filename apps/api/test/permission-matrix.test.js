import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Authorization matrix: for every protected route, who may call it. The server runs in-process with in-memory services and real HTTP
// requests are sent as an administrator, an operator, an auditor and an anonymous caller. Mutating routes are probed with a WRONG CSRF
// token, which is checked after authorization and before the handler: 403 PERMISSION_DENIED means the role lacks the permission,
// 403 CSRF_INVALID means the role was authorized (and nothing was executed). Read-only routes are called for real.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE = readFileSync(join(HERE, '../src/server.js'), 'utf8');
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));

const PASSWORD = 'Matrix-Test-Password-1!'; // secret-scan:allow (fake test credential)
const ID = '00000000-0000-4000-8000-000000000001', SESSION_HASH = 'a'.repeat(64);
const PERMISSIONS = {
  admin: ['resource.view', 'resource.operate', 'connection.view', 'connection.manage', 'identity.manage', 'audit.view', 'platform.manage'],
  operator: ['resource.view', 'resource.operate', 'connection.view'],
  auditor: ['resource.view', 'connection.view', 'audit.view']
};
// [method, path, permission, route id used by the coverage check]
const PROTECTED = [
  ['GET', '/api/v1/platform/upgrade', 'platform.manage', '/api/v1/platform/upgrade'],
  ['POST', '/api/v1/platform/upgrade/upload', 'platform.manage', '/api/v1/platform/upgrade/upload'],
  ['POST', '/api/v1/platform/upgrade/start', 'platform.manage', '/api/v1/platform/upgrade/start'],
  ['GET', '/api/v1/platform/metrics', 'platform.manage', '/api/v1/platform/metrics'],
  ['GET', '/api/v1/platform/metrics/prometheus', 'platform.manage', '/api/v1/platform/metrics/prometheus'],
  ['GET', '/api/v1/users', 'identity.manage', '/api/v1/users'],
  ['PATCH', `/api/v1/users/${ID}`, 'identity.manage', 'userMatch'],
  ['POST', `/api/v1/users/${ID}/revoke-sessions`, 'identity.manage', 'userSessionsMatch'],
  ['POST', `/api/v1/users/${ID}/recovery-code`, 'identity.manage', 'userRecoveryMatch'],
  ['GET', '/api/v1/tasks', 'resource.view', '/api/v1/tasks'],
  ['POST', `/api/v1/tasks/${ID}/reconcile`, 'resource.operate', 'reconcileTaskMatch'],
  ['POST', `/api/v1/tasks/${ID}/cancel`, 'resource.operate', 'cancelTaskMatch'],
  ['POST', `/api/v1/tasks/${ID}/retry`, 'resource.operate', 'retryTaskMatch'],
  ['POST', '/api/v1/mock/operations', 'resource.operate', '/api/v1/mock/operations'],
  ['GET', '/api/v1/connections', 'connection.view', '/api/v1/connections'],
  ['POST', '/api/v1/connections', 'connection.manage', '/api/v1/connections'],
  ['GET', `/api/v1/connections/${ID}`, 'connection.view', 'connectionMatch'],
  ['PATCH', `/api/v1/connections/${ID}`, 'connection.manage', 'connectionMatch'],
  ['DELETE', `/api/v1/connections/${ID}`, 'connection.manage', 'deleteConnectionMatch'],
  ['POST', `/api/v1/connections/${ID}/credentials`, 'connection.manage', 'credentialMatch'],
  ['POST', `/api/v1/connections/${ID}/discover`, 'connection.manage', 'discoveryMatch'],
  ['POST', `/api/v1/connections/${ID}/test`, 'connection.manage', 'connectionTestMatch'],
  ['GET', `/api/v1/connections/${ID}/diagnostics`, 'connection.view', 'connectionDiagnosticsMatch'],
  ['POST', `/api/v1/connections/${ID}/host-client`, 'resource.operate', 'hostClientMatch'],
  ['POST', `/api/v1/connections/${ID}/terminal-sessions`, 'platform.manage', 'terminalMatch'],
  ['GET', '/api/v1/connection-alerts', 'connection.view', '/api/v1/connection-alerts'],
  ['POST', `/api/v1/connection-alerts/${ID}/acknowledge`, 'connection.manage', 'acknowledgeAlertMatch'],
  ['GET', '/api/v1/audit-events', 'audit.view', '/api/v1/audit-events'],
  ['GET', '/api/v1/agents', 'platform.manage', '/api/v1/agents'],
  ['POST', '/api/v1/agents/enrollment-tokens', 'platform.manage', '/api/v1/agents/enrollment-tokens'],
  ['POST', '/api/v1/agents/maintenance/sweep', 'platform.manage', '/api/v1/agents/maintenance/sweep'],
  ['POST', '/api/v1/agent-upgrades/releases', 'platform.manage', '/api/v1/agent-upgrades/releases'],
  ['POST', `/api/v1/agents/${ID}/upgrades`, 'platform.manage', 'agentUpgradeStageMatch'],
  ['POST', `/api/v1/agents/${ID}/rotate-secret`, 'platform.manage', 'agentRotateMatch'],
  ['POST', `/api/v1/agents/${ID}/revoke`, 'platform.manage', 'agentRevokeMatch'],
  ['POST', `/api/v1/agents/${ID}/commands`, 'resource.operate', 'agentCommandMatch'],
  ['GET', '/api/v1/resources', 'resource.view', '/api/v1/resources'],
  ['GET', '/api/v1/performance/latest', 'resource.view', '/api/v1/performance/latest'],
  ['GET', `/api/v1/resources/${ID}`, 'resource.view', 'resourceMatch'],
  ['GET', `/api/v1/resources/${ID}/metrics`, 'resource.view', 'resourceMetricsMatch'],
  ['GET', `/api/v1/resources/${ID}/settings`, 'resource.view', 'resourceSettingsMatch'],
  ['PATCH', `/api/v1/resources/${ID}/settings`, 'resource.operate', 'resourceSettingsMatch'],
  ['GET', `/api/v1/resources/${ID}/snapshots`, 'resource.view', 'resourceSnapshotsMatch'],
  ['POST', `/api/v1/resources/${ID}/snapshots`, 'resource.operate', 'resourceSnapshotsMatch'],
  ['POST', `/api/v1/resources/${ID}/snapshots/snap-1/revert`, 'resource.operate', 'resourceSnapshotActionMatch'],
  ['DELETE', `/api/v1/resources/${ID}/snapshots/snap-1`, 'resource.operate', 'resourceSnapshotActionMatch'],
  ['GET', `/api/v1/resources/${ID}/media/browse`, 'resource.operate', 'resourceMediaBrowseMatch'],
  ['GET', `/api/v1/resources/${ID}/media`, 'resource.view', 'resourceMediaMatch'],
  ['POST', `/api/v1/resources/${ID}/media`, 'resource.operate', 'resourceMediaMatch'],
  ['DELETE', `/api/v1/resources/${ID}/media/3000`, 'resource.operate', 'resourceMediaDriveMatch'],
  ['POST', `/api/v1/resources/${ID}/operations`, 'resource.operate', 'resourceOperationMatch'],
  ['POST', `/api/v1/resources/${ID}/console-sessions`, 'resource.operate', 'consoleSessionMatch']
];
// Any signed-in user, whatever their role.
const SESSION_ONLY = [
  ['GET', '/api/v1/auth/me', '/api/v1/auth/me'],
  ['GET', '/api/v1/auth/sessions', '/api/v1/auth/sessions'],
  ['DELETE', `/api/v1/auth/sessions/${SESSION_HASH}`, 'ownSessionMatch'],
  ['POST', '/api/v1/auth/recovery-code', '/api/v1/auth/recovery-code'],
  ['POST', '/api/v1/auth/logout', '/api/v1/auth/logout']
];
// Authenticated by an agent secret, not by a user session.
const AGENT_ROUTES = [
  ['POST', `/api/v1/agents/${ID}/heartbeat`, 'heartbeatMatch'],
  ['GET', `/api/v1/agents/${ID}/commands`, 'pendingCommandsMatch'],
  ['POST', `/api/v1/agents/${ID}/commands/${ID}/ack`, 'agentAckMatch'],
  ['GET', `/api/v1/agents/${ID}/upgrades`, 'agentUpgradeStageMatch'],
  ['POST', `/api/v1/agents/${ID}/upgrades/${ID}/report`, 'agentUpgradeReportMatch']
];
// Reachable without a session by design.
const PUBLIC = ['/api/v1/health', '/api/v1/readiness', '/api/v1/auth/login', '/api/v1/auth/signup', '/api/v1/auth/password-reset', '/api/v1/agents/enroll'];

describe('authorization matrix', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir; const sessions = {};

  async function call(who, method, path, { csrf = 'wrong', body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (who) {
      requestHeaders.cookie = sessions[who].cookie;
      if (method !== 'GET') requestHeaders['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf;
    }
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text, headers: response.headers };
  }
  async function login(username, password = PASSWORD) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const json = await response.json();
    return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken, user: json.user, json };
  }
  async function addUser(username, role) {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await call('admin', 'PATCH', `/api/v1/users/${signup.user.id}`, { csrf: 'valid', body: { status: 'active', roles: [role] }, headers: { 'if-match': `"${signup.user.rowVersion}"` } });
    assert.equal(update.status, 200, `activating ${username}: ${update.text}`);
    const listed = await call('admin', 'GET', '/api/v1/users');
    return (listed.json.items ?? listed.json.users ?? listed.json).find(u => u.id === signup.user.id);   // current row version
  }

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-matrix-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_UPGRADE_SHARED_DIR: join(workDir, 'upgrades'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sessions.admin = await login('admin');
    assert.equal(sessions.admin.status, 200);
    await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
    sessions.operator = await login('operator1'); sessions.auditor = await login('auditor1');
    assert.deepEqual([sessions.operator.status, sessions.auditor.status], [200, 200]);
    assert.deepEqual(sessions.operator.user.roles, ['operator']);
    assert.deepEqual(sessions.auditor.user.roles, ['auditor']);
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('the roles used here carry the permissions this matrix assumes', () => {
    for (const [role, expected] of Object.entries(PERMISSIONS)) {
      assert.deepEqual([...sessions[role].user.permissions].sort(), [...expected].sort(), role);
    }
  });

  for (const [method, path, permission] of PROTECTED) {
    test(`${method} ${path.replace(ID, ':id').replace('snap-1', ':snapshot').replace('3000', ':drive')} requires ${permission}`, async () => {
      const anonymous = await call(null, method, path);
      assert.equal(anonymous.status, 401, 'anonymous callers are refused');
      assert.equal(anonymous.code, 'NUV_AUTH_REQUIRED');
      for (const role of Object.keys(PERMISSIONS)) {
        const allowed = PERMISSIONS[role].includes(permission);
        const result = await call(role, method, path);
        if (method === 'GET') {
          if (allowed) assert.ok(![401, 403].includes(result.status) && result.status < 500, `${role} should be let in, got ${result.status} ${result.code ?? ''}`);
          else { assert.equal(result.status, 403, `${role} must be refused`); assert.equal(result.code, 'NUV_PERMISSION_DENIED'); }
        } else if (allowed) {
          assert.equal(result.status, 403, role); assert.equal(result.code, 'NUV_CSRF_INVALID', `${role} is authorized, so the only remaining check is CSRF`);
        } else {
          assert.equal(result.status, 403, role); assert.equal(result.code, 'NUV_PERMISSION_DENIED', `${role} must be refused before anything else is checked`);
        }
      }
    });
  }

  for (const [method, path] of SESSION_ONLY) {
    test(`${method} ${path.replace(SESSION_HASH, ':session')} needs a session but no particular permission`, async () => {
      assert.equal((await call(null, method, path)).status, 401);
      for (const role of Object.keys(PERMISSIONS)) {
        const result = await call(role, method, path);
        if (method === 'GET') assert.equal(result.status, 200, role);
        else { assert.equal(result.status, 403, role); assert.equal(result.code, 'NUV_CSRF_INVALID', role); }
      }
    });
  }

  for (const [method, path] of AGENT_ROUTES) {
    test(`${method} ${path.replaceAll(ID, ':id')} cannot be used with a user session or without agent credentials`, async () => {
      for (const who of [null, 'admin']) {
        const result = await call(who, method, path, { csrf: 'valid', body: method === 'POST' ? {} : undefined });
        assert.ok([401, 403, 404].includes(result.status), `${who ?? 'anonymous'} got ${result.status}`);
        assert.ok(result.status < 500);
        assert.notEqual(result.status, 200);
      }
      const wrong = await call(null, method, path, { body: method === 'POST' ? {} : undefined, headers: { 'x-agent-id': ID, 'x-agent-secret': 'wrong', authorization: 'Bearer wrong' } });
      assert.ok([401, 403, 404].includes(wrong.status), `wrong agent secret got ${wrong.status}`);
    });
  }

  test('every route in the server is covered by this matrix (a new route must be added here)', () => {
    const covered = new Set([...PROTECTED.map(r => r[3]), ...SESSION_ONLY.map(r => r[2]), ...AGENT_ROUTES.map(r => r[2]), ...PUBLIC]);
    const literals = [...SERVER_SOURCE.matchAll(/url\.pathname\s*===?\s*'(\/api\/v1\/[^']+)'/g)].map(m => m[1]);
    const patterns = [...SERVER_SOURCE.matchAll(/const (\w+Match)\s*=\s*url\.pathname\.match\(\/\^\\\/api\\\/v1/g)].map(m => m[1]);
    const websocketOnly = new Set(['agentConsoleMatch', 'terminalMatch']);   // matched on the upgrade path, which authenticates separately
    const missing = [...new Set([...literals, ...patterns])].filter(id => !covered.has(id) && !(id === 'terminalMatch'));
    assert.deepEqual(missing.filter(id => !websocketOnly.has(id)), [], 'routes with no authorization test');
    assert.ok(literals.length > 25 && patterns.length > 25, 'the route scan itself found the routes');
  });

  test('public routes work without a session', async () => {
    assert.equal((await call(null, 'GET', '/api/v1/health')).status, 200);
    assert.ok([200, 503].includes((await call(null, 'GET', '/api/v1/readiness')).status));
    const failed = await call(null, 'POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'wrong' } });
    assert.equal(failed.status, 401); assert.equal(failed.code, 'NUV_LOGIN_FAILED');
    const enroll = await call(null, 'POST', '/api/v1/agents/enroll', { body: { token: 'PASTE_TOKEN_HERE', name: 'x' } }); // secret-scan:allow (placeholder, not a real token)
    assert.ok([400, 401, 403].includes(enroll.status), `invalid enrollment token got ${enroll.status}`);
    assert.equal(enroll.code, 'NUV_AGENT_ENROLLMENT_INVALID');
  });

  test('an invalid or garbage session cookie is treated as not signed in', async () => {
    for (const cookie of ['nuvrion_session=garbage', 'nuvrion_session=', 'other=1', 'nuvrion_session=' + 'A'.repeat(64)]) {
      const result = await call(null, 'GET', '/api/v1/users', { headers: { cookie } });
      assert.equal(result.status, 401, cookie);
    }
  });

  test('a CSRF token without a session does not authenticate, and one user\'s CSRF token is useless for another', async () => {
    assert.equal((await call(null, 'POST', '/api/v1/connections', { headers: { 'x-csrf-token': sessions.admin.csrf } })).status, 401);
    const crossed = await call('operator', 'POST', '/api/v1/mock/operations', { csrf: sessions.admin.csrf });
    assert.equal(crossed.status, 403); assert.equal(crossed.code, 'NUV_CSRF_INVALID');
  });

  test('a lower-privileged user cannot grant themselves more access', async () => {
    const operator = sessions.operator.user;
    const attempt = await call('operator', 'PATCH', `/api/v1/users/${operator.id}`, { csrf: 'valid', body: { status: 'active', roles: ['platform_admin'] }, headers: { 'if-match': `"${operator.rowVersion}"` } });
    assert.equal(attempt.status, 403); assert.equal(attempt.code, 'NUV_PERMISSION_DENIED');
    const me = await call('operator', 'GET', '/api/v1/auth/me');
    assert.deepEqual(me.json.user.roles, ['operator']);
  });

  test('responses carry the standard security headers and are not cacheable', async () => {
    const result = await call(null, 'GET', '/api/v1/health');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('set-cookie') ?? '', /^$|HttpOnly/);
  });

  test('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
  });

  test('repeated failed sign-ins are throttled per user, with a Retry-After hint, and do not lock out other users', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'victim', password: `wrong-${i}` }) });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.equal((await last.json()).code, 'NUV_LOGIN_THROTTLED');
    assert.equal((await login('operator1')).status, 200, 'a different user is unaffected');
  });

  test('disabling a user ends their session immediately', async () => {
    const victim = await addUser('temp-op', 'operator');
    sessions.temp = await login('temp-op');
    assert.equal((await call('temp', 'GET', '/api/v1/auth/me')).status, 200);
    const disabled = await call('admin', 'PATCH', `/api/v1/users/${victim.id}`, { csrf: 'valid', body: { status: 'disabled', roles: ['operator'] }, headers: { 'if-match': `"${victim.rowVersion}"` } });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal((await call('temp', 'GET', '/api/v1/auth/me')).status, 401);
    assert.equal((await login('temp-op')).status, 401, 'and they cannot sign in again');
  });

  test('logout ends the session', async () => {
    sessions.short = await login('auditor1');
    assert.equal((await call('short', 'POST', '/api/v1/auth/logout', { csrf: 'valid' })).status, 204);
    assert.equal((await call('short', 'GET', '/api/v1/auth/me')).status, 401);
  });
});

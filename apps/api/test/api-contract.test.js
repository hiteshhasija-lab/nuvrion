import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// API contract tests. contracts/openapi/nuvrion-v1.yaml is the contract. The server runs in-process with in-memory services, every
// documented operation is called with real HTTP requests, and each request and response is checked against the description:
// the status must be documented, the body must match the schema, and the headers must be the documented ones.
// Two further checks keep the file honest: the operations listed must be exactly the routes the server implements, and the
// permission an operation says it needs must be the permission the server enforces.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const SERVER_SOURCE = readFileSync(join(ROOT, 'apps/api/src/server.js'), 'utf8');
const SPEC_TEXT = readFileSync(join(ROOT, 'contracts/openapi/nuvrion-v1.yaml'), 'utf8');
const missing = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib', 'yaml', 'ajv/dist/2020.js', 'ajv-formats'].map(name => import(name).then(() => null, () => name))).then(r => r.filter(Boolean));
const SKIP = missing.length ? `dependencies are not installed (${missing.join(', ')}); run npm install` : false;

const PASSWORD = 'Contract-Test-Password-1!'; // secret-scan:allow (fake test credential)
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT = '00000000-0000-4000-8000-0000000000aa';

const { parse } = SKIP ? {} : await import('yaml');
const spec = SKIP ? null : parse(SPEC_TEXT);
const operations = new Map();      // operationId -> { id, method, path, op }
if (spec) for (const [path, item] of Object.entries(spec.paths)) for (const method of METHODS) if (item[method]) operations.set(item[method].operationId, { id: item[method].operationId, method: method.toUpperCase(), path, op: item[method], item });

function resolveRef(ref) {
  assert.ok(ref.startsWith('#/'), `only local references are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((node, part) => node?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
}
const deref = node => node?.$ref ? resolveRef(node.$ref) : node;

let validators;
async function ajv() {
  if (validators) return validators;
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  validators = new Ajv2020({ strict: false, allErrors: true });
  addFormats(validators);
  return validators;
}
const compiled = new Map();
async function validatorFor(schema) {
  const key = JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, (await ajv()).compile({ components: spec.components, ...schema }));   // 'components' lets "#/components/..." references resolve
  return compiled.get(key);
}
async function check(schema, value, label) {
  const validate = await validatorFor(schema);
  assert.ok(validate(value), `${label} does not match the schema: ${(validate.errors ?? []).slice(0, 4).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}\n${JSON.stringify(value).slice(0, 600)}`);
}

// ---- the routes the server implements, read from its source -------------------------------------------------
function serverOperations() {
  const patterns = new Map();
  for (const m of SERVER_SOURCE.matchAll(/(\w+)\s*=\s*url\.pathname\.match\(\/\^(.*?)\$\/i?\)/g)) patterns.set(m[1], m[2]);
  const toTemplate = source => source.replaceAll('\\/', '/').replace(/\(([^()]*)\)/g, '{}');
  const found = new Set();
  for (const m of SERVER_SOURCE.matchAll(/req\.method\s*===?\s*'(GET|POST|PUT|PATCH|DELETE)'\s*&&\s*(?:url\.pathname\s*===?\s*'([^']+)'|(\w*[mM]atch))/g)) {
    const [, method, literal, name] = m;
    if (literal) found.add(`${method} ${literal}`);
    else if (patterns.has(name) && name !== 'resourceSnapshotActionMatch') found.add(`${method} ${toTemplate(patterns.get(name))}`);
  }
  // one pattern serves two methods: POST .../revert and DELETE
  assert.ok(patterns.has('resourceSnapshotActionMatch'), 'the snapshot route moved; update this scan');
  found.add('POST /api/v1/resources/{}/snapshots/{}/revert');
  found.add('DELETE /api/v1/resources/{}/snapshots/{}');
  return new Set([...found].filter(route => route.split(' ')[1].startsWith('/api/v1/')));
}
const specOperationKeys = () => new Set([...operations.values()].map(o => `${o.method} /api/v1${o.path.replace(/\{[^}]+\}/g, '{}')}`));

describe('the OpenAPI description', { skip: SKIP }, () => {
  test('is OpenAPI 3.1 with a title, a version and a server path', () => {
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.info.title && spec.info.version);
    assert.equal(spec.servers[0].url, '/api/v1');
  });

  test('lists exactly the routes the server implements: nothing missing, nothing invented', () => {
    const implemented = serverOperations(), documented = specOperationKeys();
    assert.ok(implemented.size > 60, `the route scan found only ${implemented.size} routes`);
    assert.deepEqual([...implemented].filter(r => !documented.has(r)).sort(), [], 'implemented but not documented');
    assert.deepEqual([...documented].filter(r => !implemented.has(r)).sort(), [], 'documented but not implemented');
  });

  test('every operation has a unique operationId, a tag and a summary or description of its responses', () => {
    const seen = new Set();
    for (const { id, op, method, path } of operations.values()) {
      assert.ok(id && !seen.has(id), `${method} ${path}: operationId missing or duplicated`);
      seen.add(id);
      assert.ok(op.tags?.length, `${id} has no tag`);
      assert.ok(Object.keys(op.responses).length, `${id} documents no responses`);
    }
    assert.ok(operations.size >= 69);
  });

  test('every $ref resolves, and every schema compiles', async () => {
    const refs = [];
    (function walk(node) { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) { if (key === '$ref') refs.push(value); else walk(value); } })(spec);
    assert.ok(refs.length > 100);
    for (const ref of refs) assert.ok(resolveRef(ref) !== undefined, `${ref} does not resolve`);
    for (const [name, schema] of Object.entries(spec.components.schemas)) await validatorFor(schema).catch(error => assert.fail(`schema ${name} does not compile: ${error.message}`));
  });

  test('every path parameter in a template is declared, and every declared one appears in the template', () => {
    for (const { id, path, op, item } of operations.values()) {
      const declared = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref).filter(p => p.in === 'path').map(p => p.name);
      const inTemplate = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      assert.deepEqual([...new Set(declared)].sort(), [...new Set(inTemplate)].sort(), `${id}: path parameters`);
    }
  });

  test('every JSON response has a schema, and every error response is a Problem', () => {
    for (const { id, op } of operations.values()) {
      for (const [status, response] of Object.entries(op.responses)) {
        const resolved = deref(response), json = resolved.content?.['application/json'];
        if (['204'].includes(status)) { assert.equal(resolved.content, undefined, `${id} ${status} must have no body`); continue; }
        if (resolved.content && !json) continue;   // text/plain or a ZIP, described by its own media type
        assert.ok(json?.schema, `${id} ${status} has no JSON schema`);
        if (Number(status) >= 400 && id !== 'getReadiness') assert.equal(json.schema.$ref, '#/components/schemas/Problem', `${id} ${status} must be a Problem`);
      }
    }
  });

  test('every signed-in operation documents 401, and every state-changing one sends the CSRF header and documents 403', () => {
    for (const { id, method, op } of operations.values()) {
      const security = op.security ?? spec.security;
      const usesSession = security.some(s => 'sessionCookie' in s);
      if (usesSession) assert.ok(op.responses['401'], `${id} must document 401`);
      if (usesSession && method !== 'GET') {
        assert.ok(security.every(s => 'csrfHeader' in s), `${id} changes state and must require the CSRF header`);
        assert.ok(op.responses['403'], `${id} must document 403`);
      }
      if (security.some(s => 'agentSecret' in s)) assert.ok(op.responses['401'], `${id} must document 401`);
    }
  });

  test('required permissions are named permissions', () => {
    const known = new Set(['resource.view', 'resource.operate', 'connection.view', 'connection.manage', 'identity.manage', 'audit.view', 'platform.manage']);
    for (const { id, op } of operations.values()) if (op['x-required-permission']) assert.ok(known.has(op['x-required-permission']), `${id}: ${op['x-required-permission']}`);
  });
});

describe('the API behaves as the description says', { skip: SKIP }, () => {
  let server, base, workDir;
  const sessions = {}, seen = new Map(), ctx = {};

  async function rawCall(who, method, path, { csrf = 'valid', body, headers = {}, rawBody } = {}) {
    const requestHeaders = { ...headers };
    if (who) { requestHeaders.cookie = sessions[who].cookie; if (method !== 'GET') requestHeaders['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers: requestHeaders, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function login(username, password = PASSWORD) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const json = await response.json();
    return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken, user: json.user };
  }

  // Calls a documented operation, validating the request against the description first (unless told not to), then the response.
  async function call(operationId, { as = 'admin', params = {}, query, headers = {}, body, rawBody, csrf, agent, expect, invalid = false } = {}) {
    const operation = operations.get(operationId);
    assert.ok(operation, `unknown operation ${operationId}`);
    const { op, item, method } = operation;
    const declared = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
    let path = '/api/v1' + operation.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(params[name] ?? assert.fail(`${operationId}: no value for {${name}}`)));
    if (query) path += '?' + new URLSearchParams(query);
    const requestHeaders = { ...headers, ...(agent ? { 'x-agent-secret': agent } : {}) };
    if (!invalid) {
      for (const p of declared.filter(x => x.in === 'path')) await check(p.schema, params[p.name], `${operationId} path parameter ${p.name}`);
      for (const p of declared.filter(x => x.in === 'query' && query?.[x.name] !== undefined)) await check(p.schema, p.schema.type === 'integer' ? Number(query[p.name]) : query[p.name], `${operationId} query ${p.name}`);
      for (const p of declared.filter(x => x.in === 'header' && x.required)) assert.ok(Object.keys(requestHeaders).some(k => k.toLowerCase() === p.name.toLowerCase()), `${operationId}: required header ${p.name} was not sent`);
      for (const p of declared.filter(x => x.in === 'query' && x.required)) assert.ok(query?.[p.name] !== undefined, `${operationId}: required query ${p.name} was not sent`);
      const bodySpec = deref(op.requestBody);
      if (bodySpec?.required) assert.ok(body !== undefined || rawBody !== undefined, `${operationId}: the description requires a request body`);
      if (body !== undefined && bodySpec?.content?.['application/json']) await check(bodySpec.content['application/json'].schema, body, `${operationId} request body`);
    }
    const result = await rawCall(as, method, path, { csrf, body, rawBody, headers: requestHeaders });
    // --- the response
    const documented = op.responses[String(result.status)] ?? op.responses.default;
    assert.ok(documented, `${operationId} returned ${result.status} (${result.json?.code ?? result.text.slice(0, 80)}), which the description does not list`);
    const response = deref(documented);
    assert.ok(UUID.test(result.headers.get('x-correlation-id') ?? ''), `${operationId} ${result.status}: x-correlation-id header is missing`);
    if (result.status === 204) assert.equal(result.text, '', 'a 204 has no body');
    else if (response.content) {
      const media = Object.keys(response.content).find(type => (result.headers.get('content-type') ?? '').startsWith(type));
      assert.ok(media, `${operationId} ${result.status}: content-type ${result.headers.get('content-type')} is not one of ${Object.keys(response.content)}`);
      if (media === 'application/json') await check(response.content[media].schema, result.json, `${operationId} ${result.status} response`);
    }
    for (const [name] of Object.entries(response.headers ?? {})) if (result.status < 300) assert.ok(result.headers.has(name.toLowerCase()), `${operationId} ${result.status}: documented header ${name} is missing`);
    if (!seen.has(operationId)) seen.set(operationId, new Set());
    seen.get(operationId).add(result.status);
    if (expect !== undefined) assert.equal(result.status, expect, `${operationId}: expected ${expect}, got ${result.status} ${result.json?.code ?? ''} ${result.json?.detail ?? ''}`);
    if (expect >= 400) assert.match(result.json.code, /^NUV_/);
    return result;
  }
  const codeOf = result => result.json?.code;

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-contract-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_UPGRADE_SHARED_DIR: join(workDir, 'upgrades'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sessions.admin = await login('admin');
    assert.equal(sessions.admin.user.roles[0], 'platform_admin');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  // ---- platform ----
  test('getHealth, getReadiness: public, no sign-in', async () => {
    await call('getHealth', { as: null, expect: 200 });
    await call('getReadiness', { as: null, expect: 200 });
  });

  test('every response carries the correlation id the caller sent', async () => {
    const id = randomUUID();
    const result = await rawCall(null, 'GET', '/api/v1/health', { headers: { 'x-correlation-id': id } });
    assert.equal(result.headers.get('x-correlation-id'), id);
    assert.equal(result.json.correlationId, id);
  });

  // ---- authentication ----
  test('login: 200 sets the session cookie; 401 for a wrong password; 429 after repeated failures', async () => {
    const ok = await call('login', { as: null, body: { username: 'admin', password: PASSWORD }, expect: 200 });
    assert.match(ok.headers.get('set-cookie'), /nuvrion_session=.*HttpOnly/);
    await call('login', { as: null, body: { username: 'admin', password: 'wrong' }, expect: 401 });
    let last;
    for (let i = 0; i < 6; i++) last = await call('login', { as: null, body: { username: 'throttled-user', password: `wrong-${i}` } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  test('signup, resetPassword: a new account is pending, and its recovery code resets the password once', async () => {
    const created = await call('signup', { as: null, body: { username: 'newbie', displayName: 'New Bie', password: PASSWORD }, expect: 201 });
    ctx.newbie = created.json.user;
    assert.equal(ctx.newbie.status, 'pending');
    await call('signup', { as: null, body: { username: 'newbie', displayName: 'Again', password: PASSWORD }, expect: 409 });
    // 422 (NUV_SIGNUP_INVALID) for a too-short password is documented, but this server mode (signup is a lab-recovery feature) allows weak passwords, so it cannot be provoked here.
    await call('resetPassword', { as: null, body: { username: 'newbie', recoveryCode: 'wrong-code', newPassword: PASSWORD }, expect: 401 });
    await call('resetPassword', { as: null, body: { username: 'newbie', recoveryCode: created.json.recoveryCode, newPassword: 'Another-Password-2!' }, expect: 200 }); // secret-scan:allow (fake test credential)
  });

  test('getCurrentUser, listOwnSessions', async () => {
    const me = await call('getCurrentUser', { expect: 200 });
    assert.equal(me.json.user.username, 'admin');
    await call('getCurrentUser', { as: null, expect: 401 });
    const list = await call('listOwnSessions', { expect: 200 });
    assert.ok(list.json.items.some(s => s.current));
  });

  test('revokeOwnSession, logout, rotateOwnRecoveryCode', async () => {
    sessions.second = await login('admin');
    const listed = await call('listOwnSessions', { expect: 200 });
    const other = listed.json.items.find(s => !s.current);
    assert.ok(other, 'a second session exists');
    const revoked = await call('revokeOwnSession', { params: { sessionId: other.id }, expect: 200 });
    assert.equal(revoked.json.revoked, 1);
    await call('revokeOwnSession', { params: { sessionId: 'f'.repeat(64) }, expect: 404 });
    sessions.third = await login('admin');
    await call('logout', { as: 'third', expect: 204 });
    await call('rotateOwnRecoveryCode', { expect: 200 });
    await call('rotateOwnRecoveryCode', { as: null, expect: 401 });
  });

  // ---- users ----
  test('listUsers, updateUser, revokeUserSessions, rotateUserRecoveryCode', async () => {
    const users = await call('listUsers', { expect: 200 });
    const admin = users.json.items.find(u => u.username === 'admin');
    const newbie = users.json.items.find(u => u.id === ctx.newbie.id);
    await call('updateUser', { params: { userId: newbie.id }, headers: { 'if-match': `"${newbie.rowVersion + 9}"` }, body: { status: 'active', roles: ['operator'] }, expect: 412 });
    await call('updateUser', { params: { userId: newbie.id }, body: { status: 'active', roles: ['operator'] }, headers: { 'if-match': `"${newbie.rowVersion}"` }, expect: 200 });
    ctx.operatorUser = (await call('listUsers', { expect: 200 })).json.items.find(u => u.id === newbie.id);
    await call('updateUser', { params: { userId: newbie.id }, body: { status: 'active', roles: ['operator'] }, headers: {}, invalid: true, expect: 428 });
    await call('updateUser', { params: { userId: ABSENT }, body: { status: 'active', roles: ['operator'] }, headers: { 'if-match': '"1"' }, expect: 404 });
    await call('updateUser', { params: { userId: admin.id }, body: { status: 'active', roles: ['operator'] }, headers: { 'if-match': `"${admin.rowVersion}"` }, expect: 409 });
    await call('updateUser', { params: { userId: newbie.id }, body: { status: 'active', roles: ['root'] }, headers: { 'if-match': `"${ctx.operatorUser.rowVersion}"` }, invalid: true, expect: 422 });
    assert.equal((await call('revokeUserSessions', { params: { userId: newbie.id }, expect: 200 })).json.revoked, 0);
    await call('rotateUserRecoveryCode', { params: { userId: newbie.id }, expect: 200 });
    await call('rotateUserRecoveryCode', { params: { userId: ABSENT }, expect: 404 });
    sessions.operator = await login('newbie', 'Another-Password-2!'); // secret-scan:allow (fake test credential)
    assert.equal(sessions.operator.status, 200);
    assert.deepEqual(sessions.operator.user.roles, ['operator']);
  });

  test('an auditor account for the permission checks', async () => {
    const signup = await call('signup', { as: null, body: { username: 'auditor1', displayName: 'Auditor', password: PASSWORD }, expect: 201 });
    await call('updateUser', { params: { userId: signup.json.user.id }, body: { status: 'active', roles: ['auditor'] }, headers: { 'if-match': `"${signup.json.user.rowVersion}"` }, expect: 200 });
    sessions.auditor = await login('auditor1');
    assert.deepEqual(sessions.auditor.user.roles, ['auditor']);
  });

  // ---- platform (administrator) ----
  test('getPlatformMetrics, getPrometheusMetrics, getPlatformUpgrade', async () => {
    await call('getPlatformMetrics', { expect: 200 });
    const prometheus = await call('getPrometheusMetrics', { expect: 200 });
    assert.match(prometheus.text, /^# HELP nuvrion_/m);
    await call('getPlatformUpgrade', { expect: 200 });
  });

  test('stagePlatformUpgrade, startPlatformUpgrade', async () => {
    const zip = Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]);
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const staged = await call('stagePlatformUpgrade', { query: { sha256 }, headers: { 'content-type': 'application/zip', 'x-nuvrion-file-name': 'release.zip' }, rawBody: zip, expect: 201 });
    assert.equal(staged.json.sha256, sha256);
    await call('stagePlatformUpgrade', { query: { sha256 }, headers: { 'content-type': 'text/plain' }, rawBody: 'not a zip', expect: 415 });
    await call('startPlatformUpgrade', { body: { uploadId: 'unknown-upload' }, expect: 422 });
  });

  // ---- connections ----
  const mockConnection = (name, extra = {}) => ({ name, providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' }, ...extra });  // secret-scan:allow (fake test credential)

  test('createConnection, listConnections, getConnection', async () => {
    const created = await call('createConnection', { body: mockConnection('Contract lab'), expect: 201 });
    ctx.connection = created.json;
    assert.equal(created.headers.get('location'), `/api/v1/connections/${ctx.connection.id}`);
    assert.equal(JSON.stringify(created.json).includes('pass'), false, 'the credential is never returned');
    await call('createConnection', { body: { name: 'No credential', providerType: 'aws' }, invalid: true, expect: 422 });
    const listed = await call('listConnections', { expect: 200 });
    assert.ok(listed.json.items.some(c => c.id === ctx.connection.id));
    await call('getConnection', { params: { connectionId: ctx.connection.id }, expect: 200 });
    await call('getConnection', { params: { connectionId: ABSENT }, expect: 404 });
  });

  test('discoverConnectionResources, testProviderConnection, getConnectionDiagnostics', async () => {
    const discovered = await call('discoverConnectionResources', { params: { connectionId: ctx.connection.id }, expect: 200 });
    assert.ok(discovered.json.discovered > 0);
    await call('discoverConnectionResources', { params: { connectionId: ABSENT }, expect: 404 });
    await call('testProviderConnection', { params: { connectionId: ctx.connection.id }, expect: 200 });
    await call('testProviderConnection', { params: { connectionId: ABSENT }, expect: 404 });
    const diagnostics = await call('getConnectionDiagnostics', { params: { connectionId: ctx.connection.id }, query: { limit: '5' }, expect: 200 });
    assert.ok(diagnostics.json.items.length > 0);
    await call('getConnectionDiagnostics', { params: { connectionId: ABSENT }, expect: 404 });
  });

  test('updateConnection, replaceConnectionCredential', async () => {
    const id = ctx.connection.id;
    const updated = await call('updateConnection', { params: { connectionId: id }, body: { name: 'Contract lab (renamed)' }, expect: 200 });
    assert.equal(updated.json.name, 'Contract lab (renamed)');
    await call('updateConnection', { params: { connectionId: id }, body: { name: '' }, invalid: true, expect: 422 });
    await call('updateConnection', { params: { connectionId: ABSENT }, body: { name: 'x' }, expect: 404 });
    const version = updated.json.rowVersion, credential = { username: 'user', password: 'pass-2' }; // secret-scan:allow (fake test credential)
    await call('replaceConnectionCredential', { params: { connectionId: id }, body: { credential }, headers: { 'if-match': `"${version + 5}"` }, expect: 412 });
    await call('replaceConnectionCredential', { params: { connectionId: id }, body: { credential }, headers: {}, invalid: true, expect: 428 });
    await call('replaceConnectionCredential', { params: { connectionId: ABSENT }, body: { credential }, headers: { 'if-match': '"1"' }, expect: 404 });
    await call('replaceConnectionCredential', { params: { connectionId: id }, body: { credential }, headers: { 'if-match': `"${version}"` }, expect: 200 });
  });

  test('openEsxiHostClient, createHostTerminalSession', async () => {
    const esxi = await call('createConnection', { body: mockConnection('Contract ESXi', { connectionType: 'esxi', endpointUri: 'https://127.0.0.1:1', configuration: { adapter: 'mock', sshHostKeySha256: `SHA256:${'A'.repeat(43)}` } }), expect: 201 });
    ctx.esxi = esxi.json;
    const hostClient = await call('openEsxiHostClient', { params: { connectionId: ctx.esxi.id }, expect: 200 });
    assert.match(hostClient.json.url, /^https:\/\/127\.0\.0\.1:1\/ui$/);
    await call('openEsxiHostClient', { params: { connectionId: ctx.connection.id }, expect: 422 });
    await call('openEsxiHostClient', { params: { connectionId: ABSENT }, expect: 404 });
    const terminal = await call('createHostTerminalSession', { params: { connectionId: ctx.esxi.id }, body: { username: 'root', password: 'secret' }, expect: 201 });  // secret-scan:allow (fake test credential)
    assert.match(terminal.json.socketUrl, /^\/api\/v1\/terminal-sessions\/[0-9a-f-]{36}\/socket$/);
    await call('createHostTerminalSession', { params: { connectionId: ctx.esxi.id }, body: { username: '' }, invalid: true, expect: 422 });
    await call('createHostTerminalSession', { params: { connectionId: ABSENT }, body: { username: 'root', password: 'x' }, expect: 404 });
  });

  test('listConnectionAlerts, acknowledgeConnectionAlert: a failing connection raises an alert', async () => {
    const broken = await call('createConnection', { body: { ...mockConnection('Broken lab'), configuration: {} }, expect: 201 });
    ctx.broken = broken.json;
    await call('discoverConnectionResources', { params: { connectionId: ctx.broken.id }, expect: 503 });
    await call('testProviderConnection', { params: { connectionId: ctx.broken.id }, expect: 503 });
    const alerts = await call('listConnectionAlerts', { expect: 200 });
    const alert = alerts.json.items.find(a => a.connectionId === ctx.broken.id);
    assert.ok(alert, 'the failing connection raised an alert');
    await call('listConnectionAlerts', { query: { status: 'active', limit: '10' }, expect: 200 });
    const acknowledged = await call('acknowledgeConnectionAlert', { params: { alertId: alert.id }, expect: 200 });
    assert.equal(acknowledged.json.status, 'acknowledged');
    await call('acknowledgeConnectionAlert', { params: { alertId: ABSENT }, expect: 404 });
  });

  // ---- resources ----
  test('listResources, getLatestPerformance, getResource, getResourceMetrics', async () => {
    const all = await call('listResources', { expect: 200 });
    ctx.vm = all.json.items.find(r => r.connectionId === ctx.connection.id);
    assert.ok(ctx.vm, 'the discovered VM is listed');
    await call('listResources', { query: { connectionId: ctx.connection.id, resourceType: 'virtual_machine', lifecycleState: 'active', search: ctx.vm.name.slice(0, 4) }, expect: 200 });
    await call('getLatestPerformance', { expect: 200 });
    await call('getResource', { params: { resourceId: ctx.vm.id }, expect: 200 });
    await call('getResource', { params: { resourceId: ABSENT }, expect: 404 });
    const metrics = await call('getResourceMetrics', { params: { resourceId: ctx.vm.id }, query: { hours: '6', limit: '10' }, expect: 200 });
    assert.equal(metrics.json.hours, 6);
    await call('getResourceMetrics', { params: { resourceId: ABSENT }, expect: 404 });
  });

  test('getResourceSettings, updateResourceSettings', async () => {
    const settings = await call('getResourceSettings', { params: { resourceId: ctx.vm.id }, expect: 200 });
    assert.equal(settings.json.resource.id, ctx.vm.id);
    await call('getResourceSettings', { params: { resourceId: ABSENT }, expect: 404 });
    await call('updateResourceSettings', { params: { resourceId: ctx.vm.id }, body: { annotation: 'set by the contract test' }, expect: 200 });
    await call('updateResourceSettings', { params: { resourceId: ctx.vm.id }, body: { cpuCount: 0 }, invalid: true, expect: 422 });
    await call('updateResourceSettings', { params: { resourceId: ABSENT }, body: { annotation: 'x' }, expect: 404 });
  });

  test('listResourceSnapshots, createResourceSnapshot, revertResourceSnapshot, deleteResourceSnapshot', async () => {
    const id = ctx.vm.id;
    const created = await call('createResourceSnapshot', { params: { resourceId: id }, body: { name: 'contract snapshot', description: 'made by the contract test' }, expect: 201 });
    const snapshotId = created.json.snapshot.id;
    await call('createResourceSnapshot', { params: { resourceId: id }, body: { description: 'no name' }, invalid: true, expect: 422 });
    await call('createResourceSnapshot', { params: { resourceId: ABSENT }, body: { name: 'x' }, expect: 404 });
    const listed = await call('listResourceSnapshots', { params: { resourceId: id }, expect: 200 });
    assert.ok(listed.json.items.some(s => s.id === snapshotId));
    await call('listResourceSnapshots', { params: { resourceId: ABSENT }, expect: 404 });
    await call('revertResourceSnapshot', { params: { resourceId: id, snapshotId }, expect: 200 });
    await call('revertResourceSnapshot', { params: { resourceId: ABSENT, snapshotId }, expect: 404 });
    await call('deleteResourceSnapshot', { params: { resourceId: id, snapshotId }, expect: 200 });
    await call('deleteResourceSnapshot', { params: { resourceId: ABSENT, snapshotId }, expect: 404 });
  });

  test('getResourceMedia, mountResourceMedia, ejectResourceMedia, browseResourceMedia', async () => {
    const id = ctx.vm.id;
    const media = await call('getResourceMedia', { params: { resourceId: id }, expect: 200 });
    const driveId = media.json.drives[0].id;
    await call('getResourceMedia', { params: { resourceId: ABSENT }, expect: 404 });
    const mounted = await call('mountResourceMedia', { params: { resourceId: id }, body: { driveId, isoPath: '[datastore1] contract.iso' }, expect: 200 });
    assert.equal(mounted.json.drive.media, '[datastore1] contract.iso');
    await call('mountResourceMedia', { params: { resourceId: id }, body: { driveId }, invalid: true, expect: 422 });
    await call('mountResourceMedia', { params: { resourceId: ABSENT }, body: { driveId, isoPath: 'x.iso' }, expect: 404 });
    const ejected = await call('ejectResourceMedia', { params: { resourceId: id, driveId }, expect: 200 });
    assert.equal(ejected.json.drive.media, null);
    await call('ejectResourceMedia', { params: { resourceId: ABSENT, driveId }, expect: 404 });
    await call('browseResourceMedia', { params: { resourceId: id }, expect: 422 });   // host-drive browsing is for Workstation VMs
    await call('browseResourceMedia', { params: { resourceId: ABSENT }, expect: 404 });
  });

  test('createConsoleSession: documented errors for a VM whose provider has no console', async () => {
    await call('createConsoleSession', { params: { resourceId: ctx.vm.id }, expect: 422 });
    await call('createConsoleSession', { params: { resourceId: ABSENT }, expect: 404 });
  });

  test('createResourceOperation: accepted, repeated with the same key, and the documented refusals', async () => {
    const id = ctx.vm.id, key = `contract-${randomUUID()}`;
    const stopped = await call('createResourceOperation', { params: { resourceId: id }, headers: { 'idempotency-key': key }, body: { operation: 'stop' }, expect: 202 });
    ctx.task = stopped.json;
    const again = await call('createResourceOperation', { params: { resourceId: id }, headers: { 'idempotency-key': key }, body: { operation: 'stop' }, expect: 200 });
    assert.equal(again.json.id, ctx.task.id, 'the same key returns the same task');
    await call('createResourceOperation', { params: { resourceId: id }, headers: {}, body: { operation: 'stop' }, invalid: true, expect: 400 });
    await call('createResourceOperation', { params: { resourceId: ABSENT }, headers: { 'idempotency-key': `contract-${randomUUID()}` }, body: { operation: 'stop' }, expect: 404 });
    await call('createResourceOperation', { params: { resourceId: id }, headers: { 'idempotency-key': `contract-${randomUUID()}` }, body: { operation: 'explode' }, invalid: true, expect: 422 });
    const other = (await call('listResources', { expect: 200 })).json.items.find(r => r.id !== id && r.connectionId === ctx.connection.id);
    if (other) await call('createResourceOperation', { params: { resourceId: other.id }, headers: { 'idempotency-key': key }, body: { operation: 'stop' }, expect: 409 });  // the key belongs to another target
  });

  // ---- tasks ----
  test('listTasks, getTask, and the documented refusals of cancelTask, retryTask, reconcileTask', async () => {
    const listed = await call('listTasks', { expect: 200 });
    assert.ok(listed.json.items.some(t => t.id === ctx.task.id));
    let task;   // the in-process worker finishes the task shortly after it is accepted
    for (let attempt = 0; attempt < 50; attempt++) {
      task = await call('getTask', { params: { taskId: ctx.task.id }, expect: 200 });
      if (task.json.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(task.json.status, 'completed');
    assert.ok(task.json.attempts.length >= 1);
    await call('getTask', { params: { taskId: ABSENT }, expect: 404 });
    for (const operationId of ['cancelTask', 'retryTask']) {
      await call(operationId, { params: { taskId: ctx.task.id }, expect: 409 });      // a finished task cannot be cancelled or retried
      await call(operationId, { params: { taskId: ABSENT }, expect: 404 });
    }
    await call('reconcileTask', { params: { taskId: ctx.task.id }, expect: 409 });
    await call('reconcileTask', { params: { taskId: ABSENT }, expect: 404 });
  });

  test('createMockOperation', async () => {
    const key = `mock-${randomUUID()}`;
    const created = await call('createMockOperation', { headers: { 'idempotency-key': key }, body: { operation: 'start' }, expect: 201 });
    assert.equal(created.headers.get('location'), `/api/v1/tasks/${created.json.id}`);
    assert.equal((await call('createMockOperation', { headers: { 'idempotency-key': key }, body: { operation: 'start' }, expect: 200 })).json.id, created.json.id);
    await call('createMockOperation', { headers: {}, body: { operation: 'start' }, invalid: true, expect: 400 });
    await call('createMockOperation', { headers: { 'idempotency-key': `mock-${randomUUID()}` }, body: { operation: 'explode' }, invalid: true, expect: 422 });
  });

  // ---- audit ----
  test('listAuditEvents: paging and filters, and an operator is refused', async () => {
    const page = await call('listAuditEvents', { query: { limit: '2', offset: '0' }, expect: 200 });
    assert.equal(page.json.items.length, 2);
    assert.ok(page.json.count > 2);
    assert.equal(page.json.nextCursor, '2');
    await call('listAuditEvents', { query: { action: 'identity.login', outcome: 'failed' }, expect: 200 });
    await call('listAuditEvents', { query: { search: 'admin' }, expect: 200 });
    await call('listAuditEvents', { as: 'operator', expect: 403 });
    await call('listAuditEvents', { as: 'auditor', expect: 200 });
  });

  // ---- agents ----
  test('createAgentEnrollmentToken, enrollAgent, listAgents, agentHeartbeat', async () => {
    const token = await call('createAgentEnrollmentToken', { expect: 201 });
    const enrolled = await call('enrollAgent', { as: null, body: { token: token.json.token, name: 'contract agent', version: '0.1.46' }, expect: 201 });
    ctx.agent = { id: enrolled.json.agentId, secret: enrolled.json.secret };
    await call('enrollAgent', { as: null, body: { token: token.json.token, name: 'replay' }, expect: 401 });   // a token works once
    const listed = await call('listAgents', { expect: 200 });
    const agent = listed.json.items.find(a => a.id === ctx.agent.id);
    assert.ok(agent);
    assert.equal(JSON.stringify(listed.json).includes(ctx.agent.secret), false, 'the secret is never listed');
    await call('agentHeartbeat', { as: null, params: { agentId: ctx.agent.id }, agent: ctx.agent.secret, body: { version: '0.1.46', inventory: [], diagnostics: null }, expect: 200 });
    await call('agentHeartbeat', { as: null, params: { agentId: ctx.agent.id }, agent: 'wrong-secret', body: {}, expect: 401 });
  });

  test('createAgentCommand, listAgentPendingCommands, acknowledgeAgentCommand', async () => {
    const { id, secret } = ctx.agent;
    const queued = await call('createAgentCommand', { params: { agentId: id }, body: { operation: 'start', targetId: 'C:\\VMs\\lab\\lab.vmx' }, expect: 201 });
    assert.ok(queued.json.signature);
    await call('createAgentCommand', { params: { agentId: ABSENT }, body: { operation: 'start' }, expect: 404 });
    await call('createAgentCommand', { params: { agentId: id }, body: { operation: 'format_disk' }, invalid: true, expect: 422 });
    const pending = await call('listAgentPendingCommands', { as: null, params: { agentId: id }, agent: secret, expect: 200 });
    assert.equal(pending.json.items[0].payload.commandId, queued.json.payload.commandId);
    await call('listAgentPendingCommands', { as: null, params: { agentId: id }, agent: 'wrong', expect: 401 });
    const commandId = queued.json.payload.commandId;
    await call('acknowledgeAgentCommand', { as: null, params: { agentId: id, commandId }, agent: secret, body: { status: 'bogus' }, invalid: true, expect: 422 });
    const acknowledged = await call('acknowledgeAgentCommand', { as: null, params: { agentId: id, commandId }, agent: secret, body: { status: 'completed', result: { ok: true } }, expect: 200 });
    assert.equal(acknowledged.json.status, 'completed');
    await call('acknowledgeAgentCommand', { as: null, params: { agentId: id, commandId }, agent: secret, body: { status: 'completed' }, expect: 422 });   // a second result is refused (replay)
    await call('acknowledgeAgentCommand', { as: null, params: { agentId: id, commandId }, agent: 'wrong', body: { status: 'completed' }, expect: 401 });
  });

  test('registerAgentRelease, stageAgentUpgrade, listAgentPendingUpgrades, reportAgentUpgrade', async () => {
    const release = await call('registerAgentRelease', { body: { version: '0.1.47', artifactUrl: 'https://example.invalid/agent.nuvpkg', sha256: 'a'.repeat(64), sizeBytes: 1024 }, expect: 201 });
    await call('registerAgentRelease', { body: { version: '0.1.48', artifactUrl: 'http://example.invalid/agent.nuvpkg', sha256: 'a'.repeat(64), sizeBytes: 1024 }, invalid: true, expect: 422 });
    const staged = await call('stageAgentUpgrade', { params: { agentId: ctx.agent.id }, body: { releaseId: release.json.manifest.releaseId }, expect: 201 });
    await call('stageAgentUpgrade', { params: { agentId: ABSENT }, body: { releaseId: release.json.manifest.releaseId }, expect: 404 });
    const pending = await call('listAgentPendingUpgrades', { as: null, params: { agentId: ctx.agent.id }, agent: ctx.agent.secret, expect: 200 });
    assert.ok(pending.json.items.some(u => u.deploymentId === staged.json.deploymentId));
    await call('listAgentPendingUpgrades', { as: null, params: { agentId: ctx.agent.id }, agent: 'wrong', expect: 401 });
    await call('reportAgentUpgrade', { as: null, params: { agentId: ctx.agent.id, deploymentId: staged.json.deploymentId }, agent: ctx.agent.secret, body: { status: 'downloading' }, expect: 200 });
    await call('reportAgentUpgrade', { as: null, params: { agentId: ctx.agent.id, deploymentId: staged.json.deploymentId }, agent: ctx.agent.secret, body: { status: 'exploded' }, invalid: true, expect: 422 });
    await call('reportAgentUpgrade', { as: null, params: { agentId: ctx.agent.id, deploymentId: ABSENT }, agent: ctx.agent.secret, body: { status: 'installed' }, expect: 422 });
    await call('reportAgentUpgrade', { as: null, params: { agentId: ctx.agent.id, deploymentId: staged.json.deploymentId }, agent: 'wrong', body: { status: 'installed' }, expect: 401 });
  });

  test('sweepAgents, rotateAgentSecret, revokeAgent', async () => {
    await call('sweepAgents', { expect: 200 });
    await call('sweepAgents', { body: { offlineAfterMs: 1000 }, expect: 200 });
    const rotated = await call('rotateAgentSecret', { params: { agentId: ctx.agent.id }, expect: 200 });
    assert.notEqual(rotated.json.secret, ctx.agent.secret);
    await call('agentHeartbeat', { as: null, params: { agentId: ctx.agent.id }, agent: ctx.agent.secret, body: {}, expect: 401 });   // the old secret stopped working
    await call('rotateAgentSecret', { params: { agentId: ABSENT }, expect: 404 });
    const revoked = await call('revokeAgent', { params: { agentId: ctx.agent.id }, body: { reason: 'contract test' }, expect: 200 });
    assert.equal(revoked.json.status, 'revoked');
    await call('revokeAgent', { params: { agentId: ABSENT }, expect: 404 });
  });

  // ---- connection removal last, so the earlier tests could use the connections ----
  test('deleteConnection', async () => {
    await call('deleteConnection', { params: { connectionId: ctx.broken.id }, expect: 200 });
    await call('deleteConnection', { params: { connectionId: ctx.broken.id }, expect: 404 });
    await call('getConnection', { params: { connectionId: ctx.broken.id }, expect: 404 });
  });

  // ---- cross-cutting ----
  test('anonymous callers are refused with 401 wherever the description asks for a session', async () => {
    for (const { id, op, path, method } of operations.values()) {
      const security = op.security ?? spec.security;
      if (!security.some(s => 'sessionCookie' in s)) continue;
      const params = Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map(m => [m[1], m[1] === 'sessionId' ? 'f'.repeat(64) : m[1] === 'snapshotId' || m[1] === 'driveId' ? 'x' : ABSENT]));
      const result = await call(id, { as: null, params, invalid: true });
      assert.equal(result.status, 401, `${method} ${path} must refuse anonymous callers`);
      assert.equal(codeOf(result), 'NUV_AUTH_REQUIRED');
    }
  });

  test('the permission each operation names is the permission the server enforces', async () => {
    const permissionsOf = who => new Set(sessions[who].user.permissions);
    const checked = new Set();
    for (const { id, op, path } of operations.values()) {
      const required = op['x-required-permission'];
      if (!required) continue;
      const params = Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map(m => [m[1], m[1] === 'snapshotId' || m[1] === 'driveId' ? 'x' : ABSENT]));
      for (const who of ['operator', 'auditor']) {
        const allowed = permissionsOf(who).has(required);
        // A wrong CSRF token stops a permitted state-changing call before anything runs; a refused role is stopped earlier by permission.
        const result = await call(id, { as: who, params, csrf: 'wrong', invalid: true });
        if (!allowed) { assert.equal(result.status, 403, `${id} must refuse ${who} (needs ${required})`); assert.equal(codeOf(result), 'NUV_PERMISSION_DENIED', `${id} ${who}`); }
        else assert.notEqual(codeOf(result), 'NUV_PERMISSION_DENIED', `${id} must let ${who} in (has ${required})`);
        checked.add(`${id}:${who}`);
      }
    }
    assert.ok(checked.size > 80, `only ${checked.size} permission checks ran`);
  });

  test('agent operations refuse a user session and a wrong agent secret', async () => {
    for (const { id, op, path, method } of operations.values()) {
      if (!(op.security ?? []).some(s => 'agentSecret' in s)) continue;
      const params = Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map(m => [m[1], ABSENT]));
      for (const [as, agent] of [[null, 'wrong-secret'], [null, undefined], ['admin', undefined]]) {
        const result = await call(id, { as, agent, params, body: method === 'GET' ? undefined : {}, invalid: true });
        assert.ok([401, 403, 404].includes(result.status) && result.status !== 200, `${id} (${as ?? 'anonymous'}, ${agent ?? 'no secret'}) returned ${result.status}`);
      }
    }
  });

  test('every documented operation was called successfully, except the few that need a real provider', () => {
    const NEEDS_A_REAL_PROVIDER = {
      browseResourceMedia: 'host-drive browsing needs a VMware Workstation agent',
      createConsoleSession: 'needs a running VM on a provider with a console',
      startPlatformUpgrade: 'needs the host-side update helper',
      cancelTask: 'needs a task that is still queued when the request arrives; the in-process worker finishes tasks at once',
      retryTask: 'needs a failed task',
      reconcileTask: 'needs a verification-required task'
    };
    const unexercised = [];
    for (const { id, op } of operations.values()) {
      const success = Object.keys(op.responses).filter(s => s.startsWith('2')).map(Number);
      const statuses = seen.get(id) ?? new Set();
      if (!success.some(s => statuses.has(s)) && !NEEDS_A_REAL_PROVIDER[id]) unexercised.push(id);
    }
    assert.deepEqual(unexercised, [], 'operations that never returned a documented success');
    for (const id of Object.keys(NEEDS_A_REAL_PROVIDER)) assert.ok(operations.has(id), `${id} is listed here but not in the description`);
  });

  test('every error status in the description that a test could cause was seen at least once for the common cases', () => {
    const statuses = new Set([...seen.values()].flatMap(s => [...s]));
    for (const expected of [200, 201, 202, 204, 400, 401, 403, 404, 409, 412, 415, 422, 428, 429, 503]) assert.ok(statuses.has(expected), `no test produced a ${expected}`);
  });
});

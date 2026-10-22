import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Threshold alerts and the notification centre over the real HTTP API (in-memory services, the mock provider): the lab estate has a VM at 18.5% CPU, one at 0%, and a datastore
// that is 90% full, so rules about them fire deterministically. Who may do what, what a rule must look like, the alert's life, the feed and who has read it.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Alerts-Test-Password-1!'; // secret-scan:allow (fake test credential)

describe('threshold alerts over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir, connectionId; const sessions = {};

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
  const rule = (over = {}) => ({ name: 'Busy VMs', metric: 'vm.cpu_percent', comparison: 'above', threshold: 10, severity: 'warning', ...over });
  const create = (body, who = 'admin') => call(who, 'POST', '/api/v1/alert-rules', { body });
  const evaluate = () => call('admin', 'POST', '/api/v1/alerts/evaluate');
  const rules = async () => (await call('admin', 'GET', '/api/v1/alert-rules')).json.items;

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-alerts-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD, NUVRION_ALERT_INTERVAL_MS: '3600000' });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await login('admin')).status, 200);
    const created = await call('admin', 'POST', '/api/v1/connections', { body: { name: 'Alerts lab', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' } } }); // secret-scan:allow (fake test credential)
    connectionId = created.json.id;
    assert.equal((await call('admin', 'POST', `/api/v1/connections/${connectionId}/discover`)).status, 200);
    await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('the metrics a rule can use are listed with what they measure and their units', async () => {
    const metrics = (await call('operator1', 'GET', '/api/v1/alert-metrics')).json.items;
    assert.deepEqual(metrics.map(metric => metric.key).sort(), ['datastore.days_until_full', 'datastore.free_gb', 'datastore.used_percent', 'host.cpu_percent', 'host.memory_percent', 'vm.cpu_percent', 'vm.memory_percent']);
    assert.deepEqual(metrics.find(metric => metric.key === 'datastore.free_gb'), { key: 'datastore.free_gb', kind: 'datastore', label: 'Datastore free space', unit: 'GB', max: 10000000 });
  });

  test('only people with alert.manage change rules; everyone who can view resources can read them; every change is audited', async () => {
    for (const who of ['operator1', 'auditor1']) {
      const refused = await create(rule({ name: `Refused ${who}` }), who);
      assert.deepEqual([refused.status, refused.code], [403, 'NUV_PERMISSION_DENIED'], who);
    }
    const made = await create(rule());
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.name, made.json.summary, made.json.rowVersion, made.json.openAlertCount], ['Busy VMs', 'Virtual machine CPU use above 10%', 1, 0]);
    for (const who of ['operator1', 'auditor1']) assert.deepEqual((await call(who, 'GET', '/api/v1/alert-rules')).json.items.map(item => item.name), ['Busy VMs'], who);
    assert.equal((await call('admin', 'POST', '/api/v1/alert-rules', { body: rule({ name: 'Bad CSRF' }), csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    const audit = await call('admin', 'GET', '/api/v1/audit-events?limit=200&search=alert.rule');
    assert.ok((audit.json.items ?? []).some(event => event.action === 'alert.rule_created'));
  });

  test('a rule is judged by the rules: metric, comparison, severity, threshold range, duration, name, connection, unknown fields, duplicates', async () => {
    const cases = [
      [rule({ metric: 'vm.disk' }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ comparison: 'equal' }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ severity: 'urgent' }), 422, 'NUV_ALERT_RULE_INVALID'],
      [rule({ threshold: 101 }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ threshold: '10' }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ threshold: -1 }), 422, 'NUV_ALERT_RULE_INVALID'],
      [rule({ durationMinutes: 1.5 }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ durationMinutes: 2000 }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ name: '  ' }), 422, 'NUV_ALERT_RULE_INVALID'],
      [rule({ connectionId: 'nope' }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ connectionId: '00000000-0000-4000-8000-0000000000aa' }), 422, 'NUV_ALERT_RULE_INVALID'], [rule({ extra: true }), 422, 'NUV_ALERT_RULE_INVALID'],
      [rule({ name: 'busy vms' }), 409, 'NUV_ALERT_RULE_EXISTS']
    ];
    for (const [body, status, code] of cases) {
      const result = await create(body);
      assert.deepEqual([result.status, result.code], [status, code], JSON.stringify(body).slice(0, 90));
    }
    const scoped = await create(rule({ name: 'One connection', connectionId }));
    assert.deepEqual([scoped.status, scoped.json.connectionId], [201, connectionId], 'a rule may name a connection that exists');
    assert.equal((await call('admin', 'DELETE', `/api/v1/alert-rules/${scoped.json.id}`)).status, 200);
    for (const body of [null, [], 'x']) assert.equal((await call('admin', 'POST', '/api/v1/alert-rules', { body })).code, 'NUV_ALERT_RULE_INVALID');
  });

  test('evaluating fires the alert for the VM over the threshold, once, and the bell shows it as news until it is read', async () => {
    const summary = await evaluate();
    assert.equal(summary.status, 200, summary.text);
    assert.deepEqual([summary.json.fired, summary.json.resolved, summary.json.rules], [1, 0, 1]);
    assert.equal((await evaluate()).json.fired, 0, 'a second evaluation raises nothing new');
    const alerts = (await call('auditor1', 'GET', '/api/v1/alerts')).json;
    assert.deepEqual([alerts.items.length, alerts.openCount, alerts.criticalCount], [1, 1, 0]);
    assert.deepEqual([alerts.items[0].targetName, alerts.items[0].value, alerts.items[0].status, alerts.items[0].ruleName], ['nuvrion-app-01', 18.5, 'active', 'Busy VMs']);
    const feed = (await call('auditor1', 'GET', '/api/v1/notifications')).json;
    assert.deepEqual([feed.unreadCount, feed.items[0].kind, feed.items[0].title, feed.items[0].source, feed.items[0].detail], [1, 'fired', 'nuvrion-app-01', 'threshold', 'Busy VMs: 18.5%']);
    assert.equal((await call('auditor1', 'POST', '/api/v1/notifications/read', { body: {} })).status, 200);
    assert.equal((await call('auditor1', 'GET', '/api/v1/notifications')).json.unreadCount, 0, 'read');
    assert.equal((await call('operator1', 'GET', '/api/v1/notifications')).json.unreadCount, 1, 'reading is per person');
  });

  test('acknowledging needs resource.operate, keeps the alert open, and is audited; a rule edit that stops matching resolves the alert and the recovery is news', async () => {
    const [alert] = (await call('admin', 'GET', '/api/v1/alerts')).json.items;
    const refused = await call('auditor1', 'POST', `/api/v1/alerts/${alert.id}/acknowledge`);
    assert.deepEqual([refused.status, refused.code], [403, 'NUV_PERMISSION_DENIED']);
    const acknowledged = await call('operator1', 'POST', `/api/v1/alerts/${alert.id}/acknowledge`);
    assert.deepEqual([acknowledged.status, acknowledged.json.status], [200, 'acknowledged']);
    assert.equal((await call('admin', 'GET', '/api/v1/alerts?status=acknowledged')).json.items.length, 1);
    assert.equal((await call('admin', 'GET', '/api/v1/alerts?status=open')).json.openCount, 1);
    assert.equal((await call('admin', 'POST', `/api/v1/alerts/00000000-0000-4000-8000-0000000000aa/acknowledge`)).status, 404);
    const [busy] = await rules();
    const raised = await call('admin', 'PATCH', `/api/v1/alert-rules/${busy.id}`, { body: { threshold: 50 }, version: busy.rowVersion });
    assert.deepEqual([raised.status, raised.json.threshold, raised.json.rowVersion, raised.json.summary], [200, 50, 2, 'Virtual machine CPU use above 50%']);
    assert.equal((await evaluate()).json.resolved, 1);
    assert.deepEqual((await call('admin', 'GET', '/api/v1/alerts')).json.items, []);
    const history = (await call('admin', 'GET', '/api/v1/alerts?status=resolved')).json.items;
    assert.deepEqual([history.length, history[0].resolvedReason, history[0].status], [1, 'cleared', 'resolved']);
    assert.equal((await call('admin', 'POST', `/api/v1/alerts/${alert.id}/acknowledge`)).code, 'NUV_ALERT_RESOLVED');
    const feed = (await call('auditor1', 'GET', '/api/v1/notifications')).json;
    assert.deepEqual([feed.items[0].kind, feed.unreadCount], ['resolved', 1], 'the recovery is news to someone who had read the firing');
    assert.equal((await call('admin', 'GET', '/api/v1/alerts?status=sleeping')).code, 'NUV_ALERT_QUERY_INVALID');
    const actions = new Set(((await call('admin', 'GET', '/api/v1/audit-events?limit=300&search=alert.')).json.items ?? []).map(event => event.action));
    for (const action of ['alert.acknowledged', 'alert.rule_updated']) assert.ok(actions.has(action), action);
  });

  test('a change needs the current version; a stale one, a missing one and an unknown rule are refused; a name taken by another rule is refused', async () => {
    const [busy] = await rules(), other = await create(rule({ name: 'Other' }));
    assert.equal((await call('admin', 'PATCH', `/api/v1/alert-rules/${busy.id}`, { body: { threshold: 60 }, version: 1 })).status, 412);
    assert.equal((await call('admin', 'PATCH', `/api/v1/alert-rules/${busy.id}`, { body: { threshold: 60 } })).status, 428);
    assert.equal((await call('admin', 'PATCH', '/api/v1/alert-rules/00000000-0000-4000-8000-0000000000aa', { body: { threshold: 60 }, version: 1 })).status, 404);
    assert.equal((await call('admin', 'PATCH', `/api/v1/alert-rules/${other.json.id}`, { body: { name: 'BUSY vms' }, version: 1 })).code, 'NUV_ALERT_RULE_EXISTS');
    assert.equal((await call('admin', 'PATCH', `/api/v1/alert-rules/${other.json.id}`, { body: { threshold: 500 }, version: 1 })).code, 'NUV_ALERT_RULE_INVALID');
    assert.equal((await call('admin', 'PATCH', `/api/v1/alert-rules/${other.json.id}`, { body: {}, version: 1 })).code, 'NUV_ALERT_RULE_INVALID');
    assert.equal((await call('admin', 'DELETE', `/api/v1/alert-rules/${other.json.id}`)).status, 200);
  });

  test('a datastore rule fires for the 90%-full datastore, a preview says what a rule would match without raising anything, and deleting a rule resolves what it raised', async () => {
    const preview = await call('admin', 'POST', '/api/v1/alert-rules/preview', { body: rule({ name: 'Preview', metric: 'datastore.used_percent', threshold: 85 }) });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.json.summary, preview.json.evaluated, preview.json.matches.map(match => [match.name, Math.round(match.value)])], ['Datastore space used above 85%', 2, [['datastore2', 90]]]);
    assert.equal((await call('admin', 'GET', '/api/v1/alerts')).json.items.length, 0, 'a preview raises nothing');
    assert.equal((await call('admin', 'POST', '/api/v1/alert-rules/preview', { body: rule({ metric: 'nope' }) })).code, 'NUV_ALERT_RULE_INVALID');
    const made = await create(rule({ name: 'Full datastores', metric: 'datastore.used_percent', threshold: 85, severity: 'critical', durationMinutes: 0 }));
    assert.equal((await evaluate()).json.fired, 1);
    const [alert] = (await call('admin', 'GET', '/api/v1/alerts')).json.items;
    assert.deepEqual([alert.targetKind, alert.targetName, alert.severity, Math.round(alert.value)], ['datastore', 'datastore2', 'critical', 90]);
    assert.equal((await call('admin', 'GET', '/api/v1/alerts')).json.criticalCount, 1);
    const lowSpace = await create(rule({ name: 'Low free space', metric: 'datastore.free_gb', comparison: 'below', threshold: 500 }));
    assert.equal((await evaluate()).json.fired, 1, 'datastore2 has about 102 GB free; datastore1 has more than 500');
    const deleted = await call('admin', 'DELETE', `/api/v1/alert-rules/${made.json.id}`);
    assert.deepEqual([deleted.status, deleted.json], [200, { deleted: 1, alertsResolved: 1 }]);
    assert.equal((await call('admin', 'DELETE', `/api/v1/alert-rules/${made.json.id}`)).status, 404);
    assert.deepEqual((await call('admin', 'GET', '/api/v1/alerts')).json.items.map(item => item.ruleName), ['Low free space']);
    assert.ok(lowSpace.json.id);
  });

  test('connection problems are in the bell for people who may see connections, and not for those who may not', async () => {
    const broken = await call('admin', 'POST', '/api/v1/connections', { body: { name: 'Broken ESXi', providerType: 'vmware_vsphere', connectionType: 'esxi', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' } } }); // secret-scan:allow (fake test credential)
    await call('admin', 'POST', `/api/v1/connections/${broken.json.id}/discover`);
    const feed = (await call('admin', 'GET', '/api/v1/notifications')).json;
    const own = feed.items.filter(event => event.source === 'connection');
    assert.ok(own.length >= 1, 'the failing connection is in the feed'); assert.equal(own[0].title, 'Broken ESXi'); assert.match(own[0].detail, /Connection is/);
    const role = await call('admin', 'POST', '/api/v1/roles', { body: { name: 'viewer_only', permissions: ['resource.view'] } });
    assert.equal(role.status, 201, role.text);
    await addUser('viewer1', 'viewer_only');
    const hidden = (await call('viewer1', 'GET', '/api/v1/notifications')).json;
    assert.equal(hidden.items.filter(event => event.source === 'connection').length, 0, 'without connection.view the connection’s trouble is not shown');
    assert.ok(hidden.items.some(event => event.source === 'threshold'));
  });
});

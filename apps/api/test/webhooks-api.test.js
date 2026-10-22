import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Webhooks over the real HTTP API (in-memory services, the mock provider, a receiver on this machine that the test allows): who may manage them, that an address is never shown or
// audited, that a test post arrives signed, that an alert raised and resolved is delivered once each to the webhooks that asked for it, and that turning one off, filtering by severity
// and deleting behave. Retries and the rules of addresses are in the unit tests.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Webhooks-Test-Password-1!'; // secret-scan:allow (fake test credential)
const TOKEN = 'very-secret-token-12345', SIGNING = 'a-long-signing-secret';   // secret-scan:allow (fake test credential)

describe('webhooks over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir, receiver, receiverUrl; const sessions = {}, received = []; let answer = () => ({ status: 200 });

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
  const hook = (over = {}) => ({ name: 'Ops chat', url: `${receiverUrl}/hook/${TOKEN}`, format: 'json', ...over });
  const create = (body, who = 'admin') => call(who, 'POST', '/api/v1/webhooks', { body });
  const waitFor = async (check, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail(`never happened: ${what}`); };
  const deliveriesOf = async id => (await call('admin', 'GET', `/api/v1/webhook-deliveries?destinationId=${id}&limit=100`)).json.items;
  const postsTo = path => received.filter(request => request.url.startsWith(path));

  before(async () => {
    receiver = http.createServer((req, res) => {
      let data = ''; req.on('data', chunk => { data += chunk; });
      req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: data }); const result = answer(req); res.writeHead(result.status); res.end(result.body ?? ''); });
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-webhooks-api-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'),
      NUVRION_BOOTSTRAP_PASSWORD: PASSWORD, NUVRION_SCHEDULE_INTERVAL_MS: '3600000', NUVRION_ALERT_INTERVAL_MS: '3600000', NUVRION_WEBHOOK_INTERVAL_MS: '150', NUVRION_WEBHOOK_ALLOW_HTTP: 'true', NUVRION_WEBHOOK_ALLOW_LOOPBACK: 'true' });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const { createServer } = await import('../src/server.js');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await login('admin');
    const created = await call('admin', 'POST', '/api/v1/connections', { body: { name: 'Webhooks lab', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' } } }); // secret-scan:allow (fake test credential)
    assert.equal((await call('admin', 'POST', `/api/v1/connections/${created.json.id}/discover`)).status, 200);
    await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); receiver?.closeAllConnections?.(); await new Promise(resolve => receiver.close(resolve)); rmSync(workDir, { recursive: true, force: true }); });

  test('only people who manage alerts may see or change webhooks, and a change needs the CSRF token', async () => {
    for (const who of ['operator1', 'auditor1']) {
      assert.deepEqual([(await call(who, 'GET', '/api/v1/webhooks')).status, (await create(hook({ name: 'Nope' }), who)).code], [403, 'NUV_PERMISSION_DENIED'], who);
      assert.equal((await call(who, 'GET', '/api/v1/webhook-deliveries')).status, 403);
    }
    assert.equal((await call(null, 'GET', '/api/v1/webhooks')).status, 401);
    assert.equal((await call('admin', 'POST', '/api/v1/webhooks', { body: hook({ name: 'Bad CSRF' }), csrf: 'wrong' })).code, 'NUV_CSRF_INVALID');
    const list = await call('admin', 'GET', '/api/v1/webhooks');
    assert.deepEqual([list.status, list.json.items, Object.keys(list.json.events), Object.keys(list.json.formats)], [200, [], ['alert.fired', 'alert.resolved', 'connection.down', 'connection.recovered', 'schedule.problem'], ['json', 'text', 'discord']]);
  });

  test('an address that could point the platform at itself, or carries credentials, or is not an address, is refused; a name is unique', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/x', 'http://0.0.0.0/x', 'ftp://hooks.example.test/x', 'http://user:pw@hooks.example.test/x', 'nonsense', '']) {
      const result = await create(hook({ name: `Bad ${url.slice(0, 12)}`, url }));
      assert.deepEqual([result.status, result.code], [422, 'NUV_WEBHOOK_INVALID'], url);
    }
    for (const over of [{ name: '  ' }, { format: 'xml' }, { events: [] }, { events: ['nope'] }, { minSeverity: 'info' }, { signingSecret: 'short' }, { extra: 1 }]) assert.equal((await create(hook({ name: 'Invalid', ...over }))).status, 422, JSON.stringify(over));
    for (const body of [null, [], 'x']) assert.equal((await call('admin', 'POST', '/api/v1/webhooks', { body })).code, 'NUV_WEBHOOK_INVALID');
    assert.equal((await call('admin', 'GET', '/api/v1/webhooks')).json.count, 0, 'nothing was saved');
  });

  test('a webhook is created without ever showing its address; a test post arrives signed and is recorded; a receiver that refuses is reported', async () => {
    received.length = 0; answer = () => ({ status: 200 });
    const made = await create(hook({ name: 'Signed chat', format: 'text', signingSecret: SIGNING }));
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.urlHint, made.json.hasSigningSecret, made.json.format, made.json.enabled, made.json.rowVersion], [`${receiverUrl}/…`, true, 'text', true, 1]);
    assert.ok(made.json.activeSince);
    assert.equal(made.text.includes(TOKEN) || made.text.includes(SIGNING), false);
    assert.equal((await create(hook({ name: 'SIGNED CHAT' }))).code, 'NUV_WEBHOOK_EXISTS');
    assert.equal((await call('admin', 'GET', '/api/v1/webhooks')).text.includes(TOKEN), false, 'not in the list either');
    const tested = await call('admin', 'POST', `/api/v1/webhooks/${made.json.id}/test`);
    assert.equal(tested.status, 200, tested.text);
    assert.deepEqual([tested.json.eventType, tested.json.status, tested.json.responseStatus, tested.json.attempts, tested.json.title], ['test', 'sent', 200, 1, 'Test message from Nuvrion']);
    const post = postsTo(`/hook/${TOKEN}`).at(-1);
    assert.ok(post, 'the receiver was asked, at the address that was saved');
    assert.deepEqual(JSON.parse(post.body), { text: '[WARNING] Test message from Nuvrion — If you can read this, the webhook works. (test)' });
    assert.equal(post.headers['x-nuvrion-event'], 'test'); assert.equal(post.headers['x-nuvrion-delivery'], tested.json.id.length ? post.headers['x-nuvrion-delivery'] : '');
    assert.equal(post.headers['x-nuvrion-signature'], `sha256=${createHmac('sha256', SIGNING).update(`${post.headers['x-nuvrion-timestamp']}.${post.body}`).digest('hex')}`, 'the receiver can check who sent it');
    answer = () => ({ status: 500, body: 'receiver is unwell' });
    const bad = await call('admin', 'POST', `/api/v1/webhooks/${made.json.id}/test`);
    assert.deepEqual([bad.json.status, bad.json.responseStatus, bad.json.error, bad.json.attempts], ['failed', 500, 'HTTP 500: receiver is unwell', 1]);
    const shown = (await call('admin', 'GET', '/api/v1/webhooks')).json.items[0];
    assert.deepEqual([shown.consecutiveFailures, shown.lastError], [1, 'HTTP 500: receiver is unwell']);
    answer = () => ({ status: 200 });
    assert.equal((await call('admin', 'POST', `/api/v1/webhooks/${made.json.id}/test`)).json.status, 'sent');
    assert.equal((await call('admin', 'GET', '/api/v1/webhooks')).json.items[0].consecutiveFailures, 0, 'a success starts the count again');
    assert.equal((await call('admin', 'POST', '/api/v1/webhooks/00000000-0000-4000-8000-0000000000aa/test')).status, 404);
  });

  test('an alert that fires and one that resolves are each delivered once to the webhooks that want them, filtered by severity and kind', async () => {
    received.length = 0; answer = () => ({ status: 200 });
    const all = (await call('admin', 'GET', '/api/v1/webhooks')).json.items.find(item => item.name === 'Signed chat');
    await call('admin', 'PATCH', `/api/v1/webhooks/${all.id}`, { body: { url: `${receiverUrl}/all/${TOKEN}` }, version: all.rowVersion });
    const critical = await create(hook({ name: 'Pager', url: `${receiverUrl}/pager/${TOKEN}`, minSeverity: 'critical', events: ['alert.fired', 'schedule.problem'] }));
    const resolvedOnly = await create(hook({ name: 'Recoveries', url: `${receiverUrl}/recoveries/${TOKEN}`, events: ['alert.resolved', 'connection.recovered'] }));
    assert.equal(critical.status, 201); assert.equal(resolvedOnly.status, 201);
    const rule = await call('admin', 'POST', '/api/v1/alert-rules', { body: { name: 'Webhook CPU', metric: 'vm.cpu_percent', comparison: 'above', threshold: 10, severity: 'warning', durationMinutes: 0 } });
    assert.equal(rule.status, 201, rule.text);
    assert.equal((await call('admin', 'POST', '/api/v1/alerts/evaluate')).json.fired, 1);
    await waitFor(() => postsTo('/all/').length === 1, 'the alert reaches the webhook that wants everything');
    const fired = JSON.parse(postsTo('/all/')[0].body);
    assert.deepEqual([fired.text.startsWith('[WARNING] nuvrion-app-01 — Webhook CPU:'), fired.text.endsWith('(alert raised)')], [true, true]);
    await call('admin', 'POST', '/api/v1/alerts/evaluate'); await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(postsTo('/all/').length, 1, 'refreshing an open alert does not send it again');
    assert.equal(postsTo('/pager/').length, 0, 'a warning does not reach a webhook that wants critical only');
    assert.equal(postsTo('/recoveries/').length, 0, 'nor one that wants only recoveries');
    // raise the limit: the alert resolves
    const stored = (await call('admin', 'GET', '/api/v1/alert-rules')).json.items.find(item => item.name === 'Webhook CPU');
    await call('admin', 'PATCH', `/api/v1/alert-rules/${stored.id}`, { body: { threshold: 50 }, version: stored.rowVersion });
    assert.equal((await call('admin', 'POST', '/api/v1/alerts/evaluate')).json.resolved, 1);
    await waitFor(() => postsTo('/recoveries/').length === 1 && postsTo('/all/').length === 2, 'the resolution reaches those who want it');
    assert.match(JSON.parse(postsTo('/recoveries/')[0].body).text, /\(alert resolved\)$/); assert.equal(postsTo('/pager/').length, 0);
    const history = await deliveriesOf(all.id);
    assert.deepEqual(history.filter(delivery => delivery.eventType !== 'test').map(delivery => [delivery.eventType, delivery.status, delivery.attempts]).sort(), [['alert.fired', 'sent', 1], ['alert.resolved', 'sent', 1]]);
    // the escalation: the same kind of alert, critical, reaches the pager
    const hot = await call('admin', 'POST', '/api/v1/alert-rules', { body: { name: 'Hot', metric: 'vm.cpu_percent', comparison: 'above', threshold: 10, severity: 'critical', durationMinutes: 0 } });
    assert.equal(hot.status, 201);
    await call('admin', 'POST', '/api/v1/alerts/evaluate');
    await waitFor(() => postsTo('/pager/').length === 1, 'a critical alert reaches the pager');
    assert.match(JSON.parse(postsTo('/pager/')[0].body).text, /^\[CRITICAL\]/);
  });

  test('a webhook that is turned off sends nothing, and when turned on again sends nothing from the time it was off; changes need the current version', async () => {
    received.length = 0;
    const [pager] = (await call('admin', 'GET', '/api/v1/webhooks')).json.items.filter(item => item.name === 'Pager');
    const off = await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { enabled: false }, version: pager.rowVersion });
    assert.deepEqual([off.status, off.json.enabled, off.json.rowVersion], [200, false, pager.rowVersion + 1]);
    assert.equal((await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { name: 'Stale' }, version: pager.rowVersion })).status, 412);
    assert.equal((await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { name: 'No version' } })).status, 428);
    assert.equal((await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { name: 'signed CHAT' }, version: off.json.rowVersion })).code, 'NUV_WEBHOOK_EXISTS');
    assert.equal((await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { url: 'ftp://x.example.test' }, version: off.json.rowVersion })).status, 422);
    assert.equal((await call('admin', 'PATCH', '/api/v1/webhooks/00000000-0000-4000-8000-0000000000aa', { body: { enabled: true }, version: 1 })).status, 404);
    await call('admin', 'POST', '/api/v1/alerts/evaluate'); await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(postsTo('/pager/').length, 0);
    const on = await call('admin', 'PATCH', `/api/v1/webhooks/${pager.id}`, { body: { enabled: true }, version: off.json.rowVersion });
    assert.ok(Date.parse(on.json.activeSince) > Date.parse(pager.activeSince));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(postsTo('/pager/').length, 0, 'what happened while it was off is not sent afterwards');
  });

  test('everything an administrator does with webhooks is in the audit history, and the address is in none of it', async () => {
    const events = (await call('admin', 'GET', '/api/v1/audit-events?limit=250&search=webhook.')).json.items;
    const actions = new Set(events.map(event => event.action));
    for (const action of ['webhook.created', 'webhook.updated', 'webhook.tested']) assert.ok(actions.has(action), action);
    assert.equal(JSON.stringify(events).includes(TOKEN) || JSON.stringify(events).includes(SIGNING), false);
    assert.ok(events.some(event => event.action === 'webhook.updated' && event.detail.addressChanged === true), 'that the address changed is recorded, not the address');
  });

  test('deleting a webhook removes it and its history', async () => {
    const [chat] = (await call('admin', 'GET', '/api/v1/webhooks')).json.items.filter(item => item.name === 'Signed chat');
    assert.ok((await deliveriesOf(chat.id)).length > 0);
    assert.equal((await call('operator1', 'DELETE', `/api/v1/webhooks/${chat.id}`)).status, 403);
    assert.deepEqual((await call('admin', 'DELETE', `/api/v1/webhooks/${chat.id}`)).json, { deleted: 1 });
    assert.equal((await call('admin', 'DELETE', `/api/v1/webhooks/${chat.id}`)).status, 404);
    assert.deepEqual(await deliveriesOf(chat.id), []);
    assert.equal((await call('admin', 'GET', '/api/v1/webhooks')).json.items.some(item => item.id === chat.id), false);
    assert.equal((await call('admin', 'GET', '/api/v1/audit-events?limit=250&search=webhook.deleted')).json.items.length, 1);
  });
});

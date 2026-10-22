import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capacity over the real HTTP API (in-memory services, the mock provider): the platform records a reading of each datastore by itself, a datastore with no history says so, a history
// gives a forecast (the mock's datastore2 is 90% full and its history grows 10 GB a day; datastore1 is flat), the list puts the datastore that fills first at the top, the history of a
// datastore is returned for a chart, and an alert rule on the days until full fires for the one that is filling.
const dependenciesInstalled = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib'].map(name => import(name).then(() => true, () => false))).then(r => r.every(Boolean));
const PASSWORD = 'Capacity-Test-Password-1!'; // secret-scan:allow (fake test credential)
const GB = 1024 ** 3, DAY = 86_400_000;

describe('capacity over the API', { skip: dependenciesInstalled ? false : 'server dependencies are not installed (run npm install)' }, () => {
  let server, base, workDir, capacityService, ds1, ds2; const sessions = {};

  async function call(who, method, path, { body, csrf = 'valid' } = {}) {
    const headers = {};
    if (who) { headers.cookie = sessions[who].cookie; if (method !== 'GET') headers['x-csrf-token'] = csrf === 'valid' ? sessions[who].csrf : csrf; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, code: json?.code, json, text };
  }
  async function login(name, username = name) {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    const json = await response.json();
    sessions[name] = { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrf: json.csrfToken };
  }
  async function addUser(username, role) {
    const signup = await (await fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: username, password: PASSWORD }) })).json();
    const update = await fetch(`${base}/api/v1/users/${signup.user.id}`, { method: 'PATCH', headers: { cookie: sessions.admin.cookie, 'x-csrf-token': sessions.admin.csrf, 'content-type': 'application/json', 'if-match': `"${signup.user.rowVersion}"` }, body: JSON.stringify({ status: 'active', roles: [role] }) });
    assert.equal(update.status, 200, await update.text());
    await login(username);
  }
  const list = async who => (await call(who, 'GET', '/api/v1/capacity/datastores')).json;
  const waitFor = async (check, what) => { for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail(`never happened: ${what}`); };

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nuvrion-capacity-api-'));
    Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_VIEWS_FILE: join(workDir, 'views.json'), NUVRION_BOOTSTRAP_PASSWORD: PASSWORD, NUVRION_SCHEDULE_INTERVAL_MS: '3600000', NUVRION_ALERT_INTERVAL_MS: '3600000', NUVRION_CAPACITY_INTERVAL_MS: '200' });
    delete process.env.NUVRION_RUNTIME_PROFILE;
    const module = await import('../src/server.js');
    capacityService = module.capacityService;
    server = module.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await login('admin');
    const created = await call('admin', 'POST', '/api/v1/connections', { body: { name: 'Capacity lab', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' } } }); // secret-scan:allow (fake test credential)
    assert.equal((await call('admin', 'POST', `/api/v1/connections/${created.json.id}/discover`)).status, 200);
    await addUser('operator1', 'operator'); await addUser('auditor1', 'auditor');
  });
  after(async () => { await new Promise(resolve => server?.close(resolve)); server?.closeAllConnections?.(); rmSync(workDir, { recursive: true, force: true }); });

  test('anyone who may view resources can read capacity; nobody else', async () => {
    assert.equal((await call(null, 'GET', '/api/v1/capacity/datastores')).status, 401);
    assert.equal((await call('auditor1', 'GET', '/api/v1/capacity/datastores')).status, 200);
    assert.equal((await call('operator1', 'GET', '/api/v1/capacity/datastores')).status, 200);
    assert.equal((await call(null, 'GET', '/api/v1/capacity/datastores/00000000-0000-4000-8000-000000000001')).status, 401);
  });

  test('the platform records a reading of each datastore by itself, and with no history says how full each is but gives no forecast', async () => {
    const items = await waitFor(async () => { const body = await list('admin'); return body.items.length === 2 && (await Promise.all(body.items.map(item => call('admin', 'GET', `/api/v1/capacity/datastores/${item.id}`)))).every(r => r.json.points.length >= 1) ? body.items : null; }, 'a first reading of each datastore');
    ds1 = items.find(item => item.name === 'datastore1'); ds2 = items.find(item => item.name === 'datastore2');
    assert.deepEqual([ds1.connectionName, Math.round(ds1.usedPercent), Math.round(ds2.usedPercent), ds2.stale], ['Capacity lab', 40, 90, false]);
    assert.equal(ds2.capacityBytes, 1099511627776); assert.equal(ds2.usedBytes, ds2.capacityBytes - ds2.freeBytes);
    assert.deepEqual([ds2.forecast.status, ds2.forecast.confidence, ds2.forecast.daysUntilFull, ds2.forecast.sampleCount], ['insufficient', null, null, 1]);
    assert.match(ds2.forecast.summary, /Not enough history/);
  });

  test('a history gives a forecast, and the datastore that fills first is listed first', async () => {
    const now = Date.now(), perDay = 10 * GB;
    for (const [item, growth] of [[ds1, 0], [ds2, perDay]]) {
      const points = [];
      for (let hours = 10 * 24; hours >= 6; hours -= 6) points.push({ objectId: item.id, connectionId: item.connectionId, capacityBytes: item.capacityBytes, freeBytes: item.freeBytes + growth * (hours / 24), observedAt: now - hours * 3_600_000 });
      const result = await capacityService.record(points);
      assert.equal(result.recorded, points.length, 'every reading six hours apart is kept');
    }
    const body = await list('operator1');
    assert.deepEqual(body.items.map(item => item.name), ['datastore2', 'datastore1'], 'soonest full first');
    const [filling, flat] = body.items;
    assert.deepEqual([filling.forecast.status, filling.forecast.confidence], ['growing', 'high']);
    assert.ok(Math.abs(filling.forecast.growthBytesPerDay / GB - 10) < 0.2, String(filling.forecast.growthBytesPerDay / GB));
    assert.ok(Math.abs(filling.forecast.daysUntilFull - 10.2) < 0.7, String(filling.forecast.daysUntilFull));
    assert.ok(Math.abs(Date.parse(filling.forecast.projectedFullAt) - (Date.now() + filling.forecast.daysUntilFull * DAY)) < 2 * 3_600_000, 'the date is the days from the latest reading (the days are rounded to a tenth)');
    assert.match(filling.forecast.summary, /^Growing by about 10 GB a day: full in about 10(\.\d)? days$/);
    assert.deepEqual([flat.forecast.status, flat.forecast.daysUntilFull, flat.forecast.projectedFullAt], ['stable', null, null]);
    assert.ok(filling.trend.length >= 20 && filling.trend.at(-1) > filling.trend[0], 'a trend for the small chart: used share rising');
    assert.ok(flat.trend.every(value => Math.abs(value - flat.trend[0]) < 0.5), 'and flat');
  });

  test('one datastore comes with its history for a chart, for the range asked, and refuses a range or an identifier that makes no sense', async () => {
    const week = await call('auditor1', 'GET', `/api/v1/capacity/datastores/${ds2.id}?days=7`);
    assert.equal(week.status, 200, week.text);
    assert.deepEqual([week.json.name, week.json.days, week.json.forecast.status], ['datastore2', 7, 'growing']);
    assert.ok(week.json.points.length >= 25 && week.json.points.length <= 31, `about four readings a day for seven days: ${week.json.points.length}`);
    assert.ok(week.json.points.every((point, i, all) => i === 0 || point.at > all[i - 1].at), 'in time order');
    assert.deepEqual(Object.keys(week.json.points[0]), ['at', 'usedBytes', 'capacityBytes']);
    const defaults = await call('admin', 'GET', `/api/v1/capacity/datastores/${ds2.id}`);
    assert.equal(defaults.json.days, 30); assert.ok(defaults.json.points.length > week.json.points.length);
    for (const days of ['0', '91', 'abc', '2.5']) assert.deepEqual([(await call('admin', 'GET', `/api/v1/capacity/datastores/${ds2.id}?days=${days}`)).status, (await call('admin', 'GET', `/api/v1/capacity/datastores/${ds2.id}?days=${days}`)).code], [422, 'NUV_CAPACITY_RANGE_INVALID']);
    assert.deepEqual([(await call('admin', 'GET', '/api/v1/capacity/datastores/00000000-0000-4000-8000-000000000001')).status, (await call('admin', 'GET', '/api/v1/capacity/datastores/00000000-0000-4000-8000-000000000001')).code], [404, 'NUV_CAPACITY_DATASTORE_NOT_FOUND']);
    assert.equal((await call('admin', 'GET', '/api/v1/capacity/datastores/not-an-id')).status, 404);
  });

  test('an alert rule on the days until full fires for the datastore that is filling, and not for the one that is not', async () => {
    const rule = { name: 'Filling within two weeks', metric: 'datastore.days_until_full', comparison: 'below', threshold: 14, severity: 'critical', durationMinutes: 0 };
    const preview = await call('admin', 'POST', '/api/v1/alert-rules/preview', { body: rule });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.json.summary, preview.json.matches.map(match => match.name)], ['Datastore days until full below 14 days', ['datastore2']]);
    assert.equal((await call('admin', 'POST', '/api/v1/alert-rules', { body: rule })).status, 201);
    const evaluation = await call('admin', 'POST', '/api/v1/alerts/evaluate');
    assert.equal(evaluation.json.fired, 1);
    const open = (await call('admin', 'GET', '/api/v1/alerts?status=open')).json.items.filter(alert => alert.metric === 'datastore.days_until_full');
    assert.deepEqual(open.map(alert => [alert.targetName, alert.targetKind, alert.severity]), [['datastore2', 'datastore', 'critical']]);
    assert.ok(Math.abs(open[0].value - 10.2) < 0.7);
  });

  // ---- hosts and clusters ------------------------------------------------------------------------------------------------------------------------------------------------
  // The mock estate has one cluster of two hosts: esx-mock-01 (50,400 MHz, 9,800 in use; 256 GB, 96 GB in use) and esx-mock-02 (50,400 MHz, 2,100 in use; 256 GB, 32 GB in use).
  const history = async (id, metric, capacityValue, usedNow, perDay) => {
    const now = Date.now(), points = [];
    for (let hours = 10 * 24; hours >= 6; hours -= 6) points.push({ objectId: id, metric, connectionId: undefined, capacityBytes: capacityValue, freeBytes: capacityValue - (usedNow - perDay * (hours / 24)), observedAt: now - hours * 3_600_000 });
    return capacityService.record(points);
  };
  const compute = async who => (await call(who, 'GET', '/api/v1/capacity/compute')).json;

  test('hosts and clusters are listed with their processor and memory, the cluster as the sum of its hosts, and with no history say so', async () => {
    const list = await waitFor(async () => { const body = await compute('admin'); return body.items.length === 3 && body.items.every(item => item.cpu.capacity !== null) ? body : null; }, 'the first reading of the hosts and the cluster');
    const byName = Object.fromEntries(list.items.map(item => [item.name, item]));
    const cluster = byName['Mock cluster'], first = byName['esx-mock-01.lab.example'], second = byName['esx-mock-02.lab.example'];
    assert.deepEqual([cluster.kind, first.kind, cluster.hostCount, first.parentName, first.connectionName], ['cluster', 'host', 2, 'Mock cluster', 'Capacity lab']);
    assert.deepEqual([first.cpu.capacity, first.cpu.used, first.memory.capacity, first.memory.used], [50400, 9800, 256 * GB, 96 * GB]);
    assert.deepEqual([cluster.cpu.capacity, cluster.cpu.used, cluster.memory.capacity, cluster.memory.used, cluster.memory.free], [100800, 11900, 512 * GB, 128 * GB, 384 * GB], 'the cluster is its hosts added together');
    assert.deepEqual([second.cpu.usedPercent, Math.round(first.memory.usedPercent * 10) / 10], [4.17, 37.5]);
    assert.ok(list.items.every(item => item.cpu.forecast.status === 'insufficient' && item.memory.forecast.status === 'insufficient'), 'a day of readings is needed');
    assert.match(first.cpu.forecast.summary, /Not enough history/);
    assert.equal((await call('auditor1', 'GET', '/api/v1/capacity/compute')).status, 200);
    assert.equal((await call(null, 'GET', '/api/v1/capacity/compute')).status, 401);
    ids = Object.fromEntries(list.items.map(item => [item.name, item.id]));
  });
  let ids;

  test('a history gives each host and cluster a forecast for its processor and for its memory, soonest first, in words that say "fully used"', async () => {
    await history(ids['esx-mock-01.lab.example'], 'cpu', 50400, 9800, 800);            // 40,600 MHz free at 800 a day: about 51 days
    await history(ids['esx-mock-02.lab.example'], 'cpu', 50400, 2100, 0);              // flat
    await history(ids['Mock cluster'], 'memory', 512 * GB, 128 * GB, 8 * GB);          // 384 GB free at 8 GB a day: about 48 days
    await history(ids['Mock cluster'], 'cpu', 100800, 11900, 0);
    const body = await compute('operator1');
    const byName = Object.fromEntries(body.items.map(item => [item.name, item]));
    const hostCpu = byName['esx-mock-01.lab.example'].cpu.forecast, clusterMemory = byName['Mock cluster'].memory.forecast;
    assert.deepEqual([hostCpu.status, hostCpu.confidence], ['growing', 'high']);
    assert.ok(Math.abs(hostCpu.daysUntilFull - 50.75) < 1.5, String(hostCpu.daysUntilFull));
    assert.ok(Math.abs(hostCpu.growthBytesPerDay - 800) < 20, 'growth is in MHz a day for a processor');
    assert.match(hostCpu.summary, /^Growing by about 0\.8 GHz a day: fully used in about 5\d(\.\d)? days$/);
    assert.deepEqual([clusterMemory.status, clusterMemory.confidence], ['growing', 'high']);
    assert.ok(Math.abs(clusterMemory.daysUntilFull - 48) < 1.5, String(clusterMemory.daysUntilFull));
    assert.match(clusterMemory.summary, /^Growing by about 8 GB a day: fully used in about 4\d(\.\d)? days$/);
    assert.equal(byName['esx-mock-02.lab.example'].cpu.forecast.status, 'stable'); assert.equal(byName['Mock cluster'].cpu.forecast.status, 'stable');
    assert.equal(byName['esx-mock-01.lab.example'].memory.forecast.status, 'insufficient', 'a metric with no history is not guessed');
    assert.deepEqual(body.items.slice(0, 2).map(item => item.name), ['Mock cluster', 'esx-mock-01.lab.example'], 'soonest to be fully used first (the cluster’s memory, then the host’s processor)');
    assert.ok(byName['esx-mock-01.lab.example'].cpu.trend.length >= 20);
  });

  test('one host or cluster comes with its history for a chart, for the metric and range asked, and refuses what makes no sense', async () => {
    const detail = await call('auditor1', 'GET', `/api/v1/capacity/compute/${ids['esx-mock-01.lab.example']}?metric=cpu&days=7`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual([detail.json.name, detail.json.metric, detail.json.days, detail.json.cpu.forecast.status], ['esx-mock-01.lab.example', 'cpu', 7, 'growing']);
    assert.ok(detail.json.points.length >= 25 && detail.json.points.length <= 31, String(detail.json.points.length));
    assert.ok(detail.json.points.every(point => point.capacityBytes === 50400), 'processor capacity in MHz');
    assert.equal((await call('admin', 'GET', `/api/v1/capacity/compute/${ids['Mock cluster']}`)).json.metric, 'cpu', 'processor by default');
    const memory = await call('admin', 'GET', `/api/v1/capacity/compute/${ids['Mock cluster']}?metric=memory`);
    assert.deepEqual([memory.json.metric, memory.json.days, memory.json.points.at(-1).capacityBytes], ['memory', 30, 512 * GB]);
    assert.deepEqual([(await call('admin', 'GET', `/api/v1/capacity/compute/${ids['Mock cluster']}?metric=disk`)).code, (await call('admin', 'GET', `/api/v1/capacity/compute/${ids['Mock cluster']}?days=0`)).code], ['NUV_CAPACITY_METRIC_INVALID', 'NUV_CAPACITY_RANGE_INVALID']);
    assert.equal((await call('admin', 'GET', '/api/v1/capacity/compute/00000000-0000-4000-8000-000000000001')).code, 'NUV_CAPACITY_OBJECT_NOT_FOUND');
    assert.equal((await call('admin', 'GET', `/api/v1/capacity/compute/${ids['datastore1'] ?? 'x'}`)).status, 404);
  });

  test('alert rules on the days until a host or a cluster is fully used fire for the ones that are filling, and the alert is about a cluster when it is one', async () => {
    const hostRule = { name: 'Host CPU within 60 days', metric: 'host.cpu_days_until_full', comparison: 'below', threshold: 60, severity: 'warning', durationMinutes: 0 };
    const clusterRule = { name: 'Cluster memory within 60 days', metric: 'cluster.memory_days_until_full', comparison: 'below', threshold: 60, severity: 'critical', durationMinutes: 0 };
    const preview = await call('admin', 'POST', '/api/v1/alert-rules/preview', { body: clusterRule });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.json.summary, preview.json.matches.map(match => match.name)], ['Cluster memory days until fully used below 60 days', ['Mock cluster']]);
    assert.equal((await call('admin', 'POST', '/api/v1/alert-rules', { body: hostRule })).status, 201);
    assert.equal((await call('admin', 'POST', '/api/v1/alert-rules', { body: clusterRule })).status, 201);
    assert.equal((await call('admin', 'POST', '/api/v1/alerts/evaluate')).json.fired, 2);
    const open = (await call('admin', 'GET', '/api/v1/alerts?status=open')).json.items.filter(alert => /_days_until_full$/.test(alert.metric) && alert.metric !== 'datastore.days_until_full');
    assert.deepEqual(open.map(alert => [alert.targetKind, alert.targetName, alert.severity]).sort(), [['cluster', 'Mock cluster', 'critical'], ['host', 'esx-mock-01.lab.example', 'warning']]);
    const metrics = (await call('operator1', 'GET', '/api/v1/alert-metrics')).json.items;
    assert.deepEqual(metrics.filter(metric => metric.kind === 'cluster').map(metric => metric.key).sort(), ['cluster.cpu_days_until_full', 'cluster.memory_days_until_full']);
  });
});

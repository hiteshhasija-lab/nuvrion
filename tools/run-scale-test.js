// Reference-scale test (docs/scale-test.md). It builds a synthetic estate (10,000 virtual machines by default) in a THROWAWAY database on a local PostgreSQL, starts the real API
// in the production profile against it (the in-process broker stands in for RabbitMQ), and measures what the console and the platform do at that size: the inventory the console
// loads every five seconds, searches and filters, a console refresh as one person sees it and as several people see it, detail pages, alert evaluation, tag operations, discovery
// cycles, and tasks submitted through the API and run to completion. Optionally it drives Chrome to measure what the browser does with the list.
//
//   NUVRION_QUALIFICATION_ACK=synthetic-only NUVRION_TEST_DATABASE_URL=<postgres url of a server on this machine> node tools/run-scale-test.js <evidence.json>
//
// It refuses any database that is not on this machine, creates its own database and drops it at the end, and writes nothing anywhere else. It never talks to a provider, a
// production host or the network. Environment: NUVRION_SCALE_VMS (10000), NUVRION_SCALE_TASKS (1000), NUVRION_SCALE_BROWSER=0 to skip Chrome.
import { spawn, execFile } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import http from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Node's fetch (undici) fails with "setTypeOfService EINVAL" on macOS under many concurrent sockets, so the load generator uses the plain http client with a keep-alive agent.
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const target = new URL(url), data = body === undefined ? null : Buffer.from(body);
  const req = http.request({ agent, hostname: target.hostname, port: target.port, path: target.pathname + target.search, method, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) })); res.on('error', reject);
  });
  req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('request timed out'))); if (data) req.write(data); req.end();
});

const serverMode = process.argv.includes('--server');
if (serverMode) {
  // The API as production runs it, except that RabbitMQ is replaced by the in-process broker (no AMQP server is needed on a laptop). Everything else is the production code.
  const { RabbitTaskBroker, LocalTaskBroker } = await import('../modules/messaging/src/task-broker.js');
  RabbitTaskBroker.connect = async () => new LocalTaskBroker();
  const { createServer } = await import('../apps/api/src/server.js');
  createServer().listen(Number(process.env.NUVRION_PORT), '127.0.0.1', () => console.log(JSON.stringify({ event: 'scale.server_ready' })));
}

// ---- statistics ---------------------------------------------------------------------------------------------------------------------------------------------------
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : null;
const round = (value, digits = 1) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

function summarise(latencies, { wallMs, statuses, bytes, errors }) {
  const sorted = [...latencies].sort((a, b) => a - b), total = latencies.length;
  const failed = errors + Object.entries(statuses).filter(([code]) => Number(code) >= 400).reduce((sum, [, n]) => sum + n, 0);
  return {
    requests: total, errors: failed, errorRate: round(total ? failed / total : 1, 4), statuses,
    p50Ms: round(percentile(sorted, 50)), p95Ms: round(percentile(sorted, 95)), p99Ms: round(percentile(sorted, 99)), maxMs: round(sorted.at(-1) ?? null), meanMs: round(total ? latencies.reduce((a, b) => a + b, 0) / total : null),
    throughputPerSecond: round(total / (wallMs / 1000), 2), averageResponseKB: round(total ? bytes / total / 1024 : 0, 1)
  };
}

async function cpuSeconds(pid) {
  try {
    const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]);
    const parts = stdout.trim().split(':').map(Number).reverse();
    return (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
  } catch { return null; }
}
async function rssMb(pid) {
  try { return Number((await run('ps', ['-o', 'rss=', '-p', String(pid)])).stdout.trim()) / 1024; } catch { return null; }
}

async function main() {
  const [outputPath] = process.argv.slice(2);
  const adminUrl = process.env.NUVRION_TEST_DATABASE_URL;
  if (!outputPath || process.env.NUVRION_QUALIFICATION_ACK !== 'synthetic-only' || !adminUrl) {
    throw new Error('Usage: NUVRION_QUALIFICATION_ACK=synthetic-only NUVRION_TEST_DATABASE_URL=postgres://...@127.0.0.1/postgres node tools/run-scale-test.js <evidence.json>');
  }
  const host = new URL(adminUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`Refusing to run against ${host}: the scale test only runs against a PostgreSQL on this machine.`);

  const vmCount = Number(process.env.NUVRION_SCALE_VMS ?? 10000), taskCount = Number(process.env.NUVRION_SCALE_TASKS ?? 1000);
  const { createTestDatabase } = await import('../database/test-support/test-database.js');
  const { PostgresInventoryService } = await import('../modules/inventory/src/postgres-inventory-service.js');
  const { PostgresInfrastructureService } = await import('../modules/inventory/src/postgres-infrastructure-service.js');
  const { PostgresPerformanceService } = await import('../modules/monitoring/src/postgres-performance-service.js');
    const { DiscoveryScheduler } = await import('../modules/inventory/src/discovery-scheduler.js');

  const evidence = {
    format: 'nuvrion-scale-test/v1', status: 'running', startedAt: new Date().toISOString(), vmCount, taskCount,
    machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: round(totalmem() / 2 ** 30), node: process.version, database: 'PostgreSQL on the same machine' },
    notes: ['The load generator, the API and PostgreSQL share one machine, so the numbers include no network and carry the load generator\'s own cost.', 'RabbitMQ is replaced by the in-process broker.', 'No provider is contacted: operations go to the mock provider.'],
    scenarios: {}, discovery: {}, server: {}
  };
  const db = await createTestDatabase({ poolSize: 30 });
  const workdir = await mkdtemp(join(tmpdir(), 'nuvrion-scale-'));
  let server = null;
  try {
    // ---- start the API ------------------------------------------------------------------------------------------------------------------------------------------
    const port = await new Promise(resolve => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); }); });
    const keys = generateKeyPairSync('ed25519'), password = `Scale-${randomBytes(9).toString('hex')}-Aa1`;
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NUVRION_RUNTIME_PROFILE: 'production', NUVRION_PORT: String(port),
      NUVRION_DATABASE_URL: db.connectionString, NUVRION_BROKER_URL: 'amqp://unused.invalid', NUVRION_DB_POOL_SIZE: '20',
      NUVRION_ENCRYPTION_KEYS: JSON.stringify({ k1: randomBytes(24).toString('hex') }), NUVRION_ACTIVE_ENCRYPTION_KEY_ID: 'k1', NUVRION_MASTER_KEY: randomBytes(24).toString('hex'),
      NUVRION_BACKUP_INTEGRITY_KEY: randomBytes(24).toString('hex'), NUVRION_BOOTSTRAP_PASSWORD: password,
      NUVRION_AGENT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), NUVRION_AGENT_SIGNING_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      NUVRION_UPGRADE_SHARED_DIR: join(workdir, 'upgrades'), NUVRION_AGENT_INTAKE_DIR: join(workdir, 'intake'),
      // no background discovery, capacity sampling, alert evaluation or retention while the test measures: each is driven by the test itself
      NUVRION_DISCOVERY_INTERVAL_MS: '86400000', NUVRION_CAPACITY_SAMPLE_MS: '86400000', NUVRION_ALERT_INTERVAL_MS: '86400000', NUVRION_SCHEDULE_INTERVAL_MS: '86400000', NUVRION_RETENTION_INTERVAL_MS: '86400000',
      NUVRION_WEBHOOK_INTERVAL_MS: '86400000', NUVRION_CAPACITY_INTERVAL_MS: '86400000', NUVRION_AGENT_MAINTENANCE_MS: '3600000', NUVRION_LOGIN_ATTEMPT_LIMIT: '1000'
    };
    server = spawn(process.execPath, [fileURLToPath(import.meta.url), '--server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) { if (server.exitCode !== null) throw new Error(`the API exited: ${serverLog}`); try { if ((await request(`${base}/api/v1/health`)).status === 200) break; } catch { /* not yet */ } await sleep(500); }

    // ---- sign in ----------------------------------------------------------------------------------------------------------------------------------------------
    const login = await request(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    if (login.status !== 200) throw new Error(`sign-in failed: ${login.status} ${login.buffer.toString()}`);
    const cookies = [login.headers['set-cookie']].flat().map(line => line.split(';')[0]).join('; '), csrf = JSON.parse(login.buffer.toString()).csrfToken;
    const auth = { cookie: cookies, 'x-csrf-token': csrf };
    const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
      const response = await request(`${base}/api/v1${path}`, { method, headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = JSON.parse(response.buffer.toString()); } catch { /* not JSON */ }
      return { status: response.status, bytes: response.buffer.length, json };
    };

    // ---- a load generator with a sample of the server's cost ---------------------------------------------------------------------------------------
    async function load(name, makeRequest, { requests, concurrency }) {
      const latencies = [], statuses = {}; let bytes = 0, errors = 0, next = 0, peakRss = 0;
      const cpuBefore = await cpuSeconds(server.pid), poll = setInterval(async () => { peakRss = Math.max(peakRss, (await rssMb(server.pid)) ?? 0); }, 400);
      const started = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < requests) {
          const index = next++, t0 = performance.now();
          try { const r = await makeRequest(index); latencies.push(performance.now() - t0); statuses[r.status] = (statuses[r.status] ?? 0) + 1; bytes += r.bytes; } catch (error) { errors++; latencies.push(performance.now() - t0); void error; }
        }
      }));
      const wallMs = performance.now() - started; clearInterval(poll);
      const cpuAfter = await cpuSeconds(server.pid);
      const result = { ...summarise(latencies, { wallMs, statuses, bytes, errors }), concurrency, serverCpuSeconds: cpuBefore !== null && cpuAfter !== null ? round(cpuAfter - cpuBefore, 2) : null, serverPeakRssMB: round(peakRss), wallSeconds: round(wallMs / 1000, 2) };
      evidence.scenarios[name] = result;
      console.log(JSON.stringify({ scenario: name, p50Ms: result.p50Ms, p95Ms: result.p95Ms, maxMs: result.maxMs, errorRate: result.errorRate, perSecond: result.throughputPerSecond, avgKB: result.averageResponseKB, concurrency }));
      return result;
    }

    // ---- connections (through the API, as an administrator would) ----------------------------------------------------------------------------------
    const shapes = [
      { name: 'scale-vcenter', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://scale-vcenter.example', share: 0.40, prefix: 'vc' },
      { name: 'scale-aws', providerType: 'aws', connectionType: 'cloud_api', endpointUri: 'https://ec2.us-east-1.amazonaws.com', share: 0.25, prefix: 'aws', configuration: { region: 'us-east-1' } },
      { name: 'scale-azure', providerType: 'azure', connectionType: 'cloud_api', endpointUri: 'https://management.azure.com', share: 0.20, prefix: 'az', configuration: { subscriptionId: '00000000-0000-0000-0000-000000000000' } },
      { name: 'scale-esxi-fleet', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://scale-vcenter-2.example', share: 0.10, prefix: 'es' },
      { name: 'scale-workstation', providerType: 'vmware_workstation', connectionType: 'workstation_rest', endpointUri: 'https://scale-ws.example:8697', share: 0.05, prefix: 'ws' }
    ];
    // the credentials are fake and are never used: the connections run on the mock adapter
    const credentialFor = shape => shape.providerType === 'aws' ? { accessKeyId: 'AKIAFAKEFAKEFAKE0000' /* secret-scan:allow fake credential for a mock connection */, secretAccessKey: 'fake'.repeat(10) } : shape.providerType === 'azure' ? { tenantId: 'fake', clientId: 'fake', clientSecret: 'fake'.repeat(10) } : { username: 'fake', password: 'fake'.repeat(5) };
    for (const shape of shapes) {
      // adapter 'mock': operations go to the mock provider and nothing is sent anywhere
      const created = await call('/connections', { method: 'POST', body: { name: shape.name, providerType: shape.providerType, connectionType: shape.connectionType, endpointUri: shape.endpointUri, credential: credentialFor(shape), configuration: { ...(shape.configuration ?? {}), adapter: 'mock' } } });
      if (created.status !== 201) throw new Error(`could not create ${shape.name}: ${created.status} ${JSON.stringify(created.json)}`);
      shape.connection = created.json;
    }

    // ---- the synthetic estate, brought in through the real discovery path ------------------------------------------------------------------------
    const rand = (seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; })(20261121);
    const pick = list => list[Math.floor(rand() * list.length)];
    const hostsPerConnection = Math.max(2, Math.round(vmCount / 10 / 50)), datastoresPerConnection = 6, networksPerConnection = 5;
    const observationsFor = shape => {
      const count = Math.round(vmCount * shape.share), list = [];
      for (let i = 0; i < count; i++) {
        const state = rand(), power = state < 0.70 ? 'running' : state < 0.95 ? 'stopped' : 'suspended', host = Math.floor(rand() * hostsPerConnection), ds = Math.floor(rand() * datastoresPerConnection), net = Math.floor(rand() * networksPerConnection);
        list.push({
          resourceType: 'virtual_machine', nativeId: `${shape.prefix}-vm-${String(i).padStart(5, '0')}`, name: `${shape.prefix}-${pick(['web', 'app', 'db', 'cache', 'batch', 'ci'])}-${String(i).padStart(5, '0')}`,
          healthState: rand() < 0.93 ? 'healthy' : rand() < 0.7 ? 'warning' : 'critical',
          attributes: { powerState: power, guestOs: pick(['Ubuntu 24.04', 'Windows Server 2025', 'Red Hat Enterprise Linux 9', 'Debian 12', 'Windows 11']), vcpuCount: pick([1, 2, 4, 8, 16]), memoryBytes: pick([2, 4, 8, 16, 64]) * 2 ** 30, storageBytes: pick([20, 50, 100, 500, 2000]) * 2 ** 30, privateIps: [`10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`], publicIps: [], region: pick(['us-east-1', 'eu-west-1', 'local']), availabilityZone: pick(['a', 'b', 'c']), providerShape: pick(['small', 'medium', 'large']) },
          providerMetadata: { folder: `/${pick(['Production', 'Test', 'Development'])}`, toolsStatus: pick(['current', 'outdated']), placement: { hostNativeId: `${shape.prefix}-host-${host}`, datastoreNativeIds: [`${shape.prefix}-ds-${ds}`], networkNativeIds: [`${shape.prefix}-net-${net}`] } },
          metrics: power === 'running' ? { cpuUtilizationPercent: round(rand() * 100), memoryUtilizationPercent: round(rand() * 100), memoryUsedBytes: Math.floor(rand() * 8 * 2 ** 30), storageUsedBytes: Math.floor(rand() * 100 * 2 ** 30), networkRxBytesPerSec: Math.floor(rand() * 1e6), networkTxBytesPerSec: Math.floor(rand() * 1e6), source: 'scale' } : undefined
        });
      }
      return list;
    };
    const infrastructureFor = shape => [
      { kind: 'datacenter', nativeId: `${shape.prefix}-dc`, name: `${shape.name} datacenter`, parentNativeId: null, attributes: {} },
      ...Array.from({ length: hostsPerConnection }, (_, h) => ({ kind: 'host', nativeId: `${shape.prefix}-host-${h}`, name: `${shape.prefix}-host-${h}.lab.example`, parentNativeId: `${shape.prefix}-dc`, attributes: { powerState: 'poweredOn', connectionState: 'connected', cpuCores: 48, cpuMhz: 100000, memoryBytes: 512 * 2 ** 30, cpuUsageMhz: Math.floor(rand() * 90000), memoryUsageBytes: Math.floor(rand() * 400 * 2 ** 30) } })),
      ...Array.from({ length: datastoresPerConnection }, (_, d) => ({ kind: 'datastore', nativeId: `${shape.prefix}-ds-${d}`, name: `${shape.prefix}-datastore-${d}`, parentNativeId: `${shape.prefix}-dc`, attributes: { type: 'VMFS', capacityBytes: 20 * 2 ** 40, freeBytes: Math.floor((0.1 + rand() * 0.8) * 20 * 2 ** 40), accessible: true } })),
      ...Array.from({ length: networksPerConnection }, (_, n) => ({ kind: 'network', nativeId: `${shape.prefix}-net-${n}`, name: `${shape.prefix}-vlan-${n}`, parentNativeId: `${shape.prefix}-dc`, attributes: { type: 'standard', accessible: true } }))
    ];
    const inventory = new PostgresInventoryService(db.pool), infrastructure = new PostgresInfrastructureService(db.pool), performance_ = new PostgresPerformanceService(db.pool);
    const observations = new Map(shapes.map(shape => [shape.connection.id, observationsFor(shape)])), reports = new Map(shapes.map(shape => [shape.connection.id, infrastructureFor(shape)]));
    const stubProvider = { discover: async connection => structuredClone(observations.get(connection.id)), infrastructure: async connection => structuredClone(reports.get(connection.id)) };
    const connectionService = { recordSync: async () => {}, recordDiagnostic: async () => {} };
    const scheduler = new DiscoveryScheduler({ connections: connectionService, inventory, provider: stubProvider, reconciler: { reconcileConnection: async () => ({ checked: 0 }) }, performance: performance_, infrastructure });
    const timeDiscovery = async (label, connection) => { const t0 = performance.now(); const summary = await scheduler.discover(connection); const ms = performance.now() - t0; return { label, vms: observations.get(connection.id).length, ms: round(ms), perVmMs: round(ms / observations.get(connection.id).length, 3), summary: { created: summary.created, updated: summary.updated, missing: summary.missing, metricsRecorded: summary.metricsRecorded } }; };

    evidence.discovery.initial = [];
    for (const shape of shapes) { const row = await timeDiscovery('first discovery (every VM new)', shape.connection); evidence.discovery.initial.push({ connection: shape.name, ...row }); console.log(JSON.stringify({ discovery: shape.name, vms: row.vms, ms: row.ms })); }
    const largest = shapes[0];
    evidence.discovery.unchanged = await timeDiscovery('rediscovery, nothing changed', largest.connection);
    for (const item of observations.get(largest.connection.id)) if (rand() < 0.1) item.attributes.powerState = item.attributes.powerState === 'running' ? 'stopped' : 'running';
    evidence.discovery.tenPercentChanged = await timeDiscovery('rediscovery, 10% changed power state', largest.connection);
    console.log(JSON.stringify({ discovery: 'unchanged', ms: evidence.discovery.unchanged.ms, changed: evidence.discovery.tenPercentChanged.ms }));
    // one discovery cycle for all connections together, as the platform runs them back to back
    { const t0 = performance.now(); for (const shape of shapes) await scheduler.discover(shape.connection); evidence.discovery.fullCycleMs = round(performance.now() - t0); }

    const database = await db.pool.query(`SELECT (SELECT count(*)::int FROM inventory.virtual_machines) vms, (SELECT count(*)::int FROM inventory.resources) resources, (SELECT count(*)::int FROM inventory.infrastructure_objects) infrastructure, (SELECT count(*)::int FROM monitoring.vm_metric_samples) samples, pg_database_size(current_database())::bigint bytes`);
    evidence.database = { ...database.rows[0], bytes: Number(database.rows[0].bytes), sizeMB: round(Number(database.rows[0].bytes) / 2 ** 20) };
    console.log(JSON.stringify({ seeded: evidence.database }));

    // ---- tags: operate on the estate through the API -----------------------------------------------------------------------------------------------
    const listed = await call('/resources?resourceType=virtual_machine');
    const all = listed.json.items, ids = all.map(item => item.id);
    evidence.estate = { listed: all.length, payloadMB: round(listed.bytes / 2 ** 20, 2) };
    const tagStart = performance.now(); let tagged = 0;
    for (let offset = 0; offset < Math.min(ids.length, 3000); offset += 200) {
      const result = await call('/tag-operations', { method: 'POST', body: { resourceIds: ids.slice(offset, offset + 200), set: [{ key: 'env', value: (offset / 200) % 2 ? 'test' : 'prod' }] } });
      if (result.status >= 400) { evidence.tagOperationError = { status: result.status, body: result.json }; break; }
      tagged += 200;
    }
    evidence.tagOperations = { tagged, ms: round(performance.now() - tagStart) };

    // ---- the scenarios --------------------------------------------------------------------------------------------------------------------------------------
    const random = n => Math.floor(rand() * n);
    await load('inventory_list_all_1_user', () => call('/resources?resourceType=virtual_machine'), { requests: 20, concurrency: 1 });
    await load('inventory_list_all_5_users', () => call('/resources?resourceType=virtual_machine'), { requests: 40, concurrency: 5 });
    await load('inventory_search', i => call(`/resources?resourceType=virtual_machine&search=${['web-0042', 'db-00', 'ci-01', 'Windows', 'host-1'][i % 5]}`), { requests: 40, concurrency: 5 });
    await load('inventory_one_connection', () => call(`/resources?resourceType=virtual_machine&connectionId=${shapes[1].connection.id}`), { requests: 30, concurrency: 5 });
    await load('inventory_tag_filter', () => call('/resources?resourceType=virtual_machine&tag=env=prod'), { requests: 30, concurrency: 5 });
    await load('resource_detail', () => call(`/resources/${ids[random(ids.length)]}`), { requests: 500, concurrency: 20 });
    await load('performance_latest', () => call('/performance/latest'), { requests: 40, concurrency: 5 });
    await load('infrastructure_tree', () => call('/infrastructure'), { requests: 40, concurrency: 5 });
    await load('tags_list', () => call('/tags'), { requests: 100, concurrency: 10 });
    await load('capacity_datastores', () => call('/capacity/datastores'), { requests: 60, concurrency: 5 });
    await load('capacity_compute', () => call('/capacity/compute'), { requests: 60, concurrency: 5 });
    await load('audit_events_page', () => call('/audit-events?limit=100'), { requests: 100, concurrency: 10 });

    // a console refresh: what the console fetches every five seconds for one signed-in person, all at once
    const refreshPaths = ['/health', '/connections', '/connection-alerts?limit=5000', '/resources?resourceType=virtual_machine', '/performance/latest', '/tasks', '/audit-events?limit=50&offset=0&search=', '/users', '/infrastructure', '/roles', '/permissions', '/alert-rules', '/alerts?status=open&limit=200', '/alerts?status=resolved&limit=10', '/notifications', '/schedules', '/schedule-runs?limit=30', '/capacity/datastores', '/webhooks', '/capacity/compute', '/saved-views'];
    const refresh = () => Promise.all(refreshPaths.map(path => call(path))).then(results => ({ status: Math.max(...results.map(r => r.status)) >= 400 ? 500 : 200, bytes: results.reduce((sum, r) => sum + r.bytes, 0) }));
    await load('console_refresh_1_user', refresh, { requests: 20, concurrency: 1 });
    await load('console_refresh_5_users', refresh, { requests: 50, concurrency: 5 });
    await load('console_refresh_20_users', refresh, { requests: 100, concurrency: 20 });
    // sustained: 10 people each refreshing every 5 seconds for 60 seconds (the console's own timer)
    { const people = 10, seconds = 60, latencies = [], t0 = performance.now(), cpu0 = await cpuSeconds(server.pid); let bytes = 0, errors = 0;
      await Promise.all(Array.from({ length: people }, async (_, person) => { await sleep(person * 500); while (performance.now() - t0 < seconds * 1000) { const s = performance.now(); try { const r = await refresh(); bytes += r.bytes; if (r.status >= 400) errors++; } catch { errors++; } latencies.push(performance.now() - s); await sleep(Math.max(0, 5000 - (performance.now() - s))); } }));
      const sorted = latencies.sort((a, b) => a - b), cpu1 = await cpuSeconds(server.pid);
      evidence.scenarios.console_refresh_sustained_10_users_60s = { people, seconds, refreshes: sorted.length, errors, p50Ms: round(percentile(sorted, 50)), p95Ms: round(percentile(sorted, 95)), maxMs: round(sorted.at(-1)), averageResponseKB: round(bytes / sorted.length / 1024, 1), serverCpuSeconds: round((cpu1 ?? 0) - (cpu0 ?? 0), 2), serverRssMB: round(await rssMb(server.pid)), megabytesPerSecondOut: round(bytes / 2 ** 20 / seconds, 2) };
      console.log(JSON.stringify({ scenario: 'console_refresh_sustained_10_users_60s', ...evidence.scenarios.console_refresh_sustained_10_users_60s })); }

    // alert rules over the whole estate
    evidence.alertRules = [];
    for (const body of [{ name: 'scale vm cpu high', metric: 'vm.cpu_percent', comparison: 'above', threshold: 90, durationMinutes: 0, severity: 'warning', enabled: true }, { name: 'scale host cpu high', metric: 'host.cpu_percent', comparison: 'above', threshold: 85, durationMinutes: 0, severity: 'critical', enabled: true }]) {
      const created = await call('/alert-rules', { method: 'POST', body });
      evidence.alertRules.push({ name: body.name, status: created.status, error: created.status >= 400 ? created.json?.detail : undefined });
    }
    await load('alerts_evaluate', () => call('/alerts/evaluate', { method: 'POST', body: {} }), { requests: 10, concurrency: 1 });

    // tasks: submitted through the API as the console does, run by the worker through the mock provider, then counted
    const stopped = all.filter(item => item.lifecycleState !== 'missing' && (item.powerState ?? item.attributes?.powerState) === 'stopped').slice(0, taskCount);
    const submitted = [], t0 = performance.now(); let nextTask = 0, submitErrors = 0; const submitLatencies = [];
    await Promise.all(Array.from({ length: 20 }, async () => { while (nextTask < stopped.length) { const item = stopped[nextTask++], s = performance.now(); const r = await call(`/resources/${item.id}/operations`, { method: 'POST', body: { operation: 'start' }, headers: { 'idempotency-key': `scale-${item.id}` } }); submitLatencies.push(performance.now() - s); if (r.status === 202) submitted.push(r.json.id); else submitErrors++; } }));
    const submitWall = performance.now() - t0;
    let done = 0;
    for (let i = 0; i < 600; i++) { const r = await db.pool.query("SELECT count(*) FILTER (WHERE status IN ('completed','failed','cancelled'))::int done FROM operations.tasks WHERE operation='start' AND target_type='virtual_machine' AND requested_by IS NOT NULL"); done = r.rows[0].done; if (done >= submitted.length) break; await sleep(500); }
    const timing = (await db.pool.query("SELECT count(*)::int n, count(*) FILTER (WHERE status='completed')::int completed, count(*) FILTER (WHERE status='failed')::int failed, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-queued_at)*1000) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-queued_at)*1000) p95, percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-queued_at)*1000) p99, max(extract(epoch FROM completed_at-queued_at)*1000) max, extract(epoch FROM max(completed_at)-min(queued_at)) span FROM operations.tasks WHERE operation='start' AND requested_by IS NOT NULL")).rows[0];
    const sortedSubmit = submitLatencies.sort((a, b) => a - b);
    evidence.scenarios.task_load = { requested: stopped.length, accepted: submitted.length, submitErrors, submitP50Ms: round(percentile(sortedSubmit, 50)), submitP95Ms: round(percentile(sortedSubmit, 95)), submitWallSeconds: round(submitWall / 1000, 2), tasks: timing.n, completed: timing.completed, failed: timing.failed, completionP50Ms: round(Number(timing.p50)), completionP95Ms: round(Number(timing.p95)), completionP99Ms: round(Number(timing.p99)), completionMaxMs: round(Number(timing.max)), spanSeconds: round(Number(timing.span), 2), throughputPerSecond: round(timing.completed / Number(timing.span), 2) };
    console.log(JSON.stringify({ scenario: 'task_load', ...evidence.scenarios.task_load }));
    await load('tasks_list_after_load', () => call('/tasks'), { requests: 40, concurrency: 5 });

    // ---- the browser ----------------------------------------------------------------------------------------------------------------------------------------
    if (process.env.NUVRION_SCALE_BROWSER !== '0') {
      try { evidence.browser = await measureBrowser({ base, password }); console.log(JSON.stringify({ browser: evidence.browser })); }
      catch (error) { evidence.browser = { error: error.message }; }
    }

    evidence.server = { rssMB: round(await rssMb(server.pid)), cpuSecondsTotal: round(await cpuSeconds(server.pid), 2), logTail: serverLog.split('\n').filter(line => /"level":"(error|warn)"/.test(line)).slice(-5) };
    // product gate for the same scenarios: api p95 <= 500 ms and error rate <= 1% (modules/platform/src/release-qualification.js)
    const gate = { apiP95LatencyMs: 500, maxErrorRate: 0.01, taskP95CompletionMs: 5000, taskThroughputPerSecond: 10 };
    evidence.gate = gate;
    evidence.verdict = Object.fromEntries(Object.entries(evidence.scenarios).filter(([name]) => !['task_load'].includes(name)).map(([name, r]) => [name, { p95Ms: r.p95Ms, withinGate: r.p95Ms !== null && r.p95Ms <= gate.apiP95LatencyMs && (r.errorRate ?? 0) <= gate.maxErrorRate }]));
    evidence.verdict.task_load = { p95CompletionMs: evidence.scenarios.task_load.completionP95Ms, throughputPerSecond: evidence.scenarios.task_load.throughputPerSecond, withinGate: evidence.scenarios.task_load.completionP95Ms <= gate.taskP95CompletionMs && evidence.scenarios.task_load.throughputPerSecond >= gate.taskThroughputPerSecond && evidence.scenarios.task_load.failed === 0 };
    evidence.status = 'completed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.stack ?? String(error);
    process.exitCode = 1;
  } finally {
    evidence.completedAt = new Date().toISOString();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await sleep(1500); if (server.exitCode === null) server.kill('SIGKILL'); }
    await writeFile(outputPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await db.drop().catch(() => {});
    await rm(workdir, { recursive: true, force: true });
    console.log(JSON.stringify({ status: evidence.status, outputPath }));
  }
}

// What Chrome does with the list: sign in, wait for the Overview and the inventory to render, then read the page's own measurements. The page's timer is watched for 20 seconds,
// which includes at least three of the console's own five-second refreshes, to see how long the page is unresponsive while it receives and rebuilds the list.
async function measureBrowser({ base, password }) {
  const { launchBrowser, findChrome } = await import('../apps/web/test-support/browser.js');
  if (!findChrome()) return { skipped: 'Chrome was not found' };
  const browser = await launchBrowser({ width: 1600, height: 1000 });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.fill('#login-form [name=username]', 'admin');
    await page.fill('#login-form [name=password]', password);
    const t0 = Date.now();
    await page.clickText('Sign in →', '#login-form');
    await page.waitFor(() => [...document.querySelectorAll('h1')].some(h => h.offsetParent && h.textContent.includes('Platform Overview')), { timeout: 180000 });
    const overviewMs = Date.now() - t0;
    const t1 = Date.now();
    await page.click('#navigation button[data-view=inventory]');
    await page.waitFor(() => { const section = document.getElementById('view-inventory'); return section && section.getClientRects().length > 0 && document.querySelectorAll('#view-inventory tbody tr').length > 0; }, { timeout: 180000 });
    const inventoryMs = Date.now() - t1;
    const measured = await page.evaluate(async () => {
      const gaps = []; let last = performance.now(); const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last - 50); last = now; }, 50);
      await new Promise(resolve => setTimeout(resolve, 20000)); clearInterval(timer);
      const resources = performance.getEntriesByType('resource').filter(entry => /\/api\/v1\/resources\?/.test(entry.name));
      return {
        rowsRendered: document.querySelectorAll('#view-inventory tbody tr').length, domNodes: document.getElementsByTagName('*').length,
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null,
        longestPageStallMs: Math.round(Math.max(0, ...gaps)), stallsOver100ms: gaps.filter(gap => gap > 100).length, stallsOver500ms: gaps.filter(gap => gap > 500).length,
        resourceRequests: resources.length, resourceRequestMsP50: resources.length ? Math.round(resources.map(entry => entry.duration).sort((a, b) => a - b)[Math.floor(resources.length / 2)]) : null,
        resourceTransferMB: resources.length ? Math.round(resources[0].decodedBodySize / 2 ** 20 * 10) / 10 : null
      };
    });
    return { timeToOverviewMs: overviewMs, timeToInventoryRowsMs: inventoryMs, ...measured };
  } finally { await browser.close(); }
}

if (!serverMode) await main();

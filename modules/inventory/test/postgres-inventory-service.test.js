import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresInventoryService } from '../src/postgres-inventory-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production inventory service against a real PostgreSQL: discovery, the resource lifecycle (active, missing, deleted, revived),
// operations and the guest details kept from the last time a VM was running.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const inventory = db ? new PostgresInventoryService(db.pool) : null;
after(async () => { await db?.drop(); });

const seedConnection = async (name = 'Lab') => {
  const id = randomUUID();
  await db.pool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, $2, 'vmware_workstation', 'workstation_agent', 'enabled', 'healthy')", [id, name]);
  return { id, name, providerType: 'vmware_workstation' };
};
let connection;
beforeEach(async () => {
  if (!db) return;
  await db.pool.query('TRUNCATE inventory.provider_metadata, inventory.virtual_machines, inventory.discovery_runs, inventory.resources CASCADE');
  connection = await seedConnection(`Lab ${randomUUID().slice(0, 8)}`);
});

const vm = (nativeId, name, over = {}) => ({ resourceType: 'virtual_machine', nativeId, name, healthState: 'healthy', attributes: { powerState: 'stopped', guestOs: 'Ubuntu 24.04', vcpuCount: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 40 * 1024 ** 3, privateIps: ['10.0.0.5'] }, providerMetadata: { folder: '/vms' }, ...over });
const stateOf = async (name, id = connection.id) => (await inventory.list({ connectionId: id })).find(r => r.name === name)?.lifecycleState;
const count = async (table) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('the first discovery creates the resources and records a completed run', database, async () => {
  const summary = await inventory.synchronize(connection, [vm('a', 'Alpha'), vm('b', 'Beta')]);
  assert.deepEqual([summary.discovered, summary.created, summary.updated, summary.missing], [2, 2, 0, 0]);
  const listed = await inventory.list({ connectionId: connection.id });
  assert.deepEqual(listed.map(r => r.name), ['Alpha', 'Beta']);
  const alpha = listed[0];
  assert.equal(alpha.lifecycleState, 'active');
  assert.equal(alpha.providerType, 'vmware_workstation');
  assert.equal(alpha.attributes.powerState, 'stopped');
  assert.equal(alpha.attributes.vcpuCount, 2);
  assert.deepEqual(alpha.attributes.privateIps, ['10.0.0.5']);
  assert.equal(alpha.providerMetadata.folder, '/vms');
  assert.ok(Array.isArray(alpha.capabilities) && alpha.capabilities.length > 0, 'capabilities are worked out for the VM');
  const run = (await db.pool.query('SELECT status, discovered_count, created_count, updated_count, missing_count, completed_at FROM inventory.discovery_runs')).rows[0];
  assert.deepEqual([run.status, run.discovered_count, run.created_count, run.updated_count, run.missing_count], ['completed', 2, 2, 0, 0]);
  assert.ok(run.completed_at);
});

test('discovering the same things again updates them in place: no duplicates, the version goes up, changes show', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  const first = (await inventory.list({ connectionId: connection.id }))[0];
  const again = await inventory.synchronize(connection, [vm('a', 'Alpha renamed', { attributes: { ...vm('a', 'x').attributes, powerState: 'running', vcpuCount: 4 } })]);
  assert.deepEqual([again.created, again.updated, again.missing], [0, 1, 0]);
  const rows = await inventory.list({ connectionId: connection.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id, 'the same resource, not a new one');
  assert.equal(rows[0].name, 'Alpha renamed');
  assert.equal(rows[0].attributes.powerState, 'running');
  assert.equal(rows[0].attributes.vcpuCount, 4);
  assert.equal(rows[0].version, first.version + 1);
  assert.equal(await count('inventory.virtual_machines'), 1);
});

test('a resource that disappears becomes missing, and active again when it reappears', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha'), vm('b', 'Beta')]);
  const run = await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  assert.equal(run.missing, 1);
  assert.equal(await stateOf('Beta'), 'missing');
  assert.equal(await stateOf('Alpha'), 'active');
  const beta = (await inventory.list({ search: 'beta' }))[0];
  assert.ok(beta.missingSince, 'the time it went missing is recorded');
  assert.equal((await inventory.synchronize(connection, [vm('a', 'Alpha')])).missing, 0, 'already missing is not counted again');
  await inventory.synchronize(connection, [vm('a', 'Alpha'), vm('b', 'Beta')]);
  const back = (await inventory.list({ search: 'beta' }))[0];
  assert.equal(back.lifecycleState, 'active');
  assert.equal(back.missingSince, null);
});

test('a retired connection\'s resources stay deleted across later discovery runs, and a reappearing one is revived', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  assert.equal(await inventory.retireConnection(connection.id), 1);
  await inventory.synchronize(connection, []);
  await inventory.synchronize(connection, []);
  assert.equal(await stateOf('Alpha'), 'deleted', 'empty discoveries must not turn deleted back into missing');
  assert.equal(await inventory.retireConnection(connection.id), 0, 'retiring twice changes nothing');
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  assert.equal(await stateOf('Alpha'), 'active');
});

test('one connection\'s discovery never touches another connection\'s resources', database, async () => {
  const other = await seedConnection(`Other ${randomUUID().slice(0, 8)}`);
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  await inventory.synchronize(other, [vm('a', 'Same native id elsewhere')]);
  await inventory.synchronize(connection, []);
  assert.equal(await stateOf('Alpha'), 'missing');
  assert.equal(await stateOf('Same native id elsewhere', other.id), 'active');
  assert.equal((await inventory.list()).length, 2);
});

test('a batch that names the same provider resource twice is refused, and nothing from it is kept', database, async () => {
  await assert.rejects(() => inventory.synchronize(connection, [vm('a', 'First'), vm('b', 'Other'), vm('a', 'Second')]), /DUPLICATE_PROVIDER_IDENTITY/);
  assert.equal(await count('inventory.resources'), 0);
  assert.equal(await count('inventory.discovery_runs'), 0, 'not even the run record survives');
});

test('a bad observation in the middle of a batch rolls back everything before it, including changes to existing resources', database, async () => {
  await inventory.synchronize(connection, [vm('keep', 'Keeper')]);
  const bad = vm('bad', 'Broken', { attributes: { powerState: 'running', privateIps: ['not-an-ip-address'] } });
  await assert.rejects(() => inventory.synchronize(connection, [vm('keep', 'Keeper renamed'), vm('new', 'Newcomer'), bad]));
  const rows = await inventory.list({ connectionId: connection.id });
  assert.deepEqual(rows.map(r => r.name), ['Keeper'], 'the rename and the newcomer were rolled back');
  assert.equal(rows[0].lifecycleState, 'active');
  assert.equal(await count('inventory.discovery_runs'), 1, 'only the first, successful run is recorded');
});

test('discoveries that overlap for one connection all succeed and leave exactly one copy of each resource', database, async () => {
  // Several rounds: the overlap only happens once the pool's connections are open. Each round uses new native ids, so every round starts from nothing.
  for (let round = 0; round < 6; round++) {
    const batch = () => ['a', 'b', 'c'].map(n => vm(`${round}-${n}`, `Round ${round} ${n}`));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => inventory.synchronize(connection, batch())));
    const failures = results.filter(r => r.status === 'rejected').map(r => r.reason?.code ?? r.reason?.message);
    assert.deepEqual(failures.filter(code => !['40001', '40P01'].includes(code)), [], `round ${round}: a loser may only be a serialization conflict or deadlock, never a constraint error`);
    assert.ok(results.some(r => r.status === 'fulfilled'), `round ${round}: at least one succeeds`);
  }
  const names = (await inventory.list({ connectionId: connection.id })).map(r => r.nativeId);
  assert.equal(new Set(names).size, names.length, 'no resource appears twice');
  assert.equal(await count('inventory.virtual_machines'), await count('inventory.resources'), 'every resource has exactly its VM row');
  assert.equal(await count('inventory.provider_metadata'), await count('inventory.resources'));
});

test('list filters by connection, type, state and a case-insensitive search of name and native id', database, async () => {
  const other = await seedConnection(`Other ${randomUUID().slice(0, 8)}`);
  await inventory.synchronize(connection, [vm('vm-web-1', 'Web Server'), vm('vm-db-1', 'Database'), { resourceType: 'host', nativeId: 'host-1', name: 'Hypervisor', attributes: { powerState: 'running' } }]);
  await inventory.synchronize(other, [vm('vm-web-2', 'Other Web')]);
  await inventory.synchronize(connection, [vm('vm-web-1', 'Web Server'), { resourceType: 'host', nativeId: 'host-1', name: 'Hypervisor', attributes: { powerState: 'running' } }]);
  assert.equal((await inventory.list()).length, 4);
  assert.equal((await inventory.list({ connectionId: other.id })).length, 1);
  assert.deepEqual((await inventory.list({ connectionId: connection.id, resourceType: 'host' })).map(r => r.name), ['Hypervisor']);
  assert.deepEqual((await inventory.list({ lifecycleState: 'missing' })).map(r => r.name), ['Database']);
  assert.deepEqual((await inventory.list({ search: 'WEB' })).map(r => r.name), ['Other Web', 'Web Server']);
  assert.deepEqual((await inventory.list({ search: 'vm-db' })).map(r => r.name), ['Database'], 'the native id is searched too');
  assert.deepEqual(await inventory.list({ search: 'nothing-like-this' }), []);
});

test('a resource is found by id, and an unknown id is null', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  const [alpha] = await inventory.list();
  assert.equal((await inventory.get(alpha.id)).name, 'Alpha');
  assert.equal(await inventory.get(randomUUID()), null);
});

test('an operation is checked against what the resource can do right now', database, async () => {
  await inventory.synchronize(connection, [vm('stopped', 'Off'), vm('running', 'On', { attributes: { ...vm('x', 'x').attributes, powerState: 'running' } })]);
  const off = (await inventory.list({ search: 'Off' }))[0], on = (await inventory.list({ search: 'On' }))[0];
  assert.deepEqual((await inventory.validateOperation(randomUUID(), 'start')), { ok: false, code: 'NUV_RESOURCE_NOT_FOUND' });
  assert.equal((await inventory.validateOperation(off.id, 'start')).ok, true);
  assert.equal((await inventory.validateOperation(on.id, 'start')).code, 'NUV_OPERATION_STATE_CONFLICT', 'a running VM cannot be started');
  assert.equal((await inventory.validateOperation(off.id, 'explode')).code, 'NUV_OPERATION_INVALID');
  await inventory.synchronize(connection, [vm('running', 'On', { attributes: { ...vm('x', 'x').attributes, powerState: 'running' } })]);
  assert.equal((await inventory.validateOperation(off.id, 'start')).code, 'NUV_RESOURCE_UNAVAILABLE', 'a missing VM is not available for operations');
});

test('applying an operation records the new power state, the operation and a new version', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  const before = (await inventory.list())[0];
  const after = await inventory.applyOperation(before.id, 'start', { observedFinalState: 'running' });
  assert.equal(after.attributes.powerState, 'running');
  assert.equal(after.version, before.version + 1);
  const row = (await db.pool.query('SELECT last_operation, last_operation_at FROM inventory.virtual_machines WHERE resource_id = $1', [before.id])).rows[0];
  assert.equal(row.last_operation, 'start');
  assert.ok(row.last_operation_at);
});

test('guest details from the last time a VM was running are kept, and labelled, while it is off', database, async () => {
  const running = vm('a', 'Alpha', { attributes: { ...vm('x', 'x').attributes, powerState: 'running' }, providerMetadata: { hostName: 'alpha.lab', toolsStatus: 'guestToolsRunning' } });
  const stopped = vm('a', 'Alpha', { providerMetadata: {} });
  await inventory.synchronize(connection, [running]);
  assert.equal((await inventory.list())[0].providerMetadata.hostName, 'alpha.lab');
  await inventory.synchronize(connection, [stopped]);
  const kept = (await inventory.list())[0].providerMetadata;
  assert.equal(kept.hostName, 'alpha.lab', 'the host name survives power-off');
  assert.equal(kept.toolsStatus, 'guestToolsRunning');
  assert.equal(kept.hostNameRetained, true);
  assert.equal(kept.lastPoweredOnHostName, 'alpha.lab');
  assert.match(kept.reporting.hostname, /Last reported while the VM was powered on/);
});

test('metrics count resources by state', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'Alpha'), vm('b', 'Beta'), vm('c', 'Gamma')]);
  await inventory.synchronize(connection, [vm('a', 'Alpha')]);
  assert.deepEqual(await inventory.metrics(), { resourcesTotal: 3, resourcesActive: 1, resourcesMissing: 2 });
  await inventory.retireConnection(connection.id);
  assert.deepEqual(await inventory.metrics(), { resourcesTotal: 3, resourcesActive: 0, resourcesMissing: 0 }, 'deleted resources are in the total but neither active nor missing');
});

// The same rule against the production tables: the connection's health, read in the same query as the resource, decides whether the power state is an observation.
const setHealth = (id, healthState, errorCode = null) => db.pool.query('UPDATE connections.provider_connections SET health_state=$2, last_error_code=$3 WHERE connection_id=$1', [id, healthState, errorCode]);
const oneVm = async () => (await inventory.list({ connectionId: connection.id }))[0];

test('an unreachable connection makes a VM\'s power state unknown and keeps every power operation available; recovery brings the state back', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'A', { attributes: { powerState: 'running', guestOs: 'x', vcpuCount: 1, memoryBytes: 1, storageBytes: 1, privateIps: [] }, providerMetadata: { toolsStatus: 'Running' } })]);
  const id = (await oneVm()).id;
  assert.deepEqual([(await inventory.get(id)).attributes.powerState, (await inventory.validateOperation(id, 'start')).ok], ['running', false]);

  await setHealth(connection.id, 'critical', 'NUV_AGENT_OFFLINE');
  const stale = await inventory.get(id);
  assert.deepEqual([stale.attributes.powerState, stale.attributes.lastKnownPowerState, stale.observation.state, stale.observation.reason], ['unknown', 'running', 'stale', 'NUV_AGENT_OFFLINE']);
  assert.equal((await oneVm()).attributes.powerState, 'unknown', 'list and get agree');
  assert.equal((await inventory.validateOperation(id, 'start')).ok, true);
  assert.deepEqual((await db.pool.query('SELECT power_state FROM inventory.virtual_machines WHERE resource_id=$1', [id])).rows[0], { power_state: 'running' }, 'the stored value is untouched');

  await setHealth(connection.id, 'healthy');
  assert.deepEqual([(await inventory.get(id)).attributes.powerState, (await inventory.validateOperation(id, 'start')).ok], ['running', false]);
});

test('an agent that has not reported for over two minutes makes its VMs stale even while the connection looks healthy', database, async () => {
  const seen = secondsAgo => ({ ...vm('a', 'A'), attributes: { powerState: 'running', guestOs: 'x', vcpuCount: 1, memoryBytes: 1, storageBytes: 1, privateIps: [] }, providerMetadata: { agentObservedAt: new Date(Date.now() - secondsAgo * 1000).toISOString() } });
  await inventory.synchronize(connection, [seen(10)]);
  assert.deepEqual([(await oneVm()).observation.state, (await oneVm()).attributes.powerState], ['live', 'running']);
  await inventory.synchronize(connection, [seen(300)]);
  const stale = await oneVm();
  assert.deepEqual([stale.observation.state, stale.observation.reason, stale.attributes.powerState], ['stale', 'no_recent_agent_update', 'unknown']);
});

test('a connection that is only degraded or not yet checked does not make its VMs stale', database, async () => {
  await inventory.synchronize(connection, [vm('a', 'A', { attributes: { powerState: 'running', guestOs: 'x', vcpuCount: 1, memoryBytes: 1, storageBytes: 1, privateIps: [] } })]);
  for (const health of ['unknown', 'degraded', 'healthy']) { await setHealth(connection.id, health); assert.equal((await oneVm()).observation.state, 'live', health); }
});


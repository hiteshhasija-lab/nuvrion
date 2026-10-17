import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresInfrastructureService } from '../src/postgres-infrastructure-service.js';
import { InfrastructureError } from '../src/infrastructure-rules.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production infrastructure store against a real PostgreSQL, as the restricted application role: the same behaviour as the file-backed store, plus what the table itself refuses.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const service = db ? new PostgresInfrastructureService(db.pool) : null;
after(async () => { await db?.drop(); });

let A, B;
const seedConnection = async name => {
  const id = randomUUID();
  await db.adminPool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, $2, 'vmware_vsphere', 'esxi', 'enabled', 'healthy')", [id, name]);
  return { id, name, providerType: 'vmware_vsphere' };
};
beforeEach(async () => { if (!db) return; await db.adminPool.query('TRUNCATE inventory.infrastructure_objects'); A = await seedConnection(`A ${randomUUID().slice(0, 6)}`); B = await seedConnection(`B ${randomUUID().slice(0, 6)}`); });
const host = (id, extra = {}) => ({ kind: 'host', nativeId: id, name: `esx-${id}`, parentNativeId: 'dc', attributes: { cpuCores: 8, product: 'VMware ESXi 8', ...extra } });

test('a first report creates the objects, a second updates them in place and counts what changed', database, async () => {
  assert.deepEqual(await service.synchronize(A, [host('h1'), host('h2'), { kind: 'datastore', nativeId: 'ds', name: 'datastore1', attributes: { capacityBytes: 100, freeBytes: 60, accessible: true } }]), { discovered: 3, created: 3, updated: 0, missing: 0 });
  const first = (await service.list({ connectionId: A.id })).find(object => object.nativeId === 'h1');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await service.synchronize(A, [host('h1', { cpuCores: 16 }), host('h2'), { kind: 'datastore', nativeId: 'ds', name: 'datastore1' }]), { discovered: 3, created: 0, updated: 3, missing: 0 });
  const second = (await service.list({ connectionId: A.id })).find(object => object.nativeId === 'h1');
  assert.equal(second.id, first.id); assert.equal(second.attributes.cpuCores, 16); assert.equal(second.providerType, 'vmware_vsphere');
  assert.equal(second.firstSeenAt.getTime(), first.firstSeenAt.getTime()); assert.ok(second.lastSeenAt > first.lastSeenAt);
  assert.deepEqual((await service.list({ connectionId: A.id, kind: 'datastore' }))[0].attributes, {}, 'attributes are replaced, not merged: what the provider no longer says is gone');
});

test('an object that drops out of the report is "missing" and returns "active"; another connection with the same identifiers is untouched', database, async () => {
  await service.synchronize(A, [host('h1'), host('h2')]); await service.synchronize(B, [host('h1'), host('h2')]);
  assert.equal((await service.synchronize(A, [host('h1')])).missing, 1);
  const states = async connection => Object.fromEntries((await service.list({ connectionId: connection.id })).map(object => [object.nativeId, object.lifecycleState]));
  assert.deepEqual(await states(A), { h1: 'active', h2: 'missing' }); assert.deepEqual(await states(B), { h1: 'active', h2: 'active' });
  await service.synchronize(A, [host('h1'), host('h2')]);
  assert.deepEqual(await states(A), { h1: 'active', h2: 'active' });
  assert.equal((await service.synchronize(A, [])).missing, 2, 'an empty report is the provider seeing nothing');
});

test('retiring a connection deletes its objects, once; the list filters and orders by kind then name', database, async () => {
  await service.synchronize(A, [host('b'), host('a'), { kind: 'cluster', nativeId: 'c', name: 'cl' }, { kind: 'network', nativeId: 'n', name: 'VLAN' }]);
  assert.deepEqual((await service.list({ connectionId: A.id })).map(object => `${object.kind}:${object.nativeId}`), ['cluster:c', 'host:a', 'host:b', 'network:n']);
  assert.deepEqual((await service.list({ connectionId: A.id, kind: 'host', lifecycleState: 'active' })).map(object => object.nativeId), ['a', 'b']);
  assert.equal(await service.retireConnection(A.id), 4);
  assert.equal(await service.retireConnection(A.id), 0);
  assert.ok((await service.list({ connectionId: A.id })).every(object => object.lifecycleState === 'deleted' && object.missingSince));
});

test('a bad report changes nothing: part of it is never stored, and a failure part way through is rolled back', database, async () => {
  await service.synchronize(A, [host('h1')]);
  await assert.rejects(() => service.synchronize(A, [host('h2'), { kind: 'bogus', nativeId: 'x' }]), error => error instanceof InfrastructureError);
  await assert.rejects(() => service.synchronize({ id: randomUUID(), providerType: 'vmware_vsphere' }, [host('h9')]), /foreign key/, 'an unknown connection fails at the table');
  assert.deepEqual((await service.list({ connectionId: A.id })).map(object => object.nativeId), ['h1']);
  assert.equal((await service.list()).length, 1);
});

test('the table refuses a kind outside the closed list and a duplicate object; the application role cannot change the schema', database, async () => {
  const insert = (kind, nativeId) => db.adminPool.query("INSERT INTO inventory.infrastructure_objects(connection_id, kind, native_id, name, observed_at, first_seen_at, last_seen_at) VALUES($1, $2, $3, 'x', now(), now(), now())", [A.id, kind, nativeId]);
  await assert.rejects(() => insert('vm', 'x'), /check constraint|violates check/);
  await insert('host', 'dup');
  await assert.rejects(() => insert('host', 'dup'), /duplicate key|unique constraint/);
  await assert.rejects(() => db.pool.query('ALTER TABLE inventory.infrastructure_objects ADD COLUMN x int'), /must be owner|permission denied/);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM inventory.infrastructure_objects')).rows[0].n, 1, 'and the application role can read it');
});

test('two syncs of the same connection at once leave one consistent set, not duplicates', database, async () => {
  const report = Array.from({ length: 20 }, (_, i) => host(`h${i}`));
  await Promise.all([service.synchronize(A, report), service.synchronize(A, report), service.synchronize(A, report)]);
  assert.equal((await service.list({ connectionId: A.id })).length, 20);
});

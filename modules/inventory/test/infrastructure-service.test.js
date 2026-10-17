import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfrastructureService } from '../src/infrastructure-service.js';
import { InfrastructureError } from '../src/infrastructure-rules.js';

// The file-backed infrastructure store: what a report creates, updates and marks missing, what survives a restart, and that a bad report changes nothing.
const A = { id: '3f2b8c1e-5a47-4d3e-9b0a-1c2d3e4f5a6b', providerType: 'vmware_vsphere' }, B = { id: '4a3c9d2f-6b58-4e4f-8c1b-2d3e4f5a6b7c', providerType: 'vmware_vsphere' };
const host = (id, extra = {}) => ({ kind: 'host', nativeId: id, name: `esx-${id}`, parentNativeId: 'dc', attributes: { cpuCores: 8, ...extra } });
const withFile = async work => { const dir = mkdtempSync(join(tmpdir(), 'nuvrion-infra-')); try { return await work(join(dir, 'infrastructure.json')); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('a first report creates the objects; a second updates them in place (same identity, newer observation) and counts what changed', () => withFile(async file => {
  const service = new InfrastructureService({ file });
  assert.deepEqual(await service.synchronize(A, [host('h1'), host('h2'), { kind: 'datastore', nativeId: 'ds', name: 'datastore1' }]), { discovered: 3, created: 3, updated: 0, missing: 0 });
  const first = (await service.list({ connectionId: A.id })).find(object => object.nativeId === 'h1');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await service.synchronize(A, [host('h1', { cpuCores: 16 }), host('h2'), { kind: 'datastore', nativeId: 'ds', name: 'datastore1' }]), { discovered: 3, created: 0, updated: 3, missing: 0 });
  const second = (await service.list({ connectionId: A.id })).find(object => object.nativeId === 'h1');
  assert.equal(second.id, first.id, 'the same object keeps its identity'); assert.equal(second.attributes.cpuCores, 16);
  assert.equal(second.firstSeenAt, first.firstSeenAt); assert.ok(second.lastSeenAt > first.lastSeenAt);
}));

test('an object missing from the next report becomes "missing" and comes back "active" when it reappears; other connections are untouched', () => withFile(async file => {
  const service = new InfrastructureService({ file });
  await service.synchronize(A, [host('h1'), host('h2')]); await service.synchronize(B, [host('h1')]);
  assert.equal((await service.synchronize(A, [host('h1')])).missing, 1);
  const states = async connection => Object.fromEntries((await service.list({ connectionId: connection.id })).map(object => [object.nativeId, object.lifecycleState]));
  assert.deepEqual(await states(A), { h1: 'active', h2: 'missing' }); assert.deepEqual(await states(B), { h1: 'active' });
  assert.ok((await service.list({ connectionId: A.id, lifecycleState: 'missing' }))[0].missingSince);
  await service.synchronize(A, [host('h1'), host('h2')]);
  assert.deepEqual(await states(A), { h1: 'active', h2: 'active' }); assert.equal((await service.list({ connectionId: A.id })).find(o => o.nativeId === 'h2').missingSince, null);
}));

test('an empty report marks everything missing (the provider sees nothing); retiring a connection marks its objects deleted', () => withFile(async file => {
  const service = new InfrastructureService({ file });
  await service.synchronize(A, [host('h1'), host('h2')]);
  assert.equal((await service.synchronize(A, [])).missing, 2);
  assert.equal(await service.retireConnection(A.id), 2);
  assert.deepEqual((await service.list({ connectionId: A.id })).map(object => object.lifecycleState), ['deleted', 'deleted']);
  assert.equal(await service.retireConnection(A.id), 0, 'retiring twice changes nothing');
  assert.equal(await service.retireConnection('nobody'), 0);
}));

test('a bad report is refused and changes nothing, even part of it', () => withFile(async file => {
  const service = new InfrastructureService({ file });
  await service.synchronize(A, [host('h1')]);
  await assert.rejects(() => service.synchronize(A, [host('h2'), { kind: 'bogus', nativeId: 'x' }]), error => error instanceof InfrastructureError);
  await assert.rejects(() => service.synchronize(A, [host('h3'), host('h3')]), /twice/);
  assert.deepEqual((await service.list({ connectionId: A.id })).map(object => [object.nativeId, object.lifecycleState]), [['h1', 'active']]);
}));

test('the list is filtered by connection, kind and state, sorted by kind then name, and hands out copies', () => withFile(async file => {
  const service = new InfrastructureService({ file });
  await service.synchronize(A, [host('b'), host('a'), { kind: 'datastore', nativeId: 'd', name: 'zeta' }, { kind: 'cluster', nativeId: 'c', name: 'cl' }]);
  assert.deepEqual((await service.list()).map(object => object.kind), ['cluster', 'datastore', 'host', 'host']);
  assert.deepEqual((await service.list({ kind: 'host' })).map(object => object.nativeId), ['a', 'b']);
  assert.equal((await service.list({ connectionId: B.id })).length, 0);
  (await service.list({ kind: 'host' }))[0].attributes.cpuCores = 999;
  assert.equal((await service.list({ kind: 'host' }))[0].attributes.cpuCores, 8, 'changing a listed object does not change the store');
}));

test('the store survives a restart, the file is private, and no temporary file is left', () => withFile(async file => {
  await new InfrastructureService({ file }).synchronize(A, [host('h1')]);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.ok(!existsSync(`${file}.tmp`));
  assert.deepEqual((await new InfrastructureService({ file }).list()).map(object => object.nativeId), ['h1']);
  assert.deepEqual(await new InfrastructureService().list(), [], 'with no file it is in memory only');
}));

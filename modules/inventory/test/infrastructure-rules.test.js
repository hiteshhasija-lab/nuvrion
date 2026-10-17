import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, MAX_OBJECTS, ATTRIBUTES, InfrastructureError, normaliseObject, normaliseReport } from '../src/infrastructure-rules.js';

// What a provider says about its infrastructure is turned into a small fixed shape; everything else is dropped. Providers are not trusted.
const refuses = (run, code, pattern) => assert.throws(run, error => error instanceof InfrastructureError && error.code === code && pattern.test(error.message), String(pattern));

test('an object keeps its kind, identifier, name and parent, and only the attributes its kind has, cleaned', () => {
  const host = normaliseObject({ kind: 'host', nativeId: '  host-1 ', name: ' esx01 ', parentNativeId: 'cluster-1', attributes: { powerState: 'poweredOn', cpuCores: 24, memoryBytes: 274877906944, secret: 'x', password: 'hunter2' } });
  assert.deepEqual(host, { kind: 'host', nativeId: 'host-1', name: 'esx01', parentNativeId: 'cluster-1', attributes: { powerState: 'poweredOn', cpuCores: 24, memoryBytes: 274877906944 } });
  assert.deepEqual(normaliseObject({ kind: 'datastore', nativeId: 'ds1', name: 'datastore1', attributes: { type: 'VMFS', capacityBytes: 100, freeBytes: 40, accessible: true, url: 'ds:///x', cpuCores: 5 } }).attributes,
    { type: 'VMFS', capacityBytes: 100, freeBytes: 40, accessible: true, url: 'ds:///x' }, 'a host attribute on a datastore is dropped');
  assert.deepEqual(normaliseObject({ kind: 'network', nativeId: 'n1', name: 'VLAN 10', attributes: { type: 'distributed', accessible: false } }).attributes, { type: 'distributed', accessible: false });
  assert.deepEqual(normaliseObject({ kind: 'cluster', nativeId: 'c1', name: 'C', attributes: { hostCount: 3, drsEnabled: true, haEnabled: false } }).attributes, { hostCount: 3, drsEnabled: true, haEnabled: false });
  assert.deepEqual(normaliseObject({ kind: 'datacenter', nativeId: 'dc', name: 'DC', attributes: { anything: 1 } }).attributes, {});
});

test('a missing name falls back to the identifier, a missing parent is null, missing attributes are fine', () => {
  assert.deepEqual(normaliseObject({ kind: 'network', nativeId: 'network-7' }), { kind: 'network', nativeId: 'network-7', name: 'network-7', parentNativeId: null, attributes: {} });
  assert.equal(normaliseObject({ kind: 'network', nativeId: 'n', name: '   ' }).name, 'n');
});

test('numbers must be real non-negative integers and flags real booleans: anything else is dropped, not coerced', () => {
  const host = normaliseObject({ kind: 'host', nativeId: 'h', attributes: { cpuCores: -1, cpuMhz: 1.5, memoryBytes: '1024', cpuUsageMhz: NaN, memoryUsageBytes: Infinity, uptimeSeconds: Number.MAX_SAFE_INTEGER + 2, powerState: 7, product: null, version: {} } });
  assert.deepEqual(host.attributes, {});
  assert.deepEqual(normaliseObject({ kind: 'datastore', nativeId: 'd', attributes: { accessible: 'yes', capacityBytes: 0 } }).attributes, { capacityBytes: 0 }, 'zero is a number; "yes" is not a flag');
});

test('strings are trimmed and bounded, lose control and invisible characters, and a hostile provider cannot send a huge one', () => {
  const object = normaliseObject({ kind: 'host', nativeId: 'h\u0000​1', name: `esx\n01${'x'.repeat(1000)}`, parentNativeId: 'p'.repeat(500), attributes: { cpuModel: 'Intel‮ Xeon', product: 'p'.repeat(10_000), version: '8.0\r\n3' } });
  assert.equal(object.nativeId, 'h1'); assert.equal(object.name.length, 256); assert.ok(!object.name.includes('\n'));
  assert.equal(object.parentNativeId.length, 256); assert.equal(object.attributes.cpuModel, 'Intel Xeon'); assert.equal(object.attributes.version, '8.03');
  assert.equal(object.attributes.product, undefined, 'a string far over the limit is dropped, not truncated into plausible data');
});

test('an unknown kind, no identifier, or something that is not an object is refused with a reason', () => {
  for (const bad of [null, undefined, 'host', 5, [], { nativeId: 'x' }, { kind: 'vm', nativeId: 'x' }, { kind: 'Host', nativeId: 'x' }, { kind: '__proto__', nativeId: 'x' }]) refuses(() => normaliseObject(bad), 'NUV_INFRASTRUCTURE_INVALID', /Unknown infrastructure kind/);
  for (const bad of [{ kind: 'host' }, { kind: 'host', nativeId: '' }, { kind: 'host', nativeId: '  ' }, { kind: 'host', nativeId: 5 }, { kind: 'host', nativeId: '\u0000' }]) refuses(() => normaliseObject(bad), 'NUV_INFRASTRUCTURE_INVALID', /without an identifier/);
});

test('a report is a list with no object twice and not too many; the same identifier under different kinds is fine', () => {
  assert.equal(normaliseReport([]).length, 0);
  assert.equal(normaliseReport([{ kind: 'host', nativeId: 'same' }, { kind: 'datastore', nativeId: 'same' }]).length, 2);
  refuses(() => normaliseReport([{ kind: 'host', nativeId: 'a' }, { kind: 'host', nativeId: ' a ' }]), 'NUV_INFRASTRUCTURE_INVALID', /reported twice/);
  for (const bad of [null, {}, 'x', 5]) refuses(() => normaliseReport(bad), 'NUV_INFRASTRUCTURE_INVALID', /must be a list/);
  refuses(() => normaliseReport(Array.from({ length: MAX_OBJECTS + 1 }, (_, i) => ({ kind: 'network', nativeId: `n${i}` }))), 'NUV_INFRASTRUCTURE_TOO_LARGE', /limit is 5000/);
  assert.equal(normaliseReport(Array.from({ length: MAX_OBJECTS }, (_, i) => ({ kind: 'network', nativeId: `n${i}` }))).length, MAX_OBJECTS);
});

test('every kind has an attribute table, and the closed list of kinds is the one the database and the API accept', () => {
  assert.deepEqual([...KINDS], ['datacenter', 'cluster', 'host', 'datastore', 'network']);
  assert.deepEqual(Object.keys(ATTRIBUTES), [...KINDS]);
});

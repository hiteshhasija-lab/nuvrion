import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationProvider, WorkstationProviderError, normalizeWorkstationHardware } from '../src/workstation-provider.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';
import { fakeWorkstationRest, sampleWorkstationRestVm } from '../../test-support/fake-workstation-rest.js';

// The legacy Workstation provider talks straight to the Workstation Pro REST API (vmrest). It is still reachable for connections that are not agent-based, so these
// tests run it against a simulated REST API. They check our mapping and error handling, not the behaviour of a real Workstation.
const CREDENTIAL = { username: 'admin', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const make = (fake, over = {}) => new WorkstationProvider({ endpointUri: 'https://workstation.lab.example:8697/', credential: CREDENTIAL, fetchImpl: fake.fetch, timeoutMs: 2000, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof WorkstationProviderError && error.code === code && check(error), code);
const puts = fake => fake.calls.filter(call => call.method === 'PUT').map(call => JSON.parse(call.body));

defineProviderContract('WorkstationProvider (simulated REST API)', () => make(fakeWorkstationRest()), { strictReferences: true });

test('an endpoint must use HTTPS, except on the local machine', () => {
  const fake = fakeWorkstationRest();
  assert.throws(() => new WorkstationProvider({ endpointUri: 'http://workstation.example', credential: CREDENTIAL, fetchImpl: fake.fetch }), e => e.code === 'NUV_VMWARE_TLS_REQUIRED');
  assert.ok(new WorkstationProvider({ endpointUri: 'http://localhost:8697', credential: CREDENTIAL, fetchImpl: fake.fetch }));
  assert.ok(new WorkstationProvider({ endpointUri: 'http://127.0.0.1:8697', credential: CREDENTIAL, fetchImpl: fake.fetch }));
});

test('every request carries the Basic credential and the vmrest media type; a body is sent as JSON', async () => {
  const fake = fakeWorkstationRest(), provider = make(fake);
  await provider.testConnection();
  await provider.execute('start', 'vm-1');
  const [list, put] = fake.calls;
  assert.equal(list.authorization, `Basic ${Buffer.from('admin:correct-password').toString('base64')}`);
  assert.deepEqual([put.method, put.path, put.contentType, put.body], ['PUT', '/api/vms/vm-1/power', 'application/vnd.vmware.vmw.rest-v1+json', '"on"']);
});

test('testConnection reports a healthy host and what it can do', async () => {
  const result = await make(fakeWorkstationRest()).testConnection();
  assert.deepEqual([result.status, result.provider, result.capabilities], ['healthy', 'vmware_workstation', ['inventory', 'power.start', 'power.stop', 'power.restart', 'power.pause']]);
});

test('HTTP and connection failures are classified, and only server-side failures are retryable', async () => {
  const cases = [[401, 'NUV_WORKSTATION_AUTH_FAILED', false], [403, 'NUV_WORKSTATION_PERMISSION_DENIED', false], [404, 'NUV_WORKSTATION_RESOURCE_NOT_FOUND', false], [409, 'NUV_WORKSTATION_STATE_CONFLICT', false], [400, 'NUV_WORKSTATION_REQUEST_FAILED', false], [500, 'NUV_WORKSTATION_UNAVAILABLE', true], [503, 'NUV_WORKSTATION_UNAVAILABLE', true]];
  for (const [status, code, retryable] of cases) {
    const fake = fakeWorkstationRest(); fake.faults.status.set('GET /api/vms', { status, body: { Message: 'because of reasons' } });
    await rejectsWith(() => make(fake).testConnection(), code, e => e.status === status && e.retryable === retryable && e.message === 'because of reasons');
  }
  const plain = fakeWorkstationRest(); plain.faults.status.set('GET /api/vms', { status: 502, body: '<html>Bad gateway</html>' });
  await rejectsWith(() => make(plain).testConnection(), 'NUV_WORKSTATION_UNAVAILABLE', e => /returned HTTP 502/.test(e.message));
  const down = fakeWorkstationRest(); down.faults.unreachable = true;
  await rejectsWith(() => make(down).testConnection(), 'NUV_WORKSTATION_UNREACHABLE', e => e.retryable === true && /ECONNREFUSED/.test(e.message));
});

test('a wrong password is an authentication failure that is not retried', async () => {
  const fake = fakeWorkstationRest();
  await rejectsWith(() => make(fake, { credential: { username: 'admin', password: 'wrong' } }).discover(), 'NUV_WORKSTATION_AUTH_FAILED', e => e.retryable === false && e.status === 401); // secret-scan:allow (fake test credential)
});

test('discovery maps a VM: identity, guest, CPU, memory in bytes, disks, network and the raw power state', async () => {
  const fake = fakeWorkstationRest({ vms: [sampleWorkstationRestVm('vm-9', { name: 'build-01', power: 'poweredOn' })] });
  const [vm] = await make(fake).discover();
  assert.deepEqual([vm.resourceType, vm.nativeId, vm.name, vm.healthState], ['virtual_machine', 'vm-9', 'build-01', 'unknown']);
  assert.deepEqual({ ...vm.attributes }, { powerState: 'running', guestOs: 'windows9-64', vcpuCount: 2, memoryBytes: 4096 * 1048576, storageBytes: 40 * 1024 ** 3, privateIps: [], publicIps: [], region: 'local-workstation', availabilityZone: null, providerShape: null });
  assert.deepEqual([vm.providerMetadata.path, vm.providerMetadata.rawPowerState, vm.providerMetadata.hardware.source, vm.providerMetadata.hardware.networkAdapters[0].macAddress], ['C:\\VMs\\vm-9\\vm-9.vmx', 'poweredOn', 'workstation-rest', '00:0c:29:aa:bb:cc']);
});

test('power states are mapped; an unfamiliar state is passed on in lower case rather than hidden', async () => {
  const states = { on: 'poweredOn', off: 'poweredOff', paused: 'paused', susp: 'suspended', odd: 'Resuming' };
  const fake = fakeWorkstationRest({ vms: Object.entries(states).map(([id, power]) => sampleWorkstationRestVm(id, { power })) });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v.attributes.powerState]));
  assert.deepEqual(found, { on: 'running', off: 'stopped', paused: 'suspended', susp: 'suspended', odd: 'resuming' });
});

test('the VM name comes from the details, then the list, then the .vmx file name, then the id; a VM with no details is still reported', async () => {
  const fake = fakeWorkstationRest({ vms: [sampleWorkstationRestVm('a', { name: 'from-details' }), sampleWorkstationRestVm('b'), sampleWorkstationRestVm('c', { path: '' })] });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v.name]));
  assert.deepEqual(found, { a: 'from-details', b: 'b', c: 'c' });
  const bare = fakeWorkstationRest({ vms: [{ id: 'bare', path: '/home/u/vms/Win 11/Win 11.vmx', power: 'poweredOn', details: {} }] });
  const [vm] = await make(bare).discover();
  assert.deepEqual([vm.name, vm.attributes.vcpuCount, vm.attributes.memoryBytes, vm.attributes.storageBytes, vm.attributes.guestOs, vm.providerMetadata.hardware], ['Win 11', null, null, null, null, null]);
});

test('storage is reported only when every disk reports its size', async () => {
  const two = [{ id: 'a', capacityBytes: 10 }, { id: 'b', capacityBytes: 20 }], partial = [{ id: 'a', capacityBytes: 10 }, { id: 'b' }];
  const fake = fakeWorkstationRest({ vms: [sampleWorkstationRestVm('full', { details: { hardware: { disks: two } } }), sampleWorkstationRestVm('some', { details: { hardware: { disks: partial } } })] });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v.attributes.storageBytes]));
  assert.deepEqual(found, { full: 30, some: null });
});

test('hardware is normalised from the different shapes the API reports, and is null when nothing is reported', () => {
  assert.equal(normalizeWorkstationHardware({}), null);
  const fromMap = normalizeWorkstationHardware({ disks: { 'sata0:0': { capacity_bytes: '1024', path: 'C:/d.vmdk' } }, nics: [{ key: 'e0', networkName: 'bridged', mac_address: 'aa', connected: 1, start_connected: 0 }], cdroms: [{ isoFile: 'D:/a.iso', connected: true }], usbControllers: [{ id: 'u', present: false }], videoCards: [{ memory_bytes: 8, three_d_enabled: true }], additionalDevices: [{ type: 'sound' }] });
  assert.deepEqual(fromMap.disks, [{ id: 'sata0:0', label: 'Hard disk 1', capacityBytes: 1024, type: null, backing: 'C:/d.vmdk', connected: null }]);
  assert.deepEqual([fromMap.networkAdapters[0].id, fromMap.networkAdapters[0].network, fromMap.networkAdapters[0].macAddress, fromMap.networkAdapters[0].connected, fromMap.networkAdapters[0].startConnected], ['e0', 'bridged', 'aa', true, false]);
  assert.deepEqual([fromMap.cdDvdDrives[0].media, fromMap.cdDvdDrives[0].label, fromMap.usbControllers[0].present, fromMap.videoCards[0].memoryBytes, fromMap.videoCards[0].threeDEnabled, fromMap.additionalDevices[0].label], ['D:/a.iso', 'CD/DVD drive 1', false, 8, true, 'Additional device 1']);
  assert.equal(normalizeWorkstationHardware({ hardware: { disks: [{ capacityBytes: 'lots' }] } }).disks[0].capacityBytes, null);
});

test('start, stop and pause send the matching power request; restart powers off and then on, in that order', async () => {
  const cases = [['start', ['on']], ['stop', ['off']], ['pause', ['pause']], ['restart', ['off', 'on']]];
  for (const [operation, expected] of cases) {
    const fake = fakeWorkstationRest(), provider = make(fake);
    const accepted = await provider.execute(operation, 'vm-1');
    assert.deepEqual([accepted.operation, accepted.targetId, puts(fake)], [operation, 'vm-1', expected], operation);
  }
});

test('an unsupported operation is refused before anything is sent', async () => {
  const fake = fakeWorkstationRest();
  await rejectsWith(() => make(fake).execute('format_disk', 'vm-1'), 'NUV_OPERATION_UNSUPPORTED');
  await rejectsWith(() => make(fake).execute('reboot_guest', 'vm-1'), 'NUV_OPERATION_UNSUPPORTED');
  assert.equal(fake.calls.length, 0);
});

test('verification confirms the state the operation should produce, and says "not yet" (retryable) when the VM is not there yet', async () => {
  const cases = [['start', 'running'], ['stop', 'stopped'], ['pause', 'suspended'], ['restart', 'running']];
  for (const [operation, final] of cases) {
    const fake = fakeWorkstationRest(), provider = make(fake);
    const result = await provider.verify((await provider.execute(operation, 'vm-1')).providerReference);
    assert.deepEqual([result.code, result.observedFinalState], ['NUV_OPERATION_VERIFIED', final], operation);
  }
  const fake = fakeWorkstationRest(), provider = make(fake), { providerReference } = await provider.execute('start', 'vm-1');
  fake.state.vms.get('vm-1').power = 'poweredOff';           // something else stopped it again before we checked
  await rejectsWith(() => provider.verify(providerReference), 'NUV_WORKSTATION_VERIFICATION_PENDING', e => e.retryable === true && /Expected running, observed stopped/.test(e.message));
});

test('a reference is verified once; unknown references are refused', async () => {
  const fake = fakeWorkstationRest(), provider = make(fake);
  await rejectsWith(() => provider.verify('workstation:made-up'), 'NUV_WORKSTATION_REFERENCE_INVALID');
  const { providerReference } = await provider.execute('pause', 'vm-1');
  await provider.verify(providerReference);
  await rejectsWith(() => provider.verify(providerReference), 'NUV_WORKSTATION_REFERENCE_INVALID');
});

test('an unknown VM, or a conflict reported by Workstation, comes back as a specific error', async () => {
  const fake = fakeWorkstationRest(), provider = make(fake);
  await rejectsWith(() => provider.execute('start', 'no-such-vm'), 'NUV_WORKSTATION_RESOURCE_NOT_FOUND', e => e.status === 404 && /was not found/.test(e.message));
  fake.faults.status.set('PUT /api/vms/vm-1/power', { status: 409, body: { Message: 'The VM is in a state that does not allow this.' } });
  await rejectsWith(() => provider.execute('start', 'vm-1'), 'NUV_WORKSTATION_STATE_CONFLICT', e => e.status === 409 && e.retryable === false);
});

test('a VM id with spaces or slashes is encoded in the request path', async () => {
  const id = 'my vm/1', fake = fakeWorkstationRest({ vms: [sampleWorkstationRestVm(id)] }), provider = make(fake);
  const [found] = await provider.discover();
  assert.equal(found.attributes.powerState, 'stopped');
  const { providerReference } = await provider.execute('start', id);
  assert.ok(fake.calls.some(call => call.path === '/api/vms/my%20vm%2F1/power' && call.method === 'PUT'));
  assert.equal((await provider.verify(providerReference)).observedFinalState, 'running');
  assert.ok(fake.calls.filter(call => call.method === 'GET' && call.path === '/api/vms/my%20vm%2F1/power').length >= 2, 'discovery and verification both encode the id');
});

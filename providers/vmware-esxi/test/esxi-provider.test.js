import test from 'node:test';
import assert from 'node:assert/strict';
import { EsxiProvider, EsxiProviderError } from '../src/esxi-provider.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';
import { fakeEsxi, sampleEsxiVm } from '../../test-support/fake-esxi.js';

// The standalone ESXi provider against a simulated ESXi host (its SOAP Web Services API and datastore file browser). Nothing here touches a
// network or a lab, so these tests check our mapping, state handling and error handling, not the behaviour of a real ESXi.
const CREDENTIAL = { username: 'root', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const make = (fake, over = {}) => new EsxiProvider({ endpointUri: 'https://esxi01.lab.example/', credential: CREDENTIAL, fetchImpl: fake.fetch, timeoutMs: 2000, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof EsxiProviderError && error.code === code && check(error), code);
// The provider waits one second between checks of a guest shutdown or restart (and half a second between checks of a power task); run those waits on a mocked clock.
async function settle(t, promise) {
  let done = false, value, failure;
  promise.then(v => { done = true; value = v; }, e => { done = true; failure = e; });
  for (let i = 0; !done && i < 5000; i++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000); }
  if (!done) assert.fail('the operation never finished');
  if (failure) throw failure;
  return value;
}
const quick = fake => { fake.state.taskPolls = 1; fake.state.shutdownPolls = 1; fake.state.rebootPolls = 1; return fake; };

defineProviderContract('EsxiProvider (simulated ESXi)', () => make(quick(fakeEsxi({ vms: [sampleEsxiVm('vm-1', { power: 'poweredOff' }), sampleEsxiVm('vm-2')] }))), { strictReferences: true, optional: ['media', 'snapshots'] });

test('a standalone ESXi endpoint must use HTTPS, except on the local machine', () => {
  const fake = fakeEsxi();
  assert.throws(() => new EsxiProvider({ endpointUri: 'http://esxi.example', credential: CREDENTIAL, fetchImpl: fake.fetch }), e => e.code === 'NUV_VMWARE_TLS_REQUIRED');
  assert.ok(new EsxiProvider({ endpointUri: 'http://localhost:8443', credential: CREDENTIAL, fetchImpl: fake.fetch }));
});

test('testConnection reports a healthy host with what it can do, and closes its session', async () => {
  const fake = fakeEsxi();
  const result = await make(fake).testConnection();
  assert.deepEqual([result.status, result.provider], ['healthy', 'vmware_esxi']);
  for (const capability of ['inventory', 'console.webmks', 'media.mount', 'snapshot.revert', 'settings.update', 'power.guest_restart']) assert.ok(result.capabilities.includes(capability), capability);
  assert.deepEqual([fake.state.sessionsOpened, fake.state.sessionsClosed, fake.openSessions()], [1, 1, 0]);
  assert.deepEqual(fake.soapCalls(), ['RetrieveServiceContent', 'Login', 'Logout']);
});

test('connection failures are classified: unreachable, an endpoint that is not ESXi, HTTP errors, a wrong password', async () => {
  const down = fakeEsxi(); down.faults.unreachable = true;
  await rejectsWith(() => make(down).testConnection(), 'NUV_ESXI_UNREACHABLE', e => e.retryable === true && /ECONNREFUSED/.test(e.message));
  const notEsxi = fakeEsxi(); notEsxi.faults.emptyServiceContent = true;
  await rejectsWith(() => make(notEsxi).testConnection(), 'NUV_ESXI_PROTOCOL_ERROR', e => e.retryable === false);
  for (const [status, code, retryable] of [[401, 'NUV_ESXI_AUTH_FAILED', false], [403, 'NUV_ESXI_PERMISSION_DENIED', false], [404, 'NUV_ESXI_RESOURCE_NOT_FOUND', false], [400, 'NUV_ESXI_REQUEST_FAILED', false], [503, 'NUV_ESXI_UNAVAILABLE', true]]) {
    const fake = fakeEsxi(); fake.faults.http.set('RetrieveServiceContent', { status, message: 'refused' });
    await rejectsWith(() => make(fake).testConnection(), code, e => e.status === status && e.retryable === retryable);
  }
});

test('a wrong password is an authentication failure that is not retried, never an outage', async () => {
  // vSphere reports a wrong password as a SOAP fault carried in HTTP 500. If that were treated as "ESXi unavailable" (retryable) the platform would keep
  // trying the wrong password on a schedule, which can lock the root account.
  const fake = fakeEsxi();
  await rejectsWith(() => make(fake, { credential: { username: 'root', password: 'wrong' } }).testConnection(), 'NUV_ESXI_AUTH_FAILED', e => e.retryable === false && /incorrect user name or password/.test(e.message)); // secret-scan:allow (fake test credential)
  assert.equal(fake.openSessions(), 0);
});

test('hostIdentity returns the configured host name and the management address, and fails clearly when the host has no name', async () => {
  const identity = await make(fakeEsxi({ hostName: 'esxi07.lab.example' })).hostIdentity();
  assert.deepEqual(identity, { hostName: 'esxi07.lab.example', managementAddress: 'esxi01.lab.example', source: 'esxi_management_api' });
  await rejectsWith(() => make(fakeEsxi({ hostName: '' })).hostIdentity(), 'NUV_ESXI_HOST_IDENTITY_UNAVAILABLE', e => e.retryable === true);
});

test('discovery maps a VM: identity, health, power, guest, CPU, memory, disks, network, tools and measurements', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-9', { name: 'db-01', overall: 'green' })] });
  const [vm] = await make(fake).discover();
  assert.deepEqual([vm.resourceType, vm.nativeId, vm.name, vm.healthState], ['virtual_machine', 'vm-9', 'db-01', 'healthy']);
  assert.deepEqual(
    { power: vm.attributes.powerState, os: vm.attributes.guestOs, cpu: vm.attributes.vcpuCount, mem: vm.attributes.memoryBytes, storage: vm.attributes.storageBytes, ips: vm.attributes.privateIps, host: vm.attributes.availabilityZone },
    { power: 'running', os: 'Ubuntu Linux (64-bit)', cpu: 2, mem: 4096 * 1048576, storage: 40 * 1024 ** 3, ips: ['10.0.0.60'], host: 'esxi01.lab.example' });
  assert.deepEqual([vm.providerMetadata.hostName, vm.providerMetadata.toolsRunningStatus, vm.providerMetadata.toolsVersionStatus, vm.providerMetadata.guestState, vm.providerMetadata.managedObjectReference], ['vm-9.lab.example', 'guestToolsRunning', 'guestToolsCurrent', 'running', 'vm-9']);
  assert.deepEqual({ cpu: vm.metrics.cpuUsageMhz, mem: vm.metrics.memoryUsedBytes, active: vm.metrics.memoryActiveBytes, pct: Math.round(vm.metrics.memoryUtilizationPercent), storage: vm.metrics.storageUsedBytes, source: vm.metrics.source }, { cpu: 800, mem: 1024 * 1048576, active: 512 * 1048576, pct: 25, storage: 30 * 1024 ** 3, source: 'esxi_quickstats' });
  const hardware = vm.providerMetadata.hardware;
  assert.deepEqual([hardware.disks.length, hardware.networkAdapters[0].macAddress, hardware.networkAdapters[0].network, hardware.cdDvdDrives[0].id, hardware.videoCards[0].memoryBytes, hardware.controllers.length], [1, '00:0c:29:11:22:33', 'VM Network', '3002', 8192 * 1024, 1]);
});

test('health comes from the host\'s overall status when it has one, and from the power state otherwise', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('green', { overall: 'green' }), sampleEsxiVm('yellow', { overall: 'yellow' }), sampleEsxiVm('red', { overall: 'red' }), sampleEsxiVm('none', { overall: null }), sampleEsxiVm('off', { overall: null, power: 'poweredOff' })] });
  const health = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v.healthState]));
  assert.deepEqual(health, { green: 'healthy', yellow: 'warning', red: 'critical', none: 'healthy', off: 'healthy' });
});

test('power states are mapped, and measurements are reported only for a powered-on VM that has them', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('on'), sampleEsxiVm('off', { power: 'poweredOff' }), sampleEsxiVm('sus', { power: 'suspended' }), sampleEsxiVm('bare', { quickStats: null })] });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v]));
  assert.deepEqual(['on', 'off', 'sus'].map(id => found[id].attributes.powerState), ['running', 'stopped', 'suspended']);
  assert.deepEqual([found.off.metrics, found.sus.metrics, found.bare.metrics], [null, null, null]);
  assert.ok(found.on.metrics);
});

test('memory use comes from the host figure, falling back to the guest figure, and never exceeds 100 percent', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('host-only', { quickStats: { cpu: 1, hostMem: 2048, guestMem: null, committed: 1, uncommitted: 1 } }), sampleEsxiVm('guest-only', { quickStats: { cpu: 1, hostMem: null, guestMem: 1024, committed: 1, uncommitted: 1 } }), sampleEsxiVm('over', { quickStats: { cpu: 1, hostMem: 99999, guestMem: 1, committed: 1, uncommitted: 1 } })] });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v.metrics]));
  assert.deepEqual([found['host-only'].memoryUsedBytes, found['host-only'].memoryActiveBytes], [2048 * 1048576, null]);
  assert.equal(found['guest-only'].memoryUsedBytes, 1024 * 1048576);
  assert.equal(found.over.memoryUtilizationPercent, 100);
});

test('names with XML special characters survive the round trip', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { name: 'R&D <prod> "main"' })] });
  assert.equal((await make(fake).discover())[0].name, 'R&D <prod> "main"');
});

test('a host with more VMs than one page is read page by page, losing none', async () => {
  const fake = fakeEsxi({ vms: Array.from({ length: 250 }, (_, i) => sampleEsxiVm(`vm-${i + 1}`)), pageSize: 100 });
  const found = await make(fake).discover();
  assert.equal(found.length, 250);
  assert.equal(new Set(found.map(v => v.nativeId)).size, 250);
  assert.equal(fake.soapCalls().filter(m => m === 'ContinueRetrievePropertiesEx').length, 2);
  assert.equal(fake.openSessions(), 0);
});

test('every operation closes its session, whether it succeeds or fails', async () => {
  const fake = quick(fakeEsxi()), provider = make(fake);
  await provider.discover(); await provider.testConnection(); await provider.hostIdentity(); await provider.acquireConsole('vm-1'); await provider.listMedia('vm-1');
  await assert.rejects(() => provider.acquireConsole('vm-nope'));
  await assert.rejects(() => provider.execute('stop', 'vm-nope'));
  await assert.rejects(() => provider.mountMedia('vm-1', { driveId: '3002', isoPath: 'bad path' }));
  await assert.rejects(() => provider.listMedia('vm-nope'));
  assert.equal(fake.openSessions(), 0, 'no ESXi session is left open');
});

test('each power operation sends the right SOAP call and ends in the right state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cases = [['start', 'poweredOff', 'PowerOnVM_Task', 'running'], ['power_off', 'poweredOn', 'PowerOffVM_Task', 'stopped'], ['restart', 'poweredOn', 'ResetVM_Task', 'running'], ['pause', 'poweredOn', 'SuspendVM_Task', 'suspended'], ['stop', 'poweredOn', 'ShutdownGuest', 'stopped']];
  for (const [operation, startState, soapMethod, final] of cases) {
    const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { power: startState })] }), provider = make(fake);
    const { providerReference, targetId } = await provider.execute(operation, 'vm-1');
    assert.equal(targetId, 'vm-1');
    assert.ok(fake.soapCalls().includes(soapMethod), `${operation} sends ${soapMethod}`);
    const result = await settle(t, provider.verify(providerReference));
    assert.equal(result.observedFinalState, final, operation);
    assert.equal(fake.state.vms.get('vm-1').power, { running: 'poweredOn', stopped: 'poweredOff', suspended: 'suspended' }[final]);
    assert.equal(fake.openSessions(), 0);
  }
});

test('an unsupported operation is refused before anything is sent', async () => {
  const fake = fakeEsxi();
  await rejectsWith(() => make(fake).execute('format_disk', 'vm-1'), 'NUV_OPERATION_UNSUPPORTED');
  assert.equal(fake.calls.length, 0);
});

test('a power task that ESXi rejects is reported as a failed task with ESXi\'s own message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1')] }), provider = make(fake);        // already powered on
  const { providerReference } = await provider.execute('start', 'vm-1');
  await rejectsWith(() => settle(t, provider.verify(providerReference)), 'NUV_ESXI_TASK_FAILED', e => /not allowed in the current state/.test(e.message));
  assert.equal(fake.openSessions(), 0, 'the session is closed after a failed task');
});

test('a power task that never finishes ends as a retryable timeout, and the session is still closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { power: 'poweredOff' })] }); fake.state.taskPolls = 100000;
  const provider = make(fake), { providerReference } = await provider.execute('start', 'vm-1');
  await rejectsWith(() => settle(t, provider.verify(providerReference)), 'NUV_ESXI_VERIFICATION_TIMEOUT', e => e.retryable === true);
  assert.equal(fake.openSessions(), 0);
});

test('a guest shutdown needs VMware Tools; without them the request is refused with ESXi\'s message', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { tools: 'guestToolsNotRunning' })] });
  await rejectsWith(() => make(fake).execute('stop', 'vm-1'), 'NUV_ESXI_UNAVAILABLE', e => /VMware Tools is not running/.test(e.message));
  assert.equal(fake.openSessions(), 0);
});

test('a guest shutdown is confirmed only when the VM really is powered off, and times out if the guest never acts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeEsxi(), provider = make(fake); fake.state.shutdownPolls = 4;
  const done = await settle(t, provider.verify((await provider.execute('stop', 'vm-1')).providerReference));
  assert.deepEqual([done.code, done.observedFinalState], ['NUV_OPERATION_VERIFIED', 'stopped']);
  const stuck = fakeEsxi(); stuck.state.guestIgnoresRequests = true;
  const sp = make(stuck), reference = (await sp.execute('stop', 'vm-1')).providerReference;
  await rejectsWith(() => settle(t, sp.verify(reference)), 'NUV_ESXI_VERIFICATION_TIMEOUT', e => e.retryable === true);
  assert.equal(stuck.openSessions(), 0);
});

test('a guest restart is confirmed after the tools went down and came back, and is not confirmed for a guest that never restarted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeEsxi(), provider = make(fake);
  const result = await settle(t, provider.verify((await provider.execute('reboot_guest', 'vm-1')).providerReference));
  assert.deepEqual([result.code, result.observedFinalState, result.shutdownMode], ['NUV_GUEST_RESTART_VERIFIED', 'running', 'graceful']);
  const idle = fakeEsxi(); idle.state.guestIgnoresRequests = true;
  const ip = make(idle), reference = (await ip.execute('reboot_guest', 'vm-1')).providerReference;
  await rejectsWith(() => settle(t, ip.verify(reference)), 'NUV_ESXI_VERIFICATION_TIMEOUT');
});

test('a reference is checked once: unknown and already-verified references are refused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = quick(fakeEsxi({ vms: [sampleEsxiVm('vm-1', { power: 'poweredOff' })] })), provider = make(fake);
  await rejectsWith(() => provider.verify('esxi:not-issued'), 'NUV_ESXI_REFERENCE_INVALID');
  const { providerReference } = await provider.execute('start', 'vm-1');
  await settle(t, provider.verify(providerReference));
  await rejectsWith(() => provider.verify(providerReference), 'NUV_ESXI_REFERENCE_INVALID');
});

test('the console: a WebMKS ticket is turned into a socket address on the management address, and a missing ticket is an error', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1'), sampleEsxiVm('vm-2', { noTicket: true })] }), provider = make(fake);
  const console = await provider.acquireConsole('vm-1');
  assert.equal(console.url, 'wss://esxi01.lab.example/ticket/cst-vm-1');
  assert.equal(console.serverName, 'esxi01.lab.example');
  assert.equal(console.transport, 'webmks');
  assert.ok(Date.parse(console.expiresAt) > Date.now());
  await rejectsWith(() => provider.acquireConsole('vm-2'), 'NUV_CONSOLE_TICKET_INVALID');
});

test('listing media shows the drives, the datastores and the ISO images found by browsing them', async () => {
  const media = await make(fakeEsxi()).listMedia('vm-1');
  assert.equal(media.provider, 'vmware_esxi');
  assert.deepEqual(media.drives.map(d => [d.id, d.connected, d.media]), [['3002', false, null]]);
  assert.deepEqual(media.datastores.map(d => d.name), ['datastore1']);
  assert.deepEqual(media.images, ['[datastore1] images/server.iso']);
});

test('mounting an ISO changes the drive and checks that ESXi reports it connected; a path that is not a datastore ISO is refused before anything is sent', async () => {
  const fake = quick(fakeEsxi()), provider = make(fake);
  const mounted = await provider.mountMedia('vm-1', { driveId: '3002', isoPath: '[datastore1] images/server.iso' });
  assert.deepEqual([mounted.code, mounted.drive.media, mounted.drive.connected, mounted.isoPath], ['NUV_MEDIA_MOUNTED', '[datastore1] images/server.iso', true, '[datastore1] images/server.iso']);
  const before = fake.calls.length;
  for (const isoPath of ['images/server.iso', '[datastore1] notes.txt', '[datastore1] ../x.iso']) await assert.rejects(() => provider.mountMedia('vm-1', { driveId: '3002', isoPath }), e => e.code === 'NUV_MEDIA_PATH_INVALID');
  assert.equal(fake.calls.length, before, 'nothing was sent for a refused path');
  await assert.rejects(() => provider.mountMedia('vm-1', { driveId: '9999', isoPath: '[datastore1] images/server.iso' }), e => e.code === 'NUV_MEDIA_DRIVE_NOT_FOUND' && e.status === 404);
});

test('ejecting media empties and disconnects the drive', async () => {
  const fake = quick(fakeEsxi()), provider = make(fake);
  await provider.mountMedia('vm-1', { driveId: '3002', isoPath: '[datastore1] images/server.iso' });
  const ejected = await provider.ejectMedia('vm-1', { driveId: '3002' });
  assert.deepEqual([ejected.code, ejected.drive.media, ejected.drive.connected], ['NUV_MEDIA_EJECTED', null, false]);
  assert.deepEqual([fake.state.vms.get('vm-1').cdroms[0].media, fake.openSessions()], [null, 0]);
});

test('a media change that ESXi rejects, or never finishes, is reported with ESXi\'s message or as a retryable timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = fakeEsxi(); rejected.faults.http.set('ReconfigVM_Task', { status: 500, message: 'The device is busy.', type: 'DeviceBusy' });
  await rejectsWith(() => make(rejected).mountMedia('vm-1', { driveId: '3002', isoPath: '[datastore1] images/server.iso' }), 'NUV_ESXI_UNAVAILABLE', e => /device is busy/.test(e.message));
  const slow = fakeEsxi(); slow.state.taskPolls = 100000;
  await rejectsWith(() => settle(t, make(slow).mountMedia('vm-1', { driveId: '3002', isoPath: '[datastore1] images/server.iso' })), 'NUV_MEDIA_VERIFICATION_TIMEOUT', e => e.retryable === true);
  assert.equal(slow.openSessions(), 0);
});

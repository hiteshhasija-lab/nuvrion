import test from 'node:test';
import assert from 'node:assert/strict';
import { VsphereProvider, VsphereProviderError } from '../src/vsphere-provider.js';
import { collectVsphereQuickStats } from '../src/vsphere-quickstats.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';
import { fakeVcenter, sampleVm } from '../../test-support/fake-vcenter.js';
import { fakeEsxi, sampleEsxiVm } from '../../test-support/fake-esxi.js';

// The vSphere (vCenter) provider against a simulated vCenter: what it reads, what it sends, and how it reacts to failures. Nothing here touches
// a network or a lab, so these tests check our mapping, state handling and error handling, not the behaviour of a real vCenter.
const CREDENTIAL = { username: 'administrator@vsphere.local', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const make = (fake, over = {}) => new VsphereProvider({ endpointUri: 'https://vcenter.example/', credential: CREDENTIAL, fetchImpl: fake.fetch, pollIntervalMs: 1, timeoutMs: 2000, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof VsphereProviderError && error.code === code && check(error), code);

defineProviderContract('VsphereProvider (simulated vCenter)', () => make(fakeVcenter({ vms: [sampleVm('vm-1'), sampleVm('vm-2')] })), { strictReferences: true, optional: ['media'] });

test('an endpoint must use HTTPS, except on the local machine', () => {
  const fake = fakeVcenter();
  assert.throws(() => new VsphereProvider({ endpointUri: 'http://vcenter.example', credential: CREDENTIAL, fetchImpl: fake.fetch }), error => error.code === 'NUV_VMWARE_TLS_REQUIRED');
  assert.ok(new VsphereProvider({ endpointUri: 'https://vcenter.example', credential: CREDENTIAL, fetchImpl: fake.fetch }));
  assert.ok(new VsphereProvider({ endpointUri: 'http://127.0.0.1:8443', credential: CREDENTIAL, fetchImpl: fake.fetch }));
});

test('testConnection reports a healthy vCenter with what it can do, and closes its session', async () => {
  const fake = fakeVcenter();
  const result = await make(fake).testConnection();
  assert.deepEqual([result.status, result.provider, result.identity], ['healthy', 'vmware_vsphere', CREDENTIAL.username]);
  for (const capability of ['inventory', 'console.webmks', 'media.mount', 'snapshot.create', 'settings.update', 'power.guest_restart']) assert.ok(result.capabilities.includes(capability), capability);
  assert.deepEqual([fake.state.sessionsOpened, fake.state.sessionsClosed, fake.openSessions()], [1, 1, 0]);
});

test('connection failures are classified: wrong password, no permission, missing, vCenter down, unreachable', async () => {
  const wrong = make(fakeVcenter(), { credential: { username: CREDENTIAL.username, password: 'wrong' } }); // secret-scan:allow (fake test credential)
  await rejectsWith(() => wrong.testConnection(), 'NUV_VMWARE_AUTH_FAILED', e => e.status === 401 && e.retryable === false);
  for (const [status, code, retryable] of [[403, 'NUV_VMWARE_PERMISSION_DENIED', false], [404, 'NUV_VMWARE_RESOURCE_NOT_FOUND', false], [400, 'NUV_VMWARE_REQUEST_FAILED', false], [500, 'NUV_VMWARE_UNAVAILABLE', true], [503, 'NUV_VMWARE_UNAVAILABLE', true]]) {
    const fake = fakeVcenter(); fake.faults.status.set('POST /api/session', status);
    await rejectsWith(() => make(fake).testConnection(), code, e => e.status === status && e.retryable === retryable);
  }
  const down = fakeVcenter(); down.faults.unreachable = true;
  await rejectsWith(() => make(down).testConnection(), 'NUV_VMWARE_UNREACHABLE', e => e.retryable === true && /ECONNREFUSED/.test(e.message));
});

test('discovery maps a VM: identity, power, guest, CPU, memory, disks, network, tools and where it lives', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-7', { name: 'web-01' })] });
  const [vm] = await make(fake).discover();
  assert.deepEqual([vm.resourceType, vm.nativeId, vm.name, vm.healthState], ['virtual_machine', 'vm-7', 'web-01', 'healthy']);
  assert.deepEqual(
    { power: vm.attributes.powerState, os: vm.attributes.guestOs, cpu: vm.attributes.vcpuCount, mem: vm.attributes.memoryBytes, storage: vm.attributes.storageBytes, ips: vm.attributes.privateIps, region: vm.attributes.region, host: vm.attributes.availabilityZone },
    { power: 'running', os: 'UBUNTU_64', cpu: 2, mem: 4096 * 1048576, storage: 50 * 1024 ** 3, ips: ['10.0.0.50'], region: 'on-premises', host: 'host-10' });
  assert.deepEqual([vm.providerMetadata.hostName, vm.providerMetadata.toolsStatus, vm.providerMetadata.toolsVersionStatus, vm.providerMetadata.host, vm.providerMetadata.rawPowerState], ['vm-7.lab.example', 'guestToolsRunning', 'CURRENT', 'host-10', 'POWERED_ON']);
  const hardware = vm.providerMetadata.hardware;
  assert.deepEqual(hardware.disks.map(d => d.capacityBytes), [40 * 1024 ** 3, 10 * 1024 ** 3]);
  assert.deepEqual([hardware.networkAdapters[0].network, hardware.networkAdapters[0].macAddress, hardware.networkAdapters[0].connected], ['VM Network', '00:50:56:aa:bb:cc', true]);
  assert.deepEqual([hardware.cdDvdDrives[0].media, hardware.cdDvdDrives[0].connected], [null, false]);
});

test('discovery turns power states into Nuvrion states, and reports measurements only for a running VM that has them', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('on'), sampleVm('off', { power: 'POWERED_OFF' }), sampleVm('sus', { power: 'SUSPENDED' }), sampleVm('odd', { power: 'MIGRATING' })] });
  const found = Object.fromEntries((await make(fake).discover()).map(v => [v.nativeId, v]));
  assert.deepEqual(['on', 'off', 'sus', 'odd'].map(id => found[id].attributes.powerState), ['running', 'stopped', 'suspended', 'migrating']);
  assert.deepEqual(['on', 'off', 'sus', 'odd'].map(id => found[id].healthState), ['healthy', 'healthy', 'healthy', 'unknown']);
  assert.deepEqual({ cpu: found.on.metrics.cpuUsageMhz, memUsed: found.on.metrics.memoryUsedBytes, active: found.on.metrics.memoryActiveBytes, pct: Math.round(found.on.metrics.memoryUtilizationPercent), storage: found.on.metrics.storageUsedBytes, source: found.on.metrics.source }, { cpu: 1500, memUsed: 2048 * 1048576, active: 1024 * 1048576, pct: 50, storage: 30 * 1024 ** 3, source: 'vsphere_quickstats' });
  assert.deepEqual([found.off.metrics, found.sus.metrics, found.odd.metrics], [null, null, null], 'no measurements for a VM that is not running');
});

test('a VM without the optional details (no guest identity, no tools) is still discovered; a failure of the main call is not hidden', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-1', { identity: null, tools: null, quickStats: null })] });
  const [vm] = await make(fake).discover();
  assert.deepEqual([vm.attributes.privateIps, vm.providerMetadata.hostName, vm.providerMetadata.toolsStatus, vm.metrics], [[], null, null, null]);
  const broken = fakeVcenter(); broken.faults.status.set('GET /api/vcenter/vm', 503);
  await rejectsWith(() => make(broken).discover(), 'NUV_VMWARE_UNAVAILABLE', e => e.retryable);
  const unauthorised = fakeVcenter(); unauthorised.faults.status.set('GET /api/vcenter/vm/vm-1', 500);
  await rejectsWith(() => make(unauthorised).discover(), 'NUV_VMWARE_UNAVAILABLE');
});

test('quick statistics are best effort: if that endpoint fails, discovery still works, just without measurements', async () => {
  const fake = fakeVcenter(); fake.faults.sdkFails = true;
  const [vm] = await make(fake).discover();
  assert.equal(vm.attributes.powerState, 'running');
  assert.equal(vm.metrics, null);
  const direct = await collectVsphereQuickStats({ endpointUri: 'https://vcenter.example', credential: CREDENTIAL, vmIds: ['vm-1'], fetchImpl: fakeVcenter().fetch });
  assert.equal(direct.get('vm-1').cpuUsageMhz, 1500);
  assert.equal((await collectVsphereQuickStats({ endpointUri: 'https://vcenter.example', credential: CREDENTIAL, vmIds: [], fetchImpl: () => assert.fail('no call for no VMs') })).size, 0);
});

test('more VMs than the lookup concurrency (20) are all discovered, in order, and the session stays open until the last one is read', async () => {
  const fake = fakeVcenter({ vms: Array.from({ length: 45 }, (_, i) => sampleVm(`vm-${i + 1}`)) });
  const found = await make(fake).discover();
  assert.deepEqual(found.map(v => v.nativeId), Array.from({ length: 45 }, (_, i) => `vm-${i + 1}`));
  assert.equal(fake.openSessions(), 0);
});

test('every operation closes its session, whether it succeeds or fails', async () => {
  const fake = fakeVcenter(), provider = make(fake);
  await provider.discover(); await provider.testConnection();
  await assert.rejects(() => provider.execute('start', 'vm-nope'));
  await assert.rejects(() => provider.acquireConsole('vm-nope'));
  await assert.rejects(() => provider.listMedia('vm-nope'));
  await assert.rejects(() => provider.mountMedia('vm-1', { driveId: '16000', isoPath: 'not an iso path' }));
  assert.equal(fake.openSessions(), 0, 'no vCenter session is left open');
  assert.equal(fake.state.sessionsOpened, fake.state.sessionsClosed);
});

test('each operation sends the right request to vCenter and the VM ends up in the right state', async () => {
  const cases = [['start', 'POWERED_OFF', 'POST', '/api/vcenter/vm/vm-1/power', 'start', 'running'], ['power_off', 'POWERED_ON', 'POST', '/api/vcenter/vm/vm-1/power', 'stop', 'stopped'], ['restart', 'POWERED_ON', 'POST', '/api/vcenter/vm/vm-1/power', 'reset', 'running'], ['pause', 'POWERED_ON', 'POST', '/api/vcenter/vm/vm-1/power', 'suspend', 'suspended'], ['stop', 'POWERED_ON', 'POST', '/api/vcenter/vm/vm-1/guest/power', 'shutdown', 'stopped']];
  for (const [operation, startState, method, path, action, final] of cases) {
    const fake = fakeVcenter({ vms: [sampleVm('vm-1', { power: startState })] }), provider = make(fake);
    const { providerReference, targetId } = await provider.execute(operation, 'vm-1');
    assert.equal(targetId, 'vm-1');
    assert.ok(fake.calls.some(c => c.method === method && c.path === path && c.action === action), `${operation} -> ${method} ${path}?action=${action}`);
    const result = await provider.verify(providerReference);
    assert.equal(result.observedFinalState, final, operation);
    assert.equal(result.providerReference, providerReference);
    assert.equal(fake.openSessions(), 0, `${operation}: session closed after verification`);
  }
});

test('an unsupported operation is refused before anything is sent', async () => {
  const fake = fakeVcenter();
  await rejectsWith(() => make(fake).execute('format_disk', 'vm-1'), 'NUV_OPERATION_UNSUPPORTED');
  assert.equal(fake.calls.length, 0);
});

test('a failed operation request is reported with its cause and leaves no session behind', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-1', { power: 'POWERED_OFF' })] });
  await rejectsWith(() => make(fake).execute('stop', 'vm-1'), 'NUV_VMWARE_REQUEST_FAILED', e => e.status === 400 && /not powered on/.test(e.message));
  await rejectsWith(() => make(fake).execute('start', 'vm-missing'), 'NUV_VMWARE_RESOURCE_NOT_FOUND');
  assert.equal(fake.openSessions(), 0);
});

test('a guest shutdown is confirmed only when the VM really powers off, and times out if the guest never acts', async () => {
  const fake = fakeVcenter(), provider = make(fake);
  fake.state.shutdownPolls = 5;
  const done = await provider.verify((await provider.execute('stop', 'vm-1')).providerReference);
  assert.equal(done.code, 'NUV_OPERATION_VERIFIED');
  assert.match(done.summary, /guest operating system shut down/);
  const stuck = fakeVcenter(); stuck.state.guestIgnoresRequests = true;
  const sp = make(stuck);
  await rejectsWith(async () => sp.verify((await sp.execute('stop', 'vm-1')).providerReference), 'NUV_VMWARE_VERIFICATION_TIMEOUT', e => e.retryable === true && /power state/.test(e.message) || /stopped/.test(e.message));
  assert.equal(stuck.openSessions(), 0, 'the session is closed even on a timeout');
});

test('a guest restart is confirmed only after VMware Tools went down and came back, or its restart time changed', async () => {
  const fake = fakeVcenter(), provider = make(fake);
  const result = await provider.verify((await provider.execute('reboot_guest', 'vm-1')).providerReference);
  assert.deepEqual([result.code, result.observedFinalState, result.shutdownMode], ['NUV_GUEST_RESTART_VERIFIED', 'running', 'graceful']);
  // a guest that never restarts must not be reported as restarted just because it is still running
  const idle = fakeVcenter(); idle.state.guestIgnoresRequests = true;
  const ip = make(idle);
  await rejectsWith(async () => ip.verify((await ip.execute('reboot_guest', 'vm-1')).providerReference), 'NUV_VMWARE_VERIFICATION_TIMEOUT', e => /guest restart/.test(e.message));
});

test('a reference is checked once: unknown and already-verified references are refused', async () => {
  const fake = fakeVcenter(), provider = make(fake);
  await rejectsWith(() => provider.verify('vsphere:not-issued'), 'NUV_VMWARE_REFERENCE_INVALID');
  const { providerReference } = await provider.execute('start', 'vm-1');
  await provider.verify(providerReference);
  await rejectsWith(() => provider.verify(providerReference), 'NUV_VMWARE_REFERENCE_INVALID');
});

test('the console: a WebMKS ticket is returned with an expiry, and a missing ticket is an error', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-1'), sampleVm('vm-2', { noTicket: true })] }), provider = make(fake);
  const console = await provider.acquireConsole('vm-1');
  assert.match(console.url, /^wss:\/\/vcenter\.example\/ticket\//);
  assert.equal(console.transport, 'webmks');
  assert.ok(Date.parse(console.expiresAt) > Date.now() && Date.parse(console.expiresAt) <= Date.now() + 5 * 60_000 + 1000);
  await rejectsWith(() => provider.acquireConsole('vm-2'), 'NUV_CONSOLE_TICKET_INVALID');
});

test('listing media shows drives, datastores and the ISO images found by browsing the datastores (one level of folders at a time)', async () => {
  const fake = fakeVcenter(), provider = make(fake);
  const media = await provider.listMedia('vm-1');
  assert.equal(media.provider, 'vmware_vcenter');
  assert.deepEqual(media.drives.map(d => [d.id, d.connected, d.media]), [['16000', false, null]]);
  assert.deepEqual(media.datastores.map(d => d.name), ['datastore1']);
  assert.deepEqual(media.images, ['[datastore1] images/server.iso', '[datastore1] images/tools/drivers.iso'], 'only .iso files, found in sub-folders, never links to other sites');
  assert.deepEqual(media.warnings, []);
});

test('media browsing problems become warnings, not failures', async () => {
  const fake = fakeVcenter(); fake.faults.status.set('* /folder/', 403);
  const media = await make(fake).listMedia('vm-1');
  assert.deepEqual(media.images, []);
  assert.equal(media.warnings[0].code, 'NUV_MEDIA_BROWSE_PERMISSION_DENIED');
  const missingDrive = fakeVcenter();
  await assert.rejects(() => make(missingDrive).listMedia('vm-missing'), e => e.code === 'NUV_VMWARE_RESOURCE_NOT_FOUND');
});

test('mounting an ISO on a powered-off VM sets the backing; on a running VM it also disconnects the old image first and connects the new one', async () => {
  const off = fakeVcenter({ vms: [sampleVm('vm-1', { power: 'POWERED_OFF' })] });
  const offResult = await make(off).mountMedia('vm-1', { driveId: '16000', isoPath: '[datastore1]  images/server.iso' });
  assert.equal(offResult.code, 'NUV_MEDIA_MOUNTED');
  assert.equal(offResult.isoPath, '[datastore1] images/server.iso', 'the path is normalised');
  assert.deepEqual(off.calls.filter(c => c.method !== 'GET' && c.path.includes('cdrom')).map(c => `${c.method}${c.action ? `:${c.action}` : ''}`), ['PATCH']);

  const on = fakeVcenter({ vms: [sampleVm('vm-1')] });
  on.state.vms.get('vm-1').cdroms['16000'] = { label: 'CD/DVD drive 1', backing: { type: 'ISO_FILE', iso_file: '[datastore1] images/old.iso' }, state: 'CONNECTED', start_connected: true, allow_guest_control: true };
  const onResult = await make(on).mountMedia('vm-1', { driveId: '16000', isoPath: '[datastore1] images/server.iso' });
  assert.deepEqual([onResult.drive.media, onResult.drive.connected], ['[datastore1] images/server.iso', true]);
  assert.deepEqual(on.calls.filter(c => c.method !== 'GET' && c.path.includes('cdrom')).map(c => `${c.method}${c.action ? `:${c.action}` : ''}`), ['POST:disconnect', 'PATCH', 'POST:connect'], 'disconnect, change, connect, in that order');
});

test('a bad ISO path is refused before anything is sent to the VM, with a clear code', async () => {
  const fake = fakeVcenter();
  for (const isoPath of ['images/server.iso', '[datastore1] images/readme.txt', '[datastore1] ../etc/shadow.iso', '', '[datastore1] a\u0000b.iso']) {
    await assert.rejects(() => make(fake).mountMedia('vm-1', { driveId: '16000', isoPath }), e => e.code === 'NUV_MEDIA_PATH_INVALID' && e.status === 422, JSON.stringify(isoPath));
  }
  assert.equal(fake.calls.filter(c => c.method !== 'GET').length, 0);
});

test('if vCenter never reports the media as mounted, the mount ends as a retryable verification failure', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-1', { power: 'POWERED_OFF' })] });
  const drive = fake.state.vms.get('vm-1').cdroms['16000'];
  const original = fake.fetch;
  const stubborn = (url, init) => { const result = original(url, init); if ((init?.method ?? 'GET') === 'PATCH') drive.backing = { type: 'CLIENT_DEVICE' }; return result; };   // vCenter accepts the change but does not keep it
  await rejectsWith(() => make({ fetch: stubborn }).mountMedia('vm-1', { driveId: '16000', isoPath: '[datastore1] images/server.iso' }), 'NUV_MEDIA_VERIFICATION_FAILED', e => e.retryable === true);
});

test('ejecting media disconnects a connected drive on a running VM and leaves it empty', async () => {
  const fake = fakeVcenter({ vms: [sampleVm('vm-1')] });
  fake.state.vms.get('vm-1').cdroms['16000'] = { label: 'CD/DVD drive 1', backing: { type: 'ISO_FILE', iso_file: '[datastore1] images/server.iso' }, state: 'CONNECTED', start_connected: true, allow_guest_control: true };
  const result = await make(fake).ejectMedia('vm-1', { driveId: '16000' });
  assert.deepEqual([result.code, result.drive.media, result.drive.connected], ['NUV_MEDIA_EJECTED', null, false]);
  assert.deepEqual(fake.calls.filter(c => c.method !== 'GET' && c.path.includes('cdrom')).map(c => `${c.method}${c.action ? `:${c.action}` : ''}`), ['POST:disconnect', 'PATCH']);
  await assert.rejects(() => make(fake).ejectMedia('vm-1', { driveId: 'no-such-drive' }), e => e.code === 'NUV_VMWARE_RESOURCE_NOT_FOUND');
});

// Snapshots and VM settings go through the shared VMware SOAP clients, which the vSphere provider builds from its own endpoint, credential, timeout and polling interval.
// This lab sends the REST calls to the simulated vCenter and the SOAP calls (/sdk) to a simulated host that keeps the snapshots and configuration of the same VMs.
function vcenterWithSoapHost({ ids = ['vm-1', 'vm-2'], password = CREDENTIAL.password } = {}) {
  const vcenter = fakeVcenter({ vms: ids.map(id => sampleVm(id)) }), host = fakeEsxi({ vms: ids.map(id => sampleEsxiVm(id)), username: CREDENTIAL.username, password });
  return { vcenter, host, fetch: (url, init) => new URL(url).pathname === '/sdk' ? host.fetch(url, init) : vcenter.fetch(url, init) };
}

defineProviderContract('VsphereProvider snapshots and settings (simulated vCenter + SOAP host)', () => make(vcenterWithSoapHost()), { strictReferences: true, optional: ['snapshots', 'settings'] });

test('snapshot and settings requests use the provider\'s own credential, so a wrong password is an authentication failure that is not retried', async () => {
  const lab = vcenterWithSoapHost({ password: 'another-password' }), provider = make(lab);                // secret-scan:allow (fake test credential)
  await assert.rejects(() => provider.listSnapshots('vm-1'), e => e.code === 'NUV_SNAPSHOT_AUTH_FAILED' && e.retryable === false);
  await assert.rejects(() => provider.getSettings('vm-1'), e => e.code === 'NUV_VM_SETTINGS_AUTH_FAILED' && e.retryable === false);
  assert.equal(lab.host.openSessions(), 0);
});

test('snapshot waits use the provider\'s polling interval, and a snapshot that never completes ends as a retryable timeout', async () => {
  const lab = vcenterWithSoapHost(); lab.host.state.taskPolls = 100000;
  const started = Date.now();
  await assert.rejects(() => make(lab, { pollIntervalMs: 1 }).createSnapshot('vm-1', { name: 'slow' }), e => e.code === 'NUV_SNAPSHOT_VERIFICATION_TIMEOUT' && e.retryable === true);
  assert.ok(Date.now() - started < 8000, 'a 1 ms interval over 120 attempts does not take minutes');
  assert.equal(lab.host.openSessions(), 0);
});

test('the SOAP clients talk to the provider\'s own endpoint', async () => {
  const lab = vcenterWithSoapHost(), seen = [];
  const provider = make({ fetch: (url, init) => { seen.push(new URL(url).host); return lab.fetch(url, init); } });
  await provider.listSnapshots('vm-1');
  await provider.getSettings('vm-1');
  assert.deepEqual([...new Set(seen)], ['vcenter.example']);
});

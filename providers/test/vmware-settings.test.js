import test from 'node:test';
import assert from 'node:assert/strict';
import { VmwareSettingsClient, VmwareSettingsError } from '../vmware-settings.js';
import { fakeEsxi, sampleEsxiVm } from '../test-support/fake-esxi.js';

// The settings client reads a VM's configuration and changes it through ReconfigVM_Task. VMware is strict about the order of the elements in that request, so the
// tests check the order as well as the effect. They run against the simulated ESXi host, which applies the changes it is sent and keeps a change version.
const CREDENTIAL = { username: 'root', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const client = (fake, over = {}) => new VmwareSettingsClient({ endpointUri: 'https://esxi01.lab.example/', credential: CREDENTIAL, fetchImpl: fake.fetch, timeoutMs: 2000, pollIntervalMs: 1, verificationAttempts: 5, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof VmwareSettingsError && error.code === code && check(error), code);
const reconfigs = fake => fake.calls.filter(call => call.method === 'ReconfigVM_Task');
// The names of the elements directly under <vim25:spec>, in the order they were sent.
function specOrder(body) {
  const inner = body.slice(body.indexOf('<vim25:spec>') + '<vim25:spec>'.length, body.indexOf('</vim25:spec>')), names = [];
  let depth = 0;
  for (const m of inner.matchAll(/<(\/?)vim25:(\w+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = m;
    if (closing) { depth--; continue; }
    if (depth === 0) names.push(name);
    if (!selfClosing) depth++;
  }
  return names;
}

test('get returns the VM\'s settings: identity, CPU, memory, devices, advanced options and what it could be attached to', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { config: { annotation: 'web tier', coresPerSocket: 2, firmware: 'efi', extraConfig: [{ key: 'svga.present', value: 'TRUE' }, { key: 'note', value: 'a & b' }] } })] });
  const { provider, settings } = await client(fake).get('vm-1');
  assert.equal(provider, 'vmware');
  assert.deepEqual([settings.name, settings.annotation, settings.guestId, settings.hardwareVersion, settings.powerState, settings.cpuCount, settings.coresPerSocket, settings.memoryMB, settings.firmware], ['Guest vm-1', 'web tier', 'ubuntu64Guest', 'vmx-19', 'poweredOn', 2, 2, 4096, 'efi']);
  assert.deepEqual([settings.cpuHotAddEnabled, settings.memoryHotAddEnabled, settings.nestedHVEnabled], [false, false, false]);
  assert.deepEqual(settings.extraConfig, [{ key: 'svga.present', value: 'TRUE' }, { key: 'note', value: 'a & b' }]);
  const { hardware } = settings;
  assert.deepEqual(hardware.disks.map(d => [d.id, d.label, d.capacityBytes, d.backing, d.controllerKey]), [['2000', 'Hard disk 1', 40 * 1024 ** 3, '[datastore1] vm-1/vm-1.vmdk', '1000']]);
  assert.deepEqual(hardware.networkAdapters.map(n => [n.id, n.network, n.macAddress, n.connected, n.startConnected]), [['4000', 'VM Network', '00:0c:29:11:22:33', true, true]]);
  assert.deepEqual(hardware.cdDvdDrives.map(c => [c.id, c.media, c.connected]), [['3002', null, false]]);
  assert.deepEqual([hardware.videoCards[0].memoryBytes, hardware.videoCards[0].threeDEnabled, hardware.controllers[0].busNumber], [8192 * 1024, false, 0]);
  assert.deepEqual(settings.availableNetworks.map(n => n.name), ['VM Network', 'Storage Network']);
  assert.deepEqual(settings.availableDatastores.map(d => d.name), ['datastore1']);
  assert.equal(fake.openSessions(), 0);
});

test('if the host cannot say what a VM could be attached to, the settings are still returned, with empty choices', async () => {
  const fake = fakeEsxi(); fake.faults.http.set('QueryConfigTarget', { status: 500, message: 'Not available.', type: 'RuntimeFault' });
  const { settings } = await client(fake).get('vm-1');
  assert.deepEqual([settings.availableNetworks, settings.availableDatastores, settings.cpuCount], [[], [], 2]);
});

test('changing scalar settings sends only what changed and the host change version, and returns the settings read back', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const result = await c.update('vm-1', { name: 'web-01', annotation: 'owner: ops', cpuCount: 4, memoryMB: 8192, firmware: 'efi', nestedHVEnabled: true, memoryMB_unused: 1 });
  assert.deepEqual([result.code, result.settings.name, result.settings.annotation, result.settings.cpuCount, result.settings.memoryMB, result.settings.firmware, result.settings.nestedHVEnabled], ['NUV_VM_SETTINGS_UPDATED', 'web-01', 'owner: ops', 4, 8192, 'efi', true]);
  const [sent] = reconfigs(fake);
  assert.equal(reconfigs(fake).length, 1);
  assert.match(sent.body, /<vim25:changeVersion>2026-10-07T00:00:00\.000Z<\/vim25:changeVersion>/);
  assert.notEqual(result.settings.changeVersion, '2026-10-07T00:00:00.000Z', 'the host\'s change version moved on');
  assert.equal(fake.openSessions(), 0);
});

test('asking for what the VM already has changes nothing and sends no reconfigure request', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const result = await c.update('vm-1', { cpuCount: 2, memoryMB: 4096, annotation: '', nestedHVEnabled: false, cpuHotAddEnabled: false, firmware: 'bios', extraConfig: [{ key: 'svga.present', value: 'TRUE' }] });
  assert.deepEqual([result.code, reconfigs(fake).length], ['NUV_VM_SETTINGS_UNCHANGED', 0]);
  assert.equal((await c.update('vm-1', {})).code, 'NUV_VM_SETTINGS_UNCHANGED');
});

test('the request keeps VMware\'s required element order, whatever order the fields were given in', async () => {
  const fake = fakeEsxi(), c = client(fake);
  await c.update('vm-1', { firmware: 'efi', nestedHVEnabled: true, extraConfig: [{ key: 'a', value: '1' }], swapPlacement: 'vmDirectory', cpuSharesLevel: 'high', cpuReservationMHz: 500, disks: [{ id: '2000', capacityBytes: 50 * 1024 ** 3 }], bootDelayMs: 5000, memoryMB: 8192, cpuCount: 4, annotation: 'x', name: 'renamed', toolsUpgradePolicy: 'upgradeAtPowerCycle', enableLogging: true, memoryHotAddEnabled: true, cpuHotAddEnabled: true, latencySensitivity: 'high', standbyAction: 'suspend' });
  const order = specOrder(reconfigs(fake)[0].body);
  // extraConfig appears twice: one key is added and the VM's existing svga.present is cleared
  const expected = ['changeVersion', 'name', 'annotation', 'tools', 'flags', 'powerOpInfo', 'numCPUs', 'memoryMB', 'memoryHotAddEnabled', 'cpuHotAddEnabled', 'deviceChange', 'cpuAllocation', 'latencySensitivity', 'extraConfig', 'extraConfig', 'swapPlacement', 'bootOptions', 'firmware', 'nestedHVEnabled'];
  assert.deepEqual(order, expected);
});

test('the guest standby actions are translated into the names VMware uses, and asking for the current action changes nothing', async () => {
  const fake = fakeEsxi(), c = client(fake);                       // the host's action is powerOnSuspend, which the console calls guestStandby
  assert.equal((await c.update('vm-1', { standbyAction: 'guestStandby' })).code, 'NUV_VM_SETTINGS_UNCHANGED');
  assert.equal(reconfigs(fake).length, 0);
  const changed = await c.update('vm-1', { standbyAction: 'suspend' });
  assert.match(reconfigs(fake)[0].body, /<vim25:standbyAction>checkpoint<\/vim25:standbyAction>/);
  assert.equal(changed.settings.standbyAction, 'checkpoint');
  assert.equal((await c.update('vm-1', { standbyAction: 'suspend' })).code, 'NUV_VM_SETTINGS_UNCHANGED', 'now that the host reports checkpoint, suspend is the current action');
  await c.update('vm-1', { standbyAction: 'guestStandby' });
  assert.match(reconfigs(fake)[1].body, /<vim25:standbyAction>powerOnSuspend<\/vim25:standbyAction>/);
});

test('advanced options are changed by difference: new and changed keys are sent, missing keys are cleared, unchanged keys are left alone', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { config: { extraConfig: [{ key: 'keep', value: '1' }, { key: 'change', value: 'old' }, { key: 'drop', value: 'x' }] } })] }), c = client(fake);
  const result = await c.update('vm-1', { extraConfig: [{ key: 'keep', value: '1' }, { key: 'change', value: 'new' }, { key: 'added & more', value: '<v>' }] });
  const body = reconfigs(fake)[0].body;
  assert.ok(!/<vim25:key>keep<\/vim25:key>/.test(body));
  assert.match(body, /<vim25:key>change<\/vim25:key><vim25:value xsi:type="xsd:string">new<\/vim25:value>/);
  assert.match(body, /<vim25:key>drop<\/vim25:key><vim25:value xsi:type="xsd:string"><\/vim25:value>/);
  assert.deepEqual(Object.fromEntries(result.settings.extraConfig.map(o => [o.key, o.value])), { keep: '1', change: 'new', 'added & more': '<v>' });
});

test('disks can be expanded but not shrunk, and a disk that is gone is reported as a conflict before anything is sent', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const grown = await c.update('vm-1', { disks: [{ id: '2000', capacityBytes: 60 * 1024 ** 3 }] });
  assert.equal(grown.settings.hardware.disks[0].capacityBytes, 60 * 1024 ** 3);
  assert.equal(reconfigs(fake).length, 1);
  await rejectsWith(() => c.update('vm-1', { disks: [{ id: '2000', capacityBytes: 10 * 1024 ** 3 }] }), 'NUV_VM_SETTINGS_DISK_SHRINK_UNSUPPORTED', e => e.status === 422);
  await rejectsWith(() => c.update('vm-1', { disks: [{ id: '9999', capacityBytes: 70 * 1024 ** 3 }] }), 'NUV_VM_SETTINGS_DEVICE_NOT_FOUND', e => e.status === 409);
  assert.equal(reconfigs(fake).length, 1, 'neither refused change was sent');
  assert.equal(fake.openSessions(), 0);
});

test('network adapters, CD/DVD drives and the video card are edited in place; devices that no longer exist are refused', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const result = await c.update('vm-1', { networkAdapters: [{ id: '4000', network: 'Storage Network', connected: false, startConnected: true }], cdDvdDrives: [{ id: '3002', connected: false, startConnected: true }], videoCards: [{ id: '500', memoryBytes: 16 * 1024 * 1024, threeDEnabled: true }] });
  const { hardware } = result.settings;
  assert.deepEqual([hardware.networkAdapters[0].network, hardware.networkAdapters[0].connected, hardware.networkAdapters[0].startConnected], ['Storage Network', false, true]);
  assert.deepEqual([hardware.cdDvdDrives[0].startConnected, hardware.videoCards[0].memoryBytes, hardware.videoCards[0].threeDEnabled], [true, 16 * 1024 * 1024, true]);
  const before = reconfigs(fake).length;
  for (const input of [{ networkAdapters: [{ id: '1' }] }, { cdDvdDrives: [{ id: '1' }] }, { videoCards: [{ id: '1' }] }, { controllers: [{ id: '1' }] }]) await rejectsWith(() => c.update('vm-1', input), 'NUV_VM_SETTINGS_DEVICE_NOT_FOUND', e => e.status === 409);
  assert.equal(reconfigs(fake).length, before);
});

test('devices can be added and removed; only removable kinds can be removed, and a CD/DVD drive needs a SATA or IDE controller', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const added = await c.update('vm-1', { addedDevices: [{ kind: 'network', network: 'Storage Network' }] });
  assert.deepEqual(added.settings.hardware.networkAdapters.map(n => n.network), ['VM Network', 'Storage Network']);
  assert.match(reconfigs(fake)[0].body, /<vim25:key>-100<\/vim25:key>/, 'new devices carry temporary negative keys');
  const newKey = added.settings.hardware.networkAdapters[1].id;
  const removed = await c.update('vm-1', { removedDeviceIds: [newKey] });
  assert.equal(removed.settings.hardware.networkAdapters.length, 1);
  const before = reconfigs(fake).length;
  await rejectsWith(() => c.update('vm-1', { removedDeviceIds: ['1000'] }), 'NUV_VM_SETTINGS_DEVICE_NOT_REMOVABLE', e => e.status === 422);
  await rejectsWith(() => c.update('vm-1', { removedDeviceIds: ['424242'] }), 'NUV_VM_SETTINGS_DEVICE_NOT_REMOVABLE');
  await rejectsWith(() => c.update('vm-1', { addedDevices: [{ kind: 'cdrom' }] }), 'NUV_VM_SETTINGS_CONTROLLER_REQUIRED', e => e.status === 422);
  assert.equal(reconfigs(fake).length, before, 'refused changes were not sent');
});

test('a task that VMware reports as failed carries its message; one that never finishes is a retryable timeout; the session is closed either way', async () => {
  const failing = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { reconfigError: 'Insufficient resources to satisfy the configured failover level.' })] });
  await rejectsWith(() => client(failing).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_TASK_FAILED', e => /Insufficient resources/.test(e.message) && e.retryable === false);
  const slow = fakeEsxi(); slow.state.taskPolls = 100000;
  await rejectsWith(() => client(slow).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_TIMEOUT', e => e.retryable === true);
  assert.equal(failing.openSessions() + slow.openSessions(), 0);
});

test('a VM changed by someone else since it was read is reported, and trying again is allowed', async () => {
  const fake = fakeEsxi(); fake.faults.http.set('ReconfigVM_Task', { status: 500, message: 'The configuration of the virtual machine has changed since the operation started.', type: 'ConcurrentAccess' });
  await rejectsWith(() => client(fake).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_PROVIDER_FAILED', e => e.retryable === true && /has changed/.test(e.message));
});

test('the change version really is enforced: a stale version is refused by the host', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const original = fake.fetch;
  let staled = false;
  const racing = (url, init) => { const body = String(init?.body ?? ''); if (!staled && body.includes('ReconfigVM_Task')) { staled = true; fake.state.vms.get('vm-1').config = { changeVersion: '2026-10-07T00:00:59.000Z' }; } return original(url, init); };
  await rejectsWith(() => client({ fetch: racing, openSessions: fake.openSessions }).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_PROVIDER_FAILED', e => /has changed since/.test(e.message));
  assert.equal((await c.get('vm-1')).settings.cpuCount, 2, 'nothing was applied');
});

test('connection problems: unreachable is retryable; a host that is not VMware is a protocol error', async () => {
  const down = fakeEsxi(); down.faults.unreachable = true;
  await rejectsWith(() => client(down).get('vm-1'), 'NUV_VM_SETTINGS_UNREACHABLE', e => e.retryable === true);
  const notVmware = fakeEsxi(); notVmware.faults.emptyServiceContent = true;
  await rejectsWith(() => client(notVmware).get('vm-1'), 'NUV_VM_SETTINGS_PROTOCOL_ERROR', e => e.retryable === false);
});

test('a wrong password or a missing permission is not retried, and a wrong power state is a conflict the operator can act on', async () => {
  const wrong = fakeEsxi();
  await rejectsWith(() => client(wrong, { credential: { username: 'root', password: 'wrong' } }).get('vm-1'), 'NUV_VM_SETTINGS_AUTH_FAILED', e => e.retryable === false && /incorrect user name or password/.test(e.message)); // secret-scan:allow (fake test credential)
  const denied = fakeEsxi(); denied.faults.http.set('ReconfigVM_Task', { status: 500, message: 'Permission to perform this operation was denied.', type: 'NoPermission' });
  await rejectsWith(() => client(denied).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_PERMISSION_DENIED', e => e.status === 403 && e.retryable === false);
  const state = fakeEsxi(); state.faults.http.set('ReconfigVM_Task', { status: 500, message: 'The operation is not allowed in the current state.', type: 'InvalidState' });
  await rejectsWith(() => client(state).update('vm-1', { cpuCount: 8 }), 'NUV_VM_SETTINGS_STATE_CONFLICT', e => e.retryable === false);
});

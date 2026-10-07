import test from 'node:test';
import assert from 'node:assert/strict';
import { VmwareSnapshotClient, VmwareSnapshotError, parseVmwareSnapshotInfo } from '../vmware-snapshots.js';
import { fakeEsxi, sampleEsxiVm } from '../test-support/fake-esxi.js';

// The snapshot client is shared by the ESXi and vCenter providers: it lists, creates, reverts and removes snapshots through the VMware SOAP API. The tests run it
// against the simulated ESXi host, which keeps a real snapshot tree, and against hand-written property XML for the parser.
const CREDENTIAL = { username: 'root', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const client = (fake, over = {}) => new VmwareSnapshotClient({ endpointUri: 'https://esxi01.lab.example/', credential: CREDENTIAL, fetchImpl: fake.fetch, timeoutMs: 2000, pollIntervalMs: 1, verificationAttempts: 5, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof VmwareSnapshotError && error.code === code && check(error), code);
const sentMethods = fake => fake.soapCalls();

const prop = (name, val) => `<propSet><name>${name}</name><val>${val}</val></propSet>`;
const node = (id, name, children = '', extra = {}) => `<snapshot type="VirtualMachineSnapshot">${id}</snapshot><name>${name}</name><description>${extra.description ?? ''}</description><createTime>${extra.createTime ?? '2026-10-01T00:00:00Z'}</createTime><state>${extra.state ?? 'poweredOff'}</state><quiesced>${extra.quiesced ?? false}</quiesced>${children}`;

test('the parser reads a snapshot tree: parents, depth, child counts, the current snapshot and the consolidation flag', () => {
  const tree = prop('snapshot', `<currentSnapshot type="VirtualMachineSnapshot">snap-3</currentSnapshot><rootSnapshotList>${node('snap-1', 'base', `<childSnapshotList>${node('snap-2', 'patched', `<childSnapshotList>${node('snap-3', 'tested', '', { state: 'poweredOn', quiesced: true })}</childSnapshotList>`)}</childSnapshotList><childSnapshotList>${node('snap-4', 'branch')}</childSnapshotList>`)}</rootSnapshotList><rootSnapshotList>${node('snap-5', 'other root')}</rootSnapshotList>`) + prop('runtime.consolidationNeeded', 'true');
  const info = parseVmwareSnapshotInfo(`<returnval><objects>${tree}</objects></returnval>`);
  assert.deepEqual(info.items.map(i => [i.id, i.parentId, i.depth, i.childCount, i.current]), [['snap-1', null, 0, 2, false], ['snap-2', 'snap-1', 1, 1, false], ['snap-3', 'snap-2', 2, 0, true], ['snap-4', 'snap-1', 1, 0, false], ['snap-5', null, 0, 0, false]]);
  assert.deepEqual([info.currentSnapshotId, info.consolidationRequired, info.items[2].powerState, info.items[2].quiesced, info.items[0].quiesced], ['snap-3', true, 'poweredOn', true, false]);
});

test('the parser handles a VM with no snapshots, a missing consolidation flag, and XML-escaped names', () => {
  assert.deepEqual(parseVmwareSnapshotInfo('<returnval><objects></objects></returnval>'), { currentSnapshotId: null, items: [], consolidationRequired: null });
  assert.equal(parseVmwareSnapshotInfo(`<objects>${prop('runtime.consolidationNeeded', 'false')}</objects>`).consolidationRequired, false);
  const info = parseVmwareSnapshotInfo(`<objects>${prop('snapshot', `<rootSnapshotList>${node('snap-1', 'R&amp;D &lt;pre&gt; "x"', '', { description: 'it&apos;s &amp; ok' })}</rootSnapshotList>`)}</objects>`);
  assert.deepEqual([info.items[0].name, info.items[0].description, info.currentSnapshotId], ['R&D <pre> "x"', "it's & ok", null]);
  const unnamed = parseVmwareSnapshotInfo(`<objects>${prop('snapshot', '<rootSnapshotList><snapshot type="VirtualMachineSnapshot">snap-9</snapshot></rootSnapshotList>')}</objects>`);
  assert.deepEqual([unnamed.items[0].name, unnamed.items[0].description], ['snap-9', '']);
});

test('listing a VM with no snapshots returns an empty list, and closes its session', async () => {
  const fake = fakeEsxi(), result = await client(fake).list('vm-1');
  assert.deepEqual([result.provider, result.items, result.currentSnapshotId, result.consolidationRequired], ['vmware', [], null, false]);
  assert.deepEqual([sentMethods(fake)[0], sentMethods(fake).at(-1), fake.openSessions()], ['RetrieveServiceContent', 'Logout', 0]);
});

test('creating snapshots builds a tree under the current one, and each result names the new snapshot', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const first = await c.create('vm-1', { name: 'before patch', description: 'safe point', includeMemory: true, quiesce: true });
  assert.deepEqual([first.code, first.snapshot.name, first.snapshot.description, first.snapshot.quiesced, first.snapshot.powerState, first.snapshot.parentId, first.snapshot.current], ['NUV_SNAPSHOT_CREATED', 'before patch', 'safe point', true, 'poweredOn', null, true]);
  const second = await c.create('vm-1', { name: 'after patch' });
  assert.deepEqual([second.snapshot.parentId, second.snapshot.depth, second.snapshot.powerState, second.snapshot.quiesced, second.currentSnapshotId], [first.snapshot.id, 1, 'poweredOff', false, second.snapshot.id]);
  assert.deepEqual(second.items.map(i => i.name), ['before patch', 'after patch']);
  const request = fake.calls.find(call => call.method === 'CreateSnapshot_Task').body;
  assert.match(request, /<vim25:memory>true<\/vim25:memory><vim25:quiesce>true<\/vim25:quiesce>/);
  assert.equal(fake.openSessions(), 0);
});

test('a snapshot name or description with XML characters is sent safely and comes back unchanged', async () => {
  const fake = fakeEsxi(), made = await client(fake).create('vm-1', { name: 'R&D <pre> "x"', description: "it's </description> & more" });
  assert.deepEqual([made.snapshot.name, made.snapshot.description], ['R&D <pre> "x"', "it's </description> & more"]);
});

test('reverting makes the chosen snapshot current, and a snapshot that does not belong to the VM is refused before anything is sent', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1'), sampleEsxiVm('vm-2')] }), c = client(fake);
  const a = (await c.create('vm-1', { name: 'a' })).snapshot, b = (await c.create('vm-1', { name: 'b' })).snapshot;
  const reverted = await c.revert('vm-1', a.id);
  assert.deepEqual([reverted.code, reverted.snapshotId, (await c.list('vm-1')).currentSnapshotId], ['NUV_SNAPSHOT_REVERTED', a.id, a.id]);
  const before = fake.calls.length;
  await rejectsWith(() => c.revert('vm-1', 'snapshot-999'), 'NUV_SNAPSHOT_NOT_FOUND', e => e.status === 404);
  await rejectsWith(() => c.revert('vm-2', b.id), 'NUV_SNAPSHOT_NOT_FOUND', e => e.status === 404);
  await rejectsWith(() => c.remove('vm-2', b.id), 'NUV_SNAPSHOT_NOT_FOUND');
  assert.ok(!fake.calls.slice(before).some(call => /RevertToSnapshot|RemoveSnapshot/.test(call.method)), 'nothing destructive was sent');
  assert.equal(fake.openSessions(), 0);
});

test('removing a snapshot consolidates its disks, never removes children, and refuses a snapshot that has children', async () => {
  const fake = fakeEsxi(), c = client(fake);
  const parent = (await c.create('vm-1', { name: 'parent' })).snapshot, child = (await c.create('vm-1', { name: 'child' })).snapshot;
  await rejectsWith(() => c.remove('vm-1', parent.id), 'NUV_SNAPSHOT_HAS_CHILDREN', e => e.status === 409);
  assert.ok(!fake.calls.some(call => call.method === 'RemoveSnapshot_Task'), 'nothing was removed');
  const removed = await c.remove('vm-1', child.id);
  assert.deepEqual([removed.code, removed.snapshotId], ['NUV_SNAPSHOT_DELETED', child.id]);
  assert.match(fake.calls.find(call => call.method === 'RemoveSnapshot_Task').body, /<vim25:removeChildren>false<\/vim25:removeChildren><vim25:consolidate>true<\/vim25:consolidate>/);
  const left = await c.list('vm-1');
  assert.deepEqual([left.items.map(i => i.id), left.currentSnapshotId], [[parent.id], parent.id], 'the current snapshot moves to the parent');
  await c.remove('vm-1', parent.id);
  assert.deepEqual([(await c.list('vm-1')).items, (await c.list('vm-1')).currentSnapshotId], [[], null]);
});

test('a VM that cannot take snapshots says so, and the consolidation warning is passed on', async () => {
  const fake = fakeEsxi({ vms: [sampleEsxiVm('vm-1', { snapshotsSupported: false }), sampleEsxiVm('vm-2', { consolidationNeeded: true })] }), c = client(fake);
  await rejectsWith(() => c.list('vm-1'), 'NUV_SNAPSHOT_UNSUPPORTED', e => e.status === 422);
  assert.equal((await c.list('vm-2')).consolidationRequired, true);
  assert.equal(fake.openSessions(), 0);
});

test('a snapshot task that VMware reports as failed carries VMware\'s message; one that never finishes is a retryable timeout; both close the session', async () => {
  const failing = fakeEsxi({ vms: [sampleEsxiVm('vm-1')] }), c = client(failing);
  const snap = (await c.create('vm-1', { name: 'x' })).snapshot;
  failing.state.vms.get('vm-1').snapshotTaskError = 'The file is locked by another process.';
  await rejectsWith(() => c.revert('vm-1', snap.id), 'NUV_SNAPSHOT_TASK_FAILED', e => /locked by another process/.test(e.message) && e.retryable === false);
  await rejectsWith(() => c.remove('vm-1', snap.id), 'NUV_SNAPSHOT_TASK_FAILED');
  assert.equal(failing.openSessions(), 0);
  const slow = fakeEsxi(); slow.state.taskPolls = 100000;
  await rejectsWith(() => client(slow).create('vm-1', { name: 'x' }), 'NUV_SNAPSHOT_VERIFICATION_TIMEOUT', e => e.retryable === true);
  assert.equal(slow.openSessions(), 0);
});

test('connection problems: an unreachable host is retryable; an endpoint that is not VMware is a protocol error', async () => {
  const down = fakeEsxi(); down.faults.unreachable = true;
  await rejectsWith(() => client(down).list('vm-1'), 'NUV_SNAPSHOT_PROVIDER_UNREACHABLE', e => e.retryable === true && /ECONNREFUSED/.test(e.message));
  const notVmware = fakeEsxi(); notVmware.faults.emptyServiceContent = true;
  await rejectsWith(() => client(notVmware).list('vm-1'), 'NUV_SNAPSHOT_PROTOCOL_ERROR', e => e.retryable === false);
});

test('a wrong password or a missing permission is not retried: retrying would only repeat a failed login or a refused request', async () => {
  // VMware reports both as a SOAP fault inside HTTP 500, so the status alone says "retry"; the fault type says otherwise.
  const wrong = fakeEsxi();
  await rejectsWith(() => client(wrong, { credential: { username: 'root', password: 'wrong' } }).list('vm-1'), 'NUV_SNAPSHOT_AUTH_FAILED', e => e.retryable === false && /incorrect user name or password/.test(e.message)); // secret-scan:allow (fake test credential)
  const denied = fakeEsxi(); denied.faults.http.set('CreateSnapshot_Task', { status: 500, message: 'Permission to perform this operation was denied.', type: 'NoPermission' });
  await rejectsWith(() => client(denied).create('vm-1', { name: 'x' }), 'NUV_SNAPSHOT_PERMISSION_DENIED', e => e.status === 403 && e.retryable === false);
  assert.equal(wrong.openSessions() + denied.openSessions(), 0);
});

test('a snapshot request in the wrong power state is a conflict the operator can act on, not a generic failure', async () => {
  const fake = fakeEsxi(); fake.faults.http.set('CreateSnapshot_Task', { status: 500, message: 'The operation is not allowed in the current state.', type: 'InvalidState' });
  await rejectsWith(() => client(fake).create('vm-1', { name: 'x' }), 'NUV_SNAPSHOT_STATE_CONFLICT', e => e.retryable === false);
  const other = fakeEsxi(); other.faults.http.set('CreateSnapshot_Task', { status: 500, message: 'Something unexpected happened.', type: 'RuntimeFault' });
  await rejectsWith(() => client(other).create('vm-1', { name: 'x' }), 'NUV_SNAPSHOT_PROVIDER_FAILED', e => e.status === 422);
});

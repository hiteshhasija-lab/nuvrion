// A reusable contract that every provider adapter must satisfy. Call defineProviderContract with a factory that returns a fresh
// adapter; add `optional` capabilities (snapshots, media, settings) when the adapter implements them.
import test from 'node:test';
import assert from 'node:assert/strict';

// Canonical states plus the transitional states some clouds report while an operation is in flight.
const POWER_STATES = ['running', 'stopped', 'suspended', 'unknown', 'starting', 'stopping', 'restarting', 'pending', 'shutting-down', 'terminated'];
const HEALTH_STATES = ['healthy', 'warning', 'critical', 'unknown'];

// strictReferences: the adapter must refuse to verify a reference it did not issue (real adapters; a test double may be lenient).
export function defineProviderContract(label, makeProvider, { optional = [], strictReferences = false } = {}) {
  const firstVm = async provider => (await provider.discover({ id: 'c1' }))[0];

  test(`${label} contract: discovery returns well-formed, uniquely identified virtual machines`, async () => {
    const observations = await makeProvider().discover({ id: 'c1' });
    assert.ok(Array.isArray(observations) && observations.length > 0);
    const ids = new Set();
    for (const item of observations) {
      assert.equal(item.resourceType, 'virtual_machine');
      assert.equal(typeof item.nativeId, 'string'); assert.ok(item.nativeId.length > 0);
      assert.equal(typeof item.name, 'string'); assert.ok(item.name.length > 0);
      assert.ok(HEALTH_STATES.includes(item.healthState), `health ${item.healthState}`);
      assert.ok(POWER_STATES.includes(item.attributes.powerState), `power ${item.attributes.powerState}`);
      for (const field of ['vcpuCount', 'memoryBytes']) assert.ok(item.attributes[field] === undefined || item.attributes[field] === null || Number.isFinite(Number(item.attributes[field])), field);
      assert.ok(!ids.has(item.nativeId), `duplicate native id ${item.nativeId}`);
      ids.add(item.nativeId);
    }
  });

  test(`${label} contract: discovery results are copies, so callers cannot corrupt provider state`, async () => {
    const provider = makeProvider();
    const first = await provider.discover({ id: 'c1' });
    first[0].name = 'MUTATED'; first[0].attributes.powerState = 'MUTATED';
    const second = await provider.discover({ id: 'c1' });
    assert.notEqual(second[0].name, 'MUTATED');
    assert.notEqual(second[0].attributes.powerState, 'MUTATED');
  });

  test(`${label} contract: execute returns a non-empty provider reference, different for every request`, async () => {
    const provider = makeProvider(), vm = await firstVm(provider);
    const a = await provider.execute('start', vm.nativeId, {}), b = await provider.execute('start', vm.nativeId, {});
    for (const accepted of [a, b]) assert.ok(typeof accepted.providerReference === 'string' && accepted.providerReference.length > 0);
    assert.notEqual(a.providerReference, b.providerReference);
  });

  test(`${label} contract: verify reports the final state the operation should produce`, async () => {
    const provider = makeProvider(), vm = await firstVm(provider);
    const started = await provider.verify((await provider.execute('start', vm.nativeId, {})).providerReference);
    const stopped = await provider.verify((await provider.execute('stop', vm.nativeId, {})).providerReference);
    assert.equal(started.observedFinalState, 'running');
    assert.equal(stopped.observedFinalState, 'stopped');
    for (const result of [started, stopped]) { assert.equal(typeof result.code, 'string'); assert.ok(result.providerReference); }
  });

  if (strictReferences) {
    test(`${label} contract: verify refuses a reference it did not issue, and a reference can be verified only once`, async () => {
      const provider = makeProvider(), vm = await firstVm(provider);
      await assert.rejects(() => provider.verify('not-issued-by-this-provider'), e => typeof e.code === 'string' && /REFERENCE_INVALID/.test(e.code));
      const { providerReference } = await provider.execute('start', vm.nativeId, {});
      await provider.verify(providerReference);
      await assert.rejects(() => provider.verify(providerReference), e => /REFERENCE_INVALID/.test(e.code));
    });
  }

  if (optional.includes('snapshots')) {
    test(`${label} contract: snapshots can be created, listed, reverted and deleted`, async () => {
      const provider = makeProvider(), { nativeId } = await firstVm(provider);
      assert.deepEqual((await provider.listSnapshots(nativeId)).items, []);
      const a = await provider.createSnapshot(nativeId, { name: 'before-patch' });
      const b = await provider.createSnapshot(nativeId, { name: 'after-patch' });
      const listed = await provider.listSnapshots(nativeId);
      assert.equal(listed.items.length, 2);
      assert.equal(listed.currentSnapshotId, b.snapshot.id);
      assert.equal(b.snapshot.parentId, a.snapshot.id);
      await provider.revertSnapshot(nativeId, a.snapshot.id);
      assert.equal((await provider.listSnapshots(nativeId)).currentSnapshotId, a.snapshot.id);
      await provider.deleteSnapshot(nativeId, b.snapshot.id);
      assert.equal((await provider.listSnapshots(nativeId)).items.length, 1);
    });

    test(`${label} contract: snapshot errors are explicit (unknown snapshot, snapshot with children)`, async () => {
      const provider = makeProvider(), { nativeId } = await firstVm(provider);
      const parent = await provider.createSnapshot(nativeId, { name: 'parent' });
      await provider.createSnapshot(nativeId, { name: 'child' });
      await assert.rejects(() => provider.revertSnapshot(nativeId, 'nope'), e => e.code === 'NUV_SNAPSHOT_NOT_FOUND' && e.status === 404);
      await assert.rejects(() => provider.deleteSnapshot(nativeId, 'nope'), e => e.code === 'NUV_SNAPSHOT_NOT_FOUND');
      await assert.rejects(() => provider.deleteSnapshot(nativeId, parent.snapshot.id), e => e.code === 'NUV_SNAPSHOT_HAS_CHILDREN' && e.status === 409);
    });

    test(`${label} contract: snapshots belong to one VM only`, async () => {
      const provider = makeProvider(), vms = await provider.discover({ id: 'c1' });
      const made = await provider.createSnapshot(vms[0].nativeId, { name: 'only-mine' });
      assert.deepEqual((await provider.listSnapshots(vms[1].nativeId)).items, []);
      await assert.rejects(() => provider.revertSnapshot(vms[1].nativeId, made.snapshot.id), e => e.code === 'NUV_SNAPSHOT_NOT_FOUND');
    });
  }

  if (optional.includes('media')) {
    test(`${label} contract: an ISO can be mounted, shown as connected, and ejected`, async () => {
      const provider = makeProvider(), { nativeId } = await firstVm(provider);
      const before = await provider.listMedia(nativeId);
      assert.equal(before.drives[0].connected, false);
      const mounted = await provider.mountMedia(nativeId, { driveId: before.drives[0].id, isoPath: before.images[0] });
      assert.equal(mounted.drive.connected, true);
      assert.equal((await provider.listMedia(nativeId)).drives[0].media, before.images[0]);
      const ejected = await provider.ejectMedia(nativeId, { driveId: before.drives[0].id });
      assert.equal(ejected.drive.connected, false);
      assert.equal((await provider.listMedia(nativeId)).drives[0].media, null);
    });
  }

  if (optional.includes('settings')) {
    test(`${label} contract: settings can be read and changed, and changes persist`, async () => {
      const provider = makeProvider(), { nativeId } = await firstVm(provider);
      const before = (await provider.getSettings(nativeId)).settings;
      assert.ok(before.cpuCount > 0 && before.memoryMB > 0);
      const updated = await provider.updateSettings(nativeId, { cpuCount: before.cpuCount + 2, annotation: 'changed by contract test' });
      assert.equal(updated.settings.cpuCount, before.cpuCount + 2);
      const reread = (await provider.getSettings(nativeId)).settings;
      assert.equal(reread.cpuCount, before.cpuCount + 2);
      assert.equal(reread.annotation, 'changed by contract test');
      assert.equal(reread.memoryMB, before.memoryMB, 'untouched settings are preserved');
    });
  }
}

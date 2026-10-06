import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/task-store.js';
import { VerificationReconciler, VerificationReconciliationError } from '../src/verification-reconciler.js';

let n = 0;
// A task left in verification-required, as the worker does after an ambiguous outcome.
function ambiguous(store, { operation = 'start', connectionId = 'c1' } = {}) {
  const { task } = store.create({ operation, targetId: `res-${++n}`, providerNativeId: `native-${n}`, connectionId, correlationId: `c-${n}`, idempotencyKey: `k-${n}` });
  store.claim('w', task.id);
  store.running(task.id, `ref-${n}`);
  store.verificationRequired(task.id, { code: 'NUV_ESXI_UNREACHABLE', detail: 'lost contact', retryable: true });
  return store.get(task.id);
}
const observation = (task, powerState) => ({ resourceType: 'virtual_machine', nativeId: task.providerNativeId, attributes: { powerState } });

function setup(overrides = {}) {
  const store = new TaskStore(), applied = [], executed = [];
  const provider = { discover: async () => [], execute: async () => { executed.push(1); } };
  const reconciler = new VerificationReconciler({
    store, provider,
    connections: { get: async id => (id === 'c1' ? { id: 'c1' } : null) },
    inventory: { get: async () => ({ id: 'known' }), applyOperation: async (id, op, result) => applied.push([id, op, result.code]) },
    unresolvedAfterMs: 120_000, ...overrides
  });
  return { store, reconciler, provider, applied, executed };
}

test('scheduled discovery confirms the expected state: the task completes and inventory is updated', async () => {
  const { store, reconciler, applied } = setup();
  const task = ambiguous(store);
  const results = await reconciler.reconcileConnection({ id: 'c1' }, [observation(task, 'running')]);
  assert.deepEqual(results.map(r => r.status), ['completed']);
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(store.get(task.id).result.code, 'NUV_OPERATION_RECONCILED');
  assert.equal(applied.length, 1);
});

test('the expected state depends on the operation', async () => {
  const cases = [['start', 'running'], ['restart', 'running'], ['reboot_guest', 'running'], ['stop', 'stopped'], ['power_off', 'stopped'], ['pause', 'suspended']];
  for (const [operation, state] of cases) {
    const { store, reconciler } = setup();
    const task = ambiguous(store, { operation });
    const [result] = await reconciler.reconcileConnection({ id: 'c1' }, [observation(task, state)]);
    assert.equal(result.status, 'completed', `${operation} → ${state}`);
    assert.equal(result.expected, state);
  }
});

test('a state that does not match yet stays unresolved while the task is recent', async () => {
  const { store, reconciler } = setup();
  const task = ambiguous(store);
  const [result] = await reconciler.reconcileConnection({ id: 'c1' }, [observation(task, 'stopped')]);
  assert.equal(result.status, 'unresolved');
  assert.equal(store.get(task.id).status, 'verification_required');
});

test('a mismatch that persists past the limit fails the task and does NOT reissue the operation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  const { store, reconciler, executed } = setup();
  const task = ambiguous(store);
  t.mock.timers.tick(121_000);
  const [result] = await reconciler.reconcileConnection({ id: 'c1' }, [observation(task, 'stopped')]);
  assert.equal(result.status, 'failed');
  const failed = store.get(task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'NUV_RECONCILIATION_STATE_MISMATCH');
  assert.match(failed.error.detail, /not reissued/);
  assert.equal(executed.length, 0);
});

test('a target that disappeared is reported as missing after the limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  const { store, reconciler } = setup();
  const task = ambiguous(store);
  t.mock.timers.tick(121_000);
  const [result] = await reconciler.reconcileConnection({ id: 'c1' }, []);
  assert.equal(result.status, 'failed');
  assert.equal(store.get(task.id).error.code, 'NUV_RECONCILIATION_TARGET_MISSING');
});

test('only the tasks of the discovered connection are touched', async () => {
  const { store, reconciler } = setup();
  const mine = ambiguous(store, { connectionId: 'c1' }), other = ambiguous(store, { connectionId: 'c2' });
  const results = await reconciler.reconcileConnection({ id: 'c1' }, [observation(mine, 'running'), observation(other, 'running')]);
  assert.equal(results.length, 1);
  assert.equal(store.get(other.id).status, 'verification_required');
});

test('tasks in other states are ignored', async () => {
  const { store, reconciler } = setup();
  const { task } = store.create({ operation: 'start', targetId: 'x', providerNativeId: 'n-x', connectionId: 'c1', correlationId: 'c', idempotencyKey: 'k-x' });
  assert.deepEqual(await reconciler.reconcileConnection({ id: 'c1' }, [observation(task, 'running')]), []);
});

test('manual reconcile: confirms and completes when the provider reports the expected state', async () => {
  const { store, reconciler, provider } = setup();
  const task = ambiguous(store);
  provider.discover = async () => [observation(task, 'running')];
  const { task: done, result } = await reconciler.reconcile(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(result.observedFinalState, 'running');
});

test('manual reconcile refuses when the state does not match, the target is missing, or the provider is down', async () => {
  const { store, reconciler, provider } = setup();
  const task = ambiguous(store);
  provider.discover = async () => [observation(task, 'stopped')];
  await assert.rejects(() => reconciler.reconcile(task.id), e => e.code === 'NUV_RECONCILIATION_STATE_MISMATCH');
  provider.discover = async () => [];
  await assert.rejects(() => reconciler.reconcile(task.id), e => e.code === 'NUV_RECONCILIATION_TARGET_MISSING');
  provider.discover = async () => { throw Object.assign(new Error('down'), { code: 'NUV_ESXI_UNREACHABLE', status: 503, retryable: true }); };
  await assert.rejects(() => reconciler.reconcile(task.id), e => e instanceof VerificationReconciliationError && e.code === 'NUV_ESXI_UNREACHABLE' && e.retryable === true);
  assert.equal(store.get(task.id).status, 'verification_required', 'nothing changed');
});

test('manual reconcile only accepts existing verification-required tasks on a known connection', async () => {
  const { store, reconciler } = setup();
  await assert.rejects(() => reconciler.reconcile('missing'), e => e.code === 'NUV_TASK_NOT_FOUND' && e.status === 404);
  const { task: queued } = store.create({ operation: 'start', targetId: 'q', providerNativeId: 'q', connectionId: 'c1', correlationId: 'c', idempotencyKey: 'k-q' });
  await assert.rejects(() => reconciler.reconcile(queued.id), e => e.code === 'NUV_TASK_NOT_RECONCILABLE');
  const orphan = ambiguous(store, { connectionId: 'gone' });
  await assert.rejects(() => reconciler.reconcile(orphan.id), e => e.code === 'NUV_CONNECTION_NOT_FOUND');
});

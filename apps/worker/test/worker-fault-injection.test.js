import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../../../modules/tasks/src/task-store.js';
import { Worker } from '../src/worker.js';

let n = 0;
const enqueue = (store, over = {}) => store.create({ operation: 'start', targetId: `vm-${++n}`, providerNativeId: `native-${n}`, connectionId: 'c1', correlationId: `c-${n}`, idempotencyKey: `k-${n}`, ...over }).task;
const failure = (code, retryable) => Object.assign(new Error(`${code} happened`), { code, retryable });

// A provider whose behaviour is scripted per call, recording how many times each method ran.
function provider({ execute = async () => ({ providerReference: 'ref-1' }), verify = async ref => ({ code: 'NUV_OPERATION_VERIFIED', providerReference: ref, observedFinalState: 'running' }) } = {}) {
  const calls = { execute: 0, verify: 0 };
  return {
    calls,
    execute: async (...args) => { calls.execute++; return execute(calls.execute, ...args); },
    verify: async (...args) => { calls.verify++; return verify(...args); }
  };
}
const worker = (store, p, options = {}) => new Worker({ store, provider: p, maxAttempts: 3, retryBaseMs: 100, ...options });

test('success: the operation runs once, is verified, and completes', async () => {
  const store = new TaskStore(), task = enqueue(store), p = provider(), done = [];
  await worker(store, p, { onCompleted: async (t, r) => done.push([t.id, r.observedFinalState]) }).tick();
  assert.equal(store.get(task.id).status, 'completed');
  assert.deepEqual([p.calls.execute, p.calls.verify], [1, 1]);
  assert.deepEqual(done, [[task.id, 'running']]);
});

test('a permanent provider error fails the task at once and is never retried', async () => {
  const store = new TaskStore(), task = enqueue(store);
  const p = provider({ execute: async () => { throw failure('NUV_PROVIDER_AUTH_FAILED', false); } });
  const w = worker(store, p);
  await w.tick(); await w.tick();
  const t = store.get(task.id);
  assert.equal(t.status, 'failed');
  assert.equal(t.error.code, 'NUV_PROVIDER_AUTH_FAILED');
  assert.equal(p.calls.execute, 1);
});

test('an error with no code is recorded as a generic provider failure', async () => {
  const store = new TaskStore(), task = enqueue(store);
  await worker(store, provider({ execute: async () => { throw new Error('boom'); } })).tick();
  assert.equal(store.get(task.id).error.code, 'NUV_PROVIDER_FAILURE');
});

test('provider outage before the request is accepted: retried with growing delay, then failed after the attempt limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  const store = new TaskStore(), task = enqueue(store);
  const p = provider({ execute: async () => { throw failure('NUV_ESXI_UNREACHABLE', true); } });
  const w = worker(store, p);
  await w.tick();
  assert.equal(store.get(task.id).status, 'queued');
  const firstDelay = Date.parse(store.get(task.id).retryAt) - Date.now();
  await w.tick();
  assert.equal(p.calls.execute, 1, 'not retried before it is due');
  t.mock.timers.tick(firstDelay + 1);
  await w.tick();
  const secondDelay = Date.parse(store.get(task.id).retryAt) - Date.now();
  assert.ok(secondDelay > firstDelay, `backoff grows (${firstDelay}ms then ${secondDelay}ms)`);
  t.mock.timers.tick(secondDelay + 1);
  await w.tick();
  const final = store.get(task.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'NUV_ESXI_UNREACHABLE');
  assert.equal(p.calls.execute, 3);
  assert.deepEqual(store.attempts(task.id).map(a => a.outcome), ['retry', 'retry', 'failed']);
});

test('ambiguous outcome: accepted by the provider but verification is unreachable → verification-required, never re-executed', async () => {
  const store = new TaskStore(), task = enqueue(store);
  const p = provider({ verify: async () => { throw failure('NUV_ESXI_UNREACHABLE', true); } });
  const w = worker(store, p);
  await w.tick();
  assert.equal(store.get(task.id).status, 'verification_required');
  await w.tick(); await w.tick();
  assert.equal(p.calls.execute, 1, 'a power operation must not be sent twice');
  assert.equal(store.claim('w', task.id), null, 'the task is not claimable again');
});

test('a permanent verification error after acceptance fails the task', async () => {
  const store = new TaskStore(), task = enqueue(store);
  await worker(store, provider({ verify: async () => { throw failure('NUV_VERIFICATION_REJECTED', false); } })).tick();
  assert.equal(store.get(task.id).status, 'failed');
});

test('duplicate delivery: two workers racing for one task execute it once', async () => {
  const store = new TaskStore(), task = enqueue(store), p = provider();
  const a = worker(store, p), b = worker(store, p);
  await Promise.all([a.tick(task.id), b.tick(task.id), a.tick(task.id)]);
  assert.equal(p.calls.execute, 1);
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(store.attempts(task.id).length, 1);
});

test('a task cancelled while queued is never executed', async () => {
  const store = new TaskStore(), task = enqueue(store), p = provider();
  store.cancel(task.id);
  await worker(store, p).tick();
  assert.equal(p.calls.execute, 0);
  assert.equal(store.get(task.id).status, 'cancelled');
});

test('worker crash: a task whose lease expires is recovered and completed by another tick', async () => {
  const store = new TaskStore(), task = enqueue(store), p = provider();
  store.claim('crashed-worker', task.id);            // claimed, then the worker dies without finishing
  assert.equal(store.get(task.id).status, 'running');
  assert.equal(await worker(store, p).tick(), undefined);
  assert.equal(p.calls.execute, 0, 'a task leased to a live worker is left alone');
  store.recoverExpired(Date.now() + 31_000);
  await worker(store, p).tick();
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(store.attempts(task.id).length, 2);
});

test('one failing task does not stop the next one from running', async () => {
  const store = new TaskStore();
  const bad = enqueue(store), good = enqueue(store);
  const p = provider({ execute: async (call, op, native) => { if (native === bad.providerNativeId) throw failure('NUV_PROVIDER_FAILURE', false); return { providerReference: `ref-${native}` }; } });
  const w = worker(store, p);
  await w.tick(); await w.tick();
  assert.equal(store.get(bad.id).status, 'failed');
  assert.equal(store.get(good.id).status, 'completed');
});

test('the provider is called with the native identifier, not the internal one', async () => {
  const store = new TaskStore(), task = enqueue(store, { providerNativeId: 'D:\\VMs\\X\\X.vmx' });
  const seen = [];
  await worker(store, provider({ execute: async (call, op, native) => { seen.push([op, native]); return { providerReference: 'r' }; } })).tick();
  assert.deepEqual(seen, [['start', 'D:\\VMs\\X\\X.vmx']]);
  assert.equal(store.get(task.id).status, 'completed');
});

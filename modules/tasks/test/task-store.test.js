import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.js';

let counter = 0;
const create = (store, over = {}) => store.create({ operation: 'start', targetId: `vm-${++counter}`, providerNativeId: `native-${counter}`, connectionId: 'c1', correlationId: `corr-${counter}`, idempotencyKey: `key-${counter}`, ...over }).task;
const ERR = { code: 'NUV_TEST', detail: 'test', retryable: false };
const OK = { code: 'NUV_OK' };

// Build a task sitting in each lifecycle state.
const inState = {
  queued: s => create(s),
  running: s => { const t = create(s); s.claim('w', t.id); return s.get(t.id); },
  completed: s => { const t = create(s); s.claim('w', t.id); s.complete(t.id, OK); return s.get(t.id); },
  failed: s => { const t = create(s); s.claim('w', t.id); s.fail(t.id, ERR); return s.get(t.id); },
  verification_required: s => { const t = create(s); s.claim('w', t.id); s.verificationRequired(t.id, ERR); return s.get(t.id); },
  cancelled: s => { const t = create(s); s.cancel(t.id); return s.get(t.id); }
};
const TERMINAL = ['completed', 'failed', 'cancelled'];

test('a new task is queued, audited and announced through the outbox', () => {
  const store = new TaskStore();
  const { task, created } = store.create({ operation: 'start', targetId: 'vm-a', correlationId: 'c', idempotencyKey: 'k' });
  assert.equal(created, true);
  assert.equal(task.status, 'queued');
  assert.equal(store.outbox().length, 1);
  assert.equal(store.outbox()[0].topic, 'task.queued');
  assert.equal(store.audit()[0].action, 'task.create');
});

test('the same idempotency key returns the existing task instead of creating another', () => {
  const store = new TaskStore();
  const first = store.create({ operation: 'stop', targetId: 'vm-a', correlationId: 'c1', idempotencyKey: 'same' });
  const again = store.create({ operation: 'stop', targetId: 'vm-a', correlationId: 'c2', idempotencyKey: 'same' });
  assert.equal(again.created, false);
  assert.equal(again.task.id, first.task.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.outbox().length, 1, 'no second announcement');
});

test('legal path: queued → running → completed, with a recorded attempt', () => {
  const store = new TaskStore(), t = create(store);
  const claimed = store.claim('worker-1', t.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.lease.workerId, 'worker-1');
  store.complete(t.id, OK);
  const done = store.get(t.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.lease, undefined);
  assert.deepEqual(store.attempts(t.id).map(a => [a.attemptNo, a.outcome]), [[1, 'completed']]);
});

test('claiming is exclusive: a running task cannot be claimed again', () => {
  const store = new TaskStore(), t = create(store);
  assert.ok(store.claim('a', t.id));
  assert.equal(store.claim('b', t.id), null);
  assert.equal(store.claim('b'), null);
});

test('claim only picks queued tasks, and honours a specific task id', () => {
  const store = new TaskStore(), a = create(store), b = create(store);
  assert.equal(store.claim('w', b.id).id, b.id);
  assert.equal(store.claim('w').id, a.id);
});

for (const state of TERMINAL) {
  test(`${state} is final: completing, failing, retrying or flagging it for verification changes nothing`, () => {
    const store = new TaskStore(), t = inState[state](store);
    store.complete(t.id, OK); store.fail(t.id, ERR); store.retry(t.id, ERR, 1000); store.verificationRequired(t.id, ERR);
    assert.equal(store.get(t.id).status, state);
  });
}

test('only a queued task can be cancelled', () => {
  for (const state of ['running', 'completed', 'failed', 'verification_required']) {
    const store = new TaskStore(), t = inState[state](store);
    const result = store.cancel(t.id);
    assert.equal(result.ok, false, state);
    assert.equal(result.code, 'NUV_TASK_CANCELLATION_UNSAFE', state);
    assert.equal(store.get(t.id).status, state, `${state} must be untouched`);
  }
  const store = new TaskStore(), t = create(store);
  assert.equal(store.cancel(t.id, { id: 'u1' }).ok, true);
  assert.equal(store.get(t.id).status, 'cancelled');
  assert.equal(store.cancel('missing').code, 'NUV_TASK_NOT_FOUND');
});

test('a cancelled task is never handed to a worker', () => {
  const store = new TaskStore(), t = create(store);
  store.cancel(t.id);
  assert.equal(store.claim('w'), null);
});

test('only a failed task can be manually retried; it returns to the queue clean', () => {
  for (const state of ['queued', 'running', 'completed', 'cancelled', 'verification_required']) {
    const store = new TaskStore(), t = inState[state](store);
    const result = store.manualRetry(t.id);
    assert.equal(result.ok, false, state);
    assert.equal(result.code, 'NUV_TASK_RETRY_UNSAFE', state);
  }
  const store = new TaskStore(), t = inState.failed(store);
  const result = store.manualRetry(t.id, { id: 'u1' });
  assert.equal(result.ok, true);
  assert.equal(result.task.status, 'queued');
  assert.equal(result.task.error, null);
  assert.equal(store.manualRetry('missing').code, 'NUV_TASK_NOT_FOUND');
  assert.ok(store.claim('w', t.id), 'the retried task can be claimed again');
});

test('an automatic retry requeues the task but it is not claimable until it is due', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T00:00:00Z') });
  const store = new TaskStore(), task = inState.running(store);
  store.retry(task.id, { ...ERR, retryable: true }, 5000);
  const queued = store.get(task.id);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.lease, undefined);
  assert.equal(store.claim('w', task.id), null, 'not yet due');
  t.mock.timers.tick(4999);
  assert.equal(store.claim('w', task.id), null, 'still not due');
  t.mock.timers.tick(2);
  assert.ok(store.claim('w', task.id), 'due');
  assert.deepEqual(store.attempts(task.id).map(a => a.outcome), ['retry', null]);
});

test('verification-required is not final: reconciliation can complete or fail it', () => {
  const store = new TaskStore();
  const a = inState.verification_required(store), b = inState.verification_required(store);
  assert.equal(store.listVerificationRequired().length, 2);
  store.complete(a.id, OK); store.fail(b.id, ERR);
  assert.equal(store.get(a.id).status, 'completed');
  assert.equal(store.get(b.id).status, 'failed');
  assert.equal(store.listVerificationRequired().length, 0);
});

test('superseding works on queued and running tasks only', () => {
  for (const state of ['queued', 'running']) {
    const store = new TaskStore(), t = inState[state](store);
    const result = store.supersede(t.id, { replacementOperation: 'power_off' });
    assert.equal(result.ok, true, state);
    assert.equal(store.get(t.id).status, 'cancelled');
    assert.equal(store.get(t.id).error.code, 'NUV_TASK_SUPERSEDED');
  }
  for (const state of ['completed', 'failed', 'cancelled', 'verification_required']) {
    const store = new TaskStore(), t = inState[state](store);
    assert.equal(store.supersede(t.id).code, 'NUV_TASK_SUPERSEDE_UNSAFE', state);
  }
});

test('a crashed worker is recovered: an expired lease puts the task back in the queue', () => {
  const store = new TaskStore(), t = inState.running(store);
  assert.equal(store.recoverExpired(Date.now()), 0, 'lease still valid');
  assert.equal(store.get(t.id).status, 'running');
  assert.equal(store.recoverExpired(Date.now() + 31_000), 1);
  assert.equal(store.get(t.id).status, 'queued');
  assert.ok(store.claim('w2', t.id));
  assert.equal(store.attempts(t.id).length, 2);
});

test('activeForTarget finds queued or running work only', () => {
  const store = new TaskStore();
  const q = create(store, { targetId: 'vm-q' }), r = inState.running(store), d = inState.completed(store);
  assert.equal(store.activeForTarget('vm-q').id, q.id);
  assert.equal(store.activeForTarget(r.target.id).id, r.id);
  assert.equal(store.activeForTarget(d.target.id), null);
});

test('every state change is audited with the right outcome', () => {
  const store = new TaskStore();
  inState.completed(store); inState.failed(store); inState.cancelled(store); inState.verification_required(store);
  const pairs = store.audit({ limit: 100 }).map(e => `${e.action}:${e.outcome}`);
  for (const expected of ['task.complete:succeeded', 'task.complete:failed', 'task.cancel:succeeded', 'task.verification_required:warning', 'task.create:succeeded']) {
    assert.ok(pairs.includes(expected), expected);
  }
});

test('outbox messages are delivered once: marking one published removes it from pending', () => {
  const store = new TaskStore();
  create(store); create(store);
  const [first] = store.pendingOutbox();
  store.markOutboxPublished(first.id);
  assert.equal(store.pendingOutbox().length, 1);
  assert.notEqual(store.pendingOutbox()[0].id, first.id);
});

test('state survives a restart when a file is configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-tasks-'));
  try {
    const file = join(dir, 'state.json');
    const first = new TaskStore({ file });
    const t = inState.running(first);
    const reloaded = new TaskStore({ file });
    assert.equal(reloaded.get(t.id).status, 'running');
    assert.equal(reloaded.attempts(t.id).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('metrics reflect the current mix of states', () => {
  const store = new TaskStore();
  inState.completed(store); inState.failed(store); inState.running(store); inState.queued(store);
  const m = store.metrics();
  assert.deepEqual([m.tasksTotal, m.tasksCompleted, m.tasksFailed, m.tasksRunning, m.tasksQueued], [4, 1, 1, 1, 1]);
});

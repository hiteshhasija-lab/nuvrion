import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PostgresTaskStore } from '../src/postgres-task-store.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// These run the production task store against a real PostgreSQL server (see database/test-support/test-database.js).
// They mirror task-store.test.js, which covers the in-memory store, and add what only a database can show:
// concurrent claims, row locking, transactions that roll back, and constraints.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const shared = db ? new PostgresTaskStore(db.pool) : null; // one store for the file: every store registers a pool error listener
const store = () => shared;
after(async () => { await db?.drop(); });
beforeEach(async () => {
  if (!db) return;
  await db.pool.query('TRUNCATE audit.audit_events, operations.outbox_messages, operations.task_leases, operations.task_attempts, operations.tasks CASCADE');
});

let counter = 0;
const input = (over = {}) => ({ operation: 'start', targetId: randomUUID(), providerNativeId: `native-${++counter}`, connectionId: null, correlationId: randomUUID(), idempotencyKey: `key-${counter}-${randomUUID()}`, ...over });
const create = async (s, over = {}) => (await s.create(input(over))).task;
const ERR = { code: 'NUV_TEST', detail: 'test', retryable: false };
const OK = { code: 'NUV_OK' };
// queued_at has millisecond resolution, so tasks created back to back can tie; tests that depend on order set it explicitly.
const queuedSecondsAgo = (task, seconds) => db.pool.query("UPDATE operations.tasks SET queued_at = now() - make_interval(secs => $2) WHERE task_id = $1", [task.id, seconds]);
const scalar = async (sql, params = []) => Object.values((await db.pool.query(sql, params)).rows[0])[0];

const inState = {
  queued: s => create(s),
  running: async s => { const t = await create(s); await s.claim('w', t.id); return s.get(t.id); },
  completed: async s => { const t = await create(s); await s.claim('w', t.id); await s.complete(t.id, OK); return s.get(t.id); },
  failed: async s => { const t = await create(s); await s.claim('w', t.id); await s.fail(t.id, ERR); return s.get(t.id); },
  verification_required: async s => { const t = await create(s); await s.claim('w', t.id); await s.verificationRequired(t.id, ERR); return s.get(t.id); },
  cancelled: async s => { const t = await create(s); await s.cancel(t.id); return s.get(t.id); }
};
const TERMINAL = ['completed', 'failed', 'cancelled'];

test('a database connection problem marks the store unhealthy and is reported', () => {
  const pool = new EventEmitter();
  const reported = [];
  const s = new PostgresTaskStore(pool, { onPoolError: error => reported.push(error.code) });
  assert.equal(s.status, 'healthy');
  pool.emit('error', Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
  assert.equal(s.status, 'unhealthy');
  assert.deepEqual(reported, ['ECONNRESET']);
});

test('a new task is queued, audited and announced through the outbox', database, async () => {
  const s = store();
  const { task, created } = await s.create(input());
  assert.equal(created, true);
  assert.equal(task.status, 'queued');
  assert.deepEqual(task.progress, { current: 0, total: 1, messageCode: 'NUV_TASK_QUEUED' });
  const outbox = await s.pendingOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].topic, 'task.queued');
  assert.deepEqual(outbox[0].payload, { taskId: task.id });
  assert.equal((await s.audit())[0].action, 'task.create');
});

test('the same idempotency key returns the existing task instead of creating another', database, async () => {
  const s = store();
  const first = await s.create(input({ idempotencyKey: 'same' }));
  const again = await s.create(input({ idempotencyKey: 'same', correlationId: randomUUID() }));
  assert.equal(again.created, false);
  assert.equal(again.task.id, first.task.id);
  assert.equal((await s.list()).length, 1);
  assert.equal((await s.pendingOutbox()).length, 1, 'no second announcement');
  assert.equal((await s.getByIdempotencyKey('same')).id, first.task.id);
  assert.equal(await s.getByIdempotencyKey('unknown'), null);
});

test('the idempotency key is stored only as a hash', database, async () => {
  await create(store(), { idempotencyKey: 'secret-looking-key' });
  const stored = await scalar('SELECT idempotency_key_hash FROM operations.tasks');
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.trim(), 'secret-looking-key');
});

test('concurrent requests with the same idempotency key create exactly one task', database, async () => {
  const s = store();
  for (let round = 0; round < 5; round++) {
    const key = `race-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => s.create(input({ idempotencyKey: key }))));
    assert.equal(results.filter(r => r.created).length, 1, `round ${round}: exactly one request creates the task`);
    assert.equal(new Set(results.map(r => r.task.id)).size, 1, `round ${round}: every caller is given the same task`);
  }
  assert.equal(await scalar('SELECT count(*)::int FROM operations.tasks'), 5);
  assert.equal(await scalar('SELECT count(*)::int FROM operations.outbox_messages'), 5, 'each task announced once');
  assert.equal(await scalar("SELECT count(*)::int FROM audit.audit_events WHERE action = 'task.create'"), 5, 'each task audited once');
});

test('creating a task is atomic: if the audit record cannot be written, no task or announcement remains', database, async () => {
  // audit.audit_events.target_id is a uuid, so a non-uuid target makes the last insert fail after the task and outbox rows were written.
  await assert.rejects(() => store().create(input({ targetId: 'not-a-uuid' })));
  assert.equal(await scalar('SELECT count(*)::int FROM operations.tasks'), 0);
  assert.equal(await scalar('SELECT count(*)::int FROM operations.outbox_messages'), 0);
  assert.equal(await scalar('SELECT count(*)::int FROM audit.audit_events'), 0);
});

test('the requesting user is recorded, and an unknown user is refused without leaving anything behind', database, async () => {
  const userId = randomUUID();
  await db.pool.query("INSERT INTO identity.users(user_id, username, normalized_username, display_name, status, password_hash) VALUES($1, 'Ops', 'ops', 'Ops', 'active', 'x')", [userId]);
  const s = store();
  const task = await create(s, { requestedBy: { id: userId, username: 'Ops' } });
  assert.deepEqual(task.requestedBy, { id: userId, username: 'Ops' });
  assert.equal((await s.audit())[0].actorId, userId);
  await assert.rejects(() => s.create(input({ requestedBy: { id: randomUUID(), username: 'ghost' } })), error => error.code === '23503');
  assert.equal(await scalar('SELECT count(*)::int FROM operations.tasks'), 1);
});

test('legal path: queued → running → completed, with a recorded attempt and a lease that is released', database, async () => {
  const s = store(), t = await create(s);
  const claimed = await s.claim('worker-1', t.id);
  assert.equal(claimed.status, 'running');
  assert.ok(claimed.startedAt);
  const lease = (await db.pool.query('SELECT * FROM operations.task_leases WHERE task_id = $1', [t.id])).rows[0];
  assert.equal(lease.worker_id, 'worker-1');
  assert.ok(lease.expires_at > lease.acquired_at);
  assert.equal(await s.complete(t.id, OK), true);
  const done = await s.get(t.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, OK);
  assert.deepEqual(done.progress, { current: 1, total: 1, messageCode: 'NUV_TASK_COMPLETED' });
  assert.equal(await scalar('SELECT count(*)::int FROM operations.task_leases WHERE task_id = $1', [t.id]), 0);
  assert.deepEqual((await s.attempts(t.id)).map(a => [a.attempt_no, a.outcome]), [[1, 'completed']]);
});

test('claiming is exclusive: a running task cannot be claimed again', database, async () => {
  const s = store(), t = await create(s);
  assert.ok(await s.claim('a', t.id));
  assert.equal(await s.claim('b', t.id), null);
  assert.equal(await s.claim('b'), null);
});

test('claim only picks queued tasks, oldest first, and honours a specific task id', database, async () => {
  const s = store(), a = await create(s), b = await create(s);
  await queuedSecondsAgo(a, 20); await queuedSecondsAgo(b, 10);
  assert.equal((await s.claim('w', b.id)).id, b.id);
  assert.equal((await s.claim('w')).id, a.id);
  assert.equal(await s.claim('w'), null, 'nothing left');
});

test('many workers claiming at once never receive the same task', database, async () => {
  const s = store();
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add((await create(s)).id);
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => s.claim(`worker-${i}`)));
  assert.equal(claims.filter(Boolean).length, 20, 'every task was claimed');
  assert.equal(new Set(claims.map(c => c.id)).size, 20, 'no task was claimed twice');
  assert.deepEqual(new Set(claims.map(c => c.id)), ids);
  assert.equal(await scalar('SELECT count(*)::int FROM operations.task_attempts'), 20, 'one attempt each');
});

test('more workers than tasks: the extra workers get nothing, and each task is claimed exactly once', database, async () => {
  const s = store();
  for (let i = 0; i < 4; i++) await create(s);
  const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => s.claim(`worker-${i}`)));
  assert.equal(claims.filter(Boolean).length, 4);
  assert.equal(new Set(claims.filter(Boolean).map(c => c.id)).size, 4);
  assert.equal(await scalar("SELECT count(*)::int FROM operations.tasks WHERE status = 'running'"), 4);
});

test('workers racing for one specific task: exactly one wins', database, async () => {
  const s = store(), t = await create(s);
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => s.claim(`worker-${i}`, t.id)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await scalar('SELECT count(*)::int FROM operations.task_attempts WHERE task_id = $1', [t.id]), 1);
});

for (const state of TERMINAL) {
  test(`${state} is final: completing, failing, retrying or flagging it for verification changes nothing`, database, async () => {
    const s = store(), t = await inState[state](s);
    const before = await db.pool.query('SELECT count(*)::int FROM audit.audit_events');
    assert.equal(await s.complete(t.id, OK), false);
    assert.equal(await s.fail(t.id, ERR), false);
    assert.equal(await s.retry(t.id, ERR, 1000), false);
    assert.equal(await s.verificationRequired(t.id, ERR), false);
    assert.equal((await s.get(t.id)).status, state);
    assert.deepEqual((await db.pool.query('SELECT count(*)::int FROM audit.audit_events')).rows, before.rows, 'and nothing is audited');
  });
}

test('two workers finishing the same task at once: one outcome is recorded, the other is ignored', database, async () => {
  const s = store(), t = await inState.running(s);
  const outcomes = await Promise.all([s.complete(t.id, OK), s.fail(t.id, ERR), s.complete(t.id, OK), s.fail(t.id, ERR)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await scalar("SELECT count(*)::int FROM audit.audit_events WHERE action = 'task.complete'"), 1);
});

test('only a queued task can be cancelled', database, async () => {
  for (const state of ['running', 'completed', 'failed', 'verification_required']) {
    const s = store(), t = await inState[state](s);
    const result = await s.cancel(t.id);
    assert.equal(result.ok, false, state);
    assert.equal(result.code, 'NUV_TASK_CANCELLATION_UNSAFE', state);
    assert.equal((await s.get(t.id)).status, state, `${state} must be untouched`);
  }
  const s = store(), t = await create(s);
  assert.equal((await s.cancel(t.id, { id: randomUUID() })).ok, true);
  assert.equal((await s.get(t.id)).status, 'cancelled');
  assert.equal((await s.cancel(randomUUID())).code, 'NUV_TASK_NOT_FOUND');
});

test('a cancelled task is never handed to a worker', database, async () => {
  const s = store(), t = await create(s);
  await s.cancel(t.id);
  assert.equal(await s.claim('w'), null);
});

test('cancelling while a worker claims the same task: exactly one of them wins', database, async () => {
  for (let round = 0; round < 10; round++) {
    const s = store(), t = await create(s);
    const [cancelled, claimed] = await Promise.all([s.cancel(t.id), s.claim('w', t.id)]);
    assert.notEqual(cancelled.ok, Boolean(claimed), 'either cancelled or claimed, never both and never neither');
    assert.equal((await s.get(t.id)).status, claimed ? 'running' : 'cancelled');
  }
});

test('only a failed task can be manually retried; it returns to the queue clean', database, async () => {
  for (const state of ['queued', 'running', 'completed', 'cancelled', 'verification_required']) {
    const s = store(), t = await inState[state](s);
    const result = await s.manualRetry(t.id);
    assert.equal(result.ok, false, state);
    assert.equal(result.code, 'NUV_TASK_RETRY_UNSAFE', state);
  }
  const s = store(), t = await inState.failed(s);
  const result = await s.manualRetry(t.id, { id: randomUUID() });
  assert.equal(result.ok, true);
  assert.equal(result.task.status, 'queued');
  assert.equal(result.task.error, null);
  assert.equal(result.task.completedAt, null);
  assert.equal((await s.manualRetry(randomUUID())).code, 'NUV_TASK_NOT_FOUND');
  assert.ok(await s.claim('w', t.id), 'the retried task can be claimed again');
  assert.equal((await s.attempts(t.id)).length, 2);
});

test('an automatic retry requeues the task, but it is not claimable or announced until it is due', database, async () => {
  const s = store(), task = await inState.running(s);
  await s.pendingOutbox().then(messages => Promise.all(messages.map(m => s.markOutboxPublished(m.id))));
  assert.equal(await s.retry(task.id, { ...ERR, retryable: true, code: 'NUV_RETRYABLE' }, 60_000), true);
  const queued = await s.get(task.id);
  assert.equal(queued.status, 'queued');
  assert.ok(queued.retryAt > new Date());
  assert.equal(await scalar('SELECT count(*)::int FROM operations.task_leases WHERE task_id = $1', [task.id]), 0);
  assert.equal(await s.claim('w', task.id), null, 'not yet due');
  assert.equal(await s.claim('w'), null, 'not yet due, for any worker');
  assert.equal((await s.pendingOutbox()).length, 0, 'the announcement is held back until the retry is due');
  await db.pool.query("UPDATE operations.tasks SET retry_at = now() - interval '1 second' WHERE task_id = $1", [task.id]);
  await db.pool.query("UPDATE operations.outbox_messages SET occurred_at = now() - interval '1 second' WHERE message_key = $1 AND published_at IS NULL", [task.id]);
  assert.equal((await s.pendingOutbox()).length, 1, 'announced once due');
  assert.ok(await s.claim('w', task.id), 'claimable once due');
  assert.deepEqual((await s.attempts(task.id)).map(a => a.outcome), ['retry', null]);
  assert.equal((await s.get(task.id)).retryAt, null, 'the retry time is cleared when claimed');
});

test('verification-required is not final: reconciliation can complete or fail it', database, async () => {
  const s = store();
  const a = await inState.verification_required(s), b = await inState.verification_required(s);
  assert.equal((await s.listVerificationRequired()).length, 2);
  await s.complete(a.id, OK); await s.fail(b.id, ERR);
  assert.equal((await s.get(a.id)).status, 'completed');
  assert.equal((await s.get(b.id)).status, 'failed');
  assert.equal((await s.listVerificationRequired()).length, 0);
});

test('superseding works on queued and running tasks only', database, async () => {
  for (const state of ['queued', 'running']) {
    const s = store(), t = await inState[state](s);
    const result = await s.supersede(t.id, { replacementOperation: 'power_off' });
    assert.equal(result.ok, true, state);
    assert.equal((await s.get(t.id)).status, 'cancelled');
    assert.equal((await s.get(t.id)).error.code, 'NUV_TASK_SUPERSEDED');
    assert.equal(await scalar('SELECT count(*)::int FROM operations.task_leases WHERE task_id = $1', [t.id]), 0);
  }
  for (const state of ['completed', 'failed', 'cancelled', 'verification_required']) {
    const s = store(), t = await inState[state](s);
    assert.equal((await s.supersede(t.id)).code, 'NUV_TASK_SUPERSEDE_UNSAFE', state);
  }
  assert.equal((await store().supersede(randomUUID())).code, 'NUV_TASK_NOT_FOUND');
});

test('a crashed worker is recovered: an expired lease puts the task back in the queue', database, async () => {
  const s = store(), t = await inState.running(s);
  assert.equal(await s.recoverExpired(), 0, 'lease still valid');
  assert.equal((await s.get(t.id)).status, 'running');
  await db.pool.query("UPDATE operations.task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1", [t.id]);
  assert.equal(await s.recoverExpired(), 1);
  assert.equal((await s.get(t.id)).status, 'queued');
  assert.equal(await scalar('SELECT count(*)::int FROM operations.task_leases WHERE task_id = $1', [t.id]), 0);
  assert.ok(await s.claim('w2', t.id));
  assert.equal((await s.attempts(t.id)).length, 2);
});

test('recovery leaves tasks whose lease is still valid alone', database, async () => {
  const s = store(), healthy = await inState.running(s), crashed = await inState.running(s);
  await db.pool.query("UPDATE operations.task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1", [crashed.id]);
  assert.equal(await s.recoverExpired(), 1);
  assert.equal((await s.get(healthy.id)).status, 'running');
  assert.equal((await s.get(crashed.id)).status, 'queued');
});

test('activeForTarget finds queued or running work only', database, async () => {
  const s = store();
  const q = await create(s), r = await inState.running(s), d = await inState.completed(s);
  assert.equal((await s.activeForTarget(q.target.id)).id, q.id);
  assert.equal((await s.activeForTarget(r.target.id)).id, r.id);
  assert.equal(await s.activeForTarget(d.target.id), null);
});

test('every state change is audited with the right outcome', database, async () => {
  const s = store();
  await inState.completed(s); await inState.failed(s); await inState.cancelled(s); await inState.verification_required(s);
  const pairs = (await s.audit({ limit: 100 })).map(e => `${e.action}:${e.outcome}`);
  for (const expected of ['task.complete:succeeded', 'task.complete:failed', 'task.cancel:succeeded', 'task.verification_required:warning', 'task.create:succeeded']) {
    assert.ok(pairs.includes(expected), expected);
  }
});

test('the audit log can be filtered, searched and paged, with a total', database, async () => {
  const s = store();
  for (let i = 0; i < 5; i++) await inState.completed(s);
  await inState.failed(s);
  const completed = await s.auditPage({ action: 'task.complete', outcome: 'succeeded', limit: 3 });
  assert.equal(completed.items.length, 3);
  assert.equal(completed.total, 5);
  assert.equal((await s.auditPage({ action: 'task.complete', outcome: 'succeeded', limit: 3, offset: 3 })).items.length, 2);
  assert.equal((await s.auditPage({ outcome: 'failed' })).total, 1);
  assert.equal((await s.auditPage({ search: 'task.cancel' })).total, 0);
  await s.recordAudit({ action: 'user.login', targetType: 'user', targetId: randomUUID(), correlationId: randomUUID(), actorName: 'alice' });
  assert.equal((await s.auditPage({ search: 'ALICE' })).total, 1, 'search matches actor names without regard to case');
});

test('outbox messages are delivered once: marking one published removes it from pending', database, async () => {
  const s = store();
  await create(s); await create(s);
  const [first] = await s.pendingOutbox();
  await s.markOutboxPublished(first.id);
  const pending = await s.pendingOutbox();
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].id, first.id);
  assert.equal(await scalar('SELECT attempts FROM operations.outbox_messages WHERE message_id = $1', [first.id]), 1);
});

test('state survives a restart: a new connection pool sees the same tasks, attempts and lease', database, async () => {
  const t = await inState.running(store());
  const { default: pg } = await import('pg');
  const reopened = new PostgresTaskStore(new pg.Pool({ connectionString: db.connectionString }));
  try {
    assert.equal((await reopened.get(t.id)).status, 'running');
    assert.equal((await reopened.attempts(t.id)).length, 1);
    assert.equal(await reopened.claim('other', t.id), null, 'the lease still protects it');
  } finally { await reopened.close(); }
});

test('metrics reflect the current mix of states', database, async () => {
  const s = store();
  await inState.completed(s); await inState.failed(s); await inState.running(s); await inState.queued(s);
  const m = await s.metrics();
  assert.deepEqual([m.tasksTotal, m.tasksCompleted, m.tasksFailed, m.tasksRunning, m.tasksQueued], [4, 1, 1, 1, 1]);
});

test('the task list is newest first and a missing task is null', database, async () => {
  const s = store();
  const a = await create(s), b = await create(s);
  await queuedSecondsAgo(a, 20); await queuedSecondsAgo(b, 10);
  assert.deepEqual((await s.list()).map(t => t.id), [b.id, a.id]);
  assert.equal(await s.get(randomUUID()), null);
});

test('closing the store ends its connections', database, async () => {
  const { default: pg } = await import('pg');
  const s = new PostgresTaskStore(new pg.Pool({ connectionString: db.connectionString }));
  await s.metrics();
  await s.close();
  assert.equal(s.status, 'stopped');
  await assert.rejects(() => s.metrics());
});

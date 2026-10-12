import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { RabbitTaskBroker, OutboxRelay } from '../src/task-broker.js';
import { PostgresTaskStore } from '../../tasks/src/postgres-task-store.js';
import { Worker } from '../../../apps/worker/src/worker.js';
import { createTestDatabase, adminUrl } from '../../../database/test-support/test-database.js';

// A real RabbitMQ, restarted while tasks are flowing. task-broker.test.js replaces RabbitMQ with a recording fake, which cannot show
// what a real broker does when it goes away: how amqplib reports it, what happens to a message that is being handled, what becomes of
// messages that were published but not yet consumed. These tests run the production chain (PostgreSQL task store, outbox relay, RabbitMQ
// broker, worker) against rabbitmq:3.13-alpine, the image production runs, started through docker or podman, and stop, kill and restart it.
//
// They run when NUVRION_TEST_LIVE_BROKER=1 (a container tool and a PostgreSQL for NUVRION_TEST_DATABASE_URL are needed). CI also sets
// NUVRION_REQUIRE_BROKER_TESTS=1, so that a missing container tool or database fails the build instead of skipping the tests.
const required = process.env.NUVRION_REQUIRE_BROKER_TESTS === '1';
const enabled = required || process.env.NUVRION_TEST_LIVE_BROKER === '1';
// the tag production runs, pinned by digest (the multi-architecture index) so that a moved tag cannot change what the tests run against
const image = process.env.NUVRION_TEST_BROKER_IMAGE ?? 'docker.io/library/rabbitmq:3.13-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc';
const cli = ['docker', 'podman'].find(name => name === process.env.NUVRION_TEST_CONTAINER_CLI || (!process.env.NUVRION_TEST_CONTAINER_CLI && spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0));
const problem = !enabled ? 'NUVRION_TEST_LIVE_BROKER is not set (no real RabbitMQ to test against)'
  : !cli ? 'neither docker nor podman is available to start RabbitMQ'
  : !adminUrl ? 'NUVRION_TEST_DATABASE_URL is not set (the chain needs PostgreSQL)' : null;
if (required && problem) throw new Error(`NUVRION_REQUIRE_BROKER_TESTS=1 but the live-broker tests cannot run: ${problem}`);
const options = { skip: problem ?? false };

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await condition(); if (value) return value; await wait(100); }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
};
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const run = (...args) => execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

const errors = [];                                   // anything that would end the process in production
const onProcessError = error => errors.push(error);
process.on('unhandledRejection', onProcessError);
process.on('uncaughtException', onProcessError);

let broker = null;                                   // the container; created by the first test that needs it
const container = { name: `nuvrion-test-rabbit-${randomBytes(4).toString('hex')}`, port: 0 };
const url = () => `amqp://guest:guest@127.0.0.1:${container.port}`; // secret-scan:allow (the default account of a disposable local test container)
async function brokerAccepts() {
  const { connect } = await import('amqplib');
  // a port forwarder in front of a stopped container can accept the connection and never answer, and amqplib has no timeout of its own
  const attempt = connect(url()).then(connection => connection, () => null);
  const connection = await Promise.race([attempt, wait(3000).then(() => null)]);
  if (!connection) { attempt.then(late => late?.close().catch(() => {})); return false; }
  await connection.close().catch(() => {});
  return true;
}
async function startContainer() {
  container.port = await freePort();
  run('run', '-d', '--name', container.name, '-p', `127.0.0.1:${container.port}:5672`, image);
  await until(brokerAccepts, 120_000, 'RabbitMQ to accept connections');
  broker = container;
}
// rootless podman can refuse to start a container again for a moment after it stopped ('Address already in use' from its port forwarder), so a start is retried
async function start() {
  for (let attempt = 1; ; attempt++) {
    try { run('start', container.name); return; } catch (error) { if (attempt >= 10) throw error; await wait(1000); }
  }
}
async function restartContainer(mode) {
  // 'restart' is an orderly shutdown and start; 'crash' is SIGKILL and start; 'stop' only stops (the caller starts it again).
  if (mode === 'restart') { run('stop', '-t', '5', container.name); await start(); }
  else if (mode === 'crash') { run('kill', container.name); await start(); }
  else if (mode === 'stop') run('stop', '-t', '5', container.name);
  else if (mode === 'start') await start();
  if (mode !== 'stop') await until(brokerAccepts, 120_000, 'RabbitMQ to accept connections after the restart');
}
after(() => {
  process.off('unhandledRejection', onProcessError);
  process.off('uncaughtException', onProcessError);
  if (broker) { try { run('rm', '-f', '-v', container.name); } catch { /* already gone */ } }
});

// The production chain, with a provider that counts how often each task was really executed.
async function chain({ providerDelayMs = 0, reconnectMs = 250, startWorker = true, heartbeatMs = 10_000, scripted = {} } = {}) {
  if (!broker) await startContainer();
  const db = await createTestDatabase();
  const store = new PostgresTaskStore(db.pool);
  const executions = new Map(), verifies = new Map(), relayErrors = [];
  const provider = {
    // `scripted.execute(callNumber, task)` and `scripted.verify(callNumber, reference)` let a test make a call hang, to stand for a process that dies in the middle of it
    execute: async (operation, nativeId, task) => {
      const call = (executions.get(task.id) ?? 0) + 1; executions.set(task.id, call);
      if (scripted.execute) return scripted.execute(call, task);
      if (providerDelayMs) await wait(providerDelayMs);
      return { providerReference: `ref-${task.id}` };
    },
    verify: async reference => { const call = (verifies.get(reference) ?? 0) + 1; verifies.set(reference, call); return scripted.verify ? scripted.verify(call, reference) : { state: 'done' }; }
  };
  const messageBroker = await RabbitTaskBroker.connect(url(), { reconnectMs });
  const worker = new Worker({ store, provider, broker: messageBroker, heartbeatMs });
  if (startWorker) await worker.start();
  const relay = new OutboxRelay({ store, broker: messageBroker, intervalMs: 100, onError: error => relayErrors.push(error.message) });
  relay.start();
  let n = 0;
  const create = async () => (await store.create({ operation: 'start', targetId: randomUUID(), providerNativeId: `native-${++n}`, connectionId: null, correlationId: randomUUID(), idempotencyKey: `live-${randomUUID()}` })).task;
  const statuses = async () => Object.fromEntries((await db.pool.query('SELECT status, count(*)::int AS n FROM operations.tasks GROUP BY status')).rows.map(row => [row.status, row.n]));
  const pendingOutbox = async () => (await db.pool.query('SELECT count(*)::int AS n FROM operations.outbox_messages WHERE published_at IS NULL')).rows[0].n;
  const completed = async () => (await statuses()).completed ?? 0;
  const close = async () => { relay.close(); await worker.close(); await db.drop(); };
  return { db, store, worker, messageBroker, executions, relayErrors, create, statuses, pendingOutbox, completed, close };
}
const exactlyOnce = (executions, tasks) => {
  const counts = tasks.map(task => executions.get(task.id) ?? 0);
  return { missing: counts.filter(count => count === 0).length, duplicated: counts.filter(count => count > 1).length };
};

test('an idle broker is restarted: the connection comes back by itself and the next task is delivered', options, async t => {
  const c = await chain();
  try {
    assert.equal(c.messageBroker.status, 'healthy');
    const before = Date.now();
    await restartContainer('restart');
    await until(() => c.messageBroker.status === 'healthy', 60_000, 'the broker connection to be healthy again');
    t.diagnostic(`back to healthy ${Date.now() - before} ms after the restart began`);
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(await c.create());
    await until(async () => (await c.completed()) === 5, 30_000, 'five tasks to complete');
    assert.deepEqual(exactlyOnce(c.executions, tasks), { missing: 0, duplicated: 0 });
    assert.deepEqual(errors.map(String), [], 'nothing escaped as an unhandled error');
  } finally { await c.close(); }
});

test('tasks created while the broker is stopped are not lost: they are delivered once it is back, each executed once', options, async t => {
  const c = await chain();
  try {
    await restartContainer('stop');
    await until(() => c.messageBroker.status !== 'healthy', 30_000, 'the broker connection to be reported unhealthy');
    const tasks = [];
    for (let i = 0; i < 20; i++) tasks.push(await c.create());
    await wait(1500);
    assert.equal(await c.completed(), 0, 'nothing can complete while the broker is stopped');
    assert.ok(await c.pendingOutbox() > 0, 'the tasks wait in the outbox');
    await restartContainer('start');
    await until(async () => (await c.completed()) === 20, 60_000, 'twenty tasks to complete after the broker is back');
    assert.deepEqual(exactlyOnce(c.executions, tasks), { missing: 0, duplicated: 0 });
    assert.equal(await c.pendingOutbox(), 0);
    t.diagnostic(`relay reported ${c.relayErrors.length} publish failures while the broker was down`);
    assert.deepEqual(errors.map(String), []);
  } finally { await c.close(); }
});

test('a restart while tasks are being handled: nothing crashes, nothing is lost, nothing is executed twice', options, async t => {
  const c = await chain({ providerDelayMs: 1500 });
  try {
    const tasks = [];
    for (let i = 0; i < 30; i++) { tasks.push(await c.create()); await wait(60); }
    await wait(200);
    await restartContainer('restart');
    await until(async () => (await c.completed()) === 30, 120_000, 'thirty tasks to complete');
    const counts = exactlyOnce(c.executions, tasks);
    t.diagnostic(`statuses ${JSON.stringify(await c.statuses())}; ${JSON.stringify(counts)}; errors that would end the process: ${errors.length}`);
    assert.deepEqual(errors.map(String), [], 'no unhandled rejection or exception escaped');
    assert.deepEqual(counts, { missing: 0, duplicated: 0 });
  } finally { await c.close(); }
});

test('the broker crashes (killed, not shut down) under load: nothing is lost and nothing is executed twice', options, async t => {
  const c = await chain({ providerDelayMs: 800 });
  try {
    const tasks = [];
    for (let i = 0; i < 30; i++) { tasks.push(await c.create()); await wait(40); }
    await wait(200);
    await restartContainer('crash');
    await until(async () => (await c.completed()) === 30, 120_000, 'thirty tasks to complete after the crash');
    const counts = exactlyOnce(c.executions, tasks);
    t.diagnostic(`statuses ${JSON.stringify(await c.statuses())}; ${JSON.stringify(counts)}; errors that would end the process: ${errors.length}`);
    assert.deepEqual(errors.map(String), []);
    assert.deepEqual(counts, { missing: 0, duplicated: 0 });
  } finally { await c.close(); }
});

test('tasks whose messages were lost with the broker are announced again, and completed once each', options, async t => {
  const c = await chain({ startWorker: false });
  try {
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(await c.create());
    await until(async () => (await c.pendingOutbox()) === 0, 15_000, 'the relay to publish all five');
    run('exec', container.name, 'rabbitmqctl', 'purge_queue', 'nuvrion.tasks');       // the broker loses what it was holding
    await c.worker.start();
    await wait(1500);
    assert.equal(await c.completed(), 0, 'nothing will ever arrive: the messages are gone');
    assert.equal(await c.store.reannounceStale({ olderThanMs: 1000 }), 5, 'the five tasks are queued, due, and have no message about');
    await until(async () => (await c.completed()) === 5, 30_000, 'five tasks to complete');
    assert.deepEqual(exactlyOnce(c.executions, tasks), { missing: 0, duplicated: 0 });
    assert.equal(await c.store.reannounceStale({ olderThanMs: 1000 }), 0, 'nothing is queued, so nothing more is announced');
    assert.deepEqual(errors.map(String), []);
  } finally { await c.close(); }
});

test('a worker that died before the provider accepted the operation: after the lease expires the task is queued again and completes', options, async t => {
  // the first provider call never returns and the lease is never renewed, which is what a process that was killed in the middle of it looks like
  const c = await chain({ heartbeatMs: 3_600_000, scripted: { execute: (call, task) => call === 1 ? new Promise(() => {}) : { providerReference: `ref-${task.id}-second` } } });
  try {
    const task = await c.create();
    await until(async () => (await c.statuses()).running === 1, 15_000, 'the task to be running');
    assert.equal((await c.store.recoverStranded()).requeued, 0, 'the lease is still valid: nothing is recovered');
    await c.db.pool.query("UPDATE operations.task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1", [task.id]);
    assert.deepEqual(await c.store.recoverStranded(), { requeued: 1, verificationRequired: 0, reannounced: 0 });
    await until(async () => (await c.completed()) === 1, 30_000, 'the task to complete the second time');
    assert.equal(c.executions.get(task.id), 2);
    const outcomes = (await c.store.attempts(task.id)).map(attempt => attempt.outcome);
    assert.deepEqual(outcomes, ['lease_expired', 'completed']);
  } finally { await c.close(); }
});

test('a worker that died after the provider accepted the operation: the task goes to verification and the operation is not run again', options, async t => {
  const c = await chain({ heartbeatMs: 3_600_000, scripted: { verify: () => new Promise(() => {}) } });
  try {
    const task = await c.create();
    await until(async () => (await c.store.get(task.id)).providerReference, 15_000, 'the provider to have accepted the operation');
    await c.db.pool.query("UPDATE operations.task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1", [task.id]);
    assert.deepEqual(await c.store.recoverStranded(), { requeued: 0, verificationRequired: 1, reannounced: 0 });
    await wait(2000);
    assert.equal((await c.store.get(task.id)).status, 'verification_required');
    assert.equal(c.executions.get(task.id), 1, 'the operation was executed once and not again');
    assert.equal(await c.pendingOutbox(), 0);
  } finally { await c.close(); }
});

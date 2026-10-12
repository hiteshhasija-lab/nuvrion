import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalTaskBroker, OutboxRelay, RabbitTaskBroker } from '../src/task-broker.js';

// The task queue: what is published, how it is consumed, what happens when RabbitMQ goes away, and how the outbox relay hands
// queued tasks to the broker. RabbitMQ itself is replaced by a recording fake; a live-broker restart is not covered here.
const schema = JSON.parse(readFileSync(new URL('../../../contracts/messages/task-queued.schema.json', import.meta.url), 'utf8'));
const { default: Ajv2020 } = await import('ajv/dist/2020.js'), { default: addFormats } = await import('ajv-formats');
const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
const validates = ajv.compile(schema);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await wait(5); } return condition(); };

function fakeRabbit({ failFirst = 0 } = {}) {
  const state = { connects: 0, connections: [], channels: [], sent: [], asserted: [], consumers: [], acked: [], nacked: [], confirms: 0, closed: 0, channelOpen: true, closeFails: false };
  const connectImpl = async url => {
    state.connects++;
    if (state.connects <= failFirst) throw new Error('connection refused');
    const handlers = {};
    const channel = {
      assertQueue: async (queue, options) => { state.asserted.push({ queue, options }); },
      sendToQueue: (queue, body, options) => { state.sent.push({ queue, body, options }); },
      waitForConfirms: async () => { state.confirms++; },
      consume: async (queue, handler, options) => { state.consumers.push({ queue, handler, options }); },
      // once the broker has gone away, settling a message throws, as amqplib's IllegalOperationError does
      ack: message => { if (!state.channelOpen) throw new Error('Channel closed'); state.acked.push(message); },
      nack: (message, all, requeue) => { if (!state.channelOpen) throw new Error('Channel closed'); state.nacked.push({ message, all, requeue }); },
      on: (event, handler) => { channel.handlers[event] = handler; },
      handlers: {},
      close: async () => { state.closed++; if (state.closeFails) throw new Error('Channel closed'); }
    };
    state.channels.push(channel);
    const connection = { url, handlers, createConfirmChannel: async () => channel, on: (event, handler) => { handlers[event] = handler; }, close: async () => { state.closed++; if (state.closeFails) throw new Error('Connection closed'); } };
    state.connections.push(connection);
    return connection;
  };
  return { state, connectImpl };
}
const delivery = body => ({ content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

test('the message in use is described by task-queued.schema.json: a task id and nothing else', () => {
  const id = randomUUID();
  assert.equal(validates({ taskId: id }), true);
  for (const bad of [{}, { taskId: 'not-a-uuid' }, { taskId: 7 }, { taskId: id, extra: true }, { taskId: id, operation: 'start' }, null, 'text', []]) assert.equal(validates(bad), false, JSON.stringify(bad));
});

test('publishing puts a persistent JSON message with the task id on a durable quorum queue, after the broker confirmed the queue', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl });
  assert.equal(broker.status, 'healthy');
  assert.deepEqual(state.asserted, [{ queue: 'nuvrion.tasks', options: { durable: true, arguments: { 'x-queue-type': 'quorum' } } }]);
  const id = randomUUID();
  await broker.publishTaskQueued(id);
  const [sent] = state.sent;
  assert.equal(sent.queue, 'nuvrion.tasks');
  assert.deepEqual(JSON.parse(sent.body.toString('utf8')), { taskId: id });
  assert.equal(validates(JSON.parse(sent.body.toString('utf8'))), true, 'what is really published matches the schema');
  assert.deepEqual([sent.options.persistent, sent.options.contentType, sent.options.messageId], [true, 'application/json', id]);
  assert.equal(state.confirms, 1, 'it waits for the broker to confirm the message');
  await broker.close();
});

test('publishing while the broker is unavailable fails loudly instead of losing the message', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  state.connections[0].handlers.close();
  assert.equal(broker.status, 'unhealthy');
  await assert.rejects(() => broker.publishTaskQueued(randomUUID()), /Task broker is unavailable/);
  assert.equal(state.sent.length, 0);
  await broker.close();
});

test('a delivered message reaches the handler parsed, and is acknowledged only after the handler succeeded', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl });
  const received = [];
  await broker.subscribe(async message => { received.push(message); });
  assert.equal(state.consumers.length, 1);
  assert.deepEqual(state.consumers[0].options, { noAck: false }, 'manual acknowledgement');
  const message = delivery({ taskId: 'task-1' });
  await state.consumers[0].handler(message);
  assert.deepEqual(received, [{ taskId: 'task-1' }]);
  assert.deepEqual([state.acked.length, state.nacked.length], [1, 0]);
  await state.consumers[0].handler(null);
  assert.deepEqual([state.acked.length, state.nacked.length], [1, 0], 'a cancelled consumer (null) is ignored');
  await broker.close();
});

test('a handler that fails puts the message back on the queue instead of dropping it', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl });
  await broker.subscribe(async () => { throw new Error('database unavailable'); });
  const message = delivery({ taskId: 'task-1' });
  await state.consumers[0].handler(message);
  assert.deepEqual(state.nacked, [{ message, all: false, requeue: true }]);
  assert.equal(state.acked.length, 0);
  await broker.close();
});

test('subscribing before the broker is reachable starts consuming as soon as it connects', async () => {
  const { state, connectImpl } = fakeRabbit({ failFirst: 1 });
  const broker = new RabbitTaskBroker('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  await assert.rejects(() => broker.open(), /connection refused/);
  assert.equal(broker.status, 'unhealthy');
  await broker.subscribe(async () => {});
  assert.equal(state.consumers.length, 0, 'nothing to consume from yet');
  assert.ok(await until(() => broker.status === 'healthy'), 'it reconnected by itself');
  assert.ok(await until(() => state.consumers.length === 1), 'and started consuming');
  await broker.close();
});

test('when the connection is lost the broker reports unhealthy, reconnects, and consumes again', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  await broker.subscribe(async () => {});
  assert.equal(state.consumers.length, 1);
  state.connections[0].handlers.close();
  assert.equal(broker.status, 'unhealthy');
  assert.ok(await until(() => broker.status === 'healthy'), 'healthy again');
  assert.equal(state.connects, 2);
  assert.ok(await until(() => state.consumers.length === 2), 'the consumer was re-attached to the new connection');
  const id = randomUUID();
  await broker.publishTaskQueued(id);
  assert.equal(state.sent.length, 1, 'publishing works again');
  await broker.close();
});

test('closing stops reconnecting and releases the channel and connection', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  await broker.close();
  assert.equal(broker.status, 'stopped');
  assert.equal(state.closed, 2, 'channel and connection');
  state.connections[0].handlers.close?.();
  await wait(40);
  assert.equal(state.connects, 1, 'no reconnect after an intentional close');
});

test('the local broker (used outside production) hands the task id to the subscriber', async () => {
  const broker = new LocalTaskBroker(), received = [];
  await broker.publishTaskQueued('ignored-without-subscriber');
  await broker.subscribe(message => received.push(message));
  await broker.publishTaskQueued('task-1');
  await wait(5);
  assert.deepEqual(received, [{ taskId: 'task-1' }]);
  await broker.close();
  assert.equal(broker.status, 'stopped');
});

// ---- the outbox relay ----------------------------------------------------------------------------------------
function relayWith({ pending, publish = async () => {}, onError = () => {} }) {
  const log = { published: [], marked: [] };
  const store = { pendingOutbox: async () => pending.filter(m => !log.marked.includes(m.id)), markOutboxPublished: async id => { log.marked.push(id); } };
  const broker = { publishTaskQueued: async taskId => { await publish(taskId); log.published.push(taskId); } };
  return { relay: new OutboxRelay({ store, broker, intervalMs: 10_000, onError }), log };
}
const queued = (id, taskId, topic = 'task.queued') => ({ id, topic, payload: { taskId } });

test('the relay publishes each queued task in order and marks it published only after the broker took it', async () => {
  const order = [];
  const { relay, log } = relayWith({ pending: [queued('m1', 't1'), queued('m2', 't2')], publish: async taskId => { order.push(`publish:${taskId}`); } });
  const store = relay.store, mark = store.markOutboxPublished;
  store.markOutboxPublished = async id => { order.push(`mark:${id}`); return mark(id); };
  await relay.tick();
  assert.deepEqual(order, ['publish:t1', 'mark:m1', 'publish:t2', 'mark:m2']);
  assert.deepEqual(log.published, ['t1', 't2']);
});

test('a message of another topic is left alone, and a message is never published twice', async () => {
  const { relay, log } = relayWith({ pending: [queued('m1', 't1'), queued('m2', 'other', 'audit.exported')] });
  await relay.tick(); await relay.tick();
  assert.deepEqual(log.published, ['t1']);
  assert.deepEqual(log.marked, ['m1']);
});

test('if the broker refuses, nothing is marked published and the next tick tries again', async () => {
  let failing = true;
  const { relay, log } = relayWith({ pending: [queued('m1', 't1'), queued('m2', 't2')], publish: async () => { if (failing) throw new Error('Task broker is unavailable.'); } });
  await assert.rejects(() => relay.tick(), /Task broker is unavailable/);
  assert.deepEqual(log.marked, [], 'an unpublished message stays pending');
  failing = false;
  await relay.tick();
  assert.deepEqual(log.published, ['t1', 't2']);
  assert.deepEqual(log.marked, ['m1', 'm2']);
});

test('overlapping ticks do not publish the same message twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { relay, log } = relayWith({ pending: [queued('m1', 't1')], publish: () => gate });
  const first = relay.tick(), second = relay.tick();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log.published, ['t1']);
});

test('kick() after a failed publish reports the error and does not crash the process', async () => {
  const errors = [], unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const { relay, log } = relayWith({ pending: [queued('m1', 't1')], publish: async () => { throw new Error('Task broker is unavailable.'); }, onError: error => errors.push(error.message) });
    relay.kick();
    assert.ok(await until(() => errors.length === 1), 'the failure was reported through onError');
    await wait(20);
    assert.deepEqual(errors, ['Task broker is unavailable.']);
    assert.deepEqual(unhandled, [], 'no unhandled rejection (in a real process that would end the API)');
    assert.deepEqual(log.marked, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('the timer keeps retrying after a failure, and close() stops it', async () => {
  let attempts = 0, failing = true;
  const { relay, log } = relayWith({ pending: [queued('m1', 't1')], publish: async () => { attempts++; if (failing) throw new Error('down'); } });
  relay.intervalMs = 10;
  relay.onError = () => {};
  relay.start();
  assert.ok(await until(() => attempts >= 3), 'it keeps trying while the broker is down');
  failing = false;
  assert.ok(await until(() => log.published.length === 1), 'and delivers once the broker is back');
  relay.close();
  assert.equal(relay.status, 'stopped');
  const after = attempts;
  await wait(40);
  assert.equal(attempts, after, 'no more attempts after close');
});

// A message that is not valid JSON (or carries no task id) can never be processed. Putting it back on the queue would redeliver it for ever, so it is rejected
// and reported; only a handler failure, which may be temporary, is retried.
test('a message that is not JSON is rejected and reported, never requeued, and the next message is still processed', async () => {
  const { state, connectImpl } = fakeRabbit();
  const rejected = [], received = [];
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, onRejected: detail => rejected.push(detail) });
  await broker.subscribe(async message => { received.push(message); });
  const garbage = { content: Buffer.from('this is not json {'), properties: { messageId: 'm-1' } };
  await state.consumers[0].handler(garbage);
  assert.deepEqual(state.nacked, [{ message: garbage, all: false, requeue: false }]);
  assert.deepEqual(rejected, [{ reason: 'not_json', messageId: 'm-1', bytes: 18 }]);
  assert.deepEqual(received, [], 'the handler was never asked to process it');
  await state.consumers[0].handler(delivery({ taskId: 'task-2' }));
  assert.deepEqual(received, [{ taskId: 'task-2' }]);
  assert.equal(state.acked.length, 1);
  await broker.close();
});

test('JSON without a usable task id is rejected too: an empty body, null, a list, a number, a missing or non-text id', async () => {
  const { state, connectImpl } = fakeRabbit();
  const reasons = [];
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, onRejected: detail => reasons.push(detail.reason) });
  await broker.subscribe(async () => { throw new Error('must not be called'); });
  for (const body of ['', 'null', '[]', '42', '{}', '{"taskId":7}', '{"taskId":""}', '{"task":"x"}']) await state.consumers[0].handler({ content: Buffer.from(body), properties: {} });
  assert.equal(state.nacked.length, 8);
  assert.ok(state.nacked.every(n => n.requeue === false && n.all === false));
  assert.deepEqual(reasons, ['not_json', 'no_task_id', 'no_task_id', 'no_task_id', 'no_task_id', 'no_task_id', 'no_task_id', 'no_task_id']);
  assert.equal(state.acked.length, 0);
  await broker.close();
});

test('a failing report of a rejected message does not stop the consumer, and a handler failure is still requeued', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, onRejected: () => { throw new Error('the log is full'); } });
  let fail = true;
  await broker.subscribe(async () => { if (fail) throw new Error('database unavailable'); });
  await state.consumers[0].handler({ content: Buffer.from('nope'), properties: {} });
  assert.deepEqual(state.nacked.map(n => n.requeue), [false]);
  const transient = delivery({ taskId: 'task-3' });
  await state.consumers[0].handler(transient);
  assert.deepEqual(state.nacked.at(-1), { message: transient, all: false, requeue: true }, 'a temporary failure is retried');
  fail = false;
  await state.consumers[0].handler(delivery({ taskId: 'task-3' }));
  assert.equal(state.acked.length, 1);
  await broker.close();
});

test('the broker goes away while a message is being handled: settling it fails quietly and the message is left for the broker to redeliver', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  await broker.subscribe(async task => { await wait(1); if (task.taskId === 'fails') throw new Error('database unavailable'); });
  // found by a live RabbitMQ restart: ack/nack threw IllegalOperationError out of the consumer callback, an unhandled rejection that ends the process
  for (const taskId of ['succeeds', 'fails']) {
    state.channelOpen = true;
    const pending = state.consumers[0].handler(delivery({ taskId }));
    state.channelOpen = false;                     // the broker went away during the work
    await assert.doesNotReject(pending, `${taskId}: the consumer callback must not reject`);
    assert.equal(state.acked.length + state.nacked.length, 0, `${taskId}: nothing was settled on a closed channel`);
  }
  await assert.doesNotReject(state.consumers[0].handler(delivery('not json')), 'a rejected message on a closed channel does not throw either');
  state.channelOpen = true;
  await broker.close();
});

test('a channel that closes while the connection stays open is replaced: the broker reconnects and consumes again', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl, reconnectMs: 5 });
  await broker.subscribe(async () => {});
  assert.equal(state.consumers.length, 1);
  state.channels[0].handlers.error?.(new Error('PRECONDITION_FAILED - delivery acknowledgement timed out'));   // an unhandled channel error would throw
  state.channels[0].handlers.close();
  assert.equal(broker.status, 'unhealthy');
  assert.ok(await until(() => broker.status === 'healthy'), 'healthy again');
  assert.equal(state.connects, 2);
  assert.ok(await until(() => state.consumers.length === 2), 'the consumer was attached again');
  assert.ok(state.closed >= 1, 'the old connection was closed');
  await broker.publishTaskQueued(randomUUID());
  assert.equal(state.sent.length, 1);
  await broker.close();
});

test('a connection attempt that never answers is given up and tried again, and a late answer is closed', async () => {
  const { state, connectImpl: working } = fakeRabbit();
  let late;
  const hangs = new Promise(resolve => { late = resolve; });
  let attempts = 0;
  const connectImpl = async url => { attempts++; if (attempts === 1) return hangs; return working(url); };
  const broker = new RabbitTaskBroker('amqp://broker.invalid', { connectImpl, reconnectMs: 5, connectTimeoutMs: 30 });
  await assert.rejects(() => broker.open(), /timed out/);
  assert.equal(broker.status, 'unhealthy');
  assert.ok(await until(() => broker.status === 'healthy'), 'the next attempt was made and succeeded');
  const closedBefore = state.closed;
  let lateClosed = 0;
  late({ createConfirmChannel: async () => ({ assertQueue: async () => {}, close: async () => {} }), on() {}, close: async () => { lateClosed++; } });
  assert.ok(await until(() => lateClosed === 1), 'the connection that answered too late was closed, not leaked');
  assert.equal(state.closed, closedBefore);
  await broker.close();
});

test('closing never throws because the broker is already gone', async () => {
  const { state, connectImpl } = fakeRabbit();
  const broker = await RabbitTaskBroker.connect('amqp://broker.invalid', { connectImpl });
  state.closeFails = true;
  await assert.doesNotReject(() => broker.close());
  assert.equal(broker.status, 'stopped');
});

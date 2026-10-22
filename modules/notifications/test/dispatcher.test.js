import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DestinationService } from '../src/destination-service.js';
import { createDispatcher } from '../src/dispatcher.js';
import { BACKOFF_MS, LIMITS } from '../src/webhook-rules.js';

// The sender end to end with a fake receiver: events become deliveries once each, the right ones go to the right webhook, a failure is tried again later and then given up, a
// signature is added when there is a secret, and nothing from before a webhook began to listen is sent.
const T0 = Date.parse('2026-10-22T10:00:00Z');
const ev = (id, over = {}) => ({ id, type: 'alert.fired', at: new Date(T0 + 1000).toISOString(), severity: 'critical', title: `ds ${id}`, detail: 'Full: 90%', ...over });

function lab({ events = [], answer = () => ({ ok: true, status: 200, durationMs: 1 }) } = {}) {
  const time = { now: T0 }, sent = [], current = { events };
  const service = new DestinationService({ clock: () => time.now });
  const dispatcher = createDispatcher({ destinations: service, collectEvents: async since => current.events.filter(event => Date.parse(event.at) >= since), send: async request => { sent.push(request); return answer(request, sent.length); }, clock: () => time.now, version: '0.1.198' });
  return { time, sent, service, dispatcher, current };
}

test('an event is queued once and sent once, however many rounds follow', async () => {
  const { service, dispatcher, sent, time } = lab({ events: [ev('a1:fired')] });
  const hook = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/x', format: 'text' }, null, T0 - 1000);
  assert.deepEqual(await dispatcher.tick(), { queued: 1, attempted: 1, sent: 1 });
  assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://hooks.example.com/x'); assert.deepEqual(JSON.parse(sent[0].body), { text: '[CRITICAL] ds a1:fired — Full: 90% (alert raised)' });
  time.now += 60_000;
  assert.deepEqual(await dispatcher.tick(), { queued: 0, attempted: 0, sent: 0 });
  assert.equal(sent.length, 1);
  const [delivery] = await service.listDeliveries({ destinationId: hook.id });
  assert.deepEqual([delivery.status, delivery.attempts, delivery.responseStatus], ['sent', 1, 200]);
});

test('each webhook gets the events it asked for: its kinds, from its lowest severity, and only what happened after it began to listen', async () => {
  const events = [ev('old:fired', { at: new Date(T0 - 5000).toISOString() }), ev('a1:fired'), ev('a1:resolved', { type: 'alert.resolved' }), ev('w1:fired', { severity: 'warning' }), ev('c1', { type: 'connection.down', severity: 'warning' }), ev('s1', { type: 'schedule.problem' })];
  const { service, dispatcher, sent } = lab({ events });
  await service.createDestination({ name: 'Everything', url: 'https://all.example.com/x' }, null, T0 - 1000);
  await service.createDestination({ name: 'Pager', url: 'https://pager.example.com/x', events: ['alert.fired', 'schedule.problem'], minSeverity: 'critical' }, null, T0 - 1000);
  const off = await service.createDestination({ name: 'Off', url: 'https://off.example.com/x', enabled: false }, null, T0 - 1000);
  const result = await dispatcher.tick();
  assert.equal(result.queued, 5 + 2);
  const to = host => sent.filter(request => request.url.includes(host)).map(request => JSON.parse(request.body).id).sort();
  assert.deepEqual(to('all.example.com'), ['a1:fired', 'a1:resolved', 'c1', 's1', 'w1:fired']);
  assert.deepEqual(to('pager.example.com'), ['a1:fired', 's1']);
  assert.deepEqual(to('off.example.com'), []);
  assert.equal((await service.getDestination(off.id)).pendingCount, 0);
});

test('a failure is tried again after a wait that grows, and given up on after the last attempt; later events are not held up', async () => {
  let answers = 0;
  const { service, dispatcher, time, sent, current } = lab({ events: [ev('e1')], answer: () => { answers++; return { ok: false, status: 503, error: 'HTTP 503', durationMs: 1 }; } });
  const hook = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/x' }, null, T0 - 1000);
  assert.deepEqual(await dispatcher.tick(), { queued: 1, attempted: 1, sent: 0 });
  assert.equal((await dispatcher.tick()).attempted, 0, 'not again at once');
  time.now += BACKOFF_MS[0] - 1; assert.equal((await dispatcher.tick()).attempted, 0);
  time.now += 1; assert.equal((await dispatcher.tick()).attempted, 1);
  current.events = [ev('e1'), ev('e2', { at: new Date(time.now).toISOString() })];
  assert.equal((await dispatcher.tick()).queued, 1, 'a newer event is queued while the first is waiting');
  for (let attempt = 3; attempt <= LIMITS.maxAttempts; attempt++) { time.now += BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]; await dispatcher.tick(); }
  for (let i = 0; i < 3; i++) { time.now += BACKOFF_MS[4]; await dispatcher.tick(); }
  const deliveries = await service.listDeliveries({ destinationId: hook.id });
  assert.deepEqual(deliveries.map(delivery => [delivery.eventId, delivery.status, delivery.attempts]), [['e2', 'failed', 6], ['e1', 'failed', 6]]);
  const before = answers; time.now += 10 * 3_600_000; await dispatcher.tick(); assert.equal(answers, before, 'a failed delivery is not sent again');
  const destination = await service.getDestination(hook.id);
  assert.equal(destination.consecutiveFailures >= 6, true); assert.equal(destination.lastError, 'HTTP 503');
  assert.ok(sent.length >= 6);
});

test('a webhook with a signing secret signs what it sends so that the receiver can check it; one without sends no signature', async () => {
  const { service, dispatcher, sent, time } = lab({ events: [ev('e1')] });
  await service.createDestination({ name: 'Signed', url: 'https://signed.example.com/x', signingSecret: 'a-long-signing-secret', format: 'json' }, null, T0 - 1000);   // secret-scan:allow (fake test credential)
  await service.createDestination({ name: 'Plain', url: 'https://plain.example.com/x', format: 'json' }, null, T0 - 1000);
  await dispatcher.tick();
  const signed = sent.find(request => request.url.includes('signed.')), plain = sent.find(request => request.url.includes('plain.'));
  const timestamp = signed.headers['x-nuvrion-timestamp'];
  assert.equal(signed.headers['x-nuvrion-signature'], `sha256=${createHmac('sha256', 'a-long-signing-secret').update(`${timestamp}.${signed.body}`).digest('hex')}`);
  assert.equal(plain.headers['x-nuvrion-signature'], undefined);
  assert.equal(signed.headers['x-nuvrion-event'], 'alert.fired'); assert.equal(JSON.parse(signed.body).deliveryId, signed.headers['x-nuvrion-delivery']); assert.equal(JSON.parse(signed.body).version, '0.1.198');
  assert.equal(Math.abs(Number(timestamp) * 1000 - time.now) < 1000, true);
});

test('one slow or broken receiver does not stop the others, and a send that throws is recorded as a failure', async () => {
  const { service, dispatcher } = lab({ events: [ev('e1')], answer: request => { if (request.url.includes('broken')) throw new Error('socket exploded'); return { ok: true, status: 200 }; } });
  const broken = await service.createDestination({ name: 'Broken', url: 'https://broken.example.com/x' }, null, T0 - 1000);
  await service.createDestination({ name: 'Fine', url: 'https://fine.example.com/x' }, null, T0 - 1000);
  const result = await dispatcher.tick();
  assert.deepEqual([result.attempted, result.sent], [2, 1]);
  const [delivery] = await service.listDeliveries({ destinationId: broken.id });
  assert.deepEqual([delivery.status, delivery.attempts], ['pending', 1]); assert.match(delivery.error, /could not be sent: socket exploded/);
});

test('a round at a time: a second round while one is running does nothing', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, dispatcher } = lab({ events: [ev('e1')], answer: () => gate.then(() => ({ ok: true, status: 200 })) });
  await service.createDestination({ name: 'Slow', url: 'https://slow.example.com/x' }, null, T0 - 1000);
  const first = dispatcher.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await dispatcher.tick(), { queued: 0, attempted: 0, sent: 0, skipped: true });
  release(); assert.equal((await first).sent, 1);
});

test('no more than the limit is sent in a round, and the rest follow in the next', async () => {
  const events = Array.from({ length: LIMITS.perTick + 5 }, (_, i) => ev(`e${i}`, { at: new Date(T0 + 1000 + i).toISOString() }));
  const { service, dispatcher, sent } = lab({ events });
  await service.createDestination({ name: 'Busy', url: 'https://busy.example.com/x' }, null, T0 - 1000);
  assert.deepEqual(await dispatcher.tick(), { queued: LIMITS.perTick + 5, attempted: LIMITS.perTick, sent: LIMITS.perTick });
  assert.deepEqual(await dispatcher.tick(), { queued: 0, attempted: 5, sent: 5 });
  assert.equal(sent.length, LIMITS.perTick + 5);
});

test('a test post goes out at once as a test event, is recorded, and is not queued; a webhook that is gone gives nothing', async () => {
  const { service, dispatcher, sent } = lab({ answer: () => ({ ok: true, status: 202, durationMs: 7 }) });
  const hook = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/x', format: 'json', signingSecret: 'a-long-signing-secret' }, null);   // secret-scan:allow (fake test credential)
  const delivery = await dispatcher.test(hook.id);
  assert.deepEqual([delivery.eventType, delivery.status, delivery.responseStatus, delivery.title], ['test', 'sent', 202, 'Test message from Nuvrion']);
  assert.equal(sent[0].headers['x-nuvrion-event'], 'test'); assert.ok(sent[0].headers['x-nuvrion-signature']); assert.equal(JSON.parse(sent[0].body).type, 'test');
  assert.deepEqual(await service.claimDue(10, Date.now() + 1e9), []);
  assert.equal(await dispatcher.test('00000000-0000-4000-8000-000000000001'), null);
});

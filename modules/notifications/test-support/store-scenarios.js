// The behaviour both destination stores (the local file and PostgreSQL) must have, written once: the tests of each store run these against their own service. Not a test file itself.
import assert from 'node:assert/strict';
import { BACKOFF_MS, EVENT_KEYS, LIMITS } from '../src/webhook-rules.js';

export const T0 = Date.parse('2026-10-22T10:00:00Z');
export const event = (id, over = {}) => ({ id, type: 'alert.fired', at: new Date(T0).toISOString(), severity: 'critical', title: `Title ${id}`, detail: `Detail ${id}`, ...over });
const good = { name: 'Ops chat', url: 'https://hooks.example.com/services/T0/B0/very-secret-token', format: 'text' };
const refused = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code, code);

// make() -> { service, time: { now }, reset() }
export function scenarios(make) {
  return {
    async 'a webhook is created with its address sealed: the API shape has only a hint, never the address or the secret'(ctx) {
      const { service } = ctx;
      const created = await service.createDestination({ ...good, signingSecret: 'a-long-signing-secret' }, null);   // secret-scan:allow (fake test credential)
      assert.deepEqual([created.name, created.format, created.events, created.minSeverity, created.enabled, created.urlHint, created.hasSigningSecret, created.rowVersion, created.consecutiveFailures, created.pendingCount],
        ['Ops chat', 'text', EVENT_KEYS, 'warning', true, 'https://hooks.example.com/…', true, 1, 0, 0]);
      assert.equal(created.activeSince, new Date(ctx.time.now).toISOString());
      const text = JSON.stringify(created);
      assert.equal(text.includes('very-secret-token') || text.includes('a-long-signing-secret') || text.includes('secret_') || /"secret"/.test(text), false, 'nothing secret in what the API would show');
      assert.deepEqual(await service.secretsOf(created.id), { url: good.url, signingSecret: 'a-long-signing-secret' });   // secret-scan:allow (fake test credential)
      assert.equal((await service.secretsOf('00000000-0000-4000-8000-000000000001')), null);
      assert.equal(await service.getDestination('not-an-id'), null);
      assert.deepEqual((await service.listDestinations()).map(item => item.name), ['Ops chat']);
    },
    async 'names are unique whatever the case, a limit applies, and what is invalid is refused'(ctx) {
      const { service } = ctx;
      await service.createDestination(good, null);
      await refused(service.createDestination({ ...good, name: 'ops CHAT' }), 'NUV_WEBHOOK_EXISTS');
      await refused(service.createDestination({ ...good, url: 'http://insecure.example.com/x', name: 'Other' }), 'NUV_WEBHOOK_INVALID');
      await refused(service.createDestination({ ...good, name: 'Loopback', url: 'https://127.0.0.1/x' }), 'NUV_WEBHOOK_INVALID');
      for (let i = 1; i < LIMITS.destinations; i++) await service.createDestination({ ...good, name: `Hook ${i}` }, null);
      await refused(service.createDestination({ ...good, name: 'One too many' }), 'NUV_WEBHOOK_LIMIT');
      assert.equal((await service.listDestinations()).length, LIMITS.destinations);
    },
    async 'a change needs the current version, keeps the address and secret unless given, replaces or removes them, and a webhook turned on again does not send what happened while it was off'(ctx) {
      const { service, time } = ctx;
      const created = await service.createDestination({ ...good, signingSecret: 'a-long-signing-secret' }, null);   // secret-scan:allow (fake test credential)
      const renamed = await service.updateDestination(created.id, { name: 'Renamed', events: ['alert.fired'], minSeverity: 'critical' }, 1);
      assert.deepEqual([renamed.name, renamed.events, renamed.minSeverity, renamed.rowVersion, renamed.hasSigningSecret], ['Renamed', ['alert.fired'], 'critical', 2, true]);
      assert.deepEqual(await service.secretsOf(created.id), { url: good.url, signingSecret: 'a-long-signing-secret' }, 'kept');   // secret-scan:allow (fake test credential)
      const moved = await service.updateDestination(created.id, { url: 'https://other.example.org:8443/new/secret-2' }, 2);
      assert.equal(moved.urlHint, 'https://other.example.org:8443/…');
      assert.deepEqual(await service.secretsOf(created.id), { url: 'https://other.example.org:8443/new/secret-2', signingSecret: 'a-long-signing-secret' });   // secret-scan:allow (fake test credential)
      const unsigned = await service.updateDestination(created.id, { signingSecret: null }, 3);
      assert.deepEqual([unsigned.hasSigningSecret, (await service.secretsOf(created.id)).signingSecret], [false, null]);
      assert.equal((await service.updateDestination(created.id, { signingSecret: 'brand-new-secret' }, 4)).hasSigningSecret, true);   // secret-scan:allow (fake test credential)
      await assert.rejects(service.updateDestination(created.id, { name: 'Stale' }, 1), /VERSION_CONFLICT/);
      assert.equal(await service.updateDestination('00000000-0000-4000-8000-000000000001', { name: 'x' }, 1), null);
      await service.createDestination({ ...good, name: 'Second' }, null);
      await refused(service.updateDestination(created.id, { name: 'SECOND' }, 5), 'NUV_WEBHOOK_EXISTS');
      await refused(service.updateDestination(created.id, { url: 'ftp://x.example.com' }, 5), 'NUV_WEBHOOK_INVALID');
      const off = await service.updateDestination(created.id, { enabled: false }, 5), offAt = off.activeSince;
      time.now += 3_600_000;
      const on = await service.updateDestination(created.id, { enabled: true }, 6);
      assert.ok(Date.parse(on.activeSince) > Date.parse(offAt), 'it listens again from now');
    },
    async 'an event is queued once however often it is offered; the queue shows pending work'(ctx) {
      const { service, time } = ctx;
      const created = await service.createDestination(good, null);
      assert.equal(await service.enqueue(created.id, [event('e1'), event('e2')], time.now), 2);
      assert.equal(await service.enqueue(created.id, [event('e1'), event('e3')], time.now), 1);
      assert.equal(await service.enqueue('00000000-0000-4000-8000-000000000001', [event('e9')], time.now), 0);
      assert.equal((await service.getDestination(created.id)).pendingCount, 3);
      const deliveries = await service.listDeliveries({ destinationId: created.id });
      assert.deepEqual(deliveries.map(delivery => delivery.eventId).sort(), ['e1', 'e2', 'e3']);
      assert.deepEqual([deliveries[0].status, deliveries[0].attempts, deliveries[0].eventType, deliveries[0].destinationName], ['pending', 0, 'alert.fired', 'Ops chat']);
    },
    async 'what is due is claimed once: not again while claimed, not before its time, not for a webhook that is off, oldest first, up to a limit'(ctx) {
      const { service, time } = ctx;
      const a = await service.createDestination(good, null), b = await service.createDestination({ ...good, name: 'Off one' }, null);
      await service.enqueue(a.id, [event('e1'), event('e2'), event('e3')], time.now); await service.enqueue(b.id, [event('b1')], time.now);
      const version = (await service.getDestination(b.id)).rowVersion;
      await service.updateDestination(b.id, { enabled: false }, version);
      const first = await service.claimDue(2, time.now);
      assert.equal(first.length, 2); assert.ok(first.every(delivery => delivery.destinationId === a.id));
      const second = await service.claimDue(10, time.now);
      assert.equal(second.length, 1, 'the two claimed are not offered again; the webhook that is off has nothing due');
      assert.deepEqual(await service.claimDue(10, time.now), []);
      assert.equal((await service.claimDue(10, time.now + 3 * 60_000)).length, 3, 'a claim lapses after two minutes (a sender that died)');
    },
    async 'a result is recorded: sent, tried again later with a longer wait each time, or failed for good; the webhook keeps count of consecutive failures and the last error'(ctx) {
      const { service, time } = ctx;
      const created = await service.createDestination(good, null);
      await service.enqueue(created.id, [event('e1')], time.now);
      let [delivery] = await service.claimDue(10, time.now);
      let recorded = await service.recordResult(delivery.id, { ok: false, status: 503, error: 'HTTP 503', durationMs: 30 }, time.now);
      assert.deepEqual([recorded.status, recorded.attempts, recorded.responseStatus, recorded.error, recorded.claimedUntil, Date.parse(recorded.nextAttemptAt) - time.now], ['pending', 1, 503, 'HTTP 503', null, BACKOFF_MS[0]]);
      let destination = await service.getDestination(created.id);
      assert.deepEqual([destination.consecutiveFailures, destination.lastError, destination.lastSuccessAt, destination.lastAttemptAt], [1, 'HTTP 503', null, new Date(time.now).toISOString()]);
      assert.deepEqual(await service.claimDue(10, time.now + BACKOFF_MS[0] - 1), [], 'not before its time');
      for (let attempt = 2; attempt <= 5; attempt++) {
        time.now += BACKOFF_MS[attempt - 2];
        [delivery] = await service.claimDue(10, time.now);
        recorded = await service.recordResult(delivery.id, { ok: false, error: 'No answer' }, time.now);
        assert.deepEqual([recorded.status, recorded.attempts, Date.parse(recorded.nextAttemptAt) - time.now], ['pending', attempt, BACKOFF_MS[attempt - 1]]);
      }
      time.now += BACKOFF_MS[4];
      [delivery] = await service.claimDue(10, time.now);
      recorded = await service.recordResult(delivery.id, { ok: false, status: 502, error: 'HTTP 502' }, time.now);
      assert.deepEqual([recorded.status, recorded.attempts], ['failed', LIMITS.maxAttempts]);
      assert.deepEqual(await service.claimDue(10, time.now + 10 * BACKOFF_MS[4]), [], 'a failed delivery is never sent again');
      await service.enqueue(created.id, [event('e2')], time.now);
      [delivery] = await service.claimDue(10, time.now);
      recorded = await service.recordResult(delivery.id, { ok: true, status: 204, durationMs: 12 }, time.now);
      assert.deepEqual([recorded.status, recorded.attempts, recorded.error, recorded.sentAt, recorded.durationMs], ['sent', 1, null, new Date(time.now).toISOString(), 12]);
      destination = await service.getDestination(created.id);
      assert.deepEqual([destination.consecutiveFailures, destination.lastError, destination.lastSuccessAt, destination.pendingCount], [0, null, new Date(time.now).toISOString(), 0]);
      assert.equal(await service.recordResult('00000000-0000-4000-8000-000000000001', { ok: true }, time.now), null);
      await service.enqueue(created.id, [event('e3')], time.now);
      [delivery] = await service.claimDue(10, time.now);
      assert.equal((await service.recordResult(delivery.id, { ok: false, status: 404, error: 'HTTP 404' }, time.now)).status, 'failed', 'an answer that waiting cannot change is final at once');
    },
    async 'a test post is recorded as it happened, with no retry, and counts toward the webhook’s record'(ctx) {
      const { service, time } = ctx;
      const created = await service.createDestination(good, null);
      const ok = await service.recordTest(created.id, event('test:1', { type: 'test', severity: 'warning', title: 'Test', detail: 'Hi' }), { ok: true, status: 200, durationMs: 5 }, time.now);
      assert.deepEqual([ok.eventType, ok.status, ok.attempts, ok.responseStatus, ok.sentAt !== null], ['test', 'sent', 1, 200, true]);
      const bad = await service.recordTest(created.id, event('test:2', { type: 'test' }), { ok: false, status: 401, error: 'HTTP 401: nope' }, time.now + 1000);
      assert.deepEqual([bad.status, bad.error, bad.sentAt], ['failed', 'HTTP 401: nope', null]);
      const destination = await service.getDestination(created.id);
      assert.deepEqual([destination.consecutiveFailures, destination.lastError], [1, 'HTTP 401: nope']);
      assert.deepEqual(await service.claimDue(10, time.now + 10_000_000), [], 'a test is never queued');
      assert.equal(await service.recordTest('00000000-0000-4000-8000-000000000001', event('t'), { ok: true }, time.now), null);
    },
    async 'history is newest first, per webhook, limited, and goes with the webhook when it is deleted; old history is pruned but pending work is kept'(ctx) {
      const { service, time } = ctx;
      const a = await service.createDestination(good, null), b = await service.createDestination({ ...good, name: 'Other' }, null);
      for (let i = 0; i < 3; i++) { await service.enqueue(a.id, [event(`a${i}`)], time.now + i * 1000); }
      await service.enqueue(b.id, [event('b0')], time.now + 10_000);
      assert.deepEqual((await service.listDeliveries({ destinationId: a.id, limit: 2 })).map(delivery => delivery.eventId), ['a2', 'a1']);
      assert.equal((await service.listDeliveries({})).length, 4);
      assert.deepEqual(await service.listDeliveries({ destinationId: 'not-an-id' }), []);
      const [delivery] = await service.claimDue(1, time.now);
      await service.recordResult(delivery.id, { ok: true, status: 200 }, time.now);
      time.now += (LIMITS.retentionDays + 1) * 86_400_000;
      assert.equal(await service.prune(time.now), 1, 'the one finished delivery is old; the three still pending stay');
      assert.equal((await service.listDeliveries({})).length, 3);
      assert.deepEqual(await service.deleteDestination(a.id), { deleted: 1 });
      assert.equal((await service.listDeliveries({})).length, 1, 'only the other webhook’s remain');
      assert.equal(await service.deleteDestination(a.id), null); assert.equal(await service.deleteDestination('not-an-id'), null);
    }
  };
}

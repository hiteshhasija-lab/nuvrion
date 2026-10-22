// The part that sends (docs/webhooks.md): every few seconds it looks at the events of the last day, queues for each webhook the ones it wants (once each: a queued or sent event is never
// queued again, so a restart or a second Nuvrion process cannot send it twice), and posts what is due. A failed post is tried again later by webhook-rules.js's schedule.
import { randomUUID } from 'node:crypto';
import { LIMITS, buildHeaders, buildPayload, wants } from './webhook-rules.js';

const WINDOW_MS = 24 * 3_600_000, PARALLEL = 5;

// destinations: a DestinationService or PostgresDestinationService; collectEvents(sinceMs) -> events; send({ url, body, headers }) -> { ok, status?, error?, durationMs }.
export function createDispatcher({ destinations, collectEvents, send, clock = Date.now, version = '', log = () => {} }) {
  let running = false;

  async function deliver(delivery) {
    let result;
    try {
      const destination = await destinations.getDestination(delivery.destinationId), secrets = await destinations.secretsOf(delivery.destinationId);
      if (!destination || !secrets) return null;
      const event = { id: delivery.eventId, type: delivery.eventType, at: delivery.occurredAt, severity: delivery.severity, title: delivery.title, detail: delivery.detail };
      const body = buildPayload(destination, event, { version, deliveryId: delivery.id });
      result = await send({ url: secrets.url, body, headers: buildHeaders({ body, event, deliveryId: delivery.id, version, signingSecret: secrets.signingSecret, now: clock() }) });
    } catch (error) {
      result = { ok: false, error: `The webhook could not be sent: ${String(error.message).slice(0, 150)}` };
    }
    return destinations.recordResult(delivery.id, result, clock());
  }

  return {
    // One round: queue, then send what is due. Returns { queued, attempted, sent }.
    async tick() {
      if (running) return { queued: 0, attempted: 0, sent: 0, skipped: true };
      running = true;
      try {
        const now = clock(), summary = { queued: 0, attempted: 0, sent: 0 };
        const active = (await destinations.listDestinations()).filter(destination => destination.enabled);
        if (active.length) {
          const events = await collectEvents(now - WINDOW_MS);
          for (const destination of active) {
            const wanted = events.filter(event => wants(destination, event));
            if (wanted.length) summary.queued += await destinations.enqueue(destination.id, wanted, now);
          }
        }
        const due = await destinations.claimDue(LIMITS.perTick, now);
        for (let i = 0; i < due.length; i += PARALLEL) {
          const done = await Promise.all(due.slice(i, i + PARALLEL).map(delivery => deliver(delivery)));
          for (const delivery of done) if (delivery) { summary.attempted++; if (delivery.status === 'sent') summary.sent++; }
        }
        if (summary.attempted > summary.sent) log(`webhooks: ${summary.attempted - summary.sent} of ${summary.attempted} posts did not succeed (see the webhook's history)`);
        return summary;
      } finally { running = false; }
    },

    // A test post to one webhook, made now: recorded as it happened and not tried again. Returns the delivery, or null if the webhook is gone.
    async test(destinationId) {
      const destination = await destinations.getDestination(destinationId), secrets = destination ? await destinations.secretsOf(destinationId) : null;
      if (!destination || !secrets) return null;
      const event = { id: `test:${randomUUID()}`, type: 'test', at: new Date(clock()).toISOString(), severity: 'warning', title: 'Test message from Nuvrion', detail: 'If you can read this, the webhook works.' };
      const deliveryId = randomUUID(), body = buildPayload(destination, event, { version, deliveryId });
      let result;
      try { result = await send({ url: secrets.url, body, headers: buildHeaders({ body, event, deliveryId, version, signingSecret: secrets.signingSecret, now: clock() }) }); }
      catch (error) { result = { ok: false, error: `The webhook could not be sent: ${String(error.message).slice(0, 150)}` }; }
      return destinations.recordTest(destinationId, event, result, clock());
    }
  };
}

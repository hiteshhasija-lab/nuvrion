// Webhook destinations and their queue of deliveries in a local file (the mode without PostgreSQL): the same interface as PostgresDestinationService. What a destination may be and how a
// result is judged are decided by webhook-rules.js. The address and the signing secret are sealed with the platform's key ring and never leave this class except to the sender.
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { keyringFromEnvironment } from '../../platform/src/keyring-cipher.js';
import { LIMITS, WebhookError, judge, parseChange, parseDestination, urlHint } from './webhook-rules.js';

const clone = value => structuredClone(value);
const iso = ms => new Date(ms).toISOString();
const context = id => `nuvrion:webhook-destination:${id}`;
const sealed = ({ keyId, nonce, ciphertext, tag }) => ({ keyId, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') });
const unsealed = ({ keyId, nonce, ciphertext, tag }) => ({ algorithm: 'aes-256-gcm', keyId, nonce: Buffer.from(nonce, 'base64'), ciphertext: Buffer.from(ciphertext, 'base64'), tag: Buffer.from(tag, 'base64') });

export class DestinationService {
  #destinations = new Map(); #deliveries = []; #file; #clock; #cipher; #policy;
  constructor({ file = null, clock = Date.now, cipher = null, policy = {} } = {}) {
    this.#file = file; this.#clock = clock; this.#policy = policy; this.#cipher = cipher ?? keyringFromEnvironment(process.env);
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        for (const item of saved.destinations ?? []) this.#destinations.set(item.id, item);
        this.#deliveries = saved.deliveries ?? [];
      } catch { /* an unreadable file starts again: the destinations must then be entered again */ }
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ destinations: [...this.#destinations.values()], deliveries: this.#deliveries }), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
  #public(item) {
    const { secret, ...rest } = item;
    return { ...clone(rest), pendingCount: this.#deliveries.filter(delivery => delivery.destinationId === item.id && delivery.status === 'pending').length };
  }
  #checkName(name, exceptId = null) {
    if ([...this.#destinations.values()].some(item => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) throw new WebhookError(`A webhook named "${name}" already exists.`, 'NUV_WEBHOOK_EXISTS');
  }

  async listDestinations() { return [...this.#destinations.values()].sort((a, b) => a.name.localeCompare(b.name)).map(item => this.#public(item)); }
  async getDestination(id) { const item = this.#destinations.get(id); return item ? this.#public(item) : null; }
  // For the sender only: { url, signingSecret }.
  async secretsOf(id) {
    const item = this.#destinations.get(id);
    return item ? this.#cipher.decrypt(unsealed(item.secret), { context: context(id) }) : null;
  }

  async createDestination(input, userId = null, now = this.#clock()) {
    const fields = parseDestination(input, this.#policy);
    if (this.#destinations.size >= LIMITS.destinations) throw new WebhookError(`At most ${LIMITS.destinations} webhooks may exist.`, 'NUV_WEBHOOK_LIMIT');
    this.#checkName(fields.name);
    const id = randomUUID(), at = iso(now);
    const item = { id, name: fields.name, format: fields.format, events: fields.events, minSeverity: fields.minSeverity, enabled: fields.enabled, activeSince: at, urlHint: urlHint(new URL(fields.url)),
      secret: sealed(this.#cipher.encrypt({ url: fields.url, signingSecret: fields.signingSecret }, { context: context(id) })), hasSigningSecret: Boolean(fields.signingSecret),
      consecutiveFailures: 0, lastAttemptAt: null, lastSuccessAt: null, lastError: null, rowVersion: 1, createdBy: userId, createdAt: at, updatedAt: at };
    this.#destinations.set(id, item); this.#persist();
    return this.#public(item);
  }
  async updateDestination(id, patch, expectedVersion, now = this.#clock()) {
    const item = this.#destinations.get(id);
    if (!item) return null;
    if (item.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const change = parseChange(patch, this.#policy);
    if (change.name !== undefined) this.#checkName(change.name, id);
    const secrets = await this.secretsOf(id);
    if (change.url !== undefined) { secrets.url = change.url; item.urlHint = urlHint(new URL(change.url)); }
    if (change.signingSecret !== undefined) { secrets.signingSecret = change.signingSecret; item.hasSigningSecret = Boolean(change.signingSecret); }
    if (change.url !== undefined || change.signingSecret !== undefined) item.secret = sealed(this.#cipher.encrypt(secrets, { context: context(id) }));
    for (const key of ['name', 'format', 'events', 'minSeverity']) if (change[key] !== undefined) item[key] = change[key];
    if (change.enabled !== undefined) { if (change.enabled && !item.enabled) item.activeSince = iso(now); item.enabled = change.enabled; }   // events from the time it was off are not sent afterwards
    item.rowVersion += 1; item.updatedAt = iso(now);
    this.#persist();
    return this.#public(item);
  }
  async deleteDestination(id) {
    if (!this.#destinations.delete(id)) return null;
    this.#deliveries = this.#deliveries.filter(delivery => delivery.destinationId !== id);
    this.#persist();
    return { deleted: 1 };
  }

  // ---- the queue ----
  // events: [{ id, type, at, severity, title, detail }] this destination wants. A delivery already queued or sent for the same event is not queued again. Returns how many were queued.
  async enqueue(destinationId, events, now = this.#clock()) {
    const item = this.#destinations.get(destinationId);
    if (!item) return 0;
    let queued = 0;
    for (const event of events) {
      if (this.#deliveries.some(delivery => delivery.destinationId === destinationId && delivery.eventId === event.id)) continue;
      this.#deliveries.unshift({ id: randomUUID(), destinationId, destinationName: item.name, eventId: event.id, eventType: event.type, severity: event.severity, title: event.title.slice(0, 300), detail: event.detail.slice(0, 1000),
        occurredAt: new Date(event.at).toISOString(), status: 'pending', attempts: 0, nextAttemptAt: iso(now), claimedUntil: null, responseStatus: null, error: null, durationMs: null, createdAt: iso(now), sentAt: null });
      queued++;
    }
    if (queued) this.#persist();
    return queued;
  }
  // The deliveries that are due, oldest first, at most `limit`, each claimed for two minutes so that nobody else sends it meanwhile.
  async claimDue(limit = LIMITS.perTick, now = this.#clock()) {
    const due = this.#deliveries.filter(delivery => delivery.status === 'pending' && Date.parse(delivery.nextAttemptAt) <= now && (!delivery.claimedUntil || Date.parse(delivery.claimedUntil) <= now) && this.#destinations.get(delivery.destinationId)?.enabled)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt)).slice(0, limit);
    for (const delivery of due) delivery.claimedUntil = iso(now + 120_000);
    if (due.length) this.#persist();
    return due.map(clone);
  }
  async recordResult(deliveryId, result, now = this.#clock()) {
    const delivery = this.#deliveries.find(item => item.id === deliveryId);
    if (!delivery) return null;
    const item = this.#destinations.get(delivery.destinationId);
    delivery.attempts += 1;
    const verdict = judge(result, delivery.attempts);
    Object.assign(delivery, { status: verdict.status, claimedUntil: null, responseStatus: result.status ?? null, error: result.ok ? null : (result.error ?? null), durationMs: result.durationMs ?? null });
    if (verdict.status === 'sent') delivery.sentAt = iso(now);
    if (verdict.status === 'pending') delivery.nextAttemptAt = iso(now + verdict.waitMs);
    if (item) {
      item.lastAttemptAt = iso(now);
      if (result.ok) { item.consecutiveFailures = 0; item.lastSuccessAt = iso(now); item.lastError = null; } else { item.consecutiveFailures += 1; item.lastError = result.error ?? null; }
    }
    this.#persist();
    return clone(delivery);
  }
  // A test post is made at once and recorded as it happened, with no retry.
  async recordTest(destinationId, event, result, now = this.#clock()) {
    const item = this.#destinations.get(destinationId);
    if (!item) return null;
    const delivery = { id: randomUUID(), destinationId, destinationName: item.name, eventId: event.id, eventType: 'test', severity: event.severity, title: event.title, detail: event.detail, occurredAt: iso(now), status: result.ok ? 'sent' : 'failed',
      attempts: 1, nextAttemptAt: iso(now), claimedUntil: null, responseStatus: result.status ?? null, error: result.ok ? null : (result.error ?? null), durationMs: result.durationMs ?? null, createdAt: iso(now), sentAt: result.ok ? iso(now) : null };
    this.#deliveries.unshift(delivery);
    item.lastAttemptAt = iso(now);
    if (result.ok) { item.consecutiveFailures = 0; item.lastSuccessAt = iso(now); item.lastError = null; } else { item.consecutiveFailures += 1; item.lastError = result.error ?? null; }
    this.#persist();
    return clone(delivery);
  }
  async listDeliveries({ destinationId = null, limit = 50 } = {}) {
    return this.#deliveries.filter(delivery => !destinationId || delivery.destinationId === destinationId).slice(0, Math.min(LIMITS.deliveriesKept, Math.max(1, limit))).map(clone);
  }
  // Old history goes: sent or failed deliveries older than 30 days, and everything beyond the newest 200 of a destination.
  async prune(now = this.#clock()) {
    const cutoff = now - LIMITS.retentionDays * 86_400_000, counts = new Map();
    const before = this.#deliveries.length;
    this.#deliveries = this.#deliveries.filter(delivery => {
      const count = (counts.get(delivery.destinationId) ?? 0) + 1; counts.set(delivery.destinationId, count);
      return delivery.status === 'pending' || (count <= LIMITS.deliveriesKept && Date.parse(delivery.createdAt) >= cutoff);
    });
    if (this.#deliveries.length !== before) this.#persist();
    return before - this.#deliveries.length;
  }
}

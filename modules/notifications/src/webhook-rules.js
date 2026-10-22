// Webhooks (docs/webhooks.md): where an alert, a connection problem or a failed schedule run is sent, what is sent, and the rules that keep the sending safe. Pure functions, shared by both
// stores and the sender so they cannot disagree.
//
// A webhook is an address Nuvrion posts a small JSON message to. Because Nuvrion makes the request, an address is a way to make the platform talk to something the person chose, so
// the rules are strict: https only, no credentials in the address, and the places the platform itself lives (this machine, link-local addresses such as cloud metadata) are refused,
// both as written and as the name resolves at the moment of sending.

import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const EVENT_TYPES = Object.freeze({
  'alert.fired': 'A threshold alert is raised',
  'alert.resolved': 'A threshold alert is resolved',
  'connection.down': 'A connection has a problem',
  'connection.recovered': 'A connection recovered',
  'schedule.problem': 'A scheduled run failed, partly failed or was missed'
});
export const EVENT_KEYS = Object.freeze(Object.keys(EVENT_TYPES));
export const FORMATS = Object.freeze({ json: 'JSON (every field; for your own receiver)', text: 'Text message (Slack, Mattermost, Teams, Google Chat)', discord: 'Discord' });
export const SEVERITY_RANK = Object.freeze({ warning: 1, critical: 2 });
export const LIMITS = Object.freeze({ destinations: 20, nameMax: 100, urlMax: 2048, secretMax: 200, deliveriesKept: 200, perTick: 20, maxAttempts: 6, retentionDays: 30, timeoutMs: 10_000 });
export const BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000]);   // the wait after the 1st, 2nd ... failed attempt

export class WebhookError extends Error {
  constructor(message, code = 'NUV_WEBHOOK_INVALID') { super(message); this.code = code; }
}

// ---- addresses ------------------------------------------------------------------------------------------------------------------------------------------------------------
const ipv4Parts = address => { const parts = address.split('.').map(Number); return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null; };

// What kind of place an IP address is: loopback, link-local, unspecified, multicast, reserved (never a destination), private (a LAN: allowed unless the installation says otherwise) or public.
export function classifyAddress(address) {
  let text = String(address ?? '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) text = mapped[1];
  const kind = isIP(text);
  if (kind === 4) {
    const [a, b] = ipv4Parts(text) ?? [];
    if (a === undefined) return 'reserved';
    if (a === 127) return 'loopback';
    if (a === 0) return 'unspecified';
    if (a === 169 && b === 254) return 'link-local';
    if (a >= 224 && a <= 239) return 'multicast';
    if (a >= 240) return 'reserved';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  if (kind === 6) {
    if (text === '::1') return 'loopback';
    if (text === '::') return 'unspecified';
    const first = parseInt(text.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return 'link-local';
    if ((first & 0xff00) === 0xff00) return 'multicast';
    if ((first & 0xfe00) === 0xfc00) return 'private';
    return 'public';
  }
  return 'reserved';
}

// policy: { allowHttp, allowLoopback, blockPrivate } (from the installation's environment; the defaults are the safe ones). Throws a WebhookError that says what is wrong.
export function checkAddressAllowed(address, policy = {}) {
  const kind = classifyAddress(address);
  if (kind === 'loopback' && !policy.allowLoopback) throw new WebhookError('That address is this machine itself. A webhook must point at another system.');
  if (['link-local', 'unspecified', 'multicast', 'reserved'].includes(kind)) throw new WebhookError('That address is not one a webhook may use (it is a link-local, unspecified, multicast or reserved address).');
  if (kind === 'private' && policy.blockPrivate) throw new WebhookError('This installation does not allow webhooks to private network addresses.');
  return kind;
}

// The address as written: https (http only when the installation allows it), no user name or password in it, a host that is not a forbidden literal address. Returns the parsed URL.
export function parseWebhookUrl(raw, policy = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new WebhookError('Enter the webhook address.');
  if (text.length > LIMITS.urlMax) throw new WebhookError(`The address may have at most ${LIMITS.urlMax} characters.`);
  if (/[\p{Cc}\p{Cf}\s]/u.test(text)) throw new WebhookError('The address may not contain spaces or control characters.');
  let url;
  try { url = new URL(text); } catch { throw new WebhookError('The address is not a valid web address (it should look like https://hooks.example.com/path).'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) throw new WebhookError('The address must start with https:// (a webhook carries alert details).');
  if (url.username || url.password) throw new WebhookError('The address may not contain a user name or password; put a token in the path or use the signing secret.');
  if (!url.hostname) throw new WebhookError('The address has no host name.');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host)) checkAddressAllowed(host, policy);
  return url;
}

// What may be shown about an address afterwards: where it goes, not the path or query that usually holds the token.
export const urlHint = url => `${url.protocol}//${url.host}/…`;

// ---- a destination ------------------------------------------------------------------------------------------------------------------------------------------------------
const EDITABLE = ['name', 'url', 'format', 'events', 'minSeverity', 'signingSecret', 'enabled'];
const plainName = raw => {
  const text = String(raw ?? '').trim();
  if (!text) throw new WebhookError('A webhook needs a name.');
  if (text.length > LIMITS.nameMax) throw new WebhookError(`The name may have at most ${LIMITS.nameMax} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw new WebhookError('The name may not contain control or invisible formatting characters.');
  return text;
};

// A new destination from a request body. Returns { name, url (the string), format, events, minSeverity, signingSecret (string or null), enabled }.
export function parseDestination(body, policy = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebhookError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !EDITABLE.includes(key));
  if (unknown) throw new WebhookError(`Unknown field: ${unknown.slice(0, 40)}.`);
  const url = parseWebhookUrl(body.url, policy);
  const format = body.format ?? 'json';
  if (!Object.hasOwn(FORMATS, format)) throw new WebhookError(`format must be one of ${Object.keys(FORMATS).join(', ')}.`);
  const events = body.events === undefined ? [...EVENT_KEYS] : body.events;
  if (!Array.isArray(events) || !events.length || events.some(event => !EVENT_KEYS.includes(event))) throw new WebhookError(`Choose at least one event (${EVENT_KEYS.join(', ')}).`);
  const minSeverity = body.minSeverity ?? 'warning';
  if (!Object.hasOwn(SEVERITY_RANK, minSeverity)) throw new WebhookError('minSeverity must be "warning" or "critical".');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new WebhookError('enabled must be true or false.');
  let signingSecret = null;
  if (body.signingSecret !== undefined && body.signingSecret !== null && body.signingSecret !== '') {
    signingSecret = String(body.signingSecret);
    if (signingSecret.length < 8 || signingSecret.length > LIMITS.secretMax) throw new WebhookError(`The signing secret must have 8 to ${LIMITS.secretMax} characters.`);
    if (/[\p{Cc}\p{Cf}]/u.test(signingSecret)) throw new WebhookError('The signing secret may not contain control characters.');
  }
  return { name: plainName(body.name), url: url.href, format, events: [...new Set(events)], minSeverity, signingSecret, enabled: body.enabled ?? true };
}

// A change: only the fields given are replaced. The address and the signing secret are write-only, so a change that leaves them out keeps them. `signingSecret: ''` or null removes it.
// Returns the fields that change: { name?, url?, format?, events?, minSeverity?, enabled?, signingSecret? (string, or null to remove) }.
export function parseChange(patch, policy = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new WebhookError('The request must be a JSON object.');
  const unknown = Object.keys(patch).find(key => !EDITABLE.includes(key));
  if (unknown) throw new WebhookError(`Unknown field: ${unknown.slice(0, 40)}.`);
  if (!Object.keys(patch).length) throw new WebhookError('Nothing to change.');
  const change = {};
  if (patch.name !== undefined) change.name = plainName(patch.name);
  if (patch.url !== undefined) change.url = parseWebhookUrl(patch.url, policy).href;
  if (patch.format !== undefined) { if (!Object.hasOwn(FORMATS, patch.format)) throw new WebhookError(`format must be one of ${Object.keys(FORMATS).join(', ')}.`); change.format = patch.format; }
  if (patch.events !== undefined) {
    if (!Array.isArray(patch.events) || !patch.events.length || patch.events.some(event => !EVENT_KEYS.includes(event))) throw new WebhookError(`Choose at least one event (${EVENT_KEYS.join(', ')}).`);
    change.events = [...new Set(patch.events)];
  }
  if (patch.minSeverity !== undefined) { if (!Object.hasOwn(SEVERITY_RANK, patch.minSeverity)) throw new WebhookError('minSeverity must be "warning" or "critical".'); change.minSeverity = patch.minSeverity; }
  if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw new WebhookError('enabled must be true or false.'); change.enabled = patch.enabled; }
  if (patch.signingSecret !== undefined) change.signingSecret = patch.signingSecret === '' || patch.signingSecret === null ? null : parseDestination({ name: 'x', url: 'https://example.com/', signingSecret: patch.signingSecret }, policy).signingSecret;
  return change;
}

// ---- events and what is sent --------------------------------------------------------------------------------------------------------------------------------------------
// The events Nuvrion can send, built from what it already knows: the threshold alerts and connection events of the notification feed, and the runs of schedules that did not go well.
// feed: events as the notification feed shapes them ({ id, kind: fired|resolved, at, source: threshold|connection, severity, title, detail }); runs: schedule runs.
export function collectEvents({ feed = [], runs = [], since = 0 }) {
  const events = [];
  for (const item of feed) {
    const type = item.source === 'connection' ? (item.kind === 'resolved' ? 'connection.recovered' : 'connection.down') : (item.kind === 'resolved' ? 'alert.resolved' : 'alert.fired');
    events.push({ id: String(item.id), type, at: item.at, severity: item.severity === 'critical' ? 'critical' : 'warning', title: String(item.title ?? ''), detail: String(item.detail ?? '') });
  }
  for (const run of runs) {
    if (!['partial', 'failed', 'error', 'missed'].includes(run.outcome)) continue;
    const label = { partial: 'partly failed', failed: 'failed', error: 'could not run', missed: 'was missed' }[run.outcome];
    events.push({ id: `schedule-run:${run.id}`, type: 'schedule.problem', at: run.startedAt, severity: ['failed', 'error'].includes(run.outcome) ? 'critical' : 'warning', title: String(run.scheduleName ?? 'A schedule'), detail: `The scheduled run ${label}${run.summary ? `: ${run.summary}` : ''}` });
  }
  return events.filter(event => new Date(event.at).getTime() >= since).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Whether a destination wants an event: it is on, listens to that kind of event, the event is severe enough, and it happened after the destination began to listen.
export function wants(destination, event) {
  if (!destination.enabled || !destination.events.includes(event.type)) return false;
  if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[destination.minSeverity]) return false;
  return new Date(event.at).getTime() >= new Date(destination.activeSince).getTime();
}

const VERB = { 'alert.fired': 'alert raised', 'alert.resolved': 'alert resolved', 'connection.down': 'connection problem', 'connection.recovered': 'connection recovered', 'schedule.problem': 'schedule problem', test: 'test' };
export const describeEvent = event => `[${String(event.severity).toUpperCase()}] ${event.title}${event.detail ? ` — ${event.detail}` : ''} (${VERB[event.type] ?? event.type})`;

// The body to post, as a string, in the destination's format.
export function buildPayload(destination, event, { version = '', deliveryId = randomUUID() } = {}) {
  if (destination.format === 'text') return JSON.stringify({ text: describeEvent(event) });
  if (destination.format === 'discord') return JSON.stringify({ content: describeEvent(event).slice(0, 2000) });
  return JSON.stringify({ id: event.id, deliveryId, type: event.type, occurredAt: new Date(event.at).toISOString(), severity: event.severity, title: event.title, detail: event.detail, text: describeEvent(event), source: 'nuvrion', version });
}

// The headers of a post. The signature lets the receiver check the message came from this Nuvrion: HMAC-SHA256 of "<timestamp>.<body>" with the signing secret, hex.
export function buildHeaders({ body, event, deliveryId, version = '', signingSecret = null, now = Date.now() }) {
  const headers = { 'content-type': 'application/json', 'user-agent': `Nuvrion/${version || 'unknown'}`, 'x-nuvrion-event': event.type, 'x-nuvrion-delivery': deliveryId, 'content-length': String(Buffer.byteLength(body)) };
  if (signingSecret) {
    const timestamp = Math.floor(now / 1000);
    headers['x-nuvrion-timestamp'] = String(timestamp);
    headers['x-nuvrion-signature'] = `sha256=${createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex')}`;
  }
  return headers;
}

// How a result of a post is judged: sent, tried again later, or given up on. A success is any 2xx. Rate limits (429), timeouts, server errors and network failures are tried again;
// any other answer (a redirect, 400, 401, 403, 404 ...) will not change by waiting and is final. After the last attempt a retry becomes a failure.
export function judge(result, attempts) {
  if (result.ok) return { status: 'sent' };
  const retryable = result.status === undefined || result.status === 408 || result.status === 425 || result.status === 429 || result.status >= 500;
  if (!retryable || attempts >= LIMITS.maxAttempts) return { status: 'failed' };
  return { status: 'pending', waitMs: BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] };
}

export const describeDestination = destination => `${destination.name}: ${destination.events.length === EVENT_KEYS.length ? 'all events' : destination.events.join(', ')}, ${destination.minSeverity} and above, ${FORMATS[destination.format]?.split(' (')[0] ?? destination.format}`;

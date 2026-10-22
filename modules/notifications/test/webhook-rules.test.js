import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { classifyAddress, checkAddressAllowed, parseWebhookUrl, urlHint, parseDestination, parseChange, collectEvents, wants, describeEvent, buildPayload, buildHeaders, judge, describeDestination, EVENT_KEYS, BACKOFF_MS, LIMITS, WebhookError } from '../src/webhook-rules.js';

// Webhook rules: which addresses are acceptable (the platform itself and metadata addresses never are), what a destination may be, which events exist and who wants them, the messages and
// their signature, and how a failed post is judged.
const refused = (fn, pattern) => assert.throws(fn, error => error instanceof WebhookError && (!pattern || pattern.test(error.message)), String(pattern));

test('addresses are classified: this machine, link-local (cloud metadata), reserved, private networks and public ones', () => {
  const expected = { '127.0.0.1': 'loopback', '127.8.8.8': 'loopback', '::1': 'loopback', '[::1]': 'loopback', '::ffff:127.0.0.1': 'loopback', '169.254.169.254': 'link-local', 'fe80::1': 'link-local', '0.0.0.0': 'unspecified', '::': 'unspecified',
    '224.0.0.1': 'multicast', 'ff02::1': 'multicast', '255.255.255.255': 'reserved', '240.0.0.1': 'reserved', '10.1.2.3': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.1.1': 'private', '100.64.0.1': 'private', 'fd12::1': 'private',
    '172.32.0.1': 'public', '8.8.8.8': 'public', '2606:4700::1111': 'public', 'not an address': 'reserved', '::ffff:10.0.0.1': 'private' };
  for (const [address, kind] of Object.entries(expected)) assert.equal(classifyAddress(address), kind, address);
});

test('the policy refuses this machine, link-local and reserved addresses, and private networks only when the installation says so', () => {
  refused(() => checkAddressAllowed('127.0.0.1'), /this machine/);
  refused(() => checkAddressAllowed('169.254.169.254'), /not one a webhook may use/);
  refused(() => checkAddressAllowed('0.0.0.0'), /not one a webhook may use/);
  assert.equal(checkAddressAllowed('127.0.0.1', { allowLoopback: true }), 'loopback');
  assert.equal(checkAddressAllowed('10.0.0.5'), 'private'); assert.equal(checkAddressAllowed('8.8.8.8'), 'public');
  refused(() => checkAddressAllowed('10.0.0.5', { blockPrivate: true }), /private network/);
  refused(() => checkAddressAllowed('169.254.169.254', { allowLoopback: true, allowHttp: true }), /not one a webhook may use/);
});

test('an address must be https, free of credentials and spaces, and not a forbidden literal address; the hint shows only where it goes', () => {
  assert.equal(parseWebhookUrl('https://hooks.example.com/services/T0/B0/secret?x=1').href, 'https://hooks.example.com/services/T0/B0/secret?x=1');
  assert.equal(urlHint(parseWebhookUrl('https://hooks.example.com:8443/services/T0/B0/secret?x=1')), 'https://hooks.example.com:8443/…');
  for (const [raw, pattern] of [['', /Enter/], ['hooks.example.com/x', /not a valid/], ['http://hooks.example.com/x', /https/], ['ftp://hooks.example.com/x', /https/], ['https://user:pw@hooks.example.com/x', /user name or password/],
    ['https://127.0.0.1/x', /this machine/], ['https://[::1]/x', /this machine/], ['https://169.254.169.254/latest/meta-data', /not one a webhook/], ['https://hooks.example.com/a b', /spaces/], [`https://h.example.com/${'a'.repeat(2100)}`, /at most/], ['https://', /not a valid/], [null, /Enter/]]) {
    refused(() => parseWebhookUrl(raw), pattern);
  }
  assert.equal(parseWebhookUrl('http://hooks.example.com/x', { allowHttp: true }).protocol, 'http:');
  assert.equal(parseWebhookUrl('http://127.0.0.1:9/x', { allowHttp: true, allowLoopback: true }).hostname, '127.0.0.1');
});

test('a destination has a name, an address, a format, events and a lowest severity, and is on unless turned off', () => {
  const made = parseDestination({ name: ' Ops chat ', url: 'https://hooks.example.com/x' });
  assert.deepEqual(made, { name: 'Ops chat', url: 'https://hooks.example.com/x', format: 'json', events: EVENT_KEYS, minSeverity: 'warning', signingSecret: null, enabled: true });
  const custom = parseDestination({ name: 'Pager', url: 'https://hooks.example.com/y', format: 'text', events: ['alert.fired', 'alert.fired', 'schedule.problem'], minSeverity: 'critical', signingSecret: 'a-long-secret', enabled: false });   // secret-scan:allow (fake test credential)
  assert.deepEqual([custom.events, custom.minSeverity, custom.format, custom.signingSecret, custom.enabled], [['alert.fired', 'schedule.problem'], 'critical', 'text', 'a-long-secret', false]);
  const bad = [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'a\u0000b' }, { format: 'xml' }, { events: [] }, { events: ['alert.deleted'] }, { events: 'alert.fired' }, { minSeverity: 'info' }, { enabled: 'yes' }, { signingSecret: 'short' }, { signingSecret: 'x'.repeat(201) }, { signingSecret: 'bad\u0007secret' }, { extra: 1 }, { url: 'http://x.example.com' }];   // secret-scan:allow (fake test credential)
  for (const over of bad) refused(() => parseDestination({ name: 'N', url: 'https://hooks.example.com/x', ...over }));
  for (const body of [null, [], 'x']) refused(() => parseDestination(body), /JSON object/);
});

test('a change replaces only what is given; the address and the signing secret are kept unless given, and an empty secret removes it', () => {
  assert.deepEqual(parseChange({ enabled: false }), { enabled: false });
  assert.deepEqual(parseChange({ name: ' New ', events: ['alert.fired'], minSeverity: 'critical', format: 'discord' }), { name: 'New', events: ['alert.fired'], minSeverity: 'critical', format: 'discord' });
  assert.deepEqual(parseChange({ url: 'https://other.example.com/z' }), { url: 'https://other.example.com/z' });
  assert.deepEqual(parseChange({ signingSecret: '' }), { signingSecret: null }); assert.deepEqual(parseChange({ signingSecret: null }), { signingSecret: null });
  assert.deepEqual(parseChange({ signingSecret: 'a-new-long-secret' }), { signingSecret: 'a-new-long-secret' });   // secret-scan:allow (fake test credential)
  for (const patch of [{}, { url: 'http://x.example.com' }, { events: [] }, { format: 'xml' }, { minSeverity: 'x' }, { enabled: 'no' }, { signingSecret: 'short' }, { nope: 1 }]) refused(() => parseChange(patch));
});

const feed = [
  { id: 'a1:fired', kind: 'fired', at: '2026-10-22T10:00:00Z', source: 'threshold', severity: 'critical', title: 'datastore2', detail: 'Full: 90%' },
  { id: 'a1:resolved', kind: 'resolved', at: '2026-10-22T11:00:00Z', source: 'threshold', severity: 'critical', title: 'datastore2', detail: 'back to normal' },
  { id: 'connection:c1:fired', kind: 'fired', at: '2026-10-22T09:00:00Z', source: 'connection', severity: 'warning', title: 'ESXi 7', detail: 'Connection is having problems' },
  { id: 'connection:c1:resolved', kind: 'resolved', at: '2026-10-22T09:30:00Z', source: 'connection', severity: 'warning', title: 'ESXi 7', detail: 'Connection recovered' }
];
const runs = [
  { id: 'r1', outcome: 'completed', startedAt: '2026-10-22T08:00:00Z', scheduleName: 'Nightly', summary: '2 requested' }, { id: 'r2', outcome: 'failed', startedAt: '2026-10-22T08:10:00Z', scheduleName: 'Nightly', summary: '0 requested, 2 failed' },
  { id: 'r3', outcome: 'missed', startedAt: '2026-10-22T08:20:00Z', scheduleName: 'Morning', summary: '' }, { id: 'r4', outcome: 'skipped', startedAt: '2026-10-22T08:30:00Z', scheduleName: 'X' }, { id: 'r5', outcome: 'error', startedAt: '2026-10-22T08:40:00Z', scheduleName: 'Y', summary: 'owner gone' }, { id: 'r6', outcome: 'partial', startedAt: '2026-10-22T08:50:00Z', scheduleName: 'Z', summary: '1 requested, 1 failed' }
];

test('events are built from the alerts, the connection events and the schedule runs that went wrong, oldest first, from a given time', () => {
  const events = collectEvents({ feed, runs, since: Date.parse('2026-10-22T08:15:00Z') });
  assert.deepEqual(events.map(event => [event.id, event.type, event.severity]), [
    ['schedule-run:r3', 'schedule.problem', 'warning'], ['schedule-run:r5', 'schedule.problem', 'critical'], ['schedule-run:r6', 'schedule.problem', 'warning'], ['connection:c1:fired', 'connection.down', 'warning'],
    ['connection:c1:resolved', 'connection.recovered', 'warning'], ['a1:fired', 'alert.fired', 'critical'], ['a1:resolved', 'alert.resolved', 'critical']]);
  assert.match(events[0].detail, /was missed/); assert.match(events[1].detail, /could not run: owner gone/); assert.match(events[2].detail, /partly failed: 1 requested, 1 failed/);
  assert.equal(collectEvents({ feed, runs, since: 0 }).some(event => event.id === 'schedule-run:r1' || event.id === 'schedule-run:r4'), false, 'a completed or skipped run is not a problem');
  assert.deepEqual(collectEvents({}), []);
});

test('a destination wants an event when it is on, listens to that kind, the event is severe enough and happened after it began to listen', () => {
  const destination = { enabled: true, events: ['alert.fired', 'schedule.problem'], minSeverity: 'critical', activeSince: '2026-10-22T09:00:00Z' };
  const event = (over = {}) => ({ type: 'alert.fired', severity: 'critical', at: '2026-10-22T10:00:00Z', ...over });
  assert.equal(wants(destination, event()), true);
  assert.equal(wants({ ...destination, enabled: false }, event()), false, 'turned off');
  assert.equal(wants(destination, event({ type: 'alert.resolved' })), false, 'not a kind it listens to');
  assert.equal(wants(destination, event({ severity: 'warning' })), false, 'not severe enough');
  assert.equal(wants({ ...destination, minSeverity: 'warning' }, event({ severity: 'warning' })), true);
  assert.equal(wants(destination, event({ at: '2026-10-22T08:59:59Z' })), false, 'before it began to listen: no history is sent');
});

test('the message is in the destination’s format: the full event, a text line, or Discord’s content', () => {
  const event = { id: 'a1:fired', type: 'alert.fired', at: '2026-10-22T10:00:00Z', severity: 'critical', title: 'datastore2', detail: 'Full: 90%' };
  assert.equal(describeEvent(event), '[CRITICAL] datastore2 — Full: 90% (alert raised)');
  assert.deepEqual(JSON.parse(buildPayload({ format: 'text' }, event)), { text: '[CRITICAL] datastore2 — Full: 90% (alert raised)' });
  assert.deepEqual(JSON.parse(buildPayload({ format: 'discord' }, event)), { content: '[CRITICAL] datastore2 — Full: 90% (alert raised)' });
  const full = JSON.parse(buildPayload({ format: 'json' }, event, { version: '0.1.198', deliveryId: 'd-1' }));
  assert.deepEqual(full, { id: 'a1:fired', deliveryId: 'd-1', type: 'alert.fired', occurredAt: '2026-10-22T10:00:00.000Z', severity: 'critical', title: 'datastore2', detail: 'Full: 90%', text: '[CRITICAL] datastore2 — Full: 90% (alert raised)', source: 'nuvrion', version: '0.1.198' });
  assert.equal(JSON.parse(buildPayload({ format: 'discord' }, { ...event, detail: 'x'.repeat(5000) })).content.length, 2000);
});

test('a post carries the event and delivery identifiers, and a signature the receiver can check when there is a signing secret', () => {
  const body = '{"a":1}', event = { type: 'alert.fired' }, now = 1_800_000_000_000;
  const plain = buildHeaders({ body, event, deliveryId: 'd-1', version: '0.1.198' });
  assert.deepEqual(Object.keys(plain).sort(), ['content-length', 'content-type', 'user-agent', 'x-nuvrion-delivery', 'x-nuvrion-event']);
  assert.equal(plain['user-agent'], 'Nuvrion/0.1.198'); assert.equal(plain['content-length'], '7');
  const signed = buildHeaders({ body, event, deliveryId: 'd-1', signingSecret: 'a-long-secret', now });   // secret-scan:allow (fake test credential)
  assert.equal(signed['x-nuvrion-timestamp'], '1800000000');
  assert.equal(signed['x-nuvrion-signature'], `sha256=${createHmac('sha256', 'a-long-secret').update(`1800000000.${body}`).digest('hex')}`);
  assert.notEqual(buildHeaders({ body: '{"a":2}', event, deliveryId: 'd-1', signingSecret: 'a-long-secret', now })['x-nuvrion-signature'], signed['x-nuvrion-signature'], 'a changed body changes the signature');   // secret-scan:allow (fake test credential)
});

test('a result is judged: success is any 2xx, rate limits, timeouts and server errors are tried again with a longer wait each time, anything else is final, and the last attempt is final', () => {
  assert.deepEqual(judge({ ok: true, status: 204 }, 1), { status: 'sent' });
  assert.deepEqual(judge({ ok: false, status: 500 }, 1), { status: 'pending', waitMs: BACKOFF_MS[0] });
  assert.deepEqual(judge({ ok: false, status: 503 }, 2), { status: 'pending', waitMs: BACKOFF_MS[1] });
  assert.deepEqual(judge({ ok: false, status: 429 }, 3), { status: 'pending', waitMs: BACKOFF_MS[2] });
  assert.deepEqual(judge({ ok: false, status: 408 }, 4), { status: 'pending', waitMs: BACKOFF_MS[3] });
  assert.deepEqual(judge({ ok: false }, 5), { status: 'pending', waitMs: BACKOFF_MS[4] }, 'no answer at all (network failure) is tried again');
  assert.deepEqual(judge({ ok: false, status: 500 }, LIMITS.maxAttempts), { status: 'failed' });
  for (const status of [301, 400, 401, 403, 404, 410]) assert.deepEqual(judge({ ok: false, status }, 1), { status: 'failed' }, String(status));
  assert.ok(BACKOFF_MS.every((wait, i) => i === 0 || wait > BACKOFF_MS[i - 1]), 'each wait is longer');
});

test('a destination is described in one line', () => {
  assert.match(describeDestination({ name: 'Ops', events: EVENT_KEYS, minSeverity: 'warning', format: 'text' }), /^Ops: all events, warning and above, Text message$/);
  assert.match(describeDestination({ name: 'Pager', events: ['alert.fired'], minSeverity: 'critical', format: 'json' }), /^Pager: alert\.fired, critical and above, JSON$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText, readBoundedJson, ReplyTooLargeError, MAX_REPLY_BYTES, REPLY_TOO_LARGE } from '../response-body.js';
import { VsphereProvider, VsphereProviderError } from '../vmware-vsphere/src/vsphere-provider.js';
import { WorkstationProvider, WorkstationProviderError } from '../vmware-workstation/src/workstation-provider.js';
import { EsxiProvider, EsxiProviderError } from '../vmware-esxi/src/esxi-provider.js';
import { VmwareSettingsClient, VmwareSettingsError } from '../vmware-settings.js';
import { VmwareSnapshotClient, VmwareSnapshotError } from '../vmware-snapshots.js';
import { collectVsphereQuickStats } from '../vmware-vsphere/src/vsphere-quickstats.js';
import { browseDatastoreIsoFiles } from '../vmware-media.js';

// A reply from a managed endpoint is read up to a limit; beyond it the read stops and the call fails, instead of the endpoint choosing how much memory the
// API holds. The limit is checked on the declared length first, then on the bytes as they arrive (a reply may have no length or a wrong one).
const CREDENTIAL = { username: 'root', password: 'correct-password' }; // secret-scan:allow (fake test credential)
const OVER = MAX_REPLY_BYTES + 1;

// A reply of `bytes` bytes that has no declared length and counts how much of it was pulled.
function streamed(bytes, pulled = { bytes: 0, cancelled: false }) {
  const chunk = new Uint8Array(1024 * 1024).fill(0x78);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const size = Math.min(chunk.byteLength, bytes - sent);
      sent += size; pulled.bytes = sent;
      controller.enqueue(size === chunk.byteLength ? chunk : chunk.subarray(0, size));
    },
    cancel() { pulled.cancelled = true; }
  });
  return { response: new Response(body, { status: 200 }), pulled };
}

test('a reply within the limit is returned whole, with its UTF-8 text intact', async () => {
  assert.equal(await readBoundedText(new Response('<a>café ✓</a>')), '<a>café ✓</a>');
  assert.equal(await readBoundedText(new Response('')), '');
  assert.equal(await readBoundedText(new Response('1234'), { limitBytes: 4 }), '1234', 'exactly at the limit is accepted');
  assert.equal(await readBoundedText(new Response('﻿abc')), 'abc', 'a byte order mark is dropped, as response.text() does');
});

test('multi-byte characters split across chunks are decoded correctly', async () => {
  const bytes = new TextEncoder().encode('aé✓\u{1f600}z');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await readBoundedText(new Response(body)), 'aé✓\u{1f600}z');
});

test('a declared length over the limit is refused without reading the body', async () => {
  const { response, pulled } = streamed(OVER);
  const declared = new Response(response.body, { headers: { 'content-length': String(OVER) } });
  await assert.rejects(() => readBoundedText(declared), error => error instanceof ReplyTooLargeError && error.code === REPLY_TOO_LARGE && error.retryable === false);
  assert.ok(pulled.bytes <= 2 * 1024 * 1024, `only the first chunks were pulled (${pulled.bytes})`);
  assert.equal(pulled.cancelled, true);
});

test('a reply without a declared length is cut off at the limit and the connection is released', async () => {
  const { response, pulled } = streamed(MAX_REPLY_BYTES * 4);
  await assert.rejects(() => readBoundedText(response, { limitBytes: 8 * 1024 * 1024 }), error => error.code === REPLY_TOO_LARGE);
  assert.ok(pulled.bytes <= 8 * 1024 * 1024 + 4 * 1024 * 1024, `stopped near the limit (${pulled.bytes} of ${MAX_REPLY_BYTES * 4})`);
  assert.equal(pulled.cancelled, true);
});

test('a stand-in response with only text() is checked after the read', async () => {
  const fake = { text: async () => 'x'.repeat(9) };
  assert.equal(await readBoundedText(fake, { limitBytes: 9 }), 'xxxxxxxxx');
  await assert.rejects(() => readBoundedText(fake, { limitBytes: 8 }), error => error.code === REPLY_TOO_LARGE);
});

test('the caller can turn the refusal into its own error type', async () => {
  await assert.rejects(() => readBoundedText(new Response('12345'), { limitBytes: 4, make: error => new RangeError(error.code) }), error => error instanceof RangeError && error.message === REPLY_TOO_LARGE);
});

const huge = async () => streamed(OVER).response;

test('each client refuses an oversized reply with its own error type, not retryable', async () => {
  const options = { endpointUri: 'https://esxi01.lab.example/', credential: CREDENTIAL, fetchImpl: huge, timeoutMs: 5000 };
  await assert.rejects(() => new EsxiProvider(options).testConnection(), error => error instanceof EsxiProviderError && error.code === REPLY_TOO_LARGE && error.retryable === false);
  await assert.rejects(() => new VmwareSettingsClient(options).get('vm-1'), error => error instanceof VmwareSettingsError && error.code === REPLY_TOO_LARGE && error.retryable === false);
  await assert.rejects(() => new VmwareSnapshotClient(options).list('vm-1'), error => error instanceof VmwareSnapshotError && error.code === REPLY_TOO_LARGE && error.retryable === false);
});

test('quick statistics are best effort: an oversized reply gives no statistics, and the rest of the reply is not read', async () => {
  const pulled = { bytes: 0, cancelled: false };
  const stats = await collectVsphereQuickStats({ endpointUri: 'https://vcenter.example', credential: CREDENTIAL, vmIds: ['vm-1'], fetchImpl: async () => streamed(MAX_REPLY_BYTES * 4, pulled).response });
  assert.equal(stats.size, 0);
  assert.ok(pulled.bytes < MAX_REPLY_BYTES * 2, `stopped at the limit (${pulled.bytes})`);
  assert.equal(pulled.cancelled, true);
});

test('the datastore browser reports an oversized listing as a warning and carries on with what it has', async () => {
  const result = await browseDatastoreIsoFiles({ base: new URL('https://esxi01.lab.example/'), credential: CREDENTIAL, datastores: ['datastore1'], fetchImpl: huge, timeoutMs: 5000 });
  assert.deepEqual(result.warnings.map(warning => [warning.datastore, warning.code]), [['datastore1', REPLY_TOO_LARGE]]);
  assert.deepEqual([...result.images ?? result.files ?? []], []);
});

test('JSON is parsed from the bounded text, and bad JSON is still a SyntaxError', async () => {
  assert.deepEqual(await readBoundedJson(new Response('{"a":[1,2,{"b":"caf\u00e9"}]}')), { a: [1, 2, { b: 'caf\u00e9' }] });
  await assert.rejects(() => readBoundedJson(new Response('{"a":')), SyntaxError);
  await assert.rejects(() => readBoundedJson(new Response('[1,2,3]'), { limitBytes: 3 }), error => error.code === REPLY_TOO_LARGE);
});

test('the REST providers refuse an oversized reply with their own error type, not retryable', async () => {
  const options = { credential: CREDENTIAL, fetchImpl: async () => streamed(OVER).response, timeoutMs: 5000, pollIntervalMs: 1 };
  const created = async () => new Response(streamed(OVER).response.body, { status: 201 });   // vCenter answers a login with 201
  await assert.rejects(() => new VsphereProvider({ ...options, fetchImpl: created, endpointUri: 'https://vcenter.example/' }).testConnection(), error => error instanceof VsphereProviderError && error.code === REPLY_TOO_LARGE && error.retryable === false);
  await assert.rejects(() => new WorkstationProvider({ ...options, endpointUri: 'https://workstation.lab.example:8697/' }).testConnection(), error => error instanceof WorkstationProviderError && error.code === REPLY_TOO_LARGE && error.retryable === false);
});

test('an oversized error body is not read: the failure is reported from the HTTP status as before', async () => {
  const pulled = { bytes: 0, cancelled: false };
  const failing = async () => { const { response } = streamed(MAX_REPLY_BYTES * 4, pulled); return new Response(response.body, { status: 503 }); };
  const options = { credential: CREDENTIAL, fetchImpl: failing, timeoutMs: 5000, pollIntervalMs: 1 };
  await assert.rejects(() => new WorkstationProvider({ ...options, endpointUri: 'https://workstation.lab.example:8697/' }).testConnection(), error => error.code === 'NUV_WORKSTATION_UNAVAILABLE' && error.retryable === true);
  assert.ok(pulled.bytes < MAX_REPLY_BYTES * 2, `stopped at the limit (${pulled.bytes})`);
  assert.equal(pulled.cancelled, true);
});

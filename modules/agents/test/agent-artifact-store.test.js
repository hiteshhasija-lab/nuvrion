import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgentArtifactStore, AgentArtifactError } from '../src/agent-artifact-store.js';

const exe = size => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(size - 2, 7)]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const chunks = (bytes, size = 4096) => Readable.from((function* () { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size); })());

async function withStore(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nuvrion-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AgentArtifactStore({ directory, ...options }) };
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => error instanceof AgentArtifactError && error.code === code, code);
}

test('an executable is stored under its SHA-256 and nothing else is left behind', async t => {
  const { directory, store } = await withStore(t);
  const bytes = exe(20000);
  const result = await store.store(chunks(bytes));
  assert.deepEqual(result, { sha256: digest(bytes), sizeBytes: 20000 });
  assert.deepEqual(await readdir(directory), [digest(bytes)]);
  assert.ok((await readFile(join(directory, digest(bytes)))).equals(bytes));
  assert.equal(await store.has(digest(bytes)), true);
  assert.equal(await store.has('0'.repeat(64)), false);
  assert.equal(await store.has('../etc/passwd'), false);
  assert.deepEqual(await store.store(chunks(bytes)), result, 'the same file again is the same artifact');
});

test('a matching expected checksum is accepted and a different one discards the upload', async t => {
  const { directory, store } = await withStore(t);
  const bytes = exe(5000);
  await store.store(chunks(bytes), { expectedSha256: digest(bytes).toUpperCase() });
  const other = exe(5001);
  await rejects(store.store(chunks(other), { expectedSha256: digest(bytes) }), 'NUV_AGENT_ARTIFACT_CHECKSUM_MISMATCH');
  assert.equal(await store.has(digest(other)), false);
  assert.deepEqual(await readdir(directory), [digest(bytes)], 'no partial file remains');
  await rejects(store.store(chunks(bytes), { expectedSha256: 'not-a-checksum' }), 'NUV_AGENT_ARTIFACT_INVALID');
});

test('something that is not a Windows executable, or is empty, is refused', async t => {
  const { directory, store } = await withStore(t);
  await rejects(store.store(chunks(Buffer.from('PK\u0003\u0004 a zip archive'))), 'NUV_AGENT_ARTIFACT_NOT_EXECUTABLE');
  await rejects(store.store(chunks(Buffer.from('<html>login page</html>'))), 'NUV_AGENT_ARTIFACT_NOT_EXECUTABLE');
  await rejects(store.store(Readable.from([])), 'NUV_AGENT_ARTIFACT_EMPTY');
  assert.deepEqual(await readdir(directory), []);
});

test('the size limit applies to the declared length and, while streaming, to the real one', async t => {
  const { directory, store } = await withStore(t, { maxBytes: 10000 });
  await rejects(store.store(chunks(exe(100)), { declaredLength: 10001 }), 'NUV_AGENT_ARTIFACT_TOO_LARGE');
  await rejects(store.store(chunks(exe(10001))), 'NUV_AGENT_ARTIFACT_TOO_LARGE');
  assert.deepEqual(await readdir(directory), [], 'an oversized upload leaves no file');
  await store.store(chunks(exe(10000)));
});

test('a stream that fails part way leaves nothing behind', async t => {
  const { directory, store } = await withStore(t);
  const broken = new Readable({ read() { this.push(exe(100)); this.destroy(new Error('connection reset')); } });
  await assert.rejects(store.store(broken), /connection reset/);
  assert.deepEqual(await readdir(directory), []);
});

test('uploads running at the same time do not disturb each other', async t => {
  const { directory, store } = await withStore(t);
  const files = Array.from({ length: 8 }, (_, index) => exe(30000 + index));
  const results = await Promise.all(files.map(bytes => store.store(chunks(bytes, 1024))));
  assert.deepEqual(results.map(item => item.sha256), files.map(digest));
  assert.deepEqual((await readdir(directory)).sort(), files.map(digest).sort());
});

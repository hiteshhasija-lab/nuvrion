import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagService } from '../src/tag-service.js';
import { TagError } from '../src/tag-rules.js';

// The file-backed tag store (local mode): what it keeps, what survives a restart, and that a refused request leaves nothing behind.
const A = '3f2b8c1e-5a47-4d3e-9b0a-1c2d3e4f5a6b', B = '4a3c9d2f-6b58-4e4f-8c1b-2d3e4f5a6b7c', C = '5b4d0e3a-7c69-4f5a-9d2c-3e4f5a6b7c8d';
const withDirectory = async work => { const dir = mkdtempSync(join(tmpdir(), 'nuvrion-tags-')); try { return await work(dir, join(dir, 'tags.json')); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('tags are set on several resources at once, listed sorted with their source, and summarised in a catalog', () => withDirectory(async (dir, file) => {
  const service = new TagService({ file });
  const plan = await service.apply({ resourceIds: [A, B], set: [{ key: 'env', value: 'prod' }, { key: 'team', value: 'core' }] });
  assert.deepEqual(plan.map(entry => entry.changedAnything), [true, true]);
  await service.apply({ resourceIds: [B], set: [{ key: 'env', value: 'staging' }] });
  const tags = await service.forResources([A, B, C]);
  assert.deepEqual(tags.get(A), [{ key: 'env', value: 'prod', source: 'nuvrion' }, { key: 'team', value: 'core', source: 'nuvrion' }]);
  assert.equal(tags.get(B).find(tag => tag.key === 'env').value, 'staging');
  assert.equal(tags.has(C), false, 'a resource without tags is simply absent');
  assert.deepEqual(await service.catalog(), [
    { key: 'env', resourceCount: 2, values: [{ value: 'prod', count: 1 }, { value: 'staging', count: 1 }] },
    { key: 'team', resourceCount: 2, values: [{ value: 'core', count: 2 }] }]);
}));

test('tags survive a restart, the file is private and written atomically, and a request that changes nothing does not rewrite it', () => withDirectory(async (dir, file) => {
  const service = new TagService({ file });
  await service.apply({ resourceIds: [A], set: [{ key: 'env', value: 'prod' }] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${file}.tmp`), 'no temporary file is left');
  const reopened = new TagService({ file });
  assert.deepEqual((await reopened.forResources([A])).get(A), [{ key: 'env', value: 'prod', source: 'nuvrion' }]);
  const before = statSync(file).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 15));
  const plan = await reopened.apply({ resourceIds: [A], set: [{ key: 'env', value: 'prod' }], remove: ['absent'] });
  assert.equal(plan[0].changedAnything, false);
  assert.equal(statSync(file).mtimeMs, before, 'nothing changed, so nothing was written');
}));

test('removing the last tag of a resource removes the resource from the store', () => withDirectory(async (dir, file) => {
  const service = new TagService({ file });
  await service.apply({ resourceIds: [A], set: [{ key: 'env', value: 'prod' }] });
  await service.apply({ resourceIds: [A], remove: ['env'] });
  assert.equal((await service.forResources([A])).size, 0);
  assert.deepEqual(await service.catalog(), []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tags, []);
}));

test('a request refused for any resource changes none: a resource at the limit stops the whole request', () => withDirectory(async (dir, file) => {
  const service = new TagService({ file });
  const fifty = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: '' }));
  for (let start = 0; start < 50; start += 20) await service.apply({ resourceIds: [A], set: fifty.slice(start, start + 20) });
  await assert.rejects(() => service.apply({ resourceIds: [B, A], set: [{ key: 'extra', value: '1' }] }), error => error instanceof TagError && error.code === 'NUV_TAG_LIMIT_EXCEEDED');
  assert.equal((await service.forResources([B])).has(B), false, 'B was listed first and was not changed either');
  assert.equal((await service.forResources([A])).get(A).length, 50);
  await assert.rejects(() => service.apply({ resourceIds: [A], set: [{ key: 'Bad Key' }] }), TagError);
  assert.equal((await service.forResources([A])).get(A).length, 50);
}));

test('forget drops the tags of resources that no longer exist, and a missing or empty file is a fresh store', () => withDirectory(async (dir, file) => {
  const service = new TagService({ file });
  await service.apply({ resourceIds: [A, B], set: [{ key: 'env', value: 'prod' }] });
  assert.equal(await service.forget([A, C]), 1);
  assert.deepEqual([...(await new TagService({ file }).forResources([A, B])).keys()], [B]);
  assert.deepEqual(await new TagService({ file: join(dir, 'absent.json') }).catalog(), []);
  assert.deepEqual(await new TagService().catalog(), [], 'with no file at all it is in memory only');
  writeFileSync(join(dir, 'empty.json'), '{"schemaVersion":1}');
  assert.deepEqual(await new TagService({ file: join(dir, 'empty.json') }).catalog(), []);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('task creation does not check out a nested pool connection',async()=>{
  const source=await readFile(new URL('../modules/tasks/src/postgres-task-store.js',import.meta.url),'utf8');
  const createBody=source.slice(source.indexOf('async create('),source.indexOf('async list('));
  assert.match(createBody,/INSERT INTO operations\.tasks[\s\S]*RETURNING \*/);
  assert.doesNotMatch(createBody,/await this\.get\(/);
  assert.match(createBody,/taskFrom\(inserted\.rows\[0\]\)/);
});

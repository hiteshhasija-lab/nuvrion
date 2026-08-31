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

test('transactional task completion and recovery paths use their existing client',async()=>{
  const source=await readFile(new URL('../modules/tasks/src/postgres-task-store.js',import.meta.url),'utf8');
  for(const [start,end] of [['async #finish(','complete(id,result)'],['async retry(','async verificationRequired('],['async verificationRequired(','async cancel(']]){
    const body=source.slice(source.indexOf(start),source.indexOf(end));
    assert.doesNotMatch(body,/await this\.get\(/);
    assert.match(body,/client\.query\('SELECT \* FROM operations\.tasks WHERE task_id=\$1'/);
  }
});

test('task claim returns through its existing transaction client',async()=>{
  const source=await readFile(new URL('../modules/tasks/src/postgres-task-store.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async claim('),source.indexOf('async running('));
  assert.doesNotMatch(body,/await this\.get\(/);
  assert.match(body,/const claimed=taskFrom\(\(await client\.query/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskStore} from '../modules/tasks/src/task-store.js';
import {LocalTaskBroker} from '../modules/messaging/src/task-broker.js';
import {Worker} from '../apps/worker/src/worker.js';

test('broker delivery claims only the task identified by its message',async()=>{
  const store=new TaskStore(),make=key=>store.create({operation:'start',targetId:key,correlationId:key,idempotencyKey:key}).task,first=make('first'),second=make('second');
  const broker=new LocalTaskBroker(),provider={async execute(){return {providerReference:'ref'}},async verify(){return {code:'OK'}}},worker=new Worker({store,provider,broker});
  await worker.start();await broker.publishTaskQueued(second.id);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(store.get(first.id).status,'queued');assert.equal(store.get(second.id).status,'completed');
});

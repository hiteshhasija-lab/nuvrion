import test from 'node:test';
import assert from 'node:assert/strict';
import {runDurableTaskLoad,DurableTaskLoadError} from '../modules/platform/src/durable-task-load.js';

class FakeStore{
  constructor({duplicate=false,fail=false}={}){this.tasks=new Map();this.duplicate=duplicate;this.fail=fail;}
  async create(input){const queuedAt=new Date(1000).toISOString(),task={id:input.targetId,operation:input.operation,target:{id:input.targetId,type:input.targetType},providerNativeId:input.providerNativeId,connectionId:input.connectionId,queuedAt,completedAt:new Date(1100).toISOString(),status:this.fail?'failed':'completed'};this.tasks.set(task.id,task);return {created:true,task};}
  async get(id){return this.tasks.get(id);}
  async attempts(){return this.duplicate?[{},{}]:[{}];}
}

test('synthetic durable task load passes with bounded aggregate evidence',async()=>{let now=2000;const store=new FakeStore(),result=await runDurableTaskLoad({store,count:20,concurrency:5,clock:()=>now,sleep:async()=>{now+=1}});assert.equal(result.status,'passed');assert.equal(result.syntheticOnly,true);assert.equal(result.completedTasks,20);assert.equal(result.lostTasks,0);assert.equal(result.duplicateOperations,0);assert.equal(result.p95CompletionMs,100);for(const task of store.tasks.values()){assert.match(task.target.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.match(task.providerNativeId,new RegExp(`^qualification:${result.runId}:\\d+$`));}});
test('duplicate provider attempts fail the task load gate',async()=>{const result=await runDurableTaskLoad({store:new FakeStore({duplicate:true}),count:10,concurrency:5,clock:()=>2000});assert.equal(result.status,'failed');assert.equal(result.duplicateOperations,10);});
test('unsafe bounds and missing stores fail closed',async()=>{await assert.rejects(()=>runDurableTaskLoad({count:10}),error=>error instanceof DurableTaskLoadError);await assert.rejects(()=>runDurableTaskLoad({store:new FakeStore(),count:9}),/outside safe bounds/);await assert.rejects(()=>runDurableTaskLoad({store:new FakeStore(),count:10,concurrency:11}),/outside safe bounds/);});

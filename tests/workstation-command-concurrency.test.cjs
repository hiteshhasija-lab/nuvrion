const test=require('node:test');
const assert=require('node:assert/strict');
const {runCommandBatch}=require('../apps/workstation-agent/src/agent-service.cjs');

test('Workstation agent executes independent VM commands concurrently',async()=>{
  const commands=[1,2,3].map(index=>({payload:{commandId:`command-${index}`,targetId:`vm-${index}`}}));
  let active=0,maximum=0,started=0,release;
  const gate=new Promise(resolve=>release=resolve),acknowledged=[];
  await runCommandBatch(commands,{
    async executeCommand(command){active++;started++;maximum=Math.max(maximum,active);if(started===3)release();await gate;active--;return {powerState:'running',targetId:command.payload.targetId};},
    async acknowledge(command,status){acknowledged.push([command.payload.commandId,status]);}
  });
  assert.equal(maximum,3);
  assert.deepEqual(acknowledged.sort(),[['command-1','completed'],['command-2','completed'],['command-3','completed']]);
});

test('Workstation agent applies no artificial command concurrency limit',async()=>{
  const commands=Array.from({length:12},(_,index)=>({payload:{commandId:`command-${index}`}}));
  let active=0,maximum=0,started=0,release;
  const gate=new Promise(resolve=>release=resolve);
  await runCommandBatch(commands,{async executeCommand(){active++;started++;maximum=Math.max(maximum,active);if(started===commands.length)release();await gate;active--;return {};},async acknowledge(){}});
  assert.equal(maximum,commands.length);
});

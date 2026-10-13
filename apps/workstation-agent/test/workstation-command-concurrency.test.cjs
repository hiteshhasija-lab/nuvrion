const test=require('node:test');
const assert=require('node:assert/strict');
const {createCommandDispatcher,runCommandBatch}=require('../src/agent-service.cjs');

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

test('Workstation agent serializes commands targeting the same VM',async()=>{
  const commands=[1,2,3].map(index=>({payload:{commandId:`same-${index}`,targetId:'C:\\VMs\\Lab\\Lab.vmx'}}));
  let active=0,maximum=0;
  await runCommandBatch(commands,{async executeCommand(){active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {};},async acknowledge(){}});
  assert.equal(maximum,1);
});

test('Workstation agent re-acknowledges a durable result without executing twice',async()=>{
  const command={payload:{commandId:'durable-1',targetId:'vm-1'}},saved={status:'completed',result:{powerState:'running'}},acknowledged=[];
  let executions=0;
  const [result]=await runCommandBatch([command],{async executeCommand(){executions++;return {};},lookupResult:()=>saved,async acknowledge(_command,status,value){acknowledged.push({status,value})}});
  assert.equal(executions,0);
  assert.equal(result.replayed,true);
  assert.deepEqual(acknowledged,[{status:'completed',value:saved.result}]);
});

test('Workstation agent serializes commands that target the same VM',async()=>{
  const commands=[1,2,3].map(index=>({payload:{commandId:`same-${index}`,targetId:'C:\\VMs\\Lab\\Lab.vmx'}}));
  let active=0,maximum=0;
  await runCommandBatch(commands,{
    async executeCommand(){active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {};},
    async acknowledge(){}
  });
  assert.equal(maximum,1);
});

test('Workstation agent replays a durable terminal result without executing twice',async()=>{
  const command={payload:{commandId:'durable-command',targetId:'vm-1'}},saved={status:'completed',result:{powerState:'running'}},acknowledged=[];
  let executions=0;
  const [result]=await runCommandBatch([command],{
    async executeCommand(){executions++;return {};},
    lookupResult:()=>saved,
    async acknowledge(_command,status,value){acknowledged.push([status,value]);}
  });
  assert.equal(executions,0);
  assert.equal(result.replayed,true);
  assert.deepEqual(acknowledged,[['completed',saved.result]]);
});

test('Workstation agent keeps polling while a previously dispatched command is still running',async()=>{
  let releaseStop,stopStarted=false,powerOffStarted=false;
  const stopGate=new Promise(resolve=>releaseStop=resolve),dispatcher=createCommandDispatcher({
    async executeCommand(command){if(command.payload.operation==='stop'){stopStarted=true;await stopGate;}else powerOffStarted=true;return {};},
    async acknowledge(){}
  });
  dispatcher.dispatch([{payload:{commandId:'stop-1',operation:'stop',targetId:'C:\\VMs\\Boot Test VM\\Boot Test VM.vmx'}}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopStarted,true);
  dispatcher.dispatch([{payload:{commandId:'power-off-1',operation:'power_off',targetId:'C:\\VMs\\Boot Test VM\\Boot Test VM.vmx'}}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(powerOffStarted,true);
  releaseStop();
  await dispatcher.waitForIdle();
});

test('Workstation agent does not execute a repeatedly polled in-flight command twice',async()=>{
  let executions=0,release;
  const gate=new Promise(resolve=>release=resolve),command={payload:{commandId:'repeat-1',operation:'stop',targetId:'vm-1'}},dispatcher=createCommandDispatcher({async executeCommand(){executions++;await gate;return {};},async acknowledge(){}});
  assert.equal(dispatcher.dispatch([command]).length,1);
  assert.equal(dispatcher.dispatch([command]).length,0);
  release();
  await dispatcher.waitForIdle();
  assert.equal(executions,1);
});

test('Workstation agent still serializes ordinary commands received in separate polls',async()=>{
  let active=0,maximum=0,releaseFirst;
  const firstGate=new Promise(resolve=>releaseFirst=resolve),dispatcher=createCommandDispatcher({async executeCommand(command){active++;maximum=Math.max(maximum,active);if(command.payload.commandId==='first')await firstGate;active--;return {};},async acknowledge(){}}),targetId='C:\\VMs\\Lab\\Lab.vmx';
  dispatcher.dispatch([{payload:{commandId:'first',operation:'stop',targetId}}]);
  await new Promise(resolve=>setImmediate(resolve));
  dispatcher.dispatch([{payload:{commandId:'second',operation:'start',targetId}}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(maximum,1);
  releaseFirst();
  await dispatcher.waitForIdle();
  assert.equal(maximum,1);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {acquireSingleInstance,singleInstanceAddress}=require('../src/agent-service.cjs');

class FakeServer extends EventEmitter{
  constructor(conflict){super();this.conflict=conflict;}
  listen(_address,ready){queueMicrotask(()=>this.conflict?this.emit('error',Object.assign(new Error('in use'),{code:'EADDRINUSE'})):ready());}
  close(done){queueMicrotask(()=>done?.());}
}

test('Workstation agent rejects a duplicate process and releases its guard cleanly',async()=>{
  const name=`NuvrionWorkstationAgent-test-${randomUUID()}`;
  const address=singleInstanceAddress(name);
  const first=await acquireSingleInstance(address,()=>new FakeServer(false));
  await assert.rejects(acquireSingleInstance(address,()=>new FakeServer(true)),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  await first.close();
  const replacement=await acquireSingleInstance(address,()=>new FakeServer(false));
  await replacement.close();
});

test('Workstation agent uses a named pipe as its Windows single-instance guard',()=>{
  const address=singleInstanceAddress('NuvrionTest');
  if(process.platform==='win32')assert.equal(address,'\\\\.\\pipe\\NuvrionTest');
  else assert.match(address,/nuv-[a-f0-9]{16}\.sock$/);
});

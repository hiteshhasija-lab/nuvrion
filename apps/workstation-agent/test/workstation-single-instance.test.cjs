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
  await assert.rejects(acquireSingleInstance(address,()=>new FakeServer(true),{probe:async()=>true}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  await first.close();
  const replacement=await acquireSingleInstance(address,()=>new FakeServer(false));
  await replacement.close();
});

test('Workstation agent uses a named pipe as its Windows single-instance guard',()=>{
  const address=singleInstanceAddress('NuvrionTest');
  if(process.platform==='win32')assert.equal(address,'\\\\.\\pipe\\NuvrionTest');
  else assert.match(address,/nuv-[a-f0-9]{16}\.sock$/);
});

// A POSIX process that exits leaves its socket file; a Windows named pipe cannot. A socket nobody answers on must not read as a running agent
// (found by running a real upgrade, where the restarted agent was refused by the exiting agent's leftover file).
test('a leftover socket that nothing answers on is removed once and the guard is taken',async()=>{
  const removed=[],servers=[new FakeServer(true),new FakeServer(false)];
  const guard=await acquireSingleInstance('/tmp/nuv-stale.sock',()=>servers.shift(),{posix:true,probe:async()=>false,unlink:file=>removed.push(file)});
  assert.deepEqual(removed,['/tmp/nuv-stale.sock']);
  await guard.close();
});

test('a socket that answers is a running agent: refused, and the file is left alone',async()=>{
  const removed=[];
  await assert.rejects(acquireSingleInstance('/tmp/nuv-live.sock',()=>new FakeServer(true),{posix:true,probe:async()=>true,unlink:file=>removed.push(file)}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  assert.deepEqual(removed,[]);
});

test('a stale socket is retried only once, so a guard that keeps failing ends as already running',async()=>{
  let attempts=0;
  await assert.rejects(acquireSingleInstance('/tmp/nuv-x.sock',()=>{attempts+=1;return new FakeServer(true);},{posix:true,probe:async()=>false,unlink(){}}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  assert.equal(attempts,2);
});

test('on Windows the named pipe is never probed or removed',async()=>{
  let probed=false;
  await assert.rejects(acquireSingleInstance('\\\\.\\pipe\\X',()=>new FakeServer(true),{posix:false,probe:async()=>{probed=true;return false;}}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  assert.equal(probed,false);
});

test('the real probe tells a live socket from a leftover file',async t=>{
  const net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  if(process.platform==='win32')return t.skip('POSIX sockets only');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nuv-probe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const address=path.join(dir,'a.sock'),live=net.createServer(socket=>socket.destroy());
  await new Promise(resolve=>live.listen(address,resolve));
  // the same function the agent uses, reached through acquireSingleInstance's default probe: a live socket is refused
  await assert.rejects(acquireSingleInstance(address,undefined,{posix:true}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  assert.ok(fs.existsSync(address),'a live socket must not be removed');
  await new Promise(resolve=>live.close(resolve));
  // a real leftover: a process that listened and was killed, so its socket file outlived it
  const {spawnSync}=require('node:child_process');
  spawnSync(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(address)},()=>process.kill(process.pid,'SIGKILL'))`]);
  assert.ok(fs.lstatSync(address).isSocket(),'the leftover must be a socket file');
  const guard=await acquireSingleInstance(address,undefined,{posix:true});
  await guard.close();
  // and a regular file at that path is not ours to remove
  // (the probe is forced to "nothing answers" so the removal rule itself is what is tested, whatever error this OS gives for a non-socket)
  fs.writeFileSync(address,'precious');
  await assert.rejects(acquireSingleInstance(address,undefined,{posix:true,probe:async()=>false}),error=>error.code==='NUV_AGENT_ALREADY_RUNNING');
  assert.equal(fs.readFileSync(address,'utf8'),'precious');
});

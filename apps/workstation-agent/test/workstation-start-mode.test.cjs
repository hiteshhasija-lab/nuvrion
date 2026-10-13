const test=require('node:test'),assert=require('node:assert/strict');
const {workstationStartAction,workstationStartMode}=require('../src/agent-service.cjs');

const vmx='C:\\VMs\\NOVAAPP02\\NOVAAPP02.vmx';
const running=new Set(['c:\\vms\\other\\other.vmx']);

test('a VM that is not running is started without a window unless startMode is gui',()=>{
  assert.deepEqual(workstationStartAction(vmx,running),['start',vmx,'nogui']);
  assert.deepEqual(workstationStartAction(vmx,running,'nogui'),['start',vmx,'nogui']);
  assert.deepEqual(workstationStartAction(vmx,running,'gui'),['start',vmx,'gui']);
});

test('a VM that is already running (paused) is unpaused whatever the start mode',()=>{
  const paused=new Set([vmx.toLowerCase()]);
  assert.deepEqual(workstationStartAction(vmx,paused,'gui'),['unpause',vmx]);
  assert.deepEqual(workstationStartAction(vmx,paused,'nogui'),['unpause',vmx]);
});

test('startMode comes from bootstrap.json: only "gui" (any case) opts in, everything else keeps the default',()=>{
  assert.equal(workstationStartMode({startMode:'gui'}),'gui');
  assert.equal(workstationStartMode({startMode:'GUI'}),'gui');
  for(const value of [undefined,null,'','nogui','window',true,1,{},[]]){
    assert.equal(workstationStartMode({startMode:value}),'nogui',JSON.stringify(value));
  }
  assert.equal(workstationStartMode({}),'nogui');
  assert.equal(workstationStartMode(undefined),'nogui');
});

test('an unknown mode passed straight to the action cannot put an arbitrary argument on the vmrun command line',()=>{
  assert.deepEqual(workstationStartAction(vmx,running,'; calc'),['start',vmx,'nogui']);
});

// The command path: the agent asks vmrun which VMs are running, then picks the action. A stub vmrun stands in for VMware.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {workstationStartCommand}=require('../src/agent-service.cjs');

function stubVmrun(t,runningVmx=[]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-vmrun-stub-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'vmrun');
  fs.writeFileSync(file,`#!/bin/sh\nif [ "$1" = "list" ]; then echo "Total running VMs: ${runningVmx.length}"; ${runningVmx.map(v=>`echo '${v}';`).join(' ')} exit 0; fi\nexit 9\n`,{mode:0o755});
  return file;
}

test('the start command reads the running list from vmrun and applies startMode from the configuration',{skip:process.platform==='win32'},async t=>{
  const target=path.join(os.tmpdir(),'NOVAAPP02','NOVAAPP02.vmx');
  const vmrunPath=stubVmrun(t,[path.join(os.tmpdir(),'OTHER','OTHER.vmx')]);
  assert.deepEqual(await workstationStartCommand({vmrunPath},target),['start',target,'nogui']);
  assert.deepEqual(await workstationStartCommand({vmrunPath,startMode:'gui'},target),['start',target,'gui']);
  assert.deepEqual(await workstationStartCommand({vmrunPath,startMode:'nogui'},target),['start',target,'nogui']);
});

test('the start command unpauses a VM that vmrun lists as running, in either mode',{skip:process.platform==='win32'},async t=>{
  const target=path.join(os.tmpdir(),'NOVAAPP02','NOVAAPP02.vmx');
  const vmrunPath=stubVmrun(t,[target]);
  assert.deepEqual(await workstationStartCommand({vmrunPath,startMode:'gui'},target),['unpause',target]);
  assert.deepEqual(await workstationStartCommand({vmrunPath},target),['unpause',target]);
});

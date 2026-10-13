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

// What the agent ran is written to agent.log.
const {runWorkstationCommand}=require('../src/agent-service.cjs');

// Takes only the agent's own log lines; anything else written to stdout (the test runner's output) is passed through untouched.
function capture(){const lines=[],write=process.stdout.write;process.stdout.write=function(chunk,...rest){if(String(chunk).startsWith('{"time":')&&String(chunk).includes('"event":"agent.')){lines.push(String(chunk));return true;}return write.call(this,chunk,...rest);};return {events:()=>lines.flatMap(l=>l.split('\n')).filter(Boolean).map(l=>JSON.parse(l)),stop:()=>{process.stdout.write=write;}};}
function stubVmrunExit(t,code){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-vmrun-stub-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'vmrun');
  fs.writeFileSync(file,`#!/bin/sh\n${code?'echo "The virtual machine is locked" >&2; ':''}exit ${code}\n`,{mode:0o755});
  return file;
}

test('a start is logged with its arguments and start mode before vmrun is run',{skip:process.platform==='win32'},async t=>{
  const vmrunPath=stubVmrunExit(t,0),target='D:\\VMs\\NOVAAPP02\\NOVAAPP02.vmx',action=['start',target,'gui'],output=capture();
  try{await runWorkstationCommand({vmrunPath,startMode:'gui'},{commandId:'cmd-1',operation:'start'},action);}finally{output.stop();}
  const [event,...rest]=output.events();
  assert.equal(rest.length,0);
  assert.equal(event.event,'agent.vmrun');
  assert.equal(event.commandId,'cmd-1');
  assert.equal(event.operation,'start');
  assert.deepEqual(event.action,action);
  assert.equal(event.startMode,'gui');
});

test('only a start carries a start mode; other VMware commands are logged without one',{skip:process.platform==='win32'},async t=>{
  const vmrunPath=stubVmrunExit(t,0),output=capture();
  try{
    await runWorkstationCommand({vmrunPath,startMode:'gui'},{commandId:'cmd-2',operation:'stop'},['stop','D:\\VMs\\A\\A.vmx','soft']);
    await runWorkstationCommand({vmrunPath,startMode:'gui'},{commandId:'cmd-3',operation:'start'},['unpause','D:\\VMs\\A\\A.vmx']);
  }finally{output.stop();}
  const events=output.events();
  assert.equal(events.length,2);
  assert.equal('startMode' in events[0],false);
  assert.equal('startMode' in events[1],false);
});

test('a failing vmrun is logged with its own message and the error is still thrown',{skip:process.platform==='win32'},async t=>{
  const vmrunPath=stubVmrunExit(t,1),output=capture();
  let thrown;
  try{await runWorkstationCommand({vmrunPath},{commandId:'cmd-4',operation:'start'},['start','D:\\VMs\\A\\A.vmx','nogui']);}catch(error){thrown=error;}finally{output.stop();}
  assert.ok(thrown,'the failure must propagate to the command result');
  const events=output.events();
  assert.deepEqual(events.map(e=>e.event),['agent.vmrun','agent.vmrun.failed']);
  assert.equal(events[1].commandId,'cmd-4');
  assert.match(events[1].message,/virtual machine is locked/);
});

// Setup: a new install and an upgrade both end up with startMode gui, and an upgrade never overwrites a choice.
test('a new install writes startMode gui into bootstrap.json',()=>{
  const install=fs.readFileSync('deploy/workstation-agent/install.ps1','utf8');
  assert.match(install,/"commandPollIntervalMs":500,"startMode":"gui"\}'/);
});

test('an upgrade adds startMode gui only when the setting is absent',()=>{
  const upgrade=fs.readFileSync('deploy/workstation-agent/upgrade-lab.ps1','utf8');
  const line=upgrade.split('\n').find(l=>l.includes("Properties['startMode']"));
  assert.ok(line,'upgrade-lab.ps1 must handle startMode');
  assert.match(line,/if\(\$null -eq \$bootstrap\.PSObject\.Properties\['startMode'\]\)\{\$bootstrap\|Add-Member -NotePropertyName startMode -NotePropertyValue 'gui'\}/);
  assert.doesNotMatch(line,/-Force/,'an existing startMode (for example nogui) must not be overwritten');
  assert.equal(upgrade.split('\n').filter(l=>/NotePropertyName startMode/.test(l)).length,1);
});

test('the setup wizard does not reset startMode when it re-saves bootstrap.json after an upgrade',()=>{
  const wizard=fs.readFileSync('deploy/workstation-agent/install-gui.ps1','utf8');
  assert.doesNotMatch(wizard,/startMode/);
  // it re-reads the file the upgrade just wrote and only sets the keys it lists, so startMode is carried through
  assert.match(wizard,/\$bootstrap=Get-Content -Raw -LiteralPath \$bootstrapPath\|ConvertFrom-Json/);
});

test('runCommand issues its VMware command through the logging helper, not directly',()=>{
  // runCommand has side effects (power-state files next to the executable) and is not run here, so this guards the call site.
  const source=fs.readFileSync(path.join(__dirname,'..','src','agent-service.cjs'),'utf8');
  assert.match(source,/await runWorkstationCommand\(config,payload,action\);/);
  assert.doesNotMatch(source,/await run\(config\.vmrunPath,action,120000\)/);   // the helper itself passes timeoutMs
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {consolePassword,reconcileConsoleConfiguration,vmxValue}=require('../apps/workstation-agent/src/agent-service.cjs');

test('automatic console configuration changes only stopped VMs and allocates unique local ports',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-console-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stopped=path.join(root,'stopped.vmx'),running=path.join(root,'running.vmx');
  fs.writeFileSync(stopped,'displayName = "Stopped"\n');
  fs.writeFileSync(running,'displayName = "Running"\n');
  const config={identity:{secret:'agent-secret'},autoConfigureConsole:true,consolePortRange:{start:5900,end:5902}};
  reconcileConsoleConfiguration(config,[stopped,running],new Set([running.toLowerCase()]));
  const stoppedText=fs.readFileSync(stopped,'utf8'),runningText=fs.readFileSync(running,'utf8');
  assert.equal(vmxValue(stoppedText,'RemoteDisplay.vnc.enabled'),'TRUE');
  assert.equal(vmxValue(stoppedText,'RemoteDisplay.vnc.ip'),'127.0.0.1');
  assert.equal(vmxValue(stoppedText,'RemoteDisplay.vnc.port'),'5900');
  assert.equal(vmxValue(stoppedText,'RemoteDisplay.vnc.password'),consolePassword(config.identity.secret,stopped));
  assert.equal(runningText,'displayName = "Running"\n');
});

test('automatic console configuration preserves a ready managed VM',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-console-ready-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const vmx=path.join(root,'ready.vmx'),secret='agent-secret',original=`displayName = "Ready"\nRemoteDisplay.vnc.enabled = "TRUE"\nRemoteDisplay.vnc.port = "5901"\nRemoteDisplay.vnc.password = "${consolePassword(secret,vmx)}"\nRemoteDisplay.vnc.ip = "127.0.0.1"\n`;
  fs.writeFileSync(vmx,original);
  reconcileConsoleConfiguration({identity:{secret},consolePortRange:{start:5900,end:5999}},[vmx],new Set());
  assert.equal(fs.readFileSync(vmx,'utf8'),original);
});

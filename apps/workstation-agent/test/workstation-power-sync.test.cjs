const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {mergePowerInventory,workstationPowerAction,workstationStartAction}=require('../src/agent-service.cjs');

test('fast Workstation inventory updates power state without rebuilding metadata',()=>{
  const vmx=path.normalize('C:\\VMs\\Exchange2K\\Exchange2K.vmx');
  const item={nativeId:vmx,name:'Exchange2K',hostName:'EXCHANGE2K',privateIps:['10.0.0.27'],powerState:'stopped'};
  const running=new Set([vmx.toLowerCase()]);
  const observedAt='2026-09-01T20:00:00.000Z';
  const [updated]=mergePowerInventory([item],running,new Set(),observedAt);
  assert.equal(updated.powerState,'running');
  assert.equal(updated.hostName,'EXCHANGE2K');
  assert.deepEqual(updated.privateIps,['10.0.0.27']);
  assert.equal(updated.observedAt,observedAt);
});

test('fast Workstation inventory preserves a known suspended state',()=>{
  const vmx=path.normalize('C:\\VMs\\XP\\XP.vmx'),key=vmx.toLowerCase();
  const [updated]=mergePowerInventory([{nativeId:vmx,powerState:'running'}],new Set([key]),new Set([key]),undefined,candidate=>candidate===key);
  assert.equal(updated.powerState,'suspended');
});

test('fast Workstation inventory detects native suspend state without a Nuvrion pause record',()=>{
  const vmx=path.normalize('C:\\VMs\\Native\\Native.vmx'),key=vmx.toLowerCase();
  const [updated]=mergePowerInventory([{nativeId:vmx,powerState:'running'}],new Set(),new Set(),undefined,candidate=>candidate===key);
  assert.equal(updated.powerState,'suspended');
});

test('resume uses unpause whenever Workstation still lists the VM as running',()=>{
  const vmx=path.normalize('C:\\VMs\\XP\\XP.vmx'),running=new Set([vmx.toLowerCase()]);
  assert.deepEqual(workstationStartAction(vmx,running),['unpause',vmx]);
  assert.deepEqual(workstationStartAction('C:\\VMs\\Off\\Off.vmx',running),['start','C:\\VMs\\Off\\Off.vmx','nogui']);
});

test('guest restart is soft while Reset remains explicitly hard',()=>{
  const vmx='C:\\VMs\\Lab\\Lab.vmx';
  assert.deepEqual(workstationPowerAction('reboot_guest',vmx),['reset',vmx,'soft']);
  assert.deepEqual(workstationPowerAction('restart',vmx),['reset',vmx,'hard']);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {cachedDiskUsedBytes,cachedVmcliGuestMetadata,pruneInventoryCaches,reconcileConsoleIfChanged,vmxSnapshot}=require('../src/agent-service.cjs');

test('unchanged VM configuration is reused until its file changes',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-vmx-cache-')),file=path.join(directory,'Lab.vmx');
  fs.writeFileSync(file,'displayName = "Lab"\nmemsize = "2048"\n');
  const first=vmxSnapshot(file,'secret',300000,1000),second=vmxSnapshot(file,'secret',300000,2000);
  assert.equal(second,first);
  fs.appendFileSync(file,'numvcpus = "4"\n');
  const changed=vmxSnapshot(file,'secret',300000,3000);
  assert.notEqual(changed,first);
  assert.equal(changed.cpu,4);
  pruneInventoryCaches(new Set());
});

test('virtual-disk utilization is cached for five minutes',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-vmdk-cache-')),descriptor=path.join(directory,'Lab.vmdk'),extent=path.join(directory,'Lab-flat.vmdk');
  fs.writeFileSync(descriptor,'# Disk DescriptorFile\nRW 16 FLAT "Lab-flat.vmdk" 0\n');
  fs.writeFileSync(extent,'1234');
  const hardware={disks:[{backing:'Lab.vmdk',capacityBytes:8192}]};
  assert.equal(cachedDiskUsedBytes(hardware,path.join(directory,'Lab.vmx'),300000,1000),4);
  fs.appendFileSync(extent,'5678');
  assert.equal(cachedDiskUsedBytes(hardware,path.join(directory,'Lab.vmx'),300000,2000),4);
  assert.equal(cachedDiskUsedBytes(hardware,path.join(directory,'Lab.vmx'),300000,301001),8);
  pruneInventoryCaches(new Set());
});

test('complete VMware guest identity is cached while incomplete data retries each minute',async()=>{
  let calls=0;
  const complete={vmrunPath:'vmrun.exe',vmcliRunner:async args=>{calls+=1;return args.includes('Tools')?'1':JSON.stringify({guest:{hostName:'VDI02',guestFullName:'Windows Server'}});}};
  const vmx='C:\\VMs\\VDI02\\VDI02.vmx';
  assert.equal((await cachedVmcliGuestMetadata(complete,vmx,'running',300000,1000)).hostName,'VDI02');
  assert.equal(calls,2);
  await cachedVmcliGuestMetadata(complete,vmx,'running',300000,2000);
  assert.equal(calls,2);
  await cachedVmcliGuestMetadata(complete,vmx,'running',300000,301001);
  assert.equal(calls,4);

  const incompleteVmx='C:\\VMs\\NoTools\\NoTools.vmx';
  const incomplete={vmrunPath:'vmrun.exe',vmcliRunner:async()=>{calls+=1;return '';}};
  await cachedVmcliGuestMetadata(incomplete,incompleteVmx,'running',300000,1000);
  const afterFirst=calls;
  await cachedVmcliGuestMetadata(incomplete,incompleteVmx,'running',300000,2000);
  assert.equal(calls,afterFirst);
  await cachedVmcliGuestMetadata(incomplete,incompleteVmx,'running',300000,61001);
  assert.ok(calls>afterFirst);
  pruneInventoryCaches(new Set());
});

test('console configuration reconciliation skips an unchanged inventory',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-console-cache-')),file=path.join(directory,'Lab.vmx'),config={identity:{secret:'secret'},consolePortRange:{start:5900,end:5901}};
  fs.writeFileSync(file,'displayName = "Lab"\n');
  assert.equal(reconcileConsoleIfChanged(config,[file],new Set()),true);
  assert.equal(reconcileConsoleIfChanged(config,[file],new Set()),true);
  assert.equal(reconcileConsoleIfChanged(config,[file],new Set()),false);
});

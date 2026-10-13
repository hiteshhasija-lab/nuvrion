const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {browseHostMedia,isoCatalog,isoLibrary,mergeMediaInventory,parseVmxHardware,updateCdDvdMedia}=require('../src/agent-service.cjs');

test('desktop media helper releases the VM keyboard before opening settings',()=>{
  const helper=fs.readFileSync('deploy/workstation-agent/workstation-ui-media.ps1','utf8');
  assert.match(helper,/public static void ReleaseVmInput\(\)/);
  assert.match(helper,/ReleaseVmInput\(\)[\s\S]{0,180}SendCtrlD\(\)/);
  assert.match(helper,/public static void SendVmSettingsMenu\(\)/);
  assert.match(helper,/ReleaseVmInput\(\)[\s\S]{0,180}SendVmSettingsMenu\(\)/);
});

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-workstation-media-')),vmRoot=path.join(root,'vms'),isoRoot=path.join(root,'isos');
  fs.mkdirSync(vmRoot);fs.mkdirSync(isoRoot);
  const vmxPath=path.join(vmRoot,'Lab.vmx'),isoPath=path.join(isoRoot,'tools.iso'),vmrunPath=path.join(root,'vmrun');
  fs.writeFileSync(vmxPath,'displayName = "Lab"\nsata0:1.present = "TRUE"\nsata0:1.deviceType = "cdrom-raw"\nsata0:1.fileName = "auto detect"\nsata0:1.startConnected = "FALSE"\n');
  fs.writeFileSync(isoPath,'test ISO fixture');
  fs.writeFileSync(vmrunPath,'#!/bin/sh\necho "Total running VMs: 0"\n');
  fs.chmodSync(vmrunPath,0o755);
  return {root,vmRoot,isoRoot,vmxPath,isoPath,vmrunPath,config:{vmSearchRoots:[vmRoot],isoSearchRoots:[isoRoot],vmrunPath}};
}

test('Workstation media catalog is bounded to authorized ISO folders',()=>{
  const item=fixture(),outside=path.join(item.root,'outside.iso');fs.writeFileSync(outside,'outside');
  assert.deepEqual(isoCatalog(item.config),[item.isoPath]);
  const nested=path.join(item.isoRoot,'nested');fs.mkdirSync(nested);
  const library=isoLibrary({...item.config,isoSearchRoots:[item.isoRoot,path.join(item.root,'missing')]});
  assert.deepEqual(library.images,[item.isoPath]);
  assert.deepEqual(library.locations[0],{path:item.isoRoot,status:'available',folders:[item.isoRoot,nested],imageCount:1});
  assert.equal(library.locations[1].status,'missing');
});

test('Workstation host browser lists only folders and ISO files inside configured drives',()=>{
  const item=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-media-outside-'));
  fs.writeFileSync(path.join(item.root,'ignore.txt'),'not media');
  const config={...item.config,allowHostDriveBrowsing:true,hostDriveRoots:[item.root]};
  const roots=browseHostMedia(config,null),folder=browseHostMedia(config,item.root),isos=browseHostMedia(config,item.isoRoot);
  assert.deepEqual(roots.directories,[{name:item.root,path:item.root}]);
  assert.deepEqual(folder.directories.map(entry=>entry.name),['isos','vms']);
  assert.deepEqual(folder.images,[]);
  assert.deepEqual(isos.images,[{name:'tools.iso',path:item.isoPath,sizeBytes:16}]);
  assert.equal(isos.parent,item.root);
  assert.throws(()=>browseHostMedia(config,outside),error=>error.code==='NUV_MEDIA_BROWSE_PATH_INVALID');
});

test('Workstation host browser allows mounting an ISO selected from a browsable drive',async()=>{
  const item=fixture(),outside=path.join(item.root,'outside.iso');fs.writeFileSync(outside,'outside');
  const mounted=await updateCdDvdMedia({...item.config,allowHostDriveBrowsing:true,hostDriveRoots:[item.root]},'media.mount',{vmxPath:item.vmxPath,driveId:'sata0:1',isoPath:outside});
  assert.equal(mounted.code,'NUV_MEDIA_MOUNTED');
  assert.equal(mounted.drive.media,outside);
});

test('Workstation agent mounts and ejects media with final-state reconciliation',async()=>{
  const item=fixture(),mounted=await updateCdDvdMedia(item.config,'media.mount',{vmxPath:item.vmxPath,driveId:'sata0:1',isoPath:item.isoPath});
  assert.equal(mounted.code,'NUV_MEDIA_MOUNTED');assert.equal(mounted.drive.media,item.isoPath);assert.equal(mounted.drive.connected,true);
  const ejected=await updateCdDvdMedia(item.config,'media.eject',{vmxPath:item.vmxPath,driveId:'sata0:1'});
  assert.equal(ejected.code,'NUV_MEDIA_EJECTED');assert.equal(ejected.drive.media,null);assert.equal(ejected.drive.connected,false);
  const hardware=parseVmxHardware(fs.readFileSync(item.vmxPath,'utf8'),item.vmxPath);assert.equal(hardware.cdDvdDrives[0].media,null);
});
test('verified media state replaces the agent cached drive immediately',()=>{const drive={id:'sata0:1',media:'C:\\ISO\\new.iso',connected:true},inventory=mergeMediaInventory([{id:'C:\\VMs\\Lab.vmx',hardware:{cdDvdDrives:[{id:'sata0:1',media:'C:\\ISO\\old.iso',connected:true}]}}],'C:\\VMs\\Lab.vmx',{drive,drives:[drive]});assert.equal(inventory[0].hardware.cdDvdDrives[0].media,drive.media);});
test('verified media state can be reapplied over a stale in-flight inventory result',()=>{const drive={id:'sata0:1',media:'C:\\ISO\\new.iso',connected:true},stale=[{id:'C:\\VMs\\Lab.vmx',hardware:{cdDvdDrives:[{id:'sata0:1',media:'C:\\ISO\\old.iso',connected:true}]}}],reconciled=mergeMediaInventory(stale,'C:\\VMs\\Lab.vmx',{drive,drives:[drive]});assert.equal(reconciled[0].hardware.cdDvdDrives[0].media,'C:\\ISO\\new.iso');});

test('Workstation agent rejects media outside authorized folders and uses desktop control for running VMs',async()=>{
  const item=fixture(),outside=path.join(item.root,'outside.iso');fs.writeFileSync(outside,'outside');
  await assert.rejects(()=>updateCdDvdMedia(item.config,'media.mount',{vmxPath:item.vmxPath,driveId:'sata0:1',isoPath:outside}),error=>error.code==='NUV_MEDIA_PATH_INVALID');
  fs.writeFileSync(item.vmrunPath,`#!/bin/sh\necho "Total running VMs: 1"\necho "${item.vmxPath}"\n`);fs.chmodSync(item.vmrunPath,0o755);
  let request;
  const mounted=await updateCdDvdMedia({...item.config,uiMediaRunner:async value=>{request=value;return {status:'completed',durationMs:321,settingsClosed:true,timings:[{stage:'apply_settings',durationMs:80}]};}},'media.mount',{vmxPath:item.vmxPath,driveId:'sata0:1',isoPath:item.isoPath});
  assert.equal(request.vmName,'Lab');assert.equal(request.driveIndex,0);assert.equal(request.isoPath,item.isoPath);assert.equal(request.assisted,false);
  assert.equal(mounted.controlMode,'workstation_ui');assert.equal(mounted.requiresPowerOff,false);assert.equal(mounted.drive.media,item.isoPath);
  assert.deepEqual(mounted.automation,{durationMs:321,settingsClosed:true,timings:[{stage:'apply_settings',durationMs:80}]});
});

test('Workstation 26H1 uses native vmcli for live mount and eject',async()=>{
  const item=fixture();
  fs.writeFileSync(item.vmrunPath,`#!/bin/sh\necho "Total running VMs: 1"\necho "${item.vmxPath}"\n`);fs.chmodSync(item.vmrunPath,0o755);
  const calls=[],config={...item.config,vmcliRunner:async args=>{calls.push(args);return ''}};
  const mounted=await updateCdDvdMedia(config,'media.mount',{vmxPath:item.vmxPath,driveId:'sata0:1',isoPath:item.isoPath});
  assert.equal(mounted.controlMode,'vmcli');assert.equal(mounted.drive.media,item.isoPath);assert.equal(mounted.drive.connected,true);
  assert.deepEqual(calls,[
    ['Disk','ConnectionControl','sata0:1','disconnect',item.vmxPath],
    ['Disk','SetBackingInfo','sata0:1','cdrom_image',item.isoPath,'1',item.vmxPath],
    ['Disk','ConnectionControl','sata0:1','connect',item.vmxPath]
  ]);
  calls.length=0;
  const ejected=await updateCdDvdMedia(config,'media.eject',{vmxPath:item.vmxPath,driveId:'sata0:1'});
  assert.equal(ejected.controlMode,'vmcli');assert.equal(ejected.drive.media,null);assert.equal(ejected.drive.connected,false);
  assert.deepEqual(calls,[['Disk','ConnectionControl','sata0:1','disconnect',item.vmxPath]]);
});

test('live media does not hot-add an existing CD/DVD drive',async()=>{
  const item=fixture(),calls=[];
  await require('../src/agent-service.cjs').runVmcliMedia({...item.config,vmcliRunner:async args=>{calls.push(args)}},'media.mount',{vmxPath:item.vmxPath,driveId:'ide1:0',isoPath:item.isoPath});
  assert.equal(calls.some(args=>args.includes('SetPresent')),false);
});

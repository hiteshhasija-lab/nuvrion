const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parseVmxHardware,totalDiskCapacity}=require('../src/agent-service.cjs');

test('Workstation agent normalizes configured VM hardware and VMDK capacity',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-vmx-hardware-')),vmxPath=path.join(directory,'Lab.vmx'),vmdkPath=path.join(directory,'Lab.vmdk');
  fs.writeFileSync(vmdkPath,'# Disk DescriptorFile\nRW 41943040 SPARSE "Lab-s001.vmdk"\n');
  const hardware=parseVmxHardware(`
scsi0:0.present = "TRUE"
scsi0:0.fileName = "Lab.vmdk"
ethernet0.present = "TRUE"
ethernet0.virtualDev = "e1000e"
ethernet0.connectionType = "nat"
ethernet0.startConnected = "TRUE"
usb_xhci.present = "TRUE"
svga.present = "TRUE"
svga.vramSize = "16777216"
mks.enable3d = "TRUE"
ide1:0.present = "TRUE"
ide1:0.deviceType = "cdrom-image"
ide1:0.fileName = "C:\\ISO\\rhel9.iso"
sound.present = "TRUE"
`,vmxPath);
  assert.equal(hardware.source,'vmx');
  assert.equal(hardware.disks[0].capacityBytes,21474836480);
  assert.equal(totalDiskCapacity(hardware),21474836480);
  assert.equal(hardware.networkAdapters[0].network,'nat');
  assert.equal(hardware.usbControllers[0].type,'USB 3.x');
  assert.equal(hardware.videoCards[0].memoryBytes,16777216);
  assert.equal(hardware.cdDvdDrives[0].media,'C:\\ISO\\rhel9.iso');
  assert.equal(hardware.additionalDevices[0].label,'Sound card');
});

test('Workstation agent does not invent total storage when a disk capacity is unknown',()=>{
  const hardware=parseVmxHardware('scsi0:0.present = "TRUE"\nscsi0:0.fileName = "missing.vmdk"\n','C:\\VMs\\Lab.vmx');
  assert.equal(hardware.disks[0].capacityBytes,null);
  assert.equal(totalDiskCapacity(hardware),null);
});

test('Workstation discovery reads only a bounded VMDK descriptor prefix',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/agent-service.cjs'),'utf8');
  assert.match(source,/Math\.min\(fs\.fstatSync\(handle\)\.size,1024\*1024\)/);
  assert.doesNotMatch(source,/fs\.readFileSync\(target,\{encoding:'utf8'\}\)/);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const {dhcpLeaseHostName,friendlyGuestOs,guestHostName,normalizeGuestHostName,parseDetailedGuestData,parseDhcpLeaseHostName,parseNetbiosHostName,parseVmcliGuestInfo,parseVmcliToolsStatus,parseWindowsProcessMetrics,vmcliGuestMetadata,vmxVcpuCount}=require('../src/agent-service.cjs');

test('Workstation agent retains a cached NetBIOS guest hostname',async()=>{
  assert.equal(await guestHostName('10.0.0.27',{'10.0.0.27':'EXCHANGE2K'}),'EXCHANGE2K');
});

test('Workstation agent parses workstation and server NetBIOS registrations',()=>{
  assert.equal(parseNetbiosHostName('  EXCHANGE2K  <00>  UNIQUE      Registered\r\n  LAB  <00>  GROUP       Registered'),'EXCHANGE2K');
  assert.equal(parseNetbiosHostName('  FILESERVER   <20>  UNIQUE      Registered'),'FILESERVER');
});

test('Workstation agent reads a guest-supplied hostname from VMware DHCP leases by MAC address',()=>{
  const leases='lease 192.168.80.128 {\n  hardware ethernet 00:0c:29:bf:f3:82;\n  client-hostname "SHP02.lab.local";\n}\n';
  assert.equal(parseDhcpLeaseHostName(leases,['00:0C:29:BF:F3:82']),'SHP02');
  assert.equal(parseDhcpLeaseHostName(leases,['00:0C:29:00:00:00']),null);
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'nuvrion-dhcp-')),file=path.join(directory,'vmnetdhcp.leases');
  fs.writeFileSync(file,leases);
  assert.equal(dhcpLeaseHostName({dhcpLeasePaths:[file]},['00:0C:29:BF:F3:82']),'SHP02');
});

test('Workstation agent reads native VMware guest metadata without DNS substitution',()=>{
  const output=JSON.stringify({guest:{hostName:'EXCHANGE2K.lab.local',guestFullName:'Microsoft Windows Server 2016 Standard'}});
  assert.deepEqual(parseVmcliGuestInfo(output),{hostName:'EXCHANGE2K',guestOs:'Microsoft Windows Server 2016 Standard'});
  assert.equal(normalizeGuestHostName('172.0.0.3'),null);
  assert.equal(parseVmcliToolsStatus(JSON.stringify({toolsRunningStatus:'guestToolsRunning'})),'Running');
});

test('Workstation agent uses VMware detailed guest data when live metadata is unavailable',()=>{
  assert.deepEqual(parseDetailedGuestData("architecture='X86' bitness='64' prettyName='Windows Server 2019 Standard'"),{architecture:'X86',bitness:'64',prettyName:'Windows Server 2019 Standard'});
});

test('Workstation agent normalizes VMware Tools properties and VM process consumption',()=>{
  const properties=JSON.stringify([{name:'guestInfo.hostName',value:'SHP02.lab.local'},{name:'guestInfo.detailed.data',value:"prettyName='Windows Server 2019 Datacenter'"}]);
  assert.deepEqual(parseVmcliGuestInfo(properties),{hostName:'SHP02',guestOs:'Windows Server 2019 Datacenter'});
  assert.deepEqual(parseVmcliGuestInfo("guestInfo.hostName = SHP02.lab.local\nguestInfo.detailed.data = architecture='X86' prettyName='Windows Server 2019 Datacenter'"),{hostName:'SHP02',guestOs:'Windows Server 2019 Datacenter'});
  assert.equal(parseVmcliToolsStatus(JSON.stringify({status:1})),'Running');
  assert.equal(parseVmcliToolsStatus('1'),'Running');
  assert.equal(parseVmcliToolsStatus('0'),'Not running');
  const metrics=parseWindowsProcessMetrics(JSON.stringify({commandLine:'"C:\\Program Files\\VMware\\VMware Workstation\\vmware-vmx.exe" "C:\\VMs\\SHP02\\SHP02.vmx"',cpuPercent:12,hostClockMhz:4000,workingSetBytes:2147483648}));
  const metric=metrics.get(require('node:path').normalize('C:\\VMs\\SHP02\\SHP02.vmx').toLowerCase());
  assert.equal(metric.memoryUsedBytes,2147483648);
  assert.equal(metric.cpuUsageMhz,480);
});

test('Workstation agent accepts current GuestInfo names and VMware default CPU count',()=>{
  assert.deepEqual(parseVmcliGuestInfo(JSON.stringify({computerName:'VDI02.lab.local',guestDetailedData:"prettyName='Windows Server 2012 Standard'"})),{hostName:'VDI02',guestOs:'Windows Server 2012 Standard'});
  assert.equal(vmxVcpuCount('displayName = "VDI02"\n'),1);
  assert.equal(vmxVcpuCount('numvcpus = "4"\n'),4);
  assert.equal(vmxVcpuCount('numvcpus = "invalid"\n'),null);
  assert.equal(friendlyGuestOs('windows8srv-64'),'Microsoft Windows Server 2012 (64-bit)');
});

test('Workstation agent serializes vmcli guest queries and stops after complete native metadata',async()=>{
  let active=0,maxActive=0;
  const calls=[];
  const result=await vmcliGuestMetadata({vmrunPath:'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe',vmcliRunner:async args=>{calls.push(args);active+=1;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active-=1;if(args.includes('Tools'))return JSON.stringify({status:1});return JSON.stringify({guest:{hostName:'SHP02.lab.local',guestFullName:'Microsoft Windows Server 2019'}});}},'C:\\VMs\\SHP02\\SHP02.vmx','running');
  assert.equal(maxActive,1);
  assert.equal(calls.length,2);
  assert.deepEqual(result,{hostName:'SHP02',guestOs:'Microsoft Windows Server 2019',toolsStatus:'Running'});
});

test('Workstation agent serializes native guest queries across different VMs',async()=>{
  let active=0,maxActive=0;
  const config={vmrunPath:'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe',vmcliRunner:async args=>{active+=1;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active-=1;if(args.includes('Tools'))return '1';const vmx=args[0];return JSON.stringify({guest:{hostName:vmx.includes('SHP02')?'SHP02.lab.local':'EXCHANGE2K.lab.local',guestFullName:'Microsoft Windows Server'}});}};
  const [first,second]=await Promise.all([vmcliGuestMetadata(config,'C:\\VMs\\SHP02\\SHP02.vmx','running'),vmcliGuestMetadata(config,'C:\\VMs\\Exchange2K\\Exchange2K.vmx','running')]);
  assert.equal(maxActive,1);
  assert.equal(first.hostName,'SHP02');
  assert.equal(second.hostName,'EXCHANGE2K');
  assert.equal(first.toolsStatus,'Running');
});

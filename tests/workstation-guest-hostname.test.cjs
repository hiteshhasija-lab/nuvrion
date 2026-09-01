const test=require('node:test');
const assert=require('node:assert/strict');
const {guestHostName,parseNetbiosHostName}=require('../apps/workstation-agent/src/agent-service.cjs');

test('Workstation agent retains a cached NetBIOS guest hostname',async()=>{
  assert.equal(await guestHostName('10.0.0.27',{'10.0.0.27':'EXCHANGE2K'}),'EXCHANGE2K');
});

test('Workstation agent parses workstation and server NetBIOS registrations',()=>{
  assert.equal(parseNetbiosHostName('  EXCHANGE2K  <00>  UNIQUE      Registered\r\n  LAB  <00>  GROUP       Registered'),'EXCHANGE2K');
  assert.equal(parseNetbiosHostName('  FILESERVER   <20>  UNIQUE      Registered'),'FILESERVER');
});

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const script=fs.readFileSync('deploy/workstation-agent/verify-install.ps1','utf8');
// Comments and the help block are not behaviour: examine the code only.
const code=script.replace(/<#[\s\S]*?#>/,'').split('\n').filter(line=>!/^\s*#/.test(line)).join('\n');

test('the installation verifier is read-only: it has no command that changes the machine',()=>{
  for(const verb of ['Set-Content','Add-Content','Out-File','Remove-Item','New-Item','Copy-Item','Move-Item','Rename-Item','Stop-Process','Start-Process','Stop-ScheduledTask','Start-ScheduledTask','Register-ScheduledTask','Unregister-ScheduledTask','Set-ItemProperty','New-ItemProperty','Restart-Service','Stop-Service','Start-Service','Invoke-WebRequest','Invoke-RestMethod','schtasks']){
    assert.equal(code.includes(verb),false,`must not use ${verb}`);
  }
});

test('the verifier never prints the agent secret or the enrollment token, only whether they are present',()=>{
  const secretLines=code.split('\n').filter(l=>/\.secret\b/.test(l));
  assert.equal(secretLines.length,1,'the secret may be read in exactly one place');
  assert.match(secretLines[0],/IsNullOrEmpty\(\[string\]\$identity\.secret\)/);
  const tokenLines=code.split('\n').filter(l=>/enrollmentToken/.test(l));
  assert.ok(tokenLines.length>=1);
  for(const line of tokenLines)assert.match(line,/IsNullOrEmpty\(\[string\]\$bootstrap\.enrollmentToken\)/);
  // the only identity value that is shown is the agent id
  const shown=code.split('\n').filter(l=>/\$identity\.agentId/.test(l)&&/enrolled as agent/.test(l));
  assert.equal(shown.length,1);
});

test('the verifier fails with exit code 1 when any check failed and 0 when all passed',()=>{
  assert.match(code,/if\(\$failed\.Count -gt 0\)\{[\s\S]*?exit 1[\s\S]*?\}[\s\S]*?exit 0/);
  assert.match(code,/\$_\.Result -eq 'FAIL'/);
});

test('the verifier checks what a clean install must leave behind',()=>{
  for(const [name,pattern] of [
    ['executable','nuvrion-workstation-agent\\.exe'],['bootstrap','bootstrap\\.json'],['https url',"-like 'https://\\*'"],
    ['vmrun runs',"& \\$path list"],['enrollment','The agent is enrolled'],['token consumed','single-use enrollment token has been consumed'],
    ['start mode','startMode is set'],['scheduled task','Get-ScheduledTask -TaskName \\$TaskName'],['one process','Exactly one agent process is running'],
    ['restart after edit','started after bootstrap\\.json was last written'],['desktop session','not session 0'],
    ['inventory is fresh','agent\\.inventory'],['fatal errors','agent\\.fatal'],
  ]) assert.match(code,new RegExp(pattern),name);
  // a second launch exiting is normal and must not count as a fatal error
  assert.match(code,/Another Nuvrion Workstation Agent process is already running/);
});

test('the verifier is compatible with Windows PowerShell 5.1: no null-conditional or null-coalescing operators',()=>{
  assert.doesNotMatch(code,/\?\.|\?\?\s/);
  assert.doesNotMatch(code,/\bForEach-Object\s+-Parallel\b/);
});

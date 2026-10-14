<#
Verifies a finished Nuvrion Workstation Agent installation (a clean install or an upgrade).

Read-only: it changes nothing, and it never prints the agent's secret or the enrollment token.
Exit code 0 = every check passed, 1 = at least one failed. Windows PowerShell 5.1 or later.

  .\verify-install.ps1
  .\verify-install.ps1 -InstallDirectory 'D:\Nuvrion\WorkstationAgent' -LogFreshnessSeconds 300
#>
param(
  [string]$InstallDirectory='C:\Program Files\Nuvrion\WorkstationAgent',
  [string]$TaskName='NuvrionWorkstationAgent',
  [string]$CompanionTaskName='NuvrionWorkstationDesktopCompanion',
  [int]$LogFreshnessSeconds=180
)
$ErrorActionPreference='Stop'
$results=New-Object System.Collections.ArrayList
function Add-Result([string]$Name,[bool]$Ok,[string]$Detail){
  $status='FAIL'; if($Ok){$status='PASS'}
  [void]$results.Add([pscustomobject]@{Check=$Name;Result=$status;Detail=$Detail})
}
function Test-Step([string]$Name,[scriptblock]$Body){
  try{ & $Body }catch{ Add-Result $Name $false ('error: '+$_.Exception.Message) }
}

$exe=Join-Path $InstallDirectory 'nuvrion-workstation-agent.exe'
$bootstrapPath=Join-Path $InstallDirectory 'bootstrap.json'
$logPath=Join-Path $InstallDirectory 'agent.log'
$bootstrap=$null

Test-Step 'Install directory' {
  Add-Result 'Install directory exists' (Test-Path -LiteralPath $InstallDirectory) $InstallDirectory
}
Test-Step 'Executable' {
  $present=Test-Path -LiteralPath $exe
  $detail='missing'
  if($present){ $detail=('{0:N0} bytes, modified {1}' -f (Get-Item -LiteralPath $exe).Length,(Get-Item -LiteralPath $exe).LastWriteTime) }
  Add-Result 'Agent executable is present' $present $detail
}
Test-Step 'bootstrap.json' {
  if(-not (Test-Path -LiteralPath $bootstrapPath)){ Add-Result 'bootstrap.json is valid JSON' $false 'file is missing'; return }
  $script:bootstrap=Get-Content -Raw -LiteralPath $bootstrapPath | ConvertFrom-Json
  Add-Result 'bootstrap.json is valid JSON' $true 'parsed'
}
if($bootstrap){
  Test-Step 'apiUrl' {
    $url=[string]$bootstrap.apiUrl
    Add-Result 'apiUrl uses HTTPS' ($url -like 'https://*') $url
  }
  Test-Step 'vmrun' {
    $path=[string]$bootstrap.vmrunPath
    $exists=($path -ne '') -and (Test-Path -LiteralPath $path)
    Add-Result 'vmrun.exe exists at vmrunPath' $exists $path
    if($exists){
      $output=& $path list 2>&1
      Add-Result 'vmrun list runs' ($LASTEXITCODE -eq 0) (($output | Select-Object -First 1) -as [string])
    }
  }
  Test-Step 'CA certificate' {
    $path=[string]$bootstrap.caCertificatePath
    Add-Result 'CA certificate file exists' (($path -ne '') -and (Test-Path -LiteralPath $path)) $path
  }
  Test-Step 'search roots' {
    $roots=@($bootstrap.vmSearchRoots | Where-Object { $_ })
    Add-Result 'At least one VM search folder is configured' ($roots.Count -gt 0) ('{0} folder(s)' -f $roots.Count)
  }
  Test-Step 'enrollment' {
    $identity=$bootstrap.identity
    $enrolled=($null -ne $identity) -and (-not [string]::IsNullOrEmpty([string]$identity.agentId)) -and (-not [string]::IsNullOrEmpty([string]$identity.secret))
    # only the agent id is shown; the secret is checked for presence and never printed
    $detail='no identity: the agent has not enrolled'
    if($enrolled){ $detail=('enrolled as agent ' + [string]$identity.agentId) }
    Add-Result 'The agent is enrolled' $enrolled $detail
    $tokenGone=[string]::IsNullOrEmpty([string]$bootstrap.enrollmentToken)
    Add-Result 'The single-use enrollment token has been consumed' $tokenGone $(if($tokenGone){'no token left in bootstrap.json'}else{'an enrollment token is still stored'})
  }
  Test-Step 'startMode' {
    $mode=[string]$bootstrap.startMode
    $valid=($mode -eq 'gui') -or ($mode -eq 'nogui')
    $detail='setting absent: the agent starts VMs without a Workstation window'
    if($valid){ $detail=$mode }
    Add-Result 'startMode is set (gui or nogui)' $valid $detail
  }
}
Test-Step 'Scheduled task' {
  $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if($null -eq $task){ Add-Result "Scheduled task $TaskName exists" $false 'not found'; return }
  Add-Result "Scheduled task $TaskName exists" $true ('state ' + [string]$task.State)
  Add-Result "Scheduled task $TaskName is enabled" ([string]$task.State -ne 'Disabled') ([string]$task.State)
}
Test-Step 'Companion task' {
  $task=Get-ScheduledTask -TaskName $CompanionTaskName -ErrorAction SilentlyContinue
  Add-Result "Desktop companion task $CompanionTaskName exists" ($null -ne $task) $(if($task){'state ' + [string]$task.State}else{'not found'})
}
Test-Step 'Process' {
  $procs=@(Get-Process -Name 'nuvrion-workstation-agent' -ErrorAction SilentlyContinue)
  $detail='not running'
  if($procs.Count -gt 0){ $detail=('pid {0}, session {1}, started {2}' -f $procs[0].Id,$procs[0].SessionId,$procs[0].StartTime) }
  Add-Result 'Exactly one agent process is running' ($procs.Count -eq 1) $detail
  if($procs.Count -eq 1 -and (Test-Path -LiteralPath $bootstrapPath)){
    $started=$procs[0].StartTime; $edited=(Get-Item -LiteralPath $bootstrapPath).LastWriteTime
    Add-Result 'The running agent started after bootstrap.json was last written' ($started -ge $edited) ('process {0}, file {1}' -f $started,$edited)
  }
  if($procs.Count -eq 1){
    Add-Result 'The agent runs in an interactive desktop session (not session 0)' ($procs[0].SessionId -ne 0) ('session ' + $procs[0].SessionId)
  }
}
Test-Step 'Log' {
  if(-not (Test-Path -LiteralPath $logPath)){ Add-Result 'agent.log exists' $false 'file is missing'; return }
  $lines=@(Get-Content -LiteralPath $logPath -Tail 200)
  $events=@()
  foreach($line in $lines){
    try{ $events += ($line | ConvertFrom-Json) }catch{ }
  }
  $inventory=@($events | Where-Object { $_.event -eq 'agent.inventory' })
  $fresh=$false; $detail='no agent.inventory event in the last 200 lines'
  if($inventory.Count -gt 0){
    $last=[datetime]::Parse([string]$inventory[-1].time,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    $age=((Get-Date).ToUniversalTime()-$last).TotalSeconds
    $fresh=($age -le $LogFreshnessSeconds); $detail=('last inventory {0:N0} s ago (limit {1} s)' -f $age,$LogFreshnessSeconds)
  }
  Add-Result 'The agent is publishing inventory (agent.log)' $fresh $detail
  $fatal=@($events | Where-Object { $_.event -eq 'agent.fatal' -and ([string]$_.message) -notlike '*Another Nuvrion Workstation Agent process is already running*' })
  $fatalDetail='none in the last 200 lines'
  if($fatal.Count -gt 0){ $fatalDetail=([string]$fatal[-1].message) }
  Add-Result 'No fatal error in the recent log' ($fatal.Count -eq 0) $fatalDetail
}

$results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
$failed=@($results | Where-Object { $_.Result -eq 'FAIL' })
if($failed.Count -gt 0){
  Write-Host ('{0} of {1} checks FAILED.' -f $failed.Count,$results.Count) -ForegroundColor Red
  exit 1
}
Write-Host ('All {0} checks passed.' -f $results.Count) -ForegroundColor Green
exit 0

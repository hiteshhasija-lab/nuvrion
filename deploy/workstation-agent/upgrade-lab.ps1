param(
  [Parameter(Mandatory=$true)][string]$AgentExecutablePath,
  [string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",
  [string]$TaskName='NuvrionWorkstationAgent'
)
$ErrorActionPreference='Stop'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this script from PowerShell as Administrator.'}
$source=(Resolve-Path -LiteralPath $AgentExecutablePath).Path
$target=Join-Path $InstallDirectory 'nuvrion-workstation-agent.exe'
$sourceHelper=Join-Path (Split-Path -Parent $source) 'workstation-ui-media.ps1'
$targetHelper=Join-Path $InstallDirectory 'workstation-ui-media.ps1'
$sourceCompanion=Join-Path (Split-Path -Parent $source) 'workstation-desktop-companion.ps1'
$targetCompanion=Join-Path $InstallDirectory 'workstation-desktop-companion.ps1'
if(-not (Test-Path -LiteralPath $sourceHelper)){throw 'The Workstation live-media helper is missing from the upgrade package.'}
if(-not (Test-Path -LiteralPath $sourceCompanion)){throw 'The Workstation desktop companion is missing from the upgrade package.'}
if((Get-Item -LiteralPath $source).Length -lt 1MB){throw 'The Workstation Agent executable in this package is incomplete.'}
if(-not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'identity.json'))){throw 'The existing enrolled agent identity was not found.'}
$backup=$target+'.pre-console.bak'
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Disable-ScheduledTask -InputObject $task|Out-Null
Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'NuvrionWorkstationDesktopCompanion' -ErrorAction SilentlyContinue
schtasks.exe /End /TN $TaskName 2>$null|Out-Null
Start-Sleep -Seconds 1
$deadline=(Get-Date).AddSeconds(10)
do{
  $agentProcess=Get-CimInstance Win32_Process|Where-Object{
    ($_.ExecutablePath -and $_.ExecutablePath.Equals($target,[System.StringComparison]::OrdinalIgnoreCase)) -or
    $_.Name -eq 'nuvrion-workstation-agent.exe'
  }
  if(-not $agentProcess){break}
  $agentProcess|ForEach-Object{Invoke-CimMethod -InputObject $_ -MethodName Terminate|Out-Null}
  Start-Sleep -Milliseconds 500
}while((Get-Date)-lt $deadline)
if(Get-Process -Name 'nuvrion-workstation-agent' -ErrorAction SilentlyContinue){throw 'The existing agent process did not stop within 10 seconds.'}
Copy-Item -Force -LiteralPath $target -Destination $backup
try{
  $bootstrapPath=Join-Path $InstallDirectory 'bootstrap.json'
  $bootstrap=Get-Content -Raw -LiteralPath $bootstrapPath|ConvertFrom-Json
  if($null -eq $bootstrap.PSObject.Properties['autoConfigureConsole']){$bootstrap|Add-Member -NotePropertyName autoConfigureConsole -NotePropertyValue $true}
  if($null -eq $bootstrap.PSObject.Properties['consolePortRange']){$bootstrap|Add-Member -NotePropertyName consolePortRange -NotePropertyValue ([pscustomobject]@{start=5900;end=5999})}
  if($null -eq $bootstrap.PSObject.Properties['isoSearchRoots']){$bootstrap|Add-Member -NotePropertyName isoSearchRoots -NotePropertyValue @($bootstrap.vmSearchRoots)}
  $bootstrap|Add-Member -NotePropertyName allowHostDriveBrowsing -NotePropertyValue $true -Force
  $bootstrap|Add-Member -NotePropertyName uiMediaHelperPath -NotePropertyValue $targetHelper -Force
  $desktopMediaQueue=Join-Path $env:LOCALAPPDATA 'Nuvrion\WorkstationAgent\desktop-media'
  New-Item -ItemType Directory -Force -Path $desktopMediaQueue|Out-Null
  $bootstrap|Add-Member -NotePropertyName desktopMediaQueuePath -NotePropertyValue $desktopMediaQueue -Force
  $bootstrap|Add-Member -NotePropertyName pollIntervalMs -NotePropertyValue 5000 -Force
  $bootstrap|Add-Member -NotePropertyName metadataPollIntervalMs -NotePropertyValue 60000 -Force
  $bootstrap|Add-Member -NotePropertyName staticMetadataCacheMs -NotePropertyValue 300000 -Force
  $bootstrap|Add-Member -NotePropertyName guestMetadataCacheMs -NotePropertyValue 300000 -Force
  $bootstrap|Add-Member -NotePropertyName storageMetadataCacheMs -NotePropertyValue 300000 -Force
  $bootstrap|Add-Member -NotePropertyName commandPollIntervalMs -NotePropertyValue 500 -Force
  $bootstrap|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $bootstrapPath -Encoding UTF8
  Copy-Item -Force -LiteralPath $source -Destination $target
  Copy-Item -Force -LiteralPath $sourceHelper -Destination $targetHelper
  Copy-Item -Force -LiteralPath $sourceCompanion -Destination $targetCompanion
  $runAsUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$folder=$scheduler.GetFolder('\');$definition=$scheduler.NewTask(0)
  $definition.RegistrationInfo.Description='Nuvrion VMware Workstation interactive media companion';$definition.Settings.Enabled=$true;$definition.Settings.StartWhenAvailable=$true;$definition.Settings.ExecutionTimeLimit='PT0S';$definition.Settings.MultipleInstances=2
  $definition.Principal.UserId=$runAsUser;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=1
  $trigger=$definition.Triggers.Create(9);$trigger.Enabled=$true;$trigger.UserId=$runAsUser
  $action=$definition.Actions.Create(0);$action.Path=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');$action.Arguments='-NoLogo -NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$targetCompanion+'" -InstallDirectory "'+$InstallDirectory+'" -QueueDirectory "'+$desktopMediaQueue+'"'
  $companionTask=$folder.RegisterTaskDefinition('NuvrionWorkstationDesktopCompanion',$definition,6,$null,$null,3,$null);$null=$companionTask.Run($null)
  Enable-ScheduledTask -TaskName $TaskName|Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $startDeadline=(Get-Date).AddSeconds(15)
  do{
    Start-Sleep -Milliseconds 500
    $startedProcesses=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.Equals($target,[System.StringComparison]::OrdinalIgnoreCase)})
  }while($startedProcesses.Count -ne 1 -and (Get-Date)-lt $startDeadline)
  if((Get-ScheduledTask -TaskName $TaskName).State -eq 'Disabled'){throw 'The upgraded agent task remained disabled.'}
  if((Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult -notin 0,267009){throw 'The upgraded agent task did not start successfully.'}
  if($startedProcesses.Count -ne 1){throw "Expected exactly one Workstation Agent process after upgrade, but found $($startedProcesses.Count)."}
  Write-Output "Upgraded and restarted $TaskName. Exactly one agent process is running. Automatic console configuration is enabled for ports 5900 through 5999. Running VMs were not changed."
}catch{
  Get-Process -Name 'nuvrion-workstation-agent' -ErrorAction SilentlyContinue|Stop-Process -Force -ErrorAction SilentlyContinue
  Copy-Item -Force -LiteralPath $backup -Destination $target
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue|Out-Null
  Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  throw
}

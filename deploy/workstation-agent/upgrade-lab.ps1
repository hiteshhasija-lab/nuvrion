param(
  [Parameter(Mandatory=$true)][string]$AgentExecutablePath,
  [string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",
  [string]$TaskName='NuvrionWorkstationAgent'
)
$ErrorActionPreference='Stop'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this script from PowerShell as Administrator.'}
$source=(Resolve-Path -LiteralPath $AgentExecutablePath).Path
$target=Join-Path $InstallDirectory 'nuvrion-workstation-agent.exe'
if(-not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'identity.json'))){throw 'The existing enrolled agent identity was not found.'}
$backup=$target+'.pre-console.bak'
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskWasEnabled=$task.State -ne 'Disabled'
Disable-ScheduledTask -InputObject $task|Out-Null
Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
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
  if($null -eq $bootstrap.autoConfigureConsole){$bootstrap|Add-Member -NotePropertyName autoConfigureConsole -NotePropertyValue $true}
  if($null -eq $bootstrap.consolePortRange){$bootstrap|Add-Member -NotePropertyName consolePortRange -NotePropertyValue ([pscustomobject]@{start=5900;end=5999})}
  $bootstrap|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $bootstrapPath -Encoding UTF8
  Copy-Item -Force -LiteralPath $source -Destination $target
  if($taskWasEnabled){Enable-ScheduledTask -InputObject $task|Out-Null}
  Start-ScheduledTask -InputObject $task
  Start-Sleep -Seconds 3
  if((Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult -notin 0,267009){throw 'The upgraded agent task did not start successfully.'}
  Write-Output "Upgraded and restarted $TaskName. Automatic console configuration is enabled for ports 5900 through 5999. Running VMs were not changed."
}catch{
  Get-Process -Name 'nuvrion-workstation-agent' -ErrorAction SilentlyContinue|Stop-Process -Force -ErrorAction SilentlyContinue
  Copy-Item -Force -LiteralPath $backup -Destination $target
  if($taskWasEnabled){Enable-ScheduledTask -InputObject $task|Out-Null}
  Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  throw
}

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
schtasks.exe /End /TN $TaskName 2>$null|Out-Null
Start-Sleep -Seconds 2
Copy-Item -Force -LiteralPath $target -Destination $backup
try{
  Copy-Item -Force -LiteralPath $source -Destination $target
  $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Start-ScheduledTask -InputObject $task
  Start-Sleep -Seconds 3
  if((Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult -notin 0,267009){throw 'The upgraded agent task did not start successfully.'}
  Write-Output "Upgraded and restarted $TaskName. Existing enrollment and configuration were preserved."
}catch{
  Copy-Item -Force -LiteralPath $backup -Destination $target
  Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  throw
}

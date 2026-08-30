param([string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",[string]$ServiceName="NuvrionWorkstationAgent",[switch]$KeepConfiguration)
$ErrorActionPreference='Stop'
if(Get-Service $ServiceName -ErrorAction SilentlyContinue){Stop-Service $ServiceName -Force;sc.exe delete $ServiceName | Out-Null}
schtasks.exe /Query /TN $ServiceName 2>$null | Out-Null
if($LASTEXITCODE -eq 0){schtasks.exe /End /TN $ServiceName 2>$null | Out-Null;schtasks.exe /Delete /TN $ServiceName /F | Out-Null}
if(-not $KeepConfiguration -and (Test-Path $InstallDirectory)){Remove-Item -LiteralPath $InstallDirectory -Recurse -Force}
Write-Output "Uninstalled $ServiceName service or lab startup task. Revoke the agent record in Nuvrion if this endpoint is retired."

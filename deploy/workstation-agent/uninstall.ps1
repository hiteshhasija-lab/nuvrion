param([string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",[string]$ServiceName="NuvrionWorkstationAgent",[switch]$KeepConfiguration)
$ErrorActionPreference='Stop'
if(Get-Service $ServiceName -ErrorAction SilentlyContinue){Stop-Service $ServiceName -Force;sc.exe delete $ServiceName | Out-Null}
if(-not $KeepConfiguration -and (Test-Path $InstallDirectory)){Remove-Item -LiteralPath $InstallDirectory -Recurse -Force}
Write-Output "Uninstalled $ServiceName. Revoke the agent record in Nuvrion if this endpoint is retired."

param(
  [Parameter(Mandatory=$true)][string]$ApiUrl,
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",
  [string]$ServiceName="NuvrionWorkstationAgent"
)
$ErrorActionPreference='Stop'
if(-not $ApiUrl.StartsWith('https://')){throw 'ApiUrl must use HTTPS.'}
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
$acl=Get-Acl $InstallDirectory
$acl.SetAccessRuleProtection($true,$false)
$admins=New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow')
$system=New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($admins);$acl.SetAccessRule($system);Set-Acl $InstallDirectory $acl
$config=@{apiUrl=$ApiUrl;enrollmentToken=$EnrollmentToken;serviceName=$ServiceName}|ConvertTo-Json
$config|Set-Content -Encoding UTF8 -Path (Join-Path $InstallDirectory 'bootstrap.json')
$executable=Join-Path $InstallDirectory 'nuvrion-workstation-agent.exe'
if(-not (Test-Path $executable)){throw "Place the signed agent executable at $executable before installation."}
$signature=Get-AuthenticodeSignature -FilePath $executable
if($signature.Status -ne 'Valid'){throw "The Workstation Agent executable must have a valid Authenticode signature. Status: $($signature.Status)"}
sc.exe create $ServiceName binPath= "`"$executable`" --service" start= delayed-auto obj= "NT AUTHORITY\LocalService" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/none/0 | Out-Null
sc.exe description $ServiceName "Nuvrion VMware Workstation management agent" | Out-Null
Start-Service $ServiceName
Write-Output "Installed and started $ServiceName. The one-time enrollment token is consumed during first startup."

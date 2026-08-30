param(
  [Parameter(Mandatory=$true)][string]$ApiUrl,
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [Parameter(Mandatory=$true)][string]$AgentExecutablePath,
  [Parameter(Mandatory=$true)][string]$CaCertificatePath,
  [Parameter(Mandatory=$true)][string]$VmrunPath,
  [Parameter(Mandatory=$true)][string[]]$VmSearchRoots,
  [string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",
  [string]$ServiceName="NuvrionWorkstationAgent",
  [switch]$AllowUnsignedLabBuild
)
$ErrorActionPreference='Stop'
if(-not $ApiUrl.StartsWith('https://')){throw 'ApiUrl must use HTTPS.'}
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
$acl=Get-Acl $InstallDirectory
$acl.SetAccessRuleProtection($true,$false)
$admins=New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow')
$system=New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($admins);$acl.SetAccessRule($system);Set-Acl $InstallDirectory $acl
$caTarget=Join-Path $InstallDirectory 'nuvrion-lab-ca.crt'
Copy-Item -Force -LiteralPath $CaCertificatePath -Destination $caTarget
function ConvertTo-JsonString([string]$Value){
  if($null -eq $Value){return ''}
  return $Value.Replace('\','\\').Replace('"','\"').Replace("`r",'\r').Replace("`n",'\n').Replace("`t",'\t')
}
$rootsJson=(($VmSearchRoots|ForEach-Object{'"'+(ConvertTo-JsonString $_)+'"'}) -join ',')
$config='{"apiUrl":"'+(ConvertTo-JsonString $ApiUrl)+'","enrollmentToken":"'+(ConvertTo-JsonString $EnrollmentToken)+'","serviceName":"'+(ConvertTo-JsonString $ServiceName)+'","caCertificatePath":"'+(ConvertTo-JsonString $caTarget)+'","vmrunPath":"'+(ConvertTo-JsonString $VmrunPath)+'","vmSearchRoots":['+$rootsJson+'],"agentName":"'+(ConvertTo-JsonString $env:COMPUTERNAME)+'","pollIntervalMs":15000}'
$config|Set-Content -Encoding UTF8 -Path (Join-Path $InstallDirectory 'bootstrap.json')
$executable=Join-Path $InstallDirectory 'nuvrion-workstation-agent.exe'
if(-not (Test-Path $AgentExecutablePath)){throw "Agent executable was not found at $AgentExecutablePath"}
Copy-Item -Force -LiteralPath $AgentExecutablePath -Destination $executable
$signature=Get-AuthenticodeSignature -FilePath $executable
if($signature.Status -ne 'Valid' -and -not $AllowUnsignedLabBuild){throw "The Workstation Agent executable must have a valid Authenticode signature. Status: $($signature.Status)"}
if($signature.Status -ne 'Valid'){Write-Warning 'Installing an unsigned LAB-ONLY agent. Do not use this bypass in production.'}
if($AllowUnsignedLabBuild){
  $runAsUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $launcher=Join-Path $InstallDirectory 'launch-hidden.vbs'
  @"
Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "$executable" & Chr(34) & " --service", 0, True
"@ | Set-Content -Encoding ASCII -LiteralPath $launcher
  $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$folder=$scheduler.GetFolder('\');$definition=$scheduler.NewTask(0)
  $definition.RegistrationInfo.Description='Nuvrion VMware Workstation lab agent';$definition.Settings.Enabled=$true;$definition.Settings.StartWhenAvailable=$true;$definition.Settings.ExecutionTimeLimit='PT0S';$definition.Settings.RestartCount=3;$definition.Settings.RestartInterval='PT1M'
  $definition.Settings.MultipleInstances=2
  $definition.Principal.UserId=$runAsUser;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=1
  $trigger=$definition.Triggers.Create(9);$trigger.Enabled=$true;$trigger.UserId=$runAsUser;$action=$definition.Actions.Create(0);$action.Path=(Join-Path $env:SystemRoot 'System32\wscript.exe');$action.Arguments='"'+$launcher+'"'
  $task=$folder.RegisterTaskDefinition($ServiceName,$definition,6,$null,$null,3,$null);$null=$task.Run($null)
  Write-Output "Installed and started unsigned lab task $ServiceName under $runAsUser. It will start automatically when this user logs on."
}else{
  sc.exe create $ServiceName binPath= "`"$executable`" --service" start= delayed-auto obj= "NT AUTHORITY\LocalService" | Out-Null
  sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/none/0 | Out-Null
  sc.exe description $ServiceName "Nuvrion VMware Workstation management agent" | Out-Null
  Start-Service $ServiceName
  Write-Output "Installed and started $ServiceName. The one-time enrollment token is consumed during first startup."
}

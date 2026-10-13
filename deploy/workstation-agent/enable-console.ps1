param(
  [Parameter(Mandatory=$true)][string]$VmxPath,
  [ValidateRange(5901,5999)][int]$Port=0
)
$ErrorActionPreference='Stop'
$resolved=(Resolve-Path -LiteralPath $VmxPath).Path
if(-not $resolved.EndsWith('.vmx',[System.StringComparison]::OrdinalIgnoreCase)){throw 'VmxPath must identify a .vmx file.'}
$installDirectory=Join-Path $env:ProgramFiles 'Nuvrion\WorkstationAgent'
$bootstrap=Get-Content -Raw -LiteralPath (Join-Path $installDirectory 'bootstrap.json')|ConvertFrom-Json
if(-not (Test-Path -LiteralPath $bootstrap.vmrunPath)){throw 'The configured vmrun executable was not found.'}
$running=& $bootstrap.vmrunPath list
$runningPaths=@($running|Select-Object -Skip 1|ForEach-Object{$_.Trim()}|Where-Object{$_})
if($runningPaths|Where-Object{[System.IO.Path]::GetFullPath($_).Equals($resolved,[System.StringComparison]::OrdinalIgnoreCase)}){throw 'Power off this VM before enabling its embedded console.'}
if($Port -eq 0){
  $used=[System.Collections.Generic.HashSet[int]]::new()
  foreach($root in @($bootstrap.vmSearchRoots)){
    if(-not (Test-Path -LiteralPath $root)){continue}
    Get-ChildItem -LiteralPath $root -Filter *.vmx -Recurse -ErrorAction SilentlyContinue|ForEach-Object{
      $match=[regex]::Match((Get-Content -Raw -LiteralPath $_.FullName),'(?im)^\s*RemoteDisplay\.vnc\.port\s*=\s*"(\d+)"')
      if($match.Success){$null=$used.Add([int]$match.Groups[1].Value)}
    }
  }
  $listeners=[System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
  $Port=5901..5999|Where-Object{-not $used.Contains($_) -and $listeners -notcontains $_}|Select-Object -First 1
  if(-not $Port){throw 'No available Workstation console port was found from 5901 through 5999.'}
}
$text=[System.IO.File]::ReadAllText($resolved)
function Set-VmxValue([string]$InputText,[string]$Name,[string]$Value){
  $pattern='(?im)^\s*'+[regex]::Escape($Name)+'\s*=\s*"[^"]*"\s*$'
  $line=$Name+' = "'+$Value+'"'
  if([regex]::IsMatch($InputText,$pattern)){return [regex]::Replace($InputText,$pattern,$line)}
  return $InputText.TrimEnd()+[Environment]::NewLine+$line+[Environment]::NewLine
}
$backup=$resolved+'.nuvrion-console.bak'
Copy-Item -Force -LiteralPath $resolved -Destination $backup
$text=Set-VmxValue $text 'RemoteDisplay.vnc.enabled' 'TRUE'
$text=Set-VmxValue $text 'RemoteDisplay.vnc.port' ([string]$Port)
[System.IO.File]::WriteAllText($resolved,$text,(New-Object System.Text.UTF8Encoding($false)))
Write-Output "Enabled the Nuvrion embedded console for $resolved on local VNC port $Port."
Write-Output "Backup: $backup"
Write-Output 'Start the VM, wait for the next agent heartbeat, then use Console in Nuvrion.'

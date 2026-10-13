param(
  [string]$InstallDirectory="$env:ProgramFiles\Nuvrion\WorkstationAgent",
  [string]$QueueDirectory="$env:LOCALAPPDATA\Nuvrion\WorkstationAgent\desktop-media"
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$created=$false
$mutex=[Threading.Mutex]::new($true,'Local\NuvrionWorkstationDesktopCompanion',[ref]$created)
if(-not $created){exit 0}
$helper=Join-Path $InstallDirectory 'workstation-ui-media.ps1'
New-Item -ItemType Directory -Force -Path $QueueDirectory|Out-Null

$icon=New-Object Windows.Forms.NotifyIcon
$icon.Icon=[Drawing.SystemIcons]::Application
$icon.Text='Nuvrion Workstation Desktop Companion'
$icon.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip
$statusItem=$menu.Items.Add('Nuvrion media companion is ready')
$statusItem.Enabled=$false
$exitItem=$menu.Items.Add('Exit')
$script:keepRunning=$true
$exitItem.Add_Click({$script:keepRunning=$false})
$icon.ContextMenuStrip=$menu

function Write-Response([string]$Path,[object]$Value){
  $temporary=$Path+'.tmp'
  $Value|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -Force -LiteralPath $temporary -Destination $Path
}
function Process-Request([IO.FileInfo]$File){
  $request=$null
  try{
    $request=Get-Content -Raw -LiteralPath $File.FullName|ConvertFrom-Json
    if($request.id -notmatch '^[0-9a-f-]{36}$'){throw 'The desktop media request identifier is invalid.'}
    if($request.operation -notin @('mount','eject')){throw 'The desktop media operation is invalid.'}
    if(-not (Test-Path -LiteralPath $helper -PathType Leaf)){throw 'The VMware media helper is not installed.'}
    $arguments=@('-NoLogo','-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',$helper,'-VmxPath',[string]$request.vmxPath,'-VmName',[string]$request.vmName,'-DriveId',[string]$request.driveId,'-DriveIndex',[string]$request.driveIndex,'-VmwarePath',[string]$request.vmwarePath,'-Operation',[string]$request.operation)
    if($request.operation -eq 'mount'){$arguments+=@('-IsoPath',[string]$request.isoPath)}
    $output=@(& powershell.exe @arguments 2>&1)
    if($LASTEXITCODE -ne 0){throw (($output|ForEach-Object{[string]$_}) -join "`n")}
    $result=($output|Select-Object -Last 1)|ConvertFrom-Json
    Write-Response (Join-Path $QueueDirectory ($request.id+'.response.json')) ([pscustomobject]@{status='completed';result=$result})
    $icon.ShowBalloonTip(2500,'Nuvrion',$(if($request.operation -eq 'mount'){'ISO image mounted.'}else{'CD/DVD media ejected.'}),[Windows.Forms.ToolTipIcon]::Info)
  }catch{
    $id=if($request -and $request.id -match '^[0-9a-f-]{36}$'){$request.id}else{[IO.Path]::GetFileName($File.Name).Split('.')[0]}
    Write-Response (Join-Path $QueueDirectory ($id+'.response.json')) ([pscustomobject]@{status='failed';code='NUV_MEDIA_UI_AUTOMATION_FAILED';message=$_.Exception.Message})
    $icon.ShowBalloonTip(3500,'Nuvrion media change failed',$_.Exception.Message,[Windows.Forms.ToolTipIcon]::Error)
  }finally{
    Remove-Item -Force -LiteralPath $File.FullName -ErrorAction SilentlyContinue
  }
}

try{
  $lastReady=[DateTime]::MinValue
  while($script:keepRunning){
    [Windows.Forms.Application]::DoEvents()
    if(((Get-Date)-$lastReady).TotalSeconds -ge 2){
      [pscustomobject]@{processId=$PID;sessionId=(Get-Process -Id $PID).SessionId;observedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $QueueDirectory 'ready.json') -Encoding UTF8
      $lastReady=Get-Date
    }
    foreach($file in @(Get-ChildItem -LiteralPath $QueueDirectory -Filter '*.request.json' -File -ErrorAction SilentlyContinue|Sort-Object CreationTime)){Process-Request $file}
    Start-Sleep -Milliseconds 150
  }
}finally{
  $icon.Visible=$false
  $icon.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}

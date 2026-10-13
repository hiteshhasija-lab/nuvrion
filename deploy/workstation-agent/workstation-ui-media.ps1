param(
  [Parameter(Mandatory=$true)][string]$VmxPath,
  [Parameter(Mandatory=$true)][string]$VmName,
  [Parameter(Mandatory=$true)][string]$DriveId,
  [int]$DriveIndex=0,
  [Parameter(Mandatory=$true)][string]$VmwarePath,
  [Parameter(Mandatory=$true)][ValidateSet('mount','eject','assist-mount','assist-eject')][string]$Operation,
  [string]$IsoPath=''
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NuvrionDesktopWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public static bool Activate(IntPtr handle) {
    if (handle == IntPtr.Zero) return false;
    IntPtr foreground = GetForegroundWindow();
    uint currentThread = GetCurrentThreadId();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
    uint targetThread = GetWindowThreadProcessId(handle, IntPtr.Zero);
    bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    bool attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread && AttachThreadInput(currentThread, targetThread, true);
    try {
      ShowWindowAsync(handle, 9);
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
      SetFocus(handle);
      return GetForegroundWindow() == handle;
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
  public static void SendCtrlD() {
    const uint KEYUP = 0x0002;
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x44, 0, 0, UIntPtr.Zero);
    keybd_event(0x44, 0, KEYUP, UIntPtr.Zero);
    keybd_event(0x11, 0, KEYUP, UIntPtr.Zero);
  }
  public static void ReleaseVmInput() {
    const uint KEYUP = 0x0002;
    // VMware Workstation captures the keyboard when its running VM display is
    // active. Ctrl+Alt releases that grab so the following shortcut is handled
    // by Workstation instead of being delivered to the guest.
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, KEYUP, UIntPtr.Zero);
    keybd_event(0x11, 0, KEYUP, UIntPtr.Zero);
  }
  public static void SendVmSettingsMenu() {
    const uint KEYUP = 0x0002;
    // Open the VM menu with its accelerator, then select Settings. This avoids
    // relying on VMware's Qt controls being exposed through UI Automation.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x4D, 0, 0, UIntPtr.Zero);
    keybd_event(0x4D, 0, KEYUP, UIntPtr.Zero);
    keybd_event(0x12, 0, KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(200);
    keybd_event(0x53, 0, 0, UIntPtr.Zero);
    keybd_event(0x53, 0, KEYUP, UIntPtr.Zero);
  }
  public static void Click(int x, int y) {
    const uint LEFTDOWN = 0x0002;
    const uint LEFTUP = 0x0004;
    SetCursorPos(x, y);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

function Find-All([System.Windows.Automation.AutomationElement]$Root,[System.Windows.Automation.ControlType]$Type){
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,$Type)
  return @($Root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition))
}
function Find-TopLevelWindows(){
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window)
  return @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition))
}
function Find-Named([System.Windows.Automation.AutomationElement]$Root,[System.Windows.Automation.ControlType]$Type,[string[]]$Names,[switch]$Contains){
  foreach($item in (Find-All $Root $Type)){
    $name=$item.Current.Name
    foreach($expected in $Names){
      if(($Contains -and $name -like "*$expected*") -or (-not $Contains -and $name -eq $expected)){return $item}
    }
  }
  return $null
}
function Invoke-Control([System.Windows.Automation.AutomationElement]$Element){
  if(-not $Element){return $false}
  $pattern=$null
  try{if($Element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return $true}}catch{}
  try{
    $pattern=$null
    if($Element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){
      if($pattern.Current.IsSelected){return $true}
      $pattern.Select();return $true
    }
  }catch{}
  try{
    $pattern=$null
    if($Element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){
      if($pattern.Current.ExpandCollapseState -ne [Windows.Automation.ExpandCollapseState]::Expanded){$pattern.Expand()}
      return $true
    }
  }catch{}
  return $false
}
function Set-ControlValue([System.Windows.Automation.AutomationElement]$Element,[string]$Value){
  if(-not $Element -or -not $Element.Current.IsEnabled){return $false}
  try{
    $pattern=$null
    if($Element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$pattern.SetValue($Value);return $true}
  }catch{return $false}
  return $false
}
function Set-Toggle([System.Windows.Automation.AutomationElement]$Element,[bool]$Enabled){
  if(-not $Element){return $false}
  $pattern=$null
  if($Element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){
    $isOn=$pattern.Current.ToggleState -eq [Windows.Automation.ToggleState]::On
    if($isOn -ne $Enabled){$pattern.Toggle()}
    return $true
  }
  return $false
}
function Click-Control([System.Windows.Automation.AutomationElement]$Element){
  if(-not $Element){return $false}
  try{
    $bounds=$Element.Current.BoundingRectangle
    if($bounds.IsEmpty -or $bounds.Width -lt 1 -or $bounds.Height -lt 1){return $false}
    [NuvrionDesktopWindow]::Click([int]($bounds.Left+($bounds.Width/2)),[int]($bounds.Top+($bounds.Height/2)))
    return $true
  }catch{return $false}
}
function Wait-Window([int]$ProcessId,[string[]]$Names,[int]$TimeoutSeconds=12){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    foreach($window in (Find-TopLevelWindows)){
      if($window.Current.ProcessId -eq $ProcessId){
        foreach($name in $Names){if($window.Current.Name -like "*$name*"){return $window}}
      }
    }
    Start-Sleep -Milliseconds 150
  }while((Get-Date)-lt $deadline)
  return $null
}
function Wait-WindowClosed([int]$ProcessId,[string[]]$Names,[int]$TimeoutSeconds=4){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    $found=$false
    foreach($window in (Find-TopLevelWindows)){
      if($window.Current.ProcessId -ne $ProcessId){continue}
      foreach($name in $Names){if($window.Current.Name -like "*$name*"){$found=$true;break}}
      if($found){break}
    }
    if(-not $found){return $true}
    Start-Sleep -Milliseconds 75
  }while((Get-Date)-lt $deadline)
  return $false
}
function Test-VmwareProcess([int]$ProcessId){
  try{return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName -like 'vmware*'}catch{return $false}
}
function Wait-VmwareWindow([string[]]$Names,[int]$TimeoutSeconds=12){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    foreach($window in (Find-TopLevelWindows)){
      if(-not (Test-VmwareProcess $window.Current.ProcessId)){continue}
      foreach($name in $Names){if($window.Current.Name -like "*$name*"){return $window}}
    }
    Start-Sleep -Milliseconds 125
  }while((Get-Date)-lt $deadline)
  return $null
}
function Wait-VmwareWindowClosed([string[]]$Names,[int]$TimeoutSeconds=4){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    $found=$false
    foreach($window in (Find-TopLevelWindows)){
      if(-not (Test-VmwareProcess $window.Current.ProcessId)){continue}
      foreach($name in $Names){if($window.Current.Name -like "*$name*"){$found=$true;break}}
      if($found){break}
    }
    if(-not $found){return $true}
    Start-Sleep -Milliseconds 75
  }while((Get-Date)-lt $deadline)
  return $false
}
function Find-VmTab([System.Windows.Automation.AutomationElement]$Root,[string]$Name){
  return Find-Named $Root ([Windows.Automation.ControlType]::TabItem) @($Name,[IO.Path]::GetFileNameWithoutExtension($VmxPath)) -Contains
}
function Select-VmTab([System.Windows.Automation.AutomationElement]$Tab){
  try{
    Invoke-Control $Tab|Out-Null
    $Tab.SetFocus()
    $bounds=$Tab.Current.BoundingRectangle
    if(-not $bounds.IsEmpty){[NuvrionDesktopWindow]::Click([int]($bounds.Left+($bounds.Width/2)),[int]($bounds.Top+($bounds.Height/2)))}
    Start-Sleep -Milliseconds 175
    return $true
  }catch{return $false}
}
function Find-VmWindow([string]$Name){
  $processes=@{}
  foreach($candidateProcess in (Get-Process -Name vmware -ErrorAction SilentlyContinue)){$processes[[int]$candidateProcess.Id]=$candidateProcess}
  foreach($candidateRoot in (Find-TopLevelWindows)){
    try{
      $candidateProcessId=[int]$candidateRoot.Current.ProcessId
      if(-not $processes.ContainsKey($candidateProcessId)){continue}
      $candidateTab=Find-VmTab $candidateRoot $Name
      $candidateHandle=[IntPtr]$candidateRoot.Current.NativeWindowHandle
      if($candidateHandle -eq [IntPtr]::Zero){$candidateHandle=$processes[$candidateProcessId].MainWindowHandle}
      if($candidateTab){return [pscustomobject]@{Process=$processes[$candidateProcessId];Root=$candidateRoot;Tab=$candidateTab;Handle=$candidateHandle}}
      if($candidateRoot.Current.Name -like "*$Name*"){return [pscustomobject]@{Process=$processes[$candidateProcessId];Root=$candidateRoot;Tab=$null;Handle=$candidateHandle}}
    }catch{}
  }
  return $null
}
function Wait-VmWindow([string]$Name,[int]$TimeoutSeconds=12){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    $candidate=Find-VmWindow $Name
    if($candidate){return $candidate}
    Start-Sleep -Milliseconds 150
  }while((Get-Date)-lt $deadline)
  return $null
}
function Select-Tab([System.Windows.Automation.AutomationElement]$Root,[string]$Name){
  $candidate=Find-VmTab $Root $Name
  if(-not $candidate){throw "The VMware Workstation tab for '$Name' was not found."}
  if(-not (Invoke-Control $candidate)){throw "The VMware Workstation tab for '$Name' could not be selected."}
}
function Wait-VmTab([System.Windows.Automation.AutomationElement]$Root,[string]$Name,[int]$TimeoutSeconds=8){
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{
    $candidate=Find-VmTab $Root $Name
    if($candidate){return $candidate}
    Start-Sleep -Milliseconds 150
  }while((Get-Date)-lt $deadline)
  return $null
}
function Find-ProcessNamed([int]$ProcessId,[System.Windows.Automation.ControlType]$Type,[string[]]$Names){
  foreach($item in (Find-All ([Windows.Automation.AutomationElement]::RootElement) $Type)){
    try{
      if($item.Current.ProcessId -ne $ProcessId){continue}
      foreach($name in $Names){if($item.Current.Name -like "*$name*"){return $item}}
    }catch{}
  }
  return $null
}
function Open-VmSettings([System.Windows.Automation.AutomationElement]$Root,[int]$ProcessId,[IntPtr]$Handle){
  $settingsNames=@('Virtual Machine Settings','Settings')
  $directNames=@('Edit virtual machine settings','Virtual Machine Settings')
  foreach($type in @([Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::Hyperlink,[Windows.Automation.ControlType]::MenuItem)){
    $direct=Find-Named $Root $type $directNames -Contains
    if($direct -and (Invoke-Control $direct)){
      $settings=Wait-VmwareWindow $settingsNames 3
      if($settings){return $settings}
    }
  }
  $vmMenu=Find-Named $Root ([Windows.Automation.ControlType]::MenuItem) @('VM') -Contains
  if($vmMenu){
    $opened=Click-Control $vmMenu
    if(-not $opened){$opened=Invoke-Control $vmMenu}
    if($opened){
      Start-Sleep -Milliseconds 300
      $settingsItem=Find-ProcessNamed $ProcessId ([Windows.Automation.ControlType]::MenuItem) @('Settings...','Settings…','Settings')
      if($settingsItem){
        $selected=Click-Control $settingsItem
        if(-not $selected){$selected=Invoke-Control $settingsItem}
        if($selected){
          $settings=Wait-VmwareWindow $settingsNames 4
          if($settings){return $settings}
        }
      }
    }
  }
  try{
    $shell=New-Object -ComObject WScript.Shell
    if($shell.AppActivate($ProcessId)){
      Start-Sleep -Milliseconds 175
      [NuvrionDesktopWindow]::ReleaseVmInput()
      Start-Sleep -Milliseconds 175
      $shell.SendKeys('^d')
      $settings=Wait-VmwareWindow $settingsNames 3
      if($settings){return $settings}
    }
  }catch{}
  try{$Root.SetFocus()}catch{}
  $activated=[NuvrionDesktopWindow]::Activate($Handle)
  Start-Sleep -Milliseconds 175
  [NuvrionDesktopWindow]::ReleaseVmInput()
  Start-Sleep -Milliseconds 175
  [NuvrionDesktopWindow]::SendCtrlD()
  $settings=Wait-VmwareWindow $settingsNames 3
  if($settings){return $settings}
  try{$Root.SetFocus()}catch{}
  $activated=[NuvrionDesktopWindow]::Activate($Handle) -or $activated
  Start-Sleep -Milliseconds 250
  [NuvrionDesktopWindow]::ReleaseVmInput()
  Start-Sleep -Milliseconds 175
  [Windows.Forms.SendKeys]::SendWait('^d')
  $settings=Wait-VmwareWindow $settingsNames 5
  if($settings){return $settings}
  try{$Root.SetFocus()}catch{}
  $activated=[NuvrionDesktopWindow]::Activate($Handle) -or $activated
  Start-Sleep -Milliseconds 250
  [NuvrionDesktopWindow]::ReleaseVmInput()
  Start-Sleep -Milliseconds 175
  [NuvrionDesktopWindow]::SendVmSettingsMenu()
  $settings=Wait-VmwareWindow $settingsNames 5
  if(-not $settings -and -not $activated){throw 'VMware Workstation rejected foreground activation in the signed-in desktop session.'}
  return $settings
}
function Get-VmwareDiagnostics([System.Windows.Automation.AutomationElement]$Root,[System.Windows.Automation.AutomationElement]$Tab,[IntPtr]$Handle){
  $windowName='unknown';try{$windowName=$Root.Current.Name}catch{}
  $tabName='not found';try{if($Tab){$tabName=$Tab.Current.Name}}catch{$tabName='unavailable'}
  $menuNames=@((Find-All $Root ([Windows.Automation.ControlType]::MenuItem))|ForEach-Object{$_.Current.Name}|Where-Object{$_}|Select-Object -First 20) -join ', '
  $foreground=[NuvrionDesktopWindow]::GetForegroundWindow()
  return "window='$windowName'; tab='$tabName'; targetHandle=$Handle; foregroundHandle=$foreground; menus=[$menuNames]"
}
function Add-Timing([System.Collections.Generic.List[object]]$Items,[string]$Stage,[Diagnostics.Stopwatch]$Clock,[long]$Previous){
  $elapsed=$Clock.ElapsedMilliseconds
  $Items.Add([pscustomobject]@{stage=$Stage;durationMs=$elapsed-$Previous})
  return $elapsed
}
function Select-Device([System.Windows.Automation.AutomationElement]$Dialog,[int]$Index){
  $candidates=@((Find-All $Dialog ([Windows.Automation.ControlType]::ListItem))|Where-Object{$_.Current.Name -like '*CD/DVD*'})
  if(-not $candidates.Count){$candidates=@((Find-All $Dialog ([Windows.Automation.ControlType]::TreeItem))|Where-Object{$_.Current.Name -like '*CD/DVD*'})}
  $candidate=if($Index -ge 0 -and $Index -lt $candidates.Count){$candidates[$Index]}else{$null}
  if(-not $candidate){throw 'The CD/DVD device was not found in Virtual Machine Settings.'}
  if(-not (Invoke-Control $candidate)){throw 'The CD/DVD device could not be selected.'}
  Start-Sleep -Milliseconds 250
}

if($Operation -in @('mount','assist-mount')){
  if(-not (Test-Path -LiteralPath $IsoPath -PathType Leaf)){throw 'The selected ISO image no longer exists.'}
  if([IO.Path]::GetExtension($IsoPath) -ne '.iso'){throw 'Select an ISO image.'}
}
if(-not (Test-Path -LiteralPath $VmwarePath -PathType Leaf)){throw 'VMware Workstation could not be found beside vmrun.exe.'}
if($Operation -in @('assist-mount','assist-eject')){
  if($Operation -eq 'assist-mount'){Set-Clipboard -Value $IsoPath}
  $openArguments='-t "'+$VmxPath.Replace('"','\"')+'"'
  Start-Process -FilePath $VmwarePath -ArgumentList $openArguments
  [pscustomobject]@{status='prepared';operation=$Operation;vmxPath=$VmxPath;driveId=$DriveId;isoPath=$(if($Operation -eq 'assist-mount'){$IsoPath}else{$null});clipboardReady=$Operation -eq 'assist-mount'}|ConvertTo-Json -Compress
  exit 0
}
$clock=[Diagnostics.Stopwatch]::StartNew()
$previous=0L
$timings=New-Object 'System.Collections.Generic.List[object]'
$window=Find-VmWindow $VmName
if(-not $window){
  $openArguments='-t "'+$VmxPath.Replace('"','\"')+'"'
  Start-Process -FilePath $VmwarePath -ArgumentList $openArguments
  $window=Wait-VmWindow $VmName
}
if(-not $window){$agentSession=(Get-Process -Id $PID).SessionId;$vmwareSessions=@(Get-Process -Name vmware -ErrorAction SilentlyContinue|ForEach-Object{$_.SessionId}|Sort-Object -Unique)-join ',';throw "The VMware Workstation window containing '$VmName' could not be opened in the signed-in Windows session. Agent session: $agentSession; VMware sessions: $vmwareSessions."}
$process=$window.Process
$root=$window.Root
$tab=$window.Tab
$previous=Add-Timing $timings 'workstation_window' $clock $previous
[NuvrionDesktopWindow]::ShowWindowAsync($window.Handle,9)|Out-Null
[NuvrionDesktopWindow]::SetForegroundWindow($window.Handle)|Out-Null
Start-Sleep -Milliseconds 125
if($tab -and -not (Select-VmTab $tab)){throw "The VMware Workstation tab for '$VmName' could not be selected."}
$previous=Add-Timing $timings 'select_vm' $clock $previous
$settings=Open-VmSettings $root $process.Id $window.Handle
if(-not $settings){throw ('VMware Workstation did not open Virtual Machine Settings. '+(Get-VmwareDiagnostics $root $tab $window.Handle))}
$previous=Add-Timing $timings 'open_settings' $clock $previous
Select-Device $settings $DriveIndex
$previous=Add-Timing $timings 'select_drive' $clock $previous

$connected=Find-Named $settings ([Windows.Automation.ControlType]::CheckBox) @('Connected')
if($Operation -eq 'eject'){
  if(-not (Set-Toggle $connected $false)){throw 'The CD/DVD Connected option could not be changed.'}
}else{
  $useIso=Find-Named $settings ([Windows.Automation.ControlType]::RadioButton) @('Use ISO image file') -Contains
  if(-not $useIso -or -not (Invoke-Control $useIso)){throw 'The ISO image option was not available in Virtual Machine Settings.'}
  Start-Sleep -Milliseconds 100
  $isoField=@((Find-All $settings ([Windows.Automation.ControlType]::Edit))|Where-Object{$_.Current.IsEnabled})|Select-Object -Last 1
  $pathEntered=Set-ControlValue $isoField $IsoPath
  if(-not $pathEntered){
    $browse=Find-Named $settings ([Windows.Automation.ControlType]::Button) @('Browse...','Browse')
    if(-not $browse -or -not (Invoke-Control $browse)){throw 'The ISO image path field and VMware Workstation ISO browser were unavailable.'}
    $picker=Wait-Window $process.Id @('Browse for ISO Image','Open')
    if(-not $picker){throw 'The VMware Workstation ISO file dialog did not open.'}
    $fileName=Find-Named $picker ([Windows.Automation.ControlType]::Edit) @('File name:','File name') -Contains
    if(-not $fileName){$fileName=(Find-All $picker ([Windows.Automation.ControlType]::Edit))|Select-Object -Last 1}
    if(-not (Set-ControlValue $fileName $IsoPath)){throw 'The ISO file path could not be entered.'}
    $open=Find-Named $picker ([Windows.Automation.ControlType]::Button) @('Open')
    if(-not $open -or -not (Invoke-Control $open)){throw 'The selected ISO image could not be confirmed.'}
    Start-Sleep -Milliseconds 250
  }
  if(-not (Set-Toggle $connected $true)){throw 'The CD/DVD Connected option could not be changed.'}
}
$previous=Add-Timing $timings 'change_media' $clock $previous
$ok=Find-Named $settings ([Windows.Automation.ControlType]::Button) @('OK')
if(-not $ok -or -not (Invoke-Control $ok)){throw 'Virtual Machine Settings could not be applied.'}
$settingsClosed=Wait-VmwareWindowClosed @('Virtual Machine Settings','Settings')
$previous=Add-Timing $timings 'apply_settings' $clock $previous
[pscustomobject]@{status='completed';operation=$Operation;vmxPath=$VmxPath;driveId=$DriveId;isoPath=$(if($Operation -eq 'mount'){$IsoPath}else{$null});durationMs=$clock.ElapsedMilliseconds;settingsClosed=$settingsClosed;timings=$timings}|ConvertTo-Json -Depth 4 -Compress

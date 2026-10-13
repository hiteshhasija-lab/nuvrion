$ErrorActionPreference='Stop'
$current=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'))
  exit
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$packageDirectory=Split-Path -Parent $PSCommandPath
$agentPath=Join-Path $packageDirectory 'nuvrion-workstation-agent.exe'
$installScript=Join-Path $packageDirectory 'install.ps1'
$upgradeScript=Join-Path $packageDirectory 'upgrade-lab.ps1'
$installDirectory=Join-Path $env:ProgramFiles 'Nuvrion\WorkstationAgent'
$existing=Test-Path (Join-Path $installDirectory 'identity.json')

$form=New-Object Windows.Forms.Form
$form.Text='Nuvrion Workstation Agent Setup'
$form.Size=New-Object Drawing.Size(720,590)
$form.MinimumSize=New-Object Drawing.Size(720,590)
$form.StartPosition='CenterScreen'
$form.BackColor=[Drawing.Color]::FromArgb(239,247,246)
$form.Font=New-Object Drawing.Font('Segoe UI',10)

$title=New-Object Windows.Forms.Label
$title.Text=if($existing){'Upgrade Nuvrion Workstation Agent'}else{'Install Nuvrion Workstation Agent'}
$title.Font=New-Object Drawing.Font('Segoe UI Semibold',18)
$title.ForeColor=[Drawing.Color]::FromArgb(10,79,74)
$title.Location=New-Object Drawing.Point(28,22)
$title.AutoSize=$true
$form.Controls.Add($title)

$subtitle=New-Object Windows.Forms.Label
$subtitle.Text=if($existing){'Your existing enrollment and connection settings will be preserved.'}else{'Connect this Windows system securely to your Nuvrion console.'}
$subtitle.ForeColor=[Drawing.Color]::FromArgb(66,87,91)
$subtitle.Location=New-Object Drawing.Point(31,62)
$subtitle.AutoSize=$true
$form.Controls.Add($subtitle)

function Add-Field([string]$label,[int]$top,[string]$value,[bool]$secret=$false){
  $caption=New-Object Windows.Forms.Label;$caption.Text=$label;$caption.Location=New-Object Drawing.Point(31,$top);$caption.AutoSize=$true;$form.Controls.Add($caption)
  $box=New-Object Windows.Forms.TextBox;$box.Location=New-Object Drawing.Point(31,($top+24));$box.Size=New-Object Drawing.Size(640,29);$box.Text=$value;$box.UseSystemPasswordChar=$secret;$form.Controls.Add($box);return $box
}
$api=Add-Field 'Nuvrion address' 100 'https://nuvrion.lab.sps'
$token=Add-Field ($(if($existing){'Enrollment token (not required for upgrade)'}else{'Enrollment token'})) 164 '' $true
$ca=Add-Field 'Nuvrion CA certificate' 228 (Join-Path $packageDirectory 'nuvrion-lab-ca.crt')
$vmrun=Add-Field 'VMware vmrun.exe' 292 'C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe'
$vmRoots=Add-Field 'VM folders (separate multiple folders with semicolons)' 356 'C:\Virtual Machines'
$isoRoots=Add-Field 'Authorized ISO folders (separate multiple folders with semicolons)' 420 'C:\ISO'
$isoRoots.Size=New-Object Drawing.Size(525,29)
$browseIso=New-Object Windows.Forms.Button
$browseIso.Text='Browse...';$browseIso.Location=New-Object Drawing.Point(566,444);$browseIso.Size=New-Object Drawing.Size(105,29)
$form.Controls.Add($browseIso)
$browseIso.Add_Click({
  $picker=New-Object Windows.Forms.FolderBrowserDialog
  $picker.Description='Select a folder containing ISO images'
  $picker.ShowNewFolderButton=$true
  if($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){
    $existingFolders=@($isoRoots.Text.Split(';')|ForEach-Object{$_.Trim()}|Where-Object{$_})
    if($existingFolders -notcontains $picker.SelectedPath){$isoRoots.Text=(@($existingFolders)+$picker.SelectedPath)-join ';'}
  }
})

if($existing){
  try{
    $saved=Get-Content -Raw -LiteralPath (Join-Path $installDirectory 'bootstrap.json')|ConvertFrom-Json
    if($saved.apiUrl){$api.Text=$saved.apiUrl}
    if($saved.caCertificatePath){$ca.Text=$saved.caCertificatePath}
    if($saved.vmrunPath){$vmrun.Text=$saved.vmrunPath}
    if($saved.vmSearchRoots){$vmRoots.Text=@($saved.vmSearchRoots)-join ';'}
    if($saved.isoSearchRoots){$isoRoots.Text=@($saved.isoSearchRoots)-join ';'}
  }catch{}
}

$status=New-Object Windows.Forms.Label
$status.Location=New-Object Drawing.Point(31,487);$status.Size=New-Object Drawing.Size(450,42);$status.ForeColor=[Drawing.Color]::FromArgb(66,87,91)
$form.Controls.Add($status)
$install=New-Object Windows.Forms.Button
$install.Text=if($existing){'Upgrade'}else{'Install'}
$install.Location=New-Object Drawing.Point(531,487);$install.Size=New-Object Drawing.Size(140,42)
$install.BackColor=[Drawing.Color]::FromArgb(22,150,139);$install.ForeColor=[Drawing.Color]::White;$install.FlatStyle='Flat'
$form.Controls.Add($install)

$install.Add_Click({
  $install.Enabled=$false;$status.Text='Applying the Workstation Agent configuration...';$form.Refresh()
  try{
    $roots=@($vmRoots.Text.Split(';')|ForEach-Object{$_.Trim()}|Where-Object{$_})
    $isos=@($isoRoots.Text.Split(';')|ForEach-Object{$_.Trim()}|Where-Object{$_})
    if(-not (Test-Path $agentPath)){throw 'The agent executable is missing from this setup package.'}
    foreach($requiredFile in @('install.ps1','upgrade-lab.ps1','workstation-ui-media.ps1','workstation-desktop-companion.ps1')){if(-not (Test-Path -LiteralPath (Join-Path $packageDirectory $requiredFile))){throw "The setup package is incomplete. Missing $requiredFile."}}
    if((Get-Item -LiteralPath $agentPath).Length -lt 1MB){throw 'The agent executable in this setup package is incomplete.'}
    if(-not $roots.Count){throw 'Enter at least one VM folder.'}
    if(-not $isos.Count){throw 'Enter at least one authorized ISO folder.'}
    if($existing){
      & $upgradeScript -AgentExecutablePath $agentPath
      $bootstrapPath=Join-Path $installDirectory 'bootstrap.json'
      $bootstrap=Get-Content -Raw -LiteralPath $bootstrapPath|ConvertFrom-Json
      $bootstrap|Add-Member -NotePropertyName vmSearchRoots -NotePropertyValue $roots -Force
      $bootstrap|Add-Member -NotePropertyName isoSearchRoots -NotePropertyValue $isos -Force
      $bootstrap|Add-Member -NotePropertyName allowHostDriveBrowsing -NotePropertyValue $true -Force
      $bootstrap|Add-Member -NotePropertyName pollIntervalMs -NotePropertyValue 5000 -Force
      $bootstrap|Add-Member -NotePropertyName metadataPollIntervalMs -NotePropertyValue 60000 -Force
      $bootstrap|Add-Member -NotePropertyName commandPollIntervalMs -NotePropertyValue 500 -Force
      $bootstrap|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $bootstrapPath -Encoding UTF8
      Stop-ScheduledTask -TaskName 'NuvrionWorkstationAgent' -ErrorAction SilentlyContinue
      Enable-ScheduledTask -TaskName 'NuvrionWorkstationAgent'|Out-Null
      Start-ScheduledTask -TaskName 'NuvrionWorkstationAgent'
    }else{
      if([string]::IsNullOrWhiteSpace($token.Text)){throw 'Enter the enrollment token generated by Nuvrion.'}
      if(-not (Test-Path $ca.Text)){throw 'Select the Nuvrion CA certificate.'}
      if(-not (Test-Path $vmrun.Text)){throw 'Select VMware Workstation vmrun.exe.'}
      & $installScript -ApiUrl $api.Text.TrimEnd('/') -EnrollmentToken $token.Text -AgentExecutablePath $agentPath -CaCertificatePath $ca.Text -VmrunPath $vmrun.Text -VmSearchRoots $roots -IsoSearchRoots $isos -AllowUnsignedLabBuild
    }
    $status.Text='Setup completed successfully.'
    [Windows.Forms.MessageBox]::Show('Nuvrion Workstation Agent is installed and running.','Nuvrion Setup','OK','Information')|Out-Null
    $form.Close()
  }catch{
    $status.Text='Setup could not be completed.'
    [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Nuvrion Setup','OK','Error')|Out-Null
    $install.Enabled=$true
  }
})
[void]$form.ShowDialog()

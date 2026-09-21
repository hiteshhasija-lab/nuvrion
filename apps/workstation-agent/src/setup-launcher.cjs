const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');

const script=path.join(path.dirname(process.execPath),'install-gui.ps1');
const logPath=path.join(os.tmpdir(),'Nuvrion-Setup.log');

function showError(message){
  const safe=String(message||'The setup wizard could not be opened.').replace(/'/g,"''");
  const command=`Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show('${safe}\n\nDetails: ${logPath.replace(/'/g,"''")}', 'Nuvrion Setup', 'OK', 'Error') | Out-Null`;
  const encoded=Buffer.from(command,'utf16le').toString('base64');
  const alert=spawn('powershell.exe',['-NoLogo','-NoProfile','-Sta','-EncodedCommand',encoded],{detached:true,windowsHide:true,stdio:'ignore'});
  alert.unref();
}

if(!fs.existsSync(script)){
  fs.writeFileSync(logPath,`Missing setup script: ${script}\r\n`);
  showError('The setup package is incomplete. Extract the entire ZIP before running Setup.exe.');
}else{
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-Sta','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let errorText='';
  child.stderr.on('data',chunk=>{if(errorText.length<32768)errorText+=String(chunk)});
  child.once('error',error=>{
    fs.writeFileSync(logPath,`${error.stack||error.message}\r\n`);
    showError('Windows could not start the Nuvrion setup wizard.');
  });
  child.once('close',code=>{
    if(code===0)return;
    fs.writeFileSync(logPath,errorText||`Setup exited with code ${code}.\r\n`);
    showError('The Nuvrion setup wizard closed unexpectedly.');
  });
}

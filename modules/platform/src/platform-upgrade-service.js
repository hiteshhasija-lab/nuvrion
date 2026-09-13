import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SHA256=/^[a-f0-9]{64}$/;
const UPLOAD_ID=/^[0-9a-f-]{36}$/;

async function readJson(path,fallback=null){try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')return fallback;throw error}}
async function atomicJson(path,value){const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});await rename(temporary,path)}

export class PlatformUpgradeService {
  constructor({root='/var/lib/nuvrion/upgrades',currentVersion='0.1.0',maxBytes=256*1024*1024}={}){
    this.root=root;this.currentVersion=currentVersion;this.maxBytes=maxBytes;
  }

  async initialize(){await mkdir(join(this.root,'staging'),{recursive:true,mode:0o700});await mkdir(join(this.root,'pending'),{recursive:true,mode:0o700});await mkdir(join(this.root,'status'),{recursive:true,mode:0o700})}

  async status(){
    await this.initialize();
    const helper=await stat(join(this.root,'.helper-ready')).then(()=>true).catch(()=>false);
    const status=await readJson(join(this.root,'status','current.json'),{state:'idle',message:'No platform update is in progress.',updatedAt:null});
    const staged=await readJson(join(this.root,'status','staged.json'),null);
    return {currentVersion:this.currentVersion,helperAvailable:helper,status,staged};
  }

  async stage(req,{sha256,fileName}){
    await this.initialize();
    const expected=String(sha256??'').trim().toLowerCase();
    if(!SHA256.test(expected))throw Object.assign(new Error('Enter the 64-character SHA-256 checksum supplied with the release.'),{code:'NUV_UPGRADE_CHECKSUM_REQUIRED',status:422});
    const safeName=basename(String(fileName??'Nuvrion-release.zip')).slice(0,160);
    if(!safeName.toLowerCase().endsWith('.zip'))throw Object.assign(new Error('Select a Nuvrion release ZIP file.'),{code:'NUV_UPGRADE_FILE_INVALID',status:422});
    const declared=Number(req.headers['content-length']??0);
    if(declared>this.maxBytes)throw Object.assign(new Error('The release bundle exceeds the 256 MB upload limit.'),{code:'NUV_UPGRADE_FILE_TOO_LARGE',status:413});
    const uploadId=randomUUID(),temporary=join(this.root,'staging',`${uploadId}.upload`),archivePath=join(this.root,'staging',`${uploadId}.zip`),hash=createHash('sha256');
    const output=createWriteStream(temporary,{flags:'wx',mode:0o600});let bytes=0;
    try{
      for await(const chunk of req){bytes+=chunk.length;if(bytes>this.maxBytes)throw Object.assign(new Error('The release bundle exceeds the 256 MB upload limit.'),{code:'NUV_UPGRADE_FILE_TOO_LARGE',status:413});hash.update(chunk);if(!output.write(chunk))await new Promise((resolve,reject)=>{output.once('drain',resolve);output.once('error',reject)})}
      await new Promise((resolve,reject)=>output.end(error=>error?reject(error):resolve()));
      if(!bytes)throw Object.assign(new Error('The selected release bundle is empty.'),{code:'NUV_UPGRADE_FILE_INVALID',status:422});
      const actual=hash.digest('hex');
      if(actual!==expected)throw Object.assign(new Error('The release checksum does not match. The upload was discarded.'),{code:'NUV_UPGRADE_CHECKSUM_MISMATCH',status:422});
      await rename(temporary,archivePath);
      const staged={uploadId,fileName:safeName,sha256:actual,sizeBytes:bytes,stagedAt:new Date().toISOString()};
      await atomicJson(join(this.root,'status','staged.json'),staged);
      await atomicJson(join(this.root,'status','current.json'),{state:'staged',message:'Release verified and ready to install.',updatedAt:staged.stagedAt,uploadId});
      return staged;
    }catch(error){output.destroy();await unlink(temporary).catch(()=>{});throw error}
  }

  async queue(uploadId){
    await this.initialize();
    if(!UPLOAD_ID.test(String(uploadId??'')))throw Object.assign(new Error('The staged release identifier is invalid.'),{code:'NUV_UPGRADE_STAGE_INVALID',status:422});
    const staged=await readJson(join(this.root,'status','staged.json'),null);
    if(!staged||staged.uploadId!==uploadId)throw Object.assign(new Error('The staged release is no longer available. Upload it again.'),{code:'NUV_UPGRADE_STAGE_NOT_FOUND',status:404});
    await stat(join(this.root,'staging',`${uploadId}.zip`)).catch(()=>{throw Object.assign(new Error('The staged release file is missing.'),{code:'NUV_UPGRADE_STAGE_NOT_FOUND',status:404})});
    const existing=await readJson(join(this.root,'pending','request.json'),null);
    if(existing)throw Object.assign(new Error('Another platform update is already queued.'),{code:'NUV_UPGRADE_IN_PROGRESS',status:409});
    const queuedAt=new Date().toISOString(),request={schemaVersion:1,uploadId,sha256:staged.sha256,fileName:staged.fileName,queuedAt};
    await atomicJson(join(this.root,'pending','request.json'),request);
    await atomicJson(join(this.root,'status','current.json'),{state:'queued',message:'Update queued for the RHEL9 upgrade helper.',updatedAt:queuedAt,uploadId});
    return request;
  }
}

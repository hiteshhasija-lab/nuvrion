import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {AgentUpgradeError} from './agent-upgrade-service.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Buffer.from(JSON.stringify(value));
const publicKeyBytes=value=>(value?.type==='public'?value:createPublicKey(value)).export({type:'spki',format:'der'});
const safePath=value=>{const path=String(value??'').replaceAll('\\','/');if(!path||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_PATH_INVALID','Package entries must use safe relative paths.');return path;};
const validTarget=(platform,architecture)=>['win32'].includes(platform)&&['x64','arm64'].includes(architecture);

export function createAgentPackage({version,platform,architecture,entries,privateKey,publicKey}){
  if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version??''))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_VERSION_INVALID','Package version must use semantic versioning.');
  if(!validTarget(platform,architecture))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_TARGET_INVALID','Package target is not supported.');
  const normalized=[...(entries??[])].map(entry=>{const path=safePath(entry.path),bytes=Buffer.from(entry.bytes);if(!bytes.length)throw new AgentUpgradeError('NUV_AGENT_PACKAGE_ENTRY_INVALID','Package entries cannot be empty.');return {path,mode:entry.mode??'0644',sizeBytes:bytes.length,sha256:digest(bytes),content:bytes.toString('base64')};}).sort((a,b)=>a.path.localeCompare(b.path));
  if(!normalized.length||new Set(normalized.map(entry=>entry.path)).size!==normalized.length)throw new AgentUpgradeError('NUV_AGENT_PACKAGE_ENTRY_INVALID','Package entries must be present and unique.');
  const signingKeyId=createHash('sha256').update(publicKeyBytes(publicKey)).digest('hex').slice(0,16),manifest={format:'nuvrion-agent-package/v1',version,platform,architecture,signingKeyId,files:normalized.map(({content,...file})=>file)};
  return {manifest,files:Object.fromEntries(normalized.map(entry=>[entry.path,entry.content])),signature:sign(null,canonical(manifest),privateKey).toString('base64url')};
}

export function verifyAgentPackage({bundle,trustedPublicKey,expectedPlatform,expectedArchitecture}){
  if(bundle?.manifest?.format!=='nuvrion-agent-package/v1'||!verify(null,canonical(bundle.manifest),trustedPublicKey,Buffer.from(bundle.signature??'','base64url')))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_SIGNATURE_INVALID','Agent package signature is invalid.');
  if(bundle.manifest.platform!==expectedPlatform||bundle.manifest.architecture!==expectedArchitecture)throw new AgentUpgradeError('NUV_AGENT_PACKAGE_TARGET_MISMATCH','Agent package does not match this operating system and architecture.');
  const paths=new Set();for(const file of bundle.manifest.files??[]){const path=safePath(file.path);if(paths.has(path))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_ENTRY_INVALID','Agent package contains duplicate paths.');paths.add(path);const bytes=Buffer.from(bundle.files?.[path]??'','base64');if(bytes.length!==file.sizeBytes||digest(bytes)!==file.sha256)throw new AgentUpgradeError('NUV_AGENT_PACKAGE_CONTENT_INVALID','Agent package content does not match its signed manifest.');}
  if(!paths.size||Object.keys(bundle.files??{}).some(path=>!paths.has(path)))throw new AgentUpgradeError('NUV_AGENT_PACKAGE_CONTENT_INVALID','Agent package contains unsigned or missing content.');
  return {verified:true,version:bundle.manifest.version,platform:bundle.manifest.platform,architecture:bundle.manifest.architecture,fileCount:paths.size};
}

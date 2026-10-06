import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const unquote=value=>value.replace(/^['"]|['"]$/g,'');
const byName=(a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`);
function packageIdentity(key){const clean=unquote(key).replace(/\(.+\)$/,'');const index=clean.lastIndexOf('@');if(index<=0)return null;return {name:clean.slice(0,index),version:clean.slice(index+1)};}

// npm: package-lock.json (lockfile v2/v3). Production components only: development-only entries are left out, optional ones are kept and marked.
export function parseNpmComponents(lockJson){
  const lock=typeof lockJson==='string'?JSON.parse(lockJson):lockJson;
  if(!lock?.packages||![2,3].includes(lock.lockfileVersion))throw new Error('NUV_SBOM_LOCKFILE_UNSUPPORTED');
  const components=[];
  for(const [path,entry] of Object.entries(lock.packages)){
    if(!path||entry.dev||entry.link)continue;
    const name=entry.name??path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length);
    components.push({name,version:entry.version,integrity:entry.integrity??null,optional:Boolean(entry.optional)});
  }
  return components.sort(byName);
}

// pnpm: pnpm-lock.yaml (lockfile 9).
export function parsePnpmComponents(lockText){const lines=String(lockText).split(/\r?\n/),components=[];let packages=false,current=null;for(const line of lines){if(line==='packages:'){packages=true;continue;}if(packages&&line==='snapshots:')break;if(!packages)continue;const entry=line.match(/^  (.+):$/);if(entry){const identity=packageIdentity(entry[1]);current=identity?{...identity,integrity:null}:null;if(current)components.push(current);continue;}const integrity=line.match(/^    resolution: \{integrity: ([^,}]+).*/);if(current&&integrity)current.integrity=unquote(integrity[1]);}return components.sort(byName);}

const isNpmLock=lockText=>{try{return Boolean(JSON.parse(lockText)?.lockfileVersion);}catch{return false;}};
const lockfileFormat=lockText=>isNpmLock(lockText)?`package-lock.json/v${JSON.parse(lockText).lockfileVersion}`:'pnpm-lock.yaml/9.0';

// CycloneDX wants hashes as hex; lockfiles carry them as "<algorithm>-<base64>" (Subresource Integrity).
function integrityHash(value){if(!value)return undefined;const index=value.indexOf('-');if(index<1)return undefined;const algorithm=value.slice(0,index).toUpperCase().replace('SHA','SHA-'),content=Buffer.from(value.slice(index+1),'base64').toString('hex');return content?{alg:algorithm,content}:undefined;}
const purl=(name,version)=>`pkg:npm/${name.startsWith('@')?`%40${name.slice(1)}`:name}@${version}`; // scoped names keep their '/', only '@' is encoded (package-url spec)
export function createCycloneDxSbom({lockText,packageJson,sourceRevision='uncommitted-workspace',generatedAt=new Date().toISOString()}){
  const dependencies=isNpmLock(lockText)?parseNpmComponents(lockText):parsePnpmComponents(lockText),
    components=dependencies.map(item=>{const digest=integrityHash(item.integrity);return {type:'library',name:item.name,version:item.version,'bom-ref':purl(item.name,item.version),purl:purl(item.name,item.version),...(item.optional?{scope:'optional'}:{}),...(digest?{hashes:[digest]}:{})};}),
    fingerprint=hash(Buffer.from(JSON.stringify(components))),
    uuid=`${fingerprint.slice(0,8)}-${fingerprint.slice(8,12)}-4${fingerprint.slice(13,16)}-a${fingerprint.slice(17,20)}-${fingerprint.slice(20,32)}`,
    root=`pkg:npm/${packageJson.name}@${packageJson.version}`,
    direct=Object.keys(packageJson.dependencies??{}).map(name=>components.find(item=>item.name===name)?.['bom-ref']).filter(Boolean).sort();
  return {bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:`urn:uuid:${uuid}`,version:1,metadata:{timestamp:generatedAt,component:{type:'application','bom-ref':root,name:packageJson.name,version:packageJson.version,purl:root},properties:[{name:'nuvrion:sourceRevision',value:sourceRevision},{name:'nuvrion:productionDependencyFingerprint',value:fingerprint},{name:'nuvrion:lockfileFormat',value:lockfileFormat(lockText)}]},components,dependencies:[{ref:root,dependsOn:direct}]};
}
export function verifyCycloneDxSbom({sbom,lockText,packageJson}){const rebuilt=createCycloneDxSbom({lockText,packageJson,sourceRevision:sbom?.metadata?.properties?.find(x=>x.name==='nuvrion:sourceRevision')?.value,generatedAt:sbom?.metadata?.timestamp}),expected=sbom?.metadata?.properties?.find(x=>x.name==='nuvrion:productionDependencyFingerprint')?.value;if(sbom?.bomFormat!=='CycloneDX'||sbom?.specVersion!=='1.6'||expected!==rebuilt.metadata.properties[1].value||JSON.stringify(sbom.components)!==JSON.stringify(rebuilt.components)||JSON.stringify(sbom.dependencies)!==JSON.stringify(rebuilt.dependencies))throw new Error('NUV_SBOM_VERIFICATION_FAILED');return {verified:true,componentCount:rebuilt.components.length,fingerprint:expected};}

import { randomUUID } from 'node:crypto';
import {keyringFromEnvironment,KeyringCipher} from '../../platform/src/keyring-cipher.js';
export class ConnectionService {
  #connections=new Map(); #secrets=new Map(); #diagnostics=new Map(); #key;
  constructor(options={}){this.#key=options.cipher??(options.masterKey?new KeyringCipher({activeKeyId:'legacy-local-key',keys:{'legacy-local-key':options.masterKey}}):keyringFromEnvironment(process.env,{production:false}));}
  #encrypt(value){const encrypted=this.#key.encrypt(value);return {...encrypted,nonce:encrypted.nonce.toString('base64url'),ciphertext:encrypted.ciphertext.toString('base64url'),tag:encrypted.tag.toString('base64url')};}
  #decrypt(secret){return this.#key.decrypt({...secret,nonce:Buffer.from(secret.nonce,'base64url'),ciphertext:Buffer.from(secret.ciphertext,'base64url'),tag:Buffer.from(secret.tag,'base64url')});}
  create({name,providerType,connectionType,endpointUri=null,credential,configuration={},createdBy}){
    if(!name?.trim()||!['vmware_vsphere','vmware_workstation','aws','azure'].includes(providerType)||!credential)throw new Error('CONNECTION_INVALID');
    const secretReferenceId=randomUUID();this.#secrets.set(secretReferenceId,this.#encrypt(credential));const now=new Date().toISOString();
    const c={id:randomUUID(),name:name.trim(),providerType,connectionType,endpointUri,secretReferenceId,configuration,status:'enabled',healthState:'unknown',lastSuccessAt:null,lastSyncAt:null,resourceCount:0,consecutiveFailures:0,lastErrorCode:null,nextRetryAt:null,rowVersion:1,createdBy,createdAt:now,updatedAt:now};this.#connections.set(c.id,c);return this.public(c);
  }
  list(){return [...this.#connections.values()].map(c=>this.public(c));}
  get(id){const c=this.#connections.get(id);return c?this.public(c):null;}
  replaceCredential(id,credential,expectedVersion){const c=this.#connections.get(id);if(!c)return null;if(c.rowVersion!==expectedVersion)throw new Error('VERSION_CONFLICT');this.#secrets.set(c.secretReferenceId,this.#encrypt(credential));c.rowVersion++;c.updatedAt=new Date().toISOString();return this.public(c);}
  resolveCredential(id){const c=this.#connections.get(id);return c?this.#decrypt(this.#secrets.get(c.secretReferenceId)):null;}
  recordSync(id,count){const c=this.#connections.get(id);if(c){c.lastSyncAt=new Date().toISOString();c.lastSuccessAt=c.lastSyncAt;c.healthState='healthy';c.resourceCount=count;c.consecutiveFailures=0;c.lastErrorCode=null;c.nextRetryAt=null;c.rowVersion++;c.updatedAt=c.lastSyncAt;}return c?this.public(c):null;}
  recordHealth(id,healthState){const c=this.#connections.get(id);if(c){c.healthState=healthState;c.lastSuccessAt=healthState==='healthy'?new Date().toISOString():c.lastSuccessAt;if(healthState==='healthy'){c.consecutiveFailures=0;c.lastErrorCode=null;c.nextRetryAt=null;}c.rowVersion++;c.updatedAt=new Date().toISOString();}return c?this.public(c):null;}
  recordFailure(id,errorCode,retryDelayMs=null){const c=this.#connections.get(id);if(c){c.consecutiveFailures++;c.lastErrorCode=errorCode;c.nextRetryAt=retryDelayMs==null?null:new Date(Date.now()+retryDelayMs).toISOString();c.healthState=c.consecutiveFailures>=3?'critical':'unhealthy';c.rowVersion++;c.updatedAt=new Date().toISOString();}return c?this.public(c):null;}
  recordDiagnostic(id,{checkType,outcome,errorCode=null,durationMs=0}){const event={id:randomUUID(),connectionId:id,checkType,outcome,errorCode,durationMs:Math.max(0,Math.round(durationMs)),checkedAt:new Date().toISOString()},items=this.#diagnostics.get(id)??[];items.unshift(event);this.#diagnostics.set(id,items.slice(0,100));return event;}
  diagnostics(id,limit=25){return (this.#diagnostics.get(id)??[]).slice(0,Math.min(100,Math.max(1,limit)));}
  public(c){const {secretReferenceId,...safe}=c;return {...safe,etag:`\"${c.rowVersion}\"`};}
}

import {randomUUID} from 'node:crypto';

export class WorkstationProviderError extends Error{
  constructor(code,message,{status=null,retryable=false}={}){super(message);this.code=code;this.status=status;this.retryable=retryable;}
}

export class WorkstationProvider{
  #references=new Map();
  constructor({endpointUri,credential,fetchImpl=fetch,timeoutMs=15000}){
    this.base=new URL(endpointUri);if(this.base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(this.base.hostname))throw new WorkstationProviderError('NUV_VMWARE_TLS_REQUIRED','VMware Workstation endpoints must use HTTPS.');
    this.base.pathname=this.base.pathname.replace(/\/$/,'');this.credential=credential;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async #request(path,{method='GET',body,expected=[200]}={}){
    const headers={accept:'application/vnd.vmware.vmw.rest-v1+json',authorization:`Basic ${Buffer.from(`${this.credential.username}:${this.credential.password}`).toString('base64')}`};if(body!==undefined)headers['content-type']='application/vnd.vmware.vmw.rest-v1+json';
    let response;try{response=await this.fetch(new URL(path,this.base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});}catch(error){throw new WorkstationProviderError('NUV_WORKSTATION_UNREACHABLE',error.message,{retryable:true});}
    if(!expected.includes(response.status)){let detail={};try{detail=await response.json();}catch{}const message=detail.message??detail.Message??`VMware Workstation API returned HTTP ${response.status}.`;const code=response.status===401?'NUV_WORKSTATION_AUTH_FAILED':response.status===403?'NUV_WORKSTATION_PERMISSION_DENIED':response.status===404?'NUV_WORKSTATION_RESOURCE_NOT_FOUND':response.status===409?'NUV_WORKSTATION_STATE_CONFLICT':response.status>=500?'NUV_WORKSTATION_UNAVAILABLE':'NUV_WORKSTATION_REQUEST_FAILED';throw new WorkstationProviderError(code,message,{status:response.status,retryable:response.status>=500});}
    if(response.status===204)return null;return response.json();
  }
  async testConnection(){await this.#request('/api/vms');return {status:'healthy',provider:'vmware_workstation',api:'VMware Workstation Pro REST API',capabilities:['inventory','power.start','power.stop','power.restart']};}
  async discover(){const vms=await this.#request('/api/vms');return Promise.all(vms.map(async vm=>{const id=vm.id??vm.vm;const [details,power]=await Promise.all([this.#request(`/api/vms/${encodeURIComponent(id)}`),this.#request(`/api/vms/${encodeURIComponent(id)}/power`)]);return {resourceType:'virtual_machine',nativeId:id,name:details.name??vm.name??this.#name(details.path??vm.path,id),healthState:'unknown',attributes:{powerState:this.#power(power.power_state??power.state),guestOs:details.guestOS??details.guest_os??null,vcpuCount:details.processors??details.cpu_count??null,memoryBytes:details.memory==null?null:Number(details.memory)*1048576,storageBytes:null,privateIps:[],publicIps:[],region:'local-workstation',availabilityZone:null,providerShape:null},providerMetadata:{path:details.path??vm.path??null,rawPowerState:power.power_state??power.state,settings:details}};}));}
  async execute(operation,nativeId){if(!['start','stop','restart'].includes(operation))throw new WorkstationProviderError('NUV_OPERATION_UNSUPPORTED',`Unsupported VMware Workstation operation: ${operation}`);if(operation==='restart')await this.#powerRequest(nativeId,'off');await this.#powerRequest(nativeId,operation==='stop'?'off':'on');const reference=`workstation:${randomUUID()}`;this.#references.set(reference,{nativeId,operation});return {providerReference:reference,operation,targetId:nativeId};}
  async verify(reference){const operation=this.#references.get(reference);if(!operation)throw new WorkstationProviderError('NUV_WORKSTATION_REFERENCE_INVALID','Provider operation reference is unknown.');try{const power=await this.#request(`/api/vms/${encodeURIComponent(operation.nativeId)}/power`),state=this.#power(power.power_state??power.state),expected=operation.operation==='stop'?'stopped':'running';if(state!==expected)throw new WorkstationProviderError('NUV_WORKSTATION_VERIFICATION_PENDING',`Expected ${expected}, observed ${state}.`,{retryable:true});return {code:'NUV_OPERATION_VERIFIED',summary:'VMware Workstation reported the requested final VM state.',providerReference:reference,observedFinalState:state};}finally{this.#references.delete(reference);}}
  #powerRequest(id,state){return this.#request(`/api/vms/${encodeURIComponent(id)}/power`,{method:'PUT',body:state});}
  #power(value){return ({poweredOn:'running',poweredOff:'stopped',paused:'suspended',suspended:'suspended'})[value]??String(value??'unknown').toLowerCase();}
  #name(path,id){const segment=String(path??'').split(/[\\/]/).pop();return segment?.replace(/\.vmx$/i,'')||id;}
}

export class WorkstationAgentProviderError extends Error {
  constructor(code,message,{retryable=false,status}={}) { super(message); this.code=code; this.retryable=retryable; this.status=status; }
}

const GUEST_OS_NAMES=new Map([
  ['dos','MS-DOS'],['win2000pro','Microsoft Windows 2000 Professional'],['win2000advserv','Microsoft Windows 2000 Advanced Server'],
  ['winnetenterprise','Microsoft Windows Server 2003 Enterprise'],['winxppro','Microsoft Windows XP Professional'],
  ['winxppro-64','Microsoft Windows XP Professional (64-bit)'],['windows7','Microsoft Windows 7'],
  ['windows7-64','Microsoft Windows 7 (64-bit)'],['windows8','Microsoft Windows 8'],['windows8-64','Microsoft Windows 8 (64-bit)'],
  ['windows9','Microsoft Windows 10'],['windows9-64','Microsoft Windows 10 (64-bit)'],
  ['windows8srv-64','Microsoft Windows Server 2012 (64-bit)'],['windows9srv-64','Microsoft Windows Server 2016 (64-bit)'],['windows2019srv-64','Microsoft Windows Server 2019 (64-bit)'],
  ['windows2022srvnext-64','Microsoft Windows Server 2022 (64-bit)'],['windows2022srv-64','Microsoft Windows Server 2022 (64-bit)'],
  ['windows11-64','Microsoft Windows 11 (64-bit)'],['vmkernel7','VMware ESXi 7.x'],['vmkernel8','VMware ESXi 8.x'],
  ['rhel9-64','Red Hat Enterprise Linux 9 (64-bit)'],
]);
const friendlyGuestOs=value=>value==null||String(value).trim()===''?null:(GUEST_OS_NAMES.get(String(value).trim().toLowerCase())??String(value).trim());
const versionAtLeast=(value,minimum)=>{const parse=input=>String(input??'').split(/[.-]/).slice(0,3).map(part=>Number(part)||0),a=parse(value),b=parse(minimum);return a[0]>b[0]||a[0]===b[0]&&(a[1]>b[1]||a[1]===b[1]&&a[2]>=b[2]);};

export class WorkstationAgentProvider {
  #references=new Map();
  constructor({registry,agentId,verificationAttempts=90,verificationIntervalMs=500}) { this.registry=registry; this.agentId=agentId; this.attempts=verificationAttempts; this.interval=verificationIntervalMs; }

  async #agent({media=false}={}) {
    const agent=await this.registry.agent(this.agentId);
    if(!agent) throw new WorkstationAgentProviderError('NUV_AGENT_NOT_FOUND','The configured Workstation agent was not found.',{status:404});
    if(agent.status!=='online') throw new WorkstationAgentProviderError('NUV_AGENT_OFFLINE','The configured Workstation agent is offline.',{retryable:true,status:503});
    if(agent.compatibility&&!agent.compatibility.compatible) throw new WorkstationAgentProviderError('NUV_AGENT_UPGRADE_REQUIRED',`Workstation agent ${agent.version} is below minimum supported version ${agent.compatibility.minimumVersion}.`,{status:409});
    if(media&&!versionAtLeast(agent.version,'0.1.13')) throw new WorkstationAgentProviderError('NUV_AGENT_MEDIA_UPGRADE_REQUIRED','Upgrade this Workstation Agent to version 0.1.13 or later to manage CD/DVD media.',{status:409});
    return agent;
  }

  async testConnection() {
    const agent=await this.#agent();
    return {status:'healthy',provider:'vmware_workstation',transport:'signed_agent',agentId:this.agentId,agentVersion:agent.version,compatibility:agent.compatibility,diagnostics:agent.diagnostics??null,capabilities:['inventory','power.start','power.stop','power.restart','power.pause',...(versionAtLeast(agent.version,'0.1.44')?['power.force_off','native_suspend_detection','durable_command_deduplication']:[]),...(versionAtLeast(agent.version,'0.1.45')?['power.guest_restart']:[]),...(versionAtLeast(agent.version,'0.1.13')?['media.list','media.mount','media.eject']:[]),...(versionAtLeast(agent.version,'0.1.15')?['media.browse']:[]),...(versionAtLeast(agent.version,'0.1.27')?['media.live_mount','media.desktop_companion']:versionAtLeast(agent.version,'0.1.26')?['media.assisted_mount']:versionAtLeast(agent.version,'0.1.17')?['media.live_mount']:[])]};
  }

  async discover() {
    const agent=await this.#agent();
    return (agent.inventory??[]).map(vm=>({resourceType:'virtual_machine',nativeId:vm.id??vm.nativeId,name:vm.name??vm.id,healthState:vm.healthState??'unknown',attributes:{powerState:vm.powerState??'unknown',guestOs:friendlyGuestOs(vm.guestOs),vcpuCount:vm.vcpuCount??null,memoryBytes:vm.memoryBytes??null,storageBytes:vm.storageBytes??null,privateIps:vm.privateIps??[],publicIps:[],region:'local-workstation',availabilityZone:this.agentId,providerShape:null},metrics:vm.metrics?{...vm.metrics,observedAt:vm.observedAt??agent.lastHeartbeatAt,source:'workstation_agent'}:null,providerMetadata:{agentId:this.agentId,agentVersion:agent.version,path:vm.path??null,hostName:vm.hostName??vm.hostname??vm.guestHostname??null,toolsStatus:vm.toolsStatus??null,reporting:vm.reporting??null,agentDiagnostics:agent.diagnostics??null,agentObservedAt:vm.observedAt??agent.lastHeartbeatAt,consoleState:vm.consoleState??'unknown',consoleManaged:Boolean(vm.consoleManaged),consolePort:vm.consolePort??null,hardware:vm.hardware??null,mediaImages:vm.mediaImages??[],mediaLocations:vm.mediaLocations??[]}}));
  }

  async #waitForCommand(commandId,{timeoutCode='NUV_AGENT_VERIFICATION_TIMEOUT',attempts=this.attempts}={}) {
    for(let attempt=0;attempt<attempts;attempt++) {
      const command=await this.registry.command(commandId);
      if(command?.status==='completed') return command.result??{};
      if(['failed','rejected'].includes(command?.status)) {
        if(command.result?.code==='NUV_MEDIA_CONFIRMATION_REQUIRED') return {...command.result,confirmationRequired:true};
        throw new WorkstationAgentProviderError(command.result?.code??'NUV_AGENT_COMMAND_FAILED',command.result?.message??'Workstation agent rejected or failed the command.',{status:422});
      }
      if(attempt<attempts-1) await new Promise(resolve=>setTimeout(resolve,this.interval));
    }
    throw new WorkstationAgentProviderError(timeoutCode,'Workstation agent did not report a result before the verification deadline.',{retryable:true,status:503});
  }

  async listMedia(nativeId) {
    const agent=await this.#agent({media:true}),vm=(agent.inventory??[]).find(item=>(item.id??item.nativeId)===nativeId);
    if(!vm) throw new WorkstationAgentProviderError('NUV_MEDIA_VM_NOT_FOUND','The Workstation VM is not present in the latest agent inventory.',{status:404});
    const liveMedia=versionAtLeast(agent.version,'0.1.17'),assistedMedia=versionAtLeast(agent.version,'0.1.26')&&!versionAtLeast(agent.version,'0.1.27');
    return {drives:vm.hardware?.cdDvdDrives??[],images:vm.mediaImages??[],locations:vm.mediaLocations??[],source:'workstation_agent',requiresPowerOff:!liveMedia,assistedMedia,warnings:vm.powerState==='stopped'?[]:assistedMedia?['Powered-on Workstation media changes open VMware Workstation and require confirmation there.']:liveMedia?[]:['Power off this VMware Workstation VM before mounting or ejecting media.']};
  }

  async browseMedia(path=null) {
    const agent=await this.#agent({media:true});
    if(!versionAtLeast(agent.version,'0.1.15')) throw new WorkstationAgentProviderError('NUV_AGENT_MEDIA_BROWSE_UPGRADE_REQUIRED','Upgrade this Workstation Agent to version 0.1.15 or later to browse host drives.',{status:409});
    if(path!=null&&(typeof path!=='string'||path.length>1024)) throw new WorkstationAgentProviderError('NUV_MEDIA_BROWSE_PATH_INVALID','The media browse path is invalid.',{status:422});
    const envelope=await this.registry.createCommand(this.agentId,{operation:'media.browse',targetId:JSON.stringify({path}),ttlMs:60000});
    return this.#waitForCommand(envelope.payload.commandId,{timeoutCode:'NUV_MEDIA_BROWSE_TIMEOUT',attempts:Math.max(this.attempts,120)});
  }

  async mountMedia(nativeId,{driveId,isoPath}) {
    await this.#agent({media:true});
    if(typeof driveId!=='string'||!driveId||typeof isoPath!=='string'||!isoPath||isoPath.length>1024) throw new WorkstationAgentProviderError('NUV_MEDIA_REQUEST_INVALID','A CD/DVD drive and local ISO path are required.',{status:422});
    const envelope=await this.registry.createCommand(this.agentId,{operation:'media.mount',targetId:JSON.stringify({vmxPath:nativeId,driveId,isoPath}),ttlMs:120000});
    return this.#waitForCommand(envelope.payload.commandId,{timeoutCode:'NUV_MEDIA_VERIFICATION_TIMEOUT',attempts:Math.max(this.attempts,240)});
  }

  async ejectMedia(nativeId,{driveId}) {
    await this.#agent({media:true});
    if(typeof driveId!=='string'||!driveId) throw new WorkstationAgentProviderError('NUV_MEDIA_REQUEST_INVALID','A CD/DVD drive is required.',{status:422});
    const envelope=await this.registry.createCommand(this.agentId,{operation:'media.eject',targetId:JSON.stringify({vmxPath:nativeId,driveId}),ttlMs:120000});
    return this.#waitForCommand(envelope.payload.commandId,{timeoutCode:'NUV_MEDIA_VERIFICATION_TIMEOUT',attempts:Math.max(this.attempts,240)});
  }

  async execute(operation,nativeId) {
    const agent=await this.#agent();
    if(operation==='reboot_guest'&&!versionAtLeast(agent.version,'0.1.45')) throw new WorkstationAgentProviderError('NUV_AGENT_GUEST_RESTART_UPGRADE_REQUIRED','Upgrade this Workstation Agent to version 0.1.45 or later to restart a guest operating system.',{status:409});
    const envelope=await this.registry.createCommand(this.agentId,{operation,targetId:nativeId}),reference=`workstation-agent:${envelope.payload.commandId}`;
    this.#references.set(reference,envelope.payload.commandId);
    return {providerReference:reference,operation,targetId:nativeId};
  }

  async verify(reference) {
    const commandId=this.#references.get(reference);
    if(!commandId) throw new WorkstationAgentProviderError('NUV_AGENT_REFERENCE_INVALID','Agent operation reference is unknown.');
    try {
      const result=await this.#waitForCommand(commandId),command=await this.registry.command(commandId);
      return {code:result.code??'NUV_OPERATION_VERIFIED',summary:result.message??'Workstation agent completed and verified the signed lifecycle command.',providerReference:reference,shutdownMode:result.shutdownMode??null,observedFinalState:result.powerState??(['stop','power_off'].includes(command?.operation)?'stopped':command?.operation==='pause'?'suspended':'running')};
    } finally { this.#references.delete(reference); }
  }
}

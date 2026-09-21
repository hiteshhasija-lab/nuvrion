export class AgentMaintenanceScheduler{
  constructor({registry,intervalMs=30000,offlineAfterMs=120000,onError=()=>{}}){this.registry=registry;this.intervalMs=intervalMs;this.offlineAfterMs=offlineAfterMs;this.onError=onError;this.timer=null;this.running=false;}
  start(){if(this.timer)return;this.timer=setInterval(()=>this.run(),this.intervalMs);this.timer.unref?.();}
  async run(){if(this.running)return null;this.running=true;try{return await this.registry.sweep({offlineAfterMs:this.offlineAfterMs});}catch(error){this.onError(error);return null;}finally{this.running=false;}}
  close(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}

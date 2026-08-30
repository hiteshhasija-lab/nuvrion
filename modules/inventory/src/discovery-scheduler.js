export class DiscoveryScheduler {
  constructor({connections,inventory,provider,reconciler,intervalMs=300000,onError=()=>{}}){this.connections=connections;this.inventory=inventory;this.provider=provider;this.reconciler=reconciler;this.intervalMs=intervalMs;this.onError=onError;this.timer=null;this.running=false;}
  start(){if(this.timer)return;this.timer=setInterval(()=>this.run(),this.intervalMs);this.timer.unref?.();this.run();}
  async discover(connection){const observations=await this.provider.discover(connection),summary=await this.inventory.synchronize(connection,observations);await this.connections.recordSync?.(connection.id,summary.discovered);const reconciliation=await this.reconciler.reconcileConnection(connection,observations);return {...summary,reconciliation};}
  async run(){if(this.running)return null;this.running=true;const results=[];try{for(const connection of await this.connections.list()){if(connection.status!=='enabled')continue;try{results.push({connectionId:connection.id,status:'completed',summary:await this.discover(connection)});}catch(error){await this.connections.recordHealth?.(connection.id,'unhealthy');results.push({connectionId:connection.id,status:'failed',code:error.code??'NUV_PROVIDER_FAILURE'});this.onError(error,connection);}}return results;}finally{this.running=false;}}
  close(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}

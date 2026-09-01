import {randomUUID} from 'node:crypto';
const clean=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):null;
const normalize=(resourceId,metric)=>({id:randomUUID(),resourceId,observedAt:metric.observedAt??new Date().toISOString(),cpuUtilizationPercent:clean(metric.cpuUtilizationPercent,0,100),cpuUsageMhz:clean(metric.cpuUsageMhz),memoryUtilizationPercent:clean(metric.memoryUtilizationPercent,0,100),memoryUsedBytes:clean(metric.memoryUsedBytes),storageUsedBytes:clean(metric.storageUsedBytes),networkRxBytesPerSec:clean(metric.networkRxBytesPerSec),networkTxBytesPerSec:clean(metric.networkTxBytesPerSec),source:String(metric.source??'provider').slice(0,32)});
export class PerformanceService{
  #samples=[];constructor({retentionMs=7*24*60*60_000}={}){this.retentionMs=retentionMs;}
  async record(connection,observations,resources){const byNative=new Map(resources.map(resource=>[resource.nativeId,resource.id])),samples=observations.filter(item=>item.metrics&&byNative.has(item.nativeId)).map(item=>normalize(byNative.get(item.nativeId),item.metrics));this.#samples.push(...samples);this.prune();return samples;}
  history(resourceId,{since=new Date(Date.now()-24*60*60_000).toISOString(),limit=500}={}){return this.#samples.filter(sample=>sample.resourceId===resourceId&&sample.observedAt>=since).slice(-Math.min(2000,Math.max(1,limit))).map(value=>structuredClone(value));}
  latest(resourceId){return this.#samples.filter(sample=>sample.resourceId===resourceId).at(-1)??null;}
  prune(now=Date.now()){const cutoff=new Date(now-this.retentionMs).toISOString(),before=this.#samples.length;this.#samples=this.#samples.filter(sample=>sample.observedAt>=cutoff);return before-this.#samples.length;}
}
export {normalize as normalizeMetricSample};

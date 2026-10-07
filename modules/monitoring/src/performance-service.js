import {randomUUID} from 'node:crypto';
// "Not reported" (null, undefined, an empty string, a boolean) is unknown. Number(null) is 0 and Number(true) is 1, which would turn a missing measurement into a real-looking one.
const reported=value=>value!==null&&value!==undefined&&typeof value!=='boolean'&&String(value).trim()!=='';
const clean=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>reported(value)&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):null;
// Byte counts and byte rates are stored as integers, so a fractional one is rounded instead of making the whole insert fail.
const whole=value=>{const number=clean(value);return number===null?null:Math.round(number);};
const normalize=(resourceId,metric)=>({id:randomUUID(),resourceId,observedAt:metric.observedAt??new Date().toISOString(),cpuUtilizationPercent:clean(metric.cpuUtilizationPercent,0,100),cpuUsageMhz:clean(metric.cpuUsageMhz),memoryUtilizationPercent:clean(metric.memoryUtilizationPercent,0,100),memoryUsedBytes:whole(metric.memoryUsedBytes),memoryActiveBytes:whole(metric.memoryActiveBytes),storageUsedBytes:whole(metric.storageUsedBytes),networkRxBytesPerSec:whole(metric.networkRxBytesPerSec),networkTxBytesPerSec:whole(metric.networkTxBytesPerSec),source:String(metric.source??'provider').slice(0,32)});
export class PerformanceService{
  #samples=[];constructor({retentionMs=7*24*60*60_000}={}){this.retentionMs=retentionMs;}
  async record(connection,observations,resources){const byNative=new Map(resources.map(resource=>[resource.nativeId,resource.id])),samples=observations.filter(item=>item.metrics&&byNative.has(item.nativeId)).map(item=>normalize(byNative.get(item.nativeId),item.metrics));this.#samples.push(...samples);this.prune();return samples;}
  history(resourceId,{since=new Date(Date.now()-24*60*60_000).toISOString(),limit=500}={}){return this.#samples.filter(sample=>sample.resourceId===resourceId&&sample.observedAt>=since).slice(-Math.min(2000,Math.max(1,limit))).map(value=>structuredClone(value));}
  latest(resourceId){return this.#samples.filter(sample=>sample.resourceId===resourceId).at(-1)??null;}
  latestForResources(resourceIds=[]){const wanted=new Set(resourceIds),latest=new Map();for(const sample of this.#samples)if(wanted.has(sample.resourceId))latest.set(sample.resourceId,sample);return [...latest.values()].map(value=>structuredClone(value));}
  prune(now=Date.now()){const cutoff=new Date(now-this.retentionMs).toISOString(),before=this.#samples.length;this.#samples=this.#samples.filter(sample=>sample.observedAt>=cutoff);return before-this.#samples.length;}
}
export {normalize as normalizeMetricSample};

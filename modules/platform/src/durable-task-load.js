import {randomUUID} from 'node:crypto';

const percentile=(sorted,value)=>sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*value)-1))]:null;
const terminal=new Set(['completed','failed','verification_required','cancelled']);

export class DurableTaskLoadError extends Error{
  constructor(message){super(message);this.code='NUV_TASK_LOAD_INVALID';}
}

export async function runDurableTaskLoad({store,count=200,concurrency=25,timeoutMs=30000,pollIntervalMs=25,clock=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),runId=randomUUID()}={}){
  if(!store?.create||!store?.get||!store?.attempts)throw new DurableTaskLoadError('A durable task store is required.');
  if(!Number.isSafeInteger(count)||count<10||count>5000||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>100||concurrency>count)throw new DurableTaskLoadError('Task count or concurrency is outside safe bounds.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>1000)throw new DurableTaskLoadError('Timeout or poll interval is outside safe bounds.');

  const startedAt=clock(),tasks=new Array(count),queue=Array.from({length:count},(_,index)=>index);
  async function creator(){while(queue.length){const index=queue.shift(),targetId=`qualification:${runId}:${index}`,result=await store.create({operation:'start',targetId,targetType:'qualification_synthetic',providerNativeId:targetId,connectionId:null,correlationId:randomUUID(),idempotencyKey:`qualification:${runId}:${index}`});if(!result.created)throw new DurableTaskLoadError('A qualification idempotency key was unexpectedly reused.');tasks[index]=result.task;}}
  await Promise.all(Array.from({length:concurrency},()=>creator()));

  const deadline=startedAt+timeoutMs;let current=[];
  do{current=await Promise.all(tasks.map(task=>store.get(task.id)));if(current.every(task=>task&&terminal.has(task.status)))break;if(clock()>=deadline)break;await sleep(pollIntervalMs);}while(true);

  const finishedAt=clock(),completed=current.filter(task=>task?.status==='completed'),lost=current.filter(task=>!task||!terminal.has(task.status)),failed=current.filter(task=>task&&task.status!=='completed'&&terminal.has(task.status)),durations=completed.map(task=>new Date(task.completedAt).getTime()-new Date(task.queuedAt).getTime()).sort((a,b)=>a-b),attemptSets=await Promise.all(tasks.map(task=>store.attempts(task.id))),duplicateOperations=attemptSets.reduce((sum,attempts)=>sum+Math.max(0,attempts.length-1),0),durationMs=Math.max(1,finishedAt-startedAt),p95CompletionMs=percentile(durations,.95),throughputPerSecond=Number((completed.length/(durationMs/1000)).toFixed(3)),qualified=completed.length===count&&lost.length===0&&failed.length===0&&duplicateOperations===0&&p95CompletionMs<=5000&&throughputPerSecond>=10;
  return {format:'nuvrion-durable-task-load/v1',environment:'staging',runId,completedAt:new Date(finishedAt).toISOString(),status:qualified?'passed':'failed',syntheticOnly:true,taskCount:count,concurrency,durationMs,throughputPerSecond,p50CompletionMs:percentile(durations,.5),p95CompletionMs,maximumCompletionMs:durations.at(-1)??null,completedTasks:completed.length,failedTasks:failed.length,lostTasks:lost.length,duplicateOperations,thresholds:{p95CompletionMs:5000,throughputPerSecond:10,lostTasks:0,duplicateOperations:0}};
}

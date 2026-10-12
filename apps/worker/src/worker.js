export class Worker {
  constructor({ store, provider, broker = null, onCompleted = null, maxAttempts=3, retryBaseMs=250, heartbeatMs=10000 }) { this.store = store; this.provider = provider; this.broker = broker; this.onCompleted = onCompleted; this.maxAttempts=maxAttempts;this.retryBaseMs=retryBaseMs;this.heartbeatMs=heartbeatMs;this.status = 'starting'; this.timer = null; }
  async start() { this.status = 'healthy';if(this.broker)await this.broker.subscribe(message=>this.tick(message?.taskId));else{this.timer=setInterval(()=>this.tick(),50);this.timer.unref?.();} }
  async notify(taskId) { if(this.broker)await this.broker.publishTaskQueued(taskId);else queueMicrotask(() => this.tick()); }
  async tick(taskId=null) {
    const task = await this.store.claim('worker',taskId); if (!task) return;
    // The lease is renewed for as long as this process is working on the task, so that it only expires when the process has stopped (periodic recovery relies on that).
    const beat=this.store.heartbeat?setInterval(()=>{try{Promise.resolve(this.store.heartbeat(task.id)).catch(()=>{});}catch{/* a failed renewal must never fail the task or end the process */}},this.heartbeatMs):null;beat?.unref?.();
    let accepted=null;try {
      accepted = await this.provider.execute(task.operation, task.providerNativeId ?? task.target.id, task);
      await this.store.running(task.id, accepted.providerReference);
      const result = await this.provider.verify(accepted.providerReference);
      await this.onCompleted?.(task, result);
      await this.store.complete(task.id, result);
    } catch (error) {const summary={code:error.code??'NUV_PROVIDER_FAILURE',detail:error.message,retryable:Boolean(error.retryable)},attemptCount=(await this.store.attempts(task.id)).length;if(accepted&&error.retryable)await this.store.verificationRequired(task.id,summary);else if(error.retryable&&attemptCount<this.maxAttempts)await this.store.retry(task.id,summary,this.retryBaseMs*2**(attemptCount-1));else await this.store.fail(task.id,summary);}finally{if(beat)clearInterval(beat);}
  }
  async close(){this.status='stopping';if(this.timer)clearInterval(this.timer);await this.broker?.close();this.status='stopped';}
}

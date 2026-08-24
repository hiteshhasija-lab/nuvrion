export class Worker {
  constructor({ store, provider, broker = null, onCompleted = null, maxAttempts=3, retryBaseMs=250 }) { this.store = store; this.provider = provider; this.broker = broker; this.onCompleted = onCompleted; this.maxAttempts=maxAttempts;this.retryBaseMs=retryBaseMs;this.status = 'starting'; this.timer = null; }
  async start() { this.status = 'healthy';if(this.broker)await this.broker.subscribe(()=>this.tick());else{this.timer=setInterval(()=>this.tick(),50);this.timer.unref?.();} }
  async notify(taskId) { if(this.broker)await this.broker.publishTaskQueued(taskId);else queueMicrotask(() => this.tick()); }
  async tick() {
    const task = await this.store.claim(); if (!task) return;
    let accepted=null;try {
      accepted = await this.provider.execute(task.operation, task.providerNativeId ?? task.target.id, task);
      await this.store.running(task.id, accepted.providerReference);
      const result = await this.provider.verify(accepted.providerReference);
      await this.onCompleted?.(task, result);
      await this.store.complete(task.id, result);
    } catch (error) {const summary={code:error.code??'NUV_PROVIDER_FAILURE',detail:error.message,retryable:Boolean(error.retryable)},attemptCount=(await this.store.attempts(task.id)).length;if(accepted&&error.retryable)await this.store.verificationRequired(task.id,summary);else if(error.retryable&&attemptCount<this.maxAttempts)await this.store.retry(task.id,summary,this.retryBaseMs*2**(attemptCount-1));else await this.store.fail(task.id,summary);}
  }
  async close(){this.status='stopping';if(this.timer)clearInterval(this.timer);await this.broker?.close();this.status='stopped';}
}

export class LocalTaskBroker {
  #handler=null;
  status='healthy';
  async subscribe(handler){this.#handler=handler;}
  async publishTaskQueued(taskId){queueMicrotask(()=>this.#handler?.({taskId}));}
  async close(){this.#handler=null;this.status='stopped';}
}

export class RabbitTaskBroker {
  constructor(url,{queue='nuvrion.tasks',connectImpl,reconnectMs=1000,onRejected=()=>{}}={}){this.url=url;this.queue=queue;this.connectImpl=connectImpl;this.reconnectMs=reconnectMs;this.onRejected=onRejected;this.connection=null;this.channel=null;this.handler=null;this.status='starting';this.closing=false;this.reconnectTimer=null;this.connecting=null;}
  static async connect(url,{queue='nuvrion.tasks',connectImpl,reconnectMs,onRejected}={}){if(!connectImpl)({connect:connectImpl}=await import('amqplib'));const broker=new RabbitTaskBroker(url,{queue,connectImpl,reconnectMs,onRejected});await broker.open();return broker;}
  async open(){if(this.closing)return;if(this.connecting)return this.connecting;this.connecting=(async()=>{try{const connection=await this.connectImpl(this.url),channel=await connection.createConfirmChannel();await channel.assertQueue(this.queue,{durable:true,arguments:{'x-queue-type':'quorum'}});this.connection=connection;this.channel=channel;this.status='healthy';connection.on?.('error',()=>{if(!this.closing)this.status='unhealthy';});connection.on?.('close',()=>{if(this.connection!==connection||this.closing)return;this.connection=null;this.channel=null;this.status='unhealthy';this.scheduleReconnect();});if(this.handler)await this.consume();}catch(error){this.status='unhealthy';this.scheduleReconnect();throw error;}finally{this.connecting=null;}})();return this.connecting;}
  scheduleReconnect(){if(this.closing||this.reconnectTimer)return;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.open().catch(()=>{});},this.reconnectMs);this.reconnectTimer.unref?.();}
  async consume(){const channel=this.channel,handler=this.handler;if(!channel||!handler)return;await channel.consume(this.queue,async message=>{if(!message)return;/* a message that is not JSON, or has no task id, can never succeed: requeueing it would redeliver it for ever, so it is rejected and reported; only a failure of the handler (the database is down, say) is retried */let task=null,reason=null;try{task=JSON.parse(message.content.toString('utf8'));}catch{reason='not_json';}if(!reason&&!(task&&typeof task==='object'&&typeof task.taskId==='string'&&task.taskId))reason='no_task_id';if(reason){channel.nack(message,false,false);try{this.onRejected({reason,messageId:message.properties?.messageId??null,bytes:message.content?.length??0});}catch{/* reporting must not stop the consumer */}return;}try{await handler(task);channel.ack(message);}catch{channel.nack(message,false,true);}},{noAck:false});}
  async subscribe(handler){this.handler=handler;if(this.status==='healthy')await this.consume();}
  async publishTaskQueued(taskId){if(this.status!=='healthy'||!this.channel)throw new Error('Task broker is unavailable.');this.channel.sendToQueue(this.queue,Buffer.from(JSON.stringify({taskId})),{persistent:true,contentType:'application/json',messageId:taskId});await this.channel.waitForConfirms();}
  async close(){this.closing=true;this.status='stopping';if(this.reconnectTimer)clearTimeout(this.reconnectTimer);const channel=this.channel,connection=this.connection;this.channel=null;this.connection=null;try{await channel?.close();}finally{await connection?.close();this.status='stopped';}}
}

export class OutboxRelay{
  constructor({store,broker,intervalMs=500,onError=()=>{}}){this.store=store;this.broker=broker;this.intervalMs=intervalMs;this.onError=onError;this.timer=null;this.running=false;this.status='starting';}
  start(){this.status='healthy';this.timer=setInterval(()=>this.tick().catch(this.onError),this.intervalMs);this.timer.unref?.();this.tick().catch(this.onError);}
  async tick(){if(this.running)return;this.running=true;try{for(const message of await this.store.pendingOutbox()){if(message.topic!=='task.queued')continue;await this.broker.publishTaskQueued(message.payload.taskId);await this.store.markOutboxPublished(message.id);}}finally{this.running=false;}}
  kick(){queueMicrotask(()=>this.tick().catch(this.onError));}   // a failed publish is reported and retried by the timer; it must never become an unhandled rejection, which would end the process
  close(){if(this.timer)clearInterval(this.timer);this.status='stopped';}
}

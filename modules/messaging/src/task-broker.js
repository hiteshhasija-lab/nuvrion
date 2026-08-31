export class LocalTaskBroker {
  #handler=null;
  status='healthy';
  async subscribe(handler){this.#handler=handler;}
  async publishTaskQueued(taskId){queueMicrotask(()=>this.#handler?.({taskId}));}
  async close(){this.#handler=null;this.status='stopped';}
}

export class RabbitTaskBroker {
  constructor(url,{queue='nuvrion.tasks',connectImpl,reconnectMs=1000}={}){this.url=url;this.queue=queue;this.connectImpl=connectImpl;this.reconnectMs=reconnectMs;this.connection=null;this.channel=null;this.handler=null;this.status='starting';this.closing=false;this.reconnectTimer=null;this.connecting=null;}
  static async connect(url,{queue='nuvrion.tasks',connectImpl,reconnectMs}={}){if(!connectImpl)({connect:connectImpl}=await import('amqplib'));const broker=new RabbitTaskBroker(url,{queue,connectImpl,reconnectMs});await broker.open();return broker;}
  async open(){if(this.closing)return;if(this.connecting)return this.connecting;this.connecting=(async()=>{try{const connection=await this.connectImpl(this.url),channel=await connection.createConfirmChannel();await channel.assertQueue(this.queue,{durable:true,arguments:{'x-queue-type':'quorum'}});this.connection=connection;this.channel=channel;this.status='healthy';connection.on?.('error',()=>{if(!this.closing)this.status='unhealthy';});connection.on?.('close',()=>{if(this.connection!==connection||this.closing)return;this.connection=null;this.channel=null;this.status='unhealthy';this.scheduleReconnect();});if(this.handler)await this.consume();}catch(error){this.status='unhealthy';this.scheduleReconnect();throw error;}finally{this.connecting=null;}})();return this.connecting;}
  scheduleReconnect(){if(this.closing||this.reconnectTimer)return;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.open().catch(()=>{});},this.reconnectMs);this.reconnectTimer.unref?.();}
  async consume(){const channel=this.channel,handler=this.handler;if(!channel||!handler)return;await channel.consume(this.queue,async message=>{if(!message)return;try{await handler(JSON.parse(message.content.toString('utf8')));channel.ack(message);}catch{channel.nack(message,false,true);}},{noAck:false});}
  async subscribe(handler){this.handler=handler;if(this.status==='healthy')await this.consume();}
  async publishTaskQueued(taskId){if(this.status!=='healthy'||!this.channel)throw new Error('Task broker is unavailable.');this.channel.sendToQueue(this.queue,Buffer.from(JSON.stringify({taskId})),{persistent:true,contentType:'application/json',messageId:taskId});await this.channel.waitForConfirms();}
  async close(){this.closing=true;this.status='stopping';if(this.reconnectTimer)clearTimeout(this.reconnectTimer);const channel=this.channel,connection=this.connection;this.channel=null;this.connection=null;try{await channel?.close();}finally{await connection?.close();this.status='stopped';}}
}

export class OutboxRelay{
  constructor({store,broker,intervalMs=500,onError=()=>{}}){this.store=store;this.broker=broker;this.intervalMs=intervalMs;this.onError=onError;this.timer=null;this.running=false;this.status='starting';}
  start(){this.status='healthy';this.timer=setInterval(()=>this.tick().catch(this.onError),this.intervalMs);this.timer.unref?.();this.tick().catch(this.onError);}
  async tick(){if(this.running)return;this.running=true;try{for(const message of await this.store.pendingOutbox()){if(message.topic!=='task.queued')continue;await this.broker.publishTaskQueued(message.payload.taskId);await this.store.markOutboxPublished(message.id);}}finally{this.running=false;}}
  kick(){queueMicrotask(()=>this.tick());}
  close(){if(this.timer)clearInterval(this.timer);this.status='stopped';}
}

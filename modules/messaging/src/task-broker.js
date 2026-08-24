export class LocalTaskBroker {
  #handler=null;
  status='healthy';
  async subscribe(handler){this.#handler=handler;}
  async publishTaskQueued(){queueMicrotask(()=>this.#handler?.());}
  async close(){this.#handler=null;this.status='stopped';}
}

export class RabbitTaskBroker {
  constructor(connection,channel,queue){this.connection=connection;this.channel=channel;this.queue=queue;this.status='healthy';}
  static async connect(url,{queue='nuvrion.tasks'}={}){const {connect}=await import('amqplib');const connection=await connect(url);const channel=await connection.createConfirmChannel();await channel.assertQueue(queue,{durable:true,arguments:{'x-queue-type':'quorum'}});return new RabbitTaskBroker(connection,channel,queue);}
  async subscribe(handler){await this.channel.consume(this.queue,async message=>{if(!message)return;try{await handler(JSON.parse(message.content.toString('utf8')));this.channel.ack(message);}catch{this.channel.nack(message,false,true);}},{noAck:false});}
  async publishTaskQueued(taskId){this.channel.sendToQueue(this.queue,Buffer.from(JSON.stringify({taskId})),{persistent:true,contentType:'application/json',messageId:taskId});await this.channel.waitForConfirms();}
  async close(){this.status='stopping';await this.channel.close();await this.connection.close();this.status='stopped';}
}

export class OutboxRelay{
  constructor({store,broker,intervalMs=500}){this.store=store;this.broker=broker;this.intervalMs=intervalMs;this.timer=null;this.running=false;this.status='starting';}
  start(){this.status='healthy';this.timer=setInterval(()=>this.tick(),this.intervalMs);this.timer.unref?.();this.tick();}
  async tick(){if(this.running)return;this.running=true;try{for(const message of await this.store.pendingOutbox()){if(message.topic!=='task.queued')continue;await this.broker.publishTaskQueued(message.payload.taskId);await this.store.markOutboxPublished(message.id);}}finally{this.running=false;}}
  kick(){queueMicrotask(()=>this.tick());}
  close(){if(this.timer)clearInterval(this.timer);this.status='stopped';}
}

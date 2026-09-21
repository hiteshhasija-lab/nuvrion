import {createHmac,randomBytes} from 'node:crypto';
export class LoginRateLimiter{
  #failures=new Map();
  constructor({limit=5,windowMs=300000,keySecret=randomBytes(32),clock=()=>Date.now()}={}){this.limit=limit;this.windowMs=windowMs;this.keySecret=keySecret;this.clock=clock;}
  #key(client,username){return createHmac('sha256',this.keySecret).update(`${client}|${String(username??'').trim().toLowerCase()}`).digest('hex');}
  check(client,username){const now=this.clock(),key=this.#key(client,username),recent=(this.#failures.get(key)??[]).filter(value=>value>now-this.windowMs);if(recent.length)this.#failures.set(key,recent);else this.#failures.delete(key);const allowed=recent.length<this.limit,retryAfterSeconds=allowed?0:Math.max(1,Math.ceil((recent[0]+this.windowMs-now)/1000));return {allowed,retryAfterSeconds};}
  recordFailure(client,username){const key=this.#key(client,username),now=this.clock(),recent=(this.#failures.get(key)??[]).filter(value=>value>now-this.windowMs);recent.push(now);this.#failures.set(key,recent);}
  reset(client,username){this.#failures.delete(this.#key(client,username));}
}

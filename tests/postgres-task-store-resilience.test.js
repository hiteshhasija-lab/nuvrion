import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PostgresTaskStore} from '../modules/tasks/src/postgres-task-store.js';
import {ReadinessService} from '../modules/platform/src/readiness-service.js';

test('an idle PostgreSQL pool error marks the store unhealthy without becoming an unhandled event',()=>{
  const pool=new EventEmitter(),observed=[];
  const store=new PostgresTaskStore(pool,{onPoolError:error=>observed.push(error.code)});
  pool.emit('error',Object.assign(new Error('database unavailable'),{code:'ECONNREFUSED'}));
  assert.equal(store.status,'unhealthy');
  assert.deepEqual(observed,['ECONNREFUSED']);
});

test('readiness rejects traffic during a database outage and returns healthy after recovery',async()=>{
  let available=false;
  const store={status:'healthy',pool:{async query(sql){if(!available)throw Object.assign(new Error('database unavailable'),{code:'ECONNREFUSED'});return sql==='SELECT 1'?{rowCount:1}:{rowCount:3};}}};
  const service=new ReadinessService({production:true,store,broker:{status:'healthy'},worker:{status:'healthy'},agentMaintenance:{timer:{}},requiredMigration:'0019'});
  const unavailable=await service.check();
  assert.equal(unavailable.status,'not_ready');
  assert.equal(unavailable.components.database,'unhealthy');
  assert.equal(store.status,'unhealthy');
  available=true;
  const recovered=await service.check();
  assert.equal(recovered.status,'ready');
  assert.equal(recovered.components.database,'healthy');
  assert.equal(store.status,'healthy');
});

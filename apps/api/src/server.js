import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { TaskStore } from '../../../modules/tasks/src/task-store.js';
import { MockProvider } from '../../../providers/mock/src/mock-provider.js';
import { Worker } from '../../worker/src/worker.js';
import { IdentityService, parseCookies } from '../../../modules/identity/src/identity-service.js';
import { ConnectionService } from '../../../modules/connections/src/connection-service.js';
import { InventoryService } from '../../../modules/inventory/src/inventory-service.js';
import { PostgresTaskStore } from '../../../modules/tasks/src/postgres-task-store.js';
import { LocalTaskBroker, RabbitTaskBroker, OutboxRelay } from '../../../modules/messaging/src/task-broker.js';
import { PostgresIdentityService } from '../../../modules/identity/src/postgres-identity-service.js';
import { PostgresConnectionService } from '../../../modules/connections/src/postgres-connection-service.js';
import { PostgresInventoryService } from '../../../modules/inventory/src/postgres-inventory-service.js';
import { ProviderRouter } from '../../../providers/provider-router.js';
import { AgentRegistry } from '../../../modules/agents/src/agent-registry.js';
import { PostgresAgentRegistry } from '../../../modules/agents/src/postgres-agent-registry.js';
import { AgentCompatibilityPolicy } from '../../../modules/agents/src/agent-compatibility.js';
import { AgentMaintenanceScheduler } from '../../../modules/agents/src/agent-maintenance-scheduler.js';
import { AgentUpgradeService } from '../../../modules/agents/src/agent-upgrade-service.js';
import { PostgresAgentUpgradeService } from '../../../modules/agents/src/postgres-agent-upgrade-service.js';
import { validateRuntimeConfiguration } from '../../../modules/platform/src/runtime-configuration.js';
import { ReadinessService } from '../../../modules/platform/src/readiness-service.js';
import { VerificationReconciler } from '../../../modules/tasks/src/verification-reconciler.js';
import { LoginRateLimiter } from '../../../modules/identity/src/login-rate-limiter.js';
import { OperationalMetrics } from '../../../modules/platform/src/operational-metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../../web');
const production=process.env.NUVRION_RUNTIME_PROFILE==='production';
const runtimeConfiguration=validateRuntimeConfiguration(process.env);
const store = production?await PostgresTaskStore.connect(process.env.NUVRION_DATABASE_URL):new TaskStore({file:process.env.NUVRION_STATE_FILE ?? '.nuvrion/state.json'});
const broker = production?await RabbitTaskBroker.connect(process.env.NUVRION_BROKER_URL):new LocalTaskBroker();
const mockProvider = new MockProvider();
const identity = production?await PostgresIdentityService.create(store.pool):new IdentityService();
const connections = production?new PostgresConnectionService(store.pool):new ConnectionService();
const inventory = production?new PostgresInventoryService(store.pool):new InventoryService({file:process.env.NUVRION_INVENTORY_FILE ?? '.nuvrion/inventory.json'});
const compatibility=new AgentCompatibilityPolicy({minimumVersion:process.env.NUVRION_AGENT_MIN_VERSION??'0.1.0',recommendedVersion:process.env.NUVRION_AGENT_RECOMMENDED_VERSION??'0.1.0'});
const agents = production?new PostgresAgentRegistry(store.pool,{compatibility}):new AgentRegistry({compatibility});
const agentMaintenance=new AgentMaintenanceScheduler({registry:agents,intervalMs:Number(process.env.NUVRION_AGENT_MAINTENANCE_MS??30000),offlineAfterMs:Number(process.env.NUVRION_AGENT_OFFLINE_MS??120000),onError:error=>console.error(JSON.stringify({level:'error',event:'agent.maintenance.failed',error:error.message}))});agentMaintenance.start();
const signingKeys={privateKeyPem:process.env.NUVRION_AGENT_SIGNING_PRIVATE_KEY??null,publicKeyPem:process.env.NUVRION_AGENT_SIGNING_PUBLIC_KEY??null};
const agentUpgrades=production?new PostgresAgentUpgradeService(store.pool,signingKeys):new AgentUpgradeService(signingKeys);
const provider = new ProviderRouter({connections,agents,mock:mockProvider});
const worker = new Worker({ store, provider, broker, onCompleted:async(task,result)=>{if(task.target.type==='virtual_machine'&&await inventory.get(task.target.id))await inventory.applyOperation(task.target.id,task.operation,result);} });
await worker.start();
const readiness=new ReadinessService({production,store,broker,worker,agentMaintenance,requiredMigration:'0016'});
const verificationReconciler=new VerificationReconciler({store,connections,inventory,provider});
const loginLimiter=new LoginRateLimiter({limit:Number(process.env.NUVRION_LOGIN_ATTEMPT_LIMIT??5),windowMs:Number(process.env.NUVRION_LOGIN_WINDOW_MS??300000),...(process.env.NUVRION_MASTER_KEY?{keySecret:process.env.NUVRION_MASTER_KEY}:{})});
const operationalMetrics=new OperationalMetrics();
const outboxRelay=production?new OutboxRelay({store,broker}):null;outboxRelay?.start();
const recovered=await store.recoverExpired();if(recovered&&!production)await worker.notify();

function securityHeaders(contentType,cacheControl='no-store'){return {'content-type':contentType,'cache-control':cacheControl,'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...(production?{'strict-transport-security':'max-age=31536000; includeSubDomains'}:{})};}
function json(res, status, payload, correlationId) {
  res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'x-correlation-id': correlationId });
  res.end(JSON.stringify(payload));
}
function problem(res, status, code, detail, correlationId) {
  json(res, status, { type: `https://nuvrion.local/problems/${code.toLowerCase()}`, title: 'Request failed', status, detail, code, correlationId, retryable: false }, correlationId);
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('BODY_TOO_LARGE'); }
  if(raw&&!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))throw new Error('UNSUPPORTED_MEDIA_TYPE');
  return raw ? JSON.parse(raw) : {};
}
async function principal(req,verifyCsrf=false){return identity.session(parseCookies(req.headers.cookie).nuvrion_session,verifyCsrf?req.headers['x-csrf-token']:null);}
async function requireAuth(req,res,correlationId,permission){const p=await principal(req);if(!p){problem(res,401,'NUV_AUTH_REQUIRED','Authentication is required.',correlationId);return null;}if(permission&&!identity.authorize(p,permission)){problem(res,403,'NUV_PERMISSION_DENIED','You do not have permission to perform this action.',correlationId);return null;}return p;}
async function requireCsrf(req,res,correlationId,p){const valid=production?Boolean((await principal(req,true))?.session.csrfVerified):req.headers['x-csrf-token']===p.session.csrf;if(!valid){problem(res,403,'NUV_CSRF_INVALID','The request could not be validated.',correlationId);return false;}return true;}
export async function handler(req, res) {
  const requestStarted=process.hrtime.bigint(),completeMetric=operationalMetrics.begin(),finishMetric=()=>{operationalMetrics.observeLatency(Number(process.hrtime.bigint()-requestStarted)/1e6);completeMetric(res.statusCode);};if(typeof res.once==='function')res.once('finish',finishMetric);else{const end=res.end.bind(res);res.end=(...args)=>{finishMetric();return end(...args);};}
  const correlationId = /^[0-9a-f-]{36}$/i.test(req.headers['x-correlation-id'] ?? '') ? req.headers['x-correlation-id'] : randomUUID();
  const url = new URL(req.url, 'http://localhost');
  console.log(JSON.stringify({ level: 'info', event: 'http.request', method: req.method, path: url.pathname, correlationId }));
  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/health') return json(res, 200, {
      status: 'healthy', version: '0.1.0', correlationId,
      components: { api: 'healthy', database: production?'postgresql':'local_durable_adapter', broker: production?'rabbitmq':'local_broker', worker: worker.status, mockProvider: 'healthy' }, metrics: {...await store.metrics(),...await inventory.metrics()}
    }, correlationId);
    if(req.method==='GET'&&url.pathname==='/api/v1/readiness'){const result=await readiness.check();return json(res,result.status==='ready'?200:503,{...result,profile:runtimeConfiguration.profile,correlationId},correlationId);}
    if(req.method==='POST'&&url.pathname==='/api/v1/auth/login'){
      const input=await body(req),client=process.env.NUVRION_TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']??'').split(',')[0].trim():req.socket?.remoteAddress??'unknown',limit=loginLimiter.check(client,input.username);if(!limit.allowed){res.setHeader('retry-after',String(limit.retryAfterSeconds));return problem(res,429,'NUV_LOGIN_THROTTLED','Too many unsuccessful sign-in attempts. Try again later.',correlationId);}const result=await identity.authenticate(input.username??'',input.password??'');
      if(!result){loginLimiter.recordFailure(client,input.username);return problem(res,401,'NUV_LOGIN_FAILED','Username or password is incorrect.',correlationId);}loginLimiter.reset(client,input.username);
      res.setHeader('set-cookie',production?[`nuvrion_session=${encodeURIComponent(result.token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1800`,`nuvrion_csrf=${encodeURIComponent(result.csrf)}; Secure; SameSite=Strict; Path=/; Max-Age=1800`]:`nuvrion_session=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      return json(res,200,{user:result.user,csrfToken:result.csrf,expiresAt:result.expiresAt},correlationId);
    }
    if(req.method==='GET'&&url.pathname==='/api/v1/auth/me'){const p=await requireAuth(req,res,correlationId);if(!p)return;const csrfToken=production?parseCookies(req.headers.cookie).nuvrion_csrf:p.session.csrf;return json(res,200,{user:p.user,csrfToken,expiresAt:new Date(p.session.idleExpiresAt).toISOString()},correlationId);}
    if(req.method==='POST'&&url.pathname==='/api/v1/auth/logout'){const p=await requireAuth(req,res,correlationId);if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;await identity.logout(parseCookies(req.headers.cookie).nuvrion_session);res.setHeader('set-cookie',production?['nuvrion_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0','nuvrion_csrf=; Secure; SameSite=Strict; Path=/; Max-Age=0']:'nuvrion_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.writeHead(204,{...securityHeaders('application/json; charset=utf-8'),'x-correlation-id':correlationId});return res.end();}
    if (req.method === 'GET' && url.pathname === '/api/v1/tasks') {const p=await requireAuth(req,res,correlationId,'resource.view');if(!p)return;const items=await store.list();return json(res, 200, { items, nextCursor: null, count: items.length, meta: { correlationId } }, correlationId);}
    const match = url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && match) {
      const p=await requireAuth(req,res,correlationId,'resource.view');if(!p)return;
      const task = await store.get(match[1]);
      return task ? json(res, 200, {...task,attempts:await store.attempts(task.id)}, correlationId) : problem(res, 404, 'NUV_TASK_NOT_FOUND', 'Task was not found.', correlationId);
    }
    const reconcileTaskMatch=url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)\/reconcile$/i);
    if(req.method==='POST'&&reconcileTaskMatch){const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{return json(res,200,await verificationReconciler.reconcile(reconcileTaskMatch[1]),correlationId);}catch(error){return problem(res,error.status??409,error.code??'NUV_RECONCILIATION_FAILED',error.message,correlationId);}}
    const cancelTaskMatch=url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)\/cancel$/i);
    if(req.method==='POST'&&cancelTaskMatch){const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const result=await store.cancel(cancelTaskMatch[1],{id:p.user.id,username:p.user.username});if(!result.ok)return problem(res,result.code==='NUV_TASK_NOT_FOUND'?404:409,result.code,result.detail??'Task could not be cancelled.',correlationId);return json(res,200,result.task,correlationId);}
    const retryTaskMatch=url.pathname.match(/^\/api\/v1\/tasks\/([0-9a-f-]+)\/retry$/i);
    if(req.method==='POST'&&retryTaskMatch){const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const result=await store.manualRetry(retryTaskMatch[1],{id:p.user.id,username:p.user.username});if(!result.ok)return problem(res,result.code==='NUV_TASK_NOT_FOUND'?404:409,result.code,result.detail??'Task could not be retried.',correlationId);production?outboxRelay.kick():await worker.notify(result.task.id);return json(res,202,result.task,correlationId);}
    if (req.method === 'POST' && url.pathname === '/api/v1/mock/operations') {
      const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;
      const input = await body(req);
      if (!['start','stop','restart'].includes(input.operation)) return problem(res, 422, 'NUV_OPERATION_INVALID', 'operation must be start, stop, or restart.', correlationId);
      const key = req.headers['idempotency-key'];
      if (!key) return problem(res, 400, 'NUV_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.', correlationId);
      const { task, created } = await store.create({ operation: input.operation, targetId: input.targetId ?? 'mock-vm-001', correlationId, idempotencyKey: key });
      if (created) production?outboxRelay.kick():await worker.notify(task.id);
      res.setHeader('location', `/api/v1/tasks/${task.id}`);
      return json(res, created ? 201 : 200, task, correlationId);
    }
    if(req.method==='GET'&&url.pathname==='/api/v1/connections'){const p=await requireAuth(req,res,correlationId,'connection.view');if(!p)return;const items=await connections.list();return json(res,200,{items,nextCursor:null,count:items.length,meta:{correlationId}},correlationId);}
    if(req.method==='GET'&&url.pathname==='/api/v1/audit-events'){const p=await requireAuth(req,res,correlationId,'audit.view');if(!p)return;const items=await store.audit({action:url.searchParams.get('action'),outcome:url.searchParams.get('outcome'),limit:Math.min(Number(url.searchParams.get('limit')??100),250)});return json(res,200,{items,nextCursor:null,count:items.length,meta:{correlationId}},correlationId);}
    if(req.method==='GET'&&url.pathname==='/api/v1/platform/metrics'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;return json(res,200,{...await store.metrics(),...await inventory.metrics(),correlationId},correlationId);}
    if(req.method==='GET'&&url.pathname==='/api/v1/platform/metrics/prometheus'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;const application={...await store.metrics(),...await inventory.metrics()},payload=operationalMetrics.prometheus({application,runtime:{workerHealthy:worker.status==='healthy'?1:0,brokerHealthy:broker.status==='healthy'?1:0}});res.writeHead(200,{...securityHeaders('text/plain; version=0.0.4; charset=utf-8'),'x-correlation-id':correlationId});return res.end(payload);}
    if(req.method==='GET'&&url.pathname==='/api/v1/agents'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;const items=await agents.list();return json(res,200,{items,count:items.length,meta:{correlationId}},correlationId);}
    if(req.method==='POST'&&url.pathname==='/api/v1/agents/enrollment-tokens'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;return json(res,201,await agents.createEnrollmentToken({createdBy:p.user.id}),correlationId);}
    if(req.method==='POST'&&url.pathname==='/api/v1/agents/enroll'){const input=await body(req);try{return json(res,201,await agents.enroll(input),correlationId);}catch(error){return problem(res,401,error.code??'NUV_AGENT_ENROLLMENT_INVALID',error.message,correlationId);}}
    if(req.method==='POST'&&url.pathname==='/api/v1/agents/maintenance/sweep'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const input=await body(req);return json(res,200,await agents.sweep({offlineAfterMs:Number(input.offlineAfterMs??120000)}),correlationId);}
    if(req.method==='POST'&&url.pathname==='/api/v1/agent-upgrades/releases'){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{return json(res,201,await agentUpgrades.registerRelease(await body(req)),correlationId);}catch(error){return problem(res,422,error.code??'NUV_AGENT_RELEASE_INVALID',error.message,correlationId);}}
    const agentUpgradeStageMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/upgrades$/i);
    if(req.method==='GET'&&agentUpgradeStageMatch){if(!await agents.authenticate(agentUpgradeStageMatch[1],req.headers['x-agent-secret']))return problem(res,401,'NUV_AGENT_AUTH_FAILED','Agent authentication failed.',correlationId);const items=await agentUpgrades.pending(agentUpgradeStageMatch[1]);return json(res,200,{items,count:items.length},correlationId);}
    if(req.method==='POST'&&agentUpgradeStageMatch){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{const input=await body(req);if(!await agents.agent(agentUpgradeStageMatch[1]))return problem(res,404,'NUV_AGENT_NOT_FOUND','Agent was not found.',correlationId);return json(res,201,await agentUpgrades.stage(agentUpgradeStageMatch[1],input.releaseId),correlationId);}catch(error){return problem(res,404,error.code??'NUV_AGENT_RELEASE_NOT_FOUND',error.message,correlationId);}}
    const agentUpgradeReportMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/upgrades\/([0-9a-f-]+)\/report$/i);
    if(req.method==='POST'&&agentUpgradeReportMatch){if(!await agents.authenticate(agentUpgradeReportMatch[1],req.headers['x-agent-secret']))return problem(res,401,'NUV_AGENT_AUTH_FAILED','Agent authentication failed.',correlationId);try{return json(res,200,await agentUpgrades.report(agentUpgradeReportMatch[1],agentUpgradeReportMatch[2],await body(req)),correlationId);}catch(error){return problem(res,422,error.code??'NUV_AGENT_UPGRADE_STATUS_INVALID',error.message,correlationId);}}
    const agentRotateMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/rotate-secret$/i);
    if(req.method==='POST'&&agentRotateMatch){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{return json(res,200,await agents.rotateSecret(agentRotateMatch[1]),correlationId);}catch(error){return problem(res,404,error.code??'NUV_AGENT_NOT_FOUND',error.message,correlationId);}}
    const agentRevokeMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/revoke$/i);
    if(req.method==='POST'&&agentRevokeMatch){const p=await requireAuth(req,res,correlationId,'platform.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{return json(res,200,await agents.revoke(agentRevokeMatch[1],await body(req)),correlationId);}catch(error){return problem(res,404,error.code??'NUV_AGENT_NOT_FOUND',error.message,correlationId);}}
    const heartbeatMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/heartbeat$/i);
    if(req.method==='POST'&&heartbeatMatch){try{return json(res,200,await agents.heartbeat(heartbeatMatch[1],req.headers['x-agent-secret'],await body(req)),correlationId);}catch(error){return problem(res,401,error.code??'NUV_AGENT_AUTH_FAILED',error.message,correlationId);}}
    const pendingCommandsMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/commands$/i);
    if(req.method==='GET'&&pendingCommandsMatch){try{const items=await agents.pending(pendingCommandsMatch[1],req.headers['x-agent-secret']);return json(res,200,{items,count:items.length},correlationId);}catch(error){return problem(res,401,error.code??'NUV_AGENT_AUTH_FAILED',error.message,correlationId);}}
    const agentCommandMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/commands$/i);
    if(req.method==='POST'&&agentCommandMatch){const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;try{return json(res,201,await agents.createCommand(agentCommandMatch[1],{...await body(req),requestedBy:p.user.id}),correlationId);}catch(error){return problem(res,error.code==='NUV_AGENT_NOT_FOUND'?404:422,error.code??'NUV_AGENT_COMMAND_INVALID',error.message,correlationId);}}
    const agentAckMatch=url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/commands\/([0-9a-f-]+)\/ack$/i);
    if(req.method==='POST'&&agentAckMatch){try{return json(res,200,await agents.acknowledge(agentAckMatch[1],req.headers['x-agent-secret'],agentAckMatch[2],await body(req)),correlationId);}catch(error){return problem(res,error.code==='NUV_AGENT_AUTH_FAILED'?401:422,error.code??'NUV_AGENT_RESULT_INVALID',error.message,correlationId);}}
    if(req.method==='GET'&&url.pathname==='/api/v1/resources'){const p=await requireAuth(req,res,correlationId,'resource.view');if(!p)return;const items=await inventory.list({connectionId:url.searchParams.get('connectionId'),resourceType:url.searchParams.get('resourceType'),lifecycleState:url.searchParams.get('lifecycleState'),search:url.searchParams.get('search')});return json(res,200,{items,nextCursor:null,count:items.length,meta:{correlationId}},correlationId);}
    const resourceMatch=url.pathname.match(/^\/api\/v1\/resources\/([0-9a-f-]+)$/i);
    if(req.method==='GET'&&resourceMatch){const p=await requireAuth(req,res,correlationId,'resource.view');if(!p)return;const resource=await inventory.get(resourceMatch[1]);return resource?json(res,200,resource,correlationId):problem(res,404,'NUV_RESOURCE_NOT_FOUND','Resource was not found.',correlationId);}
    const resourceOperationMatch=url.pathname.match(/^\/api\/v1\/resources\/([0-9a-f-]+)\/operations$/i);
    if(req.method==='POST'&&resourceOperationMatch){const p=await requireAuth(req,res,correlationId,'resource.operate');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const key=req.headers['idempotency-key'];if(!key)return problem(res,400,'NUV_IDEMPOTENCY_REQUIRED','Idempotency-Key is required.',correlationId);const prior=await store.getByIdempotencyKey(key);if(prior){if(prior.target.id!==resourceOperationMatch[1])return problem(res,409,'NUV_IDEMPOTENCY_CONFLICT','The idempotency key was already used for another target.',correlationId);return json(res,200,prior,correlationId);}const input=await body(req);const validation=await inventory.validateOperation(resourceOperationMatch[1],input.operation);if(!validation.ok){const status=validation.code==='NUV_RESOURCE_NOT_FOUND'?404:validation.code==='NUV_OPERATION_STATE_CONFLICT'?409:422;return problem(res,status,validation.code,validation.detail??'The requested operation is not available for this resource.',correlationId);}if(await store.activeForTarget(resourceOperationMatch[1]))return problem(res,409,'NUV_OPERATION_IN_PROGRESS','Another lifecycle operation is already active for this resource.',correlationId);const resource=validation.resource;const {task,created}=await store.create({operation:input.operation,targetId:resource.id,targetType:resource.resourceType,providerNativeId:resource.nativeId,connectionId:resource.connectionId,requestedBy:{id:p.user.id,username:p.user.username},correlationId,idempotencyKey:key});if(created){if(production)outboxRelay.kick();else await worker.notify(task.id);}res.setHeader('location',`/api/v1/tasks/${task.id}`);return json(res,202,task,correlationId);}
    const discoveryMatch=url.pathname.match(/^\/api\/v1\/connections\/([0-9a-f-]+)\/discover$/i);
    if(req.method==='POST'&&discoveryMatch){const p=await requireAuth(req,res,correlationId,'connection.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const connection=await connections.get(discoveryMatch[1]);if(!connection)return problem(res,404,'NUV_CONNECTION_NOT_FOUND','Connection was not found.',correlationId);try{const summary=await inventory.synchronize(connection,await provider.discover(connection));await connections.recordSync?.(connection.id,summary.discovered);return json(res,200,summary,correlationId);}catch(error){await connections.recordHealth?.(connection.id,'unhealthy');return problem(res,error.status===401?401:error.status===403?403:error.status===404?404:error.retryable?503:422,error.code??'NUV_PROVIDER_FAILURE',error.message,correlationId);}}
    const connectionTestMatch=url.pathname.match(/^\/api\/v1\/connections\/([0-9a-f-]+)\/test$/i);
    if(req.method==='POST'&&connectionTestMatch){const p=await requireAuth(req,res,correlationId,'connection.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const connection=await connections.get(connectionTestMatch[1]);if(!connection)return problem(res,404,'NUV_CONNECTION_NOT_FOUND','Connection was not found.',correlationId);try{const result=await provider.test(connection);await connections.recordHealth?.(connection.id,'healthy');return json(res,200,result,correlationId);}catch(error){await connections.recordHealth?.(connection.id,'unhealthy');return problem(res,error.status===401?401:error.status===403?403:error.retryable?503:422,error.code??'NUV_PROVIDER_FAILURE',error.message,correlationId);}}
    if(req.method==='POST'&&url.pathname==='/api/v1/connections'){const p=await requireAuth(req,res,correlationId,'connection.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const input=await body(req);try{const c=await connections.create({...input,createdBy:p.user.id});res.setHeader('location',`/api/v1/connections/${c.id}`);res.setHeader('etag',c.etag);return json(res,201,c,correlationId);}catch{return problem(res,422,'NUV_CONNECTION_INVALID','Connection data is invalid.',correlationId);}}
    const connectionMatch=url.pathname.match(/^\/api\/v1\/connections\/([0-9a-f-]+)$/i);
    if(req.method==='GET'&&connectionMatch){const p=await requireAuth(req,res,correlationId,'connection.view');if(!p)return;const c=await connections.get(connectionMatch[1]);if(!c)return problem(res,404,'NUV_CONNECTION_NOT_FOUND','Connection was not found.',correlationId);res.setHeader('etag',c.etag);return json(res,200,c,correlationId);}
    const credentialMatch=url.pathname.match(/^\/api\/v1\/connections\/([0-9a-f-]+)\/credentials$/i);
    if(req.method==='POST'&&credentialMatch){const p=await requireAuth(req,res,correlationId,'connection.manage');if(!p)return;if(!await requireCsrf(req,res,correlationId,p))return;const version=Number((req.headers['if-match']??'').replaceAll('"',''));if(!version)return problem(res,428,'NUV_PRECONDITION_REQUIRED','If-Match is required.',correlationId);try{const c=await connections.replaceCredential(credentialMatch[1],(await body(req)).credential,version);if(!c)return problem(res,404,'NUV_CONNECTION_NOT_FOUND','Connection was not found.',correlationId);res.setHeader('etag',c.etag);return json(res,200,c,correlationId);}catch(e){return problem(res,e.message==='VERSION_CONFLICT'?412:422,e.message==='VERSION_CONFLICT'?'NUV_VERSION_CONFLICT':'NUV_CREDENTIAL_INVALID',e.message==='VERSION_CONFLICT'?'The connection has changed. Refresh and retry.':'Credential data is invalid.',correlationId);}}
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(resolve(webRoot, 'index.html'));
      res.writeHead(200, { ...securityHeaders('text/html; charset=utf-8'), 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'x-correlation-id': correlationId }); return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      const js = await readFile(resolve(webRoot, 'app.js'));
      res.writeHead(200, securityHeaders('text/javascript; charset=utf-8','public, max-age=300')); return res.end(js);
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      const css = await readFile(resolve(webRoot, 'styles.css'));
      res.writeHead(200, securityHeaders('text/css; charset=utf-8','public, max-age=300')); return res.end(css);
    }
    if (req.method === 'GET' && url.pathname === '/visibility.css') {
      const css = await readFile(resolve(webRoot, 'visibility.css'));
      res.writeHead(200, securityHeaders('text/css; charset=utf-8','public, max-age=300')); return res.end(css);
    }
    return problem(res, 404, 'NUV_ROUTE_NOT_FOUND', 'Route was not found.', correlationId);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'http.error', correlationId, error: error.message }));
    if(error.message==='BODY_TOO_LARGE')return problem(res,413,'NUV_BODY_TOO_LARGE','The request body exceeds the allowed size.',correlationId);if(error.message==='UNSUPPORTED_MEDIA_TYPE')return problem(res,415,'NUV_CONTENT_TYPE_REQUIRED','JSON requests must use application/json.',correlationId);return problem(res,500,'NUV_INTERNAL_ERROR','The request could not be completed.',correlationId);
  }
}

export function createServer() { return http.createServer(handler); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.NUVRION_HOST ?? '127.0.0.1'; const port = Number(process.env.NUVRION_PORT ?? 4100);
  const server=createServer();server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', event: 'server.started', profile:production?'production':'local',url: `http://${host}:${port}` })));
  const shutdown=async signal=>{console.log(JSON.stringify({level:'info',event:'server.stopping',signal}));server.close();agentMaintenance.close();outboxRelay?.close();await worker.close();await store.close?.();};
  process.once('SIGTERM',()=>shutdown('SIGTERM'));process.once('SIGINT',()=>shutdown('SIGINT'));
}

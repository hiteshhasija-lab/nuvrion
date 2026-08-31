import {writeFile} from 'node:fs/promises';
import {PostgresTaskStore} from '../modules/tasks/src/postgres-task-store.js';
import {runDurableTaskLoad} from '../modules/platform/src/durable-task-load.js';

const [outputPath]=process.argv.slice(2);
if(!outputPath||process.env.NUVRION_QUALIFICATION_ACK!=='synthetic-only'||!process.env.NUVRION_DATABASE_URL)throw new Error('Usage: NUVRION_QUALIFICATION_ACK=synthetic-only NUVRION_DATABASE_URL=... node tools/run-durable-task-load.js <evidence.json>');
const count=Number(process.env.NUVRION_TASK_LOAD_COUNT??200),concurrency=Number(process.env.NUVRION_TASK_LOAD_CONCURRENCY??25),timeoutMs=Number(process.env.NUVRION_TASK_LOAD_TIMEOUT_MS??30000),store=await PostgresTaskStore.connect(process.env.NUVRION_DATABASE_URL);
try{
  const evidence=await runDurableTaskLoad({store,count,concurrency,timeoutMs});
  const pending=await store.pool.query("SELECT count(*)::int count FROM operations.outbox_messages o JOIN operations.tasks t ON t.task_id=o.message_key::uuid WHERE t.target_type='qualification_synthetic' AND t.provider_native_id LIKE $1 AND o.published_at IS NULL",[`qualification:${evidence.runId}:%`]);
  evidence.unpublishedQualificationOutboxMessages=pending.rows[0].count;
  if(evidence.unpublishedQualificationOutboxMessages)evidence.status='failed';
  await writeFile(outputPath,JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify({status:evidence.status,taskCount:evidence.taskCount,p95CompletionMs:evidence.p95CompletionMs,throughputPerSecond:evidence.throughputPerSecond,lostTasks:evidence.lostTasks,duplicateOperations:evidence.duplicateOperations,outputPath}));
  if(evidence.status!=='passed')process.exitCode=1;
}finally{await store.close();}

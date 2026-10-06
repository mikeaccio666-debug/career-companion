import { createProviderRuntime } from '@companion/ai-core';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { createStorage } from './storage.ts';
import { createWorker, JobService, recoverInterrupted } from './jobs.ts';
import { startAccountEmailWorker } from './account-mail.ts';
import { startWorkerHeartbeat } from './worker-heartbeat.ts';
const config=readConfig(),db=new Database(config.databaseUrl,{max:config.databasePoolMax,connectionTimeoutMillis:config.databaseConnectTimeoutMs});
const jobs=new JobService(db,config,createProviderRuntime(),createStorage(config));
await db.query('SELECT 1');await recoverInterrupted(jobs);
const worker=createWorker(jobs);
const accountEmailWorker=startAccountEmailWorker(db,config.accountEmail);
worker.on('error',()=>{process.stderr.write('Worker connection interrupted; waiting for recovery.\n');});
const heartbeat=startWorkerHeartbeat({db,worker,queueName:config.queueName,codeVersion:config.codeVersion});
let closing=false,recovering:Promise<void>|undefined,shutdown:Promise<void>|undefined;
const recovery=setInterval(()=>{
  if(closing||recovering)return;
  const current=recoverInterrupted(jobs).then(()=>{},()=>{}).finally(()=>{if(recovering===current)recovering=undefined;});
  recovering=current;
},15_000);recovery.unref();
process.stdout.write('Platform task worker started.\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
  if(shutdown)return;
  closing=true;clearInterval(recovery);
  shutdown=(async()=>{
    await heartbeat.stop();
    await recovering;
    // BullMQ close waits for processors and has no built-in deadline. A stopping report is not proof of shutdown.
    const results=await Promise.allSettled([worker.close(),accountEmailWorker.close()]);
    await db.close();
    if(results.some(result=>result.status==='rejected'))throw new Error('Worker shutdown could not be confirmed.');
  })();
  void shutdown.then(()=>process.exit(0),()=>{process.stderr.write('Worker shutdown could not be confirmed.\n');process.exit(1);});
});

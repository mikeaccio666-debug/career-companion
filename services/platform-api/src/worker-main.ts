import { UploadWrites } from './upload-writes.ts';
import { MentorFinancialLedger } from './mentor-financial-ledger.ts';
import { UploadRemovals } from './upload-removals.ts';
import { purgeExpiredMemoryDeletions } from './memory-retention.ts';
import { loadLegalBundle } from './legal-documents.ts';
import { createProviderRuntime } from '@companion/ai-core';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { createStorage } from './storage.ts';
import { createWorker, JobService, recoverInterrupted } from './jobs.ts';
import { startAccountEmailWorker } from './account-mail.ts';
import { startWorkerHeartbeat } from './worker-heartbeat.ts';
import { CompanionEntry } from './companion-entry.ts';
import { requireModelConsent } from './model-consent.ts';
import { CompanionGenerationQueue, createCompanionGenerationWorker, reconcileCompanionAccounting } from './companion-generation-queue.ts';
import { createCompanionStudentOnboarding } from './companion-student-onboarding.ts';
import { readCompanionSafetyResourceConfiguration } from './companion-safety-resources.ts';
import { CompanionNameQueue, createCompanionNameWorker } from './companion-name-queue.ts';
const config=readConfig(),db=new Database(config.databaseUrl,{max:config.databasePoolMax,connectionTimeoutMillis:config.databaseConnectTimeoutMs});
const legal=await loadLegalBundle(config.legalBundlePath),runtime=requireModelConsent(createProviderRuntime());
const storage=createStorage(config),uploadRemovals=new UploadRemovals(db,config.dataCrypto,storage),uploadWrites=new UploadWrites(db,config.dataCrypto,storage);
const jobs=new JobService(db,config,runtime,storage,undefined,undefined,legal);
const companion=new CompanionEntry(db,config,legal,runtime);
const safetyResourcesConfiguration=await readCompanionSafetyResourceConfiguration(config);
const studentOnboarding=await createCompanionStudentOnboarding(db,config,legal,runtime,companion.generation,safetyResourcesConfiguration.review);
const naming=studentOnboarding.naming;
await db.query('SELECT 1');await recoverInterrupted(jobs);
await reconcileCompanionAccounting(companion);
await purgeExpiredMemoryDeletions(db);
const mentorFinancialRetention=config.dataCrypto?new MentorFinancialLedger(config):null;
if(mentorFinancialRetention)await mentorFinancialRetention.purgeExpired(db);
if(config.dataCrypto){await uploadRemovals.recover();await uploadWrites.recover();}
const worker=createWorker(jobs);
const companionWorker=createCompanionGenerationWorker(companion),companionQueue=new CompanionGenerationQueue(companion);
const companionNameWorker=createCompanionNameWorker(naming),companionNameQueue=new CompanionNameQueue(naming);
companionQueue.start();
companionNameQueue.start();
const accountEmailWorker=startAccountEmailWorker(db,config.accountEmail);
worker.on('error',()=>{process.stderr.write('Worker connection interrupted; waiting for recovery.\n');});
const heartbeat=startWorkerHeartbeat({db,worker,queueName:config.queueName,codeVersion:config.codeVersion});
let closing=false,recovering:Promise<void>|undefined,shutdown:Promise<void>|undefined;
const recovery=setInterval(()=>{
  if(closing||recovering)return;
  const current=Promise.allSettled([recoverInterrupted(jobs),reconcileCompanionAccounting(companion),purgeExpiredMemoryDeletions(db),...(mentorFinancialRetention?[mentorFinancialRetention.purgeExpired(db).catch(()=>{process.stderr.write('Mentor financial retention maintenance failed.\n');})]:[]),...(config.dataCrypto?[uploadRemovals.recover(),uploadWrites.recover()]:[])]).then(()=>{}).finally(()=>{if(recovering===current)recovering=undefined;});
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
    const results=await Promise.allSettled([worker.close(),accountEmailWorker.close(),companionWorker.close(),companionQueue.close(),
      companionNameWorker.close(),companionNameQueue.close()]);
    await db.close();
    if(results.some(result=>result.status==='rejected'))throw new Error('Worker shutdown could not be confirmed.');
  })();
  void shutdown.then(()=>process.exit(0),()=>{process.stderr.write('Worker shutdown could not be confirmed.\n');process.exit(1);});
});

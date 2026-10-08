import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Worker } from 'bullmq';
import type { CompanionNamingAccepted } from '@companion/platform-contracts';
import { CompanionNameQueue, companionNameQueueName, createCompanionNameWorker } from '../src/companion-name-queue.ts';
import { ProducerQueue } from '../src/queue-connection.ts';
import { createNamingDispatchFixture, dispatchBytes, type NamingDispatchFixture } from './fixtures/companion-name-dispatch.ts';
import { withPrebirthLoopback } from './fixtures/companion-prebirth.ts';

const refs=(saved:CompanionNamingAccepted)=>({dispatchId:saved.acceptance.dispatchId,taskId:saved.acceptance.taskId,submissionId:saved.acceptance.submissionId});
const classifierCalls=(requests:Record<string,unknown>[])=>requests.filter(request=>request.model==='fictional-prebirth-classifier').length;
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function eventually(check:()=>Promise<boolean>,message:string) {
  const end=Date.now()+8000;
  while(!await check()){if(Date.now()>end)assert.fail(message);await delay(25);}
}
async function source(f:NamingDispatchFixture,id:string) {
  const row=(await f.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[id,f.who.userId])).rows[0];
  assert(row);return row;
}
async function notificationDue(f:NamingDispatchFixture,id:string) {
  // Only notification scheduling metadata changes. Never edit claims, leases,
  // results, original authorization, encrypted journals or source generations.
  await f.db.query("UPDATE platform_companion_name_dispatch_outbox SET dispatched_at=clock_timestamp()-interval '1 minute' WHERE dispatch_id=$1 AND user_id=$2",[id,f.who.userId]);
}
function queueFixture(f:NamingDispatchFixture) {
  const queues:CompanionNameQueue[]=[],workers:Worker[]=[],control=new ProducerQueue(companionNameQueueName(f.config.queueName),f.config.redisUrl);
  return {control,
    producer(){const queue=new CompanionNameQueue(f.naming);queues.push(queue);return queue;},
    worker(){const worker=createCompanionNameWorker(f.naming);workers.push(worker);return worker;},
    async close(){
      const failures:unknown[]=[];
      for(const closers of [workers,queues]) {
        for(const result of await Promise.allSettled(closers.map(item=>item.close())))
          if(result.status==='rejected')failures.push(result.reason);
      }
      // This UUID namespace belongs to this fixture alone. Never FLUSHDB or
      // remove another application/worker's notifications.
      try{await control.obliterate({force:true});}catch(error){failures.push(error);}
      try{await control.close();}catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,'Owned naming queue cleanup did not complete.');
    },
  };
}
async function closeFixture(q:ReturnType<typeof queueFixture>,f:NamingDispatchFixture) {
  const failures:unknown[]=[];
  try{await q.close();}catch(error){failures.push(error);}
  try{await f.close();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Owned naming queue/schema cleanup did not complete.');
}

test('real naming Redis loss rebuilds reference-only notifications and duplicate producers/workers classify once',async()=>withPrebirthLoopback(async(runtime,requests)=>{
  const f=await createNamingDispatchFixture(runtime),q=queueFixture(f);
  try {
    const command=f.command('Fictional raw Juno'),saved=await f.naming.accept(f.who,command),reference=refs(saved);
    const producer=q.producer(),otherProducer=q.producer();
    await producer.dispatch();
    const first=await q.control.getJob(reference.dispatchId);assert(first);
    assert.equal(first.id,reference.dispatchId);assert.equal(first.name,'companion-name');
    assert.deepEqual(first.data,reference);assert.deepEqual(Object.keys(first.data).sort(),['dispatchId','submissionId','taskId']);
    assert.equal(JSON.stringify(first.data).includes(command.name),false);
    const beforeLoss=await dispatchBytes(f);
    await q.control.obliterate({force:true});
    assert.equal(await q.control.getJob(reference.dispatchId),undefined);
    assert.deepEqual(await dispatchBytes(f),beforeLoss);
    await notificationDue(f,reference.dispatchId);
    const one=producer.dispatch();assert.equal(producer.dispatch(),one);
    await Promise.all([one,otherProducer.dispatch()]);
    assert.equal(await q.control.getWaitingCount(),1);
    const restored=await q.control.getJob(reference.dispatchId);assert(restored);assert.deepEqual(restored.data,reference);
    q.worker();q.worker();
    await eventually(async()=>{const state=await f.naming.readOperation(f.who,command.operationId);return state?.progress.application.status==='name_rejected';},'Recovered naming did not finish its real semantic validation.');
    const done=await source(f,reference.submissionId);
    assert.equal(done.status,'detected');assert.equal(done.generation,1);assert.equal(done.level,'L0');assert.equal(done.detector_mode,'full');
    assert.equal(done.application_status,'name_rejected');assert.equal(done.rejected_category,'length');
    assert.equal(classifierCalls(requests),1);
    assert.equal((await f.db.query("SELECT call_id FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1",[reference.submissionId])).rowCount,1);
    const completedBytes=await dispatchBytes(f);
    await Promise.all([f.naming.executeNotification(reference),f.naming.executeNotification(reference)]);
    assert.deepEqual(await dispatchBytes(f),completedBytes);assert.equal(classifierCalls(requests),1);
  } finally {await closeFixture(q,f);}
}));

test('poisoned naming notifications are isolated while a genuine source progresses in the same owned Redis queue',async()=>withPrebirthLoopback(async(runtime,requests)=>{
  const f=await createNamingDispatchFixture(runtime),q=queueFixture(f);
  try {
    const bad=await f.naming.accept(f.who,f.command('Juno'));
    const goodCommand=f.command('Milo',1,0),good=await f.naming.accept(f.who,goodCommand);
    const badRefs=refs(bad),goodRefs=refs(good);
    // The extra raw field is hostile Redis data, never accepted model authority.
    await q.control.add('companion-name',{...badRefs,name:'Fictional poisoned text'},
      {jobId:badRefs.dispatchId,delay:60000,attempts:1});
    const producer=q.producer();await producer.dispatch();
    const held=(await f.db.query('SELECT held_reason FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1',[badRefs.dispatchId])).rows[0];
    assert.equal(held.held_reason,'storage');
    const genuine=await q.control.getJob(goodRefs.dispatchId);assert(genuine);assert.deepEqual(genuine.data,goodRefs);
    const badBefore=await source(f,badRefs.submissionId);
    const malformedId=randomUUID();
    await q.control.add('companion-name',goodRefs,{jobId:malformedId,attempts:1});
    q.worker();
    await eventually(async()=>(await source(f,goodRefs.submissionId)).status==='detected','A different poisoned job blocked genuine classification.');
    await eventually(async()=>await (await q.control.getJob(malformedId))?.getState()==='failed','The unbound notification was not rejected by the real worker.');
    assert.deepEqual(await source(f,badRefs.submissionId),badBefore);
    const malformed=await q.control.getJob(malformedId);assert(malformed);
    assert.equal(malformed.failedReason,'Naming notification could not be verified.');
    const actual=await source(f,goodRefs.submissionId);
    assert.equal(actual.generation,1);assert.equal(actual.level,'L0');assert.equal(actual.detector_mode,'full');assert.equal(classifierCalls(requests),1);
    assert.equal((await f.db.query("SELECT call_id FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1",[badRefs.submissionId])).rowCount,0);
  } finally {await closeFixture(q,f);}
}));

test('real producer retries a classified requires-review application after an older source completes without reclassifying',async()=>withPrebirthLoopback(async(runtime,requests)=>{
  const f=await createNamingDispatchFixture(runtime),q=queueFixture(f);
  try {
    const older=await f.naming.accept(f.who,f.command('Juno'));
    // The fictional reviewed fixture configures an English seal alias for
    // Juno. An unconfigured alias would correctly hold the application.
    const currentCommand=f.command('Juno',1,0),current=await f.naming.accept(f.who,currentCommand),currentRefs=refs(current);
    // Deliver only the newer source through actual Redis first. The older raw
    // source is genuinely pending, so the complete prebirth barrier must hold.
    await q.control.add('companion-name',currentRefs,{jobId:currentRefs.dispatchId,attempts:1});
    const firstWorker=q.worker();
    await eventually(async()=>{
      const row=(await f.db.query('SELECT held_reason FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1',[currentRefs.dispatchId])).rows[0];
      return row.held_reason==='requires_review'&&await (await q.control.getJob(currentRefs.dispatchId))?.getState()==='completed';
    },'The real worker did not retain its classified application hold.');
    await firstWorker.close();
    const blocked=await source(f,currentRefs.submissionId);
    assert.equal(blocked.status,'detected');assert.equal(blocked.generation,1);assert.equal(blocked.level,'L0');assert.equal(blocked.detector_mode,'full');
    assert.equal(blocked.application_status,'pending');assert.equal(classifierCalls(requests),1);
    assert.equal((await source(f,older.acceptance.submissionId)).status,'pending');
    // Finish the older original source through its authenticated accepted path.
    // No source damage, lease edits, invented classifications or reset occurs.
    await f.naming.executeNotification(refs(older));
    assert.equal((await source(f,older.acceptance.submissionId)).status,'detected');assert.equal(classifierCalls(requests),2);
    const classificationsDone=classifierCalls(requests),producer=q.producer();
    await producer.dispatch();
    const rebuilt=await q.control.getJob(currentRefs.dispatchId);assert(rebuilt);
    assert.equal(await rebuilt.getState(),'waiting');assert.deepEqual(rebuilt.data,currentRefs);
    q.worker();
    await eventually(async()=>(await f.naming.readOperation(f.who,currentCommand.operationId))?.progress.application.status==='applied','Saved classification did not resume its application stage.');
    const applied=await source(f,currentRefs.submissionId);
    assert.equal(applied.generation,blocked.generation);assert.deepEqual(applied.result_ciphertext,blocked.result_ciphertext);
    assert.deepEqual(applied.claim_ciphertext,blocked.claim_ciphertext);assert.deepEqual(applied.request_ciphertext,blocked.request_ciphertext);
    assert.equal(applied.application_status,'applied');assert.equal(classifierCalls(requests),classificationsDone);
    const state=await f.naming.readOperation(f.who,currentCommand.operationId);assert(state);
    assert.equal(state.progress.phase,'detected');assert.equal(state.progress.hold,null);assert.equal(state.progress.application.identityRevision,1);
    assert.equal((await f.db.query("SELECT call_id FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1",[currentRefs.submissionId])).rowCount,1);
    const journal=(await f.db.query('SELECT kind FROM platform_companion_name_dispatch_operations WHERE dispatch_id=$1 ORDER BY revision',[currentRefs.dispatchId])).rows.map(row=>row.kind);
    assert.deepEqual(journal,['claim','start','detected','hold','application']);
  } finally {await closeFixture(q,f);}
}));

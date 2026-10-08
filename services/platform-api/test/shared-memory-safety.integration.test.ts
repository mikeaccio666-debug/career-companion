import { purgeExpiredMemoryDeletions } from '../src/memory-retention.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/errors.ts';
import { SharedMemories } from '../src/shared-memories.ts';
import { SharedMemorySafety } from '../src/shared-memory-safety.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { createMemorySafetyLoopback,MEMORY_PROFILE,MEMORY_PROFILE_CONTENT,memoryReply } from './fixtures/shared-memory-safety.ts';
import { expectedSafetyProfileDigests,parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,memories:SharedMemories,loop:Awaited<ReturnType<typeof createMemorySafetyLoopback>>;
before(async()=>{f=await createCompanionNameSafetyFixture();memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);loop=await createMemorySafetyLoopback(f,memories);});
after(async()=>{try{await loop?.close();}finally{await f?.close();}});
const command=(content='Fictional confirmed preference')=>({operationId:randomUUID(),content,category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
const bad=(e:unknown)=>e instanceof ApiError;
async function select(who:Awaited<ReturnType<typeof f.actor>>,patch:Record<string,unknown>={}){return f.db.withBoundedTransaction(c=>memories.selectInTransaction(c,who,{ownerId:who.userId,speaker:'companion',channel:'web',purpose:'chat',now:new Date().toISOString(),intentKeys:[],userRaisedMemoryIds:[],selfSetReminderMemoryIds:[],...patch}));}
async function usage(userId:string){return (await f.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1 ORDER BY created_at',[userId])).rows;}
function reset(){loop.setHandler((_b,r)=>memoryReply(r));}

test('only actual admitted complete classifier output unlocks an owner-confirmed current memory, without inventing a turn or use',async()=>{
 reset();const who=await f.actor(),saved=await memories.mutate(who,'create',null,command());assert.equal((await select(who)).useReferences.length,0);
 const calls=loop.bodies.length;await loop.safety.runCurrent(who,saved.memory.id);assert.equal(loop.bodies.length,calls+1);
 assert.equal((await select(who)).current[0].content,saved.memory.content);assert.equal((await loop.safety.observe(who,saved.memory.id)).status,'clear');
 assert.equal(await loop.safety.runCurrent(who,saved.memory.id),null);assert.equal(loop.bodies.length,calls+1);
 const row=(await f.db.query('SELECT * FROM platform_memory_safety_sources WHERE memory_id=$1',[saved.memory.id])).rows[0];assert.equal(row.status,'detected');assert.equal(row.level,'L0');assert.equal(row.detector_mode,'full');assert(!row.source_ciphertext.includes(Buffer.from(saved.memory.content)));
 const actual=await usage(who.userId);assert.equal(actual.length,1);assert.equal(actual[0].source_kind,'shared_memory');assert.equal(actual[0].purpose,'safety_classify');assert.equal(actual[0].status,'complete');assert.equal(actual[0].input_tokens,34);assert.equal(actual[0].output_tokens,8);
 assert.equal((await f.db.query('SELECT id FROM platform_memory_uses WHERE user_id=$1',[who.userId])).rowCount,0);assert.equal((await memories.get(who,saved.memory.id)).revision,1);
});

test('unconfigured profile or disabled provider never manufactures L0; actual reviewed keywords retain risk without model I/O',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());const calls=loop.bodies.length;
 const none=new SharedMemorySafety(f.db,loop.config,FICTIONAL_LEGAL,memories,loop.runtime,null);await assert.rejects(none.runCurrent(who,a.memory.id),bad);assert.equal((await none.observe(who,a.memory.id)).status,'unavailable');
 const disabled=new SharedMemorySafety(f.db,loop.config,FICTIONAL_LEGAL,memories,loop.makeRuntime({PLATFORM_ALLOW_PROVIDER_CALLS:'0'}),MEMORY_PROFILE);
 await assert.rejects(disabled.runCurrent(who,a.memory.id),bad);assert.equal((await select(who)).useReferences.length,0);assert.equal((await usage(who.userId)).length,0);
 const risk=await memories.mutate(who,'create',null,command('Fictional Synthetic high marker'));await disabled.runCurrent(who,risk.memory.id);assert.equal((await disabled.observe(who,risk.memory.id)).status,'blocked');assert.equal(loop.bodies.length,calls);assert.equal((await select(who)).useReferences.length,0);
});

test('privacy changes reuse only actual same-body classification; changed text and another memory need their own genuine source',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);const calls=loop.bodies.length;
 await memories.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,sensitivity:'restricted'});assert.equal(await loop.safety.runCurrent(who,a.memory.id),null);assert.equal(loop.bodies.length,calls);
 assert.equal((await select(who)).useReferences.length,0);assert.equal((await select(who,{userRaisedMemoryIds:[a.memory.id]})).current[0].revision,2);
 await memories.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:2,content:'Fictional changed actual body'});assert.equal((await select(who,{userRaisedMemoryIds:[a.memory.id]})).useReferences.length,0);await loop.safety.runCurrent(who,a.memory.id);
 const copy=await memories.mutate(who,'create',null,command('Fictional changed actual body'));assert.equal((await select(who)).useReferences.length,0);await loop.safety.runCurrent(who,copy.memory.id);assert.equal(loop.bodies.length,calls+2);
});

test('a genuine content change while the HTTP request is pending prevents publication but retains actual measured expenditure',async()=>{
 const who=await f.actor(),a=await memories.mutate(who,'create',null,command());loop.setHandler(async(_b,r)=>{await memories.mutate(who,'edit',a.memory.id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional newer body'});memoryReply(r);});
 await assert.rejects(loop.safety.runCurrent(who,a.memory.id),bad);assert.equal((await select(who)).useReferences.length,0);
 const actual=await usage(who.userId);assert.equal(actual.length,1);assert.equal(actual[0].status,'complete');assert.equal(actual[0].usage_status,'reported');
 assert.equal((await f.db.query("SELECT id FROM platform_memory_safety_sources WHERE user_id=$1 AND status='detected'",[who.userId])).rowCount,0);reset();await loop.safety.runCurrent(who,a.memory.id);assert.equal((await select(who)).current[0].content,'Fictional newer body');
});

test('real auth reset at the request preserves costs and denies the old captured session and result',async()=>{
 const who=await f.actor(),a=await memories.mutate(who,'create',null,command());loop.setHandler(async(_b,r)=>{await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);memoryReply(r);});
 await assert.rejects(loop.safety.runCurrent(who,a.memory.id),bad);assert.equal((await usage(who.userId))[0].status,'complete');
 await assert.rejects(loop.safety.observe(who,a.memory.id),bad);assert.equal((await f.db.query("SELECT id FROM platform_memory_safety_sources WHERE user_id=$1 AND status='detected'",[who.userId])).rowCount,0);reset();
});

test('owner/session, current legal consent and real active profile are rechecked before any classifier launch',async()=>{
 reset();const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),a=await memories.mutate(who,'create',null,command()),calls=loop.bodies.length;
 for(const actor of [other,staff])await assert.rejects(loop.safety.runCurrent(actor,a.memory.id),bad);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(loop.safety.runCurrent(who,a.memory.id),bad);
 const own=await f.actor(),b=await memories.mutate(own,'create',null,command());await f.db.query('UPDATE platform_safety_detector_policy SET revision=revision+1 WHERE singleton=true');
 await assert.rejects(loop.safety.runCurrent(own,b.memory.id),bad);assert.equal((await select(own)).useReferences.length,0);assert.equal(loop.bodies.length,calls);await loop.activate();
});

test('completed captures and decisions cannot be rewritten or deleted while their actual memory exists; usage corruption fails closed',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);
 await assert.rejects(f.db.query('DELETE FROM platform_memory_safety_sources WHERE memory_id=$1',[a.memory.id]));
 await assert.rejects(f.db.query("UPDATE platform_memory_safety_sources SET level='L2' WHERE memory_id=$1",[a.memory.id]));
 await f.db.query('UPDATE platform_safety_model_usage SET input_tokens=input_tokens+1 WHERE memory_id=$1',[a.memory.id]);await assert.rejects(select(who),bad);
});

test('current profile replacement requires a new actual source, with no reinterpretation of historical results',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);const calls=loop.bodies.length;
 const content={...MEMORY_PROFILE_CONTENT,revision:272},profile=parseSafetyDetectorProfile({...content,...expectedSafetyProfileDigests(content)});await loop.activate(profile);
 assert.equal((await select(who)).useReferences.length,0);const newer=new SharedMemorySafety(f.db,loop.config,FICTIONAL_LEGAL,memories,loop.runtime,profile);await newer.runCurrent(who,a.memory.id);
 assert.equal(loop.bodies.length,calls+1);assert.equal((await select(who)).current.length,1);assert.equal((await f.db.query('SELECT id FROM platform_memory_safety_sources WHERE memory_id=$1',[a.memory.id])).rowCount,2);await loop.activate();
});

test('classification refuses an uncooperative runtime within the deadline and never stores its fabricated L0',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());
 const runtime={...loop.runtime,async *streamModelStep(){await new Promise(()=>{});return {text:'{"level":"L0"}',calls:[]};}};
 const slow=new SharedMemorySafety(f.db,loop.config,FICTIONAL_LEGAL,memories,runtime,MEMORY_PROFILE),at=Date.now();await assert.rejects(slow.runCurrent(who,a.memory.id),bad);assert(Date.now()-at<2000);assert.equal((await select(who)).useReferences.length,0);
});

test('an actually deleted account cascades private classifier captures and its usage, without defeating immutable-source constraints',async()=>{
 reset();const who=await f.actor(),a=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,a.memory.id);await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);
 assert.equal((await f.db.query('SELECT id FROM platform_memory_safety_sources WHERE user_id=$1',[who.userId])).rowCount,0);assert.equal((await usage(who.userId)).length,0);
});


test('changing or physically forgetting a detected risk cannot clear its actual pending safety response',async()=>{
 reset();const who=await f.actor(),risk=await memories.mutate(who,'create',null,command('Fictional Synthetic high marker'));await loop.safety.runCurrent(who,risk.memory.id);
 await memories.mutate(who,'edit',risk.memory.id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional neutral edited body'});await loop.safety.runCurrent(who,risk.memory.id);
 assert.equal((await select(who)).useReferences.length,0);assert.equal((await loop.safety.observe(who,risk.memory.id)).status,'blocked');
 await memories.mutate(who,'delete',risk.memory.id,{operationId:randomUUID(),expectedRevision:2});await new Promise(resolve=>setTimeout(resolve,10100));await purgeExpiredMemoryDeletions(f.db);
 assert.equal((await f.db.query('SELECT id FROM platform_memory_safety_sources WHERE memory_id=$1',[risk.memory.id])).rowCount,0);
 const blocks=(await f.db.query('SELECT * FROM platform_memory_safety_blocks WHERE user_id=$1',[who.userId])).rows;assert.equal(blocks.length,1);assert(!blocks[0].receipt_ciphertext.includes(Buffer.from('Fictional Synthetic high marker')));
 await assert.rejects(f.db.query('DELETE FROM platform_memory_safety_blocks WHERE user_id=$1',[who.userId]));
 const next=await memories.mutate(who,'create',null,command('Fictional different neutral memory'));await loop.safety.runCurrent(who,next.memory.id);assert.equal((await select(who)).useReferences.length,0);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);assert.equal((await f.db.query('SELECT id FROM platform_memory_safety_blocks WHERE user_id=$1',[who.userId])).rowCount,0);
});


test('actual onboarding expenditure shares the memory quota; historical unknown usage cannot be reset by a new memory source',async()=>{
 for(const mode of ['capped','unknown'] as const){
  const who=await f.actor(),started=await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'fast_track'}});
  await f.store.save(who,{operationId:randomUUID(),expectedRevision:started.draft.revision,action:{kind:'text',questionId:'study',text:'Fictional coursework budget source'}});
  loop.setHandler((_b,r)=>memoryReply(r,{level:'L0',resolution:{kind:'unmatched'}},mode==='unknown'?null:{input_tokens:34,output_tokens:8}));
  const calls=loop.bodies.length;await new OnboardingSafetyRunner(f.store,{...loop.config,safetyDailyModelCallLimit:1},loop.runtime,MEMORY_PROFILE).runNext(who);
  assert.equal(loop.bodies.length,calls+1);assert.equal((await usage(who.userId))[0].source_kind,'onboarding');
  if(mode==='unknown')await f.db.query("UPDATE platform_safety_model_usage SET created_at=clock_timestamp()-interval '2 days' WHERE user_id=$1",[who.userId]);
  reset();const saved=await memories.mutate(who,'create',null,command());
  const capped=new SharedMemorySafety(f.db,{...loop.config,safetyDailyModelCallLimit:mode==='unknown'?10:1},FICTIONAL_LEGAL,memories,loop.runtime,MEMORY_PROFILE);
  await assert.rejects(capped.runCurrent(who,saved.memory.id),bad);assert.equal(loop.bodies.length,calls+1);assert.equal((await usage(who.userId)).length,1);assert.equal((await select(who)).useReferences.length,0);
  const high=await memories.mutate(who,'create',null,command('Fictional Synthetic high marker'));await capped.runCurrent(who,high.memory.id);
  assert.equal((await capped.observe(who,high.memory.id)).status,'blocked');assert.equal(loop.bodies.length,calls+1);
 }
});

test('a real completed memory classifier call also consumes the onboarding account cap',async()=>{
 reset();const who=await f.actor(),saved=await memories.mutate(who,'create',null,command());await loop.safety.runCurrent(who,saved.memory.id);const calls=loop.bodies.length;
 const started=await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'fast_track'}});
 await f.store.save(who,{operationId:randomUUID(),expectedRevision:started.draft.revision,action:{kind:'text',questionId:'study',text:'Fictional later coursework source'}});
 await assert.rejects(new OnboardingSafetyRunner(f.store,{...loop.config,safetyDailyModelCallLimit:1},loop.runtime,MEMORY_PROFILE).runNext(who),bad);
 assert.equal(loop.bodies.length,calls);assert.equal((await usage(who.userId)).length,1);
});

test('a reviewed L1 keyword cannot be downgraded by a completed provider L0 reply',async()=>{
 reset();const who=await f.actor(),saved=await memories.mutate(who,'create',null,command('Fictional Synthetic low marker'));const calls=loop.bodies.length;
 await loop.safety.runCurrent(who,saved.memory.id);assert.equal(loop.bodies.length,calls+1);
 const row=(await f.db.query('SELECT level,detector_mode FROM platform_memory_safety_sources WHERE memory_id=$1',[saved.memory.id])).rows[0];
 assert.equal(row.level,'L1');assert.equal(row.detector_mode,'full');assert.equal((await loop.safety.observe(who,saved.memory.id)).status,'blocked');assert.equal((await select(who)).useReferences.length,0);
});

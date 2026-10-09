import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Worker} from 'bullmq';
import {createProviderRuntime} from '@companion/ai-core';
import {readConfig} from '../src/config.ts';
import {FirstLetterTasks} from '../src/first-letter-tasks.ts';
import {FirstLetterSources} from '../src/first-letter-sources.ts';
import {FirstLetterGeneration} from '../src/first-letter-generation.ts';
import {FirstLetterDispatch} from '../src/first-letter-dispatch.ts';
import {FirstLetterQueue,firstLetterQueueName,createFirstLetterWorker} from '../src/first-letter-queue.ts';
import {ProducerQueue} from '../src/queue-connection.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
const settings={rosterRevision:1,enabledExperts:[] as const,localDate:'2026-10-09'},model='fictional-first-letter-queue';
async function fixture(){
 const f=await createPrebirthFixture(),base=readConfig();
 assert(['127.0.0.1','localhost','[::1]'].includes(new URL(base.redisUrl).hostname));
 const config={...base,...f.config,queueName:'fictional-first-letter-'+randomUUID(),modelRoutes:{...f.config.modelRoutes,first_letter_generation:{provider:'openai'}}};
 for(const [unit,price] of [['input_token','1'],['cached_input_token','1'],['cache_write_input_token','1'],['output_token','2']])
  await f.db.query("INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from) VALUES($1,'openai',$2,'background',$3,$4,clock_timestamp())",[randomUUID(),model,unit,price]);
 let calls=0;
 async function actor(){
  let result:any;
  await withPrebirthLoopback(async birthRuntime=>{
   const who=await f.actor();
   let draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'standard'}})).draft;
   while(draft.currentQuestion){
    const question=draft.currentQuestion,value=question==='study'?{degreeField:'ds_statistics',programChoice:'24_month'}:question==='search_stage'?'applying':undefined;
    draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:draft.revision,action:value===undefined?{kind:'skip',questionId:question}:{kind:'answer',questionId:question,value}} as any)).draft;
   }
   const b=await readyBirth(f,birthRuntime,{who}),birth=await b.service.birth(who,b.body,b.key);
   const welcome=new CompanionWelcomeService(f.db,f.config,FICTIONAL_LEGAL,new CompanionBirthOriginStore(f.crypto),b.prebirth);
   const opened=await welcome.open(who,{expectedCompanionId:birth.receipt.identity.companionId});
   await welcome.choose(who,{welcomeId:opened.id,expectedRevision:1,operationId:randomUUID(),choice:'direct_letter'});
   const sources=new FirstLetterSources(f.db,f.config,FICTIONAL_LEGAL,b.ready.background,b.prebirth),tasks=new FirstLetterTasks(f.db,f.config,sources);
   const saved=await tasks.prepare(who,settings);
   const body='我是'+saved.preparation.signature.name+'，名字是你起的。我是 AI。只记你同意的；在「我 → 它记得的你」可查看、修改、删除。'+
    '要发给别人的消息和材料，都先进待确认；表单里哪些项可以替你做，由你在对话里逐项确认；最终提交永远由你本人点。'+
    '你填的专业是 DS / 统计，目前在投，还没面试。接下来一起看今天的三件事。';
   const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-injected-only',OPENAI_FIRST_LETTER_MODEL:model},
    fetch:async(target,init)=>{
     assert.equal(String(target),'https://api.openai.com/v1/responses');const request=JSON.parse(String(init?.body));
     assert.equal(request.model,model);assert.equal(request.store,false);assert.deepEqual(request.tools,[]);calls++;
     const text=request.text.format.name==='career_first_letter_review'?JSON.stringify({
      checks:Object.fromEntries(['identity','memory','external_actions','user_facts','experts','today','language_personality','prohibited_content'].map(k=>[k,'supported'])),
      references:{study:'supported',search_stage:'supported'}}):JSON.stringify({body,factReferences:[{ref:'study',quote:'DS / 统计'},{ref:'search_stage',quote:'在投，还没面试'}]});
     return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:10},
      output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]}})+'\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
    }});
   const generation=new FirstLetterGeneration(f.db,config,runtime,tasks),entry=new FirstLetterDispatch(f.db,config,runtime,tasks,generation);
   const accepted=await entry.accept(who,{operationId:randomUUID(),taskId:saved.task.taskId,expectedPreparationId:saved.task.preparationId},settings);
   result={who,saved,generation,entry,refs:{requestId:accepted.request.requestId,taskId:saved.task.taskId}};
  });return result;
 }
 const queues:FirstLetterQueue[]=[],workers:Worker[]=[],control=new ProducerQueue(firstLetterQueueName(config.queueName),config.redisUrl);
 return {...f,config,actor,control,get calls(){return calls;},
  producer(entry:FirstLetterDispatch){const q=new FirstLetterQueue(entry);queues.push(q);return q;},
  worker(entry:FirstLetterDispatch){const w=createFirstLetterWorker(entry,()=>settings);workers.push(w);return w;},
  async close(){
   const failures:unknown[]=[];
   for(const closers of [workers,queues])for(const r of await Promise.allSettled(closers.map(x=>x.close())))if(r.status==='rejected')failures.push(r.reason);
   try{await control.obliterate({force:true});}catch(e){failures.push(e);}
   try{await control.close();}catch(e){failures.push(e);}
   try{await f.close();}catch(e){failures.push(e);}
   if(failures.length)throw new AggregateError(failures,'Owned first-letter fixtures did not close.');
  }};
}
async function eventually(check:()=>Promise<boolean>,message:string){
 const deadline=Date.now()+10000;
 while(!await check()){if(Date.now()>deadline)assert.fail(message);await new Promise(r=>setTimeout(r,25));}
}
const due=async(f:Awaited<ReturnType<typeof fixture>>,requestId:string)=>f.db.query("UPDATE platform_first_letter_outbox SET dispatched_at=clock_timestamp()-interval '1 minute' WHERE request_id=$1",[requestId]);
test('real Redis loss rebuilds only references; duplicate producers/workers complete one original and review',async()=>{
 const f=await fixture();
 try{
  const a=await f.actor(),q=f.producer(a.entry),other=f.producer(a.entry);await q.dispatch();
  const first=await f.control.getJob(a.refs.requestId);assert(first);assert.deepEqual(first.data,a.refs);assert.equal(first.name,'first-letter');
  assert.equal(f.calls,0);
  await f.control.obliterate({force:true});await due(f,a.refs.requestId);
  const running=q.dispatch();assert.equal(q.dispatch(),running);await Promise.all([running,other.dispatch()]);
  assert.equal(await f.control.getWaitingCount(),1);f.worker(a.entry);f.worker(a.entry);
  await eventually(async()=>(await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[a.refs.requestId])).rows[0].held_reason==='terminal','Letter was not completed by the real worker.');
  assert.equal((await a.generation.readReview(a.who,{taskId:a.refs.taskId},settings)).kind,'reviewed_draft');assert.equal(f.calls,2);
  await due(f,a.refs.requestId);await q.dispatch();assert.equal(f.calls,2);
  assert.equal((await a.entry.executeNotification(a.refs,settings)).kind,'reviewed');assert.equal(f.calls,2);
  const stages=(await f.db.query('SELECT stage FROM platform_first_letter_stages WHERE task_id=$1 ORDER BY stage',[a.refs.taskId])).rows;
  assert.deepEqual(stages.map(r=>r.stage),['review_original','write_original']);
 }finally{await f.close();}
});
test('malformed Redis content is held without execution and revoked original authorization never adopts a newer login',async()=>{
 const f=await fixture();
 try{
  const a=await f.actor(),q=f.producer(a.entry);
  await f.control.add('first-letter',{...a.refs,tokenHash:'fictional-forged'},{jobId:a.refs.requestId,delay:60000});
  await q.dispatch();
  assert.equal((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[a.refs.requestId])).rows[0].held_reason,'storage');
  const b=await f.actor();await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[b.who.userId,b.who.tokenHash]);
  await q.dispatch();f.worker(b.entry);
  await eventually(async()=>(await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[b.refs.requestId])).rows[0].held_reason==='authorization','Revoked request was not held.');
  assert.equal(f.calls,0);assert.equal((await f.db.query('SELECT * FROM platform_first_letter_stages')).rowCount,0);
 }finally{await f.close();}
});
for(const stage of ['write_original','review_original'] as const)test(stage+': budget-held queue work resumes the same uncalled stage after the real budget becomes available',async()=>{
 const f=await fixture();
 try{
  const a=await f.actor(),q=f.producer(a.entry);
  if(stage==='review_original')await a.generation.generate(a.who,{taskId:a.refs.taskId},settings);
  const priorCalls=f.calls;
  await f.db.query('UPDATE platform_cost_user_policy SET hard_micros=1 WHERE user_id=$1',[a.who.userId]);
  await q.dispatch();f.worker(a.entry);
  await eventually(async()=>(await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[a.refs.requestId])).rows[0].held_reason==='configuration','Budget failure was not held.');
  const initial=(await f.db.query('SELECT * FROM platform_first_letter_stages WHERE task_id=$1 AND stage=$2',[a.refs.taskId,stage])).rows[0];
  assert.equal(initial.status,'failed');assert.equal(initial.call_id,null);assert.equal(f.calls,priorCalls);
  assert.equal((await f.db.query("SELECT count(*) AS n FROM platform_cost_reservations WHERE source_kind='job' AND source_id=$1",[stage==='write_original'?a.refs.taskId:initial.id])).rows[0].n,'0');
  await f.db.query('UPDATE platform_cost_user_policy SET hard_micros=100000000 WHERE user_id=$1',[a.who.userId]);
  await due(f,a.refs.requestId);await q.dispatch();
  await eventually(async()=>(await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[a.refs.requestId])).rows[0].held_reason==='terminal','Budget-restored work did not complete.');
  assert.equal(f.calls,2);
  const original=(await f.db.query("SELECT id FROM platform_first_letter_stages WHERE task_id=$1 AND stage=$2",[a.refs.taskId,stage])).rows[0];
  assert.equal(original.id,initial.id);
 }finally{await f.close();}
});

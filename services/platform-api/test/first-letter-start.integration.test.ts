import {knowledgeAccessFixture} from './fixtures/knowledge-access-retention.ts';
import { workerProcessFixture } from './fixtures/first-letter-worker-process.ts';
import {FirstLetterProgressService} from '../src/first-letter-progress.ts';
import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProviderRuntime} from '@companion/ai-core';
import {agendaLocalDate} from '@companion/platform-contracts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {readConfig} from '../src/config.ts';
import {FirstLetterSources} from '../src/first-letter-sources.ts';
import {FirstLetterTasks} from '../src/first-letter-tasks.ts';
import {FirstLetterGeneration} from '../src/first-letter-generation.ts';
import {FirstLetterDispatch} from '../src/first-letter-dispatch.ts';
import {FirstLetterSettings} from '../src/first-letter-settings.ts';
import {FirstLetterStart} from '../src/first-letter-start.ts';
import {FirstLetterQueue,createFirstLetterWorker,firstLetterQueueName} from '../src/first-letter-queue.ts';
import {ProducerQueue} from '../src/queue-connection.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {CompanionDailySettingsService} from '../src/companion-daily-settings.ts';
import {tokenHash} from '../src/auth.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>;
const model='fictional-first-letter-start',prefs={timeZone:'America/New_York',morningTime:'09:00',quietStart:'22:30',quietEnd:'08:30',dailyMinutes:90,webAlert:'none' as const};
beforeEach(async()=>{
 f=await createPrebirthFixture();
 for(const [unit,price] of [['input_token','1'],['cached_input_token','1'],['cache_write_input_token','1'],['output_token','2']])
  await f.db.query("INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from) VALUES($1,'openai',$2,'background',$3,$4,clock_timestamp())",[randomUUID(),model,unit,price]);
});
afterEach(async()=>{await f?.close();});
async function actor(preferences=true,release=true){
 let result:any;
 await withPrebirthLoopback(async birthRuntime=>{
  const who=await f.actor();let draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'standard'}})).draft;
  while(draft.currentQuestion){
   const question=draft.currentQuestion,value=question==='study'?{degreeField:'ds_statistics',programChoice:'24_month'}:question==='search_stage'?'applying':undefined;
   draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:draft.revision,action:value===undefined?{kind:'skip',questionId:question}:{kind:'answer',questionId:question,value}} as any)).draft;
  }
  const b=await readyBirth(f,birthRuntime,{who}),birth=await b.service.birth(who,b.body,b.key);
  const config={...readConfig(),...f.config,queueName:'fictional-first-letter-start-'+randomUUID(),
   expertRoster:release?{schemaVersion:1 as const,revision:7,enabledExperts:[]}:undefined,
   modelRoutes:{...f.config.modelRoutes,first_letter_generation:{provider:'openai'}}};
  const daily=new CompanionDailySettingsService(f.db,config,FICTIONAL_LEGAL);
  if(preferences)await daily.change(who,{operationId:randomUUID(),expectedRevision:0,companionId:birth.receipt.identity.companionId,preferences:prefs});
  const welcome=new CompanionWelcomeService(f.db,config,FICTIONAL_LEGAL,new CompanionBirthOriginStore(f.crypto),b.prebirth);
  const opened=await welcome.open(who,{expectedCompanionId:birth.receipt.identity.companionId});
  const sources=new FirstLetterSources(f.db,config,FICTIONAL_LEGAL,b.ready.background,b.prebirth);
  const settings=new FirstLetterSettings(f.db,daily,config),tasks=new FirstLetterTasks(f.db,config,sources,settings);let calls=0;
  const body='我是'+birth.receipt.identity.name+'，名字是你起的。我是 AI。只记你同意的；在「我 → 它记得的你」可查看、修改、删除。'+
   '要发给别人的消息和材料，都先进待确认；表单里哪些项可以替你做，由你在对话里逐项确认；最终提交永远由你本人点。'+
   '你填的专业是 DS / 统计，目前在投，还没面试。接下来一起看今天的三件事。';
  const respond:typeof fetch=async(target,init)=>{
    assert.equal(String(target),'https://api.openai.com/v1/responses');const request=JSON.parse(String(init?.body));assert.equal(request.model,model);calls++;
    const text=request.text.format.name==='career_first_letter_review'?JSON.stringify({
     checks:Object.fromEntries(['identity','memory','external_actions','user_facts','experts','today','language_personality','prohibited_content'].map(k=>[k,'supported'])),
     references:{study:'supported',search_stage:'supported'}}):JSON.stringify({body,factReferences:[{ref:'study',quote:'DS / 统计'},{ref:'search_stage',quote:'在投，还没面试'}]});
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:10},
     output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
   };
  const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-injected-only',OPENAI_FIRST_LETTER_MODEL:model},fetch:respond});
  const generation=new FirstLetterGeneration(f.db,config,runtime,tasks),entry=new FirstLetterDispatch(f.db,config,runtime,tasks,generation,settings);
  const start=new FirstLetterStart(f.db,config,welcome,settings,tasks,entry);
  result={who,config,respond,authority:b.ready.authority,daily,settings,welcome,tasks,sources,entry,generation,start,runtime,get calls(){return calls;},
   command:{welcomeId:opened.id,expectedRevision:1,operationId:randomUUID(),choice:'direct_letter'},
   savePreferences:()=>daily.change(who,{operationId:randomUUID(),expectedRevision:0,companionId:birth.receipt.identity.companionId,preferences:prefs})};
 });return result;
}
async function empty(a:any){
 assert.equal((await a.welcome.read(a.who)).step,'C1');
 for(const table of ['platform_companion_welcome_operations','platform_first_letter_tasks','platform_first_letter_requests','platform_first_letter_outbox'])
  assert.equal((await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1',[a.who.userId])).rowCount,0);
 assert.equal(a.calls,0);
}
async function ref(a:any){const r=(await f.db.query('SELECT id,task_id FROM platform_first_letter_requests WHERE user_id=$1',[a.who.userId])).rows[0];return {requestId:r.id,taskId:r.task_id};}
async function intercept(hook:(sql:string,result:any)=>void,run:()=>Promise<void>){
 const original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(fn,options)=>original(c=>fn(new Proxy(c,{get(target,key){
  if(key==='query')return async(sql:any,...args:any[])=>{const result=await(target.query as any)(sql,...args);if(typeof sql==='string')hook(sql,result);return result;};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }})),options);
 try{await run();}finally{f.db.withBoundedTransaction=original;}
}
test('missing preferences or release configuration rolls back C1; saved owner preferences supply the actual local date',async()=>{
 const a=await actor(false);await assert.rejects(a.start.choose(a.who,a.command),{code:'DAILY_SETTINGS_REQUIRED'});await empty(a);
 await a.savePreferences();
 await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2026-10-09T03:00:00Z');},async()=>{
  assert.equal((await a.start.choose(a.who,a.command)).state.step,'C7');
  const settings=await a.settings.read(a.who);assert.equal(settings.localDate,'2026-10-08');assert.equal(settings.rosterRevision,7);assert.deepEqual(settings.enabledExperts,[]);
  const saved=await a.tasks.read(a.who,{taskId:(await ref(a)).taskId},settings);assert.equal(saved.task.settings.localDate,'2026-10-08');
 });assert.equal(a.calls,0);
 const b=await actor(true,false);await assert.rejects(b.start.choose(b.who,b.command),{code:'FIRST_LETTER_RELEASE_UNAVAILABLE'});await empty(b);
});
test('concurrent C1 clicks atomically create one choice, preparation, request and notification without calling a model',async()=>{
 const a=await actor();const results=await Promise.all([a.start.choose(a.who,a.command),a.start.choose(a.who,a.command)]);
 assert.equal(results.filter(x=>x.operation.replayed).length,1);
 for(const table of ['platform_companion_welcome_operations','platform_first_letter_tasks','platform_first_letter_requests','platform_first_letter_outbox'])
  assert.equal((await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1',[a.who.userId])).rowCount,1);
 assert.equal(a.calls,0);
 await assert.rejects(a.start.choose(a.who,{...a.command,operationId:randomUUID()}),{code:'COMPANION_WELCOME_CONFLICT'});
});
test('outbox failure and late cancellation roll back the entire student choice, not only its queue intent',async()=>{
 for(const abort of [false,true]){
  const a=await actor(),stop=new AbortController();
  await intercept((sql)=>{if(sql.startsWith('INSERT INTO platform_first_letter_outbox')){
   if(abort)stop.abort(Error('Fictional cancellation'));else throw Error('Fictional database interruption');
  }},async()=>{await assert.rejects(a.start.choose(a.who,a.command,stop.signal));});
  await empty(a);assert.equal((await a.start.choose(a.who,a.command)).operation.replayed,false);
 }
});
test('observing a lost response needs no current date or route and cannot replace the original accepted session',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 const fresh={userId:a.who.userId,tokenHash:tokenHash(randomUUID())};
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[fresh.userId,fresh.tokenHash]);
 await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[a.who.userId,a.who.tokenHash]);
 const observing=new FirstLetterStart(f.db,a.config,a.welcome,{readInTransaction:async()=>{throw Error('Replay cannot read live configuration.');}},a.tasks,a.entry);
 assert.equal((await observing.choose(fresh,a.command)).operation.replayed,true);
 await assert.rejects(a.entry.executeNotification(refs),{code:'AUTH_REQUIRED'});assert.equal(a.calls,0);
});
test('begin remains independent of letter settings and does not queue a first letter',async()=>{
 const a=await actor(false,false),result=await a.start.choose(a.who,{...a.command,choice:'begin'});
 assert.equal(result.state.step,'C2');
 assert.equal((await f.db.query('SELECT * FROM platform_first_letter_tasks WHERE user_id=$1',[a.who.userId])).rowCount,0);assert.equal(a.calls,0);
});
test('real Redis worker obtains settings from the original owner instead of a notification callback',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 assert(['127.0.0.1','localhost','[::1]'].includes(new URL(a.config.redisUrl).hostname));
 const queue=new FirstLetterQueue(a.entry),control=new ProducerQueue(firstLetterQueueName(a.config.queueName),a.config.redisUrl);
 const worker=createFirstLetterWorker(a.entry);
 try{
  await queue.dispatch();const deadline=Date.now()+10000;
  while((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason!=='terminal'){
   if(Date.now()>deadline)assert.fail('Actual worker did not finish.');await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(a.calls,2);assert.equal((await a.generation.readReview(a.who,{taskId:refs.taskId},await a.settings.read(a.who))).kind,'reviewed_draft');
  assert.equal((await a.welcome.read(a.who)).step,'C7');
  const progress=new FirstLetterProgressService(f.db,a.config,a.sources,a.generation,{settings:a.settings,config:a.config,runtime:a.runtime});
  await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2027-01-01T00:00:00Z');},async()=>{
   assert.equal((await progress.read(a.who)).state,'reviewed');
  });
 }finally{await worker.close();await queue.close();try{await control.obliterate({force:true});}finally{await control.close();}}
});
test('changed saved time zone is re-read before execution and cannot silently change accepted preparation',async()=>{
 const a=await actor();await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2026-10-09T03:00:00Z');},async()=>{
  await a.start.choose(a.who,a.command);const refs=await ref(a),old=(await a.daily.read(a.who)).settings;
  await a.daily.change(a.who,{operationId:randomUUID(),expectedRevision:old.revision,companionId:old.companionId,preferences:{...prefs,timeZone:'Asia/Tokyo'}});
  assert.equal((await a.settings.read(a.who)).localDate,agendaLocalDate('2026-10-09T03:00:00Z','Asia/Tokyo'));
  await assert.rejects(a.entry.executeNotification(refs),{code:'FIRST_LETTER_TASK_PREPARATION_CHANGED'});assert.equal(a.calls,0);
 });
});
test('corrupt durable intent rejects observation and an old standalone choice does not silently create a new authorization',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 const row=(await f.db.query('SELECT payload_ciphertext FROM platform_first_letter_requests WHERE id=$1',[refs.requestId])).rows[0];
 const damaged=Buffer.from(row.payload_ciphertext);damaged[damaged.length-1]^=1;
 await f.db.query('UPDATE platform_first_letter_requests SET payload_ciphertext=$2 WHERE id=$1',[refs.requestId,damaged]);
 await assert.rejects(a.start.choose(a.who,a.command),{code:'FIRST_LETTER_REQUEST_UNAVAILABLE'});assert.equal(a.calls,0);
 const b=await actor();await b.welcome.choose(b.who,b.command);
 await assert.rejects(b.start.choose(b.who,b.command),{code:'FIRST_LETTER_START_UNAVAILABLE'});
 assert.equal((await f.db.query('SELECT * FROM platform_first_letter_requests WHERE user_id=$1',[b.who.userId])).rowCount,0);
});

test('a preference change between stage claim and actual started callback is checked again before buying a call',async()=>{
 const a=await actor();
 await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2026-10-09T03:00:00Z');},async()=>{
  await a.start.choose(a.who,a.command);const refs=await ref(a),settings=await a.settings.read(a.who),old=(await a.daily.read(a.who)).settings;
  const runtime={...a.runtime,async *streamChat(input:any,context:any){
   await a.daily.change(a.who,{operationId:randomUUID(),expectedRevision:old.revision,companionId:old.companionId,
    preferences:{...prefs,timeZone:'Asia/Tokyo'}});
   yield* a.runtime.streamChat(input,context);
  }};
  const generation=new FirstLetterGeneration(f.db,a.config,runtime,a.tasks);
  await assert.rejects(generation.generate(a.who,{taskId:refs.taskId},settings));assert.equal(a.calls,0);
  const stage=(await f.db.query('SELECT status,call_id FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rows[0];
  assert.equal(stage.status,'failed');assert.equal(stage.call_id,null);
  assert.equal((await f.db.query("SELECT * FROM platform_cost_reservations WHERE source_kind='job' AND source_id=$1",[refs.taskId])).rowCount,0);
 });
});

function progress(a:any,runtime=a.runtime,config=a.config){
 return new FirstLetterProgressService(f.db,a.config,a.sources,a.generation,{settings:a.settings,config,runtime});
}
test('owned queue progress distinguishes an accepted request and disabled service without changing durable work',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);
 const refs=await ref(a),before=(await f.db.query('SELECT * FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0];
 assert.equal((await progress(a).read(a.who)).state,'queued');
 const off=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'}});
 const unavailable=await progress(a,off).read(a.who);assert.equal(unavailable.state,'service_unavailable');assert.equal(unavailable.delivered,false);
 assert.equal((await progress(a,a.runtime,{...a.config,modelRoutes:{}}).read(a.who)).state,'service_unavailable');
 const json=JSON.stringify(unavailable);
 for(const secret of [a.who.tokenHash,refs.requestId,refs.taskId,model,'authVersion','payload_digest','ciphertext','held_reason'])assert(!json.includes(secret));
 assert.deepEqual((await f.db.query('SELECT * FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0],before);
 assert.equal((await f.db.query('SELECT * FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rowCount,0);assert.equal(a.calls,0);
});
test('owner sees changed dates and original-session expiry before any worker runs; a newer login grants no execution',async()=>{
 const a=await actor();
 await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2026-10-09T03:00:00Z');},async()=>{
  await a.start.choose(a.who,a.command);
 });
 await intercept((sql,result)=>{if(sql==='SELECT clock_timestamp() at')result.rows[0].at=new Date('2026-10-10T03:00:00Z');},async()=>{
  assert.equal((await progress(a).read(a.who)).state,'settings_changed');
 });
 const refs=await ref(a),fresh={userId:a.who.userId,tokenHash:tokenHash(randomUUID())};
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[fresh.userId,fresh.tokenHash]);
 await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2',[a.who.userId,a.who.tokenHash]);
 assert.equal((await progress(a).read(fresh)).state,'authorization_required');
 assert.equal((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason,null);
 await assert.rejects(a.entry.executeNotification(refs),{code:'AUTH_REQUIRED'});assert.equal(a.calls,0);
});
test('damaged or missing request evidence cannot be rendered as queued work or ordinary service unavailability',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a),reader=progress(a);
 const row=(await f.db.query('SELECT payload_ciphertext FROM platform_first_letter_requests WHERE id=$1',[refs.requestId])).rows[0];
 const damaged=Buffer.from(row.payload_ciphertext);damaged[damaged.length-1]^=1;
 await f.db.query('UPDATE platform_first_letter_requests SET payload_ciphertext=$2 WHERE id=$1',[refs.requestId,damaged]);
 await assert.rejects(reader.read(a.who),{code:'FIRST_LETTER_REQUEST_UNAVAILABLE'});
 await f.db.query('UPDATE platform_first_letter_requests SET payload_ciphertext=$2 WHERE id=$1',[refs.requestId,row.payload_ciphertext]);
 await f.db.query('DELETE FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId]);
 await assert.rejects(reader.read(a.who),{code:'FIRST_LETTER_REQUEST_UNAVAILABLE'});assert.equal(a.calls,0);
});

test('a dispatched failed call remains interrupted even when the service is now disabled; reading cannot retry it',async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);let calls=0;
 const failed=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-injected-only',OPENAI_FIRST_LETTER_MODEL:model},
  fetch:async()=>{calls++;throw Error('Fictional transport loss after dispatch');}});
 const generation=new FirstLetterGeneration(f.db,a.config,failed,a.tasks);
 await assert.rejects(generation.generate(a.who,{taskId:refs.taskId},await a.settings.read(a.who)));
 const row=(await f.db.query('SELECT status,call_id FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rows[0];
 assert.equal(row.status,'failed');assert(row.call_id);assert.equal(calls,1);
 const off=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'}});
 const reader=new FirstLetterProgressService(f.db,a.config,a.sources,generation,{settings:a.settings,config:a.config,runtime:off});
 for(let i=0;i<2;i++)assert.equal((await reader.read(a.who)).state,'interrupted');
 assert.equal(calls,1);assert.equal(a.calls,0);
 assert.equal((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason,null);
});

test('actual worker-main preserves disabled work, restarts into processing and never buys the completed letter twice', {timeout:65000}, async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 const processes=await workerProcessFixture(f,a,model);
 try{
  const disabled=await processes.start(false);
  await processes.until(async()=> (await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason==='configuration');
  assert.equal(a.calls,0);assert.equal((await f.db.query('SELECT * FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rowCount,0);
  await disabled.stop();
  const active=await processes.start(true);
  await processes.until(async()=> (await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason==='terminal',25000);
  assert.equal(a.calls,2);assert.equal((await a.generation.readReview(a.who,{taskId:refs.taskId},await a.settings.read(a.who))).kind,'reviewed_draft');
  assert.equal((await a.welcome.read(a.who)).step,'C7');
  await active.stop();
  const restarted=await processes.start(true);
  // Observe the actual newly launched worker and multiple real producer ticks.
  await processes.until(async()=> (await f.db.query("SELECT count(*)::integer n FROM platform_worker_heartbeats WHERE queue_name=$1 AND process_state='running'",[a.config.queueName])).rows[0].n===1,15000);
  assert.equal(a.calls,2);
  assert.equal((await f.db.query('SELECT * FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rowCount,2);
  await restarted.stop();
  assert.equal((await f.db.query("SELECT count(*)::integer n FROM platform_worker_heartbeats WHERE queue_name=$1 AND process_state='stopping'",[a.config.queueName])).rows[0].n,3);
 }finally{await processes.close();}
});
test('SIGTERM waits for the real in-flight letter, finishes its review and releases worker database sessions', {timeout:30000}, async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const respond=a.respond;a.respond=async(...args:any[])=>{entered=true;await gate;return respond(...args);};
 const processes=await workerProcessFixture(f,a,model);let child:Awaited<ReturnType<typeof processes.start>>|undefined;
 try{
  child=await processes.start(true);await processes.until(async()=>entered);
  child.signal();
  await processes.until(async()=> (await f.db.query("SELECT * FROM platform_worker_heartbeats WHERE queue_name=$1 AND process_state='stopping'",[a.config.queueName])).rowCount===1);
  assert.equal(child.exited(),false,'stopping heartbeat must not be mistaken for a drained process');
  release();await child.stop();assert.equal(a.calls,2);
  assert.equal((await a.generation.readReview(a.who,{taskId:refs.taskId},await a.settings.read(a.who))).kind,'reviewed_draft');
  assert.equal((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason,'terminal');
 }finally{release();await processes.close();}
});

test('SIGTERM deadline exits the real stalled worker once and preserves the admitted unfinished call', {timeout:30000}, async()=>{
 const a=await actor();await a.start.choose(a.who,a.command);const refs=await ref(a);
 let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const respond=a.respond;a.respond=async(...args:any[])=>{entered=true;await gate;return respond(...args);};
 const processes=await workerProcessFixture(f,a,model);
 try{
  const child=await processes.start(true,2000);await processes.until(async()=>entered);
  const started=performance.now();child.signal();
  await new Promise(resolve=>setTimeout(resolve,150));child.repeatSignal();
  await child.stop(1);
  assert(performance.now()-started>=1800,'the repeated signal must not bypass the grace period');
  assert(performance.now()-started<10000,'the stalled call must not keep the process alive indefinitely');
  const rows=(await f.db.query('SELECT status,call_status,output_ciphertext,finished_at,reservation_id FROM platform_first_letter_stages WHERE task_id=$1',[refs.taskId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].status,'running');assert.equal(rows[0].call_status,'admitted');
  assert.equal(rows[0].output_ciphertext,null);assert.equal(rows[0].finished_at,null);
  assert.equal((await f.db.query('SELECT status FROM platform_cost_reservations WHERE id=$1',[rows[0].reservation_id])).rows[0].status,'admitted');
  assert.notEqual((await f.db.query('SELECT held_reason FROM platform_first_letter_outbox WHERE request_id=$1',[refs.requestId])).rows[0].held_reason,'terminal');
  assert.equal(a.calls,0,'the loopback response has not completed or been retried');
 }finally{release();await processes.close();}
});

test('actual worker-main cleans expired knowledge access at startup and on maintenance while model calls are disabled',{timeout:35000},async()=>{
 const a=await actor(),library=await knowledgeAccessFixture(f);
 let processes:Awaited<ReturnType<typeof workerProcessFixture>>|undefined;
 try{
  const old=await library.access(),current=await library.access();
  await f.db.query("UPDATE platform_knowledge_access_log SET created_at=statement_timestamp()-interval '181 days',retention_until=statement_timestamp()-interval '1 day' WHERE id=$1",[old]);
  processes=await workerProcessFixture(f,a,model);
  const child=await processes.start(false);
  assert.equal((await f.db.query('SELECT id FROM platform_knowledge_access_log WHERE id=$1',[old])).rowCount,0);
  const later=await library.access();
  await f.db.query("UPDATE platform_knowledge_access_log SET created_at=statement_timestamp()-interval '181 days',retention_until=statement_timestamp()-interval '1 day' WHERE id=$1",[later]);
  await processes.until(async()=> (await f.db.query('SELECT id FROM platform_knowledge_access_log WHERE id=$1',[later])).rowCount===0,22000);
  assert.equal((await f.db.query('SELECT id FROM platform_knowledge_access_log WHERE id=$1',[current])).rowCount,1);
  assert.equal(a.calls,0);await child.stop();
 }finally{try{await processes?.close();}finally{await library.close();}}
});

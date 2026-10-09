import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AccountFileArchive} from '../src/account-file-archive.ts';
import {LocalBlobStorage} from '../src/storage.ts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProviderRuntime} from '@companion/ai-core';
import type {OnboardingQuestionValues,PlatformProviderRuntime} from '@companion/platform-contracts';
import {createPrebirthFixture,withPrebirthLoopback,type PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {FirstLetterSources} from '../src/first-letter-sources.ts';
import {FirstLetterTasks} from '../src/first-letter-tasks.ts';
import {FirstLetterGeneration} from '../src/first-letter-generation.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword} from '../src/auth.ts';
import {ApiError} from '../src/errors.ts';
let f:PrebirthFixture,encoded:string;
const model='fictional-first-letter',password='Fictional-first-letter-generation-password';
const settings={rosterRevision:1,enabledExperts:[] as const,localDate:'2026-10-09'};
before(async()=>{
 f=await createPrebirthFixture();encoded=await hashPassword(password);
 for(const [unit,rate] of [['input_token','1'],['cached_input_token','1'],['cache_write_input_token','1'],['output_token','2']])
  await f.db.query("INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from) VALUES($1,'openai',$2,'background',$3,$4,clock_timestamp())",[randomUUID(),model,unit,rate]);
});
after(async()=>{await f?.close();});
type Basics=Partial<Pick<OnboardingQuestionValues,'study'|'graduation'|'roles'|'search_stage'|'emotion_language'|'identity_stage'>>;
async function setup(runtime:PlatformProviderRuntime,values:Basics={},choice:'direct_letter'|'begin'|null='direct_letter'){
 const who=await f.actor();
 let draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'standard'}})).draft;
 while(draft.currentQuestion){
  const question=draft.currentQuestion,value=values[question as keyof Basics];
  const action=value===undefined?{kind:'skip',questionId:question}:{kind:'answer',questionId:question,value};
  draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:draft.revision,action} as any)).draft;
 }
 const b=await readyBirth(f,runtime,{who}),birth=await b.service.birth(who,b.body,b.key);
 const welcome=new CompanionWelcomeService(f.db,f.config,FICTIONAL_LEGAL,new CompanionBirthOriginStore(f.crypto),b.prebirth);
 const state=await welcome.open(who,{expectedCompanionId:birth.receipt.identity.companionId});
 const selected=choice?await welcome.choose(who,{welcomeId:state.id,expectedRevision:1,operationId:randomUUID(),choice}):null;
 const sources=new FirstLetterSources(f.db,f.config,FICTIONAL_LEGAL,b.ready.background,b.prebirth);
 return {who,b,birth,welcome,state,selected,sources};
}
const values:Basics={study:{degreeField:'ds_statistics',programChoice:'24_month'},graduation:{month:'2027-05',graduated:false},
 roles:{kind:'selected',roles:['ds','da']},search_stage:'applying',emotion_language:'en',identity_stage:'stem_opt'};

const text=JSON.stringify({body:'接下来可以一起了解你的方向。',factReferences:[]});
function provider(options:{body?:string;hook?:()=>Promise<void>;usage?:boolean;refusal?:boolean}={}){
 let calls=0;
 const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-injected-only',OPENAI_FIRST_LETTER_MODEL:model},
  fetch:async(url,init)=>{
   calls++;assert.equal(String(url),'https://api.openai.com/v1/responses');
   const req=JSON.parse(String(init?.body));assert.equal(req.model,model);assert.equal(req.store,false);
   assert.deepEqual(req.tools,[]);assert.equal(req.tool_choice,'none');assert.equal(req.text.format.strict,true);assert.equal(req.max_output_tokens,1536);
   await options.hook?.();
   const response={type:'response.completed',response:{status:'completed',
    ...(options.usage===false?{}:{usage:{input_tokens:10,output_tokens:10}}),
    output:[{type:'message',role:'assistant',status:'completed',content:[options.refusal?{type:'refusal',refusal:'Fictional refusal'}:{type:'output_text',text:options.body??text}]}]}};
   return new Response('data: '+JSON.stringify(response)+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
  }});
 return {runtime,get calls(){return calls;}};
}
async function prepared(birthRuntime:PlatformProviderRuntime){
 const a=await setup(birthRuntime,{}),tasks=new FirstLetterTasks(f.db,f.config,a.sources),saved=await tasks.prepare(a.who,settings);
 return {...a,tasks,saved};
}
const service=(a:Awaited<ReturnType<typeof prepared>>,runtime:PlatformProviderRuntime)=>new FirstLetterGeneration(f.db,{...f.config,modelRoutes:{...f.config.modelRoutes,first_letter_generation:{provider:'openai'}}},runtime,a.tasks);
const pick=(a:Awaited<ReturnType<typeof prepared>>)=>({taskId:a.saved.task.taskId});
const row=async(a:Awaited<ReturnType<typeof prepared>>)=>(await f.db.query('SELECT * FROM platform_first_letter_stages WHERE task_id=$1',[a.saved.task.taskId])).rows[0];
async function capture(a:Awaited<ReturnType<typeof prepared>>){
 await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[a.who.userId,encoded]);
 const proof=await new AccountReauthentication(f.db).verify(a.who,{purpose:'account_export',password});
 return new AccountCoreExport(f.db,f.config).capture(a.who,proof.token);
}
test('a genuine original call reserves and settles money before saving encrypted unreviewed output; rereads do not call again',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),p=provider(),g=service(a,p.runtime),before=await a.welcome.read(a.who);
  const result=await g.generate(a.who,pick(a),settings);
  assert.equal(p.calls,1);assert.equal(result.status,'draft_saved');assert.equal(result.output?.text,text);
  assert.equal(result.output?.assurance,'unreviewed_model_output');assert.equal(result.call?.receipt?.costMicros,'30');
  assert.equal(result.call?.receipt?.usage.status,'reported');assert.equal(result.call?.receipt?.launched,true);
  assert.deepEqual(await service(a,p.runtime).generate(a.who,pick(a),settings),result);assert.equal(p.calls,1);
  assert.deepEqual(await g.read(a.who,pick(a),settings),result);
  const off=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'}});
  assert.deepEqual(await service(a,off).generate(a.who,pick(a),settings),result);
  assert.deepEqual(await a.welcome.read(a.who),before);
  const saved=await row(a);assert(Buffer.isBuffer(saved.output_ciphertext));assert(!saved.output_ciphertext.includes(Buffer.from(text)));
  assert.equal(saved.lease_token,null);assert.equal(saved.runtime_lease_id,null);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_runtime_leases WHERE user_id=$1 AND kind='background'",[a.who.userId])).rows[0].n,0);
  const archive=await capture(a);assert.deepEqual(archive.sections.firstLetterStages,[result]);assert.equal(archive.includedTables.length,143);
  const wire=JSON.stringify(archive.sections.firstLetterStages);
  for(const secret of [a.who.tokenHash,'authVersion','lease_token','runtime_lease_id','ciphertext'])assert(!wire.includes(secret));
  assert.equal(archive.complete,false);assert(Object.isFrozen(result.call?.receipt?.usage));
 });
});
test('missing usage is charged conservatively; invalid structured output is a recorded content failure, never a free retry',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  for(const options of [{usage:false},{body:'not JSON'}]){
   const a=await prepared(birthRuntime),p=provider(options),g=service(a,p.runtime);
   const result=await g.generate(a.who,pick(a),settings);
   if(options.usage===false){assert.equal(result.status,'draft_saved');assert.equal(result.call?.receipt?.usage.status,'missing');assert.equal(result.call?.receipt?.estimated,true);}
   else{assert.equal(result.status,'invalid_format');assert.equal(result.output,null);assert.equal(result.call?.receipt?.structuredOutcome,'invalid_format');}
   assert.deepEqual(await g.generate(a.who,pick(a),settings),result);assert.equal(p.calls,1);
   assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE source_id=$1',[pick(a).taskId])).rows[0].n,1);
  }
 });
});
test('concurrent execution is fenced and background capacity remains independent of two active chats',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),atFetch=new Promise<void>(r=>entered=r);
  const p=provider({hook:async()=>{entered();await gate;}}),g=service(a,p.runtime);
  for(let i=0;i<2;i++)await f.db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',clock_timestamp()+interval '60 seconds')",[randomUUID(),a.who.userId]);
  const running=g.generate(a.who,pick(a),settings);
  try{await Promise.race([atFetch,running.then(()=>{throw new Error('Completed before transport was observed.');})]);await assert.rejects(g.generate(a.who,pick(a),settings),{code:'FIRST_LETTER_RECOVERY_REQUIRED'});}
  finally{release();}
  assert.equal((await running).status,'draft_saved');assert.equal(p.calls,1);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_runtime_leases WHERE user_id=$1 AND kind='chat'",[a.who.userId])).rows[0].n,2);
 });
});
test('disabled routing and unavailable budgets make no provider request; a refusal remains a paid failed stage',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),off=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'}});
  await assert.rejects(service(a,off).generate(a.who,pick(a),settings),{code:'MODEL_ROUTE_UNAVAILABLE'});assert.equal(await row(a),undefined);
  const p=provider();await f.db.query('UPDATE platform_cost_user_policy SET hard_micros=1 WHERE user_id=$1',[a.who.userId]);
  await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings));assert.equal(p.calls,0);
  assert.equal((await row(a)).call_id,null);assert.equal((await row(a)).status,'failed');
  const unused=(await row(a)).id;
  await f.db.query('UPDATE platform_cost_user_policy SET hard_micros=100000000 WHERE user_id=$1',[a.who.userId]);
  const retried=await service(a,p.runtime).generate(a.who,pick(a),settings);
  assert.equal(retried.id,unused);assert.equal(retried.status,'draft_saved');assert.equal(p.calls,1);
  const b=await prepared(birthRuntime),refused=provider({refusal:true}),g=service(b,refused.runtime);
  await assert.rejects(g.generate(b.who,pick(b),settings));
  const failed=await g.read(b.who,pick(b),settings);assert.equal(failed?.output,null);assert.equal(failed?.call?.receipt?.launched,true);
  await assert.rejects(g.generate(b.who,pick(b),settings),{code:'FIRST_LETTER_RECOVERY_REQUIRED'});assert.equal(refused.calls,1);
 });
});
test('withdrawal after dispatch keeps the actual cost but prevents publishing a saved draft',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),p=provider({hook:async()=>{await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.who.userId]);}});
  await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings));assert.equal(p.calls,1);
  const saved=await row(a);assert.equal(saved.output_ciphertext,null);assert(saved.receipt_ciphertext);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE source_id=$1',[pick(a).taskId])).rows[0].n,1);
  const archive=await capture(a);assert.equal((archive.sections.firstLetterStages[0] as any).output,null);
  assert.equal((archive.sections.firstLetterStages[0] as any).call.receipt.costMicros,'30');
 });
});
test('an admission transaction failure after launch records dispatch risk and never authorizes another request',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),p=provider(),g=service(a,p.runtime);
  const original=f.db.withBoundedTransaction.bind(f.db);let injected=false;
  f.db.withBoundedTransaction=async(run,options)=>original(async c=>{
   let granted=false;
   const result=await run(new Proxy(c,{get(target,key){
    if(key==='query')return async(sql:any,...args:any[])=>{
     const out=await(target.query as any)(sql,...args);
     if(typeof sql==='string'&&sql.startsWith("UPDATE platform_first_letter_stages s SET call_status='admitted'"))granted=true;
     return out;
    };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
   }}));
   if(granted&&!injected){injected=true;throw new ApiError(503,'FICTIONAL_COMMIT_FAILURE','Fictional test rollback.');}
   return result;
  },options);
  try{await assert.rejects(g.generate(a.who,pick(a),settings));}finally{f.db.withBoundedTransaction=original;}
  assert(injected);assert.equal(p.calls,1);
  const result=await g.read(a.who,pick(a),settings);assert.equal(result?.output,null);
  const reservation=(await f.db.query('SELECT * FROM platform_cost_reservations WHERE id=$1',[(await row(a)).reservation_id])).rows[0];
  assert(reservation.dispatch_intent_at);assert.notEqual(reservation.status,'released');
  await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings),{code:'FIRST_LETTER_RECOVERY_REQUIRED'});assert.equal(p.calls,1);
 });
});
test('cross-owner reads, relocated ciphertext and tampered accounting fail closed; deletion cascades the stage',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),b=await prepared(birthRuntime),p=provider();
  const g=service(a,p.runtime),result=await g.generate(a.who,pick(a),settings),other=await service(b,p.runtime).generate(b.who,pick(b),settings);
  await assert.rejects(service(b,p.runtime).read(b.who,pick(a),settings),{code:'NOT_FOUND'});
  const saved=await row(a),foreign=await row(b);
  for(const column of ['start_ciphertext','receipt_ciphertext','output_ciphertext']){
   await f.db.query('UPDATE platform_first_letter_stages SET '+column+'=$2 WHERE id=$1',[saved.id,foreign[column]]);
   await assert.rejects(g.read(a.who,pick(a),settings),{code:'FIRST_LETTER_STAGE_UNAVAILABLE'});
   await assert.rejects(capture(a),{code:'FIRST_LETTER_STAGE_UNAVAILABLE'});
   await f.db.query('UPDATE platform_first_letter_stages SET '+column+'=$2 WHERE id=$1',[saved.id,saved[column]]);
  }
  await f.db.query('UPDATE platform_cost_ledger SET cost_micros=cost_micros+1 WHERE reservation_id=$1',[saved.reservation_id]);
  await assert.rejects(g.read(a.who,pick(a),settings),{code:'FIRST_LETTER_STAGE_UNAVAILABLE'});
  await f.db.query('UPDATE platform_cost_ledger SET cost_micros=$2 WHERE reservation_id=$1',[saved.reservation_id,result.call!.receipt!.costMicros]);
  const before=BigInt((await f.db.query('SELECT COALESCE(sum(cost_micros),0)::text AS n FROM platform_deleted_account_cost_daily')).rows[0].n);
  const own=BigInt((await f.db.query('SELECT COALESCE(sum(cost_micros),0)::text AS n FROM platform_cost_ledger WHERE user_id=$1',[a.who.userId])).rows[0].n);
  await assert.rejects(f.db.query('DELETE FROM platform_cost_reservations WHERE id=$1',[saved.reservation_id]),{code:'23503'});
  await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.who.userId]);
  const after=BigInt((await f.db.query('SELECT COALESCE(sum(cost_micros),0)::text AS n FROM platform_deleted_account_cost_daily')).rows[0].n);
  assert.equal(after-before,own);assert.equal(await row(a),undefined);assert.deepEqual(await service(b,p.runtime).read(b.who,pick(b),settings),other);
 });
});

test('expired dispatch risk is reconciled after lost callback and failed cleanup, without replaying the original call',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),p=provider();
  const runtime:PlatformProviderRuntime={...p.runtime,streamChat:(input,context={})=>p.runtime.streamChat(input,{...context,
   onModelCall:event=>event.type==='finished'?undefined:context.onModelCall?.(event)})};
  const g=service(a,runtime),original=f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction=async(run,options)=>original(c=>run(new Proxy(c,{get(target,key){
   if(key==='query')return async(sql:any,...args:any[])=>{
    if(typeof sql==='string'&&sql.startsWith('UPDATE platform_first_letter_stages SET status=CASE'))
     throw new ApiError(503,'FICTIONAL_CLEANUP_LOST','Fictional interrupted cleanup.');
    return(target.query as any)(sql,...args);
   };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
  }})),options);
  try{await assert.rejects(g.generate(a.who,pick(a),settings));}finally{f.db.withBoundedTransaction=original;}
  const saved=await row(a);assert.equal(saved.status,'running');assert.equal(saved.call_status,'admitted');assert.equal(saved.receipt_ciphertext,null);
  assert.equal(p.calls,1);
  await f.db.query("UPDATE platform_first_letter_stages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[saved.id]);
  await f.db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[saved.reservation_id]);
  const recovered=await service(a,p.runtime).recover(a.who,pick(a),settings);
  assert.equal(recovered?.status,'uncertain');assert.equal(recovered?.output,null);assert.equal(recovered?.call?.receipt,null);
  const ledger=(await f.db.query('SELECT * FROM platform_cost_ledger WHERE reservation_id=$1',[saved.reservation_id])).rows[0];
  assert.equal(ledger.usage_status,'expired');assert.equal(ledger.estimated,true);
  assert.deepEqual(await service(a,p.runtime).recover(a.who,pick(a),settings),recovered);
  await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings),{code:'FIRST_LETTER_RECOVERY_REQUIRED'});
  assert.equal(p.calls,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_cost_ledger WHERE reservation_id=$1',[saved.reservation_id])).rows[0].n,1);
 });
});
test('the final launch statement rejects late policy, session and runtime expiry before any provider request',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  for(const kind of ['policy','session','lease']){
   const a=await prepared(birthRuntime),p=provider(),g=service(a,p.runtime),original=f.db.withBoundedTransaction.bind(f.db);let touched=false;
   f.db.withBoundedTransaction=async(run,options)=>original(c=>run(new Proxy(c,{get(target,key){
    if(key==='query')return async(sql:any,...args:any[])=>{
     if(typeof sql==='string'&&sql.startsWith("UPDATE platform_first_letter_stages s SET call_status='admitted'")){
      touched=true;
      if(kind==='policy')await target.query("UPDATE platform_cost_user_policy SET effective_to=clock_timestamp()-interval '1 millisecond' WHERE user_id=$1",[a.who.userId]);
      if(kind==='session')await target.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[a.who.tokenHash]);
      if(kind==='lease')await target.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='background'",[a.who.userId]);
     }
     return(target.query as any)(sql,...args);
    };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
   }})),options);
   try{await assert.rejects(g.generate(a.who,pick(a),settings));}finally{f.db.withBoundedTransaction=original;}
   assert(touched);assert.equal(p.calls,0);
   const saved=await row(a),reservation=(await f.db.query('SELECT * FROM platform_cost_reservations WHERE id=$1',[saved.reservation_id])).rows[0];
   assert.equal(saved.output_ciphertext,null);assert.equal(reservation.status,'released');assert.equal(reservation.dispatch_intent_at,null);
   assert.equal((await g.read(a.who,pick(a),settings))?.call?.receipt?.launched,false);
  }
 });
});
test('cancellation and lease loss after launch retain money evidence but no draft checkpoint',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  for(const kind of ['cancel','lease']){
   const a=await prepared(birthRuntime),controller=new AbortController();
   const p=provider({hook:async()=>{
    if(kind==='cancel')controller.abort(new Error('Fictional caller cancellation'));
    else await f.db.query("UPDATE platform_first_letter_stages SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",[pick(a).taskId]);
   }});
   await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings,controller.signal));assert.equal(p.calls,1);
   const saved=await row(a);assert.equal(saved.output_ciphertext,null);assert(saved.receipt_ciphertext);
   const reservation=(await f.db.query('SELECT * FROM platform_cost_reservations WHERE id=$1',[saved.reservation_id])).rows[0];
   assert.equal(reservation.status,'committed');
   await assert.rejects(service(a,p.runtime).generate(a.who,pick(a),settings),{code:'FIRST_LETTER_RECOVERY_REQUIRED'});
  }
 });
});

test('the private file archive retains the actual unreviewed draft and receipt without execution credentials',async()=>{
 await withPrebirthLoopback(async birthRuntime=>{
  const a=await prepared(birthRuntime),p=provider(),result=await service(a,p.runtime).generate(a.who,pick(a),settings);
  await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[a.who.userId,encoded]);
  const proof=await new AccountReauthentication(f.db).verify(a.who,{purpose:'account_export',password});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-letter-stage-export-'));
  try{
   const archive=await new AccountFileArchive(f.db,f.config,new LocalBlobStorage(path.join(root,'blobs')),path.join(root,'archives')).capture(a.who,proof.token);
   try{
    const saved=JSON.parse(await fs.readFile(path.join(archive.directory,'account.json'),'utf8'));
    assert.deepEqual(saved.sections.firstLetterStages,[result]);assert.equal(saved.includedTables.length,146);
    assert.equal(saved.remainingTables.length,20);assert.equal(saved.complete,false);
    const wire=JSON.stringify(saved.sections.firstLetterStages);
    for(const forbidden of [a.who.tokenHash,proof.token,'authVersion','lease_token','runtime_lease_id','ciphertext'])assert(!wire.includes(forbidden));
   }finally{await archive.dispose();}
   assert.deepEqual(await fs.readdir(path.join(root,'archives')),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
});

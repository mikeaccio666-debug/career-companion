import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProviderRuntime} from '@companion/ai-core';
import type {OnboardingQuestionValues,PlatformProviderRuntime} from '@companion/platform-contracts';
import {createPrebirthFixture,withPrebirthLoopback,type PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {FirstLetterSources} from '../src/first-letter-sources.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {ApiError} from '../src/errors.ts';
import {buildApp} from '../src/app.ts';
import {readConfig} from '../src/config.ts';
let f:PrebirthFixture;
before(async()=>{f=await createPrebirthFixture();});
after(async()=>{await f?.close();});
const denied=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
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

test('direct-letter facts come from actual O2 commands and welcome choice with exact references; identity is excluded',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{
  const a=await setup(runtime,values),count=calls.length,s=await a.sources.read(a.who);
  assert.equal(s.scope,'direct_letter_o2');assert.equal(s.ownerId,a.who.userId);assert.equal(s.companionId,a.birth.receipt.identity.companionId);
  assert.equal(s.trigger.operationId,a.selected!.operation.id);assert.equal(s.trigger.welcomeId,a.state.id);
  assert.equal(s.trigger.chosenAt,a.selected!.state.updatedAt);assert.equal(s.trigger.birthReceiptId,a.birth.receipt.id);
  assert.deepEqual(s.facts.map(v=>v.field),['study','graduation','roles','search_stage']);
  for(const fact of s.facts){
   assert.deepEqual(fact.value,values[fact.field]);assert.equal(fact.sourceRef.question,fact.field);
   assert.equal(fact.sourceRef.answersId,s.provenance.answersId);assert.equal(fact.sourceRef.sourceDraftId,s.provenance.sourceDraftId);
   assert.equal(fact.sourceRef.sourceRevision,s.provenance.sourceRevision);
   assert.equal(fact.source,'user_entered');assert.equal(fact.verification,'self_reported');
   const captured=(await f.store.read(a.who))!;
   assert.equal(fact.sourceRef.appliedRevision,captured.answersPartial[fact.field]!.appliedRevision);
  }
  assert.equal(s.emotionLanguage,'en');assert.equal(s.requiredFactReferences,2);assert.equal(s.needsMoreFacts,false);
  assert.deepEqual(s.omittedQuestions,[]);assert.deepEqual(await a.sources.read(a.who),s);assert.equal(calls.length,count);
  assert(Object.isFrozen(s));assert(Object.isFrozen(s.facts));assert(Object.isFrozen(s.facts[0].value));
  assert(Object.isFrozen(s.facts[0].sourceRef));assert(Object.isFrozen((s.facts[2].value as any).roles));
  const raw=JSON.stringify(s);for(const forbidden of ['stem_opt','identity_stage','answersPartial','styleCard','tokenHash','payload_ciphertext','Q4','textId'])assert(!raw.includes(forbidden));
 });
});

test('zero and one answered questions preserve missing facts; study subfields do not inflate the two-fact requirement',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const zero=await setup(runtime,{}),one=await setup(runtime,{study:values.study});
  const z=await zero.sources.read(zero.who),o=await one.sources.read(one.who);
  assert.deepEqual(z.facts,[]);assert.equal(z.requiredFactReferences,0);assert.equal(z.needsMoreFacts,true);assert.equal(z.emotionLanguage,null);
  assert.equal(o.facts.length,1);assert.equal(o.requiredFactReferences,1);assert.equal(o.needsMoreFacts,true);
  assert.deepEqual(o.omittedQuestions,['graduation','roles','search_stage']);
  const undecided=await setup(runtime,{roles:{kind:'undecided'},emotion_language:'either'});
  const u=await undecided.sources.read(undecided.who);assert.deepEqual(u.facts[0].value,{kind:'undecided'});assert.equal(u.emotionLanguage,'either');
 });
});

test('a saved C1 or begin choice is not C6, a timeout, a first letter or permission to generate',async()=>{
 await withPrebirthLoopback(async runtime=>{
  for(const choice of [null,'begin'] as const){
   const a=await setup(runtime,values,choice);
   await assert.rejects(a.sources.read(a.who),(e:any)=>e.code==='FIRST_LETTER_TRIGGER_REQUIRED');
  }
 });
});

test('reading preserves messages, welcome, answers, memory, plans and background jobs; it never calls the provider',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{
  const a=await setup(runtime,values);
  const rows=async()=>{const result:Record<string,unknown>={};
   for(const table of ['platform_messages','platform_companion_welcome','platform_companion_welcome_operations',
    'platform_companion_answers','platform_companion_generation_tasks','platform_memories','platform_daily_plans','platform_jobs'])
    result[table]=(await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1 ORDER BY 1',[a.who.userId])).rows;
   return result;
  };
  const before=await rows(),count=calls.length;await a.sources.read(a.who);
  assert.deepEqual(await rows(),before);assert.equal(calls.length,count);
 });
});

test('actual original sources are required; corruption, resealed changed answers and cross-owner ciphertext cannot become facts',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const foreign=await setup(runtime,values);
  const other=(await f.db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1',[foreign.who.userId])).rows[0];
  for(const mode of ['corrupt','resealed','foreign']){
   const a=await setup(runtime,values),row=(await f.db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1',[a.who.userId])).rows[0];
   let cipher=mode==='foreign'?other.payload_ciphertext:Buffer.from('fictional corrupt birth answers');
   if(mode==='resealed'){
    const context={table:'platform_companion_answers',column:'payload_ciphertext',rowId:row.id,ownerId:a.who.userId,revision:row.source_revision};
    const body=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,context));body.answersPartial.search_stage.value='offer';
    cipher=f.crypto.sealUtf8(JSON.stringify(body),context);
   }
   await f.db.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1',[row.id,cipher]);
   await assert.rejects(a.sources.read(a.who),denied(503));
  }
 });
});

test('damaged saved introduction cannot be replaced with the visible C7 state alone',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values);
  await f.db.query('UPDATE platform_companion_welcome SET intro_ciphertext=$2 WHERE id=$1',[a.state.id,Buffer.from('fictional corrupt intro')]);
  await assert.rejects(a.sources.read(a.who),denied(503));
 });
});

test('damaged current safety evidence blocks preparation even when direct-letter choice was already saved',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),saved=await a.sources.read(a.who);
  await f.db.query('UPDATE platform_companion_name_submissions SET result_ciphertext=$2 WHERE user_id=$1',
   [a.who.userId,Buffer.from('fictional corrupted current safety receipt')]);
  const welcome=await a.welcome.read(a.who);assert.equal(welcome.kind,'welcome');
  if(welcome.kind==='welcome')assert.equal(welcome.step,'C7');
  await assert.rejects(a.sources.read(a.who),denied(503));
  await assert.rejects(f.db.withBoundedTransaction(c=>a.sources.assertCurrentInTransaction(c,a.who,
   {ownerId:a.who.userId,sourceId:saved.sourceId})),denied(503));
 });
});

test('foreign/forged sessions, staff, prebirth, lost email and withdrawn consent cannot read sources',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),b=await setup(runtime,{roles:{kind:'undecided'}});
  await assert.rejects(a.sources.read({userId:a.who.userId,tokenHash:b.who.tokenHash}),denied(401));
  await assert.rejects(a.sources.read({...a.who,facts:[]} as any),denied(401));
  await assert.rejects(a.sources.read(await f.actor()),denied(409));
  await assert.rejects(a.sources.read(await f.actor(true)),denied(403));
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.who.userId]);
  await assert.rejects(a.sources.read(a.who),denied(403));
  await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[b.who.userId]);
  await assert.rejects(b.sources.read(b.who),denied(403));
 });
});

test('freshness is checked inside the consuming transaction and rejects foreign, stale and extended coordinates',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),s=await a.sources.read(a.who);
  const check=(expected:unknown)=>f.db.withBoundedTransaction(c=>a.sources.assertCurrentInTransaction(c,a.who,expected));
  assert.deepEqual(await check({ownerId:a.who.userId,sourceId:s.sourceId}),s);
  await assert.rejects(check({ownerId:randomUUID(),sourceId:s.sourceId}),denied(404));
  await assert.rejects(check({ownerId:a.who.userId,sourceId:'first_letter_source_'+'0'.repeat(64)}),denied(409));
  await assert.rejects(check({...s}),denied(400));
 });
});

test('late actual session revocation and cancellation cannot publish the composed snapshot',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),original=f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction=async(run,options)=>original(c=>run(new Proxy(c,{get(target,key){
   if(key==='query')return async(sql:any,...args:any[])=>{
    const result=await(target.query as any)(sql,...args);
    if(typeof sql==='string'&&sql.startsWith('SELECT * FROM platform_companion_welcome WHERE'))
     await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[a.who.userId]);
    return result;
   };
   const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
  }})),options);
  try{await assert.rejects(a.sources.read(a.who),denied(401));}
  finally{f.db.withBoundedTransaction=original;}
  await assert.rejects(a.sources.read(a.who,AbortSignal.abort()));
 });
});

test('real app composition exposes only an internal source service and adds no public source injection endpoint',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{
  const a=await setup(runtime,values),count=calls.length;
  const system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,enableQueue:false,
   config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true},
   runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'}})});
  try{
   assert.equal((await system.firstLetterSources.read(a.who)).sourceId,(await a.sources.read(a.who)).sourceId);
   assert.equal(calls.length,count);
   assert.equal(system.app.hasRoute({method:'POST',url:'/api/platform/first-letter/sources'}),false);
   assert.equal(system.app.hasRoute({method:'GET',url:'/api/platform/first-letter/sources'}),false);
  }finally{await system.app.close();}
 });
});

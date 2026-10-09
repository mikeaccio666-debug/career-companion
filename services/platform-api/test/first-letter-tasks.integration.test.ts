import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AccountFileArchive} from '../src/account-file-archive.ts';
import {LocalBlobStorage} from '../src/storage.ts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {OnboardingQuestionValues,PlatformProviderRuntime} from '@companion/platform-contracts';
import {createPrebirthFixture,withPrebirthLoopback,type PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {FirstLetterSources} from '../src/first-letter-sources.ts';
import {FirstLetterTasks} from '../src/first-letter-tasks.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword} from '../src/auth.ts';
let f:PrebirthFixture,encoded:string;
const password='Fictional-first-letter-task-password';
before(async()=>{f=await createPrebirthFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
const settings={rosterRevision:1,enabledExperts:['guide','applier','interviewer'] as const,localDate:'2026-10-09'};
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

const tasks=(a:Awaited<ReturnType<typeof setup>>)=>new FirstLetterTasks(f.db,f.config,a.sources);
const rows=(ownerId:string)=>f.db.query('SELECT * FROM platform_first_letter_tasks WHERE user_id=$1',[ownerId]);
async function exportProof(who:Awaited<ReturnType<typeof setup>>['who']){
 await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
 return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
}
test('concurrent preparations persist one identity; a fresh service reconstructs it without calling or advancing welcome',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{
  const a=await setup(runtime,values),count=calls.length,service=tasks(a);
  const snapshot=async()=>{
   const result:Record<string,unknown>={};
   for(const table of ['platform_messages','platform_companion_welcome','platform_jobs','platform_cost_reservations','platform_companion_generation_tasks'])
    result[table]=(await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1 ORDER BY 1',[a.who.userId])).rows;
   return result;
  };
  const before=await snapshot(),[one,two]=await Promise.all([service.prepare(a.who,settings),service.prepare(a.who,settings)]);
  assert.deepEqual(two,one);assert.deepEqual(await tasks(a).read(a.who,{taskId:one.task.taskId},settings),one);
  assert.deepEqual(await service.prepare(a.who,settings),one);assert.equal((await rows(a.who.userId)).rows.length,1);
  assert.equal(one.task.sourceId,one.preparation.sourceId);assert.equal(one.task.status,'prepared');
  assert(Object.isFrozen(one));assert(Object.isFrozen(one.task.settings.enabledExperts));
  assert.deepEqual(await snapshot(),before);assert.equal(calls.length,count);
  const row=(await rows(a.who.userId)).rows[0];
  const saved=f.crypto.openUtf8(row.preparation_ciphertext,{table:'platform_first_letter_tasks',column:'preparation_ciphertext',rowId:row.id,ownerId:a.who.userId,revision:1});
  assert.deepEqual(JSON.parse(saved),one.task);
  for(const forbidden of [a.who.tokenHash,'ds_statistics','stem_opt','messages','styleCard','factReferences'])assert(!saved.includes(forbidden));
 });
});
test('changed configuration is rejected without overwriting; foreign identifiers and injected fields cannot select tasks',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),b=await setup(runtime,{}),service=tasks(a),one=await service.prepare(a.who,settings);
  for(const changed of [{...settings,localDate:'2026-10-10'},{...settings,rosterRevision:2},{...settings,enabledExperts:[]}]){
   await assert.rejects(service.prepare(a.who,changed),{code:'FIRST_LETTER_TASK_PREPARATION_CHANGED'});
   await assert.rejects(service.read(a.who,{taskId:one.task.taskId},changed),{code:'FIRST_LETTER_TASK_PREPARATION_CHANGED'});
  }
  assert.deepEqual(await service.prepare(a.who,settings),one);
  await assert.rejects(tasks(b).read(b.who,{taskId:one.task.taskId},settings),{code:'NOT_FOUND'});
  await assert.rejects(service.read(a.who,{taskId:randomUUID()},settings),{code:'NOT_FOUND'});
  for(const selection of [{taskId:'bad'},{taskId:one.task.taskId,facts:[]},null])
   await assert.rejects(service.read(a.who,selection,settings),{code:'FIRST_LETTER_TASK_INPUT_INVALID'});
  await assert.rejects(service.prepare({...a.who,tokenHash:b.who.tokenHash},settings),{code:'AUTH_REQUIRED'});
  await assert.rejects(service.prepare({...a.who,sourceId:one.task.sourceId} as any,settings),{code:'AUTH_REQUIRED'});
  assert.equal((await rows(a.who.userId)).rows.length,1);assert.equal((await rows(b.who.userId)).rows.length,0);
 });
});
test('cipher relocation, corruption and changed row metadata fail closed; export does not consume proof',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),b=await setup(runtime,values),service=tasks(a);
  const one=await service.prepare(a.who,settings);await tasks(b).prepare(b.who,settings);
  const row=(await rows(a.who.userId)).rows[0],foreign=(await rows(b.who.userId)).rows[0],token=await exportProof(a.who);
  const broken=Buffer.from(row.preparation_ciphertext);broken[broken.length-1]^=1;
  const fail=async()=>{
   await assert.rejects(service.read(a.who,{taskId:one.task.taskId},settings),{code:'FIRST_LETTER_TASK_UNAVAILABLE'});
   await assert.rejects(new AccountCoreExport(f.db,f.config).capture(a.who,token),{code:'FIRST_LETTER_TASK_UNAVAILABLE'});
   assert.equal((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 ORDER BY verified_at DESC LIMIT 1",[a.who.userId])).rows[0].consumed_at,null);
  };
  for(const cipher of [broken,foreign.preparation_ciphertext]){
   await f.db.query('UPDATE platform_first_letter_tasks SET preparation_ciphertext=$2 WHERE id=$1',[row.id,cipher]);await fail();
  }
  await f.db.query('UPDATE platform_first_letter_tasks SET preparation_ciphertext=$2,source_id=$3 WHERE id=$1',
   [row.id,row.preparation_ciphertext,'first_letter_source_'+'0'.repeat(64)]);await fail();
  await f.db.query('UPDATE platform_first_letter_tasks SET source_id=$2 WHERE id=$1',[row.id,row.source_id]);
  const result=await new AccountCoreExport(f.db,f.config).capture(a.who,token);
  assert.deepEqual(result.sections.firstLetterTasks,[one.task]);
 });
});
test('live reads require current consent and safety, while account export retains the historical preparation',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),b=await setup(runtime,values);
  const one=await tasks(a).prepare(a.who,settings),other=await tasks(b).prepare(b.who,settings);
  const token=await exportProof(a.who);
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.who.userId]);
  await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[a.who.userId]);
  await assert.rejects(tasks(a).read(a.who,{taskId:one.task.taskId},settings),(e:any)=>e.status===403);
  await assert.rejects(tasks(a).prepare(a.who,settings),(e:any)=>e.status===403);
  await f.db.query("UPDATE platform_companions SET status='retired',retired_at=clock_timestamp() WHERE id=$1",[one.task.companionId]);
  const result=await new AccountCoreExport(f.db,f.config).capture(a.who,token);
  assert.deepEqual(result.sections.firstLetterTasks,[one.task]);assert.equal(result.includedTables.length,142);
  assert(!result.remainingTables.includes('platform_first_letter_tasks'));assert.equal(result.complete,false);
  const text=JSON.stringify(result.sections.firstLetterTasks);
  for(const secret of [a.who.tokenHash,token,encoded,password,other.task.taskId,b.who.userId,'ciphertext','messages','ds_statistics'])assert(!text.includes(secret));
  await f.db.query('UPDATE platform_companion_name_submissions SET result_ciphertext=$2 WHERE user_id=$1',[b.who.userId,Buffer.alloc(64,1)]);
  await assert.rejects(tasks(b).read(b.who,{taskId:other.task.taskId},settings),(e:any)=>e.status===503);
 });
});
test('late revocation or cancellation after insertion rolls back the new task',async()=>{
 await withPrebirthLoopback(async runtime=>{
  for(const mode of ['revoke','abort']){
   const a=await setup(runtime,values),service=tasks(a),controller=new AbortController();
   const original=f.db.withBoundedTransaction.bind(f.db);
   f.db.withBoundedTransaction=async(run,options)=>original(c=>run(new Proxy(c,{get(target,key){
    if(key==='query')return async(sql:any,...args:any[])=>{
     const result=await(target.query as any)(sql,...args);
     if(typeof sql==='string'&&sql.startsWith('INSERT INTO platform_first_letter_tasks')){
      if(mode==='revoke')await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[a.who.userId]);
      else controller.abort();
     }
     return result;
    };
    const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
   }})),options);
   try{await assert.rejects(service.prepare(a.who,settings,controller.signal));}
   finally{f.db.withBoundedTransaction=original;}
   assert.equal((await rows(a.who.userId)).rows.length,0);
   await assert.rejects(service.prepare(a.who,settings,AbortSignal.abort()));
   assert.equal((await rows(a.who.userId)).rows.length,0);
  }
 });
});
test('ownership foreign keys reject cross-owner parents and account deletion cascades only its own task',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),b=await setup(runtime,{});
  const one=await tasks(a).prepare(a.who,settings),other=await tasks(b).prepare(b.who,settings);
  for(const [column,value] of [['user_id',b.who.userId],['welcome_id',other.task.welcomeId],['conversation_id',other.task.conversationId],['birth_receipt_id',other.task.birthReceiptId]]){
   await assert.rejects(f.db.query('UPDATE platform_first_letter_tasks SET '+column+'=$2 WHERE id=$1',[one.task.taskId,value]),{code:'23503'});
  }
  await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.who.userId]);
  assert.equal((await rows(a.who.userId)).rows.length,0);
  assert.deepEqual((await tasks(b).read(b.who,{taskId:other.task.taskId},settings)).task,other.task);
 });
});

test('the private file archive includes the same task metadata and disposes generated account files',async()=>{
 await withPrebirthLoopback(async runtime=>{
  const a=await setup(runtime,values),one=await tasks(a).prepare(a.who,settings),token=await exportProof(a.who);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-letter-export-'));
  try{
   const archive=new AccountFileArchive(f.db,f.config,new LocalBlobStorage(path.join(root,'blobs')),path.join(root,'archives'));
   const result=await archive.capture(a.who,token);
   try{
    const saved=JSON.parse(await fs.readFile(path.join(result.directory,'account.json'),'utf8'));
    assert.deepEqual(saved.sections.firstLetterTasks,[one.task]);
    assert.deepEqual(result.snapshot.sections.firstLetterTasks,[one.task]);
    assert.equal(saved.includedTables.length,145);assert.equal(saved.remainingTables.length,20);
    assert.equal(saved.complete,false);assert.equal(saved.filesIncluded,true);
    const wire=JSON.stringify(saved.sections.firstLetterTasks);
    for(const secret of [a.who.tokenHash,token,'preparation_ciphertext','styleCard','messages'])assert(!wire.includes(secret));
   }finally{await result.dispose();}
   assert.deepEqual(await fs.readdir(path.join(root,'archives')),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
});

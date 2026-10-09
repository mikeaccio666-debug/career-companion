import {createOnboardingSafetyClassifier} from '../src/onboarding-safety-classifier.ts';
import {createSafetyModelUsage} from '../src/safety-model-usage.ts';
import {resolveModelRoute} from '../src/model-routing.ts';
import {createPrebirthFixture,prebirthDetector,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {OnboardingSafetyDelivery} from '../src/onboarding-safety-delivery.ts';
import {OnboardingSafetyResponses} from '../src/onboarding-safety-responses.ts';
import {OnboardingSafetyFollowup} from '../src/onboarding-safety-followup.ts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {OnboardingAction,ProviderRequestAdmission} from '@companion/platform-contracts';
import type {FixedSessionContext} from '../src/auth.ts';
import {CareerProfiles} from '../src/career-profiles.ts';
import {CareerTargets} from '../src/career-targets.ts';
import {CareerStories} from '../src/career-stories.ts';
import {CareerPreparationSources} from '../src/career-preparation-sources.ts';
import {OnboardingDrafts} from '../src/onboarding-drafts.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,profiles:CareerProfiles;
before(async()=>{f=await createCompanionNameSafetyFixture();profiles=new CareerProfiles(f.db,f.config,FICTIONAL_LEGAL);});
after(async()=>{await f?.close();});
const command=(expectedRevision:number,action:OnboardingAction)=>({operationId:randomUUID(),expectedRevision,action});
async function action(who:FixedSessionContext,value:OnboardingAction){
 const draft=await f.store.read(who);return f.store.save(who,command(draft?.revision??0,value));
}
async function start(){const who=await f.actor();await action(who,{kind:'start',mode:'standard'});return who;}
const study:OnboardingAction={kind:'answer',questionId:'study',value:{degreeField:'ds_statistics',programChoice:null}};
const graduation:OnboardingAction={kind:'answer',questionId:'graduation',value:{month:'2028-05',graduated:false}};
const roles:OnboardingAction={kind:'answer',questionId:'roles',value:{kind:'selected',roles:['da','ds']}};
const l0={level:'L0',mode:'full',resolution:{kind:'answer',questionId:'study',value:{degreeField:'ds_statistics',programChoice:null}}};
const classify=(result:unknown)=>async(_input:unknown,admit:ProviderRequestAdmission)=>admit(async signal=>{signal.throwIfAborted();return result;});
async function claim(who:FixedSessionContext){const c=await f.store.claimSafety(who,{detectorRevision:7,leaseMs:60000});assert(c);return c;}

test('accepted O2 facts persist incrementally and become the real expert source, without granting tools',async()=>{
 const who=await start();assert.equal((await profiles.get(who)).profile,null);
 const first=await action(who,study);let p=(await profiles.get(who)).profile!;
 assert.equal(p.degreeField,'ds_statistics');assert.equal(p.graduationMonth,null);assert.equal(p.graduated,null);assert.deepEqual(p.targetTracks,[]);
 assert.equal(p.source,'user_entered');assert.deepEqual(p.intakeSource,{draftId:first.draft.id,revision:first.draft.revision});
 await action(who,graduation);const last=await action(who,roles);
 const restarted=new CareerProfiles(f.db,f.config,FICTIONAL_LEGAL);p=(await restarted.get(who)).profile!;
 assert.equal(p.revision,3);assert.equal(p.graduationMonth,'2028-05');assert.equal(p.graduated,false);assert.deepEqual(p.targetTracks,['ds','da']);
 assert.equal(p.intakeSource?.revision,last.draft.revision);
 const sources=new CareerPreparationSources(f.db,new CareerTargets(f.db,f.config,FICTIONAL_LEGAL),new CareerStories(f.db,f.config,FICTIONAL_LEGAL),undefined,undefined,undefined,restarted);
 const prepared=await sources.prepare(who,{skillId:'resume-revision'});
 assert(prepared.built.context.inputs.some(i=>i.input==='confirmed-profile'&&i.id===who.userId&&i.revision===3));assert.deepEqual(prepared.built.context.tools,{});
 assert.equal((await profiles.get(await f.actor())).profile,null);
 const rows=await f.db.withBoundedTransaction(async c=>{const rows=[];for await(const row of profiles.exportInTransaction(c,who))rows.push(row);return rows;});
 assert.deepEqual(rows[0],{section:'careerProfile',record:p});
});

test('skipping preserves unknowns; identity answers and unrelated intake do not enter the profile',async()=>{
 const empty=await start();
 for(const questionId of ['study','graduation','roles'] as const)await action(empty,{kind:'skip',questionId});
 assert.equal((await profiles.get(empty)).revision,0);
 const who=await start();await action(who,study);await action(who,{kind:'skip',questionId:'graduation'});await action(who,{kind:'skip',questionId:'roles'});
 const before=await profiles.get(who);
 let draft=await f.store.read(who);
 while(draft?.currentQuestion){draft=(await action(who,{kind:'skip',questionId:draft.currentQuestion})).draft;}
 assert.deepEqual(await profiles.get(who),before);assert.equal(before.profile?.graduationMonth,null);assert.deepEqual(before.profile?.targetTracks,[]);
 assert(!JSON.stringify(before).includes('programChoice'));assert(!JSON.stringify(before).includes('answersPartial'));
});

test('manual edit and deletion win over later intake, fresh reads and original operation replays',async()=>{
 for(const edit of ['manual','delete'] as const){
  const who=await start(),input=command(1,study);await f.store.save(who,input);
  if(edit==='manual')await profiles.mutate(who,'save',{operationId:randomUUID(),expectedRevision:1,confirmed:true,facts:{degreeField:'cs',graduationMonth:null,graduated:null,targetTracks:['swe']}});
  else await profiles.mutate(who,'delete',{operationId:randomUUID(),expectedRevision:1});
  const expected=await profiles.get(who);assert.equal(expected.profile?.intakeSource,undefined);
  await action(who,graduation);await action(who,roles);
  assert.equal((await f.store.save(who,input)).operation.replayed,true);
  await new OnboardingDrafts(f.db,f.config,FICTIONAL_LEGAL).read(who);
  assert.deepEqual(await profiles.get(who),expected);
 }
});

test('pending text stays private; only the actual accepted L0 answer projects once after all older checks clear',async()=>{
 const who=await start();
 await action(who,{kind:'text',questionId:'study',text:'Fictional older note.'});
 await action(who,{kind:'text',questionId:'study',text:'Fictional newer degree note.'});
 const older=await claim(who),newer=await claim(who);
 assert.equal((await profiles.get(who)).revision,0);
 assert.equal((await f.store.processSafety(newer,classify(l0))).advanced,false);
 assert.equal((await profiles.get(who)).revision,0);
 assert.equal((await f.store.processSafety(older,classify({level:'L0',mode:'full',resolution:{kind:'unmatched'}}))).advanced,true);
 const expected=await profiles.get(who);assert.equal(expected.revision,1);assert.equal(expected.profile?.degreeField,'ds_statistics');
 assert.equal(expected.profile?.intakeSource?.revision,(await f.store.read(who))?.revision);
 assert(!JSON.stringify(expected).includes('Fictional'));
 for(const c of [older,newer])assert.equal((await f.store.processSafety(c,classify(l0))).replayed,true);
 assert.deepEqual(await profiles.get(who),expected);
});

test('L1/L2, unmatched text, stale claims and rejected commands never manufacture profile facts',async()=>{
 for(const result of [{level:'L1',mode:'full'},{level:'L2',mode:'full'},{level:'L0',mode:'full',resolution:{kind:'unmatched'}}]){
  const who=await start();await action(who,{kind:'text',questionId:'study',text:'Fictional test input only.'});
  await f.store.processSafety(await claim(who),classify(result));assert.equal((await profiles.get(who)).revision,0);
 }
 const who=await start();await action(who,{kind:'text',questionId:'study',text:'Fictional stale input.'});const c=await claim(who);
 await f.db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[c.submissionId]);
 await assert.rejects(f.store.processSafety(c,classify(l0)));
 await assert.rejects(f.store.save(who,command(0,study)));assert.equal((await profiles.get(who)).revision,0);
});

test('a late authorization failure rolls back the intake answer, profile and both operation receipts together',async()=>{
 const who=await start(),before=await f.store.read(who),original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client);let reset=false;
  const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{
   const result=await(query as any)(...args);
   if(!reset&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_career_profiles')){
    reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);
   }return result;
  };return Reflect.get(target,key);}});return run(guarded);
 },options);
 try{await assert.rejects(f.store.save(who,command(before!.revision,study)),(e:any)=>e.code==='AUTH_REQUIRED');}
 finally{f.db.withBoundedTransaction=original;}
 assert.deepEqual(await f.store.read(who),before);assert.equal((await profiles.get(who)).revision,0);
 assert.equal((await f.db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1',[who.userId])).rowCount,1);
 assert.equal((await f.db.query('SELECT * FROM platform_career_profile_operations WHERE user_id=$1',[who.userId])).rowCount,0);
});

test('deletion before an in-flight text result finishes prevents automatic recreation',async()=>{
 const who=await start();await action(who,study);
 await action(who,{kind:'text',questionId:'graduation',text:'Fictional graduation date.'});const c=await claim(who);
 await profiles.mutate(who,'delete',{operationId:randomUUID(),expectedRevision:1});
 assert.equal((await f.store.processSafety(c,classify({level:'L0',mode:'full',resolution:graduation}))).advanced,true);
 assert.equal((await profiles.get(who)).profile,null);assert.equal((await profiles.get(who)).revision,2);
});

test('lease expiry during projection rolls back the classifier result, draft advance and profile together',async()=>{
 const who=await start();await action(who,{kind:'text',questionId:'study',text:'Fictional delayed degree note.'});
 const c=await claim(who),before=await f.store.read(who),original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client);
  const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{
   const result=await(query as any)(...args);
   if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_career_profiles'))
    await query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[c.submissionId]);
   return result;
  };return Reflect.get(target,key);}});return run(guarded);
 },options);
 try{await assert.rejects(f.store.processSafety(c,classify(l0)),(e:any)=>e.code==='ONBOARDING_SAFETY_CLAIM_CHANGED');}
 finally{f.db.withBoundedTransaction=original;}
 assert.deepEqual(await f.store.read(who),before);assert.equal((await profiles.get(who)).revision,0);
 const row=(await f.db.query('SELECT status,result_ciphertext FROM platform_onboarding_safety_submissions WHERE id=$1',[c.submissionId])).rows[0];
 assert.equal(row.status,'running');assert.equal(row.result_ciphertext,null);
});

test('a pre-existing manual profile is retained, and a concurrent manual edit can never be silently overwritten by intake',async()=>{
 const who=await start(),manual={operationId:randomUUID(),expectedRevision:0,confirmed:true,facts:{degreeField:'cs',graduationMonth:null,graduated:null,targetTracks:['swe']}};
 await profiles.mutate(who,'save',manual);const expected=await profiles.get(who);
 await action(who,study);assert.deepEqual(await profiles.get(who),expected);
 const other=await start();await action(other,study);
 const outcomes=await Promise.allSettled([
  profiles.mutate(other,'save',{...manual,operationId:randomUUID(),expectedRevision:1}),
  action(other,graduation)
 ]);
 assert.equal(outcomes[1].status,'fulfilled');
 const current=await profiles.get(other);
 if(outcomes[0].status==='fulfilled'){assert.equal(current.profile?.degreeField,'cs');assert.equal(current.profile?.graduationMonth,null);assert.equal(current.profile?.intakeSource,undefined);}
 else{assert.equal((outcomes[0].reason as any).code,'CAREER_PROFILE_REVISION_CHANGED');assert.equal(current.profile?.graduationMonth,'2028-05');}
});

for(const protocol of ['native','legacy'] as const)test(protocol+' resource continuation projects the already accepted newer answer, never the earlier risk text',async()=>{
 const fixture=await createPrebirthFixture();
 try{
  const who=await fixture.actor(),store=fixture.store,profiles=new CareerProfiles(fixture.db,fixture.config,FICTIONAL_LEGAL);
  let draft=(await store.save(who,command(0,{kind:'start',mode:'standard'}))).draft;
  for(const text of ['Fictional prebirth high marker, older risk fixture.','Fictional newer course answer.'])
   draft=(await store.save(who,command(draft.revision,{kind:'text',questionId:'study',text}))).draft;
  const older=await store.claimSafety(who,{detectorRevision:prebirthDetector.revision,leaseMs:60000});
  const newer=await store.claimSafety(who,{detectorRevision:prebirthDetector.revision,leaseMs:60000});assert(older);assert(newer);
  await withPrebirthLoopback(async(runtime,requests)=>{
   for(const claim of [newer,older]){
    const usage=createSafetyModelUsage(fixture.db,claim,resolveModelRoute(fixture.config,runtime,'safety_classify'),100);
    const executor=createOnboardingSafetyClassifier({claim,profile:prebirthDetector,config:fixture.config,runtime,usage});
    await store.processSafety(claim,executor.classify,undefined,executor.guard);
   }
   assert.equal(requests.length,1);
  },'L0',l0.resolution);
  assert.equal((await profiles.get(who)).revision,0);
  if(protocol==='native'){
   const service=new OnboardingSafetyDelivery(fixture.db,fixture.config,FICTIONAL_LEGAL,fixture.bundle,fixture.review);
   const publication=await service.publish(who,{operationId:randomUUID(),submissionId:older.submissionId,expectedEdition:0});assert(publication);
   const projection=await service.issueBodyProjection(who,{publicationId:publication.publicationId});
   const send=async(action:any)=>{
    const state=await service.read(who,{publicationId:publication.publicationId});
    return service.act(who,{operationId:randomUUID(),publicationId:publication.publicationId,expectedPublicationRevision:state.revision,action});
   };
   const present=await send({kind:'present_body',bodyProjectionId:projection.bodyProjectionId});assert(present.presentationReceipt);
   await send({kind:'acknowledge',presentationReceipt:present.presentationReceipt});
   assert.equal((await profiles.get(who)).revision,0);
   const state=await service.read(who,{publicationId:publication.publicationId});
   const request={operationId:randomUUID(),publicationId:publication.publicationId,expectedPublicationRevision:state.revision,
    action:{kind:'continue_intake',presentationReceipt:present.presentationReceipt}};
   await service.act(who,request);const current=await profiles.get(who);
   await service.act(who,request);assert.deepEqual(await profiles.get(who),current);
  }else{
   await new OnboardingSafetyResponses(fixture.db,fixture.config,FICTIONAL_LEGAL,fixture.bundle).prepareSubmission(older.submissionId);
   const service=new OnboardingSafetyFollowup(fixture.db,fixture.config,FICTIONAL_LEGAL),state=await service.read(who),publication=state.publications[0];assert(publication);assert(state.draft);
   const send=(action:any)=>service.act(who,{operationId:randomUUID(),publicationId:publication.publicationId,expectedDraftRevision:state.draft!.revision,action});
   const present=await send({kind:'present'});assert(present.presentationReceipt);
   await send({kind:'acknowledge',presentationReceipt:present.presentationReceipt});
   assert.equal((await profiles.get(who)).revision,0);
   await send({kind:'continue_intake',presentationReceipt:present.presentationReceipt});
  }
  const current=await profiles.get(who);assert.equal(current.revision,1);assert.equal(current.profile?.degreeField,'ds_statistics');
  assert.equal(current.profile?.intakeSource?.revision,(await store.read(who))?.revision);
  assert(!JSON.stringify(current).includes('Fictional'));
  assert.equal((await fixture.db.query('SELECT level FROM platform_onboarding_safety_submissions WHERE id=$1',[older.submissionId])).rows[0].level,'L2');
 }finally{await fixture.close();}
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OnboardingDraft, OnboardingFollowupState, OnboardingEntryState } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';

// Real HTTP/auth/transactions, with fictional accounts and an explicitly admitted synthetic classifier.
// These tests never call a provider, contact a resource, send mail, or open an execution lease.
const base=readConfig(), schema='onboarding_http_'+randomUUID().replaceAll('-',''), url=new URL(base.databaseUrl);
assert(process.env.PLATFORM_DATABASE_URL,'Supply a dedicated verification database URL.');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Use a loopback verification database.');
assert.notEqual(url.port,'5442','Preserve the local development database.');
url.searchParams.set('options','-c search_path='+schema);
const admin=new Database(base.databaseUrl), db=new Database(url.toString());
const config={...base,databaseUrl:url.toString(),dataCrypto:readDataCrypto({PLATFORM_DATA_KEY:'99'.repeat(32)})!,
  requireVerifiedEmail:false,accountEmail:undefined,s3:undefined,mcp:undefined,webStaticDir:undefined,
  safetyDetectorProfilePath:undefined,safetyResponseBundlePath:undefined,workbenchEnabled:false,
  modelRoutes:{},allowedOrigins:new Set(['http://localhost:4321'])};
const store=new OnboardingDrafts(db,config,FICTIONAL_LEGAL),bundle=fictionalBundle(), modelCalls:string[]=[];
let system:Awaited<ReturnType<typeof buildApp>>, limited:Awaited<ReturnType<typeof buildApp>>, created=false;
const additionalSystems:Awaited<ReturnType<typeof buildApp>>[]=[];
let directory:string|undefined;
const prefix='/api/platform';
type Actor=FixedSessionContext & {cookie:string};
async function actor():Promise<Actor> {
  const userId=randomUUID(),raw=randomUUID(),hash=tokenHash(raw);
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional HTTP student','fictional-unused-password','student',clock_timestamp())`,[userId,userId+'@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`,[userId,hash]);
  await seedFictionalConsent(db,userId);return {userId,tokenHash:hash,cookie:'companion_session='+raw};
}
const headers=(who:Actor)=>({cookie:who.cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId,origin:'http://localhost:4321'});
const command=(revision:number,action:unknown)=>({operationId:randomUUID(),expectedRevision:revision,action});
const runtime={
  capabilities:()=>[],
  async *streamChat(){modelCalls.push('chat');throw new Error('No provider in the HTTP fixture.');},
  async executeJob(){modelCalls.push('job');throw new Error('No jobs in the HTTP fixture.');},
  async createVoiceSession(){modelCalls.push('voice');throw new Error('No voice in the HTTP fixture.');},
  async transcribe(){modelCalls.push('transcribe');throw new Error('No audio in the HTTP fixture.');},
  async speech(){modelCalls.push('speech');throw new Error('No speech in the HTTP fixture.');},
};
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;await db.migrate();await seedFictionalActiveLegal(db);
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'onboarding-http-assets-'));
  system=await buildApp({db,config,legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false,
    requestLimits:{policies:{api:{max:2000,windowSeconds:60}}}});
  limited=await buildApp({db,config,legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false,
    requestLimits:{policies:{api:{max:1,windowSeconds:60}}}});
});
after(async()=>{
  try {
    if(system)await system.app.close();if(limited)await limited.app.close();
    for(const target of additionalSystems)await target.app.close();
    assert.deepEqual(modelCalls,[],'Neither fixed resources nor choice-based intake calls a model.');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_runtime_leases')).rows[0].n,0);
  } finally {
    await db.close();
    try {if(created){await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);}}
    finally {await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});}
  }
});
async function risk(who:Actor) {
  let draft=(await store.save(who,command(0,{kind:'start',mode:'standard'}))).draft;
  draft=(await store.save(who,command(draft.revision,{kind:'text',questionId:'study',text:'Fictional risk fixture; no real personal text.'}))).draft;
  const claim=await store.claimSafety(who,{detectorRevision:17});assert(claim);
  await store.processSafety(claim,async(_input,admission)=>admission(async()=>({level:'L2',mode:'full'})));
  const operator=await actor();
  await db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
  [bundle.revision,bundle.contentDigest,bundle.reviewDigest,operator.userId]);
  await new OnboardingSafetyResponses(db,config,FICTIONAL_LEGAL,bundle).prepareSubmission(claim.submissionId);
  return claim;
}
test('HTTP saves a revisioned choice draft and returns the actual fixed current question after reconnect',async()=>{
  const who=await actor();
  const empty=await system.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.equal(empty.statusCode,200);assert.equal(empty.json<{entry:OnboardingEntryState}>().entry.draft,null);
  assert.deepEqual(empty.json<{entry:OnboardingEntryState}>().entry.answerSummaries,[]);
  const input=command(0,{kind:'start',mode:'standard'});
  const saved=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),payload:input});
  assert.equal(saved.statusCode,200);assert.equal(saved.json().result.draft.revision,1);
  const retry=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),payload:input});
  assert.equal(retry.json().result.operation.replayed,true);
  const reading=await system.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.match(String(reading.headers['cache-control']),/no-store/);
  const state=reading.json<{entry:OnboardingEntryState}>().entry;
  assert.equal(state.draft?.currentQuestion,'study');assert.equal(state.question?.prompt,'你现在读的是什么？');
  assert.equal(state.freeTextAvailable,false);assert.equal('clarification' in state.question!,false);
  const answered=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),
    payload:command(1,{kind:'answer',questionId:'study',value:{degreeField:'cs',programChoice:'24_month'}})});
  assert.equal(answered.statusCode,200);assert.equal(answered.json().result.draft.currentQuestion,'graduation');
  assert.equal(answered.json().result.draft.answersPartial.study.source,'user_entered');
  const reconnected=await system.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  const summary=reconnected.json<{entry:OnboardingEntryState}>().entry.answerSummaries;
  assert.equal(summary.length,1);assert.equal(summary[0].questionId,'study');assert.equal(summary[0].kind,'answered');
  assert.equal(summary[0].appliedRevision,2);assert.match(summary[0].label,/CS/);assert.match(summary[0].label,/两年/);
  assert.equal('clarification' in summary[0],false);assert.equal('value' in summary[0],false);
  const skipped=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),
    payload:command(2,{kind:'skip',questionId:'graduation'})});assert.equal(skipped.statusCode,200);
  const afterSkip=await system.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  const skippedEntry=afterSkip.json<{entry:OnboardingEntryState}>().entry;
  assert.equal(skippedEntry.draft?.currentQuestion,'roles');assert.equal(skippedEntry.answerSummaries.length,2);
  const skippedSummary=skippedEntry.answerSummaries[1];assert(skippedSummary.kind==='skipped');assert.equal(skippedSummary.reason,'user');
});
test('unconfigured text is rejected before storing an operation; HTTP cannot provide safety decisions',async()=>{
  const who=await actor(),draft=(await store.save(who,command(0,{kind:'start',mode:'standard'}))).draft;
  const response=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),
    payload:command(draft.revision,{kind:'text',questionId:'study',text:'Fictional text should not enter an unconfigured detector.'})});
  assert.equal(response.statusCode,503);assert.equal((await store.read(who))?.revision,draft.revision);
  const hostile=await system.app.inject({method:'POST',url:prefix+'/onboarding/safety/retry',headers:headers(who),payload:{level:'L0',handled:true}});
  assert.equal(hostile.statusCode,400);
});
test('private intake rejects missing/mismatched account context, origin, expired session and stale revision',async()=>{
  const who=await actor(),other=await actor();
  const missing=await system.app.inject({method:'GET',url:prefix+'/onboarding',headers:{cookie:who.cookie}});
  assert.equal(missing.statusCode,409);
  const mismatch=await system.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:{...headers(who),[PLATFORM_ACCOUNT_HEADER]:other.userId}});
  assert.equal(mismatch.statusCode,409);
  const absentOrigin=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:{cookie:who.cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId},payload:command(0,{kind:'start',mode:'standard'})});
  assert.equal(absentOrigin.statusCode,403);
  await store.save(who,command(0,{kind:'start',mode:'standard'}));
  const stale=await system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:headers(who),payload:command(0,{kind:'start',mode:'standard'})});
  assert.equal(stale.statusCode,409);
  await db.query(`UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`,[who.tokenHash]);
  const expired=await system.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:headers(who)});
  assert.equal(expired.statusCode,401);
});
test('actual fixed resources and acknowledgments survive ordinary API limits/current-terms loss; continue still requires consent',async()=>{
  const who=await actor(),source=await risk(who);
  await limited.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  const exhausted=await limited.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.equal(exhausted.statusCode,429);
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
  await db.query('DELETE FROM platform_safety_response_policy WHERE singleton=true');
  for(let count=0;count<3;count++) {
    const resource=await limited.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:headers(who)});
    assert.equal(resource.statusCode,200);assert.match(String(resource.headers['cache-control']),/no-store/);
  }
  const read=await limited.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:headers(who)});
  const followup=read.json<{followup:OnboardingFollowupState}>().followup,pub=followup.publications[0];assert(pub);assert(followup.draft);
  assert.equal(pub.submissionId,source.submissionId);assert.equal(pub.presented,false);assert.equal(pub.acknowledged,false);
  assert.equal(JSON.stringify(pub.response).includes('reviewRef'),false);
  const body=(action:unknown)=>({operationId:randomUUID(),expectedDraftRevision:followup.draft!.revision,publicationId:pub.publicationId,action});
  const presented=await limited.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:headers(who),payload:body({kind:'present'})});
  assert.equal(presented.statusCode,200);const receipt=presented.json().result.presentationReceipt;assert.equal(typeof receipt,'string');
  const ack=await limited.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:headers(who),payload:body({kind:'acknowledge',presentationReceipt:receipt})});
  assert.equal(ack.statusCode,200);assert.equal(ack.json().result.draft.state,'safety_paused');
  const resume=body({kind:'continue_intake',presentationReceipt:receipt});
  const refused=await limited.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:headers(who),payload:resume});
  assert.equal(refused.statusCode,403);assert.equal(refused.json().error.code,'TERMS_CONFIRMATION_REQUIRED');
  await seedFictionalConsent(db,who.userId);
  const continued=await limited.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:headers(who),payload:resume});
  assert.equal(continued.statusCode,200);assert.equal(continued.json().result.resumeStatus,'resumed');
  const draft=continued.json<{result:{draft:OnboardingDraft}}>().result.draft;
  assert.equal(draft.currentQuestion,'study');assert.equal(draft.state,'collecting');
  assert.equal((await db.query('SELECT level FROM platform_onboarding_safety_submissions WHERE id=$1',[source.submissionId])).rows[0].level,'L2');
});
test('malformed current intake asset files close new text while saved authenticated resources survive server reconstruction',async()=>{
  const who=await actor();await risk(who);assert(directory);
  const filename=path.join(directory,'fictional-invalid-assets.json');
  await fs.writeFile(filename,'{"schemaVersion":1,"fictionalInvalid":true}',{mode:0o600});
  const rebuilt=await buildApp({db,config:{...config,safetyDetectorProfilePath:filename,safetyResponseBundlePath:filename},
    legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false});additionalSystems.push(rebuilt);
  const resource=await rebuilt.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:headers(who)});
  assert.equal(resource.statusCode,200);assert.equal(resource.json().followup.publications.length,1);
  assert(resource.json().followup.publications[0].response.resourceCard.contacts.length>0);
  const intake=await rebuilt.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.equal(intake.statusCode,200);assert.equal(intake.json().entry.freeTextAvailable,false);
  assert.equal((await store.read(who))?.state,'safety_paused');
});

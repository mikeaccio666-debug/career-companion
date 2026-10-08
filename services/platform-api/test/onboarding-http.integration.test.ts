import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OnboardingDraft, OnboardingEntryState } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';
import { withStudentOnboardingFixture, studentJourneyHeaders, assertStudentJourneyResponse,
  type StudentOnboardingFixture } from './fixtures/companion-student-onboarding.ts';

// Real HTTP/auth/transactions and fictional accounts. The historical fixture
// uses an explicitly admitted synthetic classifier; native fixtures use only
// the strict loopback provider. No paid/external provider, contact, mail or lease.
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
  // Genuine pre-cutover039 foundation, explicitly invoked by this historical
  // fixture. The current public factory never creates publication from GET.
  const archived=await new OnboardingSafetyFollowup(db,config,FICTIONAL_LEGAL).read(who);
  const publication=archived.publications[0];assert(publication);assert.equal(publication.submissionId,claim.submissionId);
  assert.equal((await db.query('SELECT safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE user_id=$1',[who.userId])).rows[0].safety_resource_v2_draft_id,null);
  assert.equal((await db.query('SELECT 1 FROM platform_onboarding_safety_v2_publications WHERE user_id=$1',[who.userId])).rowCount,0);
  return claim;
}
async function historicalEvidence(who:Actor) {
  const evidence:Record<string,string[]>={};
  for(const table of ['platform_onboarding_drafts','platform_onboarding_operations','platform_onboarding_safety_submissions',
    'platform_onboarding_safety_responses','platform_onboarding_safety_publications','platform_onboarding_safety_followups',
    'platform_onboarding_resource_cutovers','platform_onboarding_safety_v2_publications','platform_onboarding_safety_v2_followups',
    'platform_safety_model_usage','platform_safety_question_scopes','platform_safety_question_occurrences'])
    evidence[table]=(await db.query(`SELECT row_to_json(t)::text AS value FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows.map(row=>row.value);
  return evidence;
}
async function currentArchiveObservation(target:Awaited<ReturnType<typeof buildApp>>,who:Actor,publicationId:string,saved:unknown,operationId:string) {
  const stable=await historicalEvidence(who);
  for(let i=0;i<3;i++) {
    const reading=await target.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:headers(who)});
    assert.equal(reading.statusCode,200);assert.match(String(reading.headers['cache-control']),/no-store/);
    // This is a cutover negative, not the positive resource coverage. Actual
    // archived cards are asserted through the legacy foundation; native050
    // current HTTP body/receipts have separate positive scenarios below.
    assert.deepEqual(reading.json().followup.publications,[]);
    assert.equal(Object.hasOwn(reading.json().followup,'question'),false);
    assert.deepEqual(await historicalEvidence(who),stable);
  }
  const replay=await target.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:{...headers(who),'content-type':'application/json'},payload:JSON.stringify(saved)});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().result.operation.id,operationId);assert.equal(replay.json().result.operation.replayed,true);
  assert.deepEqual(await historicalEvidence(who),stable);
  const mixed=await target.app.inject({method:'POST',url:prefix+'/onboarding/safety',headers:headers(who),
    payload:{...(saved as Record<string,unknown>),operationId:randomUUID()}});
  assert.equal(mixed.statusCode,409,mixed.body);assert.deepEqual(await historicalEvidence(who),stable);
  const counterfeitNative=await target.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:headers(who),
    payload:{sourceKind:'onboarding',publicationId,operationId:randomUUID(),expectedPublicationRevision:0,action:{kind:'need_support'}}});
  assert.equal(counterfeitNative.statusCode,404,counterfeitNative.body);assert.deepEqual(await historicalEvidence(who),stable);
}

/** Actual reviewer/ops recordReview+activate are created by the strict
 * loopback fixture. Copy/roles/contacts remain fictional, never professional
 * approval. This actor has a new native source, not a039-to050 fake bridge. */
async function nativeRisk(f:StudentOnboardingFixture) {
  const who=await f.register('Fictional native050 HTTP student'),h={...studentJourneyHeaders(who),'content-type':'application/json'};
  async function patch(payload:unknown) {
    const response=await f.system.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:h,payload:JSON.stringify(payload)});
    assertStudentJourneyResponse(response,200);return response.json().result.draft as OnboardingDraft;
  }
  let draft=await patch(command(0,{kind:'start',mode:'standard'}));assert(draft.currentQuestion);
  const rawOperationId=randomUUID();draft=await patch({expectedRevision:draft.revision,operationId:rawOperationId,
    action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional prebirth high marker; native HTTP fixture only.'}});
  const detected=await f.system.app.inject({method:'POST',url:prefix+'/onboarding/safety/retry',headers:h,payload:{}});
  assertStudentJourneyResponse(detected,200);assert.equal(detected.json().entry.draft.safety.level,'L2');assert.equal(detected.json().entry.draft.safety.mode,'keyword_only');
  const rows=(await f.prebirth.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1 AND draft_id=$2 AND operation_id=$3',[who.userId,draft.id,rawOperationId])).rows;
  assert.equal(rows.length,1);const submissionId=rows[0].id as string;
  const published=await f.system.app.inject({method:'POST',url:prefix+'/companion/support/publications',headers:h,
    payload:{sourceRef:{kind:'onboarding',submissionId},operationId:randomUUID(),expectedEdition:0}});
  assertStudentJourneyResponse(published,200);const publication=published.json().publication;assert(publication);assert.equal(publication.sourceKind,'onboarding');
  const p=(await f.prebirth.db.query('SELECT * FROM platform_onboarding_safety_v2_publications WHERE id=$1 AND user_id=$2',[publication.publicationId,who.userId])).rows[0];assert(p);
  const reviews=(await f.prebirth.db.query('SELECT kind FROM platform_safety_delivery_review_operations WHERE asset_id=$1 ORDER BY kind',[p.asset_id])).rows;
  assert.deepEqual(reviews.map(row=>row.kind),['activate','review']);
  assert.equal((await f.prebirth.db.query('SELECT 1 FROM platform_onboarding_safety_publications WHERE user_id=$1',[who.userId])).rowCount,0);
  const source=async()=>(await f.prebirth.db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1',[submissionId])).rows[0].value;
  const capsule=async()=>(await f.prebirth.db.query('SELECT row_to_json(p)::text AS value FROM platform_onboarding_safety_v2_publications p WHERE id=$1',[publication.publicationId])).rows[0].value;
  return {who,publication,submissionId,source,capsule,sourceBytes:await source(),capsuleBytes:await capsule(),calls:f.requests.length};
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
test('genuine pre-cutover039 foundation preserves cards/ack/consent and current HTTP only replays its saved original operations',async()=>{
  const who=await actor(),source=await risk(who);
  const legacy=new OnboardingSafetyFollowup(db,config,FICTIONAL_LEGAL);
  const sourceBytes=(await db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1',[source.submissionId])).rows[0].value;
  const archiveBytes=(await db.query('SELECT row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE user_id=$1',[who.userId])).rows[0].value;
  await limited.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  const exhausted=await limited.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.equal(exhausted.statusCode,429);
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
  await db.query('DELETE FROM platform_safety_response_policy WHERE singleton=true');
  const followup=await legacy.read(who),pub=followup.publications[0];assert(pub);assert(followup.draft);
  assert.equal(pub.submissionId,source.submissionId);assert.equal(pub.presented,false);assert.equal(pub.acknowledged,false);
  assert(pub.response.resourceCard.contacts.length>0);
  assert.equal(JSON.stringify(pub.response).includes('reviewRef'),false);
  const body=(action:unknown)=>({operationId:randomUUID(),expectedDraftRevision:followup.draft!.revision,publicationId:pub.publicationId,action});
  // Actual historical client declaration, not a DOM/asked-time claim. Current
  // public POST never creates these operations; only exact saved replay below.
  const presentation=body({kind:'present'}),presented=await legacy.act(who,presentation);
  const receipt=presented.presentationReceipt;assert.equal(typeof receipt,'string');
  const acknowledgment=body({kind:'acknowledge',presentationReceipt:receipt}),ack=await legacy.act(who,acknowledgment);
  assert.equal(ack.draft.state,'safety_paused');
  const resume=body({kind:'continue_intake',presentationReceipt:receipt});
  await assert.rejects(legacy.act(who,resume),(error:unknown)=>error instanceof ApiError&&error.status===403&&error.code==='TERMS_CONFIRMATION_REQUIRED');
  await seedFictionalConsent(db,who.userId);
  const continued=await legacy.act(who,resume);assert.equal(continued.resumeStatus,'resumed');
  const draft=continued.draft;
  assert.equal(draft.currentQuestion,'study');assert.equal(draft.state,'collecting');
  assert.equal((await db.query('SELECT level FROM platform_onboarding_safety_submissions WHERE id=$1',[source.submissionId])).rows[0].level,'L2');
  await currentArchiveObservation(limited,who,pub.publicationId,presentation,presentation.operationId);
  await currentArchiveObservation(limited,who,pub.publicationId,acknowledgment,acknowledgment.operationId);
  await currentArchiveObservation(limited,who,pub.publicationId,resume,resume.operationId);
  assert.equal((await db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1',[source.submissionId])).rows[0].value,sourceBytes);
  assert.equal((await db.query('SELECT row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE user_id=$1',[who.userId])).rows[0].value,archiveBytes);
});
test('genuine039 archived foundation survives malformed current assets; reconstructed public HTTP preserves bytes and exact saved receipts without new legacy transport',async()=>{
  const who=await actor(),source=await risk(who);assert(directory);
  const legacy=new OnboardingSafetyFollowup(db,config,FICTIONAL_LEGAL),archived=await legacy.read(who),pub=archived.publications[0];assert(pub);assert(archived.draft);
  assert.equal(archived.publications.length,1);assert(pub.response.resourceCard.contacts.length>0);
  const sourceBytes=(await db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1',[source.submissionId])).rows[0].value;
  const archiveBytes=(await db.query('SELECT row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE user_id=$1',[who.userId])).rows[0].value;
  const input=(action:unknown)=>({operationId:randomUUID(),expectedDraftRevision:archived.draft!.revision,publicationId:pub.publicationId,action});
  const presentation=input({kind:'present'}),shown=await legacy.act(who,presentation);assert(shown.presentationReceipt);
  const acknowledgment=input({kind:'acknowledge',presentationReceipt:shown.presentationReceipt}),ack=await legacy.act(who,acknowledgment);assert.equal(ack.draft.state,'safety_paused');
  const continuation=input({kind:'continue_intake',presentationReceipt:shown.presentationReceipt});
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
  await assert.rejects(legacy.act(who,continuation),(error:unknown)=>error instanceof ApiError&&error.status===403&&error.code==='TERMS_CONFIRMATION_REQUIRED');
  await seedFictionalConsent(db,who.userId);const continued=await legacy.act(who,continuation);assert.equal(continued.resumeStatus,'resumed');
  const filename=path.join(directory,'fictional-invalid-assets.json');
  await fs.writeFile(filename,'{"schemaVersion":1,"fictionalInvalid":true}',{mode:0o600});
  const rebuilt=await buildApp({db,config:{...config,safetyDetectorProfilePath:filename,safetyResponseBundlePath:filename},
    legalBundle:FICTIONAL_LEGAL,runtime,enableQueue:false});additionalSystems.push(rebuilt);
  const memorySession={userId:who.userId,tokenHash:who.tokenHash};
  const savedMemory=await rebuilt.sharedMemories.mutate(memorySession,'create',null,{operationId:randomUUID(),content:'Fictional saved preference with unavailable current assets',category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
  await assert.rejects(rebuilt.memorySafety.runCurrent(memorySession,savedMemory.memory.id),(error:unknown)=>error instanceof ApiError&&error.status===503&&error.code==='MEMORY_SAFETY_UNAVAILABLE');
  assert.equal((await rebuilt.memorySafety.observe(memorySession,savedMemory.memory.id)).status,'unavailable');
  assert.equal((await db.query('SELECT id FROM platform_memory_safety_sources WHERE memory_id=$1',[savedMemory.memory.id])).rowCount,0);
  const invalidConfig={...config,safetyDetectorProfilePath:filename,safetyResponseBundlePath:filename};
  const independentArchive=await new OnboardingSafetyFollowup(db,invalidConfig,FICTIONAL_LEGAL).read(who);
  assert.equal(independentArchive.publications.length,1);assert(independentArchive.publications[0].response.resourceCard.contacts.length>0);
  await currentArchiveObservation(rebuilt,who,pub.publicationId,presentation,presentation.operationId);
  await currentArchiveObservation(rebuilt,who,pub.publicationId,acknowledgment,acknowledgment.operationId);
  await currentArchiveObservation(rebuilt,who,pub.publicationId,continuation,continuation.operationId);
  const intake=await rebuilt.app.inject({method:'GET',url:prefix+'/onboarding',headers:headers(who)});
  assert.equal(intake.statusCode,200);assert.equal(intake.json().entry.freeTextAvailable,false);
  assert.equal((await store.read(who))?.state,'collecting');
  assert.equal((await db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1',[source.submissionId])).rows[0].value,sourceBytes);
  assert.equal((await db.query('SELECT row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE user_id=$1',[who.userId])).rows[0].value,archiveBytes);
});

test('native050 HTTP body/present/ack survive real ordinary quota, missing current assets and email/terms gates; continuation retains current admission',async()=>{
  await withStudentOnboardingFixture(async f=>{
    const original=await nativeRisk(f),h=studentJourneyHeaders(original.who),target={sourceKind:'onboarding',publicationId:original.publication.publicationId};
    const limitedNative=await buildApp({db:f.prebirth.db,config:f.config,legalBundle:FICTIONAL_LEGAL,runtime:f.runtime,enableQueue:false,
      requestLimits:{policies:{api:{max:1,windowSeconds:60}}}});
    try {
      // Actual ordinary HTTP requests in nativeRisk already consumed this
      // actor's shared database quota counter; rebuilding App does not reset it.
      const exhausted=await limitedNative.app.inject({method:'GET',url:prefix+'/onboarding',headers:h});
      assert.equal(exhausted.statusCode,429,exhausted.body);assert.equal(exhausted.json().error.code,'REQUEST_LIMIT_REACHED');
      const verified=(await f.prebirth.db.query('SELECT email_verified_at::text AS verified FROM platform_users WHERE id=$1',[original.who.userId])).rows[0].verified;assert.equal(typeof verified,'string');
      await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[original.who.userId]);
      await f.prebirth.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[original.who.userId]);
      await f.prebirth.db.query('DELETE FROM platform_safety_response_policy WHERE singleton=true');
      await f.prebirth.db.query('DELETE FROM platform_safety_delivery_policy WHERE singleton=true');
      const stable=await f.evidence(original.who.userId);
      for(let i=0;i<3;i++) {
        const index=await limitedNative.app.inject({method:'GET',url:prefix+'/companion/support',headers:h});assertStudentJourneyResponse(index,200);
        const state=index.json().index.sources.find((item:{sourceRef:{submissionId:string}})=>item.sourceRef.submissionId===original.submissionId)?.publication;
        assert(state);assert.equal(state.publicationId,original.publication.publicationId);assert.equal(state.handled,false);
        const read=await limitedNative.app.inject({method:'GET',url:prefix+`/companion/support/onboarding/${original.publication.publicationId}`,headers:h});assertStudentJourneyResponse(read,200);
        assert.deepEqual(await f.evidence(original.who.userId),stable);
      }
      const projectionReply=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/body',headers:h,payload:target});assertStudentJourneyResponse(projectionReply,200);
      const projection=projectionReply.json().projection;assert.equal(projection.submissionId,original.submissionId);assert.equal(Object.hasOwn(projection.body,'question'),false);assert(projection.body.resourceCard.contacts.length>0);
      const presentation={...target,operationId:randomUUID(),expectedPublicationRevision:0,action:{kind:'present_body',bodyProjectionId:projection.bodyProjectionId}};
      const shown=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:presentation});assertStudentJourneyResponse(shown,200);
      const receipt=shown.json().result.presentationReceipt;assert.equal(typeof receipt,'string');
      const ack=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:{...target,operationId:randomUUID(),
        expectedPublicationRevision:shown.json().result.state.revision,action:{kind:'acknowledge',presentationReceipt:receipt}}});assertStudentJourneyResponse(ack,200);
      assert.equal(ack.json().result.state.acknowledged,true);assert.equal(ack.json().result.state.handled,false);
      const continuation={...target,operationId:randomUUID(),expectedPublicationRevision:ack.json().result.state.revision,action:{kind:'continue_intake',presentationReceipt:receipt}};
      const blockedState=await f.evidence(original.who.userId);
      const email=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:continuation});assert.equal(email.statusCode,403,email.body);assert.equal(email.json().error.code,'EMAIL_VERIFICATION_REQUIRED');
      assert.deepEqual(await f.evidence(original.who.userId),blockedState);
      await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=$2::timestamptz WHERE id=$1',[original.who.userId,verified]);
      const terms=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:continuation});assert.equal(terms.statusCode,403,terms.body);assert.equal(terms.json().error.code,'TERMS_CONFIRMATION_REQUIRED');
      assert.deepEqual(await f.evidence(original.who.userId),blockedState);
      await seedFictionalConsent(f.prebirth.db,original.who.userId);
      const continued=await limitedNative.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:continuation});assertStudentJourneyResponse(continued,200);
      assert.equal(continued.json().result.state.handled,true);
      assert.equal((await f.prebirth.store.read(original.who))?.state,'collecting');
      assert.equal(await original.source(),original.sourceBytes);assert.equal(await original.capsule(),original.capsuleBytes);assert.equal(f.requests.length,original.calls);
      assert.equal((await f.prebirth.db.query('SELECT 1 FROM platform_safety_question_occurrences WHERE user_id=$1',[original.who.userId])).rowCount,0);
    } finally { await limitedNative.app.close(); }
  });
});

test('native050 archived professional fixture body and current receipts survive malformed assets and real server reconstruction without old039 transport',async()=>{
  await withStudentOnboardingFixture(async f=>{
    const original=await nativeRisk(f),h=studentJourneyHeaders(original.who),target={sourceKind:'onboarding',publicationId:original.publication.publicationId};
    const filename=path.join(f.config.storageDir,'fictional-invalid-native-assets-'+randomUUID()+'.json');
    await fs.writeFile(filename,'{"schemaVersion":1,"fictionalInvalid":true}',{mode:0o600,flag:'wx'});
    let rebuilt:Awaited<ReturnType<typeof buildApp>>|undefined;
    try {
      rebuilt=await buildApp({db:f.prebirth.db,config:{...f.config,safetyDetectorProfilePath:filename,safetyResponseBundlePath:filename,safetyDeliveryReviewPath:filename},
        legalBundle:FICTIONAL_LEGAL,runtime:f.runtime,enableQueue:false});
      const stable=await f.evidence(original.who.userId);
      const index=await rebuilt.app.inject({method:'GET',url:prefix+'/companion/support',headers:h});assertStudentJourneyResponse(index,200);
      const state=index.json().index.sources.find((item:{sourceRef:{submissionId:string}})=>item.sourceRef.submissionId===original.submissionId)?.publication;
      assert(state);assert.equal(state.publicationId,original.publication.publicationId);assert.equal(state.level,'L2');
      const old=await rebuilt.app.inject({method:'GET',url:prefix+'/onboarding/safety',headers:h});assertStudentJourneyResponse(old,200);assert.deepEqual(old.json().followup.publications,[]);
      assert.deepEqual(await f.evidence(original.who.userId),stable);
      const body=await rebuilt.app.inject({method:'POST',url:prefix+'/companion/support/body',headers:h,payload:target});assertStudentJourneyResponse(body,200);
      assert(body.json().projection.body.resourceCard.contacts.length>0);assert.equal(Object.hasOwn(body.json().projection.body,'question'),false);assert.equal(body.json().projection.submissionId,original.submissionId);
      const shown=await rebuilt.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:{...target,operationId:randomUUID(),expectedPublicationRevision:state.revision,
        action:{kind:'present_body',bodyProjectionId:body.json().projection.bodyProjectionId}}});assertStudentJourneyResponse(shown,200);const receipt=shown.json().result.presentationReceipt;assert.equal(typeof receipt,'string');
      const ack=await rebuilt.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:{...target,operationId:randomUUID(),expectedPublicationRevision:shown.json().result.state.revision,
        action:{kind:'acknowledge',presentationReceipt:receipt}}});assertStudentJourneyResponse(ack,200);assert.equal(ack.json().result.state.acknowledged,true);
      const intake=await rebuilt.app.inject({method:'GET',url:prefix+'/onboarding',headers:h});assertStudentJourneyResponse(intake,200);assert.equal(intake.json().entry.freeTextAvailable,false);
      const beforeRefusal=await f.evidence(original.who.userId);
      const refused=await rebuilt.app.inject({method:'PATCH',url:prefix+'/onboarding',headers:h,payload:command(intake.json().entry.draft.revision,{kind:'text',questionId:'study',text:'Fictional blocked replacement.'})});assert.equal(refused.statusCode,503,refused.body);
      assert.deepEqual(await f.evidence(original.who.userId),beforeRefusal);
      const continued=await rebuilt.app.inject({method:'POST',url:prefix+'/companion/support/actions',headers:h,payload:{...target,operationId:randomUUID(),expectedPublicationRevision:ack.json().result.state.revision,
        action:{kind:'continue_intake',presentationReceipt:receipt}}});assertStudentJourneyResponse(continued,200);assert.equal(continued.json().result.state.handled,true);
      assert.equal((await f.prebirth.store.read(original.who))?.state,'collecting');
      assert.equal(await original.source(),original.sourceBytes);assert.equal(await original.capsule(),original.capsuleBytes);assert.equal(f.requests.length,original.calls);
    } finally {if(rebuilt)await rebuilt.app.close();await fs.rm(filename,{force:true});}
  });
});

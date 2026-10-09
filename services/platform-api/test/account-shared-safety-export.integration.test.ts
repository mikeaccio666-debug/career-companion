import {readQuestionJournal,occurrenceFromCapture,questionOperationCore,questionOperationCapture,questionScopeCapture} from '../src/safety-question-delivery-protocol.ts';
import {openDelivery,sealDelivery,deliveryDigest} from '../src/safety-delivery-review.ts';
import {withStudentOnboardingFixture} from './fixtures/companion-student-onboarding.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import type {PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {prebirthDetector} from './fixtures/companion-prebirth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {SHARED_SAFETY_EXPORT_TABLES as tables} from '../src/account-shared-safety-export.ts';
import {SafetyQuestionDelivery} from '../src/safety-question-delivery.ts';
import {OnboardingSafetyDelivery} from '../src/onboarding-safety-delivery.ts';
import {OnboardingSafetyRunner} from '../src/onboarding-safety-runner.ts';
import {OnboardingSafetyResponses} from '../src/onboarding-safety-responses.ts';
import {OnboardingSafetyFollowup} from '../src/onboarding-safety-followup.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {fixture,ready,submit,classify,proof,capture,instrument,unused,password,encoded} from './fixtures/account-name-source-export.ts';
const failure={code:'ACCOUNT_SHARED_SAFETY_EXPORT_UNAVAILABLE'};
const reads=(sql:string,table:string)=>sql.startsWith('SELECT * FROM '+table+' WHERE ');
async function snapshot(f:PrebirthFixture,who:{userId:string}){const result:Record<string,unknown>={};for(const table of tables)result[table]=(await f.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`,[who.userId])).rows;return result;}
async function actor(f:PrebirthFixture){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const intakeService=(f:PrebirthFixture)=>new OnboardingSafetyDelivery(f.db,f.config,FICTIONAL_LEGAL,f.bundle,f.review);
const questions=(f:PrebirthFixture)=>new SafetyQuestionDelivery(f.db,f.crypto,f.resources,{reservationMs:60000,displayMs:60000},intakeService(f));
async function named(f:PrebirthFixture,runtime:PlatformProviderRuntime){
 const p=await ready(f,runtime),source=await submit(p,'Fictional prebirth high marker');await classify(f,p,runtime,source.submissionId);
 const pub=await f.resources.publish(p.who,{operationId:randomUUID(),submissionId:source.submissionId,expectedEdition:0});assert(pub);
 return {who:p.who,publicationId:pub.publicationId,sourceKind:'companion_name' as const};
}
async function intake(f:PrebirthFixture,runtime:PlatformProviderRuntime,legacy=false){
 const who=await actor(f);let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;assert(draft.currentQuestion);
 await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional prebirth high marker'}});
 if(legacy){
  draft=(await f.store.read(who))!;assert(draft.currentQuestion);
  await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional prebirth high marker; distinct second signal'}});
 }
 await new OnboardingSafetyRunner(f.store,f.config,runtime,prebirthDetector).runNext(who);
 let source=(await f.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision',[who.userId])).rows[0];
 if(legacy){
  await new OnboardingSafetyResponses(f.db,f.config,FICTIONAL_LEGAL,f.bundle).prepareSubmission(source.id);await new OnboardingSafetyFollowup(f.db,f.config,FICTIONAL_LEGAL).read(who);
  await new OnboardingSafetyRunner(f.store,f.config,runtime,prebirthDetector).runNext(who);
  source=(await f.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision DESC LIMIT 1',[who.userId])).rows[0];
 }
 const pub=await intakeService(f).publish(who,{operationId:randomUUID(),submissionId:source.id,expectedEdition:0});assert(pub);
 return {who,publicationId:pub.publicationId,sourceKind:'onboarding' as const};
}
async function reserve(f:PrebirthFixture,p:Awaited<ReturnType<typeof named>>|Awaited<ReturnType<typeof intake>>,revision=0){
 const service=questions(f),renderOwnerId=randomUUID(),reservation=await service.reserve(p.who,{operationId:randomUUID(),publicationId:p.publicationId,sourceKind:p.sourceKind,expectedQuestionScopeRevision:revision,renderOwnerId});assert(reservation.reservationToken);
 return {service,renderOwnerId,reservation};
}
async function claim(p:{who:Awaited<ReturnType<typeof actor>>},r:Awaited<ReturnType<typeof reserve>>){
 const {service,renderOwnerId,reservation}=r;
 const result=await service.claim(p.who,{operationId:randomUUID(),occurrenceId:reservation.occurrenceId,reservationId:reservation.reservationId,reservationToken:reservation.reservationToken!,generation:reservation.generation,renderOwnerId});
 assert('grantPresentationToken' in result);assert.equal(result.status,'display_granted');return result;
}
async function present(p:{who:Awaited<ReturnType<typeof actor>>},r:Awaited<ReturnType<typeof reserve>>,c:Awaited<ReturnType<typeof claim>>){
 return r.service.present(p.who,{operationId:randomUUID(),occurrenceId:c.occurrenceId,grantId:c.grantId,grantPresentationToken:c.grantPresentationToken!,renderOwnerId:r.renderOwnerId});
}

test('both original source kinds export prepared events and real reserve/claim/receipt history without credentials or writes',async()=>fixture(async(f,runtime,calls)=>{
 const owners=[await named(f,runtime),await intake(f,runtime)];
 for(const p of owners){
  const r=await reserve(f,p),c=await claim(p,r);await present(p,r,c);
  const before=await snapshot(f,p.who),n=calls.length,sqls:string[]=[],token=await proof(f,p.who);
  const data=await new AccountCoreExport(instrument(f,sql=>{sqls.push(sql);}),f.config).capture(p.who,token),s=data.sections;
  assert.equal(s.safetyResponseEvents.length,1);assert.equal((s.safetyResponseEvents[0] as any).sourceKind,p.sourceKind);
  assert.equal(s.safetyQuestionScopes.length,1);assert.equal(s.safetyQuestionOccurrences.length,1);assert.equal(s.safetyQuestionOperations.length,3);
  const occurrence=s.safetyQuestionOccurrences[0] as any;assert.equal(occurrence.phase,'declared');assert(occurrence.receiptReceivedAt);
  assert.equal((s.safetyQuestionOperations[1] as any).question,c.question);assert(Object.isFrozen(occurrence));
  assert.equal(data.includedTables.length,142);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
  const json=JSON.stringify(data),other=owners.find(x=>x.who.userId!==p.who.userId)!;
  for(const secret of [r.reservation.reservationToken!,c.grantPresentationToken!,p.who.tokenHash,r.renderOwnerId,other.who.userId,token,password,encoded,
   'session_hash','sessionHash','reservation_digest','grant_digest','render_owner_id','payload_ciphertext','secret',f.review.reviewerUserId])assert(!json.includes(secret),secret);
  assert.equal(calls.length,n);assert.deepEqual(await snapshot(f,p.who),before);assert(!sqls.filter(x=>/FROM platform_(safety_question|safety_legacy|onboarding)/.test(x)).some(x=>/FOR (UPDATE|SHARE|NO KEY UPDATE)/.test(x)));
 }
}));

test('empty, prepared, reserved and claimed phases never invent a display receipt or initialize history by export',async()=>fixture(async(f,runtime)=>{
 const empty=await capture(f,await actor(f));for(const k of ['safetyResponseEvents','safetyQuestionScopes','safetyQuestionOccurrences','safetyQuestionOperations','safetyLegacyExposures'] as const)assert.deepEqual(empty.sections[k],[]);
 const p=await named(f,runtime);let data=await capture(f,p.who);assert.equal(data.sections.safetyResponseEvents.length,1);assert.deepEqual(data.sections.safetyQuestionScopes,[]);
 const r=await reserve(f,p);data=await capture(f,p.who);let o=data.sections.safetyQuestionOccurrences[0] as any;assert.equal(o.phase,'reserved');assert.equal(o.claimedAt,null);assert.equal(o.receiptReceivedAt,null);assert.equal((data.sections.safetyQuestionOperations[0] as any).question,null);
 await claim(p,r);data=await capture(f,p.who);o=data.sections.safetyQuestionOccurrences[0] as any;assert.equal(o.phase,'claimed');assert(o.claimedAt);assert.equal(o.receiptReceivedAt,null);
}));

test('old transported intake capsules stay possible exposures and do not become actual asked occurrences',async()=>fixture(async(f,runtime)=>{
 const p=await intake(f,runtime,true);await reserve(f,p);
 const data=await capture(f,p.who);assert.equal(data.sections.safetyLegacyExposures.length,1);assert.equal((data.sections.safetyLegacyExposures[0] as any).kind,'legacy_possible_exposure');
 assert.equal((data.sections.safetyQuestionOccurrences[0] as any).phase,'reserved');assert.equal((data.sections.safetyQuestionOccurrences[0] as any).receiptReceivedAt,null);
}));

test('current consent, email and resource policies never rewrite original question delivery',async()=>fixture(async(f,runtime,calls)=>{
 const p=await named(f,runtime),r=await reserve(f,p),c=await claim(p,r);await present(p,r,c);const before=await capture(f,p.who),n=calls.length;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);await f.db.query('DELETE FROM platform_safety_delivery_policy');await f.db.query('DELETE FROM platform_safety_response_policy');
 const after=await capture(f,p.who);for(const key of ['safetyResponseEvents','safetyQuestionScopes','safetyQuestionOccurrences','safetyQuestionOperations','safetyLegacyExposures'] as const)assert.deepEqual(after.sections[key],before.sections[key]);assert.equal(calls.length,n);
}));

test('sealed scopes, operations and legacy exposures reject corruption and cross-owner replacement',async()=>fixture(async(f,runtime)=>{
 const p=await intake(f,runtime,true),other=await intake(f,runtime,true);await reserve(f,p);await reserve(f,other);const token=await proof(f,p.who);
 for(const table of ['platform_safety_question_scopes','platform_safety_question_operations','platform_safety_legacy_exposures']){
  const foreign=(await f.db.query(`SELECT payload_ciphertext FROM ${table} WHERE user_id=$1`,[other.who.userId])).rows[0].payload_ciphertext;
  for(const swap of [false,true]){let reached=false;const db=instrument(f,(sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;const bytes=Buffer.from(rows[0].payload_ciphertext);bytes[bytes.length-1]^=1;rows[0].payload_ciphertext=swap?foreign:bytes;}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
  }
 }
}));

test('missing entire roots, latest occurrences, operation suffixes or mixed-source events cannot silently shrink the archive',async()=>fixture(async(f,runtime)=>{
 const p=await intake(f,runtime,true);await reserve(f,p);const token=await proof(f,p.who);
 for(const table of tables){let reached=false;const db=instrument(f,(sql,rows)=>{if(reads(sql,table)&&sql.includes('LIMIT 100')){reached=true;rows.splice(0);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
 }
}));

test('authentic old scope, altered occurrence coordinates, original question and source bindings are rejected',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime),r=await reserve(f,p),old=(await f.db.query('SELECT * FROM platform_safety_question_scopes WHERE user_id=$1',[p.who.userId])).rows[0];const c=await claim(p,r);await present(p,r,c);const token=await proof(f,p.who);
 for(const fault of ['old','occurrence','suffix','anchor','event']){
  let reached=false;const db=instrument(f,(sql,rows)=>{
   if(fault==='old'&&reads(sql,'platform_safety_question_scopes')){reached=true;rows[0]={...old};}
   if(fault==='occurrence'&&reads(sql,'platform_safety_question_occurrences')&&rows.length){reached=true;rows[0].publication_id=randomUUID();}
   if(fault==='suffix'&&reads(sql,'platform_safety_question_operations')&&rows.length){reached=true;rows.pop();}
   if(fault==='anchor'&&sql.startsWith('SELECT name_question_scope_draft_id')){reached=true;rows[0].name_question_scope_draft_id=null;}
   if(fault==='event'&&reads(sql,'platform_safety_events')&&sql.includes('LIMIT 100')&&rows.length){reached=true;rows[0].name_source_generation++;}
  });await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
 }
}));

test('cancel, late authentication reset and size limits return no partial history and roll back proof consumption',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime);await reserve(f,p);
 for(const fault of ['cancel','auth','size']){
  const token=await proof(f,p.who),controller=new AbortController();let reached=false;
  const db=instrument(f,async(sql,rows,client)=>{if(reads(sql,'platform_safety_question_operations')&&rows.length&&!reached){reached=true;if(fault==='cancel')controller.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='size'?{maxBytes:1024}:{}).capture(p.who,token,controller.signal),{code:fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':fault==='auth'?'AUTH_REQUIRED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='size')assert(reached);await unused(f,p.who);
 }
 assert.equal((await capture(f,p.who)).sections.safetyQuestionOccurrences.length,1);
}));

test('105 real original events, distinct occurrences and scope operations cross pages with complete source binding',async()=>fixture(async(f,runtime,calls)=>{
 const who=await actor(f);let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;
 for(let i=0;i<105;i++){assert(draft.currentQuestion);draft=(await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional prebirth high marker; source '+i}})).draft;}
 const service=intakeService(f),runner=new OnboardingSafetyRunner(f.store,f.config,runtime,prebirthDetector);
 const sources=(await f.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision',[who.userId])).rows;
 let revision=0;
 for(const source of sources){
  await runner.runNext(who);const pub=await service.publish(who,{submissionId:source.id,operationId:randomUUID(),expectedEdition:0});assert(pub);
  const r=await reserve(f,{who,publicationId:pub.publicationId,sourceKind:'onboarding'},revision);revision=r.reservation.scopeRevision;
 }
 const n=calls.length,queries:string[]=[],data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(who,await proof(f,who));
 assert.equal(data.sections.safetyResponseEvents.length,105);assert.equal(data.sections.safetyQuestionOccurrences.length,105);assert.equal(data.sections.safetyQuestionOperations.length,105);
 assert.equal((data.sections.safetyQuestionScopes[0] as any).revision,105);
 for(const table of ['platform_safety_events','platform_safety_question_occurrences','platform_safety_question_operations'])assert.equal(queries.filter(sql=>reads(sql,table)&&sql.includes('LIMIT 100')).length,2);
 assert.equal(calls.length,n);
}));

test('one actual student shares a scope across native intake and naming while each event retains its original source',async()=>{
 await withStudentOnboardingFixture(async f=>{
  await f.prebirth.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[f.who.userId,encoded]);
  const accepted=await f.accept(f.command('Fictional prebirth high marker'));await f.execute(accepted);
  const publication=await f.system.safetyResources.resources.publish(f.who,{sourceRef:{kind:'companion_name',submissionId:accepted.acceptance.submissionId},operationId:randomUUID(),expectedEdition:0});assert(publication);
  const service=f.system.safetyResources.questionDelivery,target={sourceKind:'companion_name' as const,publicationId:publication.publicationId},state=await service.read(f.who,target),renderOwnerId=randomUUID();
  const r=await service.reserve(f.who,{...target,operationId:randomUUID(),expectedQuestionScopeRevision:state.scopeRevision,renderOwnerId});assert(r.reservationToken);
  const c=await service.claim(f.who,{operationId:randomUUID(),occurrenceId:r.occurrenceId,reservationId:r.reservationId,reservationToken:r.reservationToken,generation:r.generation,renderOwnerId});assert('grantPresentationToken' in c);
  await service.present(f.who,{operationId:randomUUID(),occurrenceId:c.occurrenceId,grantId:c.grantId,grantPresentationToken:c.grantPresentationToken,renderOwnerId});
  const who={userId:f.who.userId,tokenHash:f.who.tokenHash},n=f.requests.length,data=await new AccountCoreExport(f.prebirth.db,f.config).capture(who,await proof(f.prebirth,who));
  assert.equal(data.sections.safetyQuestionScopes.length,1);assert.deepEqual(data.sections.safetyQuestionOccurrences.map((r:any)=>r.sourceKind).sort(),['companion_name','onboarding']);
  assert.deepEqual(data.sections.safetyResponseEvents.map((r:any)=>r.sourceKind).sort(),['companion_name','onboarding']);
  assert.equal(data.sections.safetyQuestionOperations.length,6);assert.equal(f.requests.length,n);
 },{riskIntake:true});
});

test('a self-consistent re-sealed question journal still must match the actual reviewed publication',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime),r=await reserve(f,p);await claim(p,r);
 const scope=(await f.db.query('SELECT * FROM platform_safety_question_scopes WHERE user_id=$1',[p.who.userId])).rows[0];
 const original=openDelivery(f.crypto,'platform_safety_question_scopes',scope.draft_id,p.who.userId,scope.revision,scope.payload_ciphertext) as any;
 const ops=(await f.db.query('SELECT * FROM platform_safety_question_operations WHERE user_id=$1 ORDER BY applied_revision',[p.who.userId])).rows;
 let digest=ops[0].previous_digest;
 for(const op of ops){
  const raw=openDelivery(f.crypto,'platform_safety_question_operations',op.operation_id,p.who.userId,op.applied_revision,op.payload_ciphertext) as any;
  const after=occurrenceFromCapture(raw.after);after.question_digest=deliveryDigest('Fictional tampered question');
  op.previous_digest=digest;const question=op.kind==='claim'?'Fictional tampered question':null;
  digest=deliveryDigest(JSON.stringify(questionOperationCore(op,raw.request,after,raw.secret,question)));op.journal_digest=digest;
  op.payload_ciphertext=sealDelivery(f.crypto,'platform_safety_question_operations',op.operation_id,p.who.userId,op.applied_revision,questionOperationCapture(op,raw.request,after,raw.secret,question));
 }
 scope.journal_digest=digest;scope.payload_ciphertext=sealDelivery(f.crypto,'platform_safety_question_scopes',scope.draft_id,p.who.userId,scope.revision,questionScopeCapture(scope,original.legacyDigest));
 // Real FK rejects this corruption on write; additionally test the archive
 // validator against independently damaged read results without removing FKs.
 const db=instrument(f,(sql,rows)=>{
  if(reads(sql,'platform_safety_question_scopes'))rows.splice(0,rows.length,{...scope});
  if(reads(sql,'platform_safety_question_operations'))rows.splice(0,rows.length,...ops.map(op=>({...op})));
  if(reads(sql,'platform_safety_question_occurrences'))for(const row of rows)row.question_digest=deliveryDigest('Fictional tampered question');
 });
 assert.equal((await db.withBoundedTransaction(client=>readQuestionJournal(client,f.crypto,scope))).rows.length,2);
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,await proof(f,p.who)),failure);await unused(f,p.who);
}));

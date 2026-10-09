import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import {Database} from '../src/database.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {INTAKE_DELIVERY_EXPORT_TABLES as tables} from '../src/account-intake-delivery-export.ts';
import {OnboardingSafetyRunner} from '../src/onboarding-safety-runner.ts';
import {OnboardingSafetyDelivery} from '../src/onboarding-safety-delivery.ts';
import {OnboardingSafetyResponses} from '../src/onboarding-safety-responses.ts';
import {OnboardingSafetyFollowup} from '../src/onboarding-safety-followup.ts';
import {createPrebirthFixture,prebirthDetector,withPrebirthLoopback,type PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
const password='Fictional-intake-delivery-export-password',passwordHash=await hashPassword(password);
const fail={code:'ACCOUNT_INTAKE_DELIVERY_EXPORT_UNAVAILABLE'};
async function withFixture(run:(f:PrebirthFixture,runtime:PlatformProviderRuntime,calls:Record<string,unknown>[])=>Promise<void>){await withPrebirthLoopback(async(runtime,calls)=>{const f=await createPrebirthFixture();try{await run(f,runtime,calls);}finally{await f.close();}});}
async function actor(f:PrebirthFixture){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,passwordHash]);return who;}
const proof=async(f:PrebirthFixture,who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(f:PrebirthFixture,who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(f,who));
async function unconsumed(f:PrebirthFixture,who:FixedSessionContext){const row=(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND session_hash=$2 AND purpose='account_export'",[who.userId,who.tokenHash])).rows[0];assert(row);assert.equal(row.consumed_at,null);}
async function prepared(f:PrebirthFixture,runtime:PlatformProviderRuntime,legacy=false,level:'L1'|'L2'='L2'){
 const who=await actor(f);let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;assert(draft.currentQuestion);
 const text={expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text' as const,questionId:draft.currentQuestion,text:level==='L2'?'Fictional prebirth high marker; synthetic export fixture.':'Fictional prebirth low marker; synthetic export fixture.'}};
 await f.store.save(who,text);await new OnboardingSafetyRunner(f.store,f.config,runtime,prebirthDetector).runNext(who);
 const source=(await f.db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1',[who.userId])).rows[0];assert.equal(source.level,level);
 if(legacy){await new OnboardingSafetyResponses(f.db,f.config,FICTIONAL_LEGAL,f.bundle).prepareSubmission(source.id);await new OnboardingSafetyFollowup(f.db,f.config,FICTIONAL_LEGAL).read(who);}
 const service=new OnboardingSafetyDelivery(f.db,f.config,FICTIONAL_LEGAL,f.bundle,f.review),publication=await service.publish(who,{operationId:randomUUID(),submissionId:source.id,expectedEdition:0});assert(publication);
 return {who,source,text,service,publication};
}
async function finish(p:Awaited<ReturnType<typeof prepared>>,clarify=false){
 const projection=await p.service.issueBodyProjection(p.who,{publicationId:p.publication.publicationId});
 const presented=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:projection.revision,action:{kind:'present_body',bodyProjectionId:projection.bodyProjectionId}});assert(presented.presentationReceipt);
 const ack=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:presented.state.revision,action:{kind:'acknowledge',presentationReceipt:presented.presentationReceipt}});
 const handled=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:ack.state.revision,action:clarify?{kind:'clarify_exaggeration',presentationReceipt:presented.presentationReceipt,safe:true,exaggeration:true}:{kind:'continue_intake',presentationReceipt:presented.presentationReceipt}});
 return {projection,presented,ack,handled};
}
function instrument(db:Database,transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const reads=(sql:string,table:string)=>sql.startsWith('SELECT * FROM '+table+' WHERE ');
function damage(cipher:Buffer){const bytes=Buffer.from(cipher);bytes[bytes.length-1]^=1;return bytes;}
async function snapshot(f:PrebirthFixture,who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of tables)result[table]=(await f.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`,[who.userId])).rows;return result;}

test('original V2 resources, actual body/acknowledgment/handling and cutover retain distinct owner-private records',async()=>withFixture(async(f,runtime,calls)=>{
 const p=await prepared(f,runtime,true),other=await prepared(f,runtime),cycle=await finish(p,true);await finish(other);
 const before=await snapshot(f,p.who),beforeCalls=calls.length,queries:string[]=[],token=await proof(f,p.who),data=await new AccountCoreExport(instrument(f.db,sql=>{queries.push(sql);}),f.config).capture(p.who,token);
 const s=data.sections;assert.equal(s.intakeResourcePublications.length,1);assert.equal(s.intakeFollowups.length,3);assert.equal(s.intakeBodyProjections.length,1);assert.equal(s.intakeHandledSources.length,1);assert.equal(s.intakeResourceCutovers.length,1);
 assert.equal((s.intakeResourceCutovers[0] as any).legacy.length,1);assert.equal((s.intakeFollowupStates[0] as any).revision,3);assert.equal((s.intakeHandledSources[0] as any).kind,'clarify_exaggeration');
 assert.equal((s.intakeResourcePublications[0] as any).level,'L2');assert.equal((s.intakeBodyProjections[0] as any).body.question,undefined);assert.equal((s.intakeHandledSources[0] as any).operationId,cycle.handled.operation.id);
 assert.equal(s.memories.length,0);assert.equal(data.includedTables.length,117);assert.equal(data.remainingTables.length,47);assert.equal(data.complete,false);assert(data.remainingTables.includes('platform_safety_question_occurrences'));
 const json=JSON.stringify(data);for(const secret of [other.who.userId,other.source.id,p.who.tokenHash,cycle.presented.presentationReceipt!,token,password,passwordHash,'sessionHash','session_hash','presentationDigest','presentation_digest','payload_ciphertext','authVersion','activation_user_id',f.review.reviewerUserId,f.review.orgId,f.review.reviewEvidenceRef,'reviewRef'])assert(!json.includes(secret),secret);
 assert(Object.isFrozen((s.intakeResourcePublications[0] as any).response));assert.equal(calls.length,beforeCalls);assert.deepEqual(await snapshot(f,p.who),before);
 assert(!queries.some(sql=>/FROM platform_(onboarding|safety_delivery)/.test(sql)&&/FOR (UPDATE|SHARE|NO KEY UPDATE)/.test(sql)));
}));

test('empty account, published body and issued projection never manufacture a presentation or handling record',async()=>withFixture(async(f,runtime)=>{
 const empty=await capture(f,await actor(f));assert.deepEqual(empty.sections.intakeResourcePublications,[]);assert.deepEqual(empty.sections.intakeResourceCutovers,[]);
 const p=await prepared(f,runtime),before=await snapshot(f,p.who),first=await capture(f,p.who);assert.deepEqual(first.sections.intakeFollowups,[]);assert.deepEqual(first.sections.intakeBodyProjections,[]);assert.deepEqual(first.sections.intakeHandledSources,[]);assert.equal((first.sections.intakeFollowupStates[0] as any).revision,0);assert.deepEqual(await snapshot(f,p.who),before);
 await p.service.issueBodyProjection(p.who,{publicationId:p.publication.publicationId});const next=await capture(f,p.who);assert.equal(next.sections.intakeBodyProjections.length,1);assert.deepEqual(next.sections.intakeFollowups,[]);assert.deepEqual(next.sections.intakeHandledSources,[]);
 const recovery=await p.service.recover(p.who,{submissionId:p.source.id,operationId:randomUUID(),expectedEdition:1});assert.equal(recovery?.publicationId,p.publication.publicationId);
 const retried=await capture(f,p.who);assert.equal(retried.sections.intakeResourcePublications.length,1);assert.equal(retried.sections.intakeDeliveryOperations.length,2);assert(retried.sections.intakeDeliveryOperations.some((x:any)=>x.kind==='recover'));
 const low=await prepared(f,runtime,false,'L1');await finish(low);const lowArchive=await capture(f,low.who);assert.equal((lowArchive.sections.intakeResourcePublications[0] as any).questionDigest,null);assert.equal((lowArchive.sections.intakeResourcePublications[0] as any).response.question,undefined);assert.equal(lowArchive.sections.intakeHandledSources.length,1);
}));

test('withdrawn consent, email verification and active resource policy leave original private history available',async()=>withFixture(async(f,runtime,calls)=>{
 const p=await prepared(f,runtime);await finish(p);const before=await capture(f,p.who),n=calls.length;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL,name=$2 WHERE id=$1',[p.who.userId,'Changed fictional export name']);await f.db.query('DELETE FROM platform_safety_delivery_policy');
 const after=await capture(f,p.who);for(const section of ['intakeResourcePublications','intakeBodyProjections','intakeFollowups','intakeFollowupStates','intakeHandledSources','intakeDeliveryHeads','intakeDeliveryOperations','intakeResourceCutovers'] as const)assert.deepEqual(after.sections[section],before.sections[section]);assert.equal(calls.length,n);
}));

test('105 actual publication retries, projections and support operations are completely paginated',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);let revision=0;
 for(let i=0;i<105;i++){
  await p.service.publish(p.who,{submissionId:p.source.id,operationId:randomUUID(),expectedEdition:0});await p.service.issueBodyProjection(p.who,{publicationId:p.publication.publicationId});
  const result=await p.service.act(p.who,{publicationId:p.publication.publicationId,operationId:randomUUID(),expectedPublicationRevision:revision,action:{kind:'need_support'}});revision=result.state.revision;
 }
 const queries:string[]=[],data=await new AccountCoreExport(instrument(f.db,sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(f,p.who));
 assert.equal(data.sections.intakeDeliveryOperations.length,106);assert.equal(data.sections.intakeBodyProjections.length,105);assert.equal(data.sections.intakeFollowups.length,105);assert.equal((data.sections.intakeFollowupStates[0] as any).revision,105);assert.deepEqual(data.sections.intakeHandledSources,[]);
 for(const table of ['platform_onboarding_delivery_v2_operations','platform_onboarding_safety_v2_body_projections','platform_onboarding_safety_v2_followups'])assert.equal(queries.filter(sql=>reads(sql,table)&&sql.includes('LIMIT 100')).length,2);
}));

test('every encrypted V2 table rejects damaged or foreign ciphertext and keeps the reauthentication proof',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime),other=await prepared(f,runtime);await finish(p);await finish(other);const token=await proof(f,p.who);
 for(const table of tables.filter(t=>t!=='platform_onboarding_safety_v2_handled')){
  const foreign=(await f.db.query(`SELECT payload_ciphertext FROM ${table} WHERE user_id=$1`,[other.who.userId])).rows[0];assert(foreign);
  for(const swap of [false,true]){let reached=false;const db=instrument(f.db,(sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;rows[0].payload_ciphertext=swap?foreign.payload_ciphertext:damage(rows[0].payload_ciphertext);}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),fail);assert(reached);await unconsumed(f,p.who);
  }
 }assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.intakeHandledSources.length,1);
}));

test('missing head, publication, operation, state, projection, followup, handled source or cutover cannot silently shrink history',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);const token=await proof(f,p.who);
 for(const table of tables){let reached=false;const db=instrument(f.db,(sql,rows)=>{if(reads(sql,table)){reached=true;rows.splice(0);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),fail);assert(reached);await unconsumed(f,p.who);
 }
}));

test('an authentic earlier sealed state and a truncated journal suffix cannot be treated as the latest history',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime),old=(await f.db.query('SELECT * FROM platform_onboarding_safety_v2_followup_states WHERE publication_id=$1',[p.publication.publicationId])).rows[0];await finish(p);const token=await proof(f,p.who);
 for(const fault of ['old_state','suffix','anchor']){let reached=false;const db=instrument(f.db,(sql,rows)=>{
  if(fault==='old_state'&&reads(sql,'platform_onboarding_safety_v2_followup_states')){reached=true;rows[0]={...old};}
  if(fault==='suffix'&&reads(sql,'platform_onboarding_safety_v2_followups')&&sql.includes('LIMIT 100')){reached=true;rows.pop();}
  if(fault==='anchor'&&sql.startsWith('SELECT first_safety_v2_publication_id')){reached=true;rows[0].first_safety_v2_publication_id=randomUUID();}
 });await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),fail);assert(reached);await unconsumed(f,p.who);}
}));

test('missing historical asset or activation and altered handled metadata fail without consulting active policy',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);const token=await proof(f,p.who);
 for(const fault of ['asset','activation','handled']){let reached=false;const table=fault==='asset'?'platform_safety_delivery_assets':fault==='activation'?'platform_safety_delivery_review_operations':'platform_onboarding_safety_v2_handled';
  const db=instrument(f.db,(sql,rows)=>{if(reads(sql,table)){reached=true;if(fault==='handled')rows[0].source_generation++;else rows.splice(0);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),fail);assert(reached);await unconsumed(f,p.who);
 }
}));

test('cancellation, late session revocation and byte limits release no partial archive and retain retry proof',async()=>withFixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);
 for(const fault of ['cancel','auth','capacity']){const token=await proof(f,p.who),controller=new AbortController();let reached=false;
  const db=instrument(f.db,async(sql,rows,client)=>{if(reads(sql,'platform_onboarding_resource_cutovers')&&rows.length&&!reached){reached=true;if(fault==='cancel')controller.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='capacity'?{maxBytes:1024}:{}).capture(p.who,token,controller.signal),{code:fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':fault==='auth'?'AUTH_REQUIRED':'ACCOUNT_EXPORT_TOO_LARGE'});if(fault!=='capacity')assert(reached);await unconsumed(f,p.who);
 }
 assert.equal((await capture(f,p.who)).sections.intakeHandledSources.length,1);
}));

test('105 independent original sources retain every publication/head across pages and beyond the source cache',async()=>withFixture(async(f,runtime,calls)=>{
 const who=await actor(f);let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;
 for(let i=0;i<105;i++){assert(draft.currentQuestion);draft=(await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional prebirth high marker; synthetic source '+i}})).draft;}
 const service=new OnboardingSafetyDelivery(f.db,f.config,FICTIONAL_LEGAL,f.bundle,f.review),runner=new OnboardingSafetyRunner(f.store,f.config,runtime,prebirthDetector);
 const sources=(await f.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision',[who.userId])).rows;
 for(const source of sources){await runner.runNext(who);const result=await service.publish(who,{submissionId:source.id,operationId:randomUUID(),expectedEdition:0});assert(result);}
 const queries:string[]=[],beforeCalls=calls.length,data=await new AccountCoreExport(instrument(f.db,sql=>{queries.push(sql);}),f.config).capture(who,await proof(f,who));
 assert.equal(data.sections.intakeResourcePublications.length,105);assert.equal(data.sections.intakeDeliveryHeads.length,105);assert.equal(data.sections.intakeFollowupStates.length,105);assert.deepEqual(data.sections.intakeHandledSources,[]);
 assert.deepEqual(data.sections.intakeResourcePublications.map((p:any)=>p.submissionId).sort(),sources.map(s=>s.id).sort());
 for(const table of ['platform_onboarding_safety_v2_publications','platform_onboarding_delivery_v2_heads'])assert.equal(queries.filter(sql=>reads(sql,table)&&sql.includes('LIMIT 100')).length,2);assert.equal(calls.length,beforeCalls);
}));

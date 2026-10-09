import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {OnboardingFollowupAction} from '@companion/platform-contracts';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {OnboardingSafetyResponses} from '../src/onboarding-safety-responses.ts';
import {OnboardingSafetyFollowup} from '../src/onboarding-safety-followup.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {withStudentOnboardingFixture} from './fixtures/companion-student-onboarding.ts';
import {fictionalBundle} from './fixtures/onboarding-followup.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-companion-source-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function prepare(){const who=await actor();let taskId='';await withPrebirthLoopback(async(runtime,requests)=>{taskId=(await f.ready(runtime,{who,generate:false})).prepared.taskId;assert.equal(requests.length,0);});return {who,taskId};}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const manifests=(sql:string)=>sql.startsWith('SELECT * FROM platform_companion_source_prefixes WHERE user_id=');
function noCredentials(value:any){if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){assert(!/hash|digest|authVersion|token|cipher/i.test(key),key);noCredentials(child);}}
async function saved(who:FixedSessionContext){const row=(await f.db.query('SELECT * FROM platform_companion_source_prefixes WHERE user_id=$1',[who.userId])).rows[0];
 return {row,payload:JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,{table:'platform_companion_source_prefixes',column:'payload_ciphertext',rowId:row.id,ownerId:who.userId,revision:row.source_revision}))};}

test('original version-one source manifest links every captured operation without leaking credential-derived digests',async()=>{
 const p=await prepare(),other=await prepare(),original=await saved(p.who),result=await capture(p.who),manifest=result.sections.companionSourceManifests[0] as any;
 assert.equal(result.sections.companionSourceManifests.length,1);assert.equal(manifest.schemaVersion,1);assert.equal(manifest.taskId,p.taskId);assert.equal(manifest.capturedAt,original.payload.capturedAt);
 assert.deepEqual(manifest.operations.map((op:any)=>op.operationId),original.payload.operations.map((op:any)=>op.operationId));assert(manifest.operations.length>1);
 assert(!('intakeResources' in manifest));assert.deepEqual(manifest.followups,[]);assert.deepEqual(manifest.handledSubmissionIds,[]);noCredentials(manifest);
 for(const secret of [p.who.tokenHash,other.who.userId,other.taskId,original.row.payload_digest,original.payload.canonicalAnswersDigest,original.payload.canonicalSeedDigest])assert(!JSON.stringify(manifest).includes(secret));
 assert(Object.isFrozen(manifest.operations[0]));assert.equal(result.includedTables.length,139);assert(!result.remainingTables.includes('platform_companion_source_prefixes'));assert(result.includedTables.includes('platform_onboarding_safety_v2_followups'));assert.equal(result.complete,false);
});

test('real legacy handling keeps publication, presentation and acknowledgment links but drops the nested original session',async()=>{
 const who=await actor(),operator=await f.actor(true),bundle=fictionalBundle();
 await f.db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
  VALUES(true,$1,$2,$3,clock_timestamp(),$4)`,[bundle.revision,bundle.contentDigest,bundle.reviewDigest,operator.userId]);
 let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;
 draft=(await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:'study',text:'Fictional original handled context.'}})).draft;
 const claim=await f.store.claimSafety(who,{detectorRevision:29});assert(claim);
 await f.store.processSafety(claim,async(_input,admission)=>admission(async()=>({level:'L1',mode:'keyword_only'})));
 await new OnboardingSafetyResponses(f.db,f.config,FICTIONAL_LEGAL,bundle).prepareSubmission(claim.submissionId);
 const followup=new OnboardingSafetyFollowup(f.db,f.config,FICTIONAL_LEGAL),view=await followup.read(who),publication=view.publications[0];assert(view.draft);assert(publication);
 const command=(action:OnboardingFollowupAction)=>({expectedDraftRevision:view.draft!.revision,publicationId:publication.publicationId,operationId:randomUUID(),action});
 const present=command({kind:'present'}),shown=await followup.act(who,present);assert(shown.presentationReceipt);
 const ack=command({kind:'acknowledge',presentationReceipt:shown.presentationReceipt});await followup.act(who,ack);
 const resume=command({kind:'continue_intake',presentationReceipt:shown.presentationReceipt});await followup.act(who,resume);
 await withPrebirthLoopback(async(runtime,requests)=>{await f.ready(runtime,{who,generate:false});assert.equal(requests.length,0);});
 const original=await saved(who),result=await capture(who),manifest=result.sections.companionSourceManifests[0] as any;
 assert.equal(manifest.schemaVersion,1);assert.equal(manifest.submissions[0].originalLevel,'L1');assert.equal(manifest.responses.length,1);assert.equal(manifest.events.length,1);assert.equal(manifest.publications[0].publicationId,publication.publicationId);
 const handled=manifest.followups.find((op:any)=>op.operationId===resume.operationId);assert.equal(handled.presentationOperationId,present.operationId);assert.equal(handled.acknowledgmentOperationId,ack.operationId);assert.equal(handled.handled,true);
 assert.deepEqual(manifest.handledSubmissionIds,[claim.submissionId]);assert(original.payload.followups.some((op:any)=>op.sessionHash===who.tokenHash));assert(!JSON.stringify(manifest).includes(who.tokenHash));noCredentials(manifest);
});

test('genuine version-two resource handling exports original source links without copying private projection or execution proofs',async()=>{
 await withStudentOnboardingFixture(async f=>{
  assert(f.risk);const who={userId:f.who.userId,tokenHash:f.who.tokenHash},calls=f.requests.length,before=await f.evidence();
  const token=(await new AccountReauthentication(f.prebirth.db).verify(who,{purpose:'account_export',password:f.who.password})).token;
  const result=await new AccountCoreExport(f.prebirth.db,f.config).capture(who,token),manifest=result.sections.companionSourceManifests[0] as any;
  assert.equal(manifest.schemaVersion,2);assert.equal(manifest.submissions[0].originalLevel,'L2');assert.equal(manifest.submissions[0].originalDetectorMode,'keyword_only');
  assert.deepEqual(manifest.followups,[]);assert.deepEqual(manifest.publications,[]);assert.deepEqual(manifest.handledSubmissionIds,[f.risk.submissionId]);
  assert.equal(manifest.intakeResources.length,1);const resource=manifest.intakeResources[0];
  assert.equal(resource.publicationId,f.risk.publicationId);assert.equal(resource.handledOperationId,f.risk.continuationOperationId);assert(resource.projectionIds.includes(f.risk.bodyProjectionId));
  assert(resource.operationIds.includes(f.risk.presentationOperationId));assert(resource.operationIds.includes(f.risk.acknowledgmentOperationId));noCredentials(manifest);
  assert(!JSON.stringify(manifest).includes(f.who.tokenHash));assert(Object.isFrozen(resource.operationIds));assert.deepEqual(await f.evidence(),before);assert.equal(f.requests.length,calls);
 },{riskIntake:true});
});

test('withdrawn model consent and unverified email do not invoke source reconstruction or change the retained manifest',async()=>{
 const p=await prepare(),original=await saved(p.who),before=(await capture(p.who)).sections.companionSourceManifests;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(p.who));
 assert.deepEqual(result.sections.companionSourceManifests,before);assert.equal(queries.filter(manifests).length,1);
 assert(!queries.some(sql=>sql.includes('SELECT m.* FROM platform_companion_source_prefixes')));assert(!queries.filter(sql=>sql.includes('platform_companion_source_prefixes')).some(sql=>/FOR (UPDATE|SHARE)/.test(sql)));
 assert.deepEqual((await saved(p.who)).row,original.row);
});

test('missing manifests, foreign ciphertext and altered source coordinates fail atomically without consuming the proof',async()=>{
 const p=await prepare(),other=await prepare(),foreign=await saved(other.who),token=await proof(p.who);
 const mutations:((rows:any[])=>void)[]=[rows=>rows.splice(0),rows=>{rows[0].payload_ciphertext=foreign.row.payload_ciphertext;},rows=>{const b=Buffer.from(rows[0].payload_ciphertext);b[b.length-1]^=1;rows[0].payload_ciphertext=b;},
  rows=>{rows[0].payload_digest='0'.repeat(64);},rows=>{rows[0].answers_id=randomUUID();},rows=>{rows[0].auth_version='999';},rows=>{rows[0].captured_at=new Date(0);},rows=>{rows[0].schema_version=2;}];
 for(const mutate of mutations){let reached=false;const db=instrument((sql,rows)=>{if(manifests(sql)&&rows.length){reached=true;mutate(rows);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionSourceManifests.length,1);
});

test('authenticated unknown nested manifest fields and rewritten original seeds cannot escape the source binding',async()=>{
 const p=await prepare(),token=await proof(p.who),original=await saved(p.who),task=(await f.db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1',[p.taskId])).rows[0];
 const seedBinding={table:'platform_companion_generation_tasks',column:'seed_ciphertext',rowId:p.taskId,ownerId:p.who.userId,revision:task.source_revision};
 const seed=JSON.parse(f.crypto.openUtf8(task.seed_ciphertext,seedBinding));
 for(const kind of ['unknown','seed']){
  const payload=structuredClone(original.payload);if(kind==='unknown')payload.operations[0].newPrivateField='must not escape';
  const text=JSON.stringify(payload),digest=createHash('sha256').update(text).digest('hex');
  const changedSeed=kind==='unknown'?{...seed,sourceReceiptDigest:digest}:{...seed,model:'fictional-changed-seed'};
  const db=instrument((sql,rows)=>{
   if(sql.startsWith('SELECT * FROM platform_companion_generation_tasks WHERE user_id=')&&rows.length)rows[0].seed_ciphertext=f.crypto.sealUtf8(JSON.stringify(changedSeed),seedBinding);
   if(kind==='unknown'&&manifests(sql)&&rows.length){rows[0].payload_digest=digest;rows[0].payload_ciphertext=f.crypto.sealUtf8(text,{table:'platform_companion_source_prefixes',column:'payload_ciphertext',rowId:p.taskId,ownerId:p.who.userId,revision:task.source_revision});}
  });
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionSourceManifests.length,1);
});

test('cancellation at source capture returns no partial archive and permits retry with the same proof',async()=>{
 const p=await prepare(),token=await proof(p.who),controller=new AbortController(),db=instrument(sql=>{if(manifests(sql))controller.abort();});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionSourceManifests.length,1);
});

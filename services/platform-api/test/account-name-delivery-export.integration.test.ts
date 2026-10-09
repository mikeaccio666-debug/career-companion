import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import type {PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {NAME_DELIVERY_EXPORT_TABLES as tables} from '../src/account-name-delivery-export.ts';
import {fixture,ready,submit,classify,proof,capture,instrument,unused,password,encoded} from './fixtures/account-name-source-export.ts';
const failure={code:'ACCOUNT_NAME_DELIVERY_EXPORT_UNAVAILABLE'};
const reads=(sql:string,table:string)=>sql.startsWith('SELECT * FROM '+table+' WHERE ');
const damage=(cipher:Buffer)=>{const bytes=Buffer.from(cipher);bytes[bytes.length-1]^=1;return bytes;};
async function snapshot(f:PrebirthFixture,who:{userId:string}){const saved:Record<string,unknown>={};for(const table of tables)saved[table]=(await f.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`,[who.userId])).rows;return saved;}
async function prepared(f:PrebirthFixture,runtime:PlatformProviderRuntime,level:'L1'|'L2'='L2'){
 const p=await ready(f,runtime),source=await submit(p,level==='L2'?'Fictional prebirth high marker':'Fictional prebirth low marker');
 await classify(f,p,runtime,source.submissionId);
 const publication=await f.resources.publish(p.who,{operationId:randomUUID(),submissionId:source.submissionId,expectedEdition:0});assert(publication);
 return {...p,source,publication,service:f.resources};
}
async function finish(p:Awaited<ReturnType<typeof prepared>>,clarify=false){
 const projection=await p.service.issueBodyProjection(p.who,{publicationId:p.publication.publicationId});
 const presented=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:projection.revision,action:{kind:'present_body',bodyProjectionId:projection.bodyProjectionId}});assert(presented.presentationReceipt);
 const ack=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:presented.state.revision,action:{kind:'acknowledge',presentationReceipt:presented.presentationReceipt}});
 const handled=await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:ack.state.revision,action:clarify?{kind:'clarify_exaggeration',presentationReceipt:presented.presentationReceipt,safe:true,exaggeration:true}:{kind:'continue_naming',presentationReceipt:presented.presentationReceipt}});
 return {projection,presented,ack,handled};
}

test('original name response and actual publication, projection, acknowledgment and handling remain distinct private records',async()=>fixture(async(f,runtime,calls)=>{
 const p=await prepared(f,runtime),cycle=await finish(p,true),other=await prepared(f,runtime);await finish(other);
 const before=await snapshot(f,p.who),n=calls.length,queries:string[]=[],token=await proof(f,p.who),data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(p.who,token),s=data.sections;
 assert.equal(s.nameSafetyResponses.length,1);assert.equal(s.nameResourcePublications.length,1);assert.equal(s.nameBodyProjections.length,1);assert.equal(s.nameFollowups.length,3);assert.equal(s.nameHandledSources.length,1);
 assert.equal((s.nameFollowupStates[0] as any).revision,3);assert.equal((s.nameHandledSources[0] as any).kind,'clarify_exaggeration');assert.equal((s.nameBodyProjections[0] as any).body.question,undefined);
 assert.equal((s.nameSafetyResponses[0] as any).status,'ready');assert.equal((s.nameSafetyResponses[0] as any).localeOrigin,'captured_answers');
 assert.equal(s.memories.length,0);assert.equal(data.includedTables.length,139);assert.equal(data.remainingTables.length,25);assert.equal(data.complete,false);assert(data.includedTables.includes('platform_safety_question_occurrences'));
 const json=JSON.stringify(data);for(const secret of [other.who.userId,other.source.submissionId,p.who.tokenHash,cycle.presented.presentationReceipt!,token,password,encoded,'sessionHash','session_hash','presentationDigest','presentation_digest','payload_ciphertext','authVersion',f.review.reviewerUserId,f.review.orgId,f.review.reviewEvidenceRef,'reviewRef'])assert(!json.includes(secret),secret);
 assert(Object.isFrozen((s.nameResourcePublications[0] as any).response));assert.equal(calls.length,n);assert.deepEqual(await snapshot(f,p.who),before);
 assert(!queries.filter(sql=>/FROM platform_(companion_name|safety_events|safety_delivery)/.test(sql)).some(sql=>/FOR (UPDATE|SHARE|NO KEY UPDATE)/.test(sql)));
}));

test('empty, pending, prepared-only, published and projected name resources never imply actual presentation or handling',async()=>fixture(async(f,runtime)=>{
 const p=await ready(f,runtime);let data=await capture(f,p.who);assert.deepEqual(data.sections.nameSafetyResponses,[]);
 const source=await submit(p,'Fictional prebirth high marker');await classify(f,p,runtime,source.submissionId);
 data=await capture(f,p.who);assert.equal((data.sections.nameSafetyResponses[0] as any).status,'pending');assert.equal((data.sections.nameSafetyResponses[0] as any).response,null);
 await f.original.prepareSubmission(source.submissionId);data=await capture(f,p.who);assert.equal((data.sections.nameSafetyResponses[0] as any).status,'ready');assert.deepEqual(data.sections.nameResourcePublications,[]);
 const pub=await f.resources.publish(p.who,{operationId:randomUUID(),submissionId:source.submissionId,expectedEdition:0});assert(pub);
 await f.resources.issueBodyProjection(p.who,{publicationId:pub.publicationId});data=await capture(f,p.who);assert.equal(data.sections.nameBodyProjections.length,1);assert.deepEqual(data.sections.nameFollowups,[]);assert.deepEqual(data.sections.nameHandledSources,[]);
 const low=await prepared(f,runtime,'L1');await finish(low);const archived=await capture(f,low.who);assert.equal((archived.sections.nameResourcePublications[0] as any).questionDigest,null);assert.equal((archived.sections.nameSafetyResponses[0] as any).detectorMode,'full');
}));

test('current policy, consent, display name and email verification changes do not rewrite original name resources',async()=>fixture(async(f,runtime,calls)=>{
 const p=await prepared(f,runtime);await finish(p);const before=await capture(f,p.who),n=calls.length;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET name=$2,email_verified_at=NULL WHERE id=$1',[p.who.userId,'Changed fictional name']);await f.db.query('DELETE FROM platform_safety_delivery_policy');await f.db.query('DELETE FROM platform_safety_response_policy');
 const after=await capture(f,p.who);for(const key of ['nameSafetyResponses','nameResourcePublications','nameBodyProjections','nameFollowupStates','nameFollowups','nameHandledSources','nameDeliveryHeads','nameDeliveryOperations'] as const)assert.deepEqual(after.sections[key],before.sections[key]);assert.equal(calls.length,n);
}));

test('105 original publication retries, body projections and support operations cross pages without fabrication or truncation',async()=>fixture(async(f,runtime,calls)=>{
 const p=await prepared(f,runtime);let revision=0;
 for(let i=0;i<105;i++){
  await p.service.publish(p.who,{operationId:randomUUID(),submissionId:p.source.submissionId,expectedEdition:0});await p.service.issueBodyProjection(p.who,{publicationId:p.publication.publicationId});
  revision=(await p.service.act(p.who,{operationId:randomUUID(),publicationId:p.publication.publicationId,expectedPublicationRevision:revision,action:{kind:'need_support'}})).state.revision;
 }
 const recovery=await p.service.recover(p.who,{operationId:randomUUID(),submissionId:p.source.submissionId,expectedEdition:1});assert.equal(recovery?.publicationId,p.publication.publicationId);
 const queries:string[]=[],n=calls.length,data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(f,p.who));
 assert.equal(data.sections.nameDeliveryOperations.length,107);assert.equal(data.sections.nameBodyProjections.length,105);assert.equal(data.sections.nameFollowups.length,105);assert.equal((data.sections.nameFollowupStates[0] as any).revision,105);assert.deepEqual(data.sections.nameHandledSources,[]);
 for(const table of ['platform_companion_name_delivery_operations','platform_companion_name_safety_body_projections','platform_companion_name_safety_followups'])assert.equal(queries.filter(sql=>reads(sql,table)&&sql.includes('LIMIT 100')).length,2);assert.equal(calls.length,n);
}));
test('all sealed delivery records reject damage and cross-owner replacement without consuming the proof',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);const other=await prepared(f,runtime);await finish(other);const token=await proof(f,p.who);
 for(const table of tables.filter(t=>t!=='platform_companion_name_safety_handled')){
  const foreign=(await f.db.query(`SELECT payload_ciphertext FROM ${table} WHERE user_id=$1`,[other.who.userId])).rows[0];assert(foreign);
  for(const swap of [false,true]){let reached=false;const db=instrument(f,(sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;rows[0].payload_ciphertext=swap?foreign.payload_ciphertext:damage(rows[0].payload_ciphertext);}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
  }
 }assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.nameHandledSources.length,1);
}));

test('missing response, head, publication, operation, projection, followup state, history or handled proof cannot silently shrink the archive',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);const token=await proof(f,p.who);
 for(const table of tables){let reached=false;const db=instrument(f,(sql,rows)=>{if(reads(sql,table)){reached=true;rows.splice(0);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
 }
}));

test('authentic older state, a missing history suffix and wrong first-publication anchor are rejected',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime),old=(await f.db.query('SELECT * FROM platform_companion_name_safety_followup_states WHERE user_id=$1',[p.who.userId])).rows[0];await finish(p);const token=await proof(f,p.who);
 for(const fault of ['old_state','suffix','anchor']){let reached=false;const db=instrument(f,(sql,rows)=>{
  if(fault==='old_state'&&reads(sql,'platform_companion_name_safety_followup_states')){reached=true;rows[0]={...old};}
  if(fault==='suffix'&&reads(sql,'platform_companion_name_safety_followups')&&sql.includes('LIMIT 100')){reached=true;rows.pop();}
  if(fault==='anchor'&&sql.startsWith('SELECT first_safety_publication_id')){reached=true;rows[0].first_safety_publication_id=randomUUID();}
 });await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);}
}));

test('original response event, captured locale proof, reviewed asset, activation and handled metadata must still agree',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);const token=await proof(f,p.who);
 for(const fault of ['event','locale','asset','activation','handled']){let reached=false;const db=instrument(f,(sql,rows)=>{
  if(fault==='event'&&sql.includes('FROM platform_safety_events WHERE name_response_id=')){reached=true;rows.splice(0);}
  if(fault==='locale'&&reads(sql,'platform_companion_name_safety_responses')&&rows.length){reached=true;const r=rows[0],context={table:'platform_companion_name_safety_responses',column:'payload_ciphertext',rowId:r.id,ownerId:p.who.userId,revision:1},v=JSON.parse(f.crypto.openUtf8(r.payload_ciphertext,context));v.localeProof.sourceRevision++;r.payload_ciphertext=f.crypto.sealUtf8(JSON.stringify(v),context);}
  if(fault==='asset'&&reads(sql,'platform_safety_delivery_assets')){reached=true;rows.splice(0);}
  if(fault==='activation'&&reads(sql,'platform_safety_delivery_review_operations')){reached=true;rows.splice(0);}
  if(fault==='handled'&&reads(sql,'platform_companion_name_safety_handled')){reached=true;rows[0].source_generation++;}
 });await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached,fault);await unused(f,p.who);}
}));

test('cancellation, late auth reset and size boundaries return no partial name delivery data and preserve retry proof',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime);await finish(p);
 for(const fault of ['cancel','auth','size']){const token=await proof(f,p.who),controller=new AbortController();let reached=false;
  const db=instrument(f,async(sql,rows,client)=>{if(reads(sql,'platform_companion_name_safety_handled')&&rows.length&&!reached){reached=true;if(fault==='cancel')controller.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='size'?{maxBytes:1024}:{}).capture(p.who,token,controller.signal),{code:fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':fault==='auth'?'AUTH_REQUIRED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='size')assert(reached);await unused(f,p.who);
 }
 assert.equal((await capture(f,p.who)).sections.nameHandledSources.length,1);
}));

test('pending and prepared originals cannot disappear before any publication exists',async()=>fixture(async(f,runtime)=>{
 for(const prepare of [false,true]){
  const p=await ready(f,runtime),source=await submit(p,'Fictional prebirth high marker');await classify(f,p,runtime,source.submissionId);
  if(prepare)await f.original.prepareSubmission(source.submissionId);
  const token=await proof(f,p.who);let reached=false;
  const db=instrument(f,(sql,rows)=>{if(reads(sql,'platform_companion_name_safety_responses')){reached=true;rows.splice(0);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
  await f.db.query('DELETE FROM platform_companion_name_safety_responses WHERE user_id=$1',[p.who.userId]);
  await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),failure);await unused(f,p.who);
 }
}));

test('original creation time cannot follow its preparation or lie in the future',async()=>fixture(async(f,runtime)=>{
 const p=await prepared(f,runtime),token=await proof(f,p.who);
 const db=instrument(f,(sql,rows)=>{if(reads(sql,'platform_companion_name_safety_responses')&&rows.length)rows[0].created_at=new Date(rows[0].prepared_at.getTime()+1);});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);await unused(f,p.who);
 const pending=await ready(f,runtime),source=await submit(pending,'Fictional prebirth low marker');await classify(f,pending,runtime,source.submissionId);
 await f.db.query("UPDATE platform_companion_name_safety_responses SET created_at=clock_timestamp()+interval '1 day' WHERE user_id=$1",[pending.who.userId]);
 await assert.rejects(capture(f,pending.who),failure);await unused(f,pending.who);
}));

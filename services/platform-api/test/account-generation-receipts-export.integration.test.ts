import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {readConfig} from '../src/config.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {CompanionEntry} from '../src/companion-entry.ts';
import {hashPassword,tokenHash,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-generation-receipts-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
function instrument(transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>,beforeQuery?:(sql:string)=>void):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{beforeQuery?.(sql);const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
async function prepare(mode:'pending'|'complete'|'unpublished'='complete'){
 const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
 let result:any;
 await withPrebirthLoopback(async(runtime,requests)=>{
  const ready=await f.ready(runtime,{who,generate:false}),operationId=randomUUID(),draft=await f.store.read(who);
  const db=mode==='unpublished'?instrument(()=>{},sql=>{if(sql.includes('INSERT INTO platform_companion_revisions'))throw new Error('Fictional publication storage failure.');}):f.db;
  const entry=new CompanionEntry(db,{...readConfig(),...f.config},FICTIONAL_LEGAL,runtime);
  const accepted=await entry.accept(who,{operationId,expectedRevision:draft!.revision});assert.equal(accepted.operation.replayed,false);
  assert.equal((await entry.accept(who,{operationId,expectedRevision:draft!.revision})).operation.replayed,true);
  if(mode==='unpublished')await assert.rejects(entry.executeNotification({requestId:operationId,taskId:ready.prepared.taskId}));
  else if(mode==='complete')await entry.executeNotification({requestId:operationId,taskId:ready.prepared.taskId});
  assert.equal(requests.length,mode==='pending'?0:1);result={...ready,operationId,requestCount:requests.length};
 });
 return result as {who:FixedSessionContext;operationId:string;prepared:{taskId:string;companionId:string};requestCount:number};
}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const table=(sql:string,name:string)=>sql.startsWith(`SELECT * FROM platform_companion_generation_${name} WHERE user_id=`);
function damage(bytes:Buffer){const copy=Buffer.from(bytes);copy[copy.length-1]^=1;return copy;}
function rewrite(row:Record<string,any>,name:'requests'|'checkpoints',change:(payload:any)=>void){
 const binding={table:`platform_companion_generation_${name}`,column:'payload_ciphertext',rowId:name==='requests'?row.id:row.task_id,ownerId:row.user_id,revision:name==='requests'?row.source_revision:row.generation};
 const payload=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,binding));change(payload);const text=JSON.stringify(payload);
 row.payload_ciphertext=f.crypto.sealUtf8(text,binding);row.payload_digest=createHash('sha256').update(text).digest('hex');
}

test('accepted request and pending outbox preserve original intent but exclude original execution credentials',async()=>{
 const p=await prepare('pending'),other=await prepare('pending'),token=await proof(p.who),result=await new AccountCoreExport(f.db,f.config).capture(p.who,token);
 const request=result.sections.companionGenerationRequests[0] as any,outbox=result.sections.companionGenerationOutbox[0] as any;
 assert.equal(result.sections.companionGenerationRequests.length,1);assert.equal(request.operationId,p.operationId);assert.equal(request.command.operationId,p.operationId);assert.equal(request.sourceRevision,request.command.expectedRevision);assert.equal(request.initialGeneration,0);
 assert.equal(outbox.requestId,p.operationId);assert.equal(outbox.taskId,p.prepared.taskId);assert.equal(outbox.dispatchedAt,null);assert.equal(outbox.heldReason,null);
 assert.deepEqual(result.sections.companionGenerationCheckpoints,[]);assert.deepEqual(result.sections.companionRevisions,[]);
 const text=JSON.stringify(result);for(const secret of [p.who.tokenHash,other.who.userId,other.operationId,password,encoded,token,'authVersion','payload_digest','payload_ciphertext','fictional-loopback-only'])assert(!text.includes(secret));
 assert(Object.isFrozen(request.command));assert.equal(result.includedTables.length,58);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 for(const name of ['requests','outbox','checkpoints'])assert(!result.remainingTables.includes(`platform_companion_generation_${name}`));
 assert(result.includedTables.includes('platform_cost_ledger'));
});

test('completed generation includes the original checkpoint and cost receipt independently of its published revision',async()=>{
 const p=await prepare(),result=await capture(p.who),checkpoint=result.sections.companionGenerationCheckpoints[0] as any,revision=result.sections.companionRevisions[0] as any;
 assert.equal(result.sections.companionGenerationCheckpoints.length,1);assert.equal(checkpoint.publishedRevision,1);assert.equal(checkpoint.taskId,p.prepared.taskId);assert.equal(checkpoint.preview.summary,revision.summary);assert.deepEqual(checkpoint.preview.samples,revision.samples);
 const original=(await f.db.query('SELECT * FROM platform_companion_generation_checkpoints WHERE user_id=$1',[p.who.userId])).rows[0];
 const saved=JSON.parse(f.crypto.openUtf8(original.payload_ciphertext,{table:'platform_companion_generation_checkpoints',column:'payload_ciphertext',rowId:original.task_id,ownerId:p.who.userId,revision:original.generation}));
 assert.deepEqual(checkpoint.preview,saved.preview);assert.deepEqual(checkpoint.costReceipts,saved.costReceipts);
 assert.equal(checkpoint.costReceipts[0].costMicros,'76');assert.equal(checkpoint.costReceipts[0].pricingRevision,2);assert.equal(checkpoint.costReceipts[0].units.inputTokens,34);
 assert(Object.isFrozen(checkpoint.costReceipts[0].units));assert.equal((result.sections.companionGenerationOutbox[0] as any).dispatchedAt,null);
});

test('a real failure before publication retains its checkpoint without inventing a completed task or published preview',async()=>{
 const p=await prepare('unpublished'),before=(await f.db.query('SELECT status FROM platform_companion_generation_tasks WHERE id=$1',[p.prepared.taskId])).rows[0].status;
 assert.notEqual(before,'completed');assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companion_revisions WHERE user_id=$1',[p.who.userId])).rows[0].n,0);
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(p.who));
 assert.equal(result.sections.companionGenerationCheckpoints.length,1);assert.equal((result.sections.companionGenerationCheckpoints[0] as any).publishedRevision,null);assert.deepEqual(result.sections.companionRevisions,[]);
 assert.equal((result.sections.companionGenerationTasks[0] as any).status,before);assert.equal(result.sections.companionGenerationCalls.length,1);
 assert(!queries.filter(sql=>/FROM platform_companion_generation_/.test(sql)).some(sql=>/FOR (UPDATE|SHARE)/.test(sql)));
 assert.equal((await f.db.query('SELECT status FROM platform_companion_generation_tasks WHERE id=$1',[p.prepared.taskId])).rows[0].status,before);
});

test('a new authenticated session can export history after the accepted session expires and model consent is withdrawn',async()=>{
 const p=await prepare(),original=await capture(p.who),newSession={userId:p.who.userId,tokenHash:tokenHash(randomUUID())};
 await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[p.who.tokenHash]);
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[newSession.userId,newSession.tokenHash]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const result=await capture(newSession);assert.deepEqual(result.sections.companionGenerationRequests,original.sections.companionGenerationRequests);assert.deepEqual(result.sections.companionGenerationCheckpoints,original.sections.companionGenerationCheckpoints);
 assert(!JSON.stringify(result).includes(p.who.tokenHash));assert(!JSON.stringify(result).includes(newSession.tokenHash));
});

test('outbox dispatch and every held reason remain delivery metadata without starting or recovering generation',async()=>{
 const p=await prepare('pending');
 for(const held of ['authorization','configuration','source_changed','storage','terminal']){
  await f.db.query('UPDATE platform_companion_generation_outbox SET held_reason=$2,dispatched_at=clock_timestamp() WHERE request_id=$1',[p.operationId,held]);
  const result=await capture(p.who),row=result.sections.companionGenerationOutbox[0] as any;assert.equal(row.heldReason,held);assert.equal(typeof row.dispatchedAt,'string');
  assert.equal((result.sections.companionGenerationTasks[0] as any).status,'pending');assert.deepEqual(result.sections.companionGenerationCalls,[]);assert.deepEqual(result.sections.companionGenerationCheckpoints,[]);
 }
});

test('damaged, foreign and digest-mismatched request or checkpoint ciphertext reject the whole capture and preserve the proof',async()=>{
 const p=await prepare(),other=await prepare(),token=await proof(p.who);
 for(const name of ['requests','checkpoints']){
  const foreign=(await f.db.query(`SELECT * FROM platform_companion_generation_${name} WHERE user_id=$1`,[other.who.userId])).rows[0];
  for(const kind of ['damaged','foreign','digest']){let reached=false;const db=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){reached=true;if(kind==='digest')rows[0].payload_digest='0'.repeat(64);else rows[0].payload_ciphertext=kind==='foreign'?foreign.payload_ciphertext:damage(rows[0].payload_ciphertext);}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
  }
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionGenerationCheckpoints.length,1);
});

test('unknown encrypted fields, source mismatches and broken outbox links cannot enter the archive',async()=>{
 const p=await prepare(),token=await proof(p.who);
 const cases:[string,(rows:any[])=>void][]=[
  ['requests',rows=>{rows[0].auth_version='999';}],['requests',rows=>rewrite(rows[0],'requests',p=>{p.extraCredential='must not escape';})],
  ['outbox',rows=>{rows.splice(0);}],['outbox',rows=>{rows[0].task_id=randomUUID();}],['outbox',rows=>{rows[0].held_reason='unknown';}],
  ['checkpoints',rows=>{rows[0].source_draft_id=randomUUID();}],['checkpoints',rows=>{rows[0].call_ids=[randomUUID()];}],
  ['checkpoints',rows=>rewrite(rows[0],'checkpoints',p=>{p.costReceipts[0].credential='must not escape';})],
  ['checkpoints',rows=>rewrite(rows[0],'checkpoints',p=>{p.costReceipts[0].reservationId=randomUUID();})],
  ['checkpoints',rows=>rewrite(rows[0],'checkpoints',p=>{p.costReceipts[0].units.rawPrompt='must not escape';})],
  ['checkpoints',rows=>rewrite(rows[0],'checkpoints',p=>{p.preview.summary='Changed saved preview';})],
 ];
 for(const [name,change] of cases){let reached=false;const db=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){reached=true;change(rows);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionGenerationRequests.length,1);
});

test('cancellation while reading checkpoints returns no partial archive and leaves the proof reusable',async()=>{
 const p=await prepare(),token=await proof(p.who),controller=new AbortController(),db=instrument(sql=>{if(table(sql,'checkpoints'))controller.abort();});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionGenerationCheckpoints.length,1);
});

test('historical checkpoint generations cross the composite-key page boundary without dropping earlier records',async()=>{
 const p=await prepare('unpublished'),checkpoint=(await f.db.query('SELECT * FROM platform_companion_generation_checkpoints WHERE task_id=$1',[p.prepared.taskId])).rows[0];
 const call=(await f.db.query('SELECT * FROM platform_companion_generation_calls WHERE task_id=$1',[p.prepared.taskId])).rows[0];
 const payload=JSON.parse(f.crypto.openUtf8(checkpoint.payload_ciphertext,{table:'platform_companion_generation_checkpoints',column:'payload_ciphertext',rowId:checkpoint.task_id,ownerId:p.who.userId,revision:checkpoint.generation}));
 // Synthetic retained history exercises archive pagination; it does not authorize
 // additional generations or claim these attempts were actually dispatched.
 await f.db.withBoundedTransaction(async client=>{
  await client.query('UPDATE platform_companion_generation_tasks SET generation=105 WHERE id=$1',[p.prepared.taskId]);
  for(let generation=2;generation<=105;generation++){
   const callId=randomUUID(),reservationId=randomUUID();
   await client.query(`INSERT INTO platform_cost_reservations SELECT (jsonb_populate_record(NULL::platform_cost_reservations,to_jsonb(r)||$2::jsonb)).*
    FROM platform_cost_reservations r WHERE id=$1`,[call.reservation_id,JSON.stringify({id:reservationId})]);
   await client.query(`INSERT INTO platform_cost_ledger SELECT (jsonb_populate_record(NULL::platform_cost_ledger,to_jsonb(r)||$2::jsonb)).*
    FROM platform_cost_ledger r WHERE reservation_id=$1`,[call.reservation_id,JSON.stringify({reservation_id:reservationId})]);
   await client.query(`INSERT INTO platform_companion_generation_calls SELECT (jsonb_populate_record(NULL::platform_companion_generation_calls,to_jsonb(r)||$2::jsonb)).*
    FROM platform_companion_generation_calls r WHERE call_id=$1`,[call.call_id,JSON.stringify({call_id:callId,reservation_id:reservationId,generation})]);
   const saved={...payload,preview:{...payload.preview,generation,callIds:[callId]},costReceipts:payload.costReceipts.map((r:any)=>({...r,callId,reservationId}))},text=JSON.stringify(saved);
   const bytes=f.crypto.sealUtf8(text,{table:'platform_companion_generation_checkpoints',column:'payload_ciphertext',rowId:checkpoint.task_id,ownerId:p.who.userId,revision:generation});
   await client.query(`INSERT INTO platform_companion_generation_checkpoints(task_id,user_id,companion_id,generation,source_draft_id,source_revision,call_ids,policy_revision,payload_digest,payload_ciphertext)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9)`,[checkpoint.task_id,p.who.userId,checkpoint.companion_id,generation,checkpoint.source_draft_id,checkpoint.source_revision,[callId],createHash('sha256').update(text).digest('hex'),bytes]);
  }
 },{timeoutMs:5000});
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(p.who,await proof(p.who));
 const records=result.sections.companionGenerationCheckpoints as any[];
 assert.deepEqual(records.map(r=>r.generation),Array.from({length:105},(_,i)=>i+1));assert(records.every(r=>r.publishedRevision===null));
 assert.equal(result.sections.companionGenerationCalls.length,105);assert.equal(queries.filter(sql=>table(sql,'checkpoints')).length,2);
 assert.equal(result.sections.companionGenerationRequests.length,1);assert.equal(result.sections.companionGenerationOutbox.length,1);
});

test('older checkpoint receipt shapes retain unknown cache breakdown and exact money strings',async()=>{
 const p=await prepare('unpublished'),db=instrument((sql,rows)=>{if(table(sql,'checkpoints')&&rows.length)rewrite(rows[0],'checkpoints',payload=>{
  const receipt=payload.costReceipts[0];for(const key of ['pricingRevision','cachedInputPriceId','cacheWriteInputPriceId','cachedInputRate','cacheWriteInputRate'])delete receipt[key];
  receipt.costMicros='9007199254740993';receipt.estimateMicros='9007199254740994';receipt.inputRate='0.000001';
 });});
 // Authenticated synthetic legacy payload read: no new bill or generation claim.
 const result=await new AccountCoreExport(db,f.config).capture(p.who,await proof(p.who)),receipt=(result.sections.companionGenerationCheckpoints[0] as any).costReceipts[0];
 assert.equal(receipt.costMicros,'9007199254740993');assert.equal(receipt.estimateMicros,'9007199254740994');assert.equal(receipt.inputRate,'0.000001');
 assert(!('pricingRevision' in receipt));assert(!('cachedInputTokens' in receipt.units));assert(!('cacheWriteInputTokens' in receipt.units));
});

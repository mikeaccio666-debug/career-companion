import { before,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import { readFile } from 'node:fs/promises';
import { workflowHash } from '@companion/ai-core';import { ResumeOriginalReview } from '../src/resume-original-review.ts';import { ApiError } from '../src/errors.ts';import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';import type { ResumeReviewView } from '@companion/platform-contracts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,review:ResumeOriginalReview;
before(async()=>{f=await createCompanionNameSafetyFixture();review=new ResumeOriginalReview(f.db,f.config,FICTIONAL_LEGAL);});after(async()=>{await f?.close();});
const create=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:0,track:'da',label:'PRIVATE_FICTIONAL_ORIGINAL',text:'PRIVATE_FICTIONAL_RESUME_BODY: course project, personal action, no invented work.',...patch});
const command=(view:ResumeReviewView,patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:view.item.revision,payloadDigest:view.item.payloadDigest,...patch});
const error=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
test('actual owner original is pending until digest-bound explicit confirmation; edited text invalidates old revision and approved none-action object is terminal',async()=>{
 const who=await f.actor(),original=(await review.mutate(who,'create',null,create(),'web')).view!;
 assert.equal(original.item.status,'pending');assert.equal(original.item.resumeStatus,'draft');assert.equal(original.item.draftedBy,null);assert.equal(original.item.approvedAt,null);assert.equal(original.item.payloadDigest,workflowHash(original.payload));
 const edited=(await review.mutate(who,'edit',original.item.id,command(original,{label:'Fictional corrected original',text:original.payload.text+'\nA corrected fact.'}),'web')).view!;
 assert.equal(edited.item.revision,2);assert.notEqual(edited.item.payloadDigest,original.item.payloadDigest);
 await assert.rejects(review.mutate(who,'approve',original.item.id,command(original),'web'),error(409));await assert.rejects(review.mutate(who,'approve',original.item.id,command(edited,{payloadDigest:'0'.repeat(64)}),'web'),error(409));
 const approved=(await review.mutate(who,'approve',original.item.id,command(edited),'web')).view!;assert.equal(approved.item.revision,2);assert.equal(approved.item.status,'approved');assert.equal(approved.item.resumeStatus,'active');assert.equal(approved.item.approvedDigest,workflowHash(approved.payload));assert.equal(approved.item.approvedChannel,'web');
 await assert.rejects(review.mutate(who,'edit',approved.item.id,command(approved,{label:'Fictional bad edit',text:'Fictional new content'}),'web'),error(409));
 assert.equal((await review.revision(who,original.item.id,1)).payload.text,original.payload.text);assert.equal((await review.revision(who,original.item.id,2)).payload.text,edited.payload.text);
 const rows=(await f.db.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1',[who.userId])).rows;assert.equal(rows.length,1);assert.equal(rows[0].payload_digest,approved.item.payloadDigest);
});
test('new same-track draft only supersedes actual unconfirmed predecessor, preserves other tracks and confirmed old versions, and binds real fork lineage',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!,approved=(await review.mutate(who,'approve',a.item.id,command(a),'web')).view!;
 const other=(await review.mutate(who,'create',null,create({track:'swe'}),'web')).view!;
 const b=(await review.mutate(who,'create',null,create({derivedFromId:approved.item.resumeVersionId,text:'Fictional personally revised body.'}),'web')).view!;
 assert.equal(b.item.source,'derived');assert.deepEqual(b.item.derivedFrom,{id:approved.item.resumeVersionId,pendingItemId:approved.item.id,revision:approved.item.revision,approvedDigest:approved.item.payloadDigest});assert.equal(b.item.sequence,2);
 const c=(await review.mutate(who,'create',null,create(),'web')).view!;assert.equal((await review.get(who,b.item.id)).item.status,'superseded');assert.equal((await review.get(who,b.item.id)).item.supersededBy,c.item.id);
 assert.equal((await review.get(who,approved.item.id)).item.resumeStatus,'active');assert.equal((await review.get(who,other.item.id)).item.status,'pending');
 await assert.rejects(review.mutate(who,'create',null,create({derivedFromId:c.item.resumeVersionId}),'web'),error(409));assert.equal((await review.get(who,c.item.id)).item.status,'pending');
 const fresh=(await review.mutate(who,'create',null,create({derivedFromId:approved.item.resumeVersionId}),'web')).view!;
 await review.mutate(who,'delete',approved.item.id,command(approved),'web');await assert.rejects(review.mutate(who,'approve',fresh.item.id,command(fresh),'web'),error(409));
});
test('original operation observers and retries return actual current saved state; deleted content/history cannot be resurrected by a late create',async()=>{
 const who=await f.actor(),body=create(),saved=await review.mutate(who,'create',null,body,'web');assert.equal((await review.operation(who,body.operationId)).view!.item.id,saved.view!.item.id);
 assert.equal((await review.mutate(who,'create',null,body,'web')).operation.replayed,true);await assert.rejects(review.mutate(who,'create',null,{...body,text:'Different original.'},'web'),error(409));
 await review.mutate(who,'delete',saved.view!.item.id,command(saved.view!),'web');assert.equal((await review.mutate(who,'create',null,body,'web')).view,null);assert.equal((await review.operation(who,body.operationId)).view,null);
 for(const table of ['platform_pending_items','platform_pending_item_revisions','platform_pending_item_decisions','platform_career_resume_versions'])assert.equal((await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
 const next=(await review.mutate(who,'create',null,create(),'web')).view!;assert.equal(next.item.sequence,2);
});
test('real metadata, immutable payload history and confirmation decision authenticate the source; valid older metadata or relocated ciphertext cannot bypass them',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!,row=(await f.db.query('SELECT * FROM platform_pending_items WHERE id=$1',[a.item.id])).rows[0];
 await review.mutate(who,'edit',a.item.id,command(a,{label:'Fictional correction',text:'Fictional correction.'}),'web');
 await f.db.query('UPDATE platform_pending_items SET current_revision=$2,generation=$3,last_operation_id=$4,record_ciphertext=$5,updated_at=$6 WHERE id=$1',[row.id,row.current_revision,row.generation,row.last_operation_id,row.record_ciphertext,row.updated_at]);await assert.rejects(review.get(who,a.item.id),error(503));
 const other=await f.actor(),b=(await review.mutate(other,'create',null,create(),'web')).view!;
 await assert.rejects(f.db.query('UPDATE platform_pending_item_revisions SET payload_digest=$2 WHERE item_id=$1',[b.item.id,'0'.repeat(64)]));await assert.rejects(f.db.query('DELETE FROM platform_pending_item_operations WHERE user_id=$1',[other.userId]));
 const approved=(await review.mutate(other,'approve',b.item.id,command(b),'web')).view!;
 await assert.rejects(f.db.query("UPDATE platform_pending_item_decisions SET channel='discord' WHERE item_id=$1",[approved.item.id]));
 await f.db.query("UPDATE platform_career_resume_versions SET status='draft' WHERE id=$1",[b.item.resumeVersionId]);await assert.rejects(review.get(other,b.item.id),error(503));
});
test('all private labels and body remain encrypted, owner isolation is real, non-Web decisions and fabricated metadata are rejected',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),a=(await review.mutate(who,'create',null,create(),'web')).view!;
 for(const [table,column] of [['platform_pending_items','record_ciphertext'],['platform_pending_item_revisions','ciphertext'],['platform_pending_item_operations','receipt_ciphertext']]){
  for(const row of (await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1',[who.userId])).rows){const raw=row[column];assert(!raw.includes(Buffer.from('PRIVATE_FICTIONAL')));}
 }
 assert(!JSON.stringify(await review.list(who)).includes('PRIVATE_FICTIONAL_RESUME_BODY'));
 for(const key of [a.item.id,a.item.resumeVersionId])await assert.rejects(review.get(other,key,key===a.item.resumeVersionId),error(404));
 await assert.rejects(review.get(staff,a.item.id),error(403));await assert.rejects(review.operation(other,a.item.lastOperationId),error(404));
 for(const channel of ['discord','extension'] as const)await assert.rejects(review.mutate(who,'approve',a.item.id,command(a),channel),error(403));
 for(const patch of [{claims:[{text:'invented'}]},{source:'model'},{draftedBy:'guide'},{finalAction:'user_sends'},{approvedAt:a.item.createdAt},{ownerId:other.userId}])await assert.rejects(review.mutate(who,'create',null,create(patch),'web'),error(400));
});
test('duplicate approval tuple preserves the first actual decision and archival cannot be undone by a retry',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!,body=command(a),first=(await review.mutate(who,'approve',a.item.id,body,'web')).view!;
 assert.equal((await review.mutate(who,'approve',a.item.id,body,'web')).operation.replayed,true);
 const again=(await review.mutate(who,'approve',a.item.id,command(first),'web')).view!;assert.equal(again.item.approvedAt,first.item.approvedAt);assert.equal(again.item.approvalOperationId,first.item.approvalOperationId);
 assert.equal((await f.db.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1',[who.userId])).rowCount,1);
 const archived=(await review.mutate(who,'archive',a.item.id,command(again),'web')).view!;
 assert.equal((await review.mutate(who,'approve',a.item.id,command(archived),'web')).view!.item.resumeStatus,'archived');
});
test('current admission withdrawal preserves owner reading and forgetting but not new confirmation; session reset rolls back all source transitions and counters',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!;await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 assert.equal((await review.get(who,a.item.id)).item.id,a.item.id);await assert.rejects(review.mutate(who,'approve',a.item.id,command(a),'web'),error(403));await review.mutate(who,'delete',a.item.id,command(a),'web');
 const other=await f.actor(),b=(await review.mutate(other,'create',null,create(),'web')).view!,original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{const query=client.query.bind(client);let reset=false;const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await (query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_career_resume_versions')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[other.userId]);}return result;};return Reflect.get(target,key);}});return run(guarded);},options);
 try{await assert.rejects(review.mutate(other,'create',null,create(),'web'),error(401));}finally{f.db.withBoundedTransaction=original;}
 assert.equal((await review.get(other,b.item.id)).item.status,'pending');assert.equal((await f.db.query('SELECT count(*)::int count FROM platform_pending_items WHERE user_id=$1',[other.userId])).rows[0].count,1);
 assert.equal((await f.db.query('SELECT sequence FROM platform_career_resume_counters WHERE user_id=$1',[other.userId])).rows[0].sequence,1);
});
async function withFutureClock<T>(run:()=>Promise<T>):Promise<T>{const original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(fn,options)=>original(async client=>{const query=client.query.bind(client);const guarded=new Proxy(client,{get(target,key){if(key==='query')return (...args:any[])=>{if(typeof args[0]==='string'&&(args[0]==='SELECT clock_timestamp() at'||args[0].includes('expires_at<=clock_timestamp()')))args[0]=args[0].replaceAll('clock_timestamp()',"(clock_timestamp()+interval '8 days')");return (query as any)(...args);};return Reflect.get(target,key);}});return fn(guarded);},options);
 try{return await run();}finally{f.db.withBoundedTransaction=original;}}
test('controlled database clock expiration never confirms or sends and explicit reopen creates a new revision requiring confirmation',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!;
 await withFutureClock(async()=>{assert.deepEqual((await review.list(who,{status:'pending'})).items,[]);const expired=await review.get(who,a.item.id);assert.equal(expired.item.status,'expired');assert.equal(expired.item.approvedAt,null);await assert.rejects(review.mutate(who,'approve',a.item.id,command(expired),'web'),error(409));
 const restored=(await review.mutate(who,'reopen',a.item.id,command(expired),'web')).view!;assert.equal(restored.item.status,'pending');assert.equal(restored.item.revision,2);assert.equal(restored.item.payloadDigest,a.item.payloadDigest);assert.equal(restored.item.approvedAt,null);assert.equal((await review.mutate(who,'approve',restored.item.id,command(restored),'web')).view!.item.status,'approved');});
});
test('account deletion cascades every private source and genuine schema migration is repeatable',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!;await review.mutate(who,'approve',a.item.id,command(a),'web');
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);for(const table of ['platform_pending_items','platform_pending_item_operations','platform_pending_item_revisions','platform_pending_item_decisions','platform_career_resume_versions','platform_career_resume_counters'])assert.equal((await f.db.query('SELECT * FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
 await f.db.migrate();await f.db.query(await readFile(new URL('../migrations/058_resume_original_review.sql',import.meta.url),'utf8'));
});

test('concurrent owner edits accept one original version while independent approval tuple retries preserve one true decision',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!;
 const results=await Promise.allSettled(['Fictional body A','Fictional body B'].map(text=>review.mutate(who,'edit',a.item.id,command(a,{label:'Fictional concurrent edit',text}),'web')));
 assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.filter(v=>v.status==='rejected').length,1);
 const current=await review.get(who,a.item.id);assert.equal(current.item.revision,2);
 const approvals=await Promise.all([review.mutate(who,'approve',current.item.id,command(current),'web'),review.mutate(who,'approve',current.item.id,command(current),'web')]);assert.equal(approvals[0].view!.item.approvedAt,approvals[1].view!.item.approvedAt);assert.equal((await f.db.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1',[who.userId])).rowCount,1);
});
test('approval rechecks the real clock after source loading so an original that expires during admission cannot become active',async()=>{
 const who=await f.actor(),a=(await review.mutate(who,'create',null,create(),'web')).view!,original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{const query=client.query.bind(client);let clocks=0;const guarded=new Proxy(client,{get(target,key){if(key==='query')return (...args:any[])=>{if(args[0]==='SELECT clock_timestamp() at'&&++clocks>=2)args[0]="SELECT (clock_timestamp()+interval '8 days') AS at";return (query as any)(...args);};return Reflect.get(target,key);}});return run(guarded);},options);
 try{await assert.rejects(review.mutate(who,'approve',a.item.id,command(a),'web'),error(409));}finally{f.db.withBoundedTransaction=original;}
 assert.equal((await review.get(who,a.item.id)).item.status,'pending');assert.equal((await f.db.query('SELECT * FROM platform_pending_item_decisions WHERE user_id=$1',[who.userId])).rowCount,0);
});

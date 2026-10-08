import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareCareerRun } from '@companion/career-core';
import { CareerStories } from '../src/career-stories.ts';
import { CareerTargets } from '../src/career-targets.ts';
import { ResumeOriginalReview } from '../src/resume-original-review.ts';
import { CareerPreparationSources } from '../src/career-preparation-sources.ts';
import { ApiError } from '../src/errors.ts';
import type { FixedSessionContext } from '../src/auth.ts';
import type { ResumeReviewAction } from '@companion/platform-contracts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,resumes:ResumeOriginalReview,library:CareerStories,targets:CareerTargets,sources:CareerPreparationSources;
before(async()=>{f=await createCompanionNameSafetyFixture();resumes=new ResumeOriginalReview(f.db,f.config,FICTIONAL_LEGAL);library=new CareerStories(f.db,f.config,FICTIONAL_LEGAL);targets=new CareerTargets(f.db,f.config,FICTIONAL_LEGAL);sources=new CareerPreparationSources(f.db,targets,library,resumes);});after(async()=>{await f?.close();});
const save=(who:FixedSessionContext,kind:ResumeReviewAction,id:unknown,input:unknown)=>resumes.mutate(who,kind,id,input,'web');
const create=(track='da')=>({operationId:randomUUID(),expectedRevision:0,track,label:'PRIVATE_FICTIONAL_RESUME_LABEL',text:'PRIVATE_FICTIONAL_ORIGINAL_BODY. Fictional owner research.'});
const action=(v:any)=>({operationId:randomUUID(),expectedRevision:v.item.revision,payloadDigest:v.item.payloadDigest});
const coord=(v:{ownerId:string;indexId:string})=>({ownerId:v.ownerId,indexId:v.indexId}),error=(n:number)=>(e:unknown)=>e instanceof ApiError&&e.status===n;

test('actual confirmed active originals enter metadata preparation at their real resume ID and revision; draft and new generations cannot pretend recency or execution',async()=>{
 const who=await f.actor(),other=await f.actor(),draft=(await save(who,'create',null,create())).view!;
 await save(other,'create',null,create());assert.deepEqual((await sources.read(who)).resumes,[]);
 const approved=(await save(who,'approve',draft.item.id,action(draft))).view!,index=await sources.read(who);
 assert.deepEqual(index.resumes!.map(r=>({id:r.id,revision:r.revision,approvedAt:r.approvedAt})),[{id:approved.item.resumeVersionId,revision:1,approvedAt:approved.item.approvedAt}]);assert(!JSON.stringify(index).includes('PRIVATE_FICTIONAL'));
 const prepared=await sources.prepare(who,{skillId:'resume-revision'});assert.equal(prepared.built.context.inputs.find(r=>r.input==='resume-source')!.id,approved.item.resumeVersionId);assert(!prepared.built.unavailableSources.includes('listResumeVersions'));assert(prepared.built.unavailableSources.includes('readProfile'));assert.deepEqual(prepared.built.context.tools,{});assert.equal(prepareCareerRun('resume-revision',prepared.built.context).state,'blocked');
 const fresh=(await save(who,'create',null,create())).view!;assert.equal((await sources.read(who)).indexId,index.indexId);
 const latest=(await save(who,'approve',fresh.item.id,action(fresh))).view!,newIndex=await sources.read(who);assert.equal(newIndex.resumes!.length,2);assert.notEqual(newIndex.indexId,index.indexId);assert.equal((await sources.prepare(who,{skillId:'resume-revision'})).built.context.inputs.find(r=>r.input==='resume-source')!.id,latest.item.resumeVersionId);
 const selected=await sources.prepare(who,{skillId:'resume-revision',selection:{resumeId:approved.item.resumeVersionId}});assert.equal(selected.built.context.inputs.find(r=>r.input==='resume-source')!.id,approved.item.resumeVersionId);
 const again=(await save(who,'approve',approved.item.id,action(approved))).view!;assert(again.item.generation>approved.item.generation);assert.equal(again.item.approvedAt,approved.item.approvedAt);assert.equal((await sources.read(who)).indexId,newIndex.indexId);assert.equal((await sources.prepare(who,{skillId:'resume-revision'})).built.context.inputs.find(r=>r.input==='resume-source')!.id,latest.item.resumeVersionId);
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(index))),error(409));assert.equal((await sources.read(other)).resumes!.length,0);
});
test('archive, decline and physical forget change actual source availability and freeze old coordinates without reviving or substituting a selected resume',async()=>{
 const who=await f.actor(),a=(await save(who,'create',null,create())).view!;const first=(await save(who,'approve',a.item.id,action(a))).view!;const b=(await save(who,'create',null,create())).view!,latest=(await save(who,'approve',b.item.id,action(b))).view!;let index=await sources.read(who);
 await save(who,'archive',latest.item.id,action(latest));await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(index))),error(409));assert.equal((await sources.prepare(who,{skillId:'resume-revision'})).built.context.inputs.find(r=>r.input==='resume-source')!.id,first.item.resumeVersionId);
 assert.equal((await sources.prepare(who,{skillId:'resume-revision',selection:{resumeId:latest.item.resumeVersionId}})).built.context.inputs.some(r=>r.input==='resume-source'),false);
 const c=(await save(who,'create',null,create('swe'))).view!;await save(who,'decline',c.item.id,action(c));assert.equal((await sources.read(who)).resumes!.length,1);
 index=await sources.read(who);await save(who,'delete',first.item.id,action(first));assert.deepEqual((await sources.read(who)).resumes,[]);await assert.rejects(f.db.withBoundedTransaction(tx=>sources.assertCurrentInTransaction(tx,who,coord(index))),error(409));
 assert.equal((await sources.prepare(who,{skillId:'resume-revision',selection:{resumeId:first.item.resumeVersionId}})).built.context.inputs.length,0);
});
test('actual immutable decisions and latest receipt still govern index reads, including valid old metadata and forged active projections',async()=>{
 const who=await f.actor(),draft=(await save(who,'create',null,create())).view!;const old=(await f.db.query('SELECT * FROM platform_pending_items WHERE id=$1',[draft.item.id])).rows[0];await save(who,'approve',draft.item.id,action(draft));
 await f.db.query('UPDATE platform_pending_items SET status=$2,current_revision=$3,generation=$4,last_operation_id=$5,record_ciphertext=$6,updated_at=$7 WHERE id=$1',[old.id,old.status,old.current_revision,old.generation,old.last_operation_id,old.record_ciphertext,old.updated_at]);await assert.rejects(sources.read(who),error(503));
 const other=await f.actor(),pending=(await save(other,'create',null,create())).view!;await f.db.query("UPDATE platform_career_resume_versions SET status='active' WHERE id=$1",[pending.item.resumeVersionId]);await assert.rejects(sources.read(other),error(503));
});
test('actual adapter absence stays distinct from an empty owned collection; forged selection fields, staff, foreign and revoked fixed sessions cannot gain preparation access',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true);const absent=new CareerPreparationSources(f.db,targets,library);assert.equal((await absent.read(who)).resumes,null);assert((await absent.prepare(who,{skillId:'resume-revision'})).built.unavailableSources.includes('listResumeVersions'));assert.deepEqual((await sources.read(who)).resumes,[]);
 const index=await sources.read(who);await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,other,coord(index))),error(404));await assert.rejects(sources.read(staff),error(403));
 for(const input of [{skillId:'resume-revision',selection:{resumeId:randomUUID(),approvedDigest:'invented'}},{skillId:'resume-revision',selection:{uploadedResumeId:randomUUID()}},{skillId:'resume-revision',resumes:[]},{skillId:'resume-revision',tools:{read_resume_version:'ready'}}])await assert.rejects(sources.prepare(who,input),error(400));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(sources.read(who),error(403));await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[other.userId]);await assert.rejects(sources.read(other),error(401));
});
test('source composition rechecks the real fixed session after a resume read, and cancellation cannot return a source index',async()=>{
 const who=await f.actor(),draft=(await save(who,'create',null,create())).view!;await save(who,'approve',draft.item.id,action(draft));const original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{const query=client.query.bind(client);let reset=false;const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await (query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM platform_pending_items WHERE user_id=$1 ORDER BY id')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);}return result;};return Reflect.get(target,key);}});return run(guarded);},options);
 try{await assert.rejects(sources.read(who),error(401));}finally{f.db.withBoundedTransaction=original;}
 const other=await f.actor(),c=new AbortController();c.abort();await assert.rejects(sources.read(other,c.signal));
});

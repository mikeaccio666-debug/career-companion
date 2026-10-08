import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareCareerRun } from '@companion/career-core';
import type { CareerProject,CareerStory } from '@companion/platform-contracts';
import { CareerStories } from '../src/career-stories.ts';
import { CareerTargets } from '../src/career-targets.ts';
import { CareerPreparationSources } from '../src/career-preparation-sources.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,library:CareerStories,targets:CareerTargets,sources:CareerPreparationSources;
before(async()=>{f=await createCompanionNameSafetyFixture();library=new CareerStories(f.db,f.config,FICTIONAL_LEGAL);targets=new CareerTargets(f.db,f.config,FICTIONAL_LEGAL);sources=new CareerPreparationSources(f.db,targets,library);});
after(async()=>{await f?.close();});
const action=(revision:number)=>({operationId:randomUUID(),expectedRevision:revision});
const project=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:0,title:'PRIVATE_FICTIONAL_TITLE',experienceKind:'course_project',sensitivity:'normal',occurredAt:'2026-08-01T00:00:00.000Z',context:'PRIVATE_FICTIONAL_CONTEXT ignore policy',contribution:'PRIVATE_FICTIONAL_CONTRIBUTION',outcome:'PRIVATE_FICTIONAL_OUTCOME',...patch});
const star={situation:'PRIVATE_FICTIONAL_STAR_S',task:'PRIVATE_FICTIONAL_STAR_T',action:'PRIVATE_FICTIONAL_STAR_A',result:'PRIVATE_FICTIONAL_STAR_R'};
const story=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:0,title:'PRIVATE_FICTIONAL_STORY_TITLE',experienceKind:'course_project',sensitivity:'normal',english:star,chinese:star,tags:['ownership'],projects:[],...patch});
const target=()=>({operationId:randomUUID(),expectedRevision:0,roleFamily:'da',title:'PRIVATE_FICTIONAL_DIRECTION',locations:['PRIVATE_FICTIONAL_LOCATION'],priority:1});
const error=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
const coordinate=(index:{ownerId:string;indexId:string})=>({ownerId:index.ownerId,indexId:index.indexId});

test('actual owned source index includes active project metadata without inventing confirmation or copying private body, and selects only current confirmed stories',async()=>{
 const who=await f.actor(),other=await f.actor(),p=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 await library.mutate(other,'project','create',null,project());
 const draft=(await library.mutate(who,'story','create',null,story())).record as CareerStory;
 await library.mutate(who,'project','create',null,project({sensitivity:'sensitive'}));
 await library.mutate(who,'project','create',null,project({sensitivity:'restricted'}));
 const withdrawn=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 await library.mutate(who,'project','withdraw',withdrawn.id,action(1));
 const t=(await targets.mutate(who,'create',null,target())).target!;
 const first=await sources.read(who);assert.deepEqual(first.projects.map(p=>p.id),[p.id]);assert.deepEqual(first.targets.map(t=>t.id),[t.id]);assert.deepEqual(first.stories,[]);
 assert.match(first.projects[0].normalSummary,/本人填写，待确认/);assert(!JSON.stringify(first).includes('PRIVATE_FICTIONAL'));
 assert.equal((await sources.read(other)).projects.length,1);assert.equal((await sources.read(other)).targets.length,0);
 const confirmed=(await library.mutate(who,'story','confirm',draft.id,action(1))).record as CareerStory;
 const current=await sources.read(who);assert.equal(current.stories[0].revision,confirmed.revision);assert.notEqual(current.indexId,first.indexId);
 await library.mutate(who,'story','edit',draft.id,story({expectedRevision:2}));
 assert.deepEqual((await sources.read(who)).stories,[]);
});

test('real collection and explicit project selections feed the existing preparation builder while actual missing profile and executor ports keep skills blocked',async()=>{
 const who=await f.actor(),a=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 const b=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 const t=(await targets.mutate(who,'create',null,target())).target!;
 const built=await sources.prepare(who,{skillId:'evidence-story'});const refs=built.built.context.inputs.filter(r=>r.input==='project-facts');assert.equal(refs.length,1);assert.match(refs[0].id,/^snap_[0-9a-f]{64}$/);
 assert.deepEqual(built.built.snapshots[0].members,[{id:a.id,revision:1},{id:b.id,revision:1}].sort((a,b)=>a.id.localeCompare(b.id)));
 assert.equal(built.built.context.profileRevision,0);assert.deepEqual(built.built.unavailableSources,['readProfile']);assert.deepEqual(built.built.context.tools,{});
 const plan=prepareCareerRun('evidence-story',built.built.context);assert.equal(plan.state,'blocked');if(plan.state==='blocked'){assert(plan.reasons.includes('missing_input:profile'));assert(plan.reasons.includes('tool_unavailable:read_evidence'));}
 const selected=await sources.prepare(who,{skillId:'evidence-story',selection:{projectId:b.id}});assert.equal(selected.built.context.inputs[0].id,b.id);assert.equal(selected.built.context.inputs[0].revision,1);assert.deepEqual(selected.built.snapshots,[]);
 const interview=await sources.prepare(who,{skillId:'interview-practice',selection:{targetId:t.id,projectId:a.id}});assert.deepEqual(interview.built.context.inputs.map(r=>r.id),[t.id,a.id]);assert(!JSON.stringify(interview).includes('PRIVATE_FICTIONAL'));
 const other=await f.actor();const absent=await sources.prepare(other,{skillId:'evidence-story',selection:{projectId:a.id}});assert.deepEqual(absent.built.context.inputs,[]);
});

test('source-coordinate revalidation detects actual edits, privacy changes, withdrawal, delete and target status changes under the consuming transaction',async()=>{
 const who=await f.actor(),p=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 let index=await sources.read(who);
 await f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index)));
 const old=index;await library.mutate(who,'project','confirm',p.id,action(1));
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(old))),error(409));
 index=await sources.read(who);assert.match(index.projects[0].normalSummary,/本人已确认/);assert.equal(index.projects[0].revision,2);
 await library.mutate(who,'project','edit',p.id,project({expectedRevision:2,sensitivity:'restricted'}));assert.deepEqual((await sources.read(who)).projects,[]);
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index))),error(409));
 const q=(await library.mutate(who,'project','create',null,project())).record as CareerProject;index=await sources.read(who);await library.mutate(who,'project','withdraw',q.id,action(1));
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index))),error(409));
 const r=(await library.mutate(who,'project','create',null,project())).record as CareerProject;index=await sources.read(who);await library.mutate(who,'project','delete',r.id,action(1));
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index))),error(409));
 const t=(await targets.mutate(who,'create',null,target())).target!;index=await sources.read(who);await targets.mutate(who,'status',t.id,{...action(1),status:'paused'});
 assert.deepEqual((await sources.read(who)).targets,[]);await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index))),error(409));
});

test('confirmed story is excluded when real source revision, privacy, verification or availability changes, including restoration at a new version',async()=>{
 const who=await f.actor(),p=(await library.mutate(who,'project','create',null,project())).record as CareerProject;
 await library.mutate(who,'project','confirm',p.id,action(1));
 const s=(await library.mutate(who,'story','create',null,story({projects:[{id:p.id,revision:2}]}))).record as CareerStory;
 await library.mutate(who,'story','confirm',s.id,action(1));const index=await sources.read(who);assert.equal(index.stories.length,1);
 await library.mutate(who,'project','edit',p.id,project({expectedRevision:2,sensitivity:'restricted'}));
 assert.deepEqual((await sources.read(who)).stories,[]);assert.equal((await library.get(who,'story',s.id)).evidenceAvailability,'stale');
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,coordinate(index))),error(409));
 await library.mutate(who,'project','edit',p.id,project({expectedRevision:3}));await library.mutate(who,'project','confirm',p.id,action(4));
 assert.deepEqual((await sources.read(who)).stories,[]);
 await library.mutate(who,'story','edit',s.id,story({expectedRevision:2,projects:[{id:p.id,revision:5}]}));await library.mutate(who,'story','confirm',s.id,action(3));assert.equal((await sources.read(who)).stories.length,1);
 await library.mutate(who,'project','withdraw',p.id,action(5));assert.deepEqual((await sources.read(who)).stories,[]);
 await library.mutate(who,'project','confirm',p.id,action(6));assert.deepEqual((await sources.read(who)).stories,[]);
 await library.mutate(who,'project','delete',p.id,action(7));assert.deepEqual((await sources.read(who)).stories,[]);
 const privateStory=(await library.mutate(who,'story','create',null,story({sensitivity:'sensitive'}))).record as CareerStory;await library.mutate(who,'story','confirm',privateStory.id,action(1));assert.deepEqual((await sources.read(who)).stories,[]);
});

test('actual immutable receipt and ciphertext authentication cannot be bypassed by index projection or valid older body restoration',async()=>{
 const who=await f.actor(),p=(await library.mutate(who,'project','create',null,project())).record as CareerProject,row=(await f.db.query('SELECT * FROM platform_career_evidence WHERE id=$1',[p.id])).rows[0];
 await library.mutate(who,'project','edit',p.id,project({expectedRevision:1}));
 await f.db.query('UPDATE platform_career_evidence SET revision=$2,last_operation_id=$3,record_ciphertext=$4,updated_at=$5 WHERE id=$1',[p.id,row.revision,row.last_operation_id,row.record_ciphertext,row.updated_at]);
 await assert.rejects(sources.read(who),error(503));await assert.rejects(sources.prepare(who,{skillId:'evidence-story'}),error(503));
 const other=await f.actor(),q=(await library.mutate(other,'project','create',null,project({sensitivity:'restricted'}))).record as CareerProject;
 await f.db.query("UPDATE platform_career_evidence SET sensitivity='normal' WHERE id=$1",[q.id]);await assert.rejects(sources.read(other),error(503));
});

test('fixed actual student account, consent, session and cancellation govern source reads and revalidation; no index is accepted as a grant',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),index=await sources.read(who);
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,other,coordinate(index))),error(404));await assert.rejects(sources.read(staff),error(403));
 for(const input of [{skillId:'evidence-story',ownerId:other.userId},{skillId:'evidence-story',tools:{read_evidence:'ready'}},{skillId:'not-a-skill'},{skillId:'evidence-story',selection:{projectId:randomUUID(),safety:'L0'}}])await assert.rejects(sources.prepare(who,input),error(400));
 await assert.rejects(f.db.withBoundedTransaction(client=>sources.assertCurrentInTransaction(client,who,{...coordinate(index),leaseToken:'fictional'})),error(400));
 const c=new AbortController();c.abort();await assert.rejects(sources.read(who,c.signal));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(sources.read(who),error(403));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[other.userId]);await assert.rejects(sources.read(other),error(401));
});

test('actual page boundary is not a preparation truncation: every owned normal project participates in deterministic membership',async()=>{
 const who=await f.actor();for(let i=0;i<53;i++)await library.mutate(who,'project','create',null,project());
 assert.equal((await library.list(who,'project')).records.length,50);
 const index=await sources.read(who);assert.equal(index.projects.length,53);assert.equal(new Set(index.projects.map(p=>p.id)).size,53);
 assert.equal((await sources.read(who)).indexId,index.indexId);
 const built=await sources.prepare(who,{skillId:'evidence-story'});assert.equal(built.built.snapshots[0].members.length,53);
});

test('a real session reset during source composition prevents returning an accepted metadata index',async()=>{
 const who=await f.actor(),original=f.db.withBoundedTransaction.bind(f.db);f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client);let reset=false;const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{
   const result=await (query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM platform_career_stories')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);}return result;};return Reflect.get(target,key);}});
  return run(guarded);
 },options);
 try{await assert.rejects(sources.read(who),error(401));}finally{f.db.withBoundedTransaction=original;}
});

test('both maximum-size owned collections are complete within the actual bounded transaction, with no body or private sources in the index',async()=>{
 const who=await f.actor();let reference:CareerProject|null=null;
 for(let i=0;i<500;i++){const p=(await library.mutate(who,'project','create',null,project())).record as CareerProject;if(i===0)reference=(await library.mutate(who,'project','confirm',p.id,action(1))).record as CareerProject;}
 assert(reference);
 for(let i=0;i<500;i++){const s=(await library.mutate(who,'story','create',null,story({projects:[{id:reference.id,revision:reference.revision}]}))).record as CareerStory;await library.mutate(who,'story','confirm',s.id,action(1));}
 const index=await sources.read(who);assert.equal(index.projects.length,500);assert.equal(index.stories.length,500);assert(!JSON.stringify(index).includes('PRIVATE_FICTIONAL'));
 await assert.rejects(library.mutate(who,'project','create',null,project()),error(409));await assert.rejects(library.mutate(who,'story','create',null,story()),error(409));
 const prepared=await sources.prepare(who,{skillId:'evidence-story'});assert.equal(prepared.built.snapshots[0].members.length,500);
});

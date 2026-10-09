import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPrebirthFixture,withPrebirthLoopback,type PrebirthFixture} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {TodaySources} from '../src/today-sources.ts';
import {CompanionDailySettingsService} from '../src/companion-daily-settings.ts';
import {CareerTargets} from '../src/career-targets.ts';
import {CareerStories} from '../src/career-stories.ts';
import {ResumeOriginalReview} from '../src/resume-original-review.ts';
import {ManualJobs} from '../src/manual-jobs.ts';
import {CareerApplications} from '../src/career-applications.ts';
import {CareerInterviews} from '../src/career-interviews.ts';
import {ApiError} from '../src/errors.ts';
import type {FixedSessionContext} from '../src/auth.ts';
let f:PrebirthFixture,settings:CompanionDailySettingsService,targets:CareerTargets,library:CareerStories,resumes:ResumeOriginalReview,jobs:ManualJobs,applications:CareerApplications,interviews:CareerInterviews,sources:TodaySources;
const preferences={timeZone:'America/New_York',morningTime:'09:00',quietStart:'22:30',quietEnd:'08:30',dailyMinutes:90,webAlert:'none' as const};
before(async()=>{f=await createPrebirthFixture();settings=new CompanionDailySettingsService(f.db,f.config,FICTIONAL_LEGAL);targets=new CareerTargets(f.db,f.config,FICTIONAL_LEGAL);library=new CareerStories(f.db,f.config,FICTIONAL_LEGAL);resumes=new ResumeOriginalReview(f.db,f.config,FICTIONAL_LEGAL);jobs=new ManualJobs(f.db,f.config,FICTIONAL_LEGAL);applications=new CareerApplications(f.db,f.config,FICTIONAL_LEGAL,jobs);interviews=new CareerInterviews(f.db,f.config,FICTIONAL_LEGAL,applications);sources=new TodaySources(f.db,{settings,targets,library,resumes,jobs,applications,interviews});});
after(async()=>{await f?.close();});
const operation=(expectedRevision=0)=>({operationId:randomUUID(),expectedRevision});
const error=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
const coord=(v:{ownerId:string;sourceId:string})=>({ownerId:v.ownerId,sourceId:v.sourceId});
async function born(save=true){let who!:FixedSessionContext;await withPrebirthLoopback(async runtime=>{const b=await readyBirth(f,runtime);who=b.ready.who;await b.service.birth(who,b.body,b.key);});if(save)await settings.change(who,{...operation(),companionId:(await settings.read(who)).settings.companionId,preferences});return who;}
const jobInput=()=>({...operation(),employer:'PRIVATE_FICTIONAL_EMPLOYER',title:'PRIVATE_FICTIONAL_ROLE',canonicalUrl:'https://example.invalid/'+randomUUID(),roleFamily:'da',location:'PRIVATE_FICTIONAL_LOCATION',jobText:'PRIVATE_FICTIONAL_JD',privateNote:'PRIVATE_FICTIONAL_NOTE',deadlineAt:'2026-12-10T16:00:00.000Z',deadlineTimeZone:'America/New_York'});
async function job(who:FixedSessionContext){return (await jobs.mutate(who,'create',null,jobInput())).job!;}
async function application(who:FixedSessionContext){const j=await job(who);const a=(await applications.mutate(who,'create',null,{...operation(),jobObservationId:j.id,jobObservationRevision:j.revision,privateNote:'PRIVATE_FICTIONAL_APP_NOTE'})).application!;return {j,a};}
async function interview(who:FixedSessionContext,a:Awaited<ReturnType<typeof application>>['a']){return (await interviews.mutate(who,'create',null,{...operation(),applicationId:a.id,applicationRevision:a.revision,roundType:'sql',startsAt:'2026-12-09T17:00:00.000Z',timeZone:'America/New_York',durationMin:45})).interview!;}
async function resume(who:FixedSessionContext){return (await resumes.mutate(who,'create',null,{...operation(),track:'da',label:'PRIVATE_FICTIONAL_RESUME_LABEL',text:'PRIVATE_FICTIONAL_RESUME_BODY'},'web')).view!;}
const projectInput=(patch:Record<string,unknown>={})=>({...operation(),title:'PRIVATE_FICTIONAL_PROJECT',experienceKind:'course_project',sensitivity:'normal',occurredAt:'2026-08-01T00:00:00.000Z',context:'PRIVATE_FICTIONAL_CONTEXT',contribution:'PRIVATE_FICTIONAL_CONTRIBUTION',outcome:'PRIVATE_FICTIONAL_OUTCOME',...patch});

test('real repositories compose stable owned metadata, preserve missing policy sources and never expose private free text',async()=>{
 const who=await born(),other=await born(),{j,a}=await application(who),i=await interview(who,a),r=await resume(who);
 await application(other);await resume(other);
 const t=(await targets.mutate(who,'create',null,{...operation(),roleFamily:'da',title:'PRIVATE_FICTIONAL_TARGET',locations:['PRIVATE_FICTIONAL_TARGET_LOCATION'],priority:1})).target!;
 const p=(await library.mutate(who,'project','create',null,projectInput())).record!;
 await library.mutate(who,'project','create',null,projectInput({sensitivity:'restricted'}));
 const first=await sources.read(who),second=await sources.read(who);
 assert.equal(first.sourceId,second.sourceId);assert.equal(first.settings.preferences?.timeZone,'America/New_York');
 assert.deepEqual(first.projects,[{id:p.id,revision:1}]);assert.deepEqual(first.targets,[{id:t.id,revision:1,status:'exploring'}]);
 assert.equal(first.reviews[0].id,r.item.id);assert.equal(first.reviews[0].actionable,true);assert.equal(first.reviews[0].sensitivity,'sensitive');assert.equal(first.reviews[0].approvedAt,null);
 assert.equal(first.jobs[0].id,j.id);assert.equal(first.jobs[0].deadlineAt,j.deadlineAt);assert.equal(first.jobs[0].source,'manual');
 assert.equal(first.applications[0].sourceState,'same_revision');assert.equal(first.interviews[0].id,i.id);assert.equal(first.interviews[0].upcoming,true);assert.equal(first.interviews[0].sourceState,'same_revision');
 for(const key of ['companionBehavior','companionOverlays','journeyFocus','dailyHistory','practiceReceipts'] as const)assert.equal(first[key],null);
 const json=JSON.stringify(first);for(const value of ['PRIVATE_FICTIONAL',who.tokenHash,other.userId,'record_ciphertext','canonicalUrl','payloadDigest','commandDigest'])assert(!json.includes(value));
 assert(Object.isFrozen(first));assert(Object.isFrozen(first.interviews));assert(Object.isFrozen(first.interviews[0].application));
 await f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(first)));
});

test('actual review approval, decline and removal invalidate old snapshots without completing a fabricated task',async()=>{
 const who=await born(),r=await resume(who),first=await sources.read(who);
 const approved=(await resumes.mutate(who,'approve',r.item.id,{...operation(1),payloadDigest:r.item.payloadDigest},'web')).view!;
 const second=await sources.read(who);assert.equal(second.reviews[0].actionable,false);assert.equal(second.reviews[0].approvalOperationId,approved.item.approvalOperationId);assert.equal(second.resumes[0].id,approved.item.resumeVersionId);assert.equal(second.practiceReceipts,null);
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(first))),error(409));
 await resumes.mutate(who,'delete',r.item.id,{...operation(approved.item.revision),payloadDigest:approved.item.payloadDigest},'web');
 assert.equal((await sources.read(who)).reviews.length,0);await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(second))),error(409));
 const draft=await resume(who);await resumes.mutate(who,'decline',draft.item.id,{...operation(1),payloadDigest:draft.item.payloadDigest},'web');assert.equal((await sources.read(who)).reviews[0].status,'declined');
});

test('schedule completion is not practice completion; removed or changed linked sources are explicit',async()=>{
 const who=await born(),{j,a}=await application(who),i=await interview(who,a),old=await sources.read(who);
 await applications.mutate(who,'stage',a.id,{...operation(1),stage:'interview'});
 let s=await sources.read(who);assert.equal(s.interviews[0].application.revision,1);assert.equal(s.interviews[0].currentApplication?.revision,2);assert.equal(s.interviews[0].sourceState,'newer_revision');
 await interviews.mutate(who,'status',i.id,{...operation(1),status:'done'});s=await sources.read(who);assert.equal(s.interviews[0].upcoming,false);assert.equal(s.practiceReceipts,null);
 await jobs.mutate(who,'delete',j.id,operation(1));s=await sources.read(who);assert.equal(s.jobs.length,0);assert.equal(s.applications[0].sourceState,'missing');assert.equal(s.applications[0].currentJob,null);
 await applications.mutate(who,'delete',a.id,operation(2));s=await sources.read(who);assert.equal(s.interviews[0].currentApplication,null);assert.equal(s.interviews[0].sourceState,'missing');
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,coord(old))),error(409));
});

test('care restrictions use genuine qualifying events and survive application deletion without exposing rejection text',async()=>{
 const who=await born(),{a}=await application(who);
 await applications.mutate(who,'stage',a.id,{...operation(1),stage:'interview'});
 await applications.mutate(who,'stage',a.id,{...operation(2),stage:'closed',closedReason:'not_advanced'});
 const before=await sources.read(who);assert.equal(before.rejectionWindows.length,1);assert.equal(before.rejectionWindows[0].applicationId,a.id);
 await applications.mutate(who,'delete',a.id,operation(3));const after=await sources.read(who);
 assert.equal(after.applications.length,0);assert.deepEqual(after.rejectionWindows,before.rejectionWindows);assert.equal(after.companionOverlays,null);
 assert(!JSON.stringify(after).includes('PRIVATE_FICTIONAL'));
});

test('collections exceed UI first-page limits and remain complete without truncating to selected tasks',async()=>{
 const who=await born(),{a}=await application(who);
 for(let n=0;n<55;n++){await interview(who,a);await resume(who);}
 const index=await sources.read(who);assert.equal(index.interviews.length,55);assert.equal(index.reviews.length,55);assert.equal(new Set(index.interviews.map(v=>v.id)).size,55);
 assert.equal((await interviews.list(who)).interviews.length,50);assert.equal((await resumes.list(who)).items.length,50);
});

test('prebirth, unset timezone, staff, foreign coordinates, withdrawn admission and revoked sessions remain real gates',async()=>{
 await assert.rejects(sources.read(await f.actor()),error(409));const pending=await born(false);await assert.rejects(sources.read(pending),error(409));await assert.rejects(sources.read(await f.actor(true)),error(403));
 const who=await born(),other=await born(),snapshot=await sources.read(who);
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,other,coord(snapshot))),error(404));
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,{...coord(snapshot),confirmed:true})),error(400));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(sources.read(who),error(403));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[other.userId]);await assert.rejects(sources.read(other),error(401));
});

test('time-derived eligibility changes without mutating expired source rows; local date follows saved timezone across DST',async()=>{
 const who=await born(),{a}=await application(who),i=await interview(who,a),r=await resume(who),original=f.db.withBoundedTransaction.bind(f.db);
 let at='2026-11-01T05:30:00.000Z';
 f.db.withBoundedTransaction=async(run,options)=>original(async c=>run(new Proxy(c,{get(target,key){if(key==='query')return async(sql:any,...args:any[])=>sql==='SELECT clock_timestamp() at'?{rows:[{at:new Date(at)}]}:(target.query as any)(sql,...args);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})),options);
 try{const first=await sources.read(who);assert.equal(first.localDate,'2026-11-01');at='2026-11-01T06:30:00.000Z';assert.equal((await sources.read(who)).sourceId,first.sourceId);at='2026-12-08T15:59:59.000Z';const outside=await sources.read(who);assert.equal(outside.jobs[0].deadlineWithin48Hours,false);at='2026-12-08T16:00:00.000Z';const inside=await sources.read(who);assert.equal(inside.jobs[0].deadlineWithin48Hours,true);assert.notEqual(inside.sourceId,outside.sourceId);at='2026-12-11T06:00:00.000Z';const later=await sources.read(who);assert.equal(later.jobs[0].deadlinePassed,true);assert.equal(later.interviews[0].upcoming,false);assert.equal(later.reviews[0].actionable,false);assert.notEqual(later.sourceId,first.sourceId);
 }finally{f.db.withBoundedTransaction=original;}
 assert.equal((await f.db.query('SELECT status FROM platform_pending_items WHERE id=$1',[r.item.id])).rows[0].status,'pending');assert.equal((await interviews.get(who,i.id)).status,'scheduled');
});

test('authenticated old schedule rollback and late session revocation fail instead of publishing stale metadata',async()=>{
 const who=await born(),{a}=await application(who),i=await interview(who,a),old=(await f.db.query('SELECT * FROM platform_career_interviews WHERE id=$1',[i.id])).rows[0];
 await interviews.mutate(who,'status',i.id,{...operation(1),status:'cancelled'});
 await f.db.query('UPDATE platform_career_interviews SET revision=$2,last_operation_id=$3,status=$4,updated_at=$5,record_ciphertext=$6 WHERE id=$1',[i.id,old.revision,old.last_operation_id,old.status,old.updated_at,old.record_ciphertext]);await assert.rejects(sources.read(who),error(503));
 const fresh=await born(),original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async c=>run(new Proxy(c,{get(target,key){if(key==='query')return async(sql:any,...args:any[])=>{const result=await(target.query as any)(sql,...args);if(typeof sql==='string'&&sql.startsWith('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND care_until'))await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[fresh.userId]);return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})),options);
 try{await assert.rejects(sources.read(fresh),error(401));}finally{f.db.withBoundedTransaction=original;}
 await assert.rejects(sources.read(fresh,AbortSignal.abort()));
});

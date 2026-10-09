import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import type {Database} from '../src/database.ts';import type {PoolClient} from 'pg';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {ManualJobs} from '../src/manual-jobs.ts';import {CareerApplications} from '../src/career-applications.ts';
import {CareerStories} from '../src/career-stories.ts';import {ResumeOriginalReview} from '../src/resume-original-review.ts';
import {exportProductEvents,purgeExpiredProductEvents} from '../src/product-events.ts';
import {readConfig} from '../src/config.ts';import {hashPassword} from '../src/auth.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';import {AccountCoreExport} from '../src/account-core-export.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
before(async()=>{f=await createCompanionNameSafetyFixture();});after(async()=>{await f?.close();});
type Actor=Awaited<ReturnType<typeof f.actor>>;
const command=(expectedRevision=0)=>({operationId:randomUUID(),expectedRevision});
const resume=()=>({...command(),track:'da',label:'PRIVATE_FICTIONAL_LABEL',text:'PRIVATE_FICTIONAL_BODY'});
const star={situation:'PRIVATE_FICTIONAL_CONTEXT',task:'Fictional task',action:'Fictional action',result:'Fictional result'};
const story=(revision=0)=>({...command(revision),title:'PRIVATE_FICTIONAL_TITLE',experienceKind:'course_project',sensitivity:'restricted',english:star,chinese:star,tags:['ownership'],projects:[]});
function services(enabled:boolean|undefined=true,db:Database=f.db){
 const config={...f.config,productEventsEnabled:enabled},jobs=new ManualJobs(db,config,FICTIONAL_LEGAL);
 return {jobs,applications:new CareerApplications(db,config,FICTIONAL_LEGAL,jobs),stories:new CareerStories(db,config,FICTIONAL_LEGAL),resumes:new ResumeOriginalReview(db,config,FICTIONAL_LEGAL)};
}
async function application(who:Actor,s=services()){
 const job=(await s.jobs.mutate(who,'create',null,{...command(),employer:'PRIVATE_FICTIONAL_EMPLOYER',title:'PRIVATE_FICTIONAL_ROLE',canonicalUrl:'https://example.invalid/private',roleFamily:'da',location:'',deadlineAt:null,deadlineTimeZone:null,privateNote:'PRIVATE_FICTIONAL_NOTE',jobText:'PRIVATE_FICTIONAL_JD'})).job!;
 return (await s.applications.mutate(who,'create',null,{...command(),jobObservationId:job.id,jobObservationRevision:job.revision,privateNote:''})).application!;
}
const rows=async(who:Actor)=>(await f.db.query('SELECT * FROM platform_product_events WHERE user_id=$1 ORDER BY occurred_at,id',[who.userId])).rows;

test('collection is explicitly opt-in; enabling it does not backfill a replayed operation',async()=>{
 assert.equal(readConfig({}).productEventsEnabled,false);assert.equal(readConfig({PLATFORM_PRODUCT_EVENTS_ENABLED:'0'}).productEventsEnabled,false);
 assert.equal(readConfig({PLATFORM_PRODUCT_EVENTS_ENABLED:'1'}).productEventsEnabled,true);
 for(const value of ['true','yes',' 1','2'])assert.throws(()=>readConfig({PLATFORM_PRODUCT_EVENTS_ENABLED:value}));
 const who=await f.actor(),s=services(false),a=await application(who,s);
 await s.applications.mutate(who,'stage',a.id,{...command(a.revision),stage:'applied'});
 await s.stories.mutate(who,'story','create',null,story());
 const body=resume();await s.resumes.mutate(who,'create',null,body,'web');assert.equal((await rows(who)).length,0);
 await services().resumes.mutate(who,'create',null,body,'web');assert.equal((await rows(who)).length,0);
});
test('actual stage changes emit once, same-state requests do not, and conflicting/foreign operations leave no event',async()=>{
 const who=await f.actor(),other=await f.actor(),s=services(),a=await application(who,s),body={...command(1),stage:'applied'};
 const results=await Promise.all([s.applications.mutate(who,'stage',a.id,body),s.applications.mutate(who,'stage',a.id,body)]);
 assert.equal(results.filter(x=>x.operation.replayed).length,1);assert.equal((await rows(who)).length,1);
 let v=(await s.applications.mutate(who,'stage',a.id,{...command(2),stage:'applied'})).application!;
 assert.equal((await rows(who)).length,1);
 await assert.rejects(s.applications.mutate(other,'stage',a.id,{...command(v.revision),stage:'interview'}));
 await assert.rejects(s.applications.mutate(who,'stage',a.id,{...body,stage:'interview'}));
 v=(await s.applications.mutate(who,'stage',a.id,{...command(v.revision),stage:'interview'})).application!;
 await s.applications.mutate(who,'stage',a.id,{...command(v.revision),stage:'closed',closedReason:'not_advanced'});
 const events=await rows(who);assert.deepEqual(events.map(r=>r.props),[
 {from_stage:'saved',to_stage:'applied',closed_reason:'none'},{from_stage:'applied',to_stage:'interview',closed_reason:'none'},
 {from_stage:'interview',to_stage:'closed',closed_reason:'not_advanced'}]);assert.equal((await rows(other)).length,0);
 assert(!JSON.stringify(events).includes('PRIVATE_FICTIONAL'));assert(events.every(r=>r.channel==='web'));
});
test('story saves and resume creation come from actual sources, not confirmation clicks or replays',async()=>{
 const who=await f.actor(),s=services(),body=story(),record=(await s.stories.mutate(who,'story','create',null,body)).record!;
 await s.stories.mutate(who,'story','create',null,body);
 const edited=(await s.stories.mutate(who,'story','edit',record.id,story(1))).record!;
 await s.stories.mutate(who,'story','confirm',record.id,command(edited.revision));
 const original=resume(),r=(await s.resumes.mutate(who,'create',null,original,'web')).view!;
 await s.resumes.mutate(who,'create',null,original,'web');
 const approved=(await s.resumes.mutate(who,'approve',r.item.id,{...command(r.item.revision),payloadDigest:r.item.payloadDigest},'web')).view!;
 await s.resumes.mutate(who,'create',null,{...resume(),derivedFromId:approved.item.resumeVersionId},'web');
 const events=await rows(who);assert.deepEqual(events.map(r=>[r.event,r.props]),[
 ['story_saved',{source:'user_entered'}],['story_saved',{source:'user_entered'}],
 ['resume_version_created',{source:'paste'}],['resume_version_created',{source:'derived'}]]);
 assert(!JSON.stringify(events).includes('PRIVATE_FICTIONAL'));
});
test('late session revocation rolls back the actual source, operation and event together',async()=>{
 const who=await f.actor();
 const db={withBoundedTransaction:<T>(run:(c:PoolClient)=>Promise<T>,options:any)=>f.db.withBoundedTransaction(c=>run(new Proxy(c,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('INSERT INTO platform_product_events'))await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
 await assert.rejects(services(true,db).resumes.mutate(who,'create',null,resume(),'web'));
 assert.equal((await rows(who)).length,0);
 for(const table of ['platform_pending_items','platform_pending_item_operations','platform_career_resume_versions'])
  assert.equal((await f.db.query('SELECT user_id FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
});
test('the database independently rejects unknown keys, null enum fields and updates',async()=>{
 const who=await f.actor(),insert=(event:string,props:object)=>f.db.query("INSERT INTO platform_product_events(id,user_id,event,props,channel) VALUES($1,$2,$3,$4,'web')",[randomUUID(),who.userId,event,props]);
 for(const [event,props] of [['story_saved',{source:'user_entered',text:'PRIVATE_FICTIONAL'}],['story_saved',{source:null}],['unknown',{source:'paste'}],
 ['application_stage_changed',{from_stage:null,to_stage:'applied',closed_reason:'none'}],
 ['application_stage_changed',{from_stage:'saved',to_stage:'applied',closed_reason:null}]] as const)await assert.rejects(insert(event,props));
 await services().resumes.mutate(who,'create',null,resume(),'web');await assert.rejects(f.db.query('UPDATE platform_product_events SET occurred_at=clock_timestamp() WHERE user_id=$1',[who.userId]));
 assert.equal((await rows(who)).length,1);
});
test('owner export includes events with no source body and account deletion cascades',async()=>{
 const who=await f.actor(),other=await f.actor(),s=services();
 await s.resumes.mutate(who,'create',null,resume(),'web');await s.resumes.mutate(other,'create',null,resume(),'web');
 for(let n=0;n<101;n++)await s.stories.mutate(who,'story','create',null,story());
 const password='Fictional-product-export-password';await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const proof=(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
 const result=await new AccountCoreExport(f.db,f.config).capture(who,proof);
 assert(result.includedTables.includes('platform_product_events'));assert(!result.remainingTables.includes('platform_product_events'));
 const exported=result.sections.productEvents as {id:string}[];assert.equal(exported.length,102);assert.deepEqual(new Set(exported.map(r=>r.id)),new Set((await rows(who)).map(r=>r.id)));assert(!JSON.stringify(exported).includes('PRIVATE_FICTIONAL'));
 await assert.rejects(f.db.withBoundedTransaction(async c=>{for await(const _ of exportProductEvents(c,{userId:other.userId,tokenHash:who.tokenHash})){};}));
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);assert.equal((await rows(who)).length,0);assert.equal((await rows(other)).length,1);
});
test('retention removes only expired rows in bounded batches, even with collection disabled',async()=>{
 const who=await f.actor();
 await f.db.query(`INSERT INTO platform_product_events(id,user_id,event,props,channel,occurred_at)
 SELECT gen_random_uuid(),$1,'story_saved','{"source":"user_entered"}','web',clock_timestamp()-interval '14 months' FROM generate_series(1,101)`,[who.userId]);
 await f.db.query(`INSERT INTO platform_product_events(id,user_id,event,props,channel,occurred_at)
 VALUES($1,$2,'story_saved','{"source":"user_entered"}','web',clock_timestamp()-interval '12 months')`,[randomUUID(),who.userId]);
 assert.equal(await purgeExpiredProductEvents(f.db),100);assert.equal(await purgeExpiredProductEvents(f.db),1);assert.equal(await purgeExpiredProductEvents(f.db),0);assert.equal((await rows(who)).length,1);
 for(const limit of [0,101,NaN])await assert.rejects(purgeExpiredProductEvents(f.db,limit));await f.db.migrate();
});

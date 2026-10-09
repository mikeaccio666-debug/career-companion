import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountCoreExport } from '../src/account-core-export.ts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { accountExportRows,CAREER_EXPORT_TABLES } from '../src/account-export-rows.ts';
import { CareerTargets } from '../src/career-targets.ts';
import { CareerStories } from '../src/career-stories.ts';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { CareerInterviews } from '../src/career-interviews.ts';
import { CareerIdentityRecords } from '../src/career-identity.ts';
import { hashPassword,type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
let targets:CareerTargets,library:CareerStories,jobs:ManualJobs,apps:CareerApplications,interviews:CareerInterviews,identity:CareerIdentityRecords;
const password='Fictional-career-export-password';
before(async()=>{
  f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);
  targets=new CareerTargets(f.db,f.config,FICTIONAL_LEGAL);library=new CareerStories(f.db,f.config,FICTIONAL_LEGAL);
  jobs=new ManualJobs(f.db,f.config,FICTIONAL_LEGAL);apps=new CareerApplications(f.db,f.config,FICTIONAL_LEGAL,jobs);
  interviews=new CareerInterviews(f.db,f.config,FICTIONAL_LEGAL,apps);identity=new CareerIdentityRecords(f.db,f.config,FICTIONAL_LEGAL);
});
after(async()=>{await f?.close();});
async function actor(){const a=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[a.userId,encoded]);return a;}
const action=(revision:number)=>({operationId:randomUUID(),expectedRevision:revision});
async function proof(a:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(a,{purpose:'account_export',password})).token;}
const capture=async(a:FixedSessionContext,token?:string)=>new AccountCoreExport(f.db,f.config).capture(a,token??await proof(a));
const consumed=async(a:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[a.userId])).rows[0].consumed_at;
const star={situation:'Fictional class',task:'Fictional comparison',action:'Fictional source checks',result:'Fictional feedback'};
const storyBody=(title='Fictional export story')=>({...action(0),title,experienceKind:'course_project',sensitivity:'restricted',english:star,chinese:star,tags:['ownership'],projects:[]});
async function graph(a:FixedSessionContext){
  const target=(await targets.mutate(a,'create',null,{...action(0),roleFamily:'da',title:'Fictional export direction',locations:['Fictional City'],priority:1})).target!;
  const project=(await library.mutate(a,'project','create',null,{...action(0),title:'Fictional export project',experienceKind:'course_project',sensitivity:'restricted',occurredAt:'2026-08-01T00:00:00.000Z',context:'Fictional course assignment',contribution:'Fictional own source comparison',outcome:'Fictional instructor feedback'})).record!;
  const story=(await library.mutate(a,'story','create',null,{...storyBody(),projects:[{id:project.id,revision:1}]})).record!;
  const job=(await jobs.mutate(a,'create',null,{...action(0),employer:'Fictional Export Company',title:'Fictional Analyst',canonicalUrl:'https://example.invalid/jobs/'+randomUUID(),roleFamily:'da',location:'Fictional City',deadlineAt:null,deadlineTimeZone:null,privateNote:'Fictional private job note',jobText:'Fictional role. Sponsorship is available.'})).job!;
  const application=(await apps.mutate(a,'create',null,{...action(0),jobObservationId:job.id,jobObservationRevision:1,privateNote:'Fictional private application note'})).application!;
  const interview=(await interviews.mutate(a,'create',null,{...action(0),applicationId:application.id,applicationRevision:1,roundType:'sql',startsAt:'2026-11-01T05:30:00.000Z',timeZone:'America/New_York',durationMin:45})).interview!;
  const status=(await identity.mutate(a,'create',null,{...action(0),field:'opt_status',value:'Fictional private status',label:null})).record!;
  return {target,project,story,job,application,interview,status};
}

test('all seven career record kinds and their 14 table projections round-trip through the authenticated export',async()=>{
  const a=await actor(),b=await actor(),g=await graph(a),other=await graph(b),token=await proof(a);
  const result=await capture(a,token),s=result.sections;
  for(const [section,record] of [['careerTargets',g.target],['careerProjects',g.project],['careerStories',g.story],['savedJobs',g.job],['careerApplications',g.application],['careerInterviews',g.interview],['careerIdentity',g.status]] as const)
    assert.deepEqual(s[section],[record]);
  for(const section of ['careerTargetOperations','savedJobOperations','careerApplicationOperations','careerApplicationEvents','careerInterviewOperations','careerIdentityOperations'] as const)assert.equal(s[section].length,1);
  assert.equal(s.careerLibraryOperations.length,2);assert.equal(result.includedTables.length,78);
  for(const table of Object.keys(CAREER_EXPORT_TABLES)){assert(result.includedTables.includes(table));assert(!result.remainingTables.includes(table));}
  assert(result.includedTables.includes('platform_conversations'));assert(!result.remainingTables.includes('platform_conversations'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
  const serialized=JSON.stringify(result);
  for(const value of [b.userId,other.job.id,other.story.id,password,encoded,a.tokenHash,token,'acceptedAuthVersion','commandDigest','recordDigest','eventDigest','record_ciphertext','value_ciphertext'])assert(!serialized.includes(value));
  assert.equal((s.careerIdentity[0] as any).sensitivity,'restricted');assert.equal((s.careerProjects[0] as any).verification,'self_reported');
  assert(Object.isFrozen(s.careerStories[0]));
});

test('physical forgetting preserves historical receipts without restoring any deleted career body',async()=>{
  const a=await actor(),g=await graph(a);
  await interviews.mutate(a,'delete',g.interview.id,action(1));await apps.mutate(a,'delete',g.application.id,action(1));
  await jobs.mutate(a,'delete',g.job.id,action(1));await targets.mutate(a,'delete',g.target.id,action(1));
  await library.mutate(a,'story','delete',g.story.id,action(1));await library.mutate(a,'project','delete',g.project.id,action(1));
  await identity.mutate(a,'delete',g.status.id,action(1));
  const {sections:s}=await capture(a);
  for(const key of ['careerTargets','careerProjects','careerStories','savedJobs','careerApplications','careerInterviews','careerIdentity'] as const)assert.equal(s[key].length,0);
  for(const key of ['careerTargetOperations','savedJobOperations','careerApplicationOperations','careerApplicationEvents','careerInterviewOperations','careerIdentityOperations'] as const)assert.equal(s[key].length,2);
  assert.equal(s.careerLibraryOperations.length,4);
  for(const body of ['Fictional export project','Fictional own source comparison','Fictional private job note','Fictional private application note','Fictional private status'])assert(!JSON.stringify(s).includes(body));
});

test('data reads remain available after model admission is withdrawn; foreign proofs cannot expose career or identity fields',async()=>{
  const a=await actor(),b=await actor(),g=await graph(a),token=await proof(a);
  await assert.rejects(capture(b,token));assert.equal(await consumed(a),null);
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[a.userId]);
  const result=await capture(a,token);assert.deepEqual(result.sections.careerIdentity,[g.status]);assert.equal(result.sections.savedJobs.length,1);
});

test('damaged ciphertext in each record kind aborts the entire export and leaves the password proof retryable',async()=>{
  const a=await actor(),g=await graph(a),token=await proof(a);
  for(const [table,column,id] of [
    ['platform_career_targets','record_ciphertext',g.target.id],['platform_career_evidence','record_ciphertext',g.project.id],
    ['platform_career_stories','record_ciphertext',g.story.id],['platform_career_job_observations','record_ciphertext',g.job.id],
    ['platform_career_applications','record_ciphertext',g.application.id],['platform_career_interviews','record_ciphertext',g.interview.id],
    ['platform_career_identity_dates','value_ciphertext',g.status.id],
  ]){
    const original=(await f.db.query(`SELECT ${column} AS cipher FROM ${table} WHERE id=$1`,[id])).rows[0].cipher,broken=Buffer.from(original);broken[broken.length-1]^=1;
    await f.db.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`,[id,broken]);
    try{await assert.rejects(capture(a,token),(e:unknown)=>e instanceof ApiError&&e.status===503);assert.equal(await consumed(a),null);}
    finally{await f.db.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`,[id,original]);}
  }
  assert.equal((await capture(a,token)).sections.careerIdentity.length,1);
});

test('more than one page of full story text and immutable operation history is exported without summary truncation',async()=>{
  const a=await actor(),ids:string[]=[];
  for(let i=0;i<103;i++)ids.push((await library.mutate(a,'story','create',null,storyBody('Fictional export story '+i))).record!.id);
  const target=(await targets.mutate(a,'create',null,{...action(0),roleFamily:'da',title:'Fictional changing direction',locations:[],priority:1})).target!;
  for(let i=0;i<101;i++)await targets.mutate(a,'edit',target.id,{...action(i+1),title:'Fictional revision '+i});
  const {sections:s}=await capture(a);
  assert.equal(s.careerStories.length,103);assert.equal(s.careerLibraryOperations.length,103);assert.equal(s.careerTargetOperations.length,102);
  assert.deepEqual((s.careerStories as any[]).map(r=>r.id).sort(),ids.sort());
  assert((s.careerStories as any[]).every(r=>r.english.action===star.action&&r.chinese.result===star.result));
});

test('an unbound historical receipt cannot be laundered into the export as trusted metadata',async()=>{
  const a=await actor(),g=await graph(a);
  const original=(await f.db.query('SELECT * FROM platform_career_target_operations WHERE user_id=$1',[a.userId])).rows[0];
  await f.db.query(`INSERT INTO platform_career_target_operations(user_id,operation_id,target_id,action,applied_revision,created_at,receipt_ciphertext)
    VALUES($1,$2,$3,'delete',1,$4,$5)`,[a.userId,randomUUID(),randomUUID(),original.created_at,original.receipt_ciphertext]);
  const token=await proof(a);await assert.rejects(capture(a,token),(e:unknown)=>e instanceof ApiError&&e.code==='CAREER_TARGET_STORAGE_UNAVAILABLE');
  assert.equal(await consumed(a),null);assert.equal((await targets.get(a,g.target.id)).id,g.target.id);
});

test('the internal pager rejects unreviewed identifiers before executing SQL',async()=>{
  const a=await actor();
  for(const table of ['platform_users','__proto__','platform_career_targets; SELECT 1']){
    let called=false;
    await assert.rejects((async()=>{for await(const _row of accountExportRows({query:async()=>{called=true;throw new Error('Must not run');}} as any,a.userId,table as any))void _row;})(),(e:unknown)=>e instanceof ApiError&&e.code==='ACCOUNT_EXPORT_TABLE_UNREVIEWED');
    assert.equal(called,false);
  }
});

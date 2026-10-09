import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime,CreateJobInput,JobExecutionResult} from '@companion/platform-contracts';
import {browserDefinitionHash,workflowDefinitionHash} from '@companion/ai-core';
import type {Database} from '../src/database.ts';
import {readConfig} from '../src/config.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {JobService} from '../src/jobs.ts';
import {LocalBlobStorage} from '../src/storage.ts';
import {UploadRemovals} from '../src/upload-removals.ts';
import {createWorkflowTemplate,updateWorkflowTemplate,deleteWorkflowTemplate} from '../src/workflow-templates.ts';
import {applyWorkflowCheckpoint,markWorkflowInterrupted,type WorkflowBinding} from '../src/workflow-checkpoints.ts';
import {applyBrowserCheckpoint,markBrowserInterrupted,type BrowserBinding} from '../src/browser-checkpoints.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,encoded:string,jobs:JobService,storage:LocalBlobStorage;
const password='Fictional-execution-export-password',inputHash='a'.repeat(64);
const forbidden=async():Promise<never>=>{throw Error('No external execution');};
const runtime={capabilities:()=>[
 {id:'workflow',name:'Fictional workflow',enabled:true,keyConfigured:true,capabilities:['workflow'],models:[]},
 {id:'browser',name:'Fictional browser',enabled:true,keyConfigured:true,capabilities:['browser'],models:[],browserActionsEnabled:true},
 {id:'synthetic',name:'Fictional model',enabled:true,keyConfigured:true,capabilities:['chat','speech'],models:['fictional-model']},
 {id:'ark',name:'Fictional async video',enabled:true,keyConfigured:true,capabilities:['video'],models:['fictional-video']}
],executeJob:forbidden,streamChat:forbidden,createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden} as unknown as PlatformProviderRuntime;
before(async()=>{f=await createCompanionNameSafetyFixture();directory=await mkdtemp(path.join(os.tmpdir(),'fictional-execution-export-'));storage=new LocalBlobStorage(directory);encoded=await hashPassword(password);jobs=new JobService(f.db,{...readConfig(),...f.config,workbenchEnabled:true,maxActiveJobs:1000},runtime,storage,undefined,undefined,FICTIONAL_LEGAL);});
after(async()=>{await f?.close();await rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const step={kind:'chat',provider:'synthetic',prompt:'Fictional step {{input}}'};
function workflow(steps:unknown[]=[step,{...step,prompt:'Fictional second {{previous}}'}]):CreateJobInput{return {kind:'workflow',provider:'workflow',prompt:'Fictional workflow input',options:{steps}};}
function browser(total=2):CreateJobInput{return {kind:'browser',provider:'browser',prompt:'Fictional browser input',options:{url:'https://example.invalid/fictional',actions:Array.from({length:total},()=>({type:'scroll',direction:'down',pixels:100}))}};}
// Claim is an isolated lease fixture; subsequent checkpoint writes use the actual
// authorization and persistence services. No external browser/model is started.
async function claimed(who:FixedSessionContext,input=workflow()):Promise<WorkflowBinding>{const r=await jobs.create(who.userId,input);await jobs.decide(who.userId,r.approval.id,'approved');const leaseToken=randomUUID();await f.db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 hour' WHERE id=$1",[r.job.id,leaseToken]);return {authVersion:'0',jobId:r.job.id,userId:who.userId,generation:1,leaseToken,definitionHash:input.kind==='browser'?browserDefinitionHash(r.job):workflowDefinitionHash(r.job),signal:new AbortController().signal};}
async function workflowDone(who:FixedSessionContext,withFile=true){const b=await claimed(who);await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'started',index:0,inputHash,expectedRevision:0});const cp=await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'completed',index:0,inputHash,expectedRevision:1,result:{text:'Fictional retained output 原文',artifacts:withFile?[{name:'fictional.txt',mime:'text/plain',bytes:Buffer.from('Fictional private output')}]:[]}});return {b,cp};}
function observed(completedActions:number):JobExecutionResult{const text='Fictional private page snapshot';return {text,artifacts:[{name:'browser-snapshot.txt',mime:'text/plain',bytes:Buffer.from(text)},{name:'browser-screenshot.png',mime:'image/png',bytes:Buffer.from([137,80,78,71,13,10,26,10,0])},{name:'browser-observation.json',mime:'application/json',bytes:Buffer.from(JSON.stringify({version:1,provenance:'untrusted_page',requestedUrl:'https://example.invalid/fictional',url:'https://example.invalid/fictional',title:'Fictional title',text,completedActions,targets:[]}))}]};}
async function browserEvent(b:BrowserBinding,type:'started'|'completed',index:number,expectedRevision:number){return applyBrowserCheckpoint(f.db,storage,f.crypto,b,{type,index,expectedRevision,definitionHash:b.definitionHash,...(type==='completed'?{result:observed(index+1)}:{})} as any);}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const workflowRead=(sql:string)=>sql.startsWith('SELECT w.job_id AS id'),workflowEvents=(sql:string)=>sql.startsWith('SELECT l.id::text AS id,l.job_id,l.revision,l.generation,l.step_index');
const browserRead=(sql:string)=>sql.startsWith('SELECT b.job_id AS id'),browserEvents=(sql:string)=>sql.startsWith('SELECT l.id::text AS id,l.job_id,l.revision,l.generation,l.action_index');
async function snapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of ['platform_workflow_checkpoints','platform_workflow_step_ledger','platform_browser_checkpoints','platform_browser_action_ledger'])result[table]=(await f.db.query(`SELECT row_to_json(t) FROM ${table} t WHERE job_id IN (SELECT id FROM platform_jobs WHERE user_id=$1) ORDER BY row_to_json(t)::text`,[who.userId])).rows;return result;}

test('actual template create, update and soft deletion export the last saved snapshot including deleted templates',async()=>{
 const who=await actor(),other=await actor(),foreign=await createWorkflowTemplate(f.db,other.userId,{name:'Fictional foreign',steps:[step]});const t=await createWorkflowTemplate(f.db,who.userId,{name:'Fictional original',description:'Fictional description',steps:[step]});await updateWorkflowTemplate(f.db,who.userId,t.id,{revision:1,name:'Fictional revised',description:'Fictional revised description',steps:[step]});await deleteWorkflowTemplate(f.db,who.userId,t.id);
 const data=await capture(who),saved=data.sections.workflowTemplates[0] as any;assert.equal(saved.name,'Fictional revised');assert.equal(saved.revision,2);assert(saved.deletedAt);assert.equal(data.sections.workflowTemplates.length,1);assert(!JSON.stringify(data).includes(foreign.id));assert.equal(data.includedTables.length,102);assert.equal(data.remainingTables.length,62);assert.equal(data.complete,false);
});

test('real workflow completion and interruption preserve full saved text and private file references without resume or file reads',async context=>{
 const who=await actor(),{b,cp}=await workflowDone(who);await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'started',index:1,inputHash:'b'.repeat(64),expectedRevision:2});await f.db.transaction(c=>markWorkflowInterrupted(c,b.jobId,1));await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
 context.mock.method(storage,'get',forbidden);context.mock.method(runtime,'capabilities',()=>{throw Error('No live capability read');});context.mock.method(globalThis,'fetch',forbidden);const before=await snapshot(who),data=await capture(who),saved=data.sections.workflowCheckpoints[0] as any;
 assert.equal(saved.revision,4);assert.equal(saved.steps[0].text,'Fictional retained output 原文');assert.equal(saved.steps[0].textProvenance,'saved_generated_output');assert.equal(saved.steps[0].artifacts[0].attachmentId,cp.steps[0].artifacts![0].attachmentId);assert.equal(saved.steps[0].artifacts[0].availability,'metadata_present');assert.equal(saved.steps[1].state,'uncertain');assert.equal(data.sections.workflowStepEvents.length,4);assert.deepEqual(await snapshot(who),before);assert(!JSON.stringify(data).includes('Fictional private output'));assert(!JSON.stringify(data).includes(b.leaseToken));
});

test('browser completed and interrupted action history agrees with saved progress without recovering private observations',async()=>{
 const who=await actor(),b=await claimed(who,browser());await browserEvent(b,'started',0,0);await browserEvent(b,'completed',0,1);await browserEvent(b,'started',1,2);await f.db.transaction(c=>markBrowserInterrupted(c,b.jobId,1));const before=await snapshot(who),data=await capture(who),saved=data.sections.browserCheckpoints[0] as any;
 assert.equal(saved.completedActions,1);assert.equal(saved.state,'uncertain');assert.equal(saved.revision,4);assert.deepEqual((data.sections.browserActionEvents as any[]).map(r=>r.eventType),['started','completed','started','uncertain']);assert.deepEqual(await snapshot(who),before);assert(!JSON.stringify(data).includes('Fictional private page snapshot'));
});

test('actual removal of a completed workflow file preserves the old reference and does not restore its bytes',async()=>{
 const who=await actor(),{cp}=await workflowDone(who),key=cp.steps[0].artifacts![0].attachmentId;const removal=new UploadRemovals(f.db,f.crypto,storage);await removal.request(who,key,{operationId:randomUUID()});await removal.cleanup(key);
 const saved=(await capture(who)).sections.workflowCheckpoints[0] as any;assert.equal(saved.steps[0].artifacts[0].attachmentId,key);assert.equal(saved.steps[0].artifacts[0].availability,'not_found');assert.equal(saved.steps[0].text,'Fictional retained output 原文');
});

test('unknown step fields, definition changes, missing or duplicate events and fabricated checkpoint progress fail with reusable proof',async()=>{
 const who=await actor();await workflowDone(who,false);const b=await claimed(who,browser(1));await browserEvent(b,'started',0,0);await browserEvent(b,'completed',0,1);const token=await proof(who);
 const cases=[(sql:string,rows:any[])=>{if(workflowRead(sql)&&rows.length)rows[0].steps[0].privateCredentials='fictional-unknown';},(sql:string,rows:any[])=>{if(workflowRead(sql)&&rows.length)rows[0].definition_hash='f'.repeat(64);},(sql:string,rows:any[])=>{if(workflowEvents(sql)&&rows.length)rows.shift();},(sql:string,rows:any[])=>{if(browserEvents(sql)&&rows.length)rows.push(rows[0]);},(sql:string,rows:any[])=>{if(browserRead(sql)&&rows.length)rows[0].next_index=0;},(sql:string,rows:any[])=>{if(workflowEvents(sql)&&rows.length)rows[0].generation=2;}];
 for(const transform of cases){await assert.rejects(new AccountCoreExport(instrument(transform),f.config).capture(who,token),{code:'ACCOUNT_EXECUTION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);}await new AccountCoreExport(f.db,f.config).capture(who,token);
});

test('foreign upload and same-owner wrong-job artifact links reject the whole workflow snapshot',async()=>{
 const who=await actor(),other=await actor(),a=await workflowDone(who),b=await workflowDone(other),key=a.cp.steps[0].artifacts![0].attachmentId,foreign=b.cp.steps[0].artifacts![0].attachmentId,token=await proof(who);
 await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(workflowRead(sql)&&rows.length)rows[0].steps[0].artifacts[0].attachmentId=foreign;}),f.config).capture(who,token),{code:'ACCOUNT_EXECUTION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 const another=await claimed(who);await f.db.query('UPDATE platform_artifacts SET job_id=$2 WHERE upload_id=$1',[key,another.jobId]);await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_EXECUTION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
});

test('105 retained templates and real workflow/browser journals export all pages including removed templates',async()=>{
 const who=await actor();for(let i=0;i<105;i++){const t=await createWorkflowTemplate(f.db,who.userId,{name:'Fictional template '+i,steps:[step]});await deleteWorkflowTemplate(f.db,who.userId,t.id);await workflowDone(who,false);const b=await claimed(who,browser(1));await browserEvent(b,'started',0,0);await f.db.transaction(c=>markBrowserInterrupted(c,b.jobId,1));}
 const queries:string[]=[],data=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));assert.equal(data.sections.workflowTemplates.length,105);assert.equal(data.sections.workflowCheckpoints.length,105);assert.equal(data.sections.workflowStepEvents.length,210);assert.equal(data.sections.browserCheckpoints.length,105);assert.equal(data.sections.browserActionEvents.length,210);assert.equal(queries.filter(workflowRead).length,2);assert.equal(queries.filter(workflowEvents).length,3);assert.equal(queries.filter(browserRead).length,2);assert.equal(queries.filter(browserEvents).length,3);
});

test('bigint event IDs remain exact decimal strings beyond the JavaScript safe-integer range',async()=>{
 await f.db.query("SELECT setval(pg_get_serial_sequence('platform_workflow_step_ledger','id'),9007199254740993,false)");await f.db.query("SELECT setval(pg_get_serial_sequence('platform_browser_action_ledger','id'),9007199254741993,false)");const who=await actor();await workflowDone(who,false);const b=await claimed(who,browser(1));await browserEvent(b,'started',0,0);const data=await capture(who);assert.deepEqual((data.sections.workflowStepEvents as any[]).map(r=>r.id),['9007199254740993','9007199254740994']);assert.equal((data.sections.browserActionEvents[0] as any).id,'9007199254741993');
});

test('actual concurrent interruption leaves a consistent earlier checkpoint and event list in the export',async()=>{
 const who=await actor(),b=await claimed(who,browser(1));await browserEvent(b,'started',0,0);let changed=false;
 const data=await new AccountCoreExport(instrument(async sql=>{if(!changed&&browserRead(sql)){changed=true;await f.db.transaction(c=>markBrowserInterrupted(c,b.jobId,1));}}),f.config).capture(who,await proof(who));assert(changed);assert.equal((data.sections.browserCheckpoints[0] as any).state,'started');assert.equal(data.sections.browserActionEvents.length,1);assert.equal(((await capture(who)).sections.browserCheckpoints[0] as any).state,'uncertain');
});

test('async provider handles are excluded while completed workflow output remains available',async()=>{
 const who=await actor(),b=await claimed(who,workflow([{kind:'video',provider:'ark',prompt:'Fictional video'}])),handle='fictional-private-provider-handle';await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'started',index:0,inputHash,expectedRevision:0});await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'provider_task',index:0,inputHash,expectedRevision:1,providerTaskId:handle});await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'completed',index:0,inputHash,expectedRevision:2,result:{text:'Fictional completed async output',artifacts:[]}});const data=await capture(who);assert.equal((data.sections.workflowCheckpoints[0] as any).steps[0].hasProviderTask,true);assert(!JSON.stringify(data).includes(handle));assert.equal(data.sections.workflowStepEvents.length,3);
});

test('empty histories, abort and capacity failure do not create execution facts or consume the retry proof',async()=>{
 const empty=await capture(await actor());for(const section of ['workflowTemplates','workflowCheckpoints','workflowStepEvents','browserCheckpoints','browserActionEvents'] as const)assert.deepEqual(empty.sections[section],[]);
 const who=await actor();await workflowDone(who,false);const token=await proof(who),abort=new AbortController();await assert.rejects(new AccountCoreExport(instrument(sql=>{if(workflowEvents(sql))abort.abort();}),f.config).capture(who,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await consumed(who),null);await new AccountCoreExport(f.db,f.config).capture(who,token);
});

test('a genuinely retried failed workflow keeps older provider events without turning their handle into current resume authority',async()=>{
 const who=await actor(),b=await claimed(who,workflow([{kind:'video',provider:'ark',prompt:'Fictional retry'}]));await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'started',index:0,inputHash,expectedRevision:0});await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'provider_task',index:0,inputHash,expectedRevision:1,providerTaskId:'fictional-old-handle'});await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'failed',index:0,inputHash,expectedRevision:2,errorCode:'FICTIONAL_FAILED'});
 // Terminal job/lease acknowledgement fixture, followed by real retry/approval.
 await f.db.query("UPDATE platform_jobs SET status='failed',lease_token=NULL,lease_until=NULL WHERE id=$1",[b.jobId]);await jobs.retry(who.userId,b.jobId);const approval=(await f.db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2',[b.jobId])).rows[0];await jobs.decide(who.userId,approval.id,'approved');const leaseToken=randomUUID();await f.db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 hour' WHERE id=$1",[b.jobId,leaseToken]);
 await applyWorkflowCheckpoint(f.db,storage,f.crypto,{...b,generation:2,leaseToken},{type:'started',index:0,inputHash,expectedRevision:3});const data=await capture(who),saved=data.sections.workflowCheckpoints[0] as any;assert.equal(saved.steps[0].state,'started');assert.equal(saved.steps[0].hasProviderTask,false);assert.equal(data.sections.workflowStepEvents.length,4);assert.deepEqual((data.sections.workflowStepEvents as any[]).map(r=>r.generation),[1,1,1,2]);assert(!JSON.stringify(data).includes('fictional-old-handle'));
});

test('actual workflow completion during archive remains outside its earlier saved-state snapshot',async()=>{
 const who=await actor(),b=await claimed(who);await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'started',index:0,inputHash,expectedRevision:0});let changed=false;
 const data=await new AccountCoreExport(instrument(async sql=>{if(!changed&&workflowRead(sql)){changed=true;await applyWorkflowCheckpoint(f.db,storage,f.crypto,b,{type:'completed',index:0,inputHash,expectedRevision:1,result:{text:'Fictional later completion',artifacts:[]}});}}),f.config).capture(who,await proof(who));assert(changed);assert.equal((data.sections.workflowCheckpoints[0] as any).steps[0].state,'started');assert.equal(data.sections.workflowStepEvents.length,1);assert.equal(((await capture(who)).sections.workflowCheckpoints[0] as any).steps[0].text,'Fictional later completion');
});

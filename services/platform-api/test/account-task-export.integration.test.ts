import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime,CreateJobInput} from '@companion/platform-contracts';
import {ProviderError} from '@companion/ai-core';
import type {Database} from '../src/database.ts';
import {readConfig} from '../src/config.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {JobService,processJob} from '../src/jobs.ts';
import {JobOutcomeReviews} from '../src/job-outcome-reviews.ts';
import {LocalBlobStorage} from '../src/storage.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,encoded:string,jobs:JobService,reviews:JobOutcomeReviews,executions=0;
const password='Fictional-task-export-password';
const forbidden=async():Promise<never>=>{throw Error('No external service permitted');};
const runtime={capabilities:()=>[{id:'synthetic',name:'Fictional',enabled:true,keyConfigured:true,capabilities:['image','speech','cli'],models:['fictional-model']}],
 async executeJob(){executions++;throw new ProviderError('COMFYUI_SUBMISSION_UNCERTAIN','Fictional unknown result');},streamChat:forbidden,createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden} as unknown as PlatformProviderRuntime;
before(async()=>{f=await createCompanionNameSafetyFixture();directory=await mkdtemp(path.join(os.tmpdir(),'fictional-task-export-'));encoded=await hashPassword(password);
 jobs=new JobService(f.db,{...readConfig(),...f.config,workbenchEnabled:true,maxActiveJobs:1000},runtime,new LocalBlobStorage(directory),undefined,undefined,FICTIONAL_LEGAL);reviews=new JobOutcomeReviews(f.db);});
after(async()=>{await f?.close();await rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const create=(who:FixedSessionContext,kind:CreateJobInput['kind']='image')=>jobs.create(who.userId,{kind,provider:'synthetic',prompt:'Fictional original task 原文',model:'fictional-model',options:{}});
async function unknown(who:FixedSessionContext){const result=await create(who);await processJob(jobs,result.job.id,1);assert.equal((await jobs.get(who.userId,result.job.id)).status,'uncertain');return result.job.id;}
async function review(who:FixedSessionContext,key:string,note='Fictional observed result'){const page=await reviews.get(who.userId,key);return reviews.save(who.userId,key,{generation:page.currentGeneration,evidenceVersion:page.evidence!.version,expectedRevision:page.latestRevision,requestId:randomUUID(),outcome:'observed_effect',note});}
async function origin(who:FixedSessionContext){const conversationId=randomUUID(),messageId=randomUUID();await f.db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional origin','agent')",[conversationId,who.userId]);
 await f.db.query("INSERT INTO platform_messages(id,conversation_id,role,content,status,lease_until) VALUES($1,$2,'assistant','Fictional origin','streaming',now()+interval '1 hour')",[messageId,conversationId]);await f.db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',now()+interval '1 hour')",[messageId,who.userId]);return {conversationId,messageId,tool:'create_job' as const};}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const jobRead=(sql:string)=>sql.startsWith('SELECT id,user_id,kind,provider,model,prompt,options,attachment_ids,status');
const approvalRead=(sql:string)=>sql.startsWith('SELECT a.id,a.user_id,a.job_id,a.conversation_id,a.tool_name');
const reviewRead=(sql:string)=>sql.startsWith('SELECT id,user_id,job_id,generation,revision,request_id,request_hash');
async function snapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of ['platform_jobs','platform_approvals','platform_conversation_tasks','platform_job_outcome_reviews','platform_job_attempts','platform_job_outbox']){
 const own=['platform_job_attempts','platform_job_outbox'].includes(table)?'job_id IN (SELECT id FROM platform_jobs WHERE user_id=$1)':'user_id=$1';result[table]=(await f.db.query(`SELECT row_to_json(t) FROM ${table} t WHERE ${own} ORDER BY row_to_json(t)::text`,[who.userId])).rows;}return result;}

test('real uncertain execution, human observations and retries preserve old generations without executing or rewriting outcomes',async context=>{
 const who=await actor(),other=await actor(),foreign=(await create(other)).job.id,key=await unknown(who),saved=await review(who,key);await jobs.retry(who.userId,key);
 const current=(await f.db.query("SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2",[key])).rows[0];await jobs.decide(who.userId,current.id,'approved');await processJob(jobs,key,2);await review(who,key,'Fictional second observation');
 const count=executions,before=await snapshot(who);context.mock.method(globalThis,'fetch',forbidden);context.mock.method(jobs,'get',forbidden);context.mock.method(runtime,'capabilities',()=>{throw Error('No live capability lookup');});
 const data=await capture(who),job=data.sections.jobs[0] as any;assert.equal(job.storedStatus,'uncertain');assert.equal(job.generation,2);assert.equal(job.definition.prompt,'Fictional original task 原文');assert.equal(data.sections.jobAttempts.length,2);assert.equal(data.sections.jobDispatches.length,2);
 const history=data.sections.jobOutcomeReviews as any[];assert.equal(history.length,2);assert.equal(history[0].id,saved.record.id);assert(history.every(r=>r.outcome==='observed_effect'&&r.verified===false&&r.provenance==='user_reported'));assert.equal(executions,count);assert.deepEqual(await snapshot(who),before);
 assert.equal(data.includedTables.length,109);assert.equal(data.remainingTables.length,55);assert.equal(data.complete,false);
 for(const secret of [foreign,other.userId,who.tokenHash,encoded,password,'execution_policy','lease_token','provider_task_id','request_hash'])assert(!JSON.stringify(data).includes(secret));assert(Object.isFrozen(job.definition));
});

test('actual approvals retain pending, approved, rejected and expired histories instead of only the current generation',async()=>{
 const who=await actor(),a=await create(who,'cli'),b=await create(who,'cli'),c=await create(who,'cli'),d=await create(who,'cli');
 await jobs.decide(who.userId,b.approval.id,'approved');await jobs.decide(who.userId,c.approval.id,'rejected');
 // Expiration is a retained-state fixture; this test does not run the periodic recovery worker.
 await f.db.query("UPDATE platform_approvals SET status='expired',decided_at=now() WHERE id=$1",[d.approval.id]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
 const data=await capture(who),records=data.sections.jobApprovals as any[];assert.deepEqual(records.map(r=>r.status).sort(),['approved','expired','pending','rejected']);assert.equal(records.find(r=>r.id===a.approval.id).request.definition.prompt,'Fictional original task 原文');assert(records.every(r=>r.request.provenance==='saved_approval_request'));
});

test('server conversation origins retain original generation and disappear on conversation deletion without removing tasks',async()=>{
 const who=await actor(),o=await origin(who),r=await jobs.create(who.userId,{kind:'image',provider:'synthetic',prompt:'Fictional originated task'},o);
 await f.db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[o.messageId]);await f.db.query("UPDATE platform_messages SET status='complete',lease_until=NULL WHERE id=$1",[o.messageId]);
 const first=await capture(who);assert.equal((first.sections.conversationTasks[0] as any).jobId,r.job.id);assert.equal((first.sections.conversationTasks[0] as any).createdGeneration,1);
 await f.db.query('DELETE FROM platform_conversations WHERE id=$1',[o.conversationId]);const second=await capture(who);assert.deepEqual(second.sections.conversationTasks,[]);assert.equal(second.sections.jobs.length,1);
});

test('private execution configuration and remote handles are excluded while cleanup remains unconfirmed',async()=>{
 const who=await actor(),r=await create(who,'cli'),token=randomUUID(),handle=randomUUID();
 await f.db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 hour',provider_task_id=$3,execution_policy=$4 WHERE id=$1",[r.job.id,token,handle,JSON.stringify({credentials:'fictional-private-server-secret',comfyui:{job:{graph:{private:'fictional-server-graph'}}}})]);
 await jobs.cancel(who.userId,r.job.id);const data=await capture(who),saved=data.sections.jobs[0] as any;assert.equal(saved.storedStatus,'cancelled');assert.equal(saved.cleanupPending,true);assert.equal(saved.hasProviderTask,true);
 for(const secret of [token,handle,'fictional-private-server-secret','fictional-server-graph'])assert(!JSON.stringify(data).includes(secret));
});

test('owned attachment references survive removal without restoring file bytes and refuse foreign upload links',async()=>{
 const who=await actor(),other=await actor(),upload=randomUUID(),foreign=randomUUID();
 for(const [key,owner] of [[upload,who.userId],[foreign,other.userId]])await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',1,$3)",[key,owner,randomUUID()]);
 const r=await jobs.create(who.userId,{kind:'cli',provider:'synthetic',prompt:'Fictional attachment',attachmentIds:[upload]});let data=await capture(who);assert.equal(((data.sections.jobs[0] as any).attachments[0]).availability,'metadata_present');
 await f.db.query('DELETE FROM platform_uploads WHERE id=$1',[upload]);data=await capture(who);assert.equal(((data.sections.jobs[0] as any).attachments[0]).availability,'not_found');
 await f.db.query('UPDATE platform_jobs SET attachment_ids=$2 WHERE id=$1',[r.job.id,JSON.stringify([foreign])]);await assert.rejects(capture(who),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});
});

test('own approvals, origins and reviews pointing to foreign jobs or mismatched conversations fail without losing reauthentication',async()=>{
 const who=await actor(),other=await actor(),foreign=await create(other,'cli'),r=await create(who,'cli'),o=await origin(who);await jobs.create(who.userId,{kind:'image',provider:'synthetic',prompt:'Fictional origin'},o);const key=await unknown(who);await review(who,key);const token=await proof(who);
 const cases=[(sql:string,rows:any[])=>{if(approvalRead(sql)&&rows.length)rows[0].job_id=foreign.job.id;},(sql:string,rows:any[])=>{if(reviewRead(sql)&&rows.length)rows[0].job_id=foreign.job.id;},(sql:string,rows:any[])=>{if(sql.startsWith('SELECT t.job_id AS id')&&rows.length)rows[0].conversation_id=randomUUID();}];
 for(const transform of cases){await assert.rejects(new AccountCoreExport(instrument(transform),f.config).capture(who,token),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.jobApprovals.length,1);assert(r.approval);
});

test('unknown approval metadata, invalid status, altered review text, missing revision and fabricated verification fail closed',async()=>{
 const who=await actor();await create(who,'cli');const key=await unknown(who);await review(who,key);await review(who,key,'Fictional revised note');const token=await proof(who);
 const cases=[(sql:string,rows:any[])=>{if(approvalRead(sql)&&rows.length)rows[0].args.privateCredential='fictional-unknown-field';},(sql:string,rows:any[])=>{if(jobRead(sql)&&rows.length)rows[0].status='invented';},
 (sql:string,rows:any[])=>{if(reviewRead(sql)&&rows.length)rows[0].note='Fictional altered text';},(sql:string,rows:any[])=>{if(reviewRead(sql)&&rows.length)rows.shift();},(sql:string,rows:any[])=>{if(reviewRead(sql)&&rows.length)rows[0].verified=true;}];
 for(const transform of cases){await assert.rejects(new AccountCoreExport(instrument(transform),f.config).capture(who,token),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.jobOutcomeReviews.length,2);
});

test('105 real task origins and approvals plus 105 user revisions span all pages and preserve old history',async()=>{
 const who=await actor(),o=await origin(who);for(let i=0;i<105;i++)await jobs.create(who.userId,{kind:'cli',provider:'synthetic',prompt:'Fictional paginated task '+i},o);
 const key=await unknown(who);for(let i=0;i<105;i++)await review(who,key,'Fictional review '+i);
 const queries:string[]=[],data=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));assert.equal(data.sections.jobs.length,106);assert.equal(data.sections.jobApprovals.length,105);assert.equal(data.sections.conversationTasks.length,105);assert.equal(data.sections.jobOutcomeReviews.length,105);assert.equal(queries.filter(jobRead).length,2);assert.equal(queries.filter(approvalRead).length,2);assert.equal(queries.filter(reviewRead).length,2);
});

test('concurrent actual cancellation can commit while the archive keeps the earlier pending approval and task snapshot',async()=>{
 const who=await actor(),r=await create(who,'cli');let changed=false;
 const data=await new AccountCoreExport(instrument(async sql=>{if(!changed&&jobRead(sql)){changed=true;await jobs.cancel(who.userId,r.job.id);}}),f.config).capture(who,await proof(who));
 assert(changed);assert.equal((data.sections.jobs[0] as any).storedStatus,'needs_approval');assert.equal((data.sections.jobApprovals[0] as any).status,'pending');assert.equal((await jobs.get(who.userId,r.job.id)).status,'cancelled');
});

test('empty histories, abort and capacity failure return no invented or partial task archive',async()=>{
 const empty=await capture(await actor());for(const key of ['jobs','jobApprovals','jobAttempts','jobDispatches','conversationTasks','jobOutcomeReviews'] as const)assert.deepEqual(empty.sections[key],[]);
 const who=await actor();await create(who,'cli');const token=await proof(who),abort=new AbortController();await assert.rejects(new AccountCoreExport(instrument(sql=>{if(approvalRead(sql))abort.abort();}),f.config).capture(who,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await consumed(who),null);assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.jobs.length,1);
});

test('retained attempt and dispatch generations cross independent composite and UUID page boundaries',async()=>{
 const who=await actor(),key=await unknown(who);const count=executions;
 // Retained lifecycle fixtures, not 104 real external executions.
 await f.db.query('UPDATE platform_jobs SET generation=105,attempt_count=105 WHERE id=$1',[key]);
 for(let i=2;i<=105;i++){await f.db.query("INSERT INTO platform_job_attempts(id,job_id,generation,attempt,status,provider_task_id,finished_at) VALUES($1,$2,$3,$3,'uncertain',$4,now())",[randomUUID(),key,i,'fictional-provider-handle-'+i]);await f.db.query('INSERT INTO platform_job_outbox(job_id,generation,definition_hash,dispatched_at) VALUES($1,$2,$3,now())',[key,i,'a'.repeat(64)]);}
 const data=await capture(who);assert.equal(data.sections.jobAttempts.length,105);assert.equal(data.sections.jobDispatches.length,105);assert.equal(new Set((data.sections.jobDispatches as any[]).map(r=>r.generation)).size,105);assert.equal(executions,count);assert(!JSON.stringify(data).includes('fictional-provider-handle-'));
});

test('known saved approval metadata exports public relay limits and template bindings without server routing hashes',async()=>{
 const who=await actor(),r=await create(who,'cli'),before=(await f.db.query('SELECT args FROM platform_approvals WHERE id=$1',[r.approval.id])).rows[0].args;
 const args={...before,modelProvider:'openai',modelRelayLimits:{model:'fictional-model',provider:'openai',upstreamHash:'b'.repeat(64),maxRequests:3,maxTokens:4096,dailyTokens:8192,maxOutputTokens:256},executionTemplate:{version:1,hash:'c'.repeat(64)}};
 await f.db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[r.approval.id,JSON.stringify(args)]);
 const data=await capture(who),saved=(data.sections.jobApprovals[0] as any).request;assert.deepEqual(saved.definition.executionTemplate,args.executionTemplate);assert.equal(saved.metadata.modelRelayLimits.maxRequests,3);assert.equal(saved.metadata.modelProvider,'openai');assert(!JSON.stringify(data).includes('b'.repeat(64)));
 const token=await proof(who);for(const invalid of [{...args,modelRelayLimits:{...args.modelRelayLimits,apiKey:'fictional-forbidden-key'}},{...args,executionTemplate:{...args.executionTemplate,graph:{secret:'fictional-private-graph'}}}]){
  await f.db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[r.approval.id,JSON.stringify(invalid)]);await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 }
 await f.db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[r.approval.id,JSON.stringify(before)]);await new AccountCoreExport(f.db,f.config).capture(who,token);
});

test('unsupported conversation-only legacy approvals explicitly fail rather than dropping or leaking unknown payloads',async()=>{
 const who=await actor(),o=await origin(who);await f.db.query("INSERT INTO platform_approvals(id,user_id,conversation_id,tool_name,args) VALUES($1,$2,$3,'fictional-old-tool',$4)",[randomUUID(),who.userId,o.conversationId,JSON.stringify({privateServerField:'fictional-private-value'})]);
 await assert.rejects(capture(who),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
});

test('actual MCP preparation preserves the original arguments after revocation without discovery or RPC during export',async()=>{
 const {mcpSchemaHash}=await import('../src/mcp-config.ts'),{mcpJobInput}=await import('../src/mcp-connections.ts');
 const schema={type:'object',properties:{query:{type:'string'}},additionalProperties:false},schemaHash=mcpSchemaHash(schema);let discoveries=0,calls=0;
 const service=new JobService(f.db,{...readConfig(),...f.config,workbenchEnabled:true,maxActiveJobs:1000,mcp:{entries:[{id:'fictional-task-export',name:'Fictional lookup',url:'https://example.invalid/private-mcp-route',bearerToken:'fictional-mcp-secret',tools:[{name:'lookup',schemaHash}]}],fixtureOrigins:[]}},runtime,new LocalBlobStorage(directory),undefined,{async discover(){discoveries++;return [{name:'lookup',inputSchema:schema}];},async call(){calls++;throw Error('No RPC');}},FICTIONAL_LEGAL);
 const who=await actor(),connection=await service.mcp.connect(who.userId,{catalogId:'fictional-task-export'}),input=mcpJobInput({connectionId:connection.connectionId,grantVersion:connection.grantVersion,toolName:'lookup',schemaHash,arguments:{query:'Fictional original query'},goal:'Fictional lookup goal'});
 await service.create(who.userId,input);await service.mcp.revoke(who.userId,connection.connectionId!,{expectedGrantVersion:connection.grantVersion});const before=discoveries,data=await capture(who),approval=data.sections.jobApprovals[0] as any;
 assert.equal((data.sections.jobs[0] as any).definition.options.arguments.query,'Fictional original query');assert.equal(approval.request.metadata.mcp.connectionId,connection.connectionId);assert.equal(approval.request.metadata.mcp.grantVersion,1);assert.equal(discoveries,before);assert.equal(calls,0);assert(!JSON.stringify(data).includes('fictional-mcp-secret'));assert(!JSON.stringify(data).includes('private-mcp-route'));
});

test('saved plan input provenance keeps historical sources while foreign existing references reject the archive',async()=>{
 const {GoalPlans}=await import('../src/goal-plans.ts');const who=await actor(),other=await actor(),o=await origin(who),plans=new GoalPlans(f.db,jobs,runtime);
 const p=await plans.create(who.userId,o.conversationId,{title:'Fictional source plan',goal:'Fictional goal',steps:[{kind:'agent_turn',title:'Source',instruction:'Fictional source',provider:'synthetic'},{kind:'task',title:'Task',task:{kind:'cli',provider:'synthetic',prompt:'Fictional task'}}]});
 const r=await create(who,'cli'),original=(await f.db.query('SELECT args FROM platform_approvals WHERE id=$1',[r.approval.id])).rows[0].args;
 // Historical metadata fixture; it does not claim an actual resolved model turn.
 const source={source:'analysis_text',fromStep:0,mode:'append',messageId:o.messageId,sha256:'d'.repeat(64),byteSize:17};
 const saved={...original,goalPlanInput:{planId:p.id,revision:1,stepIndex:1,templateHash:'e'.repeat(64),effectiveInputHash:'f'.repeat(64),inputSources:[source]}};
 await f.db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[r.approval.id,JSON.stringify(saved)]);let data=await capture(who),metadata=(data.sections.jobApprovals[0] as any).request.metadata.goalPlanInput;assert.deepEqual(metadata.inputSources,[source]);assert.equal(metadata.references[0].availability,'metadata_present');
 await f.db.query('DELETE FROM platform_messages WHERE id=$1',[o.messageId]);data=await capture(who);metadata=(data.sections.jobApprovals[0] as any).request.metadata.goalPlanInput;assert.equal(metadata.references[0].availability,'not_found');assert.deepEqual(metadata.inputSources,[source]);
 const foreign=await origin(other);saved.goalPlanInput.inputSources=[{...source,messageId:foreign.messageId}];await f.db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[r.approval.id,JSON.stringify(saved)]);await assert.rejects(capture(who),{code:'ACCOUNT_TASK_EXPORT_UNAVAILABLE'});
});

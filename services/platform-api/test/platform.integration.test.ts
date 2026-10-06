import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatInput, CreateJobInput, JobExecutionContext, PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { processJob, recoverInterrupted, TaskQueue, createWorker } from '../src/jobs.ts';
import { acquireRuntimeLease, recoverStaleStreams, withVoiceLease } from '../src/runtime-leases.ts';

const origin='http://localhost:4321',prefix='/api/platform';
const schema=`platform_test_${randomUUID().replaceAll('-','')}`;
const base=readConfig(),admin=new Database(base.databaseUrl);
const testUrl=new URL(base.databaseUrl);testUrl.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(testUrl.toString());
let directory:string,system:Awaited<ReturnType<typeof buildApp>>;
let calls=0,lastContext:JobExecutionContext|undefined,lastChatInput:ChatInput|undefined,registrationCount=0;
let unblock:(()=>void)|undefined,started:(()=>void)|undefined;
const fake:PlatformProviderRuntime={
  capabilities:()=>[{id:'local-test',name:'Synthetic test runtime',keyConfigured:true,enabled:true,capabilities:['chat','agent','image','video','speech','cli','workflow'],models:['synthetic'],envVariables:[]},{id:'browser',name:'Synthetic browser fixture runtime',keyConfigured:true,enabled:true,capabilities:['browser'],models:[],envVariables:[]}],
  async *streamChat(input,context){
    lastChatInput=input;
    if(input.mode==='agent'&&input.messages.at(-1)?.content==='create synthetic browser task'){
      const result=await context?.executeTool?.('create_job',{kind:'browser',provider:'browser',prompt:'Read synthetic page',options:{url:'https://fictional-page.invalid'}});
      yield {type:'tool',name:'create_job',callId:'synthetic-tool',input:{},result};
    }
    yield {type:'delta',text:'Synthetic '};yield {type:'delta',text:'response'};yield {type:'usage',inputTokens:12,outputTokens:3};
  },
  async executeJob(input:CreateJobInput,context:JobExecutionContext){
    calls++;lastContext=context;
    if(input.prompt==='fail')throw new Error('secret-provider-detail-must-not-escape');
    if(input.prompt==='cleanup-unknown')throw new ApiError(503,'CLI_CLEANUP_UNCONFIRMED','Container shutdown could not be confirmed.');
    if(input.prompt==='wait'||input.prompt==='wait-cleanup-unknown'){started?.();await new Promise<void>(resolve=>{unblock=resolve;});}
    if(input.prompt==='wait-cleanup-unknown')throw new ApiError(503,'CLI_CLEANUP_UNCONFIRMED','Container shutdown could not be confirmed.');
    if(input.kind==='video'){await context.onProviderTask?.('synthetic-provider-task');}
    return {artifacts:[{name:'synthetic.txt',mime:'text/plain',bytes:new TextEncoder().encode('Synthetic artifact')}],providerTaskId:input.kind==='video'?'synthetic-provider-task':undefined};
  },
  createVoiceSession:async()=>{throw new ApiError(503,'PROVIDER_UNAVAILABLE','Voice provider is not configured.');},
  transcribe:async()=>({text:'Synthetic transcript'}),
  speech:async()=>({name:'synthetic.wav',mime:'audio/wav',bytes:new Uint8Array([1,2,3])}),
};
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-platform-test-'));
  system=await buildApp({db,config:{...base,databaseUrl:testUrl.toString(),storageDir:directory,queueName:`companion-test-${randomUUID()}`},runtime:fake,enableQueue:false});
});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
async function register(name:string){
  const response=await system.app.inject({method:'POST',url:`${prefix}/auth/register`,remoteAddress:`127.0.0.${++registrationCount}`,headers:{origin},payload:{name,email:`${name.toLowerCase()}-${randomUUID()}@example.invalid`,password:'Synthetic-password-123'}});
  assert.equal(response.statusCode,201,response.body);
  const cookie=response.headers['set-cookie'];assert.equal(typeof cookie,'string');
  assert.match(cookie as string,/HttpOnly/);assert.match(cookie as string,/SameSite=Lax/);
  return {user:response.json().user,cookie:(cookie as string).split(';')[0]};
}
async function request(actor:{cookie:string},method:'GET'|'POST'|'DELETE',url:string,payload?:Record<string,unknown>){return system.app.inject({method,url:prefix+url,headers:{origin,cookie:actor.cookie},payload});}
async function create(actor:{cookie:string},kind='image',prompt='success'){const result=await request(actor,'POST','/jobs',{kind,provider:'local-test',prompt});assert.equal(result.statusCode,201,result.body);return result.json();}

test('real sessions, login, logout, CSRF protection and password storage',async()=>{
  const alice=await register('AuthAlice');
  const stored=await db.query('SELECT password_hash FROM platform_users WHERE id=$1',[alice.user.id]);assert.match(stored.rows[0].password_hash,/^scrypt:/);assert(!stored.rows[0].password_hash.includes('Synthetic-password'));
  assert.equal((await request(alice,'GET','/auth/me')).json().user.id,alice.user.id);
  const bad=await system.app.inject({method:'POST',url:prefix+'/memories',headers:{origin:'https://evil.invalid',cookie:alice.cookie},payload:{content:'must be rejected'}});assert.equal(bad.statusCode,403);
  const wrong=await system.app.inject({method:'POST',url:prefix+'/auth/login',headers:{origin},payload:{email:alice.user.email,password:'incorrect-password'}});assert.equal(wrong.statusCode,401);
  const login=await system.app.inject({method:'POST',url:prefix+'/auth/login',headers:{origin},payload:{email:alice.user.email,password:'Synthetic-password-123'}});assert.equal(login.statusCode,200);
  assert.equal((await request(alice,'POST','/auth/logout')).statusCode,200);
  assert.equal((await request(alice,'GET','/auth/me')).statusCode,401);
});

test('ownership applies to conversations, memories, uploads and message creation',async()=>{
  const alice=await register('OwnerAlice'),bob=await register('OwnerBob');
  const conversation=(await request(alice,'POST','/conversations',{title:'Synthetic project',mode:'companion'})).json().conversation;
  assert.equal((await request(bob,'GET',`/conversations/${conversation.id}`)).statusCode,404);
  assert.equal((await request(bob,'DELETE',`/conversations/${conversation.id}`)).statusCode,404);
  const memory=(await request(alice,'POST','/memories',{content:'Synthetic saved context'})).json().memory;
  assert.equal((await request(bob,'DELETE',`/memories/${memory.id}`)).statusCode,404);assert.equal((await request(bob,'GET','/memories')).json().memories.length,0);
  const boundary='synthetic-boundary';
  const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic document\r\n--${boundary}--\r\n`);
  const upload=await system.app.inject({method:'POST',url:prefix+'/uploads',headers:{origin,cookie:alice.cookie,'content-type':`multipart/form-data; boundary=${boundary}`},payload});assert.equal(upload.statusCode,201,upload.body);
  const attachment=upload.json().attachment;
  assert.equal((await request(bob,'GET',`/uploads/${attachment.id}`)).statusCode,404);
  const forbidden=await request(bob,'POST',`/conversations/${conversation.id}/messages`,{content:'test',provider:'local-test',mode:'chat'});assert.equal(forbidden.statusCode,404);
  const ownConversation=(await request(bob,'POST','/conversations',{})).json().conversation;
  const steal=await request(bob,'POST',`/conversations/${ownConversation.id}/messages`,{content:'test',provider:'local-test',mode:'chat',attachmentIds:[attachment.id]});assert.equal(steal.statusCode,404);
  const chat=await request(alice,'POST',`/conversations/${conversation.id}/messages`,{content:'Synthetic question',provider:'local-test',mode:'companion',attachmentIds:[attachment.id]});assert.equal(chat.statusCode,200);assert.match(chat.body,/event: delta/);assert.match(chat.body,/event: done/);
  const saved=(await request(alice,'GET',`/conversations/${conversation.id}`)).json().messages;assert.equal(saved.length,2);assert.equal(saved[0].role,'user');assert.equal(saved[1].content,'Synthetic response');assert.equal(saved[1].status,'complete');
  assert.equal(saved[0].attachments[0].id,attachment.id);assert.equal(saved[0].attachments[0].name,'synthetic.txt');
  const usage=await db.query('SELECT * FROM platform_usage WHERE user_id=$1',[alice.user.id]);assert.equal(usage.rows[0].input_tokens,12);assert.equal(usage.rows[0].output_tokens,3);assert(!('prompt' in usage.rows[0]));
  const followup=await request(alice,'POST',`/conversations/${conversation.id}/messages`,{content:'Ask about the attached document again',provider:'local-test',mode:'companion'});assert.match(followup.body,/event: done/);
  assert.equal(lastChatInput?.messages[0].attachments?.[0].name,'synthetic.txt');assert.equal(new TextDecoder().decode(lastChatInput?.messages[0].attachments?.[0].bytes),'Synthetic document');assert.equal(lastChatInput?.messages.at(-1)?.attachments?.length,0);
});

test('job approval cannot be bypassed, claims are idempotent, and artifacts are private',async()=>{
  const alice=await register('ApprovalAlice'),bob=await register('ApprovalBob');
  const created=await create(alice,'cli');assert.equal(created.job.status,'needs_approval');assert.equal(created.approval.status,'pending');const before=calls;
  await processJob(system.jobs,created.job.id,1);assert.equal(calls,before);
  assert.equal((await request(bob,'POST',`/approvals/${created.approval.id}/decision`,{decision:'approved'})).statusCode,404);
  const approval=await request(alice,'POST',`/approvals/${created.approval.id}/decision`,{decision:'approved'});assert.equal(approval.statusCode,200);
  await Promise.all([processJob(system.jobs,created.job.id,1),processJob(system.jobs,created.job.id,1)]);assert.equal(calls,before+1);
  const job=(await request(alice,'GET',`/jobs/${created.job.id}`)).json().job;assert.equal(job.status,'succeeded');assert.equal(job.attempt,1);assert.equal(job.artifacts.length,1);
  assert.equal((await request(bob,'GET',`/jobs/${job.id}`)).statusCode,404);
  const url=job.artifacts[0].url;assert.equal((await request(alice,'GET',url.replace(prefix,''))).body,'Synthetic artifact');assert.equal((await request(bob,'GET',url.replace(prefix,''))).statusCode,404);
});

test('only the latest task generation approval can authorize retry execution',async()=>{
  const alice=await register('GenerationAlice'),created=await create(alice,'cli','fail');
  assert.equal((await request(alice,'POST',`/approvals/${created.approval.id}/decision`,{decision:'approved'})).statusCode,200);await processJob(system.jobs,created.job.id,1);
  assert.equal((await request(alice,'POST',`/jobs/${created.job.id}/retry`)).json().job.status,'needs_approval');
  assert.equal((await request(alice,'POST',`/approvals/${created.approval.id}/decision`,{decision:'approved'})).statusCode,409);
  await db.query("UPDATE platform_jobs SET status='queued' WHERE id=$1",[created.job.id]);const before=calls;await processJob(system.jobs,created.job.id,2);assert.equal(calls,before);assert.equal((await system.jobs.get(alice.user.id,created.job.id)).status,'needs_approval');
  const approvals=(await request(alice,'GET','/approvals')).json().approvals;const current=approvals.find((approval:any)=>approval.generation===2);
  assert.equal((await request(alice,'POST',`/approvals/${current.id}/decision`,{decision:'approved'})).statusCode,200);await processJob(system.jobs,created.job.id,2);assert.equal(calls,before+1);
});

test('failure is persisted safely; retries advance generation without fake success',async()=>{
  const alice=await register('FailureAlice'),created=await create(alice,'image','fail');
  await processJob(system.jobs,created.job.id,1);
  let job=(await request(alice,'GET',`/jobs/${created.job.id}`)).json().job;assert.equal(job.status,'failed');assert.equal(job.error.code,'PROVIDER_FAILED');assert(!JSON.stringify(job).includes('secret-provider-detail'));
  const attempts=await db.query('SELECT * FROM platform_job_attempts WHERE job_id=$1',[job.id]);assert.equal(attempts.rows[0].status,'failed');
  const retry=await request(alice,'POST',`/jobs/${job.id}/retry`);assert.equal(retry.statusCode,200);assert.equal(retry.json().job.status,'queued');
  await processJob(system.jobs,job.id,1);assert.equal((await system.jobs.get(alice.user.id,job.id)).attempt,1);
  await processJob(system.jobs,job.id,2);job=(await system.jobs.get(alice.user.id,job.id));assert.equal(job.status,'failed');assert.equal(job.attempt,2);
});

test('cancellation during execution prevents completion and result artifacts',async()=>{
  const alice=await register('CancelAlice'),created=await create(alice,'image','wait');
  const begun=new Promise<void>(resolve=>{started=resolve;});const execution=processJob(system.jobs,created.job.id,1);await begun;
  const cancelled=await request(alice,'POST',`/jobs/${created.job.id}/cancel`);assert.equal(cancelled.json().job.status,'cancelled');unblock?.();await execution;
  const job=await system.jobs.get(alice.user.id,created.job.id);assert.equal(job.status,'cancelled');assert.equal(job.artifacts.length,0);
  const attempt=await db.query('SELECT status FROM platform_job_attempts WHERE job_id=$1',[job.id]);assert.equal(attempt.rows[0].status,'cancelled');started=undefined;unblock=undefined;
});

test('interrupted unknown execution is held for review; known video tasks resume',async()=>{
  const alice=await register('RecoveryAlice'),created=await create(alice);
  await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[created.job.id,randomUUID()]);await recoverInterrupted(system.jobs);
  assert.equal((await system.jobs.get(alice.user.id,created.job.id)).status,'uncertain');
  const retry=await request(alice,'POST',`/jobs/${created.job.id}/retry`);assert.equal(retry.json().job.status,'needs_approval');const before=calls;await processJob(system.jobs,created.job.id,2);assert.equal(calls,before);
  const video=await create(alice,'video');await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,provider_task_id='already-created-task',lease_until=now()-interval '1 second' WHERE id=$1",[video.job.id,randomUUID()]);await recoverInterrupted(system.jobs);await processJob(system.jobs,video.job.id,2);
  assert.equal(lastContext?.previousProviderTaskId,'already-created-task');assert.equal((await system.jobs.get(alice.user.id,video.job.id)).status,'succeeded');
});

test('unconfirmed container cleanup remains uncertain and cannot be retried as an ordinary failure',async()=>{
  const alice=await register('CleanupAlice'),created=await create(alice,'cli','cleanup-unknown');
  assert.equal((await request(alice,'POST',`/approvals/${created.approval.id}/decision`,{decision:'approved'})).statusCode,200);
  await processJob(system.jobs,created.job.id,1);const job=await system.jobs.get(alice.user.id,created.job.id);assert.equal(job.status,'uncertain');assert.equal(job.error?.code,'CLI_CLEANUP_UNCONFIRMED');
  const retry=await request(alice,'POST',`/jobs/${created.job.id}/retry`);assert.equal(retry.statusCode,409);assert.equal(retry.json().error.code,'OPERATOR_REVIEW_REQUIRED');
  const waiting=await create(alice,'cli','wait-cleanup-unknown');await request(alice,'POST',`/approvals/${waiting.approval.id}/decision`,{decision:'approved'});
  const begun=new Promise<void>(resolve=>{started=resolve;});const execution=processJob(system.jobs,waiting.job.id,1);await begun;
  const cancelled=await request(alice,'POST',`/jobs/${waiting.job.id}/cancel`);assert.equal(cancelled.json().job.error.code,'CANCELLATION_PENDING');assert.equal((await request(alice,'POST',`/jobs/${waiting.job.id}/retry`)).statusCode,409);
  unblock?.();await execution;assert.equal((await system.jobs.get(alice.user.id,waiting.job.id)).status,'uncertain');started=undefined;unblock=undefined;
});

test('terminal provider failures restart only after new approval; pending tasks keep their handle',async()=>{
  const alice=await register('TerminalAlice'),created=await create(alice,'video');
  await db.query("UPDATE platform_jobs SET status='failed',provider_task_id='failed-provider-task',error_code='VIDEO_GENERATION_FAILED' WHERE id=$1",[created.job.id]);
  const retry=await request(alice,'POST',`/jobs/${created.job.id}/retry`);assert.equal(retry.json().job.status,'needs_approval');assert.equal(retry.json().job.providerTaskId,undefined);
  const approval=(await request(alice,'GET','/approvals')).json().approvals.find((item:any)=>item.jobId===created.job.id);assert.equal(approval.args.options.newProviderRequest,true);assert.equal(approval.args.options.mayIncurAdditionalCharge,true);
  await request(alice,'POST',`/approvals/${approval.id}/decision`,{decision:'approved'});await processJob(system.jobs,created.job.id,2);assert.equal(lastContext?.previousProviderTaskId,undefined);
  const pending=await create(alice,'video');await db.query("UPDATE platform_jobs SET status='failed',provider_task_id='still-running-task',error_code='PROVIDER_TASK_PENDING' WHERE id=$1",[pending.job.id]);
  const resume=await request(alice,'POST',`/jobs/${pending.job.id}/retry`);assert.equal(resume.json().job.providerTaskId,'still-running-task');assert.equal(resume.json().job.status,'queued');await processJob(system.jobs,pending.job.id,2);assert.equal(lastContext?.previousProviderTaskId,'still-running-task');
});

test('recovery creates a usable current approval for an interrupted approval-gated media task',async()=>{
  const alice=await register('RenewedApprovalAlice'),created=await create(alice,'video');
  await db.query("UPDATE platform_jobs SET status='running',requires_approval=true,provider_task_id='existing-approved-task',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[created.job.id,randomUUID()]);
  await recoverInterrupted(system.jobs);assert.equal((await system.jobs.get(alice.user.id,created.job.id)).status,'needs_approval');
  const approvals=(await request(alice,'GET','/approvals')).json().approvals;const renewed=approvals.find((item:any)=>item.jobId===created.job.id&&item.generation===2);assert.ok(renewed);assert.equal(renewed.args.options.resumeExistingProviderTask,true);
  await request(alice,'POST',`/approvals/${renewed.id}/decision`,{decision:'approved'});await processJob(system.jobs,created.job.id,2);assert.equal(lastContext?.previousProviderTaskId,'existing-approved-task');assert.equal((await system.jobs.get(alice.user.id,created.job.id)).status,'succeeded');
});

test('unconfigured providers fail before acceptance and active task limit is atomic',async()=>{
  const alice=await register('LimitsAlice');
  const missing=await request(alice,'POST','/jobs',{kind:'image',provider:'not-configured',prompt:'Synthetic task'});assert.equal(missing.statusCode,503);
  const results=await Promise.all(Array.from({length:6},()=>request(alice,'POST','/jobs',{kind:'browser',provider:'browser',prompt:'Synthetic task',options:{url:'https://fictional-page.invalid'}})));
  assert.equal(results.filter(result=>result.statusCode===201).length,4);assert.equal(results.filter(result=>result.statusCode===429).length,2);
  assert.equal((await request(alice,'POST','/voice/session',{})).statusCode,503);
});

test('agent tools create approval-gated tasks owned by the current user',async()=>{
  const alice=await register('AgentAlice'),conversation=(await request(alice,'POST','/conversations',{mode:'agent'})).json().conversation;
  const response=await request(alice,'POST',`/conversations/${conversation.id}/messages`,{content:'create synthetic browser task',provider:'local-test',mode:'agent'});assert.match(response.body,/event: approval/);assert.match(response.body,/event: tool/);
  const jobs=await system.jobs.list(alice.user.id);assert.equal(jobs.length,1);assert.equal(jobs[0].status,'needs_approval');
});

test('runtime leases enforce per-user concurrency and expire safely',async()=>{
  const alice=await register('LeaseAlice'),bob=await register('LeaseBob');
  const first=await db.transaction(client=>acquireRuntimeLease(client,alice.user.id,'chat'));
  const second=await db.transaction(client=>acquireRuntimeLease(client,alice.user.id,'chat'));
  const conversation=(await request(alice,'POST','/conversations',{})).json().conversation;
  const blocked=await request(alice,'POST',`/conversations/${conversation.id}/messages`,{content:'Synthetic',mode:'chat',provider:'local-test'});assert.equal(blocked.statusCode,429);
  const bobsLease=await db.transaction(client=>acquireRuntimeLease(client,bob.user.id,'chat'));assert(bobsLease);
  await db.query("UPDATE platform_runtime_leases SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[[first,second]]);
  const accepted=await request(alice,'POST',`/conversations/${conversation.id}/messages`,{content:'Synthetic',mode:'chat',provider:'local-test'});assert.equal(accepted.statusCode,200);
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered:()=>void=()=>{};const begun=new Promise<void>(resolve=>{entered=resolve;});
  const voice=withVoiceLease(db,alice.user.id,async()=>{entered();await gate;return 'done';});await begun;
  await assert.rejects(withVoiceLease(db,alice.user.id,async()=> 'must not execute'),error=>error instanceof ApiError&&error.code==='RUNTIME_CONCURRENCY_LIMIT');
  release();assert.equal(await voice,'done');
  assert.equal((await db.query("SELECT count(*)::integer AS count FROM platform_runtime_leases WHERE user_id=$1 AND kind='voice'",[alice.user.id])).rows[0].count,0);
  const staleId=randomUUID();await db.query("INSERT INTO platform_messages(id,conversation_id,role,status,lease_until) VALUES($1,$2,'assistant','streaming',now()-interval '1 second')",[staleId,conversation.id]);await recoverStaleStreams(db);assert.equal((await db.query('SELECT status FROM platform_messages WHERE id=$1',[staleId])).rows[0].status,'failed');
});

test('real Redis BullMQ dispatch processes the durable PostgreSQL outbox',async()=>{
  const alice=await register('QueueAlice'),created=await create(alice);
  const queue=new TaskQueue(system.jobs),worker=createWorker(system.jobs);
  try{
    await queue.dispatch();
    const deadline=Date.now()+10_000;let job=await system.jobs.get(alice.user.id,created.job.id);
    while(job.status==='queued'||job.status==='running'){if(Date.now()>deadline)assert.fail('BullMQ did not finish within 10 seconds');await new Promise(resolve=>setTimeout(resolve,50));job=await system.jobs.get(alice.user.id,created.job.id);}
    assert.equal(job.status,'succeeded');const outbox=await db.query('SELECT dispatched_at FROM platform_job_outbox WHERE job_id=$1',[created.job.id]);assert(outbox.rows[0].dispatched_at);
  }finally{await worker.close();await queue.queue.obliterate({force:true});await queue.close();}
});

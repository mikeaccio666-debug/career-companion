import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { configuredModelRelayPolicy, createJobModelRelay, type ModelRelayBinding } from '../src/model-relay.ts';
import { JobService, processJob } from '../src/jobs.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { LocalBlobStorage, type BlobStorage } from '../src/storage.ts';
import { createProviderRuntime, ProviderError } from '@companion/ai-core';
import { fakeCodexResponse } from '../../../packages/ai-core/test/fixtures/codex-responses.ts';
import { fileURLToPath } from 'node:url';

const schema=`relay_test_${randomUUID().replaceAll('-','')}`,base=readConfig();
const admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());
const env={PLATFORM_CLI_MODEL_RELAY:'1',PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-relay-key',PLATFORM_CLI_MODEL:'fictional-model',PLATFORM_CLI_RELAY_MAX_OUTPUT_TOKENS:'256'};
const input={model:'fictional-model',input:[{role:'user',content:'Invented local coding task.'}],stream:true};
const error=(code:string)=>(cause:unknown)=>cause instanceof ApiError&&cause.code===code;
function completed(stream=true){const body={status:'completed',output:[],usage:{input_tokens:16,output_tokens:4}};return new Response(stream?`data: ${JSON.stringify({type:'response.created',response:{id:'fictional-response'}})}\n\ndata: ${JSON.stringify({type:'response.completed',response:body})}\n\n`:JSON.stringify(body),{headers:{'Content-Type':stream?'text/event-stream':'application/json','Set-Cookie':'must-not-pass-through'}});}
function fake(fn:(url:string,init:RequestInit)=>Promise<Response>|Response):typeof fetch{return ((url:any,init:RequestInit={})=>fn(String(url),init)) as typeof fetch;}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();});
after(async()=>{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();});
async function seed(userId:string=randomUUID(),policyEnv:NodeJS.ProcessEnv=env):Promise<ModelRelayBinding>{
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[userId,`${userId}@example.invalid`,'Fictional relay user','fictional-unused-password-hash']);
  const jobId=randomUUID(),leaseToken=randomUUID();
  const policy=configuredModelRelayPolicy(policyEnv);
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,requires_approval,lease_token,lease_until,model,execution_policy) VALUES($1,$2,'cli','cli','Fictional fixture','running',true,$3,now()+interval '60 seconds',$4,$5)",[jobId,userId,leaseToken,policy.model,JSON.stringify({modelRelay:policy})]);
  await db.query("INSERT INTO platform_approvals(id,user_id,job_id,tool_name,generation,status,args) VALUES($1,$2,$3,'cli',1,'approved',$4)",[randomUUID(),userId,jobId,JSON.stringify({model:policy.model,modelProvider:policy.provider,modelRelayLimits:policy})]);
  return {userId,jobId,generation:1,leaseToken,signal:new AbortController().signal};
}

test('relay binds every request to current user, approval, generation and live worker lease',async()=>{
  const binding=await seed();let calls=0;const options={env,fetch:fake(()=>{calls++;return completed();})};
  for(const changed of [{userId:randomUUID()},{generation:2},{leaseToken:randomUUID()}]){
    await assert.rejects(createJobModelRelay(db,{...binding,...changed},options)({requestId:randomUUID(),body:input,signal:new AbortController().signal}),error('MODEL_RELAY_AUTH_REVOKED'));
  }
  await db.query("UPDATE platform_approvals SET status='rejected' WHERE job_id=$1",[binding.jobId]);
  await assert.rejects(createJobModelRelay(db,binding,options)({requestId:'no-approval',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_AUTH_REVOKED'));
  await db.query("UPDATE platform_approvals SET status='approved' WHERE job_id=$1",[binding.jobId]);
  await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[binding.jobId]);
  await assert.rejects(createJobModelRelay(db,binding,options)({requestId:'expired-lease',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_AUTH_REVOKED'));assert.equal(calls,0);
});

test('relay fixes upstream route/model and caps output without sharing credentials or response headers',async()=>{
  const binding=await seed();let sent:any;
  const relay=createJobModelRelay(db,binding,{env,fetch:fake((url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer fictional-relay-key');sent=JSON.parse(String(init.body));return completed();})});
  const response=await relay({requestId:'first',body:{...input,store:true,max_output_tokens:99999,service_tier:'priority',metadata:{fictional:'do-not-forward'},client_metadata:{fictional:'also-do-not-forward'}},signal:new AbortController().signal});
  assert.equal(sent.store,false);assert.equal(sent.background,false);assert.equal(sent.max_output_tokens,256);assert.equal(sent.service_tier,'default');assert.equal(sent.metadata,undefined);assert.equal(sent.client_metadata,undefined);assert.equal(sent.safety_identifier.length,64);
  assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('authorization'),null);assert.equal(response.headers.get('cache-control'),'no-store');assert(!(await response.text()).includes('fictional-relay-key'));
  const audit=(await db.query('SELECT * FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows[0];assert.equal(audit.status,'succeeded');assert.equal(audit.input_tokens,16);assert.equal(audit.output_tokens,4);assert(!JSON.stringify(audit).includes('Invented local coding task'));
});

const localEnv={...env,PLATFORM_ALLOW_PROVIDER_CALLS:'0',PLATFORM_CLI_MODEL_PROVIDER:'ollama',PLATFORM_CLI_OLLAMA_BASE_URL:'http://127.0.0.1:23456'};
const localStatus=()=>Response.json({cloud:{disabled:true,source:'env'}});
test('local relay verifies actual cloud-disabled status and forwards native function/namespace Responses without a commercial credential',async()=>{
  const binding=await seed(undefined,localEnv);let statusReads=0,modelCalls=0;
  const tools=[{type:'namespace',name:'functions',tools:[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}}]}];
  const relay=createJobModelRelay(db,binding,{env:localEnv,fetch:fake((url,init)=>{
    assert.equal(new Headers(init.headers).get('authorization'),null);assert.equal(init.redirect,'error');
    if(url==='http://127.0.0.1:23456/api/status'){statusReads++;assert.equal(init.method,undefined);return localStatus();}
    assert.equal(url,'http://127.0.0.1:23456/v1/responses');assert.equal(init.method,'POST');
    const sent=JSON.parse(String(init.body));assert.deepEqual(sent.tools,tools);assert.equal(sent.model,'fictional-model');assert.equal(sent.store,false);
    modelCalls++;return completed();
  })});
  await relay({requestId:'native-local-first',body:{...input,tools},signal:new AbortController().signal});
  await relay({requestId:'native-local-next',body:{...input,tools},signal:new AbortController().signal});
  assert.equal(statusReads,2);assert.equal(modelCalls,2);
  const audits=(await db.query('SELECT provider,status,input_tokens,output_tokens FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows;
  assert.equal(audits.length,2);assert(audits.every(row=>row.provider==='ollama'&&row.status==='succeeded'&&row.input_tokens===16&&row.output_tokens===4));
});
test('local relay rejects missing/false/malformed or oversized cloud state before any model POST',async()=>{
  const binding=await seed(undefined,localEnv);let modelCalls=0;
  const statuses=[()=>Response.json({}),()=>Response.json({cloud:{disabled:false}}),()=>Response.json({cloud:{disabled:'true'}}),()=>new Response('{invalid',{headers:{'content-type':'application/json'}}),()=>Response.json({cloud:{disabled:true},padding:'x'.repeat(17*1024)}),()=>new Response('unavailable',{status:503})];
  for(const status of statuses){
    const relay=createJobModelRelay(db,binding,{env:localEnv,fetch:fake((url)=>{if(url.endsWith('/api/status'))return status();modelCalls++;return completed();})});
    await assert.rejects(relay({requestId:randomUUID(),body:input,signal:new AbortController().signal}),error('MODEL_RELAY_CONFIG_INVALID'));
  }
  assert.equal(modelCalls,0);
  const rows=(await db.query('SELECT status FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows;assert.equal(rows.length,statuses.length);assert(rows.every(row=>row.status==='failed'));
});
test('local relay rejects unsupported custom tools and inputs before status or model requests',async()=>{
  const binding=await seed(undefined,localEnv);let calls=0;
  const relay=createJobModelRelay(db,binding,{env:localEnv,fetch:fake(()=>{calls++;return localStatus();})});
  for(const body of [{...input,tools:[{type:'custom',name:'apply_patch'}]},{...input,tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'apply_patch'}]}]},{...input,input:[{type:'custom_tool_call',name:'apply_patch',input:'fictional'}]},{...input,input:[{type:'custom_tool_call_output',call_id:'fictional',output:'fictional'}]},{...input,tool_choice:{type:'custom',name:'apply_patch'}}])
    await assert.rejects(relay({requestId:randomUUID(),body,signal:new AbortController().signal}),error('MODEL_RELAY_INVALID_REQUEST'));
  assert.equal(calls,0);
});
test('local status streaming is cancelled when the task request aborts, without calling a model',async()=>{
  const binding=await seed(undefined,localEnv),controller=new AbortController();let started!:()=>void,cancelled=false,modelCalls=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const relay=createJobModelRelay(db,binding,{env:localEnv,fetch:fake(url=>{
    if(!url.endsWith('/api/status')){modelCalls++;return completed();}
    return new Response(new ReadableStream<Uint8Array>({start(){started();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
  })});
  const result=relay({requestId:'cancel-status',body:input,signal:controller.signal});await ready;controller.abort();
  await assert.rejects(result,error('MODEL_RELAY_CONFIG_INVALID'));assert(cancelled);assert.equal(modelCalls,0);
});
test('provider/endpoint changes and foreign identity cannot consume a local model request under an existing approval',async()=>{
  const binding=await seed(undefined,localEnv);let calls=0;
  const fetch=fake(()=>{calls++;return localStatus();});
  for(const changedEnv of [{...localEnv,PLATFORM_CLI_OLLAMA_BASE_URL:'http://127.0.0.1:23457'},{...env}])
    await assert.rejects(createJobModelRelay(db,binding,{env:changedEnv,fetch})({requestId:randomUUID(),body:input,signal:new AbortController().signal}),error('MODEL_RELAY_POLICY_CHANGED'));
  await assert.rejects(createJobModelRelay(db,{...binding,userId:randomUUID()},{env:localEnv,fetch})({requestId:'foreign-local',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_AUTH_REVOKED'));
  const commercial=await seed();
  await assert.rejects(createJobModelRelay(db,commercial,{env:localEnv,fetch})({requestId:'commercial-to-local',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_POLICY_CHANGED'));
  assert.equal(calls,0);
});
test('legacy approvals remain bound to the original fixed OpenAI upstream',async()=>{
  const binding=await seed();
  const legacy=configuredModelRelayPolicy(env);delete legacy.provider;delete legacy.upstreamHash;
  await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[binding.jobId,JSON.stringify({modelRelay:legacy})]);
  await db.query('UPDATE platform_approvals SET args=$2 WHERE job_id=$1',[binding.jobId,JSON.stringify({model:'fictional-model',modelProvider:'openai',modelRelayLimits:legacy})]);
  let calls=0;
  await createJobModelRelay(db,binding,{env,fetch:fake((url)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');return completed();})})({requestId:'legacy-commercial',body:input,signal:new AbortController().signal});
  await assert.rejects(createJobModelRelay(db,binding,{env:localEnv,fetch:fake(()=>{calls++;return completed();})})({requestId:'legacy-local-blocked',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_POLICY_CHANGED'));
  assert.equal(calls,1);
});

test('relay rejects hosted tools, remote state, input files and disabled calls before upstream acceptance',async()=>{
  const binding=await seed();let calls=0;
  const relay=createJobModelRelay(db,binding,{env,fetch:fake(()=>{calls++;return completed();})});
  for(const body of [{...input,tools:[{type:'web_search'}]},{...input,tools:[{type:'namespace',name:'n',tools:[{type:'mcp',server_url:'https://example.invalid'}]}]},{...input,previous_response_id:'other-task-id'},{...input,url:'https://elsewhere.invalid'},{...input,model:'costly-override'},{...input,input:[{role:'user',content:[{type:'input_file',file_id:'foreign-file'}]}]}]){
    await assert.rejects(relay({requestId:randomUUID(),body,signal:new AbortController().signal}),error('MODEL_RELAY_INVALID_REQUEST'));
  }
  await assert.rejects(createJobModelRelay(db,binding,{env:{...env,PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:fake(()=>{calls++;return completed();})})({requestId:'disabled',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_DISABLED'));assert.equal(calls,0);
});

test('CLI task approval records the actual server model and durable relay limits',async()=>{
  const binding=await seed();
    const unavailable=async()=>{throw new Error('This fixture must not call a provider.');};
    const runtime:PlatformProviderRuntime={capabilities:()=>[{id:'cli',name:'Fictional CLI',enabled:true,keyConfigured:true,capabilities:['cli'],models:['fictional-model'],envVariables:[]}],streamChat:async function*(){throw new Error('No provider calls');},executeJob:unavailable,createVoiceSession:unavailable,transcribe:unavailable,speech:unavailable};
    const service=new JobService(db,base,runtime,{} as BlobStorage,{env,fetch:fake(()=>{throw new Error('No model calls expected');})});
    await assert.rejects(service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Fictional task',model:'unapproved-model'}),{code:'INVALID_INPUT'});
    const result=await service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Fictional task'});
    assert.equal(result.job.model,'fictional-model');assert.equal(result.approval.args.model,'fictional-model');assert.equal(result.approval.args.modelProvider,'openai');assert.equal(result.approval.args.modelRelayLimits.maxOutputTokens,256);
    const policy=(await db.query('SELECT execution_policy FROM platform_jobs WHERE id=$1',[result.job.id])).rows[0].execution_policy.modelRelay;
    assert.deepEqual(result.approval.args.modelRelayLimits,policy);
});
test('local CLI task approval and outbox bind the configured provider and endpoint fingerprint',async()=>{
  const binding=await seed(undefined,localEnv);
  const unavailable=async()=>{throw new Error('This fixture must not call a provider.');};
  const runtime:PlatformProviderRuntime={capabilities:()=>[{id:'cli',name:'Fictional CLI',enabled:true,keyConfigured:true,capabilities:['cli'],models:['fictional-model'],envVariables:[]}],streamChat:async function*(){throw new Error('No provider calls');},executeJob:unavailable,createVoiceSession:unavailable,transcribe:unavailable,speech:unavailable};
  const service=new JobService(db,base,runtime,{} as BlobStorage,{env:localEnv,fetch:fake(()=>{throw new Error('No model calls expected');})});
  const created=await service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Fictional local task'});
  assert.equal(created.approval.args.modelProvider,'ollama');assert.equal(created.approval.args.modelRelayLimits.provider,'ollama');
  assert.match(created.approval.args.modelRelayLimits.upstreamHash,/^[a-f0-9]{64}$/);
  assert(!JSON.stringify(created.approval.args).includes('http://127.0.0.1'));
  await service.decide(binding.userId,created.approval.id,'approved');
  const row=(await db.query('SELECT status,execution_policy FROM platform_jobs WHERE id=$1',[created.job.id])).rows[0];
  assert.equal(row.status,'queued');assert.deepEqual(row.execution_policy.modelRelay,created.approval.args.modelRelayLimits);
  const outbox=(await db.query('SELECT definition_hash FROM platform_job_outbox WHERE job_id=$1 AND generation=1',[created.job.id])).rows;assert.equal(outbox.length,1);assert.match(outbox[0].definition_hash,/^[a-f0-9]{64}$/);
});

test('relay cannot silently change the approved model or enlarge approved output allowance',async()=>{
  const binding=await seed();let calls=0;
  const options={env:{...env,PLATFORM_CLI_RELAY_MAX_OUTPUT_TOKENS:'8192'},fetch:fake((_url,init)=>{calls++;assert.equal(JSON.parse(String(init.body)).max_output_tokens,256);return completed();})};
  await createJobModelRelay(db,binding,options)({requestId:'old-output-cap',body:input,signal:new AbortController().signal});
  await assert.rejects(createJobModelRelay(db,binding,{env:{...env,PLATFORM_CLI_MODEL:'changed-model'},fetch:fake(()=>{calls++;return completed();})})({requestId:'changed-model',body:{...input,model:'changed-model'},signal:new AbortController().signal}),error('MODEL_RELAY_POLICY_CHANGED'));
  await db.query("UPDATE platform_approvals SET args=jsonb_set(args,'{model}',to_jsonb('forged-model'::text)) WHERE job_id=$1",[binding.jobId]);
  await assert.rejects(createJobModelRelay(db,binding,options)({requestId:'wrong-review',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_POLICY_CHANGED'));assert.equal(calls,1);
});

test('relay budget reservation is atomic and retries cannot reset a task allowance',async()=>{
  const binding=await seed();let calls=0;
  const relay=createJobModelRelay(db,binding,{env:{...env,PLATFORM_CLI_RELAY_MAX_REQUESTS:'1'},fetch:fake(()=>{calls++;return completed();})});
  const attempts=await Promise.allSettled(['one','two'].map(requestId=>relay({requestId,body:input,signal:new AbortController().signal})));
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(attempts.filter(result=>result.status==='rejected'&&error('MODEL_RELAY_BUDGET_LIMIT')(result.reason)).length,1);
  const accepted=(await db.query('SELECT request_id FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows[0].request_id;
  await assert.rejects(relay({requestId:accepted,body:input,signal:new AbortController().signal}),error('MODEL_RELAY_DUPLICATE'));
  await db.query('UPDATE platform_jobs SET generation=2 WHERE id=$1',[binding.jobId]);
  await db.query("INSERT INTO platform_approvals(id,user_id,job_id,tool_name,generation,status,args) VALUES($1,$2,$3,'cli',2,'approved',$4)",[randomUUID(),binding.userId,binding.jobId,JSON.stringify({model:'fictional-model',modelProvider:'openai',modelRelayLimits:configuredModelRelayPolicy(env)})]);
  await assert.rejects(createJobModelRelay(db,{...binding,generation:2},{env:{...env,PLATFORM_CLI_RELAY_MAX_REQUESTS:'1'},fetch:fake(()=>{calls++;return completed();})})({requestId:'new-attempt',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_BUDGET_LIMIT'));assert.equal(calls,1);
});

test('relay daily allowance spans tasks and failed calls retain their reservation',async()=>{
  const binding=await seed(),other=await seed(binding.userId);let calls=0;
  const options={env:{...env,PLATFORM_CLI_RELAY_DAILY_TOKENS:'4096'},fetch:fake(()=>{calls++;return new Response('fictional-upstream-secret',{status:401});})};
  for(const [current,id] of [[binding,'first'],[other,'second']] as const)await assert.rejects(createJobModelRelay(db,current,options)({requestId:id,body:input,signal:new AbortController().signal}),error('MODEL_RELAY_PROVIDER_REJECTED'));
  await assert.rejects(createJobModelRelay(db,other,options)({requestId:'third',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_BUDGET_LIMIT'));assert.equal(calls,2);
  const rows=(await db.query('SELECT * FROM platform_model_relay_requests WHERE user_id=$1',[binding.userId])).rows;assert(rows.every(row=>row.status==='failed'));assert(!JSON.stringify(rows).includes('fictional-upstream-secret'));
});

test('relay detects incomplete/invalid usage and bounds provider output before returning bytes',async()=>{
  const binding=await seed();
  const cases=[{response:()=>new Response('data: {"type":"response.created"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),code:'MODEL_RELAY_UNCERTAIN'},
    {response:()=>new Response('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":9999}}}\n\n',{headers:{'Content-Type':'text/event-stream'}}),code:'MODEL_RELAY_USAGE_INVALID'},
    {response:()=>new Response('fictional',{headers:{'Content-Type':'text/event-stream','Content-Length':String(9*1024*1024)}}),code:'MODEL_RELAY_OUTPUT_LIMIT'},
    {response:()=>new Response('data: {"type":"error","message":"fictional-secret-detail"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),code:'MODEL_RELAY_PROVIDER_FAILED'}];
  for(const entry of cases){await assert.rejects(createJobModelRelay(db,binding,{env,fetch:fake(entry.response)})({requestId:randomUUID(),body:input,signal:new AbortController().signal}),error(entry.code));}
  const rows=(await db.query('SELECT * FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows;assert.equal(rows.length,4);assert(rows.every(row=>row.status==='uncertain'));assert(!JSON.stringify(rows).includes('fictional-secret-detail'));
});

test('provider server errors retain uncertain state and their budget reservation',async()=>{
  const binding=await seed();
  await assert.rejects(createJobModelRelay(db,binding,{env,fetch:fake(()=>new Response('fictional-private-detail',{status:503}))})({requestId:'provider-503',body:input,signal:new AbortController().signal}),error('MODEL_RELAY_UNCERTAIN'));
  const audit=(await db.query('SELECT * FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows[0];assert.equal(audit.status,'uncertain');assert(audit.reserved_tokens>0);assert(!JSON.stringify(audit).includes('fictional-private-detail'));
});

test('worker retains a relay provider uncertainty instead of publishing successful job artifacts',async()=>{
  const binding=await seed(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-relay-worker-'));
  const unavailable=async()=>{throw new Error('Unused synthetic provider');};
  const runtime:PlatformProviderRuntime={capabilities:()=>[{id:'cli',name:'Fictional CLI',enabled:true,keyConfigured:true,capabilities:['cli'],models:['fictional-model'],envVariables:[]}],streamChat:async function*(){throw new Error('Unused');},createVoiceSession:unavailable,transcribe:unavailable,speech:unavailable,
    executeJob:async(_input,context)=>{assert(context.requestModel);await context.requestModel({requestId:'worker-request',body:input,signal:new AbortController().signal});return {artifacts:[{name:'must-not-publish.txt',mime:'text/plain',bytes:new TextEncoder().encode('Fictional result')}]};}};
  const service=new JobService(db,{...base,storageDir:directory},runtime,{} as BlobStorage,{env,fetch:fake(()=>new Response('fictional-private-error',{status:503}))});
  try{
    const created=await service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Fictional worker task'});await service.decide(binding.userId,created.approval.id,'approved');
    await processJob(service,created.job.id,1);
    const result=await service.get(binding.userId,created.job.id);assert.equal(result.status,'uncertain');assert.equal(result.error?.code,'MODEL_RELAY_UNCERTAIN');assert.equal(result.artifacts.length,0);
    const attempt=(await db.query('SELECT status FROM platform_job_attempts WHERE job_id=$1',[created.job.id])).rows[0];assert.equal(attempt.status,'uncertain');
    const retry=await service.retry(binding.userId,created.job.id);assert.equal(retry.status,'needs_approval');
    const approvals=(await db.query('SELECT args,status FROM platform_approvals WHERE job_id=$1 AND generation=2',[created.job.id])).rows;assert.equal(approvals[0].status,'pending');assert.equal(approvals[0].args.modelRelayLimits.model,'fictional-model');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('relay aborts an in-flight model request when cancellation revokes the database lease',async()=>{
  const binding=await seed();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let aborted=false;
  const relay=createJobModelRelay(db,binding,{env,fetch:fake((_url,init)=>new Promise<Response>((_resolve,reject)=>{started();init.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('fictional interruption'));},{once:true});}))});
  const running=relay({requestId:'cancel-live',body:input,signal:new AbortController().signal});await ready;
  await db.query("UPDATE platform_jobs SET status='cancelled' WHERE id=$1",[binding.jobId]);
  await assert.rejects(running,error('MODEL_RELAY_UNCERTAIN'));assert(aborted);
  const audit=(await db.query('SELECT status FROM platform_model_relay_requests WHERE job_id=$1',[binding.jobId])).rows[0];assert.equal(audit.status,'uncertain');
});

test('worker requires review when relay settlement is missing or its result is explicitly uncertain',async()=>{
  const binding=await seed(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-relay-settlement-'));
  const unavailable=async()=>{throw new Error('Unused synthetic provider');};
  let auditStatus:string|undefined,returnArtifact=false;
  const runtime:PlatformProviderRuntime={capabilities:()=>[{id:'cli',name:'Fictional CLI',enabled:true,keyConfigured:true,capabilities:['cli'],models:['fictional-model'],envVariables:[]}],streamChat:async function*(){throw new Error('Unused');},createVoiceSession:unavailable,transcribe:unavailable,speech:unavailable,
    executeJob:async(_input,context)=>{
      if(auditStatus)await db.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,model,reserved_tokens,status) VALUES($1,$2,$3,1,'pending-fixture','fictional-model',2048,$4)",[randomUUID(),binding.userId,context.jobId,auditStatus]);
      if(returnArtifact)return {artifacts:[{name:'must-not-publish.txt',mime:'text/plain',bytes:new TextEncoder().encode('Fictional unconfirmed result')}]};
      throw new ProviderError(auditStatus?'CLI_RELAY_PROTOCOL':'MODEL_RELAY_UNCERTAIN','Synthetic settlement requires review.',502);
    }};
  const storage=new Map<string,Uint8Array>();
  const service=new JobService(db,{...base,storageDir:directory},runtime,{put:async(key,bytes)=>{storage.set(key,bytes);},get:async key=>storage.get(key)!,delete:async key=>{storage.delete(key);},stat:async()=>{throw new Error('Metadata reads are unused by this settlement fixture');},openRead:async()=>{throw new Error('Streaming reads are unused by this settlement fixture');}},{env});
  try{
    for(const scenario of [{status:undefined,returns:false},{status:'reserved',returns:false},{status:'reserved',returns:true},{status:'uncertain',returns:true}]){
      auditStatus=scenario.status;returnArtifact=scenario.returns;
      const created=await service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Fictional pending settlement'});await service.decide(binding.userId,created.approval.id,'approved');
      await processJob(service,created.job.id,1);
      const result=await service.get(binding.userId,created.job.id);assert.equal(result.status,'uncertain');assert.equal(result.artifacts.length,0);
      assert.equal(storage.size,0,'an unconfirmed result must not retain unpublished blobs');
      const attempt=(await db.query('SELECT status FROM platform_job_attempts WHERE job_id=$1',[created.job.id])).rows[0];assert.equal(attempt.status,'uncertain');
      const retry=await service.retry(binding.userId,created.job.id);assert.equal(retry.status,'needs_approval');
      await service.cancel(binding.userId,retry.id);
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('approved platform job reaches official disconnected Codex through the audited broker and stores its actual file',{
  skip:process.env.PLATFORM_TEST_REAL_HARNESS!=='1'||process.env.PLATFORM_TEST_CLI_EXTERNAL_SANDBOX!=='1',timeout:60_000,
},async()=>{
  const parent=fileURLToPath(new URL('../../../.local/harness-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true,mode:0o700});
  const directory=await fs.mkdtemp(path.join(parent,'fictional-platform-codex-')),binding=await seed();
  let turns=0;
  const fixtureEnv={...process.env,...env,PLATFORM_CLI_MODEL:'fixture-model',PLATFORM_CLI_RELAY_MAX_TOKENS:'262144',PLATFORM_ENABLE_CLI:'1',PLATFORM_CLI_IMAGE:'companion-codex-relay:local',PLATFORM_CLI_MODEL_RELAY:'1',PLATFORM_CLI_NETWORK:'none',PLATFORM_CLI_EXTERNAL_SANDBOX:'1',PLATFORM_CLI_TIMEOUT_MS:'45000',
    PLATFORM_CLI_COMMAND:JSON.stringify(['codex','exec','--json','--skip-git-repo-check','--sandbox','danger-full-access','--ephemeral','-'])};
  const runtime=createProviderRuntime({env:fixtureEnv,fetch:fake(()=>{throw new Error('No direct provider access is permitted in this fixture.');})});
  const service=new JobService(db,{...base,storageDir:directory},runtime,new LocalBlobStorage(directory),{env:fixtureEnv,fetch:fake((url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(String(init.body));
    assert.equal(body.model,'fixture-model');assert.equal(body.store,false);assert.equal(body.client_metadata,undefined);assert.equal(body.max_output_tokens,256);
    turns++;return fakeCodexResponse(body,turns);
  })});
  try{
    const created=await service.create(binding.userId,{kind:'cli',provider:'cli',prompt:'Create fixture.ts containing one synthetic exported constant.'});
    assert.equal(created.job.status,'needs_approval');assert.equal(turns,0);
    await service.decide(binding.userId,created.approval.id,'approved');await processJob(service,created.job.id,1);
    const result=await service.get(binding.userId,created.job.id);assert.equal(result.status,'succeeded',result.error?.code);assert(turns>=2);
    const artifact=result.artifacts.find(item=>item.name.endsWith('fixture.ts'));assert(artifact,'successful job must publish the actual file');
    const saved=await db.query('SELECT u.storage_key FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1 AND a.user_id=$2',[artifact.id,binding.userId]);
    assert.equal(Buffer.from(await service.storage.get(saved.rows[0].storage_key)).toString(),'export const synthetic = 42;\n');
    const audits=(await db.query('SELECT * FROM platform_model_relay_requests WHERE job_id=$1',[created.job.id])).rows;
    assert.equal(audits.length,turns);assert(audits.every(row=>row.status==='succeeded'&&row.model==='fixture-model'&&row.input_tokens===32));
    assert(!JSON.stringify(audits).includes('Create fixture.ts'));assert(!JSON.stringify(audits).includes('fictional-relay-key'));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

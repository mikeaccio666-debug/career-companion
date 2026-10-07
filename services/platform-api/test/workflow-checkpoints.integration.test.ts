import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateJobInput, JobExecutionContext, JobExecutionResult, PlatformProviderRuntime, WorkflowCheckpoint, WorkflowStep } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError, workflowDefinitionHash, workflowHash } from '@companion/ai-core';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { JobService, processJob, recoverInterrupted } from '../src/jobs.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { applyWorkflowCheckpoint, loadWorkflowCheckpoint, readWorkflowArtifact, type WorkflowBinding } from '../src/workflow-checkpoints.ts';

const schema=`workflow_checkpoints_test_${randomUUID().replaceAll('-','')}`,config=readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' }),admin=new Database(config.databaseUrl),url=new URL(config.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());let directory:string,storage:LocalBlobStorage,jobs:JobService;
let execute:(input:CreateJobInput,context:JobExecutionContext)=>Promise<JobExecutionResult>=async()=>({artifacts:[]});
const unused=async()=>{throw new Error('No commercial model calls are permitted in checkpoint fixtures.');};
const runtime:PlatformProviderRuntime={capabilities:()=>[
  {id:'workflow',name:'Synthetic workflow',enabled:true,keyConfigured:true,capabilities:['workflow'],models:[],envVariables:[]},
  {id:'synthetic',name:'Synthetic models',enabled:true,keyConfigured:true,capabilities:['chat','image','speech'],models:['synthetic-chat','synthetic-image'],modelsByCapability:{chat:['synthetic-chat'],image:['synthetic-image'],speech:['synthetic-speech']},envVariables:[]},
  {id:'ark',name:'Synthetic async video',enabled:true,keyConfigured:true,capabilities:['chat','video'],models:['synthetic-chat','synthetic-video'],modelsByCapability:{chat:['synthetic-chat'],video:['synthetic-video']},envVariables:[]},
  {id:'comfyui',name:'Synthetic configured workflow',enabled:true,keyConfigured:true,capabilities:['image'],models:[],envVariables:[]},
],streamChat:async function*(){throw new Error('Unused');},executeJob:(input,context)=>execute(input,context),createVoiceSession:unused,transcribe:unused,speech:unused};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-checkpoint-fixtures-'));const template=path.join(directory,'synthetic-template.json');await fs.writeFile(template,JSON.stringify({'1':{class_type:'SyntheticText',inputs:{text:'Synthetic template text'}}}));const comfy=createProviderRuntime({env:{COMFYUI_BASE_URL:'http://127.0.0.1:8188',COMFYUI_WORKFLOW_TEMPLATE:template,COMFYUI_PROMPT_NODE:'1',COMFYUI_OUTPUT_KIND:'image'},fetch:unused});runtime.captureComfyUITemplate=comfy.captureComfyUITemplate;runtime.validateComfyUITemplate=comfy.validateComfyUITemplate;storage=new LocalBlobStorage(directory);jobs=new JobService(db,{...config,storageDir:directory},runtime,storage);});
after(async()=>{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
const code=(expected:string)=>(cause:unknown)=>cause instanceof ApiError&&cause.code===expected;
async function user(){const id=randomUUID();await db.query("INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,'Synthetic workflow tester','fictional-not-used')",[id,`workflow-${id}@example.invalid`]);return id;}
function input(steps:unknown[]=[{kind:'chat',provider:'synthetic',prompt:'Draft {{input}}'},{kind:'image',provider:'synthetic',prompt:'Draw {{previous}}'}]):CreateJobInput{return {kind:'workflow',provider:'workflow',prompt:'Fictional input only',options:{steps}};}
async function created(uid?:string,definition=input()){const userId=uid??await user(),result=await jobs.create(userId,definition);await jobs.decide(userId,result.approval.id,'approved');return {userId,...result};}
async function claim(item:Awaited<ReturnType<typeof created>>,generation=1):Promise<WorkflowBinding>{const leaseToken=randomUUID();await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",[item.job.id,leaseToken]);return {jobId:item.job.id,userId:item.userId,generation,leaseToken,definitionHash:workflowDefinitionHash(item.job),signal:new AbortController().signal};}
const result=(text='Synthetic completed output'):JobExecutionResult=>({text,artifacts:[{name:'step.txt',mime:'text/plain',bytes:new TextEncoder().encode(text)}]});

test('creation freezes capability-specific models, definitions and approval and rejects invalid direct plans',async()=>{
  const uid=await user(),item=await created(uid),steps=item.job.options!.steps as WorkflowStep[];assert.equal(steps[0].model,'synthetic-chat');assert.equal(steps[1].model,'synthetic-image');assert.equal(item.approval.args.workflowDefinitionHash,workflowDefinitionHash(item.job));
  const comfy=await jobs.create(uid,input([{kind:'image',provider:'comfyui',prompt:'Synthetic local image'}]));assert.equal((comfy.job.options!.steps as WorkflowStep[])[0].model,undefined);
  const speech=await jobs.create(uid,input([{kind:'speech',provider:'synthetic',prompt:'Synthetic spoken draft',options:{voice:'marin'}}]));assert.equal((speech.job.options!.steps as WorkflowStep[])[0].model,'synthetic-speech');assert.deepEqual((speech.job.options!.steps as WorkflowStep[])[0].options,{voice:'marin'});
  await assert.rejects(jobs.create(uid,input([{kind:'chat',provider:'synthetic',prompt:'Synthetic input',options:{apiKey:'fictional-key'}}])),code('INVALID_INPUT'));
  await assert.rejects(jobs.create(uid,input([{kind:'image',provider:'synthetic',prompt:'Synthetic input',referenceImages:[{fromStep:0}]}])),code('INVALID_INPUT'));
  const unavailable=new JobService(db,{...config,storageDir:directory},{...runtime,capabilities:()=>runtime.capabilities().map(provider=>provider.id==='ark'?{...provider,modelsByCapability:{chat:['synthetic-chat'],video:[]},models:['synthetic-chat']}:provider)},storage);
  await assert.rejects(unavailable.create(uid,input([{kind:'video',provider:'ark',prompt:'Synthetic video'}])),code('INVALID_INPUT'));
});

test('checkpoint transitions require owner, approval, generation, active lease, plan hash and revision',async()=>{
  const item=await created(),binding=await claim(item),hash=workflowHash({synthetic:'step-input'});
  for(const changed of [{userId:randomUUID()},{generation:2},{leaseToken:randomUUID()}])await assert.rejects(loadWorkflowCheckpoint(db,{...binding,...changed}),code('WORKFLOW_AUTH_REVOKED'));
  await assert.rejects(loadWorkflowCheckpoint(db,{...binding,definitionHash:'0'.repeat(64)}),code('WORKFLOW_DEFINITION_CHANGED'));
  await db.query("UPDATE platform_approvals SET args=jsonb_set(args,'{workflowDefinitionHash}',to_jsonb('forged'::text)) WHERE job_id=$1",[binding.jobId]);await assert.rejects(loadWorkflowCheckpoint(db,binding),code('WORKFLOW_AUTH_REVOKED'));await db.query("UPDATE platform_approvals SET args=jsonb_set(args,'{workflowDefinitionHash}',to_jsonb($2::text)) WHERE job_id=$1",[binding.jobId,binding.definitionHash]);
  await assert.rejects(applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:1,inputHash:hash,expectedRevision:0}),code('WORKFLOW_STEP_ORDER'));
  const events=await Promise.allSettled([0,1].map(()=>applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:0})));assert.equal(events.filter(event=>event.status==='fulfilled').length,1);assert.equal(events.filter(event=>event.status==='rejected'&&code('WORKFLOW_CHECKPOINT_CONFLICT')(event.reason)).length,1);
  await assert.rejects(applyWorkflowCheckpoint(db,storage,binding,{type:'completed',index:0,inputHash:'1'.repeat(64),expectedRevision:1,result:result()}),code('WORKFLOW_INPUT_CHANGED'));
  await assert.rejects(applyWorkflowCheckpoint(db,storage,binding,{type:'provider_task',index:0,inputHash:hash,expectedRevision:1,providerTaskId:'cannot-resume-chat'}),code('INVALID_INPUT'));
  assert.deepEqual((await fs.readdir(directory)).filter(file=>!file.includes('workspaces')&&file!=='synthetic-template.json'),[]);
});

test('completed step artifacts persist as private partial results and cannot be read through another job',async()=>{
  const item=await created(),binding=await claim(item),hash=workflowHash({step:0});await applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:0});
  const complete=await applyWorkflowCheckpoint(db,storage,binding,{type:'completed',index:0,inputHash:hash,expectedRevision:1,result:result()});assert.equal(complete.steps[0].state,'completed');assert.equal(complete.steps[0].text,'Synthetic completed output');const id=complete.steps[0].artifacts![0].attachmentId;
  assert.equal(new TextDecoder().decode((await readWorkflowArtifact(db,storage,binding,id)).bytes),'Synthetic completed output');
  const visible=await jobs.get(item.userId,item.job.id);assert.equal(visible.status,'running');assert.equal(visible.artifacts.length,1);assert.equal(visible.workflowSteps![0].state,'completed');assert.equal(visible.workflowSteps![1].state,'pending');
  await assert.rejects(applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:2}),code('WORKFLOW_STEP_COMPLETE'));
  const other=await created(item.userId),otherBinding=await claim(other);await assert.rejects(readWorkflowArtifact(db,storage,otherBinding,id),code('NOT_FOUND'));
  const metadata=(await db.query('SELECT metadata FROM platform_artifacts WHERE job_id=$1',[item.job.id])).rows[0].metadata;assert.equal(metadata.partialCompleted,true);assert.equal(metadata.workflowStep,0);
});

test('cancellation while storing a step prevents publishing and cleans unpublished bytes',async()=>{
  const item=await created(),binding=await claim(item),hash=workflowHash({step:'cancel'});await applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:0});
  let started!:()=>void,release!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});const delayed={get:storage.get.bind(storage),stat:storage.stat.bind(storage),openRead:storage.openRead.bind(storage),delete:storage.delete.bind(storage),put:async(key:string,bytes:Uint8Array,mime:string)=>{await storage.put(key,bytes);started();await gate;}};
  const saving=applyWorkflowCheckpoint(db,delayed,binding,{type:'completed',index:0,inputHash:hash,expectedRevision:1,result:result('Synthetic cancelled output')});await began;await jobs.cancel(item.userId,item.job.id);release();await assert.rejects(saving,code('WORKFLOW_AUTH_REVOKED'));
  assert.equal((await db.query('SELECT id FROM platform_artifacts WHERE job_id=$1',[item.job.id])).rowCount,0);const checkpoint=(await db.query('SELECT steps FROM platform_workflow_checkpoints WHERE job_id=$1',[item.job.id])).rows[0].steps;assert.equal(checkpoint[0].state,'started');
});

test('a lost checkpoint commit acknowledgement retains already published private artifacts',async()=>{
  const item=await created(),binding=await claim(item),hash=workflowHash({step:'ack'});await applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:0});
  const ackLost={query:db.query.bind(db),transaction:async(run:any)=>{await db.transaction(run);throw new Error('Synthetic lost COMMIT acknowledgement');}} as unknown as Database;
  await assert.rejects(applyWorkflowCheckpoint(ackLost,storage,binding,{type:'completed',index:0,inputHash:hash,expectedRevision:1,result:result('Synthetic retained output')}));
  const checkpoint=await loadWorkflowCheckpoint(db,binding);assert.equal(checkpoint.steps[0].state,'completed');const owned=await readWorkflowArtifact(db,storage,binding,checkpoint.steps[0].artifacts![0].attachmentId);assert.equal(new TextDecoder().decode(owned.bytes),'Synthetic retained output');
});

test('unknown workflow calls remain held for review and interrupted steps are recorded without replay',async()=>{
  const item=await created();execute=async(_input,context)=>{assert(context.onWorkflowCheckpoint);await context.onWorkflowCheckpoint({type:'started',index:0,inputHash:workflowHash({step:'unknown'}),expectedRevision:0});throw new ProviderError('PROVIDER_UNREACHABLE','Synthetic lost response',502);};
  await processJob(jobs,item.job.id,1);const job=await jobs.get(item.userId,item.job.id);assert.equal(job.status,'uncertain');assert.equal(job.workflowResumeAvailable,false);assert.equal(job.artifacts.length,0);await assert.rejects(jobs.retry(item.userId,item.job.id),code('WORKFLOW_REVIEW_REQUIRED'));
  const interrupted=await created(),binding=await claim(interrupted);await applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:workflowHash({step:'interrupted'}),expectedRevision:0});await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[interrupted.job.id]);await recoverInterrupted(jobs);
  assert.equal((await jobs.get(interrupted.userId,interrupted.job.id)).workflowSteps![0].state,'uncertain');await assert.rejects(jobs.retry(interrupted.userId,interrupted.job.id),code('WORKFLOW_REVIEW_REQUIRED'));
  const ledger=await db.query("SELECT event_type FROM platform_workflow_step_ledger WHERE job_id=$1 ORDER BY revision",[interrupted.job.id]);assert.deepEqual(ledger.rows.map(row=>row.event_type),['started','uncertain']);
});

test('final workflow publication rechecks the live lease, current approval and frozen definition',async()=>{
  const changes:[string,string,string][]=[
    ["UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",'JOB_LEASE_EXPIRED','uncertain'],
    ["UPDATE platform_approvals SET status='rejected' WHERE job_id=$1",'JOB_APPROVAL_REVOKED','uncertain'],
    ["UPDATE platform_approvals SET args=jsonb_set(args,'{workflowDefinitionHash}',to_jsonb('forged'::text)) WHERE job_id=$1",'WORKFLOW_DEFINITION_CHANGED','failed'],
    ["UPDATE platform_jobs SET prompt='Changed after completion' WHERE id=$1",'WORKFLOW_DEFINITION_CHANGED','failed'],
    ["UPDATE platform_workflow_checkpoints SET definition_hash=repeat('0',64) WHERE job_id=$1",'WORKFLOW_DEFINITION_CHANGED','failed'],
  ];
  for(const [mutation,errorCode,status] of changes){
    const item=await created(undefined,input([{kind:'chat',provider:'synthetic',prompt:'Draft {{input}}'}]));
    execute=async(_input,context)=>{
      assert(context.onWorkflowCheckpoint&&context.workflowCheckpoint);const hash=workflowHash({step:'publication-gate'});
      const started=await context.onWorkflowCheckpoint({type:'started',index:0,inputHash:hash,expectedRevision:context.workflowCheckpoint.revision});
      await context.onWorkflowCheckpoint({type:'completed',index:0,inputHash:hash,expectedRevision:started.revision,result:result('Synthetic durable partial output')});
      await db.query(mutation,[item.job.id]);return {artifacts:[]};
    };
    await processJob(jobs,item.job.id,1);const rejected=await jobs.get(item.userId,item.job.id);
    assert.equal(rejected.status,status,mutation);assert.equal(rejected.error?.code,errorCode,mutation);assert.equal(rejected.artifacts.length,1);assert.equal(rejected.workflowSteps![0].state,'completed');
    assert.equal((await db.query("SELECT id FROM platform_job_attempts WHERE job_id=$1 AND status='succeeded'",[item.job.id])).rowCount,0);
  }
});

test('an expired ordinary model-job lease prevents publication and removes its unpublished blob',async()=>{
  const uid=await user(),item=await jobs.create(uid,{kind:'video',provider:'ark',prompt:'Synthetic video publication gate'});let unpublishedKey='';
  const put=storage.put.bind(storage);storage.put=async(key,bytes)=>{unpublishedKey=key;await put(key,bytes);};
  execute=async()=>{await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[item.job.id]);return {artifacts:[{name:'unpublished.mp4',mime:'video/mp4',bytes:new TextEncoder().encode('Synthetic expired result')}]};};
  try{await processJob(jobs,item.job.id,1);}finally{storage.put=put;}
  const rejected=await jobs.get(uid,item.job.id);assert.equal(rejected.status,'uncertain');assert.equal(rejected.error?.code,'JOB_LEASE_EXPIRED');assert.equal(rejected.artifacts.length,0);assert(unpublishedKey);await assert.rejects(storage.get(unpublishedKey));
});

test('known async steps resume in a new reviewed attempt and keep completed steps and the old ledger',async()=>{
  const item=await created(undefined,input([{kind:'chat',provider:'synthetic',prompt:'Draft {{input}}'},{kind:'video',provider:'ark',prompt:'Animate {{previous}}'}]));let checkpoint:WorkflowCheckpoint;const hashes=[workflowHash({step:0}),workflowHash({step:1})];let calls=0;
  execute=async(_input,context)=>{assert(context.onWorkflowCheckpoint&&context.workflowCheckpoint);calls++;checkpoint=context.workflowCheckpoint;
    if(calls===1){checkpoint=await context.onWorkflowCheckpoint({type:'started',index:0,inputHash:hashes[0],expectedRevision:checkpoint.revision});checkpoint=await context.onWorkflowCheckpoint({type:'completed',index:0,inputHash:hashes[0],expectedRevision:checkpoint.revision,result:result()});checkpoint=await context.onWorkflowCheckpoint({type:'started',index:1,inputHash:hashes[1],expectedRevision:checkpoint.revision});await context.onWorkflowCheckpoint({type:'provider_task',index:1,inputHash:hashes[1],expectedRevision:checkpoint.revision,providerTaskId:'synthetic-existing-video'});throw new ProviderError('PROVIDER_TASK_PENDING','Synthetic pending video',504);}
    assert.equal(checkpoint.steps[0].state,'completed');assert.equal(checkpoint.steps[1].providerTaskId,'synthetic-existing-video');await context.onWorkflowCheckpoint({type:'completed',index:1,inputHash:hashes[1],expectedRevision:checkpoint.revision,result:{artifacts:[{name:'video.mp4',mime:'video/mp4',bytes:new TextEncoder().encode('Synthetic video output')}]}});return {artifacts:[]};
  };
  await processJob(jobs,item.job.id,1);assert.equal((await jobs.get(item.userId,item.job.id)).artifacts.length,1);assert.equal((await jobs.get(item.userId,item.job.id)).workflowResumeAvailable,true);const retry=await jobs.retry(item.userId,item.job.id);assert.equal(retry.status,'needs_approval');const approval=(await db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2',[item.job.id])).rows[0];await jobs.decide(item.userId,approval.id,'approved');await processJob(jobs,item.job.id,2);
  const final=await jobs.get(item.userId,item.job.id);assert.equal(final.status,'succeeded');assert.equal(final.artifacts.length,2);assert(final.workflowSteps!.every(step=>step.state==='completed'));const ledger=await db.query('SELECT event_type FROM platform_workflow_step_ledger WHERE job_id=$1 ORDER BY revision',[item.job.id]);assert.deepEqual(ledger.rows.map(row=>row.event_type),['started','completed','started','provider_task','completed']);
});

test('real provider runtime and PostgreSQL checkpoints resume polling without replaying a completed text call',async()=>{
  let textCalls=0,videoCreates=0,polls=0;const article='Synthetic article saved before video polling';
  const transport=(async(value:any,init:RequestInit={})=>{
    const target=String(value);
    if(target==='https://api.openai.com/v1/responses'){
      textCalls++;return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:article})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{id:'synthetic-response',status:'completed',output:[{type:'message',id:'synthetic-message',role:'assistant',status:'completed',content:[{type:'output_text',text:article,annotations:[]}]}],usage:{input_tokens:8,output_tokens:6}}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }
    if(target.endsWith('/contents/generations/tasks')&&init.method==='POST'){videoCreates++;return Response.json({id:'synthetic-video-handle'});}
    if(target.endsWith('/contents/generations/tasks/synthetic-video-handle')){polls++;return Response.json(polls===1?{status:'running'}:{status:'succeeded',content:{video_url:'https://synthetic.volces.com/video.mp4'}});}
    if(target==='https://synthetic.volces.com/video.mp4')return new Response('Synthetic downloadable video',{headers:{'content-type':'video/mp4'}});
    throw new Error('Unexpected synthetic provider route');
  }) as typeof fetch;
  const provider=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-key',OPENAI_CHAT_MODEL:'synthetic-chat',ARK_API_KEY:'fictional-key',ARK_VIDEO_MODEL:'synthetic-video',PLATFORM_POLL_ATTEMPTS:'1',PLATFORM_POLL_INTERVAL_MS:'50'},fetch:transport,resolveHost:async()=>[{address:'93.184.216.34',family:4}]});
  const service=new JobService(db,{...config,storageDir:directory},provider,storage),uid=await user();const created=await service.create(uid,input([{kind:'chat',provider:'openai',prompt:'Write {{input}}'},{kind:'video',provider:'ark',prompt:'Animate {{previous}}'}]));await service.decide(uid,created.approval.id,'approved');await processJob(service,created.job.id,1);
  const pending=await service.get(uid,created.job.id);assert.equal(pending.workflowSteps![0].state,'completed');assert.equal(pending.workflowSteps![1].state,'provider_task');assert.equal(pending.artifacts.length,1);assert.equal(textCalls,1);assert.equal(videoCreates,1);
  const originalCapabilities=provider.capabilities;provider.capabilities=()=>originalCapabilities().map(value=>value.id==='openai'?{...value,enabled:false}:value);
  await service.retry(uid,created.job.id);const approval=(await db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2',[created.job.id])).rows[0];await service.decide(uid,approval.id,'approved');await processJob(service,created.job.id,2);
  const done=await service.get(uid,created.job.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(done.artifacts.length,2);assert.equal(textCalls,1);assert.equal(videoCreates,1);assert.equal(polls,2);
});

test('actual image output is privately checkpointed and bound to the next Ark request rather than an arbitrary owned upload',async()=>{
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]),uid=await user();let imageCalls=0,videoCreates=0,createdId='',ordinaryId=randomUUID();const ordinaryKey=randomUUID();
  await storage.put(ordinaryKey,png);await db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'ordinary-owned.png','image/png',$3,$4)",[ordinaryId,uid,png.length,ordinaryKey]);
  const transport=(async(value:any,init:RequestInit={})=>{
    const target=String(value);
    if(target==='https://api.openai.com/v1/images/generations'){imageCalls++;return Response.json({data:[{b64_json:Buffer.from(png).toString('base64')}]});}
    if(target.endsWith('/contents/generations/tasks')&&init.method==='POST'){
      videoCreates++;const body=JSON.parse(String(init.body));assert.equal(body.content[1].role,'first_frame');assert.equal(body.content[1].image_url.url,`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
      const row=(await db.query('SELECT j.*,c.definition_hash FROM platform_jobs j JOIN platform_workflow_checkpoints c ON c.job_id=j.id WHERE j.id=$1',[createdId])).rows[0];
      const binding:WorkflowBinding={jobId:createdId,userId:uid,generation:1,leaseToken:row.lease_token,definitionHash:row.definition_hash,signal:new AbortController().signal};
      await assert.rejects(readWorkflowArtifact(db,storage,binding,ordinaryId),code('NOT_FOUND'));return Response.json({id:'synthetic-referenced-video'});
    }
    if(target.endsWith('/contents/generations/tasks/synthetic-referenced-video'))return Response.json({status:'succeeded',content:{video_url:'https://synthetic.volces.com/bound.mp4'}});
    if(target==='https://synthetic.volces.com/bound.mp4')return new Response('Synthetic referenced video',{headers:{'content-type':'video/mp4'}});
    throw new Error('Unexpected synthetic reference route');
  }) as typeof fetch;
  const provider=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-key',OPENAI_IMAGE_MODEL:'synthetic-image',ARK_API_KEY:'fictional-key',ARK_VIDEO_MODEL:'synthetic-video',PLATFORM_POLL_ATTEMPTS:'1'},fetch:transport,resolveHost:async()=>[{address:'93.184.216.34',family:4}]});
  const service=new JobService(db,{...config,storageDir:directory},provider,storage),created=await service.create(uid,input([{kind:'image',provider:'openai',prompt:'Draw {{input}}'},{kind:'video',provider:'ark',prompt:'Animate {{input}}',referenceImages:[{fromStep:0}],options:{referenceMode:'first_frame'}}]));createdId=created.job.id;
  await service.decide(uid,created.approval.id,'approved');await processJob(service,createdId,1);const final=await service.get(uid,createdId);assert.equal(final.status,'succeeded',JSON.stringify(final.error));assert.equal(final.artifacts.length,2);assert.equal(imageCalls,1);assert.equal(videoCreates,1);
});

test('confirmed terminal media failure requires new approval to clear its handle while preserving older ledger',async()=>{
  const item=await created(undefined,input([{kind:'video',provider:'ark',prompt:'Synthetic terminal video'}])),binding=await claim(item),hash=workflowHash({step:'terminal'});
  let checkpoint=await applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:0});checkpoint=await applyWorkflowCheckpoint(db,storage,binding,{type:'provider_task',index:0,inputHash:hash,expectedRevision:checkpoint.revision,providerTaskId:'failed-synthetic-provider-task'});checkpoint=await applyWorkflowCheckpoint(db,storage,binding,{type:'failed',index:0,inputHash:hash,expectedRevision:checkpoint.revision,errorCode:'VIDEO_GENERATION_FAILED'});
  await assert.rejects(applyWorkflowCheckpoint(db,storage,binding,{type:'started',index:0,inputHash:hash,expectedRevision:checkpoint.revision}),code('WORKFLOW_REVIEW_REQUIRED'));
  await db.query("UPDATE platform_jobs SET status='failed',lease_token=NULL,lease_until=NULL,error_code='VIDEO_GENERATION_FAILED' WHERE id=$1",[item.job.id]);await jobs.retry(item.userId,item.job.id);const approval=(await db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=2',[item.job.id])).rows[0];await jobs.decide(item.userId,approval.id,'approved');const next=await claim(item,2);
  const restarted=await applyWorkflowCheckpoint(db,storage,next,{type:'started',index:0,inputHash:hash,expectedRevision:checkpoint.revision});assert.equal(restarted.steps[0].providerTaskId,undefined);
  const ledger=await db.query('SELECT generation,event_type,provider_task_id FROM platform_workflow_step_ledger WHERE job_id=$1 ORDER BY revision',[item.job.id]);assert.deepEqual(ledger.rows.map(row=>row.event_type),['started','provider_task','failed','started']);assert.equal(ledger.rows[2].provider_task_id,'failed-synthetic-provider-task');assert.equal(ledger.rows[3].generation,2);
});

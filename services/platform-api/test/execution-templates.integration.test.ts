import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateJobInput, PlatformProviderRuntime, WorkflowStep } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError, workflowDefinitionHash, workflowHash } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { JobService, parseJob, processJob, recoverInterrupted } from '../src/jobs.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { GoalPlans } from '../src/goal-plans.ts';

const schema=`execution_templates_test_${randomUUID().replaceAll('-','')}`,base=readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' }),admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString()),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let directory:string,templatePath:string,storage:LocalBlobStorage;
const graph=(marker:string)=>({'1':{class_type:'SyntheticPromptEncoder',inputs:{text:'Synthetic template default'}},'2':{class_type:'SyntheticOutput',inputs:{privateTemplateMarker:marker}}});
const code=(expected:string)=>(cause:unknown)=>cause instanceof ApiError&&cause.code===expected;
before(async()=>{assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Fixtures require a local PostgreSQL database.');await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'execution-template-fixtures-'));templatePath=path.join(directory,'private-server-template.json');storage=new LocalBlobStorage(path.join(directory,'blobs'));});
after(async()=>{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
async function user(){const id=randomUUID();await db.query("INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,'Fictional template reviewer','not-a-login-password')",[id,`templates-${id}@example.invalid`]);return id;}
const direct=(prompt='Fictional image'):CreateJobInput=>({kind:'image',provider:'comfyui',prompt,options:{}});
const workflow=(prompt='Fictional workflow'):CreateJobInput=>({kind:'workflow',provider:'workflow',prompt,options:{steps:[{kind:'image',provider:'comfyui',prompt:'Draw {{input}}',options:{}}]}});
async function fixture(marker:string,endpoint='http://127.0.0.1:8188',outputKind:'image'|'video'='image'){
  await fs.writeFile(templatePath,JSON.stringify(graph(marker)));
  const requests:{url:string;method:string;body?:any}[]=[];
  let mode:'completed'|'pending'|'failed'|'unknown'|'malformed'|'missing_id'|'rejected_http'='completed';
  const transport=(async(value:any,init:RequestInit={})=>{
    const target=String(value),method=init.method??'GET';assert(target.startsWith(endpoint+'/'),'Fixture transport refuses external routes.');
    requests.push({url:target,method,...(init.body?{body:JSON.parse(String(init.body))}:{})});
    if(target===endpoint+'/prompt'){if(mode==='unknown')throw new Error('Synthetic lost queue acknowledgement');if(mode==='malformed')return new Response('Synthetic invalid JSON');if(mode==='missing_id')return Response.json({number:1});if(mode==='rejected_http')return new Response('Synthetic upstream failure',{status:502});return Response.json({prompt_id:'synthetic-owned-task'});}
    if(target===endpoint+'/history/synthetic-owned-task')return Response.json(mode==='pending'?{}:{'synthetic-owned-task':{status:mode==='failed'?{status_str:'error'}:{completed:true},outputs:{'2':outputKind==='video'?{videos:[{filename:'synthetic-output.mp4',subfolder:'',type:'output'}]}:{images:[{filename:'synthetic-output.png',subfolder:'',type:'output'}]}}}});
    // The video fixture deliberately supplies PNG bytes under video metadata; it never claims video success.
    if(target.startsWith(endpoint+'/view?'))return new Response(png,{headers:{'content-type':outputKind==='video'?'video/mp4':'image/png'}});
    throw new Error('Unexpected local template fixture route.');
  }) as typeof fetch;
  const runtime=createProviderRuntime({env:{COMFYUI_BASE_URL:endpoint,COMFYUI_WORKFLOW_TEMPLATE:templatePath,COMFYUI_PROMPT_NODE:'1',COMFYUI_OUTPUT_KIND:outputKind,PLATFORM_POLL_ATTEMPTS:'1',PLATFORM_POLL_INTERVAL_MS:'50'},fetch:transport});
  const jobs=new JobService(db,{...base,storageDir:directory,maxActiveJobs:20},runtime,storage);
  return {runtime,jobs,requests,setMode:(value:typeof mode)=>{mode=value;},posts:()=>requests.filter(request=>request.method==='POST')};
}
async function approve(jobs:JobService,uid:string,jobId:string,generation=1){const approval=(await db.query('SELECT id FROM platform_approvals WHERE job_id=$1 AND generation=$2',[jobId,generation])).rows[0];assert(approval);await jobs.decide(uid,approval.id,'approved');}
async function savedPolicy(id:string){return (await db.query('SELECT execution_policy FROM platform_jobs WHERE id=$1',[id])).rows[0].execution_policy;}
function historicalSnapshot(saved:any){const {hash:_,outputKind:__,...body}=saved;return {...body,hash:workflowHash(body)};}
function noPrivateSnapshot(value:unknown){const serialized=JSON.stringify(value);for(const secret of ['baseUrl','promptNode','promptField','class_type','privateTemplateMarker',templatePath])assert(!serialized.includes(secret),'Public responses must expose only the template binding.');}

test('creation privately freezes the full graph; file replacement and runtime restart preserve old jobs and bind new jobs to the new graph',async()=>{
  const original=await fixture('synthetic-original'),uid=await user(),old=await original.jobs.create(uid,direct('Fictional original image')),plan=await original.jobs.create(uid,workflow());await approve(original.jobs,uid,plan.job.id);
  const oldBinding=old.job.executionTemplate!;assert.equal(oldBinding.hash,original.runtime.capabilities().find(provider=>provider.id==='comfyui')!.executionTemplate!.hash);assert.deepEqual((plan.job.options!.steps as WorkflowStep[])[0].executionTemplate,oldBinding);assert.equal(plan.approval.args.workflowDefinitionHash,workflowDefinitionHash(plan.job));
  for(const publicValue of [old,plan,await original.jobs.get(uid,plan.job.id),original.runtime.capabilities()])noPrivateSnapshot(publicValue);
  const privateBefore=await savedPolicy(old.job.id);assert.equal(privateBefore.comfyui.job.graph['2'].inputs.privateTemplateMarker,'synthetic-original');
  const restarted=await fixture('synthetic-replacement'),fresh=await restarted.jobs.create(uid,direct('Fictional new image'));assert.notEqual(fresh.job.executionTemplate!.hash,oldBinding.hash);
  await processJob(restarted.jobs,old.job.id,1);await processJob(restarted.jobs,plan.job.id,1);await processJob(restarted.jobs,fresh.job.id,1);
  for(const id of [old.job.id,plan.job.id,fresh.job.id])assert.equal((await restarted.jobs.get(uid,id)).status,'succeeded');
  assert.deepEqual(restarted.posts().map(request=>request.body.prompt['2'].inputs.privateTemplateMarker),['synthetic-original','synthetic-original','synthetic-replacement']);assert.equal(restarted.posts()[0].body.prompt['1'].inputs.text,'Fictional original image');
  assert.deepEqual(await savedPolicy(old.job.id),privateBefore,'Prompt injection must not modify the private snapshot.');assert.equal(original.posts().length,0);
});

test('HTTP and strict parsers reject stale or forged bindings, graphs, paths, and bindings on non-ComfyUI tasks',async()=>{
  const old=await fixture('synthetic-old'),stale=old.runtime.capabilities().find(provider=>provider.id==='comfyui')!.executionTemplate!,current=await fixture('synthetic-current'),system=await buildApp({db,storage,runtime:current.runtime,config:{...base,storageDir:directory,maxActiveJobs:20},enableQueue:false});
  try{
    const registration=await system.app.inject({method:'POST',url:'/api/platform/auth/register',headers:{origin:'http://localhost:4321'},payload:{email:`templates-${randomUUID()}@example.invalid`,name:'Fictional template client',password:'Fictional-password-123'}});assert.equal(registration.statusCode,201);const cookie=(registration.headers['set-cookie'] as string).split(';')[0],headers={origin:'http://localhost:4321',cookie,[PLATFORM_ACCOUNT_HEADER]:registration.json().user.id};
    for(const executionTemplate of [stale,{version:1,hash:'0'.repeat(64)}]){const response=await system.app.inject({method:'POST',url:'/api/platform/jobs',headers,payload:{...direct(),executionTemplate}});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'COMFYUI_TEMPLATE_CHANGED');}
    for(const payload of [{...direct(),graph:graph('must-not-run')},{...direct(),options:{workflow:graph('must-not-run')}},{...direct(),executionTemplate:{version:1,hash:stale.hash,graph:graph('must-not-run')}},{...direct(),options:{templatePath:'/synthetic/path'}},{...direct(),model:'client-selected-model'}, {...workflow(),executionTemplate:stale},{...workflow(),options:{steps:[{kind:'image',provider:'comfyui',prompt:'Fictional step',model:'client-selected-model'}]}}]){const response=await system.app.inject({method:'POST',url:'/api/platform/jobs',headers,payload});assert.equal(response.statusCode,400,response.body);}
    const accepted=await system.app.inject({method:'POST',url:'/api/platform/jobs',headers,payload:{...direct(),executionTemplate:current.runtime.capabilities().find(provider=>provider.id==='comfyui')!.executionTemplate}});assert.equal(accepted.statusCode,201,accepted.body);noPrivateSnapshot(accepted.json());
    const list=await system.app.inject({method:'GET',url:'/api/platform/jobs',headers});noPrivateSnapshot(list.json());assert.equal(list.json().jobs.length,1);assert.equal(current.requests.length,0);
    assert.throws(()=>parseJob({...direct(),graph:{}}));
  }finally{await system.app.close();}
});

test('direct and workflow preparation reject a wrong-kind template even when a runtime overstates its capabilities',async()=>{
  const item=await fixture('synthetic-kind-binding'),uid=await user(),capabilities=item.runtime.capabilities;
  item.runtime.capabilities=()=>capabilities().map(provider=>provider.id==='comfyui'?{...provider,capabilities:['image','video']}:provider);
  const definitions:CreateJobInput[]=[{kind:'video',provider:'comfyui',prompt:'Fictional video'},
    {kind:'workflow',provider:'workflow',prompt:'Fictional mixed media',options:{steps:[{kind:'image',provider:'comfyui',prompt:'First fictional image'},{kind:'video',provider:'comfyui',prompt:'Second fictional video'}]}}];
  for(const definition of definitions)await assert.rejects(item.jobs.create(uid,definition),code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  assert.equal((await db.query('SELECT id FROM platform_jobs WHERE user_id=$1',[uid])).rowCount,0);
  assert.equal((await db.query('SELECT id FROM platform_approvals WHERE user_id=$1',[uid])).rowCount,0);
  assert.equal((await db.query('SELECT o.job_id FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1',[uid])).rowCount,0);
  assert.equal(item.requests.length,0);
});

test('missing-kind historical jobs remain readable but unfinished and known-handle jobs cannot execute or recover',async()=>{
  const item=await fixture('synthetic-legacy-kind'),uid=await user(),completed=await item.jobs.create(uid,direct('Fictional historical image'));
  await processJob(item.jobs,completed.job.id,1);const before=await item.jobs.get(uid,completed.job.id);assert.equal(before.status,'succeeded');assert.equal(before.artifacts.length,1);
  const completedPolicy=await savedPolicy(completed.job.id);completedPolicy.comfyui.job=historicalSnapshot(completedPolicy.comfyui.job);
  await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[completed.job.id,JSON.stringify(completedPolicy)]);
  const history=await item.jobs.get(uid,completed.job.id);assert.equal(history.status,'succeeded');assert.deepEqual(history.artifacts,before.artifacts);assert.equal(history.executionTemplate!.hash,completedPolicy.comfyui.job.hash);
  const baselineRequests=item.requests.length;
  const queued=await item.jobs.create(uid,direct()),queuedPolicy=await savedPolicy(queued.job.id);queuedPolicy.comfyui.job=historicalSnapshot(queuedPolicy.comfyui.job);
  await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[queued.job.id,JSON.stringify(queuedPolicy)]);
  await processJob(item.jobs,queued.job.id,1);assert.equal((await item.jobs.get(uid,queued.job.id)).error?.code,'COMFYUI_TEMPLATE_INVALID');
  const held=await item.jobs.create(uid,direct('Fictional interrupted legacy handle')),heldPolicy=await savedPolicy(held.job.id);heldPolicy.comfyui.job=historicalSnapshot(heldPolicy.comfyui.job);
  await db.query("UPDATE platform_jobs SET status='running',execution_policy=$2,provider_task_id='synthetic-owned-task',lease_token=$3,lease_until=now()-interval '1 second' WHERE id=$1",[held.job.id,JSON.stringify(heldPolicy),randomUUID()]);
  await recoverInterrupted(item.jobs);assert.equal((await item.jobs.get(uid,held.job.id)).status,'uncertain');
  await assert.rejects(item.jobs.retry(uid,held.job.id),code('COMFYUI_TEMPLATE_INVALID'));
  assert.equal(item.requests.length,baselineRequests);assert.deepEqual((await item.jobs.get(uid,completed.job.id)).artifacts,before.artifacts);
});

test('missing or tampered private snapshots fail before any provider request, including legacy workflow jobs and their approvals',async()=>{
  const item=await fixture('synthetic-missing'),uid=await user();
  for(const definition of [direct(),workflow()])for(const mutation of ['missing','tampered'] as const){
    const created=await item.jobs.create(uid,definition);if(created.approval)await approve(item.jobs,uid,created.job.id);
    const policy=await savedPolicy(created.job.id);if(mutation==='missing')delete policy.comfyui;else{const privateSnapshot=definition.kind==='workflow'?policy.comfyui.steps['0']:policy.comfyui.job;privateSnapshot.graph['2'].inputs.privateTemplateMarker='synthetic-unreviewed-change';}
    await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[created.job.id,JSON.stringify(policy)]);await processJob(item.jobs,created.job.id,1);const rejected=await item.jobs.get(uid,created.job.id);assert.equal(rejected.status,'failed');assert.equal(rejected.error?.code,mutation==='missing'?'COMFYUI_TEMPLATE_REQUIRED':'COMFYUI_TEMPLATE_INVALID');await assert.rejects(item.jobs.retry(uid,created.job.id),code(rejected.error!.code));assert.equal(rejected.artifacts.length,0);
  }
  const pending=await item.jobs.create(uid,workflow());await db.query("UPDATE platform_jobs SET execution_policy='{}' WHERE id=$1",[pending.job.id]);await assert.rejects(item.jobs.decide(uid,pending.approval.id,'approved'),code('COMFYUI_TEMPLATE_REQUIRED'));assert.equal(item.requests.length,0);
});

test('endpoint drift refuses both a new submission and an existing provider handle, and interrupted legacy handles stay held',async()=>{
  const original=await fixture('synthetic-endpoint'),uid=await user(),unstarted=await original.jobs.create(uid,direct());
  original.setMode('pending');const pending=await original.jobs.create(uid,direct('Fictional pending image'));await processJob(original.jobs,pending.job.id,1);assert.equal((await original.jobs.get(uid,pending.job.id)).providerTaskId,'synthetic-owned-task');
  const changed=await fixture('synthetic-endpoint','http://127.0.0.1:8288');await processJob(changed.jobs,unstarted.job.id,1);assert.equal((await changed.jobs.get(uid,unstarted.job.id)).error?.code,'COMFYUI_TEMPLATE_CHANGED');await assert.rejects(changed.jobs.retry(uid,pending.job.id),code('COMFYUI_TEMPLATE_CHANGED'));
  await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[pending.job.id,randomUUID()]);await recoverInterrupted(changed.jobs);assert.equal((await changed.jobs.get(uid,pending.job.id)).status,'uncertain');assert.equal(changed.requests.length,0);
  const legacy=await original.jobs.create(uid,direct('Fictional legacy handle'));await db.query("UPDATE platform_jobs SET status='running',provider_task_id='synthetic-owned-task',execution_policy='{}',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[legacy.job.id,randomUUID()]);await recoverInterrupted(original.jobs);assert.equal((await original.jobs.get(uid,legacy.job.id)).status,'uncertain');await assert.rejects(original.jobs.retry(uid,legacy.job.id),code('COMFYUI_TEMPLATE_REQUIRED'));
});

test('confirmed failed retries require new approval and reuse the original snapshot, while known-handle recovery only polls',async()=>{
  const original=await fixture('synthetic-retry'),uid=await user(),failed=await original.jobs.create(uid,direct());original.setMode('failed');await processJob(original.jobs,failed.job.id,1);assert.equal((await original.jobs.get(uid,failed.job.id)).error?.code,'COMFYUI_FAILED');
  const restarted=await fixture('synthetic-latest'),retried=await restarted.jobs.retry(uid,failed.job.id);assert.equal(retried.status,'needs_approval');assert.deepEqual(retried.executionTemplate,failed.job.executionTemplate);
  const pendingApproval=(await db.query('SELECT id,args FROM platform_approvals WHERE job_id=$1 AND generation=2',[failed.job.id])).rows[0];await db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[pendingApproval.id,JSON.stringify({...pendingApproval.args,executionTemplate:{version:1,hash:'0'.repeat(64)}})]);await assert.rejects(restarted.jobs.decide(uid,pendingApproval.id,'approved'),code('COMFYUI_TEMPLATE_CHANGED'));await db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[pendingApproval.id,JSON.stringify(pendingApproval.args)]);
  await approve(restarted.jobs,uid,failed.job.id,2);const approval=(await db.query('SELECT args FROM platform_approvals WHERE job_id=$1 AND generation=2',[failed.job.id])).rows[0].args;assert.deepEqual(approval.executionTemplate,failed.job.executionTemplate);noPrivateSnapshot(approval);await processJob(restarted.jobs,failed.job.id,2);assert.equal((await restarted.jobs.get(uid,failed.job.id)).status,'succeeded');assert.equal(restarted.posts()[0].body.prompt['2'].inputs.privateTemplateMarker,'synthetic-retry');
  original.setMode('pending');const pending=await original.jobs.create(uid,direct('Fictional recoverable image'));await processJob(original.jobs,pending.job.id,1);await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[pending.job.id,randomUUID()]);const beforePosts=restarted.posts().length;await recoverInterrupted(restarted.jobs);assert.equal((await restarted.jobs.get(uid,pending.job.id)).status,'queued');await processJob(restarted.jobs,pending.job.id,2);assert.equal((await restarted.jobs.get(uid,pending.job.id)).status,'succeeded');assert.equal(restarted.posts().length,beforePosts);
});

test('workflow handle resume retains its original definition and private snapshot without replaying the submitted graph',async()=>{
  const original=await fixture('synthetic-workflow-resume'),uid=await user(),plan=await original.jobs.create(uid,workflow());await approve(original.jobs,uid,plan.job.id);original.setMode('pending');await processJob(original.jobs,plan.job.id,1);const partial=await original.jobs.get(uid,plan.job.id);assert.equal(partial.workflowSteps![0].state,'provider_task');
  const restarted=await fixture('synthetic-workflow-latest');await restarted.jobs.retry(uid,plan.job.id);await approve(restarted.jobs,uid,plan.job.id,2);await processJob(restarted.jobs,plan.job.id,2);const complete=await restarted.jobs.get(uid,plan.job.id);assert.equal(complete.status,'succeeded');assert.equal(complete.artifacts.length,1);assert.deepEqual((complete.options!.steps as WorkflowStep[])[0].executionTemplate,(plan.job.options!.steps as WorkflowStep[])[0].executionTemplate);assert.equal(restarted.posts().length,0);assert.equal(original.posts().length,1);
});

test('completed workflow ComfyUI receipts remain reusable when its current server changes or the provider becomes unavailable',async()=>{
  const original=await fixture('synthetic-completed-receipt'),uid=await user();
  const extend=(runtime:PlatformProviderRuntime,fail:boolean)=>{
    const capabilities=runtime.capabilities,execute=runtime.executeJob;
    runtime.capabilities=()=>[...capabilities(),{id:'synthetic-speech',name:'Fictional speech fixture',enabled:true,keyConfigured:true,capabilities:['speech'],models:['synthetic-speech-model'],envVariables:[]}];
    runtime.executeJob=async(input,context)=>{if(input.provider==='synthetic-speech'){if(fail)throw new ProviderError('INVALID_PROVIDER_INPUT','Synthetic local preflight failure',400);return {artifacts:[{name:'synthetic-speech.txt',mime:'text/plain',bytes:Buffer.from('Synthetic spoken output')}]};}return execute(input,context);};
  };
  extend(original.runtime,true);const definition:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'Fictional completed receipt',options:{steps:[{kind:'image',provider:'comfyui',prompt:'Draw {{input}}'},{kind:'speech',provider:'synthetic-speech',model:'synthetic-speech-model',prompt:'Fictional narration'}]}},plan=await original.jobs.create(uid,definition);await approve(original.jobs,uid,plan.job.id);await processJob(original.jobs,plan.job.id,1);const partial=await original.jobs.get(uid,plan.job.id);assert.equal(partial.workflowSteps![0].state,'completed');assert.equal(partial.workflowSteps![1].state,'failed');assert.equal(partial.artifacts.length,1);assert.equal(original.posts().length,1);
  // Model a genuinely old completed checkpoint: its snapshot, definition and input hashes predate outputKind.
  // This private fixture does not grant legacy unfinished steps execution permission.
  const oldPolicy=await savedPolicy(plan.job.id),oldSnapshot=historicalSnapshot(oldPolicy.comfyui.steps['0']);oldPolicy.comfyui.steps['0']=oldSnapshot;
  const oldOptions=structuredClone(partial.options!);(oldOptions.steps as WorkflowStep[])[0].executionTemplate={version:1,hash:oldSnapshot.hash};
  const oldDefinitionHash=workflowDefinitionHash({...partial,options:oldOptions}),step=(oldOptions.steps as WorkflowStep[])[0];
  const oldInputHash=workflowHash({kind:step.kind,provider:step.provider,model:step.model,options:step.options??{},prompt:step.prompt.replace('{{input}}',partial.prompt),references:[],executionTemplate:step.executionTemplate});
  await db.transaction(async client=>{
    const checkpoint=(await client.query('SELECT steps FROM platform_workflow_checkpoints WHERE job_id=$1 FOR UPDATE',[plan.job.id])).rows[0];checkpoint.steps[0].inputHash=oldInputHash;
    await client.query('UPDATE platform_jobs SET options=$2,execution_policy=$3 WHERE id=$1',[plan.job.id,JSON.stringify(oldOptions),JSON.stringify(oldPolicy)]);
    await client.query('UPDATE platform_workflow_checkpoints SET definition_hash=$2,steps=$3 WHERE job_id=$1',[plan.job.id,oldDefinitionHash,JSON.stringify(checkpoint.steps)]);
    await client.query('UPDATE platform_workflow_step_ledger SET input_hash=$2 WHERE job_id=$1 AND step_index=0',[plan.job.id,oldInputHash]);
  });
  const restarted=await fixture('synthetic-unrelated-current','http://127.0.0.1:8288');extend(restarted.runtime,false);const capabilities=restarted.runtime.capabilities;restarted.runtime.capabilities=()=>capabilities().map(provider=>provider.id==='comfyui'?{...provider,enabled:false}:provider);
  await restarted.jobs.retry(uid,plan.job.id);await approve(restarted.jobs,uid,plan.job.id,2);await processJob(restarted.jobs,plan.job.id,2);const complete=await restarted.jobs.get(uid,plan.job.id);assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));assert.equal(complete.artifacts.length,2);assert.equal(complete.artifacts[0].id,partial.artifacts[0].id);assert.equal(restarted.requests.length,0);
  assert.equal((await savedPolicy(plan.job.id)).comfyui.steps['0'].hash,oldSnapshot.hash);assert(!Object.hasOwn((await savedPolicy(plan.job.id)).comfyui.steps['0'],'outputKind'));
});

test('wrong-kind saved input is refused by delivery and approval before any external request',async()=>{
  const item=await fixture('synthetic-stored-kind'),uid=await user(),queued=await item.jobs.create(uid,direct());
  const queuedPolicy=await savedPolicy(queued.job.id),{hash:_,...body}=queuedPolicy.comfyui.job;body.outputKind='video';queuedPolicy.comfyui.job={...body,hash:workflowHash(body)};
  await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[queued.job.id,JSON.stringify(queuedPolicy)]);
  await processJob(item.jobs,queued.job.id,1);assert.equal((await item.jobs.get(uid,queued.job.id)).status,'failed');assert.equal((await item.jobs.get(uid,queued.job.id)).error?.code,'COMFYUI_OUTPUT_KIND_MISMATCH');
  assert.equal((await db.query('SELECT id FROM platform_job_attempts WHERE job_id=$1',[queued.job.id])).rowCount,0);
  const pending=await item.jobs.create(uid,workflow()),policy=await savedPolicy(pending.job.id),{hash:__,...stepBody}=policy.comfyui.steps['0'];stepBody.outputKind='video';policy.comfyui.steps['0']={...stepBody,hash:workflowHash(stepBody)};
  const options=structuredClone(pending.job.options!);(options.steps as WorkflowStep[])[0].executionTemplate={version:1,hash:policy.comfyui.steps['0'].hash};
  await db.query('UPDATE platform_jobs SET options=$2,execution_policy=$3 WHERE id=$1',[pending.job.id,JSON.stringify(options),JSON.stringify(policy)]);
  await db.query('UPDATE platform_workflow_checkpoints SET definition_hash=$2 WHERE job_id=$1',[pending.job.id,workflowDefinitionHash({...pending.job,options})]);
  await assert.rejects(item.jobs.decide(uid,pending.approval.id,'approved'),code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  assert.equal((await db.query('SELECT status FROM platform_approvals WHERE id=$1',[pending.approval.id])).rows[0].status,'pending');
  assert.equal((await db.query('SELECT job_id FROM platform_job_outbox WHERE job_id=$1',[pending.job.id])).rowCount,0);assert.equal(item.requests.length,0);
});

test('real ComfyUI adapter rejects PNG bytes declared as video without publishing plan success, and retry requires new approval',async()=>{
  const item=await fixture('synthetic-invalid-video','http://127.0.0.1:8188','video'),uid=await user(),conversationId=randomUUID();
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional video goal','agent')",[conversationId,uid]);
  const plans=new GoalPlans(db,item.jobs,item.runtime),draft=await plans.create(uid,conversationId,{title:'Fictional video goal',goal:'Prepare two separately reviewed fictional videos.',steps:[
    {kind:'task',title:'First video',task:{kind:'video',provider:'comfyui',prompt:'Fictional video one'}},
    {kind:'task',title:'Second video',task:{kind:'video',provider:'comfyui',prompt:'Fictional video two'}},
  ]});
  const confirmed=await plans.confirm(uid,draft.id,{revision:draft.revision}),prepared=await plans.continue(uid,draft.id,{revision:confirmed.revision,stepIndex:0});
  if(prepared.kind!=='task')throw new Error('The fixture must prepare a reviewed task.');
  assert.equal(prepared.job.status,'needs_approval');await item.jobs.decide(uid,prepared.approval!.id,'approved');await processJob(item.jobs,prepared.job.id,1);
  const failed=await item.jobs.get(uid,prepared.job.id);assert.equal(failed.status,'failed');assert.equal(failed.error?.code,'COMFYUI_OUTPUT_INVALID');assert.equal(failed.artifacts.length,0);
  assert.equal((await db.query('SELECT id FROM platform_uploads WHERE user_id=$1',[uid])).rowCount,0);
  assert.equal((await db.query("SELECT id FROM platform_job_attempts WHERE job_id=$1 AND status='succeeded'",[failed.id])).rowCount,0);
  const read=await plans.get(uid,draft.id);assert.equal(read.steps[0].receipt,undefined);assert.equal(read.steps[1].ready,false);assert.notEqual(read.status,'completed');
  const retried=await item.jobs.retry(uid,failed.id);assert.equal(retried.status,'needs_approval');assert.equal(retried.providerTaskId,undefined);
  const approval=(await db.query('SELECT args FROM platform_approvals WHERE job_id=$1 AND generation=2',[failed.id])).rows[0].args;
  assert.equal(approval.options.newProviderRequest,true);assert.equal(approval.options.mayIncurAdditionalCharge,true);assert.equal(item.posts().length,1);
});

test('a lost ComfyUI queue acknowledgement is uncertain and cannot be retried as a new submission',async()=>{
  const item=await fixture('synthetic-unknown'),uid=await user();for(const mode of ['unknown','malformed','missing_id','rejected_http'] as const){const created=await item.jobs.create(uid,direct());item.setMode(mode);await processJob(item.jobs,created.job.id,1);const job=await item.jobs.get(uid,created.job.id);assert.equal(job.status,'uncertain');assert.equal(job.error?.code,'COMFYUI_SUBMISSION_UNCERTAIN');assert.equal(job.providerTaskId,undefined);await assert.rejects(item.jobs.retry(uid,created.job.id),code('COMFYUI_REVIEW_REQUIRED'));}assert.equal(item.posts().length,4);
  item.setMode('completed');const created=await item.jobs.create(uid,direct('Fictional persisted queue handle'));let transactions=0;
  const lostAck={query:db.query.bind(db),transaction:async(run:any)=>{const result=await db.transaction(run);if(++transactions===2)throw new Error('Synthetic lost handle COMMIT acknowledgement');return result;}} as unknown as Database;
  const service=new JobService(lostAck,{...base,storageDir:directory},item.runtime,storage);await processJob(service,created.job.id,1);const held=await service.get(uid,created.job.id);assert.equal(held.status,'uncertain');assert.equal(held.error?.code,'COMFYUI_SUBMISSION_UNCERTAIN');assert.equal(held.providerTaskId,'synthetic-owned-task');assert.equal(item.posts().length,5);
  await service.retry(uid,created.job.id);await approve(service,uid,created.job.id,2);await processJob(service,created.job.id,2);assert.equal((await service.get(uid,created.job.id)).status,'succeeded');assert.equal(item.posts().length,5,'A persisted handle must only be polled after acknowledgement loss.');
});

test('final publication rejects a private-policy mutation after generation and keeps no unconfirmed artifact',async()=>{
  const item=await fixture('synthetic-publication'),uid=await user(),created=await item.jobs.create(uid,direct()),realExecute=item.runtime.executeJob;
  const wrapped:PlatformProviderRuntime={...item.runtime,executeJob:async(input,context)=>{const result=await realExecute(input,context);const policy=await savedPolicy(created.job.id);policy.comfyui.job.graph['2'].inputs.privateTemplateMarker='synthetic-after-generation-change';await db.query('UPDATE platform_jobs SET execution_policy=$2 WHERE id=$1',[created.job.id,JSON.stringify(policy)]);return result;}};
  const service=new JobService(db,{...base,storageDir:directory},wrapped,storage);await processJob(service,created.job.id,1);const failed=await service.get(uid,created.job.id);assert.equal(failed.status,'failed');assert.equal(failed.error?.code,'COMFYUI_TEMPLATE_INVALID');assert.equal(failed.artifacts.length,0);assert.equal((await db.query('SELECT id FROM platform_uploads WHERE user_id=$1',[uid])).rowCount,0);assert.equal(item.posts().length,1);
});

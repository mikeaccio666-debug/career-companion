import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GOAL_PLAN_MAX_BYTES, PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import type { CreateJobInput, GeneratedArtifact, GoalPlan, GoalPlanContinuation, GoalPlanStepInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ProviderError } from '@companion/ai-core';
import { executeWorkflow } from '../../../packages/ai-core/src/workflow.ts';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { processJob } from '../src/jobs.ts';
import { mcpSchemaHash } from '../src/mcp-config.ts';
import type { McpTransport } from '../src/mcp-transport-port.ts';
import { recoverStaleStreams } from '../src/runtime-leases.ts';
import { parseGoalPlanInput } from '../src/goal-plans.ts';
import type { PoolClient } from 'pg';

const base=readConfig(),prefix='/api/platform',origin='http://localhost:4321';
const schema=`goal_plans_test_${randomUUID().replaceAll('-','')}`,admin=new Database(base.databaseUrl),databaseUrl=new URL(base.databaseUrl);
databaseUrl.searchParams.set('options',`-c search_path=${schema}`);const db=new Database(databaseUrl.toString());
const inputSchema={type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false};
const schemaHash=mcpSchemaHash(inputSchema);
let system:Awaited<ReturnType<typeof buildApp>>,directory:string,jobCalls=0,modelCalls=0,mcpCalls=0;
let behavior:'read'|'forbidden'|'fail'|'hold'='read',jobBehavior:'ok'|'fail'|'uncertain'|'hold'='ok',seenInput:any,seenTools:string[]=[],toolResults:any[]=[];
let entered: (()=>void)|undefined,release:(()=>void)|undefined,hold:Promise<void>|undefined;
let analysisSignal:AbortSignal|undefined;
let analysisOutput='Fictional analysis returned; evidence is limited and no real-world goal completion is asserted.';
let jobArtifacts:GeneratedArtifact[]|undefined,referenceReadGate:(()=>Promise<void>)|undefined,referenceSubmissions=0;
const executedInputs:CreateJobInput[]=[];
const forbidden=async():Promise<never>=>{throw new Error('No real provider, model, mail, browser or external credentials are permitted in this fixture.');};
const runtime:PlatformProviderRuntime={
  capabilities:()=>[
    {id:'synthetic',name:'Fictional goal-plan provider',keyConfigured:true,enabled:true,capabilities:['chat','agent','image','video','speech'],models:['fictional-model'],modelsByCapability:{chat:['fictional-model'],agent:['fictional-model'],image:['fictional-model'],video:['fictional-model'],speech:['fictional-model']},envVariables:[]},
    {id:'browser',name:'Fictional browser fixture',keyConfigured:true,enabled:true,capabilities:['browser'],models:[],envVariables:[]},
    {id:'cli',name:'Fictional isolated CLI fixture',keyConfigured:true,enabled:true,capabilities:['cli'],models:[],envVariables:[]},
    {id:'workflow',name:'Fictional workflow fixture',keyConfigured:true,enabled:true,capabilities:['workflow'],models:[],envVariables:[]},
    {id:'openai',name:'Fictional image adapter',keyConfigured:true,enabled:true,capabilities:['image'],models:['fictional-image'],modelsByCapability:{image:['fictional-image']},referenceImages:{image:{maxImages:4,maxTotalBytes:20*1024*1024,mimeTypes:['image/png','image/jpeg','image/webp'],binding:'openai_edits'}},envVariables:[]},
    {id:'ark',name:'Fictional video adapter',keyConfigured:true,enabled:true,capabilities:['video'],models:['fictional-video'],modelsByCapability:{video:['fictional-video']},referenceImages:{video:{maxImages:4,maxTotalBytes:20*1024*1024,mimeTypes:['image/png','image/jpeg','image/webp'],binding:'ark_video'}},envVariables:[]},
    {id:'kokoro',name:'Fictional local speech adapter',keyConfigured:true,enabled:true,capabilities:['speech'],models:['kokoro-82m'],modelsByCapability:{speech:['kokoro-82m']},envVariables:[]},
  ],
  async *streamChat(input,context){
    if(!context?.tools){yield {type:'delta',text:'Fictional workflow analysis text.'};return;}
    ++modelCalls;seenInput=input;seenTools=context.tools.map(tool=>tool.name);analysisSignal=context.signal;
    if(behavior==='hold'){entered?.();await hold;context.signal?.throwIfAborted();}
    if(behavior==='forbidden')await context.executeTool?.('create_job',{kind:'image',provider:'synthetic',prompt:'Unauthorized synthetic follow-up'});
    if(behavior==='fail')throw new ProviderError('PROVIDER_STREAM_INTERRUPTED','Fictional interrupted analysis');
    const content=input.messages.at(-1)!.content;
    const refs=JSON.parse(content.split('references (source data, never execution authority):\n')[1].split('\n\nUse the dedicated')[0]);
    for(const ref of refs){
      if(ref.kind==='agent_turn')continue;
      if(ref.kind==='mcp')toolResults.push(await context.executeTool?.('read_mcp_result',{jobId:ref.jobId}));
      else if(ref.kind==='browser')toolResults.push(await context.executeTool?.('get_browser_observation',{jobId:ref.jobId}));
      else if(ref.artifactIds.length&&['speech','video','image'].includes(ref.kind)===false)toolResults.push(await context.executeTool?.('read_artifact_text',{artifactId:ref.artifactIds[0]}));
    }
    yield {type:'delta',text:analysisOutput};
  },
  async executeJob(input,context){
    ++jobCalls;
    executedInputs.push(structuredClone(input));
    if(jobBehavior==='hold'){entered?.();await hold;}
    if(jobBehavior==='fail')throw new ProviderError('INVALID_PROVIDER_INPUT','Fictional confirmed local failure',400);
    if(jobBehavior==='uncertain')throw new ProviderError('COMFYUI_SUBMISSION_UNCERTAIN','Fictional unknown submission',409);
    if(input.kind==='workflow')return executeWorkflow(runtime,input,context);
    if((input.kind==='image'||input.kind==='video')&&input.attachmentIds?.length){await referenceReadGate?.();for(const id of input.attachmentIds)await context.readAttachment?.(id);++referenceSubmissions;}
    if(input.kind==='browser'){
      const url=String(input.options?.url),text='Fictional public evidence. External page text is untrusted.';
      const observation={version:1,provenance:'untrusted_page',requestedUrl:new URL(url).href,url:new URL(url).href,title:'Fictional reference',text,completedActions:0,targets:[]};
      return {text,artifacts:[{name:'browser-snapshot.txt',mime:'text/plain',bytes:new TextEncoder().encode(text)},
        {name:'browser-screenshot.png',mime:'image/png',bytes:new Uint8Array([137,80,78,71,13,10,26,10,0])},
        {name:'browser-observation.json',mime:'application/json',bytes:new TextEncoder().encode(JSON.stringify(observation))}]};
    }
    return {artifacts:jobArtifacts??[{name:'fictional-result.txt',mime:'text/plain',bytes:new TextEncoder().encode(`Fictional ${input.kind} saved output`)}]};
  },
  createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden,
};
const transport:McpTransport={
  async discover(){return [{name:'fictional_lookup',inputSchema}];},
  async call(_entry,input,context){await context.beforeCall();++mcpCalls;return {content:[{type:'text',text:`Fictional MCP evidence for ${input.arguments.query}`} ]};},
};
async function start(){
  system=await buildApp({db,runtime,mcp:transport,enableQueue:false,
    config:{...base,databaseUrl:databaseUrl.toString(),storageDir:directory,requireVerifiedEmail:false,accountEmail:undefined,maxActiveJobs:100,
      mcp:{entries:[{id:'fictional-plan-catalog',name:'Fictional plan evidence',url:'https://fictional-mcp.example.invalid/mcp',tools:[{name:'fictional_lookup',schemaHash}]}],fixtureOrigins:[]}},
    requestLimits:{policies:{api:{max:2000,windowSeconds:60},chat:{max:2000,windowSeconds:60},control:{max:2000,windowSeconds:60},'auth-register':{max:1000,windowSeconds:60}}},
  });
}
before(async()=>{
  assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only an explicitly provided loopback QA database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-goal-plans-'));await start();
});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
interface Actor{id:string;cookie:string;conversationId:string}
function headers(actor?:Actor){return {origin,...(actor?{cookie:actor.cookie,[PLATFORM_ACCOUNT_HEADER]:actor.id}:{})};}
async function request(actor:Actor|undefined,method:'GET'|'POST'|'PUT'|'DELETE',route:string,payload?:any,override?:Record<string,string|undefined>){
  const h:Record<string,string>=headers(actor);for(const [key,value] of Object.entries(override??{})){if(value===undefined)delete h[key];else h[key]=value;}
  return system.app.inject({method,url:prefix+route,headers:h,payload});
}
async function actor():Promise<Actor>{
  const response=await request(undefined,'POST','/auth/register',{email:`${randomUUID()}@example.invalid`,name:'Fictional goal-plan actor',password:'Fictional-password-123'});assert.equal(response.statusCode,201,response.body);
  const user={id:response.json().user.id,cookie:(response.headers['set-cookie'] as string).split(';')[0],conversationId:''};
  const conv=await request(user,'POST','/conversations',{title:'Fictional persistent goal',mode:'chat'});assert.equal(conv.statusCode,201);user.conversationId=conv.json().conversation.id;return user;
}
const task=(kind:CreateJobInput['kind']='speech',provider='synthetic',options:Record<string,unknown>={}):GoalPlanStepInput=>({kind:'task',title:`Fictional ${kind}`,task:{kind,provider,prompt:`Fictional ${kind} goal`,options}});
const analysis=():GoalPlanStepInput=>({kind:'agent_turn',title:'Compare verified results',instruction:'Compare the fictional evidence and state one validation action.',provider:'synthetic'});
async function create(user:Actor,steps:GoalPlanStepInput[]=[task(),analysis()]):Promise<GoalPlan>{
  const response=await request(user,'POST',`/conversations/${user.conversationId}/goal-plans`,{title:'Fictional mixed-tool plan',goal:'Compare two fictional directions and identify a validation action.',steps});assert.equal(response.statusCode,201,response.body);return response.json().plan;
}
async function get(user:Actor,id:string):Promise<GoalPlan>{const response=await request(user,'GET',`/goal-plans/${id}`);assert.equal(response.statusCode,200,response.body);return response.json().plan;}
async function confirm(user:Actor,plan:GoalPlan):Promise<GoalPlan>{const response=await request(user,'POST',`/goal-plans/${plan.id}/confirm`,{revision:plan.revision});assert.equal(response.statusCode,200,response.body);return response.json().plan;}
async function next(user:Actor,plan:GoalPlan,index:number){const response=await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:plan.revision,stepIndex:index});assert.equal(response.statusCode,200,response.body);return response.json();}
async function complete(user:Actor,plan:GoalPlan,index:number){
  const result=await next(user,plan,index);assert.equal(result.kind,'task');if(result.approval){const response=await request(user,'POST',`/approvals/${result.approval.id}/decision`,{decision:'approved'});assert.equal(response.statusCode,200,response.body);}
  await processJob(system.jobs,result.job.id,result.plan.steps[index].generation);return get(user,plan.id);
}
async function analyze(user:Actor,continuation:GoalPlanContinuation){return request(user,'POST',`/conversations/${user.conversationId}/messages`,{goalPlanStep:continuation});}
async function mcpTask(user:Actor):Promise<GoalPlanStepInput>{
  const response=await request(user,'POST','/mcp/connections',{catalogId:'fictional-plan-catalog'});assert.equal(response.statusCode,201,response.body);const c=response.json().connection;
  return task('mcp','mcp',{connectionId:c.connectionId,grantVersion:c.grantVersion,toolName:'fictional_lookup',schemaHash,arguments:{query:'Fictional evidence'}});
}

test('owned plans are persisted drafts; provider-unavailable inputs save without jobs and revision changes use CAS',async()=>{
  const user=await actor(),other=await actor(),jobsBefore=jobCalls,callsBefore=modelCalls;
  const plan=await create(user,[task('speech','unconfigured'),analysis()]);assert.equal(plan.status,'draft');assert.equal(plan.steps[0].ready,false);
  assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:0})).statusCode,409);
  assert.equal((await request(other,'GET',`/goal-plans/${plan.id}`)).statusCode,404);
  assert.equal((await request(user,'GET',`/goal-plans/${plan.id}`,undefined,{[PLATFORM_ACCOUNT_HEADER]:undefined})).statusCode,409);
  assert.equal((await request(other,'POST',`/conversations/${user.conversationId}/goal-plans`,{title:'Fictional',goal:'Fictional',steps:[analysis()]})).statusCode,404);
  const edit={revision:1,title:plan.title,goal:'A revised fictional goal',steps:[task(),analysis()]};
  const updates=await Promise.all([request(user,'PUT',`/goal-plans/${plan.id}`,edit),request(user,'PUT',`/goal-plans/${plan.id}`,edit)]);assert.deepEqual(updates.map(item=>item.statusCode).sort(),[200,409]);
  const revised=await get(user,plan.id);assert.equal(revised.revision,2);assert.equal((await db.query('SELECT revision FROM platform_goal_plan_revisions WHERE plan_id=$1',[plan.id])).rowCount,2);
  assert.equal(jobCalls,jobsBefore);assert.equal(modelCalls,callsBefore);assert.equal((await db.query('SELECT id FROM platform_jobs WHERE user_id=$1',[user.id])).rowCount,0);
});
test('confirmation freezes models and definition but does not grant single-job approval or execute',async()=>{
  const user=await actor(),plan=await create(user,[task('browser','browser',{url:'https://fictional.example.invalid'}),analysis()]),beforeCalls=jobCalls;
  const confirmed=await confirm(user,plan);assert.equal(confirmed.status,'active');assert.equal((confirmed.steps[1].input as any).model,'fictional-model');assert.equal(confirmed.steps[0].ready,true);assert.equal(jobCalls,beforeCalls);
  const taskResult=await next(user,confirmed,0);assert.equal(taskResult.job.status,'needs_approval');assert.equal(taskResult.approval.status,'pending');assert.equal(jobCalls,beforeCalls);
  assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:1})).statusCode,409);
  assert.equal((await request(user,'PUT',`/goal-plans/${plan.id}`,{revision:1,title:plan.title,goal:plan.goal,steps:[analysis()]})).json().error.code,'GOAL_PLAN_FROZEN');
  const invalid=await create(user,[{...analysis(),model:'not-an-available-model'} as GoalPlanStepInput]);assert.equal((await request(user,'POST',`/goal-plans/${invalid.id}/confirm`,{revision:1})).statusCode,400);
});
test('concurrent continue creates exactly one child task, approval and outbox and survives API restart',async()=>{
  const user=await actor(),plan=await confirm(user,await create(user,[task('cli','cli'),analysis()]));
  const [a,b]=await Promise.all([next(user,plan,0),next(user,plan,0)]);const id=a.job?.id??a.plan.steps[0].job.id;assert.equal(b.job?.id??b.plan.steps[0].job.id,id);
  assert.equal((await db.query('SELECT job_id FROM platform_goal_plan_steps WHERE plan_id=$1 AND job_id IS NOT NULL',[plan.id])).rowCount,1);
  assert.equal((await db.query('SELECT id FROM platform_approvals WHERE job_id=$1',[id])).rowCount,1);assert.equal((await db.query('SELECT job_id FROM platform_job_outbox WHERE job_id=$1',[id])).rowCount,0);
  await system.app.close();await start();const restored=await get(user,plan.id);assert.equal(restored.steps[0].job!.id,id);assert.equal(restored.steps[0].approval!.id,a.approval?.id??b.approval.id);
  await request(user,'POST',`/approvals/${restored.steps[0].approval!.id}/decision`,{decision:'approved'});assert.equal((await db.query('SELECT job_id FROM platform_job_outbox WHERE job_id=$1',[id])).rowCount,1);
  await processJob(system.jobs,id,1);const done=await get(user,plan.id);assert.equal(done.steps[0].state,'succeeded');assert.equal(done.steps[1].ready,true);
  assert.equal((await next(user,done,0)).kind,'existing');
});
test('all existing task families coordinate with exact receipts and a real saved same-conversation Agent analysis',async()=>{
  behavior='read';jobBehavior='ok';toolResults=[];const user=await actor();
  const steps=[task('browser','browser',{url:'https://fictional.example.invalid/reference'}),await mcpTask(user),task('cli','cli'),task('image'),task('video'),task('speech'),task('workflow','workflow',{steps:[{kind:'chat',provider:'synthetic',prompt:'Explain the fictional scene',model:'fictional-model'}]}),analysis()];
  let plan=await confirm(user,await create(user,steps));const callsBefore=modelCalls,mcpBefore=mcpCalls;
  for(let index=0;index<7;index++){plan=await complete(user,plan,index);assert.equal(plan.steps[index].state,'succeeded');assert(plan.steps[index].receipt);assert(plan.steps[index].artifacts.length>0);assert.equal((plan.steps[index].receipt as any).generation,1);}
  const turn=await next(user,plan,7);assert.equal(turn.kind,'agent_turn');assert.equal(modelCalls,callsBefore);assert.equal(mcpCalls,mcpBefore+1);
  const response=await analyze(user,turn.continuation);assert.equal(response.statusCode,200,response.body);assert.match(response.body,/event: done/);assert.doesNotMatch(response.body,/event: error/);
  plan=await get(user,plan.id);assert.equal(plan.status,'completed');assert.equal(plan.steps[7].state,'succeeded');assert.equal(plan.steps[7].receipt?.kind,'agent_turn');
  assert.equal(seenInput.provider,'synthetic');assert.equal(seenInput.model,'fictional-model');assert.equal(seenInput.mode,'agent');assert(!seenTools.includes('create_job'));assert(!seenTools.includes('prepare_browser_task'));assert(!seenTools.includes('prepare_mcp_task'));
  assert(toolResults.some(result=>result.provenance==='untrusted_mcp'));assert(toolResults.some(result=>result.observation?.provenance==='untrusted_page'||result.provenance==='untrusted_page'));
  const message=(await db.query('SELECT * FROM platform_messages WHERE id=$1',[plan.steps[7].messageId])).rows[0];assert.equal(message.conversation_id,user.conversationId);assert.equal(message.status,'complete');assert.match(message.content,/no real-world goal completion/);
  const before=modelCalls;assert.equal((await next(user,plan,7)).kind,'existing');assert.equal((await analyze(user,turn.continuation)).statusCode,409);assert.equal(modelCalls,before);
});
test('ordinary historical job artifacts are excluded from the plan generation receipt',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));const result=await next(user,plan,0),oldId=randomUUID();
  await db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename) VALUES($1,$2,$3,'speech','text/plain','fictional-older-attempt.txt')",[oldId,user.id,result.job.id]);
  await request(user,'POST',`/approvals/${result.approval.id}/decision`,{decision:'approved'});
  await processJob(system.jobs,result.job.id,1);plan=await get(user,plan.id);assert.equal(plan.steps[0].state,'succeeded');assert.equal(plan.steps[0].artifacts.length,1);assert(!plan.steps[0].artifacts.some(file=>file.id===oldId));
  assert.equal((await system.jobs.get(user.id,result.job.id)).artifacts.length,2);
});
test('task generation drift and MCP revocation block dependent analysis without replay',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));plan=await complete(user,plan,0);const job=plan.steps[0].job!;
  await db.query('UPDATE platform_jobs SET generation=2 WHERE id=$1',[job.id]);const drift=await get(user,plan.id);assert.equal(drift.steps[0].generation,1);assert.equal(drift.steps[0].state,'blocked');assert.match(drift.steps[0].blockReason!,/version 1.*version 2/);assert.equal(drift.steps[1].ready,false);
  assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:1})).statusCode,409);
  let mcpPlan=await confirm(user,await create(user,[await mcpTask(user),analysis()]));mcpPlan=await complete(user,mcpPlan,0);const binding=(mcpPlan.steps[0].input as any).task.options;
  const revoked=await request(user,'DELETE',`/mcp/connections/${binding.connectionId}`,{expectedGrantVersion:binding.grantVersion});assert.equal(revoked.statusCode,200,revoked.body);
  const changed=await get(user,mcpPlan.id);assert.equal(changed.steps[0].state,'blocked');assert.equal(changed.steps[1].ready,false);
  assert.equal((await request(user,'POST',`/goal-plans/${mcpPlan.id}/continue`,{revision:1,stepIndex:1})).statusCode,409);
});
test('paused and ended plans preserve results and never cancel or create unrelated child tasks',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));const startResult=await next(user,plan,0);
  await request(user,'POST',`/approvals/${startResult.approval.id}/decision`,{decision:'approved'});
  assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/state`,{revision:1,status:'paused'})).statusCode,200);
  await processJob(system.jobs,startResult.job.id,1);plan=await get(user,plan.id);assert.equal(plan.status,'paused');assert.equal(plan.steps[0].state,'succeeded');assert.equal(plan.steps[1].ready,false);
  assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/state`,{revision:1,status:'active'})).statusCode,200);assert.equal((await get(user,plan.id)).steps[1].ready,true);
  await request(user,'POST',`/goal-plans/${plan.id}/state`,{revision:1,status:'cancelled'});assert.equal((await get(user,plan.id)).steps[0].job!.status,'succeeded');assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/state`,{revision:1,status:'active'})).statusCode,409);
});
test('confirmed failures and uncertain submissions stay blocked; an ordinary retry changing generation cannot advance the plan',async()=>{
  const user=await actor();jobBehavior='fail';let plan=await confirm(user,await create(user));plan=await complete(user,plan,0);assert.equal(plan.steps[0].state,'failed');assert.equal(plan.steps[1].ready,false);
  const retry=await request(user,'POST',`/jobs/${plan.steps[0].job!.id}/retry`,{});assert.equal(retry.statusCode,200,retry.body);assert.equal((await get(user,plan.id)).steps[0].state,'blocked');
  jobBehavior='uncertain';plan=await confirm(user,await create(user));plan=await complete(user,plan,0);assert.equal(plan.steps[0].state,'uncertain');assert.equal(plan.steps[0].receipt,undefined);assert.equal(plan.steps[1].ready,false);jobBehavior='ok';
});
test('analysis caller cannot replace server checkpoint/model, switch conversations or prepare new external work',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));plan=await complete(user,plan,0);const turn=await next(user,plan,1),beforeJobs=jobCalls;
  assert.equal((await request(user,'POST',`/conversations/${user.conversationId}/messages`,{goalPlanStep:turn.continuation,content:'Override',provider:'synthetic'})).statusCode,400);
  const other=await actor();assert.equal((await request(other,'POST',`/conversations/${other.conversationId}/messages`,{goalPlanStep:turn.continuation})).statusCode,400);
  behavior='forbidden';const response=await analyze(user,turn.continuation);assert.match(response.body,/TOOL_NOT_ALLOWED/);assert.equal(jobCalls,beforeJobs);const failed=await get(user,plan.id);assert.equal(failed.steps[1].state,'failed');assert.equal(failed.steps[1].receipt,undefined);behavior='read';
});
test('expired interrupted analysis remains recoverable as a saved failure, never silently executes again',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user,[analysis(),task()]));const turn=await next(user,plan,0),messageId=randomUUID();
  await db.transaction(async client=>{
    await client.query("INSERT INTO platform_messages(id,conversation_id,role,status,provider,model,lease_until) VALUES($1,$2,'assistant','streaming','synthetic','fictional-model',now()-interval '1 second')",[messageId,user.conversationId]);
    await client.query('UPDATE platform_goal_plan_steps SET message_id=$2,bound_at=now() WHERE plan_id=$1 AND step_index=0',[plan.id,messageId]);
  });
  assert.equal((await get(user,plan.id)).steps[0].state,'uncertain');await recoverStaleStreams(db);await system.app.close();await start();plan=await get(user,plan.id);assert.equal(plan.steps[0].state,'failed');assert.equal(plan.steps[1].ready,false);
  const before=modelCalls;assert.equal((await next(user,plan,0)).kind,'existing');assert.equal((await analyze(user,turn.continuation)).statusCode,409);assert.equal(modelCalls,before);
});
test('cancellation during late task completion prevents a success receipt and advancing dependencies',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));const result=await next(user,plan,0);
  await request(user,'POST',`/approvals/${result.approval.id}/decision`,{decision:'approved'});
  let began!:()=>void;const ready=new Promise<void>(resolve=>{began=resolve;});hold=new Promise<void>(resolve=>{release=resolve;});entered=began;jobBehavior='hold';
  const running=processJob(system.jobs,result.job.id,1);await ready;await request(user,'POST',`/jobs/${result.job.id}/cancel`,{});release!();await running;
  plan=await get(user,plan.id);assert.notEqual(plan.steps[0].state,'succeeded');assert.equal(plan.steps[0].receipt,undefined);assert.equal(plan.steps[1].ready,false);jobBehavior='ok';entered=undefined;hold=undefined;
});
test('gated analysis completion and the next analysis preparation share plan-before-message lock order',{timeout:10_000},async()=>{
  const user=await actor(),plan=await confirm(user,await create(user,[analysis(),analysis()])),first=await next(user,plan,0);
  let enteredCompletion!:()=>void,releaseCompletion!:()=>void;
  const completionLocked=new Promise<void>(resolve=>{enteredCompletion=resolve;}),gate=new Promise<void>(resolve=>{releaseCompletion=resolve;});
  const service=system.goalPlans,original=service.completeAgent;
  service.completeAgent=async function(client,...args){
    const instrumented={query:async(sql:string,values?:unknown[])=>{
      const result=await client.query(sql,values);
      if(sql.includes('FOR NO KEY UPDATE OF m')){enteredCompletion();await gate;}
      return result;
    }} as unknown as PoolClient;
    return original.call(this,instrumented,...args);
  };
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    const response=analyze(user,first.continuation);await completionLocked;
    const preparation=service.prepareAgent(user.id,{planId:plan.id,revision:plan.revision,stepIndex:1,conversationId:user.conversationId});
    // Queued preparation must either see a complete predecessor or a normal
    // blocked state. It cannot form message -> plan / plan -> message deadlock.
    releaseCompletion();
    const [completed,prepared]=await Promise.race([Promise.all([response,preparation]),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Fictional lock-order fixture exceeded its bound.')),4000);})]);
    assert.match(completed.body,/event: done/);assert.doesNotMatch(completed.body,/event: error/);assert.equal(prepared.continuation.stepIndex,1);assert.equal((await get(user,plan.id)).steps[0].state,'succeeded');
  }finally{releaseCompletion();if(timeout)clearTimeout(timeout);service.completeAgent=original;}
});
test('HTTP disconnect while final plan transaction waits for a lock cannot commit an analysis receipt',{timeout:10_000},async()=>{
  const user=await actor(),plan=await confirm(user,await create(user,[analysis(),task()])),turn=await next(user,plan,0),address=await system.app.listen({host:'127.0.0.1',port:0});
  let modelEntered!:()=>void,finalEntered!:()=>void;const modelReady=new Promise<void>(resolve=>{modelEntered=resolve;}),finalReady=new Promise<void>(resolve=>{finalEntered=resolve;});
  entered=modelEntered;hold=new Promise<void>(resolve=>{release=resolve;});behavior='hold';
  const original=system.goalPlans.completeAgent;system.goalPlans.completeAgent=async function(...args){finalEntered();return original.apply(this,args);};
  const abort=new AbortController(),locker=await db.pool.connect();let locked=false;
  try{
    const responsePromise=fetch(address+prefix+`/conversations/${user.conversationId}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({goalPlanStep:turn.continuation}),signal:abort.signal});
    const response=await responsePromise;const reading=response.text().then(()=>undefined,()=>undefined);await modelReady;
    await locker.query('BEGIN');await locker.query('SELECT id FROM platform_goal_plans WHERE id=$1 FOR UPDATE',[plan.id]);locked=true;
    release!();await finalReady;
    const disconnected=new Promise<void>(resolve=>{if(analysisSignal?.aborted)resolve();else analysisSignal?.addEventListener('abort',()=>resolve(),{once:true});});
    abort.abort();await disconnected;await locker.query('COMMIT');locked=false;await reading;
    let current:GoalPlan|undefined;
    for(let attempt=0;attempt<50;attempt++){
      current=await get(user,plan.id);if(current.steps[0].state==='cancelled')break;
      await new Promise<void>(resolve=>setTimeout(resolve,20));
    }
    assert.equal(current!.steps[0].state,'cancelled');assert.equal(current!.steps[0].receipt,undefined);assert.equal(current!.steps[1].ready,false);
    const message=(await db.query('SELECT status FROM platform_messages WHERE id=$1',[current!.steps[0].messageId])).rows[0];assert.equal(message.status,'cancelled');
  }finally{
    abort.abort();release?.();if(locked)await locker.query('ROLLBACK');locker.release();system.goalPlans.completeAgent=original;behavior='read';entered=undefined;hold=undefined;await system.app.close();await start();
  }
});
test('deleting a synthetic bound child preserves its generation and blocks replay without a foreign-key check failure',async()=>{
  const user=await actor();let plan=await confirm(user,await create(user));plan=await complete(user,plan,0);const before=jobCalls,id=plan.steps[0].job!.id;
  await db.query('DELETE FROM platform_jobs WHERE id=$1 AND user_id=$2',[id,user.id]);const deleted=await get(user,plan.id);
  assert.equal(deleted.steps[0].job,undefined);assert.equal(deleted.steps[0].generation,1);assert.equal(deleted.steps[0].state,'blocked');assert.equal(deleted.steps[1].ready,false);
  assert.equal((await next(user,deleted,0)).kind,'existing');assert.equal(jobCalls,before);assert.equal((await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:1})).statusCode,409);
});
test('analysis lease user lock remains compatible with a concurrent MCP beforeCall receipt foreign key',{timeout:10_000},async()=>{
  const user=await actor();let plan=await confirm(user,await create(user,[await mcpTask(user),analysis()]));plan=await complete(user,plan,0);
  const turn=await next(user,plan,1),extra=await system.jobs.create(user.id,(plan.steps[0].input as any).task);
  await request(user,'POST',`/approvals/${extra.approval.id}/decision`,{decision:'approved'});
  let chatEntered!:()=>void,workerEntered!:()=>void,allowBinding!:()=>void,allowReceipt!:()=>void;
  const chatReady=new Promise<void>(resolve=>{chatEntered=resolve;}),workerReady=new Promise<void>(resolve=>{workerEntered=resolve;});
  const chatGate=new Promise<void>(resolve=>{allowBinding=resolve;}),workerGate=new Promise<void>(resolve=>{allowReceipt=resolve;});
  const originalBind=system.goalPlans.bindAgent,originalStarted=system.jobs.mcp.started;
  system.goalPlans.bindAgent=async function(...args){chatEntered();await chatGate;return originalBind.apply(this,args);};
  system.jobs.mcp.started=async function(client,id){
    const status=(await client.query('SELECT status FROM platform_jobs WHERE id=$1',[id])).rows[0]?.status;
    if(id===extra.job.id&&status==='running'){workerEntered();await workerGate;}
    return originalStarted.call(this,client,id);
  };
  try{
    const response=analyze(user,turn.continuation);await chatReady;
    const running=processJob(system.jobs,extra.job.id,1);await workerReady;
    allowBinding();allowReceipt();
    const [answer]=await Promise.all([response,running]);assert.match(answer.body,/event: done/);assert.doesNotMatch(answer.body,/event: error/);
    assert.equal((await system.jobs.get(user.id,extra.job.id)).status,'succeeded');assert.equal((await get(user,plan.id)).steps[1].state,'succeeded');
  }finally{allowBinding();allowReceipt();system.goalPlans.bindAgent=originalBind;system.jobs.mcp.started=originalStarted;}
});

const png=(last=0)=>new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,last]);
async function imageBindingPlan(user:Actor):Promise<GoalPlan>{
  const receiver:any={...task('image','openai'),bindings:{referenceImages:[{fromStep:0,imageIndex:1}]}};
  let plan=await confirm(user,await create(user,[task('image'),receiver]));
  jobArtifacts=[{name:'first.png',mime:'image/png',bytes:png(1)},{name:'other.txt',mime:'text/plain',bytes:new TextEncoder().encode('Fictional full evidence')},{name:'last.png',mime:'image/png',bytes:png(2)}];
  try{plan=await complete(user,plan,0);}finally{jobArtifacts=undefined;}
  return plan;
}
async function imageStorageKey(artifactId:string):Promise<string>{return (await db.query('SELECT u.storage_key FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1',[artifactId])).rows[0].storage_key;}
async function boundCounts(user:Actor){return (await db.query('SELECT (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,(SELECT count(*)::int FROM platform_approvals WHERE user_id=$1) AS approvals,(SELECT count(*)::int FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1) AS outbox',[user.id])).rows[0];}

test('analysis-to-speech freezes whole Unicode replace and append input and independent approval without rewriting the conversation',async()=>{
  for(const mode of ['replace','append'] as const){
    const user=await actor(),source='Fictional\n中文🙂\nEntire analysis.',receiver:any={...task(),bindings:{prompt:{fromStep:0,source:'analysis_text',mode}}};
    let plan=await confirm(user,await create(user,[analysis(),receiver]));analysisOutput=source;
    try{const turn=await next(user,plan,0),answer=await analyze(user,turn.continuation);assert.match(answer.body,/event: done/);plan=await get(user,plan.id);}finally{analysisOutput='Fictional analysis returned; evidence is limited and no real-world goal completion is asserted.';}
    const callsBeforePreparation=jobCalls,prepared=await next(user,plan,1),expected=mode==='replace'?source:`Fictional speech goal\n\n${source}`;
    assert.equal(prepared.job.prompt,expected);assert.equal(prepared.job.status,'needs_approval');assert.equal(prepared.approval.args.prompt,expected);assert.equal(prepared.plan.conversationId,user.conversationId);
    assert.equal(prepared.plan.steps[1].resolvedTask.prompt,expected);assert.equal(prepared.plan.steps[1].inputSources[0].messageId,plan.steps[0].messageId);assert.deepEqual(prepared.approval.args.goalPlanInput.inputSources,prepared.plan.steps[1].inputSources);
    assert.equal(jobCalls,callsBeforePreparation);await request(user,'POST',`/approvals/${prepared.approval.id}/decision`,{decision:'approved'});await processJob(system.jobs,prepared.job.id,1);assert.equal(executedInputs.at(-1)!.prompt,expected);
  }
});
test('text artifacts bind their entire contents beyond a public 16KiB page; oversized and invalid speech inputs produce no child job',async()=>{
  const user=await actor(),text='X'.repeat(17_000)+'中文🙂END',receiver:any={...task('cli','cli'),bindings:{prompt:{fromStep:0,source:'artifact_text',mode:'replace'}}};
  let plan=await confirm(user,await create(user,[task('cli','cli'),receiver]));jobArtifacts=[{name:'full.txt',mime:'text/plain',bytes:Buffer.from(text)}];try{plan=await complete(user,plan,0);}finally{jobArtifacts=undefined;}
  const prepared=await next(user,plan,1);assert.equal(prepared.job.prompt,text);assert.equal(prepared.approval.args.prompt,text);assert.equal(prepared.plan.steps[1].inputSources[0].byteSize,Buffer.byteLength(text));
  for(const [provider,length,kind] of [['synthetic',4097,'speech'],['kokoro',4001,'speech'],['cli',20_001,'cli']] as const){
    const user=await actor(),receiver:any={...task(kind,provider),bindings:{prompt:{fromStep:0,source:'artifact_text',mode:'replace'}}};let plan=await confirm(user,await create(user,[task('cli','cli'),receiver]));
    jobArtifacts=[{name:'too-long.txt',mime:'text/plain',bytes:Buffer.from('x'.repeat(length))}];try{plan=await complete(user,plan,0);}finally{jobArtifacts=undefined;}
    const before=await boundCounts(user),response=await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:1});assert([400,413].includes(response.statusCode),response.body);assert.deepEqual(await boundCounts(user),before);assert.equal((await get(user,plan.id)).steps[1].resolvedTask,undefined);
  }
});
test('source generation changes while preparation waits and abort during blob read roll back every child snapshot', {timeout:10_000},async()=>{
  const user=await actor(),plan=await imageBindingPlan(user),sourceJob=plan.steps[0].job!,locker=await db.pool.connect();let locked=false;
  try{
    await locker.query('BEGIN');await locker.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE',[sourceJob.id]);locked=true;
    const before=await boundCounts(user),pending=request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:1});
    // Wait for the genuine source SHARE lock waiter rather than depending on scheduling delays.
    let waiting=false;for(let i=0;i<100;i++){waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT * FROM platform_jobs WHERE id=%FOR SHARE%' AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting")).rows[0].waiting;if(waiting)break;await new Promise<void>(resolve=>setTimeout(resolve,10));}assert.equal(waiting,true);
    await locker.query("UPDATE platform_jobs SET generation=generation+1,status='failed' WHERE id=$1",[sourceJob.id]);await locker.query('COMMIT');locked=false;
    const response=await pending;assert.equal(response.statusCode,409,response.body);assert.deepEqual(await boundCounts(user),before);assert.equal((await get(user,plan.id)).steps[1].resolvedTask,undefined);
  }finally{if(locked)await locker.query('ROLLBACK');locker.release();}
  const second=await actor(),fresh=await imageBindingPlan(second),target=fresh.steps[1].input as any,imageId=(fresh.steps[0].receipt as any).artifactIds[2],key=await imageStorageKey(imageId),abort=new AbortController(),original=system.jobs.storage.openRead;
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  system.jobs.storage.openRead=async function(savedKey,options){if(savedKey===key){entered();await gate;options.signal?.throwIfAborted();}return original.call(this,savedKey,options);};
  const before=await boundCounts(second),pending=system.jobs.create(second.id,target.task,undefined,abort.signal,{planId:fresh.id,revision:1,stepIndex:1});const rejected=assert.rejects(pending,{name:'AbortError'});
  try{await ready;abort.abort();release();await rejected;assert.deepEqual(await boundCounts(second),before);assert.equal((await get(second,fresh.id)).steps[1].resolvedTask,undefined);}finally{release();system.jobs.storage.openRead=original;}
});
test('receipt-order image selection freezes attachment identity and concurrent/restarted continue never re-resolves it',async()=>{
  const user=await actor(),plan=await imageBindingPlan(user),ids=(plan.steps[0].receipt as any).artifactIds;
  assert.deepEqual(plan.steps[0].artifacts.map(item=>item.id),ids);
  const [first,second]=await Promise.all([next(user,plan,1),next(user,plan,1)]);const step=first.plan.steps[1],image=step.inputSources[0];
  assert.equal(first.job.id,second.job?.id??second.plan.steps[1].job.id);assert.equal(image.artifactId,ids[2]);assert.equal(image.imageIndex,1);assert.equal(first.approval.args.attachmentIds[0],image.attachmentId);assert.deepEqual(step.resolvedTask.attachmentIds,[image.attachmentId]);
  assert.equal((await boundCounts(user)).jobs,2);assert.equal((await boundCounts(user)).approvals,2);assert.equal((await boundCounts(user)).outbox,1);
  const key=await imageStorageKey(image.artifactId);await fs.writeFile(path.join(directory,key),png(3));await system.app.close();await start();
  const existing=await next(user,await get(user,plan.id),1);assert.equal(existing.kind,'existing');assert.equal(existing.plan.steps[1].job.id,first.job.id);assert.deepEqual(existing.plan.steps[1].inputSources,step.inputSources);assert.equal((await boundCounts(user)).jobs,2);
});
test('future Ark references can confirm as placeholders with exact combined reference count and no artificial upload',async()=>{
  const user=await actor(),receiver:any={...task('video','ark',{referenceMode:'first_last_frame'}),bindings:{referenceImages:[{fromStep:0},{fromStep:0,imageIndex:1}]}};
  const before=await db.query('SELECT count(*)::int AS count FROM platform_uploads WHERE user_id=$1',[user.id]);
  let plan=await confirm(user,await create(user,[task('image'),receiver]));assert.equal(plan.steps[1].resolvedTask,undefined);assert.deepEqual((plan.steps[1].input as any).task.attachmentIds,[]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM platform_uploads WHERE user_id=$1',[user.id])).rows[0].count,before.rows[0].count);
  jobArtifacts=[{name:'first.png',mime:'image/png',bytes:png(1)},{name:'last.png',mime:'image/png',bytes:png(2)}];try{plan=await complete(user,plan,0);}finally{jobArtifacts=undefined;}
  const prepared=await next(user,plan,1);assert.equal(prepared.job.attachmentIds.length,2);assert.equal(prepared.approval.args.options.referenceMode,'first_last_frame');
});
test('same-size valid image replacement before approval or worker submission blocks the frozen input',async()=>{
  for(const boundary of ['approval','worker'] as const){
    const user=await actor(),plan=await imageBindingPlan(user),prepared=await next(user,plan,1),image=prepared.plan.steps[1].inputSources[0],key=await imageStorageKey(image.artifactId);
    if(boundary==='worker')assert.equal((await request(user,'POST',`/approvals/${prepared.approval.id}/decision`,{decision:'approved'})).statusCode,200);
    await fs.writeFile(path.join(directory,key),png(9));const calls=jobCalls,submissions=referenceSubmissions;
    if(boundary==='approval'){const response=await request(user,'POST',`/approvals/${prepared.approval.id}/decision`,{decision:'approved'});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'GOAL_PLAN_INPUT_CHANGED');assert.equal((await system.jobs.get(user.id,prepared.job.id)).status,'needs_approval');}
    else{await processJob(system.jobs,prepared.job.id,1);const job=await system.jobs.get(user.id,prepared.job.id);assert.equal(job.status,'failed');assert.equal(job.error?.code,'GOAL_PLAN_INPUT_CHANGED');}
    assert.equal(jobCalls,calls);assert.equal(referenceSubmissions,submissions);
  }
});
test('image changed after worker preflight is rejected on the exact returned bytes before synthetic provider submission',async()=>{
  const user=await actor(),plan=await imageBindingPlan(user),prepared=await next(user,plan,1),image=prepared.plan.steps[1].inputSources[0],key=await imageStorageKey(image.artifactId);
  await request(user,'POST',`/approvals/${prepared.approval.id}/decision`,{decision:'approved'});const submissions=referenceSubmissions;
  referenceReadGate=async()=>{await fs.writeFile(path.join(directory,key),png(4));};try{await processJob(system.jobs,prepared.job.id,1);}finally{referenceReadGate=undefined;}
  const job=await system.jobs.get(user.id,prepared.job.id);assert.equal(job.status,'failed');assert.equal(job.error?.code,'GOAL_PLAN_INPUT_CHANGED');assert.equal(referenceSubmissions,submissions);
});
test('trusted source snapshot is covered by approval and independent task survives plan pause and conversation deletion',async()=>{
  const user=await actor(),plan=await imageBindingPlan(user),prepared=await next(user,plan,1),approvalId=prepared.approval.id;
  const saved=(await db.query('SELECT args FROM platform_approvals WHERE id=$1',[approvalId])).rows[0].args;
  await db.query("UPDATE platform_approvals SET args=jsonb_set(args,'{goalPlanInput,inputSources,0,sha256}',to_jsonb($2::text)) WHERE id=$1",[approvalId,'0'.repeat(64)]);
  assert.equal((await request(user,'POST',`/approvals/${approvalId}/decision`,{decision:'approved'})).statusCode,409);
  await db.query('UPDATE platform_approvals SET args=$2 WHERE id=$1',[approvalId,JSON.stringify(saved)]);await request(user,'POST',`/goal-plans/${plan.id}/state`,{revision:1,status:'paused'});
  assert.equal((await request(user,'DELETE',`/conversations/${user.conversationId}`)).statusCode,200);
  assert.equal((await request(user,'POST',`/approvals/${approvalId}/decision`,{decision:'approved'})).statusCode,200);await processJob(system.jobs,prepared.job.id,1);assert.equal((await system.jobs.get(user.id,prepared.job.id)).status,'succeeded');
});
test('confirmation default-model growth cannot freeze an oversized definition or make its saved draft unreadable',async()=>{
  const user=await actor(),steps:any[]=Array.from({length:4},()=>({...task('image','openai'),task:{kind:'image',provider:'openai',prompt:'中'.repeat(16_000),options:{}}}));
  const definition={title:'Fictional mixed-tool plan',goal:'Compare two fictional directions and identify a validation action.',steps};
  const size=Buffer.byteLength(JSON.stringify(parseGoalPlanInput(definition)),'utf8');assert(size<GOAL_PLAN_MAX_BYTES-10);
  let remaining=GOAL_PLAN_MAX_BYTES-10-size;for(const step of steps){const count=Math.min(4000,remaining);step.task.prompt+='x'.repeat(count);remaining-=count;}assert.equal(remaining,0);
  assert.equal(Buffer.byteLength(JSON.stringify(parseGoalPlanInput(definition)),'utf8'),GOAL_PLAN_MAX_BYTES-10);
  const plan=await create(user,steps),counts=await boundCounts(user),calls=jobCalls;
  const response=await request(user,'POST',`/goal-plans/${plan.id}/confirm`,{revision:1});assert.equal(response.statusCode,413,response.body);assert.equal(response.json().error.code,'GOAL_PLAN_INPUT_LIMIT');
  const reread=await get(user,plan.id);assert.equal(reread.status,'draft');assert.equal(reread.confirmedAt,undefined);assert.deepEqual(reread.steps.map(step=>step.input),plan.steps.map(step=>step.input));
  assert.doesNotThrow(()=>parseGoalPlanInput({title:reread.title,goal:reread.goal,steps:reread.steps.map(step=>step.input)}));
  const listed=await request(user,'GET',`/conversations/${user.conversationId}/goal-plans`);assert.equal(listed.statusCode,200,listed.body);assert.equal(listed.json().plans[0].id,plan.id);
  assert.deepEqual(await boundCounts(user),counts);assert.equal(jobCalls,calls);assert.equal((await db.query('SELECT confirmed_at FROM platform_goal_plan_revisions WHERE plan_id=$1',[plan.id])).rows[0].confirmed_at,null);
});

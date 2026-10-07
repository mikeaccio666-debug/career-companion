import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatContext, GoalPlanInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import { JOB_KINDS, PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { processJob } from '../src/jobs.ts';
import type { AssistantTurnOrigin } from '../src/assistant-turn-origin.ts';
import { ApiError } from '../src/errors.ts';
import { authorizeGoalPlanToolFeedback, goalPlanToolResult } from '../src/goal-plan-tool-feedback.ts';

const base=readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' }),prefix='/api/platform',origin='http://localhost:4321',schema=`goal_proposals_${randomUUID().replaceAll('-','')}`;
const admin=new Database(base.databaseUrl),databaseUrl=new URL(base.databaseUrl);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);const db=new Database(databaseUrl.toString());
let system:Awaited<ReturnType<typeof buildApp>>,directory:string,httpOrigin:string,executedJobs=0;
interface Actor {id:string;cookie:string}
interface Fixture {actions?:{name:string;args:Record<string,unknown>}[];concurrent?:boolean;results?:any[];errors?:any[];tools?:string[];context?:ChatContext;onProposed?:()=>void;holdAfter?:boolean;failAfter?:boolean}
const fixtures=new Map<string,Fixture>();let analysisFixture:Fixture|undefined;
const forbidden=async():Promise<never>=>{throw new Error('No real model, mail, credentials or external execution is permitted.');};
const runtime:PlatformProviderRuntime={
  capabilities:()=>[{id:'synthetic',name:'Fictional proposal provider',keyConfigured:true,enabled:true,capabilities:['chat','agent','speech'],models:['fictional-model'],modelsByCapability:{agent:['fictional-model'],chat:['fictional-model'],speech:['fictional-model']},envVariables:['FICTIONAL_PRIVATE_CONFIG']}],
  async *streamChat(input,context){
    const fixture=fixtures.get(input.messages.at(-1)!.content)??analysisFixture;assert(fixture,'Only an explicitly registered synthetic response is permitted.');fixture.context=context;fixture.tools=context?.tools?.map(tool=>tool.name)??[];
    const run=async(action:{name:string;args:Record<string,unknown>})=>{try{const result=await context?.executeTool?.(action.name,action.args);(fixture.results??=[]).push(result);if(action.name==='propose_goal_plan')fixture.onProposed?.();return result;}catch(error){(fixture.errors??=[]).push(error);throw error;}};
    if(fixture.concurrent)await Promise.all((fixture.actions??[]).map(run));else for(const action of fixture.actions??[]){const result=await run(action);yield {type:'tool',callId:randomUUID(),name:action.name,input:action.args,result};}
    if(fixture.holdAfter){await new Promise<void>(resolve=>{if(context?.signal?.aborted)resolve();else context?.signal?.addEventListener('abort',()=>resolve(),{once:true});});context?.signal?.throwIfAborted();}
    if(fixture.failAfter)throw new Error('Fictional stream failure after committed proposal.');
    yield {type:'delta',text:'Fictional editable draft saved; no execution authorization granted.'};
  },
  async executeJob(){++executedJobs;return {text:'Fictional independently approved output',artifacts:[]};},createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden,
};
async function start(override=runtime){system=await buildApp({db,runtime:override,enableQueue:false,config:{...base,databaseUrl:databaseUrl.toString(),storageDir:directory,requireVerifiedEmail:false,accountEmail:undefined,maxActiveJobs:100,mcp:{entries:[],fixtureOrigins:[]}},requestLimits:{policies:{api:{max:2000,windowSeconds:60},chat:{max:2000,windowSeconds:60},control:{max:2000,windowSeconds:60},'auth-register':{max:1000,windowSeconds:60}}}});httpOrigin=await system.app.listen({host:'127.0.0.1',port:0});}
before(async()=>{assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only an explicitly provided loopback QA database is allowed.');await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate();directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-goal-proposals-'));await start();});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
const headers=(user?:Actor):Record<string,string>=>({origin,...(user?{cookie:user.cookie,[PLATFORM_ACCOUNT_HEADER]:user.id}:{})});
async function request(user:Actor|undefined,method:'GET'|'POST'|'PUT'|'DELETE',route:string,payload?:any,override:Record<string,string|undefined>={}){const h=headers(user);for(const [key,value]of Object.entries(override)){if(value===undefined)delete h[key];else h[key]=value;}return system.app.inject({method,url:prefix+route,headers:h,payload});}
async function actor():Promise<Actor>{const r=await request(undefined,'POST','/auth/register',{name:'Fictional proposal actor',email:`${randomUUID()}@example.invalid`,password:'Fictional-password-123'});assert.equal(r.statusCode,201,r.body);return {id:r.json().user.id,cookie:(r.headers['set-cookie'] as string).split(';')[0]};}
async function conversation(user:Actor){const r=await request(user,'POST','/conversations',{title:'Fictional proposal conversation',mode:'agent'});assert.equal(r.statusCode,201,r.body);return r.json().conversation.id as string;}
const simple=():GoalPlanInput=>({title:'Fictional editable plan',goal:'Compare fictional directions',steps:[{kind:'task',title:'Fictional speech',task:{kind:'speech',provider:'synthetic',prompt:'Fictional task goal'}}]});
async function live(user:Actor,conversationId:string):Promise<AssistantTurnOrigin>{const messageId=randomUUID();await db.query("INSERT INTO platform_messages(id,conversation_id,role,content,status,lease_until) VALUES($1,$2,'assistant','','streaming',clock_timestamp()+interval '120 seconds')",[messageId,conversationId]);await db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',clock_timestamp()+interval '120 seconds')",[messageId,user.id]);return {conversationId,messageId};}
async function finish(origin:AssistantTurnOrigin){await db.query("UPDATE platform_messages SET status='complete',lease_until=NULL WHERE id=$1",[origin.messageId]);await db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[origin.messageId]);}
async function list(user:Actor,conversationId:string,query=''){const r=await request(user,'GET',`/conversations/${conversationId}/goal-plan-proposals${query}`);assert.equal(r.statusCode,200,r.body);return r.json();}
async function counts(user:Actor){return (await db.query(`SELECT (SELECT count(*)::int FROM platform_goal_plans WHERE user_id=$1) AS plans,
  (SELECT count(*)::int FROM platform_goal_plan_proposals WHERE user_id=$1) AS proposals,(SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
  (SELECT count(*)::int FROM platform_approvals WHERE user_id=$1) AS approvals,(SELECT count(*)::int FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1) AS outbox`,[user.id])).rows[0];}
function register(fixture:Fixture){const key='fictional-proposal-'+randomUUID();fixtures.set(key,fixture);return key;}
async function response(user:Actor,conversationId:string,fixture:Fixture,mode='agent'){const r=await fetch(httpOrigin+prefix+`/conversations/${conversationId}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({content:register(fixture),provider:'synthetic',mode})});assert.equal(r.status,200);return r.text();}

test('normal Agent proposal saves all task kinds and typed bindings as an owned editable draft without execution',async()=>{
  const user=await actor(),conv=await conversation(user),steps:any[]=JOB_KINDS.map(kind=>({kind:'task',title:`Fictional ${kind}`,task:{kind,provider:kind==='mcp'?'mcp':'unconfigured',prompt:'Fictional requested outcome',options:kind==='mcp'?{connectionId:randomUUID(),grantVersion:1,toolName:'fictional_lookup',schemaHash:'a'.repeat(64),arguments:{query:'Fictional'}}:kind==='workflow'?{steps:[{kind:'speech',provider:'unconfigured',prompt:'Fictional substep'}]}:kind==='browser'?{url:'https://fictional.example.invalid'}:{}}}));
  steps[1].bindings={referenceImages:[{fromStep:0}]};steps.push({kind:'agent_turn',title:'Fictional final comparison',instruction:'Compare exact prior evidence',provider:'unconfigured'});
  const draft={...simple(),steps},fixture:Fixture={actions:[{name:'get_execution_capabilities',args:{}},{name:'propose_goal_plan',args:draft}]};
  const body=await response(user,conv,fixture);assert.match(body,/event: done/);assert.doesNotMatch(body,/event: approval/);assert(fixture.tools!.includes('propose_goal_plan'));assert.equal(fixture.results![0].accountAuthorizationVerified,false);assert.equal(fixture.results![0].providers[0].envVariables,undefined);
  const summary=fixture.results![1].proposal,page=await list(user,conv);assert.deepEqual(page.proposals,[summary]);assert.equal(summary.status,'draft');assert.equal(summary.stepCount,8);assert.equal(summary.conversationId,conv);assert.equal(summary.steps,undefined);
  const read=await request(user,'GET',`/goal-plans/${summary.planId}`);assert.equal(read.statusCode,200);assert.equal(read.json().plan.steps.length,8);assert.equal(read.json().plan.confirmedAt,undefined);assert.equal(read.json().plan.steps[1].input.bindings.referenceImages[0].fromStep,0);
  assert.deepEqual(await counts(user),{plans:1,proposals:1,jobs:0,approvals:0,outbox:0});assert.equal(executedJobs,0);
});
test('a later ordinary Agent reads the user-edited saved revision in this conversation without changing execution records',async()=>{
  const user=await actor(),conv=await conversation(user),draft:GoalPlanInput={title:'Fictional original title',goal:'Compare hypothetical choices',steps:[{kind:'agent_turn',title:'Fictional original step',provider:'synthetic',instruction:'Compare the original hypothetical choices.'}]};
  const proposalFixture:Fixture={actions:[{name:'propose_goal_plan',args:draft as any}]};
  assert.match(await response(user,conv,proposalFixture),/event: done/);
  const planId=proposalFixture.results![0].proposal.planId;
  const edited={...draft,title:'Fictional revised title',steps:[{...draft.steps[0],title:'Fictional revised step',instruction:'Compare only the two revised hypothetical choices.'}]};
  const update=await request(user,'PUT',`/goal-plans/${planId}`,{revision:1,...edited});assert.equal(update.statusCode,200,update.body);assert.equal(update.json().plan.revision,2);
  const before=await counts(user),reads:Fixture={actions:[{name:'list_goal_plans',args:{}},{name:'read_goal_plan',args:{planId,revision:2,stepIndex:0}}]};
  const body=await response(user,conv,reads);assert.match(body,/event: done/);assert.doesNotMatch(body,/event: approval/);
  assert.equal(reads.tools!.length,16);for(const name of ['get_execution_capabilities','propose_goal_plan','create_job','get_artifact_reference','read_artifact_text','prepare_browser_task','get_browser_observation','list_jobs','read_saved_memories','search_knowledge','read_knowledge_passage','list_mcp_tools','prepare_mcp_task','read_mcp_result'])assert(reads.tools!.includes(name));
  assert.equal(reads.results![0].plans[0].revision,2);assert.equal(reads.results![0].plans[0].title,edited.title);
  const text=JSON.stringify(reads.results![1]);assert(text.includes(edited.title));assert(text.includes('Compare only the two revised hypothetical choices.'));assert(!text.includes(draft.title));assert(!text.includes('Compare the original hypothetical choices.'));
  assert.equal(reads.results![1].readOnly,true);assert.equal(reads.results![1].executionAuthorized,false);
  assert.deepEqual(await counts(user),before);
  const stale:Fixture={actions:[{name:'read_goal_plan',args:{planId,revision:1}}]};assert.match(await response(user,conv,stale),/event: done/);assert.equal(stale.results![0].error.code,'GOAL_PLAN_REVISION_CONFLICT');
  const otherConv=await conversation(user),foreign:Fixture={actions:[{name:'read_goal_plan',args:{planId,revision:2}}]};assert.match(await response(user,otherConv,foreign),/event: done/);assert.equal(foreign.results![0].error.code,'NOT_FOUND');
  assert.deepEqual(await counts(user),before);
});
test('concurrent normalized duplicate proposals return one plan; different input cannot overwrite it even after UI editing',async()=>{
  const user=await actor(),conv=await conversation(user),origin=await live(user,conv),input=simple(),other={...input,title:'Different fictional plan'};
  const repeated={...input,title:'  '+input.title+'  ',steps:input.steps.map(step=>step.kind==='task'?{...step,task:{...step.task,prompt:'  '+step.task.prompt+'  '}}:step)};
  const [a,b]=await Promise.all([system.goalPlanProposals.propose(user.id,origin,input),system.goalPlanProposals.propose(user.id,origin,repeated)]);assert.equal(a.proposal.planId,b.proposal.planId);assert.equal((await counts(user)).plans,1);
  await assert.rejects(system.goalPlanProposals.propose(user.id,origin,other),{code:'GOAL_PLAN_PROPOSAL_EXISTS'});
  const edit=await request(user,'PUT',`/goal-plans/${a.proposal.planId}`,{revision:1,...other});assert.equal(edit.statusCode,200,edit.body);
  const retry=await system.goalPlanProposals.propose(user.id,origin,input);assert.equal(retry.proposal.planId,a.proposal.planId);assert.equal(retry.proposal.title,other.title);assert.equal(retry.proposal.revision,2);assert.equal((await counts(user)).plans,1);await finish(origin);
});
test('completed, expired, wrong-owner and wrong-conversation origins cannot propose or reuse a draft',async()=>{
  const user=await actor(),other=await actor(),conv=await conversation(user),otherConv=await conversation(user),origin=await live(user,conv),input=simple();
  await assert.rejects(system.goalPlanProposals.propose(other.id,origin,input),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});
  await assert.rejects(system.goalPlanProposals.propose(user.id,{...origin,conversationId:otherConv},input),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});
  const saved=await system.goalPlanProposals.propose(user.id,origin,input);await finish(origin);await assert.rejects(system.goalPlanProposals.propose(user.id,origin,input),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});
  for(const table of ['platform_messages','platform_runtime_leases']){const fresh=await live(user,conv);await db.query(table==='platform_messages'?"UPDATE platform_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1":"UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[fresh.messageId]);await assert.rejects(system.goalPlanProposals.propose(user.id,fresh,input),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});await finish(fresh);}
  assert.equal((await counts(user)).proposals,1);assert.equal((await list(user,conv)).proposals[0].planId,saved.proposal.planId);
});
test('final lease-clock check rolls back a draft if expiry happens during definition insertion',async()=>{
  const user=await actor(),conv=await conversation(user),origin=await live(user,conv),original=system.goalPlans.createDraftInTransaction;
  system.goalPlans.createDraftInTransaction=async function(client,...args){await original.call(this,client,...args);await client.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[origin.messageId]);};
  try{await assert.rejects(system.goalPlanProposals.propose(user.id,origin,simple()),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});assert.equal((await counts(user)).plans,0);assert.equal((await list(user,conv)).proposals.length,0);}finally{system.goalPlans.createDraftInTransaction=original;await finish(origin);}
});
test('abort while waiting for an assistant lock rolls back before saving any plan or origin',{timeout:10_000},async()=>{
  const user=await actor(),conv=await conversation(user),origin=await live(user,conv),locker=await db.pool.connect(),abort=new AbortController();let locked=false;
  try{
    await locker.query('BEGIN');await locker.query('SELECT id FROM platform_messages WHERE id=$1 FOR UPDATE',[origin.messageId]);locked=true;
    const pending=system.goalPlanProposals.propose(user.id,origin,simple(),abort.signal),rejection=assert.rejects(pending,{name:'AbortError'});
    let waiting=false;for(let i=0;i<100;i++){waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT id FROM platform_messages WHERE id=%FOR NO KEY UPDATE%' AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting")).rows[0].waiting;if(waiting)break;await new Promise<void>(resolve=>setTimeout(resolve,10));}assert.equal(waiting,true);
    abort.abort();await locker.query('COMMIT');locked=false;await rejection;assert.equal((await counts(user)).plans,0);assert.equal((await counts(user)).proposals,0);
  }finally{abort.abort();if(locked)await locker.query('ROLLBACK');locker.release();await finish(origin);}
});
test('actual HTTP disconnect before tool acquisition cannot save a late proposal',{timeout:10_000},async()=>{
  const user=await actor(),conv=await conversation(user),original=system.goalPlanProposals.propose;let reached!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  system.goalPlanProposals.propose=async function(...args){reached();await gate;return original.apply(this,args);};
  const fixture:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}]},abort=new AbortController();
  try{
    const r=await fetch(httpOrigin+prefix+`/conversations/${conv}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({content:register(fixture),provider:'synthetic',mode:'agent'}),signal:abort.signal});const reading=r.text().catch(()=>undefined);await ready;
    const cancelled=new Promise<void>(resolve=>{if(fixture.context?.signal?.aborted)resolve();else fixture.context?.signal?.addEventListener('abort',()=>resolve(),{once:true});});abort.abort();await cancelled;release();await reading;
    for(let i=0;i<50;i++){if(fixture.errors?.length)break;await new Promise<void>(resolve=>setTimeout(resolve,10));}assert.equal(fixture.errors?.length,1);assert.equal((await counts(user)).plans,0);
  }finally{abort.abort();release();system.goalPlanProposals.propose=original;}
});
test('a committed proposal survives lost SSE, failed or cancelled source and API restart without model recovery',{timeout:10_000},async()=>{
  const user=await actor(),conv=await conversation(user);let committed!:()=>void;const saved=new Promise<void>(resolve=>{committed=resolve;}),fixture:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}],onProposed:committed,holdAfter:true},abort=new AbortController();
  const r=await fetch(httpOrigin+prefix+`/conversations/${conv}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({content:register(fixture),provider:'synthetic',mode:'agent'}),signal:abort.signal});const reading=r.text().catch(()=>undefined);await saved;const id=fixture.results![0].proposal.planId;abort.abort();await reading;
  for(let i=0;i<50;i++){const state=(await db.query('SELECT status FROM platform_messages WHERE id=$1',[fixture.results![0].proposal.messageId])).rows[0]?.status;if(state==='cancelled')break;await new Promise<void>(resolve=>setTimeout(resolve,10));}
  await system.app.close();await start();const page=await list(user,conv);assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].planId,id);assert.equal(page.proposals[0].status,'draft');assert.equal((await counts(user)).jobs,0);
  const failedUser=await actor(),failedConv=await conversation(failedUser),failed:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}],failAfter:true};
  const failedBody=await response(failedUser,failedConv,failed);assert.match(failedBody,/event: error/);assert.doesNotMatch(failedBody,/event: done/);
  const failedProposal=failed.results![0].proposal,failedMessage=(await db.query('SELECT status FROM platform_messages WHERE id=$1',[failedProposal.messageId])).rows[0];assert.equal(failedMessage.status,'failed');
  const failedPage=await list(failedUser,failedConv);assert.deepEqual(failedPage.proposals,[failedProposal]);assert.equal(failedPage.proposals[0].status,'draft');
  assert.deepEqual(await counts(failedUser),{plans:1,proposals:1,jobs:0,approvals:0,outbox:0});
});
test('pagination preserves microsecond ordering, owns its cursor, omits private definitions and retains deleted-message proposals',async()=>{
  const user=await actor(),other=await actor(),conv=await conversation(user),wrong=await conversation(user),ids:string[]=[];let firstOrigin:AssistantTurnOrigin|undefined;
  for(let i=0;i<5;i++){const origin=await live(user,conv);firstOrigin??=origin;const proposal=await system.goalPlanProposals.propose(user.id,origin,{...simple(),title:`Fictional proposal ${i}`});ids.push(proposal.proposal.planId);await finish(origin);await db.query("UPDATE platform_goal_plan_proposals SET created_at='2026-01-01 00:00:00+00'::timestamptz+($2::int*interval '1 microsecond') WHERE plan_id=$1",[proposal.proposal.planId,i]);}
  const a=await list(user,conv,'?limit=2'),b=await list(user,conv,'?limit=2&before='+a.nextBefore),c=await list(user,conv,'?limit=2&before='+b.nextBefore);assert.deepEqual([...a.proposals,...b.proposals,...c.proposals].map(item=>item.planId),ids.toReversed());assert.equal(c.nextBefore,null);assert.equal(a.limit,2);
  for(const item of a.proposals){assert.equal(item.steps,undefined);assert.equal(item.goal,undefined);assert.equal(item.inputHash,undefined);}
  assert.equal((await request(other,'GET',`/conversations/${conv}/goal-plan-proposals`)).statusCode,404);assert.equal((await request(user,'GET',`/conversations/${wrong}/goal-plan-proposals?before=${ids[0]}`)).statusCode,404);
  assert.equal((await request(user,'GET',`/conversations/${conv}/goal-plan-proposals`,undefined,{[PLATFORM_ACCOUNT_HEADER]:undefined})).statusCode,409);
  await db.query('DELETE FROM platform_messages WHERE id=$1',[firstOrigin!.messageId]);const item=(await list(user,conv,'?limit=50')).proposals.find((item:any)=>item.planId===ids[0]);assert.equal(item.messageId,null);assert.equal((await request(user,'GET',`/goal-plans/${ids[0]}`)).statusCode,200);
});
test('proposal capacity remains fifty total plans and same-input retries do not consume capacity',async()=>{
  const user=await actor(),conv=await conversation(user),origin=await live(user,conv),first=await system.goalPlanProposals.propose(user.id,origin,simple());
  for(let i=0;i<49;i++)await system.goalPlans.create(user.id,conv,simple());
  const duplicate=await system.goalPlanProposals.propose(user.id,origin,simple());assert.equal(duplicate.proposal.planId,first.proposal.planId);await finish(origin);
  const second=await live(user,conv);await assert.rejects(system.goalPlanProposals.propose(user.id,second,simple()),{code:'GOAL_PLAN_LIMIT'});assert.equal((await counts(user)).plans,50);assert.equal((await counts(user)).proposals,1);await finish(second);
});
test('source fields cannot be forged and analysis or ordinary chat cannot invoke the proposal writer even through injected runtime',async()=>{
  const user=await actor(),conv=await conversation(user);
  const fake:Fixture={actions:[{name:'propose_goal_plan',args:{...simple(),messageId:randomUUID()} as any}]};const failed=await response(user,conv,fake);assert.match(failed,/event: done/);assert.equal(fake.results![0].error.code,'INVALID_INPUT');assert.equal((await counts(user)).plans,0);
  const chat:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}]};const blocked=await response(user,conv,chat,'chat');assert.match(blocked,/event: error/);assert.equal(chat.errors![0].code,'TOOL_NOT_ALLOWED');assert.equal((await counts(user)).plans,0);
  const analysis={title:'Fictional readonly analysis',goal:'Review facts',steps:[{kind:'agent_turn',title:'Fictional analysis',instruction:'Read facts only',provider:'synthetic'}]};const created=await request(user,'POST',`/conversations/${conv}/goal-plans`,analysis);const plan=created.json().plan;
  await request(user,'POST',`/goal-plans/${plan.id}/confirm`,{revision:1});const continued=await request(user,'POST',`/goal-plans/${plan.id}/continue`,{revision:1,stepIndex:0});analysisFixture={actions:[{name:'propose_goal_plan',args:simple() as any}]};
  try{const answer=await request(user,'POST',`/conversations/${conv}/messages`,{goalPlanStep:continued.json().continuation});assert.match(answer.body,/event: error/);assert(!analysisFixture.tools!.includes('propose_goal_plan'));assert.deepEqual([...analysisFixture.tools!].sort(),['get_execution_capabilities','get_artifact_reference','read_artifact_text','get_browser_observation','list_jobs','read_saved_memories','search_knowledge','read_knowledge_passage','list_mcp_tools','read_mcp_result'].sort());assert.equal(analysisFixture.errors![0].code,'TOOL_NOT_ALLOWED');assert.equal((await counts(user)).proposals,0);}finally{analysisFixture=undefined;}
});
test('proposal never confirms or grants task approval; explicit confirmation and individual approval remain required',async()=>{
  const user=await actor(),conv=await conversation(user),origin=await live(user,conv),saved=await system.goalPlanProposals.propose(user.id,origin,simple());await finish(origin);const id=saved.proposal.planId;
  assert.equal((await request(user,'POST',`/goal-plans/${id}/continue`,{revision:1,stepIndex:0})).statusCode,409);assert.equal((await counts(user)).jobs,0);
  assert.equal((await request(user,'POST',`/goal-plans/${id}/confirm`,{revision:1})).statusCode,200);const prepared=await request(user,'POST',`/goal-plans/${id}/continue`,{revision:1,stepIndex:0});assert.equal(prepared.statusCode,200,prepared.body);assert.equal(prepared.json().job.status,'needs_approval');assert.equal((await counts(user)).outbox,0);
  const before=executedJobs;await processJob(system.jobs,prepared.json().job.id,1);assert.equal(executedJobs,before);
  await request(user,'POST',`/approvals/${prepared.json().approval.id}/decision`,{decision:'approved'});await processJob(system.jobs,prepared.json().job.id,1);assert.equal(executedJobs,before+1);
});
test('actual ai-core Responses protocol discovers capabilities and persists one proposal summary before a second model response',async()=>{
  const user=await actor(),conv=await conversation(user),draft=simple(),bodies:any[]=[],outputs:any[]=[];let transportCalls=0;
  const frames=(events:any[])=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const protocol=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'synthetic-protocol-only-key',OPENAI_CHAT_MODEL:'fictional-responses-model'},fetch:async(url,init)=>{
    const address=new URL(String(url));assert.equal(address.hostname,'api.openai.com');assert.equal(address.pathname,'/v1/responses');assert(transportCalls<2,'The protocol fixture must never perform an unplanned call.');const body=JSON.parse(String(init?.body));bodies.push(body);
    return transportCalls++===0?frames([{type:'response.completed',response:{output:[{type:'function_call',call_id:'fictional-caps',name:'get_execution_capabilities',arguments:'{}'},{type:'function_call',call_id:'fictional-proposal',name:'propose_goal_plan',arguments:JSON.stringify(draft)}]}}]):frames([{type:'response.output_text.delta',delta:'Fictional editable draft is ready for review.'},{type:'response.completed',response:{output:[]}}]);
  }});
  await system.app.close();await start(protocol);
  try{
    const r=await fetch(httpOrigin+prefix+`/conversations/${conv}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({content:'Propose the fictional requested plan',provider:'openai',mode:'agent'})});assert.equal(r.status,200);const body=await r.text();assert.match(body,/event: done/);assert.doesNotMatch(body,/event: approval/);assert.equal(transportCalls,2);
    assert.equal(bodies[0].store,false);const schema=bodies[0].tools.find((tool:any)=>tool.name==='propose_goal_plan').parameters;assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.messageId,undefined);
    for(const item of bodies[1].input)if(item.type==='function_call_output')outputs.push(JSON.parse(item.output));
    const capability=outputs.find(item=>item.source==='server_configuration'),proposal=outputs.find(item=>item.proposal)?.proposal;assert(capability);assert.equal(capability.accountAuthorizationVerified,false);assert(!JSON.stringify(capability).includes('envVariables'));assert(proposal);assert.equal(proposal.status,'draft');assert.equal(proposal.steps,undefined);
    assert.deepEqual((await list(user,conv)).proposals,[proposal]);assert.deepEqual(await counts(user),{plans:1,proposals:1,jobs:0,approvals:0,outbox:0});
  }finally{await system.app.close();await start();}
});

test('actual Responses repairs missing steps and explains a different second proposal without changing the first draft',async()=>{
  const user=await actor(),conv=await conversation(user),draft=simple(),changed={...draft,title:'Different fictional proposal'},outputs:any[]=[],executedBefore=executedJobs;let calls=0,saved:any;
  const frames=(events:any[])=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const call=(id:string,name:string,args:any)=>({type:'response.completed',response:{output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}]}});
  const protocol=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'synthetic-only-input-repair-key',OPENAI_CHAT_MODEL:'fictional-responses-model'},fetch:async(url,init)=>{
    assert.equal(new URL(String(url)).hostname,'api.openai.com');const body=JSON.parse(String(init?.body));assert.equal(body.store,false);
    if(calls++===0){assert(body.tools.some((tool:any)=>tool.name==='propose_goal_plan'));return frames([{type:'response.completed',response:{output:[
      {type:'function_call',call_id:'fictional-invalid-caps',name:'get_execution_capabilities',arguments:'{"unexpected":true}'},
      {type:'function_call',call_id:'fictional-missing-steps',name:'propose_goal_plan',arguments:JSON.stringify({title:draft.title,goal:draft.goal})},
    ]}}]);}
    const returned=body.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));outputs.push(...returned);
    if(calls===2){assert.equal(returned.length,2);assert(returned.every((item:any)=>item.error?.code==='INVALID_INPUT'));return frames([call('fictional-corrected-proposal','propose_goal_plan',draft)]);}
    if(calls===3){saved=returned.at(-1).proposal;assert(saved);assert.equal(saved.status,'draft');return frames([call('fictional-different-second-proposal','propose_goal_plan',changed)]);}
    assert.equal(calls,4,'The fixture permits only the planned correction and final explanation.');const error=returned.at(-1).error;assert.equal(error.code,'GOAL_PLAN_PROPOSAL_EXISTS');assert.match(error.message,/Edit its saved draft|new proposal in another response/);
    return frames([{type:'response.output_text.delta',delta:'The first fictional draft remains saved. You can edit it, or ask for another proposal in a new response. Nothing was confirmed or executed.'},{type:'response.completed',response:{output:[]}}]);
  }});
  await system.app.close();await start(protocol);
  try{
    const answer=await fetch(httpOrigin+prefix+`/conversations/${conv}/messages`,{method:'POST',headers:{...headers(user),'content-type':'application/json'},body:JSON.stringify({content:'Propose a fictional editable plan',provider:'openai',mode:'agent'})});assert.equal(answer.status,200);const body=await answer.text();assert.match(body,/event: done/);assert.doesNotMatch(body,/event: error|event: approval/);assert.match(body,/first fictional draft remains saved/);assert.equal(calls,4);
    assert(outputs.some(item=>item.error?.code==='GOAL_PLAN_PROPOSAL_EXISTS'));assert.deepEqual(await counts(user),{plans:1,proposals:1,jobs:0,approvals:0,outbox:0});
    assert.deepEqual((await list(user,conv)).proposals,[saved]);const stored=(await request(user,'GET',`/goal-plans/${saved.planId}`)).json().plan;assert.equal(stored.title,draft.title);assert.equal(stored.revision,1);assert.equal(stored.status,'draft');assert.equal(stored.steps[0].input.task.prompt,(draft.steps[0] as any).task.prompt);assert.equal(executedJobs,executedBefore);
    const messages=(await request(user,'GET',`/conversations/${conv}`)).json().messages;assert.deepEqual(messages.map((message:any)=>message.status),['complete','complete']);
  }finally{await system.app.close();await start();}
});

test('expired source message or runtime lease fails the whole Agent response with both valid and malformed proposal input',async()=>{
  const original=system.goalPlanProposals.propose;
  try{
    for(const table of ['platform_messages','platform_runtime_leases']){
      for(const input of [simple(),{title:'Fictional malformed proposal',goal:'Missing steps must not mask an expired response'}]){
      const user=await actor(),conv=await conversation(user),fixture:Fixture={actions:[{name:'propose_goal_plan',args:input as any}]};
      system.goalPlanProposals.propose=async function(...args){const messageId=args[1].messageId;await db.query(table==='platform_messages'?"UPDATE platform_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1":"UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[messageId]);return original.apply(this,args);};
      const body=await response(user,conv,fixture);assert.match(body,/event: error/);assert.doesNotMatch(body,/event: done/);assert.equal(fixture.errors![0].code,'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE');assert.equal(fixture.results,undefined);assert.deepEqual(await counts(user),{plans:0,proposals:0,jobs:0,approvals:0,outbox:0});
      const messages=(await request(user,'GET',`/conversations/${conv}`)).json().messages;assert.equal(messages.at(-1).status,'failed');
      }
    }
  }finally{system.goalPlanProposals.propose=original;}
});

test('malformed feedback and a retained-draft conflict cannot mask wrong-owner, wrong-conversation or expired sources',async()=>{
  const user=await actor(),other=await actor(),conv=await conversation(user),wrongConv=await conversation(user),source=await live(user,conv),signal=new AbortController().signal;
  const malformed={title:'Fictional missing steps',goal:'An input error cannot authorize a response'};
  try{
    for(const name of ['get_execution_capabilities','propose_goal_plan'] as const){
      for(const binding of [{userId:other.id,origin:source},{userId:user.id,origin:{...source,conversationId:wrongConv}}]){
        await assert.rejects(goalPlanToolResult(name,signal,()=>name==='propose_goal_plan'?system.goalPlanProposals.propose(binding.userId,binding.origin,malformed,signal):(()=>{throw new ApiError(400,'INVALID_INPUT','Fictional malformed capability arguments');})(),()=>authorizeGoalPlanToolFeedback(db,binding.userId,binding.origin,signal)),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});
      }
    }
    const first=await system.goalPlanProposals.propose(user.id,source,simple(),signal);
    await finish(source);
    await assert.rejects(goalPlanToolResult('propose_goal_plan',signal,()=>{throw new ApiError(409,'GOAL_PLAN_PROPOSAL_EXISTS','The first fictional draft is retained.');},()=>authorizeGoalPlanToolFeedback(db,user.id,source,signal)),{code:'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'});
    assert.equal((await list(user,conv)).proposals[0].planId,first.proposal.planId);assert.deepEqual(await counts(user),{plans:1,proposals:1,jobs:0,approvals:0,outbox:0});assert.equal((await counts(other)).plans,0);
  }finally{await finish(source);}
});

test('account and ownership rejection, oversized input and database failure remain hard failures without a draft',async()=>{
  const user=await actor(),other=await actor(),conv=await conversation(user),fixture:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}]},payload={content:register(fixture),provider:'synthetic',mode:'agent'};
  const missing=await request(user,'POST',`/conversations/${conv}/messages`,payload,{[PLATFORM_ACCOUNT_HEADER]:undefined});assert.equal(missing.statusCode,409);assert.equal(missing.json().error.code,'ACCOUNT_CONTEXT_REQUIRED');
  const stale=await request(user,'POST',`/conversations/${conv}/messages`,payload,{[PLATFORM_ACCOUNT_HEADER]:other.id});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'ACCOUNT_CONTEXT_CHANGED');
  assert.equal((await request(other,'POST',`/conversations/${conv}/messages`,payload)).statusCode,404);assert.equal(fixture.context,undefined);assert.equal((await counts(user)).plans,0);
  const input=simple(),oversized={...input,steps:input.steps.map(step=>step.kind==='task'?{...step,task:{...step.task,options:{fictional:'x'.repeat(192*1024)}}}:step)},sizeFixture:Fixture={actions:[{name:'propose_goal_plan',args:oversized as any}]};
  const tooLarge=await response(user,conv,sizeFixture);assert.match(tooLarge,/event: error/);assert.doesNotMatch(tooLarge,/event: done/);assert.equal(sizeFixture.errors![0].code,'GOAL_PLAN_INPUT_LIMIT');assert.equal(sizeFixture.results,undefined);
  const original=system.goalPlanProposals.propose,failure=new ApiError(500,'INVALID_INPUT','Fictional database operation failed');system.goalPlanProposals.propose=async()=>{throw failure;};
  try{const another=await conversation(user),dbFixture:Fixture={actions:[{name:'propose_goal_plan',args:simple() as any}]};const failed=await response(user,another,dbFixture);assert.match(failed,/event: error/);assert.doesNotMatch(failed,/event: done/);assert.equal(dbFixture.errors![0],failure);assert.equal(dbFixture.results,undefined);assert.equal((await counts(user)).plans,0);}finally{system.goalPlanProposals.propose=original;}
});

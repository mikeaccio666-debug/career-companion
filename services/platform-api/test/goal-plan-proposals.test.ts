import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { EXECUTION_CAPABILITIES_MAX_BYTES, JOB_KINDS } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { executionCapabilities, goalPlanTools } from '../src/goal-plan-tools.ts';
import { parseGoalProposalQuery } from '../src/goal-plan-proposals.ts';
import { authorizeAssistantTurn, parseAssistantTurnOrigin } from '../src/assistant-turn-origin.ts';
import { parseGoalPlanInput } from '../src/goal-plans.ts';
import { goalPlanToolResult } from '../src/goal-plan-tool-feedback.ts';
import { ApiError } from '../src/errors.ts';

const fixture={id:'synthetic',name:'Fictional provider',enabled:true,keyConfigured:true,capabilities:['agent','image'] as const,models:['fictional-model'],modelsByCapability:{agent:['fictional-agent'],image:['fictional-image']},envVariables:['FICTIONAL_PRIVATE_KEY'],reason:'private service detail',documentationUrl:'https://private.example.invalid',browserFixtureOrigins:['https://private.example.invalid'],referenceImages:{image:{maxImages:4,maxTotalBytes:20*1024*1024,mimeTypes:['image/png','image/jpeg','image/webp'],binding:'openai_edits'}},executionTemplate:{version:1,hash:'a'.repeat(64),graph:{private:true},baseUrl:'https://private.example.invalid'}};
const runtime=(providers:any[])=>({capabilities:()=>providers}) as PlatformProviderRuntime;
const draft={title:'Fictional editable proposal',goal:'Compare fictional directions',steps:[{kind:'agent_turn',title:'Fictional analysis',instruction:'Compare facts',provider:'unconfigured'},{kind:'task',title:'Fictional speech',task:{kind:'speech',provider:'unconfigured',prompt:'Base fictional instruction'},bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}}}]};

test('execution discovery projects only bounded configuration facts and public reference/template metadata',()=>{
  const result=executionCapabilities(runtime([fixture]),{}),encoded=JSON.stringify(result);
  assert.equal(result.source,'server_configuration');assert.equal(result.accountAuthorizationVerified,false);assert.equal(result.truncated,false);
  assert.deepEqual(result.providers[0].modelsByCapability,{agent:['fictional-agent'],image:['fictional-image']});
  assert.deepEqual(result.providers[0].executionTemplate,{version:1,hash:'a'.repeat(64)});
  for(const field of ['envVariables','FICTIONAL_PRIVATE_KEY','private.example.invalid','documentationUrl','reason','graph','baseUrl','browserFixtureOrigins'])assert(!encoded.includes(field),field);
  assert.throws(()=>executionCapabilities(runtime([fixture]),{userId:randomUUID()}),{code:'INVALID_INPUT'});
});
test('capability discovery has a whole UTF8 budget and complete selected provider entries under maximal model lists',()=>{
  const caps=['chat','agent','image','video','speech','transcription','realtime','browser','cli','workflow','mcp'];
  const large=Array.from({length:40},(_,i)=>({...fixture,id:`synthetic_${i}`,capabilities:caps,modelsByCapability:Object.fromEntries(caps.map(cap=>[cap,Array.from({length:40},(_,j)=>`fictional-${j}-`+'中'.repeat(130))]))}));
  const result=executionCapabilities(runtime([fixture,...large]),{});
  assert.equal(result.truncated,true);assert(Buffer.byteLength(JSON.stringify(result),'utf8')<=EXECUTION_CAPABILITIES_MAX_BYTES);
  assert.deepEqual(result.providers[0],executionCapabilities(runtime([fixture]),{}).providers[0]);
  assert.equal(result.providers.length,1);assert(!JSON.stringify(result).includes('FICTIONAL_PRIVATE_KEY'));
});
test('private endpoint-like model values are omitted and flagged rather than converted to model IDs',()=>{
  const result=executionCapabilities(runtime([{...fixture,modelsByCapability:{agent:['https://private.example.invalid/model','fictional-agent'],image:['fictional-image']}}]),{});
  assert.equal(result.truncated,true);assert.deepEqual(result.providers[0].modelsByCapability.agent,['fictional-agent']);assert(!JSON.stringify(result).includes('private.example.invalid'));
});
test('proposal tools expose all task kinds and typed earlier-result bindings but never model-supplied origin identities',()=>{
  const tool=goalPlanTools.find(tool=>tool.name==='propose_goal_plan')!,schema=tool.parameters as any,task=schema.properties.steps.items.oneOf[0];
  assert.deepEqual(task.properties.task.properties.kind.enum,[...JOB_KINDS]);assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.steps.maxItems,8);
  for(const field of ['userId','conversationId','messageId','origin','approval'])assert.equal(schema.properties[field],undefined);
  assert.equal((parseGoalPlanInput(draft).steps[1] as any).bindings.prompt.source,'analysis_text');
  for(const field of ['userId','conversationId','messageId','origin'])assert.throws(()=>parseGoalPlanInput({...draft,[field]:randomUUID()}),{code:'INVALID_INPUT'});
});
test('proposal pagination accepts only bounded string limits and an owned UUID-shaped cursor',()=>{
  const id=randomUUID();assert.deepEqual(parseGoalProposalQuery({}),{limit:20});assert.deepEqual(parseGoalProposalQuery({limit:'50',before:id.toUpperCase()}),{limit:50,before:id});
  for(const limit of [0,1,'0','01','51','1.0',['20'],null])assert.throws(()=>parseGoalProposalQuery({limit}),{code:'INVALID_INPUT'});
  for(const before of [null,1,[id],id+' ','opaque'])assert.throws(()=>parseGoalProposalQuery({before}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseGoalProposalQuery({messageId:id}),{code:'INVALID_INPUT'});
});
test('assistant origin is server-owned and cancellation after a waited lock aborts before another query',async()=>{
  const origin={conversationId:randomUUID(),messageId:randomUUID()};assert.deepEqual(parseAssistantTurnOrigin(origin),origin);
  for(const input of [{...origin,userId:randomUUID()},{...origin,tool:'prepare_browser_task'},{...origin,messageId:[origin.messageId]}])assert.throws(()=>parseAssistantTurnOrigin(input),{code:'INVALID_INPUT'});
  const abort=new AbortController();let queries=0;const client={query:async()=>{queries++;abort.abort();return {rowCount:1,rows:[{}]};}};
  await assert.rejects(authorizeAssistantTurn(client as any,randomUUID(),origin,abort.signal),{name:'AbortError'});assert.equal(queries,1);
});
test('actual Responses protocol carries proposal schema and only bounded summary result, with no execution or retained conversations',async()=>{
  const bodies:any[]=[],proposal={planId:randomUUID(),conversationId:randomUUID(),title:draft.title,revision:1,status:'draft',stepCount:2,messageId:randomUUID(),createdAt:new Date(0).toISOString()};let calls=0,proposed=0;
  const frames=(output:any[])=>new Response(output.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const local=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'synthetic-only-protocol-key'},fetch:async(_url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));return calls++===0?frames([{type:'response.completed',response:{output:[{type:'function_call',call_id:'fictional-proposal-call',name:'propose_goal_plan',arguments:JSON.stringify(draft)}]}}]):frames([{type:'response.output_text.delta',delta:'Fictional editable draft saved.'},{type:'response.completed',response:{output:[]}}]);
  }});
  const events=[];for await(const event of local.streamChat({provider:'openai',mode:'agent',messages:[{role:'user',content:'Propose a fictional plan'}]},{tools:goalPlanTools,executeTool:async(name,args)=>{assert.equal(name,'propose_goal_plan');assert.equal(parseGoalPlanInput(args).title,draft.title);proposed++;return {proposal};}}))events.push(event);
  assert.equal(calls,2);assert.equal(proposed,1);assert.equal(bodies[0].store,false);assert.equal(bodies[0].tools.find((tool:any)=>tool.name==='propose_goal_plan').parameters.additionalProperties,false);
  const returned=JSON.parse(bodies[1].input.at(-1).output);assert.deepEqual(returned,{proposal});assert.equal(Object.hasOwn(returned.proposal,'steps'),false);assert(!JSON.stringify(returned).includes('Base fictional instruction'));assert.equal(events.filter(event=>event.type==='delta').length,1);
});

test('Responses continues after deterministic capability and proposal input feedback, then saves one corrected draft',async()=>{
  let calls=0,saved=0;const outputs:any[]=[],abort=new AbortController(),proposal={planId:randomUUID(),conversationId:randomUUID(),title:draft.title,revision:1,status:'draft',stepCount:2,messageId:randomUUID(),createdAt:new Date(0).toISOString()};
  const frames=(output:any[])=>new Response(output.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const local=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'synthetic-only-repair-protocol-key'},fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.store,false);
    if(calls++===0)return frames([{type:'response.completed',response:{output:[
      {type:'function_call',call_id:'fictional-invalid-caps',name:'get_execution_capabilities',arguments:'{"unexpected":true}'},
      {type:'function_call',call_id:'fictional-missing-steps',name:'propose_goal_plan',arguments:JSON.stringify({title:draft.title,goal:draft.goal})},
    ]}}]);
    const returned=body.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));outputs.push(...returned);
    if(calls===2){assert.equal(returned.length,2);assert(returned.every((item:any)=>item.error?.code==='INVALID_INPUT'));return frames([{type:'response.completed',response:{output:[{type:'function_call',call_id:'fictional-corrected-proposal',name:'propose_goal_plan',arguments:JSON.stringify(draft)}]}}]);}
    assert.equal(calls,3);assert.equal(returned.at(-1).proposal.planId,proposal.planId);
    return frames([{type:'response.output_text.delta',delta:'Fictional corrected draft saved for your review. Nothing was confirmed or executed.'},{type:'response.completed',response:{output:[]}}]);
  }});
  const events=[];for await(const event of local.streamChat({provider:'openai',mode:'agent',messages:[{role:'user',content:'Propose a fictional plan'}]},{signal:abort.signal,tools:goalPlanTools,executeTool:async(name,args)=>{
    assert(name==='get_execution_capabilities'||name==='propose_goal_plan');return goalPlanToolResult(name,abort.signal,()=>{
      if(name==='get_execution_capabilities')return executionCapabilities(runtime([fixture]),args);
      assert.equal(parseGoalPlanInput(args).title,draft.title);saved++;return {proposal};
    },async()=>{});
  }}))events.push(event);
  assert.equal(calls,3);assert.equal(saved,1);assert.equal(events.filter(event=>event.type==='tool'&&Object.hasOwn(event,'result')).length,3);assert.equal(events.filter(event=>event.type==='delta').length,1);assert(outputs.every(item=>!Object.hasOwn(item,'steps')));
});

test('tool feedback never absorbs inactive authorization, size, capacity, database errors or cancellation',async()=>{
  for(const name of ['get_execution_capabilities','propose_goal_plan'] as const){
    for(const error of [new ApiError(409,'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE','Inactive fictional origin'),new ApiError(403,'TOOL_NOT_ALLOWED','Readonly analysis'),new ApiError(401,'AUTH_REQUIRED','Fictional session expired'),new ApiError(409,'GOAL_PLAN_LIMIT','Fictional capacity reached'),new ApiError(413,'GOAL_PLAN_INPUT_LIMIT','Fictional oversized input'),new ApiError(500,'INVALID_INPUT','Fictional server failure'),new ApiError(400,'DATABASE_UNAVAILABLE','Fictional database failure'),new Error('Fictional connection failure')]){
      await assert.rejects(goalPlanToolResult(name,new AbortController().signal,()=>{throw error;},async()=>{assert.fail('Hard failures must never request soft feedback authorization.');}),caught=>caught===error);
    }
  }
  const existing=new ApiError(409,'GOAL_PLAN_PROPOSAL_EXISTS','The first fictional draft is retained; edit it or use a new response.');
  assert.deepEqual(await goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw existing;},async()=>{}),{error:{code:existing.code,message:existing.publicMessage}});
  await assert.rejects(goalPlanToolResult('get_execution_capabilities',new AbortController().signal,()=>{throw existing;},async()=>{}),caught=>caught===existing);
  let invoked=0;const before=new AbortController();before.abort();await assert.rejects(goalPlanToolResult('propose_goal_plan',before.signal,()=>{invoked++;},async()=>{}),{name:'AbortError'});assert.equal(invoked,0);
  const during=new AbortController(),input=new ApiError(400,'INVALID_INPUT','Fictional correctable input');await assert.rejects(goalPlanToolResult('propose_goal_plan',during.signal,()=>{during.abort();throw input;},async()=>{}),caught=>caught===input);
  const after=new AbortController();await assert.rejects(goalPlanToolResult('propose_goal_plan',after.signal,()=>{after.abort();return {proposal:{}};},async()=>{}),{name:'AbortError'});
});

test('correctable input and retained-draft feedback require a live authorized source and recheck cancellation',async()=>{
  const inactive=new ApiError(409,'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE','Inactive fictional response');let checks=0;
  for(const name of ['get_execution_capabilities','propose_goal_plan'] as const){
    await assert.rejects(goalPlanToolResult(name,new AbortController().signal,()=>{throw new ApiError(400,'INVALID_INPUT','Fictional malformed input');},async()=>{checks++;throw inactive;}),caught=>caught===inactive);
  }
  await assert.rejects(goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw new ApiError(409,'GOAL_PLAN_PROPOSAL_EXISTS','First draft retained');},async()=>{checks++;throw inactive;}),caught=>caught===inactive);
  assert.equal(checks,3);
  const abort=new AbortController();await assert.rejects(goalPlanToolResult('propose_goal_plan',abort.signal,()=>{throw new ApiError(400,'INVALID_INPUT','Fictional malformed input');},async()=>{abort.abort();}),{name:'AbortError'});
});

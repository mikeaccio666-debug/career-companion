import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import { GOAL_PLAN_MAX_BYTES, type GoalPlanInput } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { goalPlanInputDiagnostic, withGoalPlanDiagnostic } from '../src/goal-plan-input-diagnostics.ts';
import { parseGoalPlanInput } from '../src/goal-plans.ts';
import { goalPlanToolResult } from '../src/goal-plan-tool-feedback.ts';
import { goalPlanTools } from '../src/goal-plan-tools.ts';

function draft(): GoalPlanInput {
  return { title:'Fictional plan', goal:'Compare fictional directions', steps:[
    {kind:'agent_turn',title:'Fictional analysis',instruction:'Compare facts',provider:'unconfigured'},
    {kind:'task',title:'Fictional speech',task:{kind:'speech',provider:'unconfigured',prompt:'Fictional reviewed prompt'},bindings:{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}}},
  ] };
}
function failure(value: unknown): ApiError {
  try { parseGoalPlanInput(value); assert.fail('The invalid fictional input must fail.'); }
  catch (error) { assert(error instanceof ApiError); return error; }
}
function diagnostic(value: unknown, path: string, reason: string, expected: string): void {
  const error=failure(value);assert.equal(error.status,400);assert.equal(error.code,'INVALID_INPUT');
  assert.deepEqual(goalPlanInputDiagnostic(error),{path,reason,expected});
}

test('missing, type, empty and length failures identify the exact title without conflating causes',()=>{
  for(const [value,reason] of [[undefined,'missing'],[null,'type'],[42,'type'],[{fictional_private_value:'never_echo'},'type'],[' \n\t','empty'],['x'.repeat(121),'too_long']] as const){
    diagnostic({...draft(),title:value},'title',reason,'string_1_120_characters');
    const plan:any=draft();plan.steps[0].title=value;diagnostic(plan,'steps[0].title',reason,'string_1_120_characters');
  }
});
test('root, steps and analysis fields retain their original rules and expose bounded paths',()=>{
  diagnostic(undefined,'$','missing','object');diagnostic([],'$','type','object');
  diagnostic({...draft(),steps:undefined},'steps','missing','array_1_8_steps');
  diagnostic({...draft(),steps:{}},'steps','type','array_1_8_steps');
  diagnostic({...draft(),steps:[]},'steps','empty','array_1_8_steps');
  diagnostic({...draft(),steps:Array.from({length:9},()=>draft().steps[0])},'steps','too_many','array_1_8_steps');
  diagnostic({...draft(),steps:[null]},'steps[0]','type','object');
  const plan:any=draft();plan.steps[0].instruction='';diagnostic(plan,'steps[0].instruction','empty','string_1_6000_characters');
  plan.steps[0].instruction='Fictional';plan.steps[0].provider=false;diagnostic(plan,'steps[0].provider','type','string_1_80_characters');
  plan.steps[0].provider='unconfigured';plan.steps[0].model=null;diagnostic(plan,'steps[0].model','type','string_1_150_characters');
  plan.steps[0].model=undefined;plan.steps[0].kind=['agent_turn'];diagnostic(plan,'steps[0].kind','type','task_or_agent_turn');
});
test('task options and known required fields are located without interpreting upstream error text',()=>{
  const plan:any=draft();plan.steps[1].task.options=[];diagnostic(plan,'steps[1].task.options','type','object');
  plan.steps[1].task.options={fictional:'x'.repeat(20_001)};diagnostic(plan,'steps[1].task.options','too_long','object_max_20000_characters');
  plan.steps[1].task.options={};delete plan.steps[1].task.prompt;diagnostic(plan,'steps[1].task.prompt','missing','string_1_20000_characters');
  plan.steps[1].task.prompt='Fictional';plan.steps[1].task.provider=17;diagnostic(plan,'steps[1].task.provider','type','string_1_80_characters');
  plan.steps[1].task.provider='unconfigured';plan.steps[1].task.kind='unsupported';diagnostic(plan,'steps[1].task.kind','invalid_value','supported_task_kind');
  plan.steps[1].task={kind:'mcp',provider:'mcp',prompt:'Fictional lookup',options:{}};delete plan.steps[1].bindings;
  diagnostic(plan,'steps[1].task.options','invalid_value','valid_mcp_options');
  plan.steps[1].task={kind:' workflow ',provider:null,prompt:'Fictional',options:{fictional:'x'.repeat(25_000)}};
  diagnostic(plan,'steps[1].task.provider','type','string_1_80_characters');
  plan.steps[1].task={kind:' '.repeat(31)+'speech',provider:'unconfigured',prompt:'Fictional'};
  diagnostic(plan,'steps[1].task.kind','too_long','supported_task_kind');
});
test('structural and semantic binding failures identify earlier-source errors without choosing new sources',()=>{
  const plan:any=draft();plan.steps[1].bindings.prompt.source=['analysis_text'];diagnostic(plan,'steps[1].bindings.prompt.source','type','analysis_text_or_artifact_text');
  plan.steps[1].bindings.prompt.source='analysis_text';plan.steps[1].bindings.prompt.mode=[];diagnostic(plan,'steps[1].bindings.prompt.mode','type','append_or_replace');
  plan.steps[1].bindings.prompt.mode='replace';plan.steps[1].bindings.prompt.fromStep='0';diagnostic(plan,'steps[1].bindings.prompt.fromStep','type','integer_0_7');
  plan.steps[1].bindings.prompt.fromStep=1;diagnostic(plan,'steps[1].bindings.prompt.fromStep','out_of_range','earlier_step_index');
  plan.steps[1].bindings.prompt.fromStep=0;plan.steps[1].task.kind='browser';diagnostic(plan,'steps[1].bindings.prompt','invalid_value','text_binding_for_image_video_speech_cli');
  plan.steps[1].task.kind='image';plan.steps[1].bindings={referenceImages:[{fromStep:0}]};diagnostic(plan,'steps[1].bindings.referenceImages[0].fromStep','invalid_value','earlier_task_step_index');
  plan.steps[1].bindings={referenceImages:[{fromStep:1}]};diagnostic(plan,'steps[1].bindings.referenceImages[0].fromStep','out_of_range','earlier_step_index');
  plan.steps[1].bindings={referenceImages:[{fromStep:0,imageIndex:64}]};diagnostic(plan,'steps[1].bindings.referenceImages[0].imageIndex','out_of_range','integer_0_63');
});
test('unknown input keys, values and arbitrary error diagnostics are never returned as diagnostic content',async()=>{
  const marker='FICTIONAL_PRIVATE_VALUE_DO_NOT_ECHO';
  const samples:any[]=[{...draft(),[marker]:'another private value'},draft(),draft()];
  samples[1].steps[1].task[marker]={private:'value'};samples[2].steps[1].bindings.prompt[marker]='private';
  for(const input of samples){
    const error=failure(input),feedback=await goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw error;},async()=>{});
    const encoded=JSON.stringify(feedback);assert(!encoded.includes(marker));assert(!encoded.includes('another private value'));assert(!encoded.includes('"private"'));
    const hint=goalPlanInputDiagnostic(error)!;assert.equal(hint.reason,'unsupported_field');assert(Buffer.byteLength(JSON.stringify(hint),'utf8')<=256);
    assert.deepEqual(Object.keys(hint),['path','reason','expected']);
  }
  const forged=Object.assign(new ApiError(400,'INVALID_INPUT','Safe fixed feedback'),{diagnostic:{path:marker,reason:marker,expected:marker}});
  assert.deepEqual(await goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw forged;},async()=>{}),{error:{code:'INVALID_INPUT',message:'Safe fixed feedback'}});
  const ordinary=new ApiError(400,'INVALID_INPUT','Original safe message');
  assert.throws(()=>withGoalPlanDiagnostic(()=>{throw ordinary;},{path:'steps[99].title',reason:'missing',expected:'string_1_120_characters'}),error=>error===ordinary);
});
test('normalization and optional task model semantics remain unchanged; no field or step is repaired',()=>{
  const plan:any=draft();plan.title='  Fictional plan  ';plan.steps[0].title=' Fictional analysis ';plan.steps[1].task.model=null;
  const before=structuredClone(plan),parsed=parseGoalPlanInput(plan);
  assert.deepEqual(plan,before);assert.equal(parsed.title,'Fictional plan');assert.equal(parsed.steps[0].title,'Fictional analysis');
  assert.equal((parsed.steps[1] as any).task.model,undefined);assert.equal(parsed.steps.length,2);
  assert.deepEqual((parsed.steps[1] as any).bindings,{prompt:{fromStep:0,source:'analysis_text',mode:'replace'}});
  assert.equal((parsed.steps[1] as any).task.provider,'unconfigured');
});
test('size 413 and malformed identifier 404 preserve hard failures and never request feedback authorization',async()=>{
  const oversized={...draft(),goal:'x'.repeat(GOAL_PLAN_MAX_BYTES)},large=failure(oversized);
  assert.equal(large.status,413);assert.equal(large.code,'GOAL_PLAN_INPUT_LIMIT');assert.equal(goalPlanInputDiagnostic(large),undefined);
  const plan:any=draft();plan.steps[1].task.attachmentIds=['not-a-valid-uuid'];const missing=failure(plan);
  assert.equal(missing.status,404);assert.equal(missing.code,'NOT_FOUND');assert.equal(goalPlanInputDiagnostic(missing),undefined);
  for(const error of [large,missing])await assert.rejects(goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw error;},async()=>{assert.fail('Hard failure may not authorize feedback.');}),caught=>caught===error);
});
test('diagnostic feedback requires authorization and cannot hide expired source, database failures or cancellation',async()=>{
  const bad=failure({...draft(),title:undefined}),inactive=new ApiError(409,'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE','Inactive fictional response');
  await assert.rejects(goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw bad;},async()=>{throw inactive;}),error=>error===inactive);
  const failureFromDatabase=new Error('Fictional database failure must not become input feedback');
  await assert.rejects(goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw bad;},async()=>{throw failureFromDatabase;}),error=>error===failureFromDatabase);
  const abort=new AbortController();await assert.rejects(goalPlanToolResult('propose_goal_plan',abort.signal,()=>{throw bad;},async()=>{abort.abort();}),{name:'AbortError'});
  let checks=0;const feedback:any=await goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw bad;},async()=>{checks++;});
  assert.equal(checks,1);assert.deepEqual(feedback.error.diagnostic,{path:'title',reason:'missing',expected:'string_1_120_characters'});
});
test('old feedback shape stays intact and reader errors use an exact allowlist with the same live-source gate',async()=>{
  for(const name of ['list_goal_plans','read_goal_plan'] as const){
    for(const error of [new ApiError(400,'INVALID_INPUT','Safe reader input'),new ApiError(404,'NOT_FOUND','Item not found.'),new ApiError(409,'GOAL_PLAN_REVISION_CONFLICT','Reload the current revision.')]){
      let authorized=0;assert.deepEqual(await goalPlanToolResult(name,new AbortController().signal,()=>{throw error;},async()=>{authorized++;}),{error:{code:error.code,message:error.publicMessage}});assert.equal(authorized,1);
      const inactive=new ApiError(409,'ASSISTANT_TURN_INACTIVE','Inactive fictional response');await assert.rejects(goalPlanToolResult(name,new AbortController().signal,()=>{throw error;},async()=>{throw inactive;}),caught=>caught===inactive);
    }
    for(const error of [new ApiError(409,'GOAL_PLAN_BLOCKED','Blocked source'),new ApiError(403,'TOOL_NOT_ALLOWED','Readonly mode'),new ApiError(413,'GOAL_PLAN_INPUT_LIMIT','Oversized'),new ApiError(500,'INVALID_INPUT','Infrastructure failure')])await assert.rejects(goalPlanToolResult(name,new AbortController().signal,()=>{throw error;},async()=>{assert.fail('Hard failure cannot authorize feedback.');}),caught=>caught===error);
  }
  const old=new ApiError(400,'INVALID_INPUT','Original safe input error');assert.deepEqual(await goalPlanToolResult('propose_goal_plan',new AbortController().signal,()=>{throw old;},async()=>{}),{error:{code:'INVALID_INPUT',message:'Original safe input error'}});
});
test('actual compatible chat protocol passes the precise missing-title hint, then the model submits its own corrected definition',async()=>{
  const original=draft(),bad:any=structuredClone(original);delete bad.steps[0].title;
  const proposal={planId:randomUUID(),conversationId:randomUUID(),title:original.title,revision:1,status:'draft',stepCount:2,messageId:randomUUID(),createdAt:new Date(0).toISOString()};
  const bodies:any[]=[],saved:GoalPlanInput[]=[],abort=new AbortController();let authorized=0;
  const frames=(delta:unknown,finish:string)=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}],usage:{prompt_tokens:7,completion_tokens:4}})+'\n\n'+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const runtime=createProviderRuntime({env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1',OLLAMA_CHAT_MODEL:'fictional-protocol-model'},fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));bodies.push(body);
    assert.deepEqual(body.tools.map((tool:any)=>tool.function.name),goalPlanTools.map(tool=>tool.name));
    if(bodies.length===1)return frames({tool_calls:[{index:0,id:'fictional-invalid-title',type:'function',function:{name:'propose_goal_plan',arguments:JSON.stringify(bad)}}]},'tool_calls');
    if(bodies.length===2){
      const returned=JSON.parse(body.messages.at(-1).content);assert.equal(returned.error.code,'INVALID_INPUT');assert.deepEqual(returned.error.diagnostic,{path:'steps[0].title',reason:'missing',expected:'string_1_120_characters'});
      assert.equal(saved.length,0);return frames({tool_calls:[{index:0,id:'fictional-corrected-title',type:'function',function:{name:'propose_goal_plan',arguments:JSON.stringify(original)}}]},'tool_calls');
    }
    assert.equal(bodies.length,3);assert.deepEqual(JSON.parse(body.messages.at(-1).content),{proposal});return frames({content:'Fictional draft saved for explicit review; nothing executed.'},'stop');
  }});
  const events=[];for await(const event of runtime.streamChat({provider:'ollama',mode:'agent',messages:[{role:'user',content:'Propose a fictional plan'}]},{signal:abort.signal,tools:goalPlanTools,executeTool:async(name,args)=>{
    assert.equal(name,'propose_goal_plan');return goalPlanToolResult('propose_goal_plan',abort.signal,()=>{const parsed=parseGoalPlanInput(args);saved.push(parsed);return {proposal};},async()=>{authorized++;});
  }}))events.push(event);
  assert.equal(bodies.length,3);assert.equal(authorized,1);assert.equal(saved.length,1);assert.equal(saved[0].steps[0].title,original.steps[0].title);assert.deepEqual(bad.steps[0],{kind:'agent_turn',instruction:'Compare facts',provider:'unconfigured'});
  assert(events.some(event=>event.type==='delta'));assert.equal(events.filter(event=>event.type==='tool'&&Object.hasOwn(event,'result')).length,2);
});

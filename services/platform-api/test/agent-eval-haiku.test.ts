import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import os from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import type {ChatInput,ModelCallEvent,ModelStepContext} from '@companion/platform-contracts';
import {haikuPilotRuntime,haikuUsage} from '../evals/haiku-runtime.ts';
import {runLivePilot,HAIKU_PILOT_PRICE} from '../evals/live-pilot.ts';
import {evalLiveCommand} from '../evals/live-main.ts';
import {createEvalJournal,type EvalRunManifest} from '../evals/journal.ts';
import {createEvalStudyPlan} from '../evals/study-plan.ts';
const now=()=>new Date('2026-10-09T05:00:00.000Z'),key='fictional-haiku-key';
const privateText='Fictional private answer.',thought='Fictional hidden thinking.';
async function fixture(){
 const root=await realpath(await mkdtemp(join(os.tmpdir(),'career-haiku-'))),runId='haiku-fixture';
 return {root,runId,choice:'anthropic-haiku' as const,env:{CAREER_EVAL_ALLOW_PAID_CALLS:'1',CAREER_EVAL_ANTHROPIC_API_KEY:key,CAREER_EVAL_RESULTS_DIR:root,
  ANTHROPIC_API_KEY:'fictional-unused-key',ANTHROPIC_BASE_URL:'https://example.invalid',PLATFORM_ALLOW_PROVIDER_CALLS:'0'},close:()=>rm(root,{recursive:true,force:true})};
}
async function records(root:string,runId:string){return Promise.all((await readdir(join(root,runId))).sort().map(async name=>JSON.parse(await readFile(join(root,runId,name),'utf8'))));}
function events(variant='ok'){
 const usage={input_tokens:100,output_tokens:1,cache_creation_input_tokens:20,cache_read_input_tokens:30,service_tier:variant==='tier'?'priority':'standard',inference_geo:variant==='geo'?'us':'global'};
 if(variant==='missing')delete (usage as any).cache_read_input_tokens;
 if(variant==='invalid')usage.input_tokens=-1;
 const ev:any[]=[
  {type:'message_start',message:{id:'msg_fictional',type:'message',role:'assistant',model:variant==='model'?'claude-opus-5':'claude-haiku-5-5',content:[],stop_reason:null,stop_sequence:null,usage}},
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:thought}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'fictional-signature'}},
  {type:'content_block_stop',index:0},
  {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:1,delta:{type:'text_delta',text:privateText}},
  {type:'content_block_stop',index:1},
  {type:'message_delta',delta:{stop_reason:variant==='limit'?'max_tokens':'end_turn',stop_sequence:null},usage:{output_tokens:30}},
  {type:'message_stop'},
 ];
 if(variant==='truncated')return ev.slice(0,-1);
 if(variant==='no-final-usage')return ev.filter(x=>x.type!=='message_delta');
 if(variant==='tool')ev[5].content_block={type:'tool_use',id:'tool_fictional',name:'forbidden_tool',input:{}};
 return ev;
}
function response(variant='ok'){return new Response(events(variant).map(x=>'event: '+x.type+'\ndata: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}
const input:ChatInput={provider:'anthropic',model:'claude-haiku-5-5',mode:'agent',persona:'Fictional test persona',messages:[{role:'user',content:'Fictional request'}]};
function context(account:(event:ModelCallEvent)=>void|Promise<void>):ModelStepContext{return {tools:[],toolChoice:'none',limits:{maxOutputTokens:2048},callIndex:1,purpose:'companion_reply',reasoningEffort:'low',timeoutMs:1000,firstTokenTimeoutMs:500,onModelCall:account,invocation:{}};}
async function consume(fetch:typeof globalThis.fetch,ctx:ModelStepContext,request=input){const gen=haikuPilotRuntime(key,fetch).streamModelStep!(request,ctx);let text='';for await(const event of gen)if(event.type==='delta')text+=event.text;return text;}

test('native SDK executes all 12 fixed scripts after durable reservation with exact Haiku tariff and no private output saved',async()=>{
 const f=await fixture();let calls=0;
 try{
  const report=await runLivePilot(f,{now,runtimeFactory:k=>haikuPilotRuntime(k,async(url,init)=>{
   calls++;assert.equal(k,key);assert.equal(String(url),'https://api.anthropic.com/v1/messages');assert.equal(init?.redirect,'error');
   assert.equal(new Headers(init?.headers).get('x-api-key'),key);assert.equal(new Headers(init?.headers).get('authorization'),null);
   const body=JSON.parse(init?.body as string);assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.service_tier,'standard_only');assert.equal(body.inference_geo,'global');
   assert.equal(body.max_tokens,2048);assert.deepEqual(body.thinking,{type:'adaptive'});assert.deepEqual(body.output_config,{effort:'low'});assert.equal(body.stream,true);
   assert.equal(body.tools,undefined);assert.equal(body.cache_control,undefined);assert.equal(body.temperature,undefined);assert.equal(body.fallbacks,undefined);
   assert.equal(typeof body.system,'string');assert(body.messages.every((m:any)=>['user','assistant'].includes(m.role)));
   const saved=await records(f.root,f.runId);assert.equal(saved.at(-1).type,'started_reserve');assert.equal(saved.at(-1).reservedMicroUsd,1005120);
   assert.equal(saved.filter(x=>x.scope==='isolated_provider_loop_baseline').length,calls-1);
   return response();
  })});
  assert.equal(calls,12);assert.equal(report.status,'completed');assert.equal(report.budget.actualSpentMicroUsd,2700);assert.equal(report.budget.pendingReservedMicroUsd,0);
  assert.equal(report.productGate,'not_evaluated');assert.equal(report.qualityStatus,'not_scored');
  const saved=await records(f.root,f.runId);assert.equal(saved.length,50);assert.equal(saved[0].provider,'anthropic');assert.equal(saved[0].capMicroUsd,2000000);
  const measured=saved.filter(x=>x.type==='finished_settled');assert.equal(measured.length,12);assert.equal(measured[0].inputTokens,150);assert.equal(measured[0].outputTokens,30);
  for(const text of [key,privateText,thought,'fictional-unused-key','fictional-signature'])assert(!JSON.stringify(saved).includes(text));
 }finally{await f.close();}
});

test('missing or invalid usage, mismatched tariff/model, truncated stream and unexpected tools stop the pilot without retries',async()=>{
 for(const variant of ['missing','invalid','geo','tier','model','truncated','no-final-usage','tool']){
  const f=await fixture();let calls=0;
  try{
   const report=await runLivePilot(f,{now,runtimeFactory:k=>haikuPilotRuntime(k,async()=>{calls++;return response(variant);})});
   assert.equal(calls,1,variant);assert.equal(report.status,'stopped',variant);assert.equal(report.completedCases,0,variant);
   assert.equal(report.budget.pendingReservedMicroUsd,1005120,variant);assert.equal(report.budget.uncertainCalls,1,variant);
  }finally{await f.close();}
 }
});

test('SDK retries stay disabled for authentication, missing model, rate limit and server errors',async()=>{
 for(const status of [401,404,429,500]){
  const f=await fixture();let calls=0;
  try{const report=await runLivePilot(f,{now,runtimeFactory:k=>haikuPilotRuntime(k,async()=>{calls++;return new Response(JSON.stringify({type:'error',error:{type:'api_error',message:'fictional-private-error'}}),{status,headers:{'content-type':'application/json','retry-after':'0'}});})});
   assert.equal(calls,1);assert.equal(report.status,'stopped');assert.equal(report.budget.pendingReservedMicroUsd,1005120);assert(!JSON.stringify(await records(f.root,f.runId)).includes('fictional-private-error'));
  }finally{await f.close();}
 }
});

test('output limit settles known tokens but never completes the case or starts another one',async()=>{
 const f=await fixture();let calls=0;
 try{const report=await runLivePilot(f,{now,runtimeFactory:k=>haikuPilotRuntime(k,async()=>{calls++;return response('limit');})});
  assert.equal(calls,1);assert.equal(report.status,'stopped');assert.equal(report.completedCases,0);assert.equal(report.budget.actualSpentMicroUsd,225);assert.equal(report.budget.pendingReservedMicroUsd,0);
 }finally{await f.close();}
});

test('native stream exposes only visible text, aggregates cache input and counts all output including thinking',async()=>{
 const calls:ModelCallEvent[]=[];assert.equal(await consume(async()=>response(),context(e=>{calls.push(e);})),privateText);
 assert.equal(calls.length,2);assert.equal(calls[0]?.type,'started');assert.equal(calls[1]?.type,'finished');
 if(calls[1]?.type==='finished'){assert.equal(calls[1].status,'complete');assert.deepEqual(calls[1].usage,{status:'reported',inputTokens:150,outputTokens:30,cachedInputTokens:30,cacheWriteInputTokens:20});}
 for(const value of [undefined,null])assert.deepEqual(haikuUsage({input_tokens:1,output_tokens:2,cache_read_input_tokens:value,cache_creation_input_tokens:0} as Anthropic.Usage),{status:'missing'});
 assert.deepEqual(haikuUsage({input_tokens:2147483647,output_tokens:2,cache_read_input_tokens:1,cache_creation_input_tokens:0} as Anthropic.Usage),{status:'invalid'});
});

test('failed reservation and unsupported tool/admission contexts cause zero transmissions',async()=>{
 let calls=0;const fetch:typeof globalThis.fetch=async()=>{calls++;return response();};
 await assert.rejects(consume(fetch,context(()=>{throw new Error('fictional-ledger-failure');})));
 for(const override of [{callIndex:2},{toolChoice:'auto'},{responseFormat:{name:'x',schema:{}}},{requestAdmission:{}},{tools:[{name:'forbidden'}]}])
  await assert.rejects(consume(fetch,{...context(()=>{}),...override} as ModelStepContext),{code:'PROVIDER_UNSUPPORTED'});
 assert.equal(calls,0);
});

test('external cancellation and first-visible-text timeout settle as uncertain and do not retry',async()=>{
 for(const cancel of [true,false]){
  const controller=new AbortController(),calls:ModelCallEvent[]=[];let transmissions=0;
  const ctx={...context(e=>{calls.push(e);}),signal:controller.signal,firstTokenTimeoutMs:30};
  const fetch:typeof globalThis.fetch=async(_url,init)=>{
   transmissions++;return await new Promise<Response>((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(new DOMException('fictional-aborted','AbortError')),{once:true});
    if(cancel)controller.abort();
   });
  };
  await assert.rejects(consume(fetch,ctx),{code:cancel?'STREAM_CANCELLED':'PROVIDER_STREAM_INTERRUPTED'});assert.equal(transmissions,1);assert.equal(calls.length,2);
  if(calls[1]?.type==='finished'){assert.equal(calls[1].status,cancel?'cancelled':'interrupted');assert.deepEqual(calls[1].usage,{status:'missing'});}
 }
});

test('Haiku CLI uses its own credential, opt-in and unexpired price; OpenAI key cannot authorize it',async()=>{
 const f=await fixture();let constructed=0;const deps={now,runtimeFactory:()=>{constructed++;throw new Error('must not construct');}};
 try{
  await assert.rejects(runLivePilot({...f,env:{...f.env,CAREER_EVAL_ANTHROPIC_API_KEY:'',CAREER_EVAL_OPENAI_API_KEY:key}},deps),{code:'EVAL_KEY_MISSING'});
  await assert.rejects(runLivePilot(f,{...deps,now:()=>new Date(HAIKU_PILOT_PRICE.expiresAt)}),{code:'EVAL_PRICE_UNCONFIRMED'});
  assert.equal(constructed,0);assert.deepEqual(await readdir(f.root),[]);
  assert.deepEqual(await evalLiveCommand(['--live','anthropic-haiku','--run-id','haiku-cli'],{...f.env,CAREER_EVAL_ALLOW_PAID_CALLS:'0'}),{exitCode:1,result:{status:'stopped',code:'EVAL_LIVE_DISABLED'}});
  const study=createEvalStudyPlan();
  const manifest={schemaVersion:1,scope:'isolated_provider_loop_pilot',runId:f.runId,studyDigest:study.digest,promptDigest:study.promptDigest,corpusDigest:study.corpusDigest,
   provider:'anthropic',model:'gpt-6-luna',serviceTier:'standard_only',capMicroUsd:2000000,priceSnapshotId:HAIKU_PILOT_PRICE.id,createdAt:now().toISOString(),pilotCaseIds:study.pilotCaseIds,productGate:'not_evaluated',qualityStatus:'not_scored'};
  await assert.rejects(createEvalJournal(f.root,manifest as unknown as EvalRunManifest),{code:'EVAL_JOURNAL_UNAVAILABLE'});assert.deepEqual(await readdir(f.root),[]);
 }finally{await f.close();}
});

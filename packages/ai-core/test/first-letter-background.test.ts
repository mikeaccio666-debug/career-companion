import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderRuntime} from '../src/index.ts';
import type {ChatContext,ChatInput,ChatStreamEvent,ModelCallEvent} from '@companion/platform-contracts';

const env={PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-test-only',OPENAI_CHAT_MODEL:'fictional-chat',
 OPENAI_COMPANION_GENERATION_MODEL:'fictional-preview',OPENAI_FIRST_LETTER_MODEL:'fictional-first-letter'};
const schema=()=>({type:'object',properties:{body:{type:'string',minLength:1,maxLength:350},
 factFields:{type:'array',minItems:0,maxItems:4,items:{type:'string',enum:['study','graduation','roles','search_stage']}}},
 required:['body','factFields'],additionalProperties:false});
const text=JSON.stringify({body:'Fictional letter used only to test transport.',factFields:['study','roles']});
const input=():ChatInput=>({provider:'openai',model:'fictional-first-letter',mode:'chat',
 messages:[{role:'system',content:'Fictional first-letter transport policy, not a reviewed product prompt.'},{role:'user',content:'Fictional source-only input.'}]});
const context=(events:ModelCallEvent[]=[]):ChatContext=>({
 requestAdmission:async(launch,signal)=>launch(signal??new AbortController().signal),onModelCall:event=>{events.push(event);},
 background:{purpose:'first_letter_generation',responseFormat:{name:'fictional_first_letter',schema:schema()},
  limits:{maxOutputTokens:1536},timeoutMs:15000}});
const message=(body=text)=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:body}]});
const completed=(body=text)=>({type:'response.completed',response:{status:'completed',output:[message(body)],usage:{input_tokens:20,output_tokens:30}}});
function fixture(events:unknown[]=[completed()],override:NodeJS.ProcessEnv={},before?:()=>void){
 const requests:Record<string,any>[]=[];
 const runtime=createProviderRuntime({env:{...env,...override},fetch:async(url,init)=>{
  assert.equal(String(url),'https://api.openai.com/v1/responses');before?.();
  requests.push(JSON.parse(String(init?.body)));
  return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',
   {headers:{'content-type':'text/event-stream'}});
 }});
 return {runtime,requests};
}
async function collect(f:ReturnType<typeof fixture>,ctx=context(),request=input(),result:ChatStreamEvent[]=[]){
 for await(const event of f.runtime.streamChat(request,ctx))result.push(event);
 return result;
}

test('first letter uses its own explicit model and accounting purpose in exactly one tools-disabled request',async()=>{
 const f=fixture(),ledger:ModelCallEvent[]=[],out=await collect(f,context(ledger));
 assert.deepEqual(out,[{type:'delta',text},{type:'usage',inputTokens:20,outputTokens:30}]);
 assert.equal(f.requests.length,1);const request=f.requests[0];
 assert.equal(request.model,'fictional-first-letter');assert.equal(request.store,false);assert.equal(request.stream,true);
 assert.deepEqual(request.tools,[]);assert.equal(request.tool_choice,'none');assert.equal(request.max_output_tokens,1536);
 assert.equal(request.text.format.name,'fictional_first_letter');assert.equal(request.text.format.strict,true);
 assert.equal(Object.hasOwn(request,'previous_response_id'),false);assert.equal(Object.hasOwn(request,'conversation'),false);
 assert.equal(ledger[0].type,'started');if(ledger[0].type==='started'){assert.equal(ledger[0].purpose,'first_letter_generation');assert.equal(ledger[0].model,'fictional-first-letter');}
 assert.equal(ledger[1].type,'finished');if(ledger[1].type==='finished')assert.equal(ledger[1].status,'complete');
 assert.equal(ledger[0].callId,ledger[1].callId);
});

test('missing, empty, malformed or disabled first-letter binding cannot fall back to preview or chat',async()=>{
 for(const OPENAI_FIRST_LETTER_MODEL of [undefined,'',' fictional-first-letter','fictional-first-letter\n','x'.repeat(151)]){
  const f=fixture([],{OPENAI_FIRST_LETTER_MODEL}),ledger:ModelCallEvent[]=[];
  await assert.rejects(collect(f,context(ledger)));assert.equal(f.requests.length,0);assert.deepEqual(ledger,[]);
 }
 const disabled=fixture([],{PLATFORM_ALLOW_PROVIDER_CALLS:'0'});await assert.rejects(collect(disabled));assert.equal(disabled.requests.length,0);
 for(const model of ['fictional-chat','fictional-preview']){
  const f=fixture();await assert.rejects(collect(f,context(),{...input(),model}));assert.equal(f.requests.length,0);
 }
 const reverse=fixture(),ctx=context();ctx.background!.purpose='companion_generation';
 await assert.rejects(collect(reverse,ctx));assert.equal(reverse.requests.length,0);
});

test('first-letter model metadata remains internal and does not replace public chat or preview models',()=>{
 const f=fixture(),openai=f.runtime.capabilities().find(p=>p.id==='openai')!;
 assert.deepEqual(openai.modelsByPurpose?.first_letter_generation,['fictional-first-letter']);
 assert.deepEqual(openai.modelsByPurpose?.companion_generation,['fictional-preview']);
 assert.deepEqual(openai.modelsByCapability?.chat,['fictional-chat']);
 assert.equal(openai.models.includes('fictional-first-letter'),false);
 assert.equal(Object.hasOwn(fixture([],{OPENAI_FIRST_LETTER_MODEL:undefined}).runtime.capabilities().find(p=>p.id==='openai')!.modelsByPurpose!,'first_letter_generation'),false);
});

test('purpose, model, input and schema are frozen before a lazy first-letter stream and cannot be swapped during accounting',async()=>{
 const f=fixture(),ctx=context(),request=input(),ledger:ModelCallEvent[]=[];
 ctx.onModelCall=event=>{ledger.push(event);ctx.background!.purpose='companion_generation';request.model='fictional-preview';};
 const stream=f.runtime.streamChat(request,ctx);
 ctx.background!.purpose='companion_generation';ctx.background!.responseFormat.schema.properties={};
 request.messages[0].content='Changed input must not be used.';request.model='fictional-preview';
 const output=[];for await(const e of stream)output.push(e);
 assert.equal(f.requests[0].model,'fictional-first-letter');assert.equal(f.requests[0].input[0].content,input().messages[0].content);
 assert.equal(f.requests[0].text.format.schema.required.length,2);
 assert.equal((ledger[0] as any).purpose,'first_letter_generation');assert.equal(output[0].type,'delta');
});

test('first-letter partial text waits for full completion and final accounting acknowledgement',async()=>{
 const f=fixture([{type:'response.output_text.delta',delta:text},completed()]);
 const output:ChatStreamEvent[]=[],ctx=context();let release!:()=>void,arrive!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{arrive=resolve;});
 ctx.onModelCall=async event=>{if(event.type==='finished'){arrive();await waiting;}};
 const running=collect(f,ctx,input(),output);await seen;assert.equal(output.length,0);release();await running;
 assert.equal(output.filter(e=>e.type==='delta').length,1);
});

for(const [name,events,invalidFormat] of [
 ['bad JSON',[completed('not JSON')],true],
 ['empty letter',[completed(JSON.stringify({body:'',factFields:[]}))],true],
 ['too long',[completed(JSON.stringify({body:'x'.repeat(351),factFields:[]}))],true],
 ['invented reference',[completed(JSON.stringify({body:'Fictional body',factFields:['identity_stage']}))],true],
 ['unexpected field',[completed(JSON.stringify({body:'Fictional body',factFields:[],status:'delivered'}))],true],
 ['refusal',[{type:'response.refusal.delta',delta:'Fictional refusal'}],false],
 ['truncated stream',[{type:'response.output_text.delta',delta:text}],false],
 ['output limit',[{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:20,output_tokens:1536}}}],false],
 ['tool output',[{type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'fictional',name:'send_letter',arguments:'{}'}],usage:{input_tokens:20,output_tokens:30}}}],false],
] as const)test('first-letter '+name+' cannot produce a successful structured response',async()=>{
 const f=fixture([...events]),ledger:ModelCallEvent[]=[],output:ChatStreamEvent[]=[];
 await assert.rejects(collect(f,context(ledger),input(),output));assert.equal(output.length,0);
 assert.equal(f.requests.length,1);assert.equal(ledger.length,2);
 const final=ledger[1];assert.equal(final.type,'finished');
 if(final.type==='finished'){assert.notEqual(final.status,'complete');assert.equal(final.structuredOutcome,invalidFormat?'invalid_format':undefined);}
});

test('admission denial, reserve-hook failure and final-accounting failure never publish first-letter content',async()=>{
 for(const where of ['admission','started','finished']){
  const f=fixture(),ctx=context(),output:ChatStreamEvent[]=[];
  if(where==='admission')ctx.requestAdmission=async()=>{throw Error('Fictional denied admission');};
  else ctx.onModelCall=event=>{if(event.type===where)throw Error('Fictional accounting failure');};
  await assert.rejects(collect(f,ctx,input(),output));assert.equal(output.length,0);
  assert.equal(f.requests.length,where==='finished'?1:0);
 }
});

test('first-letter cancellation and unrecognized purpose do not dispatch',async()=>{
 const f=fixture(),ctx=context();ctx.signal=AbortSignal.abort();
 await assert.rejects(collect(f,ctx));assert.equal(f.requests.length,0);
 const unknown=context();unknown.background!.purpose='first_letter_delivered' as any;
 await assert.rejects(collect(f,unknown));assert.equal(f.requests.length,0);
});

test('first-letter background bounds, server-only shape and callbacks remain mandatory',async()=>{
 for(const patch of [
  {background:{...context().background!,limits:{maxOutputTokens:1537}}},
  {background:{...context().background!,timeoutMs:15001}},
  {onModelCall:undefined},{requestAdmission:undefined},{tools:[]},
 ]){
  const f=fixture();await assert.rejects(collect(f,{...context(),...patch}));assert.equal(f.requests.length,0);
 }
});

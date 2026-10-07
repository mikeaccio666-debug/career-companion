import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.ts';
import { createProviderRuntime } from '../src/index.ts';
import type { ProviderRequestAdmission } from '@companion/platform-contracts';

test('all actual runtime request families defer payload delivery to admission, preserving its refusal',async()=>{
  let calls=0,admissions=0;
  const refused=new Error('Fictional consent revoked');
  const gate:ProviderRequestAdmission=async()=>{admissions++;throw refused;};
  const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-key',OPENAI_CHAT_MODEL:'fictional',OPENAI_IMAGE_MODEL:'fictional-image',OPENAI_REALTIME_MODEL:'fictional-realtime',OPENAI_REALTIME_VOICE:'alloy',OPENAI_SPEECH_MODEL:'fictional-speech',OPENAI_SPEECH_VOICE:'alloy',OPENAI_TRANSCRIPTION_MODEL:'fictional-asr'},fetch:async()=>{calls++;throw new Error('Unexpected payload sent');}});
  const context={requestAdmission:gate};
  const drain=async(iterable:AsyncIterable<unknown>)=>{for await(const _ of iterable){}};
  await assert.rejects(drain(runtime.streamChat({provider:'openai',mode:'chat',messages:[{role:'user',content:'Fictional message'}]},context)),error=>error===refused);
  await assert.rejects(runtime.executeJob({kind:'image',provider:'openai',prompt:'Fictional image'},{...context,jobId:'fictional',userId:'fictional',workspaceDirectory:'/fictional'}),error=>error===refused);
  await assert.rejects(runtime.createVoiceSession({provider:'openai'},context),error=>error===refused);
  await assert.rejects(runtime.transcribe({name:'fictional.wav',mime:'audio/wav',bytes:new Uint8Array([1])},context),error=>error===refused);
  await assert.rejects(runtime.speech({provider:'openai',text:'Fictional text'},context),error=>error===refused);
  await assert.rejects(drain(runtime.streamModelStep!({provider:'openai',model:'fictional',mode:'chat',messages:[{role:'user',content:'Fictional'}]},{...context,tools:[],toolChoice:'none',limits:{maxOutputTokens:32},callIndex:1,timeoutMs:1000,invocation:{}})),error=>error===refused);
  assert.equal(admissions,6);assert.equal(calls,0);
});
test('a revoked admission prevents the second HTTP request including poll/retry traffic',async()=>{
  let permitted=true,calls=0;
  const gate:ProviderRequestAdmission=async(launch,signal)=>{if(!permitted)throw new Error('Fictional revoked');return launch(signal??new AbortController().signal);};
  const client=new HttpClient(async()=>{calls++;return new Response('{}');}).withAdmission(gate);
  await client.json('https://provider.invalid/task');permitted=false;await assert.rejects(client.json('https://provider.invalid/task/status'),/revoked/);assert.equal(calls,1);
});
test('commercial flag still rejects before delivery even when a trusted admission allows',async()=>{
  let calls=0;const gate:ProviderRequestAdmission=async launch=>launch(new AbortController().signal);
  const runtime=createProviderRuntime({env:{OPENAI_API_KEY:'fictional-key'},fetch:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(runtime.speech({text:'Fictional'},{requestAdmission:gate}),{code:'PROVIDER_NOT_CONFIGURED'});assert.equal(calls,0);
});
test('only a validated existing fal task cancellation is a control request after revocation',async()=>{
  let deliveries=0;const seen:{url:string;method:unknown;body:unknown}[]=[];
  const client=new HttpClient(async(url,init)=>{deliveries++;seen.push({url:String(url),method:init?.method,body:init?.body});return new Response('{}');}).withAdmission(async()=>{throw new Error('Fictional revoked');});
  await assert.rejects(client.json('https://queue.fal.run/fal-ai/fixture',{method:'POST',body:'fictional'}),/revoked/);
  await client.cancelFal('fictional','https://queue.fal.run/fal-ai/fixture/requests/fictional/cancel',{});
  assert.deepEqual(seen,[{url:'https://queue.fal.run/fal-ai/fixture/requests/fictional/cancel',method:'PUT',body:undefined}]);
  for(const url of ['https://queue.fal.run/fal-ai/fixture','https://queue.fal.run/fal-ai/fixture/requests/other/cancel','https://provider.invalid/requests/fictional/cancel','https://queue.fal.run/requests/fictional/cancel?payload=fake','https://queue.fal.run/requests/fictional/cancel#payload'])await assert.rejects(client.cancelFal('fictional',url,{}),{code:'INVALID_PROVIDER_TASK'});
  assert.equal(deliveries,1);
});

test('workflow chat and media child steps preserve the same admission callback at actual HTTP delivery',async()=>{
  const {executeWorkflow}=await import('../src/workflow.ts');const {workflowStore}=await import('./fixtures/workflow-store.ts');
  let allowed=true,deliveries=0;const contexts:unknown[]=[];
  const gate:ProviderRequestAdmission=async(launch,signal)=>{if(!allowed)throw new Error('Fictional revoked between steps');return launch(signal??new AbortController().signal);};
  const http=new HttpClient(async()=>{deliveries++;return new Response('{}');});
  const runtime:import('@companion/platform-contracts').PlatformProviderRuntime={
    capabilities:()=>[{id:'ollama',name:'Fictional chat',enabled:true,keyConfigured:true,capabilities:['chat'],models:[],envVariables:[]},{id:'openai',name:'Fictional image',enabled:true,keyConfigured:true,capabilities:['image'],models:[],envVariables:[]}],
    async *streamChat(_input,context){contexts.push(context?.requestAdmission);await http.withAdmission(context?.requestAdmission).json('https://fictional.invalid/chat');yield {type:'delta',text:'Fictional result'};},
    async executeJob(_input,context){contexts.push(context.requestAdmission);await http.withAdmission(context.requestAdmission).json('https://fictional.invalid/image');return {artifacts:[]};},
    async createVoiceSession(){throw new Error('Not used');},async transcribe(){throw new Error('Not used');},async speech(){throw new Error('Not used');},
  };
  const input:import('@companion/platform-contracts').CreateJobInput={kind:'workflow',provider:'workflow',prompt:'Fictional',options:{steps:[{kind:'chat',provider:'ollama',model:'fictional-chat',prompt:'{{input}}'},{kind:'image',provider:'openai',model:'fictional-image',prompt:'{{previous}}'}]}};
  const store=workflowStore(input,{jobId:'fictional',userId:'fictional',workspaceDirectory:'/fictional',requestAdmission:gate});store.afterSave=async(event,snapshot)=>{if(event.type==='completed')allowed=false;return snapshot;};
  await assert.rejects(executeWorkflow(runtime,input,store.context()));assert.deepEqual(contexts,[gate,gate]);assert.equal(deliveries,1);
});

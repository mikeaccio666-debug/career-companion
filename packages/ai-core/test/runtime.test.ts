import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderRuntime, ProviderError } from '../src/index.ts';
import { HttpClient, readSse } from '../src/http.ts';
import { downloadMedia } from '../src/media.ts';
import type { CreateJobInput, JobExecutionContext } from '@companion/platform-contracts';
import { workflowStore } from './fixtures/workflow-store.ts';

const context:JobExecutionContext={jobId:'fictional-job',userId:'fictional-user',workspaceDirectory:'/tmp/fictional-workspace'};
const paid={PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fixture-key'};
const publicResolver=async()=>[{address:'203.0.113.4',family:4}];
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
function json(body:unknown){return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});}
function events(body:unknown[]){const encoded=body.map(event=>`data: ${JSON.stringify(event)}\r\n\r\n`).join('')+'data: [DONE]\r\n\r\n';const bytes=new TextEncoder().encode(encoded);return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
function fake(fn:(url:string,init:RequestInit)=>Promise<Response>|Response):typeof fetch{return ((url:any,init:RequestInit={})=>fn(String(url),init)) as typeof fetch;}
async function collect(stream:AsyncIterable<any>){const result=[];for await(const item of stream)result.push(item);return result;}

test('commercial providers stay disabled until explicit server opt-in; no OpenAI video',async()=>{
  let calls=0;const runtime=createProviderRuntime({env:{OPENAI_API_KEY:'fixture-key'},fetch:fake(()=>{calls++;return json({});})});
  assert.deepEqual(runtime.capabilities().find(p=>p.id==='comfyui')?.capabilities,[]);
  assert.equal(runtime.capabilities().find(p=>p.id==='openai')?.enabled,false);
  assert.equal(runtime.capabilities().find(p=>p.id==='openai')?.capabilities.includes('video'),false);
  const references={maxImages:4,maxTotalBytes:20*1024*1024,mimeTypes:['image/png','image/jpeg','image/webp']};
  assert.deepEqual(runtime.capabilities().find(p=>p.id==='openai')?.referenceImages,{image:{...references,binding:'openai_edits'}});
  assert.deepEqual(runtime.capabilities().find(p=>p.id==='ark')?.referenceImages,{video:{...references,binding:'ark_video'}});
  assert.deepEqual(runtime.capabilities().find(p=>p.id==='fal')?.referenceImages,{image:{...references,binding:'fal_input'},video:{...references,binding:'fal_input'}});
  assert.equal(runtime.capabilities().find(p=>p.id==='comfyui')?.referenceImages,undefined);
  assert.throws(()=>runtime.streamChat({provider:'openai',mode:'chat',messages:[{role:'user',content:'fictional'}]}),(err:unknown)=>err instanceof ProviderError&&err.status===503);
  await assert.rejects(runtime.createVoiceSession(),{code:'PROVIDER_NOT_CONFIGURED'});assert.equal(calls,0);
});

test('CLI capability requires an isolated image plus explicit paid task relay configuration',()=>{
  const configured={PLATFORM_ENABLE_CLI:'1',PLATFORM_CLI_IMAGE:'fictional-harness:reviewed',PLATFORM_CLI_COMMAND:'["codex","exec","-"]',OPENAI_API_KEY:'fictional-key'};
  const status=(env:NodeJS.ProcessEnv)=>createProviderRuntime({env}).capabilities().find(provider=>provider.id==='cli')!;
  assert.equal(status(configured).enabled,false);
  assert.equal(status({...configured,PLATFORM_CLI_MODEL_RELAY:'1'}).enabled,false);
  const ready=status({...configured,PLATFORM_CLI_MODEL_RELAY:'1',PLATFORM_ALLOW_PROVIDER_CALLS:'1',PLATFORM_CLI_MODEL:'fictional-model'});
  assert.equal(ready.enabled,true);assert.deepEqual(ready.modelsByCapability?.cli,['fictional-model']);
});

test('Realtime WebRTC input transcription is separately configured and never inherits file transcription',async()=>{
  let calls=0,body:any;
  const transport=fake((_url,init)=>{calls++;body=JSON.parse(String(init.body));return json({value:'fictional-ephemeral'});});
  const first=await createProviderRuntime({env:{...paid,OPENAI_TRANSCRIBE_MODEL:'gpt-transcribe'},fetch:transport}).createVoiceSession();
  assert.equal(first.inputTranscriptionEnabled,false);assert.equal(body.session.audio.input,undefined);
  const second=await createProviderRuntime({env:{...paid,OPENAI_REALTIME_TRANSCRIBE_MODEL:'fictional-webrtc-transcriber'},fetch:transport}).createVoiceSession();
  assert.equal(second.inputTranscriptionEnabled,true);assert.equal(body.session.audio.input.transcription.model,'fictional-webrtc-transcriber');
  await assert.rejects(createProviderRuntime({env:{...paid,OPENAI_REALTIME_TRANSCRIBE_MODEL:'gpt-transcribe'},fetch:transport}).createVoiceSession(),{code:'INVALID_PROVIDER_INPUT'});assert.equal(calls,2);
});

test('SSE parser handles UTF-8, comments, CRLF and split packets',async()=>{
  const records=await collect(readSse(events([{type:'delta',text:'你好🌱'}])));assert.deepEqual(records,[{type:'delta',text:'你好🌱'}]);
});

test('OpenAI Responses executes only allowed tools and replays output without retained conversations',async()=>{
  const requests:any[]=[];let calls=0;
  const runtime=createProviderRuntime({env:paid,fetch:fake((_url,init)=>{requests.push(JSON.parse(String(init.body)));return calls++===0?events([
    {type:'response.output_item.done',item:{type:'function_call',call_id:'c1',name:'list_jobs',arguments:'{}'}},
    {type:'response.completed',response:{output:[{type:'reasoning',encrypted_content:'fixture-encrypted'},{type:'function_call',call_id:'c1',name:'list_jobs',arguments:'{}'}]}}
  ]):events([{type:'response.output_text.delta',delta:'Nothing pending.'},{type:'response.completed',response:{output:[],usage:{input_tokens:12,output_tokens:3}}}]);})});
  let executed=0;const result=await collect(runtime.streamChat({provider:'openai',mode:'agent',messages:[{role:'user',content:'List my fictional tasks.'}]},{tools:[{name:'list_jobs',description:'List current user tasks',parameters:{type:'object',properties:{},additionalProperties:false}}],executeTool:async()=>{executed++;return {jobs:[]};}}));
  assert.equal(executed,1);assert.equal(requests[0].store,false);assert.equal(requests[1].input.at(-1).type,'function_call_output');assert.equal(requests[1].input.at(-2).call_id,'c1');assert.equal(result.filter(e=>e.type==='delta').map(e=>e.text).join(''),'Nothing pending.');assert.equal(result.at(-1).type,'usage');
});

test('unknown model tool never reaches the application callback',async()=>{
  let executed=0;const runtime=createProviderRuntime({env:paid,fetch:fake(()=>events([{type:'response.completed',response:{output:[{type:'function_call',call_id:'c',name:'run_shell',arguments:'{}'}]}}]))});
  await assert.rejects(collect(runtime.streamChat({provider:'openai',mode:'agent',messages:[{role:'user',content:'fictional'}]},{tools:[],executeTool:async()=>{executed++;}})),{code:'TOOL_NOT_ALLOWED'});assert.equal(executed,0);
});

test('a dropped provider stream is an error, not a completed assistant answer',async()=>{
  const runtime=createProviderRuntime({env:paid,fetch:fake(()=>events([{type:'response.output_text.delta',delta:'Partial'}]))});
  await assert.rejects(collect(runtime.streamChat({provider:'openai',mode:'chat',messages:[{role:'user',content:'fictional'}]})),{code:'PROVIDER_STREAM_INTERRUPTED'});
});

test('actual local HTTP Ollama transport streams split tool arguments and sends tool results',async()=>{
  const bodies:any[]=[];const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const output=bodies.length===1?[
      {choices:[{index:0,delta:{tool_calls:[{index:0,id:'c1',function:{name:'lookup',arguments:'{"term":'}}]},finish_reason:null}]},
      {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"fictional"}'}}]},finish_reason:'tool_calls'}]}
    ]:[{choices:[{index:0,delta:{content:'Found it.'},finish_reason:'stop'}]}];
    for(const event of output){const record=`data: ${JSON.stringify(event)}\n\n`;res.write(record.slice(0,11));res.write(record.slice(11));}res.end('data: [DONE]\n\n');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
  try{const runtime=createProviderRuntime({env:{OLLAMA_BASE_URL:`http://127.0.0.1:${port}/v1`,OLLAMA_CHAT_MODEL:'fixture-local'}});const result=await collect(runtime.streamChat({provider:'ollama',mode:'agent',messages:[{role:'user',content:'Find a fictional term.'}]},{tools:[{name:'lookup',description:'Lookup a term',parameters:{type:'object',properties:{term:{type:'string'}},required:['term']}}],executeTool:async(_name,args)=>{assert.equal(args.term,'fictional');return {found:true};}}));assert.equal(result.at(-1).text,'Found it.');assert.equal(bodies[1].messages.at(-1).role,'tool');assert.equal(bodies[1].messages.at(-1).tool_call_id,'c1');}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Ark stores task ID before polling and resumes without submitting another video',async()=>{
  const urls:string[]=[];let saved:string|undefined;const fetcher=fake((url,init)=>{urls.push(url);if(init.method==='POST')return json({id:'task-fixture'});if(url.includes('/tasks/')){assert.equal(saved,'task-fixture');return json({status:'succeeded',content:{video_url:'https://cdn.volces.com/fixture.mp4'}});}return new Response(new Uint8Array([0,1,2]),{headers:{'Content-Type':'video/mp4'}});});
  const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',ARK_API_KEY:'fixture-key',ARK_VIDEO_MODEL:'fixture-endpoint'},fetch:fetcher,resolveHost:publicResolver});
  const input={kind:'video' as const,provider:'ark',prompt:'Fictional scene',options:{duration:5,aspectRatio:'16:9'}};const result=await runtime.executeJob(input,{...context,onProviderTask:id=>{saved=id;}});assert.equal(result.artifacts[0].mime,'video/mp4');
  urls.length=0;await runtime.executeJob(input,{...context,previousProviderTaskId:saved});assert.equal(urls.some(url=>url.endsWith('/tasks')),false);
});

test('fal opaque task handles preserve provider URLs across restarts',async()=>{
  let handle='';let posts=0;const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',FAL_KEY:'fixture-key',FAL_IMAGE_ENDPOINT:'fal-ai/fixture'},resolveHost:publicResolver,fetch:fake((url,init)=>{
    if(init.method==='POST'){posts++;return json({request_id:'fixture-id',status_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-id/status',response_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-id/response',cancel_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-id/cancel'});}
    if(url.endsWith('/status')){assert.ok(handle.startsWith('fal:'));return json({status:'COMPLETED'});}if(url.endsWith('/response'))return json({images:[{url:'https://v3.fal.media/fixture.png',content_type:'image/png'}]});return new Response(png);
  })});const input={kind:'image' as const,provider:'fal',prompt:'Fictional'};await runtime.executeJob(input,{...context,onProviderTask:value=>{handle=value;}});await runtime.executeJob(input,{...context,previousProviderTaskId:handle});assert.equal(posts,1);
});

test('media download rejects private addresses and redirects before reading data',async()=>{
  let calls=0;const client=new HttpClient(fake(()=>{calls++;return new Response('bad');}),async()=>[{address:'127.0.0.1',family:4}]);await assert.rejects(downloadMedia(client,{},'https://v3.fal.media/fixture','x.png','image/png'),{code:'UNTRUSTED_MEDIA_URL'});await assert.rejects(downloadMedia(client,{},'https://127.0.0.1/fixture','x.png','image/png'),{code:'UNTRUSTED_MEDIA_URL'});assert.equal(calls,0);
});

test('upstream errors do not expose credentials, page contents, or raw bodies',async()=>{
  const runtime=createProviderRuntime({env:paid,fetch:fake(()=>new Response('secret fictional-key /private/path',{status:401}))});await assert.rejects(runtime.createVoiceSession(),(error:any)=>error.code==='PROVIDER_AUTH_FAILED'&&!error.message.includes('fictional-key')&&!error.message.includes('/private'));
});

test('image edits use attached bytes, and voice uses temporary tokens and audio binary',async()=>{
  const requests:{url:string;body:any}[]=[];const runtime=createProviderRuntime({env:paid,fetch:fake((url,init)=>{requests.push({url,body:init.body});if(url.includes('/images/'))return json({data:[{b64_json:Buffer.from(png).toString('base64')}]});if(url.includes('/client_secrets'))return json({value:'fixture-ephemeral',expires_at:123});if(url.includes('/transcriptions'))return json({text:'Fictional transcript'});return new Response(new Uint8Array([1,2,3]));})});
  const image=await runtime.executeJob({kind:'image',provider:'openai',prompt:'Fictional edit',attachmentIds:['fixture-upload']},{...context,readAttachment:async()=>({name:'fixture.png',mime:'image/png',bytes:png})});assert.equal(image.artifacts[0].name,'image-1.png');assert.ok(requests[0].body instanceof FormData);assert.ok(requests[0].body.get('image[]') instanceof Blob);
  const voice=await runtime.createVoiceSession();assert.equal(voice.clientSecret,'fixture-ephemeral');assert.equal(voice.endpoint,'https://api.openai.com/v1/realtime/calls');assert.equal((await runtime.speech({text:'Fictional speech'})).mime,'audio/mpeg');assert.equal((await runtime.transcribe({name:'fixture.webm',mime:'audio/webm',bytes:new Uint8Array([1])})).text,'Fictional transcript');
});

test('workflow checks every supplier before running any step and propagates previous text',async()=>{
  let calls=0;const runtime=createProviderRuntime({env:paid,fetch:fake((url,init)=>{calls++;if(url.includes('/responses'))return events([{type:'response.output_text.delta',delta:'Fixture article.'},{type:'response.completed',response:{output:[]}}]);assert.equal(JSON.parse(String(init.body)).input,'Fixture article.');return new Response(new Uint8Array([1]));})});
  const unavailable:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'fictional',options:{steps:[{kind:'chat',provider:'openai',model:'fictional-chat-model',prompt:'{{input}}'},{kind:'video',provider:'fal',model:'fal-ai/fictional',prompt:'{{previous}}'}]}};
  await assert.rejects(runtime.executeJob(unavailable,workflowStore(unavailable,context).context()),{code:'WORKFLOW_PROVIDER_UNAVAILABLE'});assert.equal(calls,0);
  const input:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'fictional',options:{steps:[{kind:'chat',provider:'openai',model:'fictional-chat-model',prompt:'{{input}}'},{kind:'speech',provider:'openai',model:'fictional-speech-model',prompt:'{{previous}}'}]}},store=workflowStore(input,context);
  const result=await runtime.executeJob(input,store.context());assert.equal(result.artifacts.length,0);assert.equal(store.published.length,2);assert.equal(store.published[1].name,'step-2-speech.mp3');
});

test('workflow interpolation treats input and earlier output as literal text',async()=>{
  const goal='Literal {{previous}} {{input}} $& $$', earlier='Output {{input}} {{previous}} $&';let calls=0;
  const runtime=createProviderRuntime({env:paid,fetch:fake((_url,init)=>{
    const body=JSON.parse(String(init.body));
    assert.equal(body.input[0].content,calls===0?`First: ${goal}`:`Next: ${goal} | ${earlier}`);calls++;
    return events([{type:'response.output_text.delta',delta:earlier},{type:'response.completed',response:{output:[]}}]);
  })});
  const input:CreateJobInput={kind:'workflow',provider:'workflow',prompt:goal,options:{steps:[
    {kind:'chat',provider:'openai',model:'fictional-chat-model',prompt:'First: {{input}}'},
    {kind:'chat',provider:'openai',model:'fictional-chat-model',prompt:'Next: {{input}} | {{previous}}'},
  ]}};await runtime.executeJob(input,workflowStore(input,context).context());assert.equal(calls,2);
});

test('speech jobs propagate cancellation to the provider request',async()=>{
  const controller=new AbortController();let requested=false;
  const runtime=createProviderRuntime({env:paid,fetch:fake(async(_url,init)=>{requested=true;assert.ok(init.signal);return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true}));})});
  const task=runtime.executeJob({kind:'speech',provider:'openai',prompt:'Fictional speech'},{...context,signal:controller.signal});assert.ok(requested);controller.abort();await assert.rejects(task,{code:'PROVIDER_INTERRUPTED'});
});

test('historical attachments become structured model input, never raw binary objects',async()=>{
  let body:any;const runtime=createProviderRuntime({env:paid,fetch:fake((_url,init)=>{body=JSON.parse(String(init.body));return events([{type:'response.output_text.delta',delta:'Fixture attachment reply.'},{type:'response.completed',response:{output:[]}}]);})});
  await collect(runtime.streamChat({provider:'openai',mode:'chat',messages:[{role:'user',content:'Read this',attachments:[{name:'fixture.pdf',mime:'application/pdf',bytes:new Uint8Array([1])}]},{role:'assistant',content:'Fixture summary'},{role:'user',content:'Ask again'}]}));assert.equal(body.input[0].content[1].type,'input_file');assert.equal(body.input[0].attachments,undefined);
});

test('workflow rejects unsupported attachments before calling a supplier',async()=>{
  let calls=0;const runtime=createProviderRuntime({env:paid,fetch:fake(()=>{calls++;return json({});})});await assert.rejects(runtime.executeJob({kind:'workflow',provider:'workflow',prompt:'fictional',attachmentIds:['fixture'],options:{steps:[{kind:'chat',provider:'openai',prompt:'{{input}}'}]}},context),{code:'INVALID_PROVIDER_INPUT'});assert.equal(calls,0);
});

test('ComfyUI runs a server-reviewed template and retrieves the same task after restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-core-'));const template=path.join(directory,'fixture.json');await fs.writeFile(template,JSON.stringify({'6':{class_type:'CLIPTextEncode',inputs:{text:'placeholder'}}}));let posts=0;let id='';
  try{const runtime=createProviderRuntime({env:{COMFYUI_BASE_URL:'http://127.0.0.1:8188',COMFYUI_WORKFLOW_TEMPLATE:template,COMFYUI_PROMPT_NODE:'6',COMFYUI_OUTPUT_KIND:'image'},fetch:fake((url,init)=>{if(init.method==='POST'){posts++;assert.equal(JSON.parse(String(init.body)).prompt['6'].inputs.text,'fictional scene');return json({prompt_id:'fixture-task'});}if(url.includes('/history/'))return json({'fixture-task':{status:{completed:true,status_str:'success'},outputs:{'9':{images:[{filename:'fixture.png',subfolder:'',type:'output'}]}}}});return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64'),{headers:{'Content-Type':'image/png'}});})});const snapshot=runtime.captureComfyUITemplate!();const input={kind:'image' as const,provider:'comfyui',prompt:'fictional scene',executionTemplate:{version:1 as const,hash:snapshot.hash}};await runtime.executeJob(input,{...context,comfyuiTemplate:snapshot,onProviderTask:value=>{id=value;}});await runtime.executeJob(input,{...context,comfyuiTemplate:snapshot,previousProviderTaskId:id});assert.equal(posts,1);}
  finally{await fs.rm(directory,{recursive:true,force:true});}
});

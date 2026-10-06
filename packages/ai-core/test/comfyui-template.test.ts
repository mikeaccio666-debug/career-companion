import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createProviderRuntime, parseExecutionTemplateBinding, validateComfyUITemplateSnapshot, workflowDefinitionHash } from '../src/index.ts';
import type { ComfyUITemplateSnapshot, CreateJobInput } from '@companion/platform-contracts';
import { workflowStore } from './fixtures/workflow-store.ts';
import { workflowHash } from '../src/json-hash.ts';
import { mp4, png, webm } from './fixtures/comfy-media.ts';

const context = { jobId: 'synthetic-comfy-task', userId: 'synthetic-user', workspaceDirectory: '/tmp/synthetic-comfy-workspace' };
const graph = (label = 'first') => ({
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'synthetic placeholder' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: label, images: ['6', 0] } },
});
const binding = (snapshot: ComfyUITemplateSnapshot) => ({ version: 1 as const, hash: snapshot.hash });
async function fixture(run: (template: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fictional-comfy-version-'));
  const template = path.join(directory, 'fictional-template.json');
  try { await fs.writeFile(template, JSON.stringify(graph())); await run(template, { COMFYUI_BASE_URL: 'http://127.0.0.1:8188', COMFYUI_WORKFLOW_TEMPLATE: template, COMFYUI_PROMPT_NODE: '6', COMFYUI_OUTPUT_KIND:'image', PLATFORM_POLL_ATTEMPTS: '1' }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('real local HTTP receives the original private snapshot after file replacement and runtime restart', async () => fixture(async (template, env) => {
  const posts: any[] = [], history: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { assert.equal(url.pathname, '/prompt'); let bytes = ''; for await (const chunk of req) bytes += chunk; posts.push(JSON.parse(bytes)); res.end(JSON.stringify({ prompt_id: `synthetic-${posts.length}` })); return; }
    if (url.pathname.startsWith('/history/')) { const id = url.pathname.split('/').at(-1)!; history.push(id); res.end(JSON.stringify({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'synthetic.png', type: 'output', subfolder: '' }] } } } })); return; }
    assert.equal(url.pathname, '/view'); res.setHeader('Content-Type', 'image/png'); res.end(png);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string');
  env = { ...env, COMFYUI_BASE_URL: `http://127.0.0.1:${address.port}` };
  try {
    const original = createProviderRuntime({ env }), snapshot = original.captureComfyUITemplate!();
    const exported = original.captureComfyUITemplate!(); (exported.graph['9'] as any).inputs.filename_prefix = 'untrusted mutation';
    assert.equal((original.captureComfyUITemplate!().graph['9'] as any).inputs.filename_prefix, 'first');
    const catalog = original.capabilities().find(provider => provider.id === 'comfyui')!;
    assert.deepEqual(catalog.executionTemplate, binding(snapshot)); assert(!JSON.stringify(catalog).includes(template)); assert(!JSON.stringify(catalog).includes('class_type')); assert(!JSON.stringify(catalog).includes(env.COMFYUI_BASE_URL!));
    await fs.writeFile(template, JSON.stringify(graph('second'))); assert.equal(original.captureComfyUITemplate!().hash, snapshot.hash, 'startup version does not change silently');
    const restarted = createProviderRuntime({ env }), latest = restarted.captureComfyUITemplate!(); assert.notEqual(latest.hash, snapshot.hash);
    await fs.rm(template); // Neither dispatch nor resume reads the source pathname.
    const input: CreateJobInput = {kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)};
    let handle = '';
    await restarted.executeJob(input, {...context,comfyuiTemplate:snapshot,onProviderTask:id=>{handle=id;}});
    await restarted.executeJob(input, {...context,comfyuiTemplate:snapshot,previousProviderTaskId:handle});
    await restarted.executeJob({...input,executionTemplate:binding(latest)}, {...context,comfyuiTemplate:latest});
    assert.equal(posts.length, 2); assert.equal(posts[0].prompt['9'].inputs.filename_prefix, 'first'); assert.equal(posts[1].prompt['9'].inputs.filename_prefix, 'second');
    for (const post of posts) { assert.equal(post.prompt['6'].inputs.text, input.prompt); assert.equal(post.client_id, context.jobId); }
    assert.equal((snapshot.graph['6'] as any).inputs.text,'synthetic placeholder'); assert.deepEqual(history,['synthetic-1','synthetic-1','synthetic-2']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); }
}));

test('snapshot validation survives JSONB ordering and detects graph, endpoint and injection-field tampering', async () => fixture(async (_template, env) => {
  const snapshot = createProviderRuntime({env}).captureComfyUITemplate!(), pin = binding(snapshot);
  const reordered = {...snapshot, graph:{'9':snapshot.graph['9'],'6':snapshot.graph['6']}};
  assert.equal(validateComfyUITemplateSnapshot(reordered,pin).hash,pin.hash);
  for (const changed of [{...snapshot,baseUrl:'http://127.0.0.1:8189'},{...snapshot,promptField:'other'},{...snapshot,graph:graph('different')},{...snapshot,hash:'0'.repeat(64)}])
    assert.throws(()=>validateComfyUITemplateSnapshot(changed,pin),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  assert.throws(()=>parseExecutionTemplateBinding({...pin,graph:graph()}),{code:'COMFYUI_TEMPLATE_BINDING_INVALID'});
  assert.throws(()=>parseExecutionTemplateBinding({version:2,hash:pin.hash}),{code:'COMFYUI_TEMPLATE_BINDING_INVALID'});
}));

test('malformed, oversized, UI-format and unusable prompt templates disable ComfyUI without exposing paths', async () => fixture(async (template, env) => {
  const candidates = ['{', JSON.stringify({nodes:[],links:[]}), JSON.stringify({'6':{class_type:'CLIPTextEncode',inputs:{other:'placeholder'}}}), JSON.stringify({'6':{class_type:'CLIPTextEncode',inputs:{text:42}}}), JSON.stringify(graph('x'.repeat(256*1024)))];
  for (const candidate of candidates) {
    await fs.writeFile(template,candidate); const runtime=createProviderRuntime({env}); const status=runtime.capabilities().find(item=>item.id==='comfyui')!;
    assert.equal(status.enabled,false); assert.equal(status.executionTemplate,undefined); assert(!status.reason?.includes(template));
    assert.throws(()=>runtime.captureComfyUITemplate!(),{code:'INVALID_COMFYUI_TEMPLATE'});
  }
  await fs.writeFile(template,JSON.stringify(graph()));
  for(const base of ['http://user:secret@127.0.0.1:8188','http://127.0.0.1:8188?secret=fictional','file:///tmp/fictional']) assert.equal(createProviderRuntime({env:{...env,COMFYUI_BASE_URL:base}}).capabilities().find(item=>item.id==='comfyui')!.enabled,false);
}));

test('missing, forged or changed-server versions reject dispatch and known-handle polling before any network request', async () => fixture(async (_template,env)=>{
  let requests=0; const fetcher:typeof fetch=async()=>{requests++;throw new Error('A rejected plan must not use the network');};
  const runtime=createProviderRuntime({env,fetch:fetcher}), snapshot=runtime.captureComfyUITemplate!();
  const input:CreateJobInput={kind:'image',provider:'comfyui',prompt:'Fictional scene',executionTemplate:binding(snapshot)};
  for(const resume of [undefined,'synthetic-known-handle']) {
    const ctx={...context,previousProviderTaskId:resume};
    await assert.rejects(runtime.executeJob(input,ctx),{code:'COMFYUI_TEMPLATE_UNBOUND'});
    await assert.rejects(runtime.executeJob({...input,executionTemplate:undefined},{...ctx,comfyuiTemplate:snapshot}),{code:'COMFYUI_TEMPLATE_UNBOUND'});
    await assert.rejects(runtime.executeJob({...input,executionTemplate:{version:1,hash:'0'.repeat(64)}},{...ctx,comfyuiTemplate:snapshot}),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
    const moved=createProviderRuntime({env:{...env,COMFYUI_BASE_URL:'http://127.0.0.1:8189'},fetch:fetcher});
    await assert.rejects(moved.executeJob(input,{...ctx,comfyuiTemplate:snapshot}),{code:'COMFYUI_SERVER_CHANGED'});
  }
  await assert.rejects(runtime.executeJob({...input,model:'a client-selected model'},{...context,comfyuiTemplate:snapshot}),{code:'INVALID_PROVIDER_INPUT'}); assert.equal(requests,0);
}));

test('an unfinished invalid ComfyUI version stops a whole workflow before earlier text or checkpoints', async () => fixture(async (_template,env)=>{
  let requests=0, checkpoints=0; const runtime=createProviderRuntime({env:{...env,OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_CHAT_MODEL:'synthetic-text'},fetch:async()=>{requests++;throw new Error('Must not be called');}}), snapshot=runtime.captureComfyUITemplate!();
  const input:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'A fictional goal',options:{steps:[{kind:'chat',provider:'ollama',model:'synthetic-text',prompt:'{{input}}'},{kind:'image',provider:'comfyui',prompt:'{{previous}}',executionTemplate:binding(snapshot)}]}};
  const store=workflowStore(input,context);
  await assert.rejects(runtime.executeJob(input,{...store.context(),onWorkflowCheckpoint:async()=>{checkpoints++;throw new Error('Must not start');}}),{code:'COMFYUI_TEMPLATE_UNBOUND'});
  const broken={...snapshot,graph:graph('modified')};
  await assert.rejects(runtime.executeJob(input,{...store.context(),workflowComfyUITemplates:{'1':broken}}),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  assert.equal(requests,0);assert.equal(checkpoints,0);assert.equal(store.snapshot().steps.length,0);
  const changed=structuredClone(input); (changed.options!.steps as any[])[1].executionTemplate.hash='0'.repeat(64);
  assert.notEqual(workflowDefinitionHash(input),workflowDefinitionHash(changed));
}));

test('unconfirmed ComfyUI submissions remain uncertain while an explicit queue rejection is terminal', async () => fixture(async (_template,env)=>{
  const responses = [new Response('{broken',{headers:{'Content-Type':'application/json'}}),Response.json({}),new Response('fictional private provider failure',{status:500}),Response.json({prompt_id:'synthetic-accepted'})];
  for (const response of responses) {
    let calls=0;const runtime=createProviderRuntime({env,fetch:async()=>{calls++;return response;}}),snapshot=runtime.captureComfyUITemplate!();
    await assert.rejects(runtime.executeJob({kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)}, {...context,comfyuiTemplate:snapshot,onProviderTask:async()=>{throw new Error('lost private checkpoint ACK');}}), error => {
      assert.equal((error as any).code,'COMFYUI_SUBMISSION_UNCERTAIN');assert(!String((error as any).message).includes('private'));return true;
    });assert.equal(calls,1);
  }
  const runtime=createProviderRuntime({env,fetch:async()=>Response.json({error:{type:'synthetic-validation-rejection'}})}),snapshot=runtime.captureComfyUITemplate!();
  await assert.rejects(runtime.executeJob({kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)}, {...context,comfyuiTemplate:snapshot}),{code:'COMFYUI_REJECTED'});
}));

test('reviewed output kind is mandatory, immutable and part of the opaque version hash', async () => fixture(async (_template, env) => {
  let calls = 0;
  for (const kind of [undefined, '', 'audio', 'image,video', 'image ']) {
    const runtime = createProviderRuntime({env:{...env, COMFYUI_OUTPUT_KIND:kind}, fetch:async()=>{calls++;throw new Error('Disabled provider must not use network');}});
    const status = runtime.capabilities().find(item=>item.id==='comfyui')!;
    assert.equal(status.enabled,false);assert.deepEqual(status.capabilities,[]);assert.equal(status.executionTemplate,undefined);
    assert.throws(()=>runtime.captureComfyUITemplate!(),{code:'INVALID_COMFYUI_TEMPLATE'});
  }
  const image = createProviderRuntime({env}), video = createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video'}});
  const first = image.captureComfyUITemplate!(), second = video.captureComfyUITemplate!();
  assert.equal(first.outputKind,'image');assert.equal(second.outputKind,'video');assert.notEqual(first.hash,second.hash);
  assert.deepEqual(image.capabilities().find(item=>item.id==='comfyui')!.capabilities,['image']);
  assert.deepEqual(video.capabilities().find(item=>item.id==='comfyui')!.capabilities,['video']);
  assert.throws(()=>validateComfyUITemplateSnapshot({...first,outputKind:'video'},binding(first)),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  assert.equal(calls,0);
}));

test('a missing historical kind preserves its old digest only through the completed-record opt-in', async () => fixture(async (_template,env)=>{
  const current=createProviderRuntime({env}).captureComfyUITemplate!(); const {outputKind:_kind,hash:_hash,...oldBody}=current;
  const legacy={...oldBody,hash:workflowHash(oldBody)};
  assert.throws(()=>validateComfyUITemplateSnapshot(legacy,binding(legacy)),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  assert.deepEqual(validateComfyUITemplateSnapshot(legacy,binding(legacy),{allowHistoricalWithoutOutputKind:true}),legacy);
  for(const kind of [undefined,null,'audio'])assert.throws(()=>validateComfyUITemplateSnapshot({...legacy,outputKind:kind},binding(legacy),{allowHistoricalWithoutOutputKind:true}),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  let calls=0;const runtime=createProviderRuntime({env,fetch:async()=>{calls++;throw new Error('Historical snapshot cannot execute');}});
  for(const previousProviderTaskId of [undefined,'synthetic-saved-handle']) await assert.rejects(runtime.executeJob({kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(legacy)}, {...context,comfyuiTemplate:legacy,previousProviderTaskId}),{code:'COMFYUI_TEMPLATE_SNAPSHOT_INVALID'});
  assert.equal(calls,0);
}));

test('kind mismatch blocks both submit and known-handle polling without consuming credentials or private URLs', async () => fixture(async (_template, env) => {
  let calls=0;const secret='synthetic-credential-not-delivered';const fetcher:typeof fetch=async()=>{calls++;throw new Error('Rejected kind must not reach private server');};
  const image=createProviderRuntime({env:{...env,OPENAI_API_KEY:secret},fetch:fetcher}),video=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video',OPENAI_API_KEY:secret},fetch:fetcher});
  for(const [runtime,snapshot,kind] of [[image,video.captureComfyUITemplate!(),'image'],[video,image.captureComfyUITemplate!(),'video']] as const)
    for(const previousProviderTaskId of [undefined,'synthetic-accepted'])await assert.rejects(runtime.executeJob({kind,provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)}, {...context,comfyuiTemplate:snapshot,previousProviderTaskId}),error=>{
      assert.equal((error as any).code,'COMFYUI_OUTPUT_KIND_MISMATCH');assert(!String((error as any).message).includes(env.COMFYUI_BASE_URL!));assert(!String((error as any).message).includes(secret));return true;
    });
  assert.equal(calls,0);
}));

test('real HTTP video output selects verified MP4/WebM rather than poster images or filename extensions', async () => fixture(async (_template, env) => {
  let posts=0;const fetched:string[]=[];const requestedHeaders:string[]=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');requestedHeaders.push(...Object.keys(req.headers).filter(name=>['authorization','cookie','x-companion-account'].includes(name)));
    if(req.method==='POST'){for await(const _ of req){}posts++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({prompt_id:'synthetic-video'}));return;}
    if(url.pathname.startsWith('/history/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({'synthetic-video':{status:{completed:true},outputs:{'9':{images:[{filename:'poster.png',type:'output'}],videos:[{filename:'result.json',type:'output'}],gifs:[{filename:'clip.dat',type:'output'}]}}}}));return;}
    const name=url.searchParams.get('filename')!;fetched.push(name);assert.notEqual(name,'poster.png');res.setHeader('Content-Type',name==='result.json'?'video/mp4':'video/webm');res.end(name==='result.json'?mp4():webm());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  try{
    const runtime=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video',COMFYUI_BASE_URL:`http://127.0.0.1:${address.port}`,OPENAI_API_KEY:'synthetic-private-key'}}),snapshot=runtime.captureComfyUITemplate!();
    const input:CreateJobInput={kind:'video',provider:'comfyui',prompt:'Synthetic container fixture',executionTemplate:binding(snapshot)};
    const output=await runtime.executeJob(input,{...context,comfyuiTemplate:snapshot});
    assert.deepEqual(output.artifacts.map(item=>[item.name,item.mime]),[['video-1.mp4','video/mp4'],['video-2.webm','video/webm']]);
    await runtime.executeJob(input,{...context,comfyuiTemplate:snapshot,previousProviderTaskId:output.providerTaskId});
    assert.equal(posts,1);assert.deepEqual(fetched,['result.json','clip.dat','result.json','clip.dat']);assert.deepEqual(requestedHeaders,[]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

test('wrong selected output rejects the result before any successful publication, including resumed handles', async () => fixture(async (_template,env)=>{
  for(const [kind,bytes,mime,key] of [['image',mp4(),'image/png','images'],['image',png,'image/jpeg','images'],['video',png,'video/mp4','videos'],['video',Buffer.from('GIF89a'),'image/gif','gifs'],['video',webm({audio:true}),'video/webm','videos']] as const){
    let posts=0,published=0;const runtime=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:kind},fetch:async(_url,init)=>{
      if(init?.method==='POST'){posts++;return Response.json({prompt_id:'synthetic-invalid'});}if(String(_url).includes('/history/'))return Response.json({'synthetic-invalid':{status:{completed:true},outputs:{'9':{[key]:[{filename:'pretends-valid.mp4',type:'output'}]}}}});return new Response(new Uint8Array(bytes),{headers:{'Content-Type':mime}});
    }}),snapshot=runtime.captureComfyUITemplate!(),input:CreateJobInput={kind,provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)};
    for(const previousProviderTaskId of [undefined,'synthetic-invalid'])await assert.rejects(runtime.executeJob(input,{...context,comfyuiTemplate:snapshot,previousProviderTaskId}).then(result=>{published+=result.artifacts.length;}),{code:'COMFYUI_OUTPUT_INVALID'});
    assert.equal(posts,1);assert.equal(published,0);
  }
}));

test('a video template with only poster images has no video output and does not fetch the poster', async () => fixture(async (_template,env)=>{
  let downloads=0;const runtime=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video'},fetch:async(url)=>{
    if(String(url).includes('/view')){downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
    return Response.json({'synthetic-video':{status:{completed:true},outputs:{'9':{images:[{filename:'poster.png',type:'output'}]}}}});
  }}),snapshot=runtime.captureComfyUITemplate!();
  await assert.rejects(runtime.executeJob({kind:'video',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)}, {...context,comfyuiTemplate:snapshot,previousProviderTaskId:'synthetic-video'}),{code:'COMFYUI_NO_OUTPUT'});assert.equal(downloads,0);
}));

test('invalid output metadata cannot be interpreted as generated files', async () => fixture(async (_template,env)=>{
  for(const outputs of [[], 'a filename is not outputs', null, {'9':null}, {'9':{images:{filename:'fake.png'}}}, {'9':{images:[[]]}}]){
    let downloads=0;const runtime=createProviderRuntime({env,fetch:async(url)=>{
      if(String(url).includes('/view')){downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
      return Response.json({'synthetic-malformed':{status:{completed:true},outputs}});
    }}),snapshot=runtime.captureComfyUITemplate!();
    await assert.rejects(runtime.executeJob({kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(snapshot)}, {...context,comfyuiTemplate:snapshot,previousProviderTaskId:'synthetic-malformed'}),{code:'COMFYUI_OUTPUT_INVALID'});assert.equal(downloads,0);
  }
}));

test('a new invalid configuration or changed output kind rejects saved snapshots without replay', async () => fixture(async (template,env)=>{
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw new Error('Configuration must fail before network');};
  const saved=createProviderRuntime({env}).captureComfyUITemplate!(),input:CreateJobInput={kind:'image',provider:'comfyui',prompt:'A fictional scene',executionTemplate:binding(saved)};
  const changed=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video'},fetch:fetcher});
  assert.throws(()=>changed.validateComfyUITemplate!(saved,binding(saved)),{code:'COMFYUI_OUTPUT_KIND_MISMATCH'});
  for(const previousProviderTaskId of [undefined,'synthetic-original'])await assert.rejects(changed.executeJob(input,{...context,comfyuiTemplate:saved,previousProviderTaskId}),{code:'COMFYUI_OUTPUT_KIND_MISMATCH'});
  await fs.writeFile(template,'{bad'); const disabled=createProviderRuntime({env,fetch:fetcher});
  assert.equal(disabled.capabilities().find(item=>item.id==='comfyui')!.enabled,false);
  assert.throws(()=>disabled.validateComfyUITemplate!(saved,binding(saved)),{code:'INVALID_COMFYUI_TEMPLATE'});
  for(const previousProviderTaskId of [undefined,'synthetic-original'])await assert.rejects(disabled.executeJob(input,{...context,comfyuiTemplate:saved,previousProviderTaskId}),{code:'INVALID_COMFYUI_TEMPLATE'});
  assert.equal(calls,0);
}));

test('workflow preflight kind mismatch stops earlier text, and invalid media cannot publish a completed checkpoint', async () => fixture(async (_template,env)=>{
  let requests=0;const runtime=createProviderRuntime({env:{...env,OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_CHAT_MODEL:'synthetic-text'},fetch:async()=>{requests++;throw new Error('Invalid frozen kind cannot execute');}});
  const savedVideo=createProviderRuntime({env:{...env,COMFYUI_OUTPUT_KIND:'video'}}).captureComfyUITemplate!();
  const input:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'A fictional goal',options:{steps:[{kind:'chat',provider:'ollama',model:'synthetic-text',prompt:'{{input}}'},{kind:'image',provider:'comfyui',prompt:'{{previous}}',executionTemplate:binding(savedVideo)}]}},store=workflowStore(input,context);
  await assert.rejects(runtime.executeJob(input,{...store.context(),workflowComfyUITemplates:{'1':savedVideo}}),{code:'COMFYUI_OUTPUT_KIND_MISMATCH'});assert.equal(requests,0);assert.equal(store.events.length,0);
  const invalidRuntime=createProviderRuntime({env,fetch:async(url,init)=>init?.method==='POST'?Response.json({prompt_id:'synthetic-invalid'}):String(url).includes('/history/')?Response.json({'synthetic-invalid':{status:{completed:true},outputs:{'9':{images:[{filename:'invalid.png',type:'output'}]}}}}):new Response('not an image',{headers:{'Content-Type':'image/png'}})}),snapshot=invalidRuntime.captureComfyUITemplate!();
  const single:CreateJobInput={kind:'workflow',provider:'workflow',prompt:'A fictional goal',options:{steps:[{kind:'image',provider:'comfyui',prompt:'{{input}}',executionTemplate:binding(snapshot)}]}},failed=workflowStore(single,context);
  await assert.rejects(invalidRuntime.executeJob(single,{...failed.context(),workflowComfyUITemplates:{'0':snapshot}}),{code:'COMFYUI_OUTPUT_INVALID'});assert.equal(failed.snapshot().steps[0].state,'failed');assert.equal(failed.published.length,0);assert(!failed.events.some(event=>event.type==='completed'));
}));

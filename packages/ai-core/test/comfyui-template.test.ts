import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createProviderRuntime, parseExecutionTemplateBinding, validateComfyUITemplateSnapshot, workflowDefinitionHash } from '../src/index.ts';
import type { ComfyUITemplateSnapshot, CreateJobInput } from '@companion/platform-contracts';
import { workflowStore } from './fixtures/workflow-store.ts';

const context = { jobId: 'synthetic-comfy-task', userId: 'synthetic-user', workspaceDirectory: '/tmp/synthetic-comfy-workspace' };
const graph = (label = 'first') => ({
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'synthetic placeholder' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: label, images: ['6', 0] } },
});
const binding = (snapshot: ComfyUITemplateSnapshot) => ({ version: 1 as const, hash: snapshot.hash });
async function fixture(run: (template: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fictional-comfy-version-'));
  const template = path.join(directory, 'fictional-template.json');
  try { await fs.writeFile(template, JSON.stringify(graph())); await run(template, { COMFYUI_BASE_URL: 'http://127.0.0.1:8188', COMFYUI_WORKFLOW_TEMPLATE: template, COMFYUI_PROMPT_NODE: '6', PLATFORM_POLL_ATTEMPTS: '1' }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('real local HTTP receives the original private snapshot after file replacement and runtime restart', async () => fixture(async (template, env) => {
  const posts: any[] = [], history: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { assert.equal(url.pathname, '/prompt'); let bytes = ''; for await (const chunk of req) bytes += chunk; posts.push(JSON.parse(bytes)); res.end(JSON.stringify({ prompt_id: `synthetic-${posts.length}` })); return; }
    if (url.pathname.startsWith('/history/')) { const id = url.pathname.split('/').at(-1)!; history.push(id); res.end(JSON.stringify({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'synthetic.png', type: 'output', subfolder: '' }] } } } })); return; }
    assert.equal(url.pathname, '/view'); res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([137,80,78,71,13,10,26,10,0]));
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

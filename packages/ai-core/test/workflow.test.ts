import test from 'node:test';
import assert from 'node:assert/strict';
import type { CreateJobInput, WorkflowStep, JobExecutionContext, JobExecutionResult, PlatformProviderRuntime, ProviderStatus, ChatInput, ComfyUITemplateSnapshot } from '@companion/platform-contracts';
import { executeWorkflow, workflowHash, workflowDefinitionHash } from '../src/workflow.ts';
import { createProviderRuntime, ProviderError, validateComfyUITemplateSnapshot } from '../src/index.ts';
import { workflowStore } from './fixtures/workflow-store.ts';

const base: JobExecutionContext = { jobId: 'fixture-workflow', userId: 'fixture-user', workspaceDirectory: '/tmp/fixture-workflow' };
const image = new Uint8Array([137,80,78,71,13,10,26,10,0]);
const plan = (steps: WorkflowStep[], prompt = 'A synthetic goal'): CreateJobInput => ({ kind: 'workflow', provider: 'workflow', prompt, options: { steps } });
const chat: WorkflowStep = { kind: 'chat', provider: 'ollama', model: 'fixture-chat-model', prompt: 'Draft {{input}}' };
const speech: WorkflowStep = { kind: 'speech', provider: 'openai', model: 'fixture-speech-model', prompt: '{{previous}}' };
const photo: WorkflowStep = { kind: 'image', provider: 'openai', model: 'fixture-image-model', prompt: '{{input}}' };
const video: WorkflowStep = { kind: 'video', provider: 'ark', model: 'fixture-video-model', prompt: '{{input}}' };
const output = (mime = 'image/png'): JobExecutionResult => ({ artifacts: [{ name: 'fixture.png', mime, bytes: image }] });
const statuses: ProviderStatus[] = [
  ['ollama', ['chat']], ['openai', ['chat','image','speech']], ['ark', ['video']], ['fal', ['image','video']], ['comfyui', ['image','video']],
].map(([id, capabilities]) => ({ id: id as string, name: id as string, keyConfigured: true, enabled: true, models: [], envVariables: [], capabilities: capabilities as ProviderStatus['capabilities'] }));
function fixture(overrides: Partial<PlatformProviderRuntime> = {}): PlatformProviderRuntime {
  return { capabilities: () => structuredClone(statuses),
    async *streamChat() { yield { type: 'delta', text: 'Synthetic article.' }; },
    async executeJob() { return output(); },
    async createVoiceSession() { throw new Error('Not used'); },
    async transcribe() { throw new Error('Not used'); },
    async speech() { throw new Error('Not used'); }, ...overrides };
}
const errorCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code;

test('canonical plan hashes survive JSONB key order and ignore review metadata', () => {
  const input = plan([{ ...photo, model: 'fixture-model', options: { z: 1, a: { y: true, x: null } } }]);
  const reordered = plan([{ options: { a: { x: null, y: true }, z: 1 }, prompt: photo.prompt, model: 'fixture-model', provider: photo.provider, kind: photo.kind }]);
  assert.equal(workflowDefinitionHash(input), workflowDefinitionHash(reordered));
  assert.equal(workflowDefinitionHash(input), workflowDefinitionHash({ ...input, options: { ...input.options, previousAttemptUncertain: true, reviewConfirmed: true } }));
  assert.notEqual(workflowDefinitionHash(input), workflowDefinitionHash({ ...input, prompt: 'Changed goal' }));
  assert.equal(workflowHash({ b: 2, a: 1 }), workflowHash({ a: 1, b: 2 }));
  assert.equal(workflowHash({ a: undefined, b: [undefined] }), workflowHash({ b: [null] }));
  assert.equal(workflowHash(Array(1)), workflowHash([null]));
  assert.throws(() => workflowHash({ a: new Date() }), errorCode('INVALID_PROVIDER_INPUT'));
  const circular: any = {}; circular.self = circular;
  assert.throws(() => workflowHash(circular), errorCode('INVALID_PROVIDER_INPUT'));
  assert.throws(() => workflowHash({ x: 'x'.repeat(512 * 1024) }), errorCode('INVALID_PROVIDER_INPUT'));
});

test('workflow has no execution path without durable checkpoint ports', async () => {
  let calls = 0; const input = plan([photo]);
  const runtime = fixture({ executeJob: async () => { calls++; return output(); } });
  await assert.rejects(executeWorkflow(runtime, input, base), errorCode('WORKFLOW_CHECKPOINT_UNAVAILABLE'));
  assert.equal(calls, 0);
});

test('all unfinished providers and reference bindings are checked before the first dispatch', async () => {
  let calls = 0;
  const runtime = fixture({ executeJob: async () => { calls++; return output(); }, capabilities: () => statuses.map(status => ({ ...status, enabled: status.id !== 'ark' })) });
  const unavailable = plan([photo, video]);
  const store = workflowStore(unavailable, base);
  await assert.rejects(executeWorkflow(runtime, unavailable, store.context()), errorCode('WORKFLOW_PROVIDER_UNAVAILABLE'));
  assert.equal(store.events.length, 0); assert.equal(calls, 0);
  const incompatible = plan([photo, { ...video, options: { referenceMode: 'first_last_frame' }, referenceImages: [{ fromStep: 0 }] }]);
  const bindingStore = workflowStore(incompatible, base);
  await assert.rejects(executeWorkflow(fixture(), incompatible, bindingStore.context()), errorCode('INVALID_PROVIDER_INPUT'));
  assert.equal(bindingStore.events.length, 0);
  for(const steps of [
    [photo,{...photo,model:'gpt-image-1.5',options:{aspectRatio:'16:9'}}],
    [photo,{...video,model:'doubao-seedance-2-5-260628',options:{aspectRatio:'16:9'},referenceImages:[{fromStep:0}]}],
  ]){
    const invalidModel=plan(steps),modelStore=workflowStore(invalidModel,base);
    await assert.rejects(executeWorkflow(fixture({executeJob:async()=>{calls++;return output();}}),invalidModel,modelStore.context()),errorCode('INVALID_PROVIDER_INPUT'));
    assert.equal(modelStore.events.length,0);assert.equal(calls,0);
  }
  assert.throws(() => workflowDefinitionHash(plan([photo, { ...video, referenceImages: [{ fromStep: 1 }] }])), errorCode('INVALID_PROVIDER_INPUT'));
  assert.throws(() => workflowDefinitionHash(plan([chat, { ...video, referenceImages: [{ fromStep: 0 }] }])), errorCode('INVALID_PROVIDER_INPUT'));
  assert.throws(() => workflowDefinitionHash(plan([photo, { ...video, referenceImages: [{ fromStep: 0 }, { fromStep: 0, imageIndex: 0 }] }])), errorCode('INVALID_PROVIDER_INPUT'));
  assert.throws(() => workflowDefinitionHash(plan([photo, { ...video, referenceImages: [{ fromStep: 0, imageIndex: 8 }] }])), errorCode('INVALID_PROVIDER_INPUT'));
  assert.throws(() => workflowDefinitionHash(plan(Array(9).fill(chat))), errorCode('INVALID_PROVIDER_INPUT'));
  const unfrozen = plan([{ ...photo, model: undefined }]); const unfrozenStore = workflowStore(unfrozen, base);
  await assert.rejects(executeWorkflow(fixture(), unfrozen, unfrozenStore.context()), errorCode('INVALID_PROVIDER_INPUT'));
  assert.equal(unfrozenStore.events.length, 0);
});

test('completed text and artifacts survive interruption without replay or provider readiness', async () => {
  const input = plan([chat, speech]); const store = workflowStore(input, base);
  let drafts = 0, spoken = 0;
  const first = fixture({ async *streamChat() { drafts++; yield { type: 'delta', text: 'Saved literal {{input}} $&.' }; } });
  await assert.rejects(executeWorkflow(first, input, store.context({ onProgress: () => { throw new Error('Synthetic worker restart'); } })), /Synthetic worker restart/);
  assert.equal(store.snapshot().steps[0].state, 'completed'); assert.equal(store.published.length, 1);
  const resumed = fixture({ capabilities: () => statuses.map(status => ({ ...status, enabled: status.id !== 'ollama' })),
    async *streamChat() { drafts++; throw new Error('Completed step replayed'); },
    async executeJob(child) { spoken++; assert.equal(child.prompt, 'Saved literal {{input}} $&.'); return output('audio/mpeg'); } });
  assert.deepEqual(await executeWorkflow(resumed, input, store.context()), { artifacts: [] });
  assert.equal(drafts, 1); assert.equal(spoken, 1); assert.equal(store.published.length, 2);
  const disabled = fixture({ capabilities: () => [], executeJob: async () => { throw new Error('Completed step replayed'); } });
  assert.deepEqual(await executeWorkflow(disabled, input, store.context()), { artifacts: [] });
  assert.equal(store.published.length, 2); assert.deepEqual(store.events.map(event => event.type), ['started','completed','started','completed']);
});

test('a confirmed queue handle resumes by polling and uncertain handles never submit a second task', async () => {
  const input = plan([video]); const store = workflowStore(input, base); let posts = 0, polls = 0;
  const runtime = fixture({ async executeJob(_child, ctx) {
    if (!ctx.previousProviderTaskId) { posts++; await ctx.onProviderTask?.('fixture-task'); assert.equal(store.snapshot().steps[0].state, 'provider_task'); throw new ProviderError('PROVIDER_TASK_PENDING', 'Synthetic pending', 504); }
    polls++; assert.equal(ctx.previousProviderTaskId, 'fixture-task'); return output('video/mp4');
  } });
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('PROVIDER_TASK_PENDING'));
  const checkpoint = store.snapshot(); checkpoint.steps[0].state = 'uncertain'; checkpoint.steps[0].errorCode = 'WORKFLOW_CHECKPOINT_UNCONFIRMED'; store.replace(checkpoint);
  await executeWorkflow(runtime, input, store.context());
  assert.equal(posts, 1); assert.equal(polls, 1);
  assert.deepEqual(store.events.map(event => event.type), ['started','provider_task','provider_task','completed']);
});

test('started and uncertain steps without a handle remain held instead of being dispatched', async () => {
  const input = plan([photo]); const store = workflowStore(input, base); let calls = 0;
  const runtime = fixture({ executeJob: async () => { calls++; throw new Error('Synthetic lost external response'); } });
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(store.snapshot().steps[0].state, 'uncertain'); assert.equal(calls, 1);
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  const checkpoint = store.snapshot(); checkpoint.steps[0].state = 'started'; store.replace(checkpoint);
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(calls, 1); assert.equal(store.snapshot().steps[0].state, 'uncertain');
});

test('lost completion acknowledgment stops the chain and the durable receipt prevents replay', async () => {
  const input = plan([photo, { ...speech, prompt: 'Synthetic narration' }]); const store = workflowStore(input, base); let calls = 0;
  const runtime = fixture({ async executeJob() { calls++; return output(); } });
  store.afterSave = (event, saved) => { if (event.type === 'completed') throw new Error('Synthetic lost DB acknowledgment'); return saved; };
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(calls, 1); assert.equal(store.snapshot().steps[0].state, 'completed');
  store.afterSave = undefined;
  await executeWorkflow(runtime, input, store.context());
  assert.equal(calls, 2); assert.equal(store.published.length, 2);
});

test('checkpoint refusal or corrupted acknowledgments never authorize a provider call', async () => {
  const input = plan([photo]); const store = workflowStore(input, base); let calls = 0;
  const runtime = fixture({ executeJob: async () => { calls++; return output(); } });
  store.onEvent = () => { throw new Error('Synthetic expired lease'); };
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_CHECKPOINT_UNCONFIRMED'));
  assert.equal(calls, 0); assert.equal(store.snapshot().revision, 0);
  store.onEvent = undefined; store.afterSave = (_event, saved) => ({ ...saved, revision: saved.revision + 1 });
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_CHECKPOINT_INVALID'));
  assert.equal(calls, 0);
});

test('frozen goal, step options and effective input hashes are validated before dispatch', async () => {
  const input = plan([photo]); const store = workflowStore(input, base); let calls = 0;
  const runtime = fixture({ executeJob: async () => { calls++; return output(); } });
  await assert.rejects(executeWorkflow(runtime, { ...input, prompt: 'A modified goal' }, store.context()), errorCode('WORKFLOW_CHECKPOINT_INVALID'));
  await executeWorkflow(runtime, input, store.context());
  const changed = store.snapshot(); changed.steps[0].inputHash = '0'.repeat(64); store.replace(changed);
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('WORKFLOW_CHECKPOINT_INVALID'));
  assert.equal(calls, 1);
});

test('only confirmed terminal failures permit an explicitly authorized new attempt', async () => {
  const template = { version: 1 as const, outputKind: 'image' as const, baseUrl: 'http://127.0.0.1:8188', promptNode: '6', promptField: 'text', graph: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'synthetic placeholder' } } } };
  const snapshot: ComfyUITemplateSnapshot = { ...template, hash: workflowHash(template) };
  const input = plan([{ kind: 'image', provider: 'comfyui', prompt: '{{input}}', executionTemplate: {version:1,hash:snapshot.hash} }]); const store = workflowStore(input, base); let attempts = 0;
  const execution = () => ({...store.context(),workflowComfyUITemplates:{'0':snapshot}});
  const runtime = fixture({ validateComfyUITemplate: (saved, binding) => { validateComfyUITemplateSnapshot(saved,binding); }, async executeJob(_input, ctx) {
    assert.equal(ctx.previousProviderTaskId, undefined); attempts++;
    await ctx.onProviderTask?.(`fixture-${attempts}`);
    if (attempts === 1) throw new ProviderError('COMFYUI_REJECTED', 'Confirmed synthetic rejection');
    return output();
  } });
  await assert.rejects(executeWorkflow(runtime, input, execution()), errorCode('COMFYUI_REJECTED'));
  assert.equal(store.snapshot().steps[0].state, 'failed');
  // The port in the API additionally requires a new generation, approval and current lease for this transition.
  await executeWorkflow(runtime, input, execution());
  assert.equal(attempts, 2); assert.equal(store.snapshot().steps[0].state, 'completed');
  assert.deepEqual(store.events.map(event => event.type), ['started','provider_task','failed','started','provider_task','completed']);
});

test('cancellation and truncated text streams are uncertain and cannot become successful receipts', async () => {
  const input = plan([chat]); const store = workflowStore(input, base); const controller = new AbortController();
  const runtime = fixture({ async *streamChat() { yield { type: 'delta', text: 'Partial synthetic text.' }; controller.abort(); throw new ProviderError('PROVIDER_STREAM_INTERRUPTED', 'Synthetic interrupted stream'); } });
  await assert.rejects(executeWorkflow(runtime, input, store.context({ signal: controller.signal })), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(store.snapshot().steps[0].state, 'uncertain'); assert.equal(store.published.length, 0);
  const large = workflowStore(input, base);
  const oversized = fixture({ async *streamChat() { yield { type: 'delta', text: 'x'.repeat(65 * 1024) }; } });
  await assert.rejects(executeWorkflow(oversized, input, large.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(large.snapshot().steps[0].errorCode, 'WORKFLOW_OUTPUT_LIMIT'); assert.equal(large.published.length, 0);
});

test('result limits match durable storage and media types are canonical before acknowledgment', async () => {
  const input = plan([photo]); const store = workflowStore(input, base);
  await executeWorkflow(fixture({ executeJob: async () => output('image/png; charset=binary') }), input, store.context());
  assert.equal(store.snapshot().steps[0].artifacts![0].mime, 'image/png');
  const oversized = workflowStore(input, base);
  await assert.rejects(executeWorkflow(fixture({ executeJob: async () => ({ artifacts: Array(9).fill(output().artifacts[0]) }) }), input, oversized.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(oversized.snapshot().steps[0].errorCode, 'WORKFLOW_OUTPUT_LIMIT'); assert.equal(oversized.published.length, 0);
  const empty = workflowStore(plan([chat]), base);
  await assert.rejects(executeWorkflow(fixture({ async *streamChat() {} }), plan([chat]), empty.context()), errorCode('WORKFLOW_STEP_UNCERTAIN'));
  assert.equal(empty.published.length, 0);
});

test('image chaining delivers only authorized private receipts through scoped virtual attachments', async () => {
  const input = plan([photo, { ...video, referenceImages: [{ fromStep: 0 }] }]); const store = workflowStore(input, base);
  let reads = 0, source = 0, target = 0;
  const runtime = fixture({ async executeJob(child, ctx) {
    if (child.kind === 'image') { source++; return output(); }
    target++; assert.deepEqual(child.attachmentIds, ['workflow-reference-1-0']);
    assert.equal(ctx.workflowCheckpoint, undefined); assert.equal(ctx.onWorkflowCheckpoint, undefined);
    const ref = await ctx.readAttachment!(child.attachmentIds![0]); assert.deepEqual(ref.bytes, image);
    await assert.rejects(ctx.readAttachment!('other-private-upload'), errorCode('INVALID_PROVIDER_INPUT'));
    return output('video/mp4');
  } });
  const ctx = store.context(); const read = ctx.readWorkflowArtifact!;
  ctx.readWorkflowArtifact = async id => { reads++; return read(id); };
  await executeWorkflow(runtime, input, ctx);
  assert.equal(source, 1); assert.equal(target, 1); assert.equal(reads, 1);
  await executeWorkflow(fixture({ capabilities: () => [] }), input, store.context({ readWorkflowArtifact: async () => { throw new Error('Completed bytes must not be re-read'); } }));
  assert.equal(store.published.length, 2);
});

test('missing private bytes never regenerate a completed source and resumed queues do not reread references', async () => {
  const input = plan([photo, { ...video, referenceImages: [{ fromStep: 0 }] }]); const store = workflowStore(input, base); let sources = 0, posts = 0, polls = 0;
  const runtime = fixture({ async executeJob(child, ctx) {
    if (child.kind === 'image') { sources++; return output(); }
    if (!ctx.previousProviderTaskId) { posts++; await ctx.onProviderTask?.('fixture-queue'); throw new ProviderError('PROVIDER_TASK_PENDING', 'Synthetic pending'); }
    polls++; assert.equal(child.attachmentIds, undefined); return output('video/mp4');
  } });
  await assert.rejects(executeWorkflow(runtime, input, store.context({ readWorkflowArtifact: async () => { throw new Error('Synthetic lost blob'); } })), errorCode('WORKFLOW_REFERENCE_UNAVAILABLE'));
  assert.equal(sources, 1); assert.equal(posts, 0); assert.equal(store.snapshot().steps.length, 1);
  await assert.rejects(executeWorkflow(runtime, input, store.context()), errorCode('PROVIDER_TASK_PENDING'));
  await executeWorkflow(runtime, input, store.context({ readWorkflowArtifact: async () => { throw new Error('Queued references must not be re-read'); } }));
  assert.equal(sources, 1); assert.equal(posts, 1); assert.equal(polls, 1);
});

test('real provider adapters send a completed private image to Ark through fake HTTP without public uploads', async () => {
  const input = plan([{ ...photo, model: 'fixture-image-model' }, { ...video, model: 'fixture-video-endpoint', referenceImages: [{ fromStep: 0 }] }]);
  const store = workflowStore(input, base); let imagePosts = 0, videoPosts = 0;
  const fetcher = (async (url: any, init: RequestInit = {}) => {
    if (String(url).includes('/images/generations')) { imagePosts++; return Response.json({ data: [{ b64_json: Buffer.from(image).toString('base64') }] }); }
    if (init.method === 'POST') { videoPosts++; const body = JSON.parse(String(init.body));
      assert.equal(body.content[1].image_url.url, `data:image/png;base64,${Buffer.from(image).toString('base64')}`);
      assert.equal(body.content[1].role, 'first_frame'); return Response.json({ id: 'fixture-task' }); }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://cdn.volces.com/fixture.mp4' } });
    return new Response(new Uint8Array([1,2,3]), { headers: { 'Content-Type': 'video/mp4' } });
  }) as typeof fetch;
  const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fixture-only', ARK_API_KEY: 'fixture-only', ARK_VIDEO_MODEL: 'fixture-video-endpoint' }, fetch: fetcher, resolveHost: async () => [{ address: '203.0.113.4', family: 4 }] });
  await runtime.executeJob(input, store.context());
  assert.equal(imagePosts, 1); assert.equal(videoPosts, 1); assert.equal(store.published.length, 2);
  assert.deepEqual(store.events.map(event => event.type), ['started','completed','started','provider_task','completed']);
});

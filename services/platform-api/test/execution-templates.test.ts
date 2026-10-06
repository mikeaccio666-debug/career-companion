import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComfyUITemplateSnapshot, CreateJobInput, PlatformProviderRuntime, WorkflowStep } from '@companion/platform-contracts';
import { ProviderError, validateComfyUITemplateSnapshot, workflowDefinitionHash, workflowHash } from '@companion/ai-core';
import { executeWorkflow } from '../../../packages/ai-core/src/workflow.ts';
import { ApiError } from '../src/errors.ts';
import { bindExecutionTemplates, safeJobExecutionTemplate, validateExecutionTemplates } from '../src/execution-templates.ts';
import { completedWorkflowStepIndexes } from '../src/workflow-checkpoints.ts';

function saved(outputKind?: 'image' | 'video'): ComfyUITemplateSnapshot {
  const body = { version: 1 as const, baseUrl: 'http://127.0.0.1:8188', promptNode: '1', promptField: 'text',
    graph: { '1': { class_type: 'FictionalText', inputs: { text: 'Fictional template input' } } }, ...(outputKind ? { outputKind } : {}) };
  return { ...body, hash: workflowHash(body) };
}
const pin = (value: ComfyUITemplateSnapshot) => ({ version: 1 as const, hash: value.hash });
const direct = (kind: 'image' | 'video', value?: ComfyUITemplateSnapshot): CreateJobInput => ({ kind, provider: 'comfyui', prompt: 'Fictional media', ...(value ? { executionTemplate: pin(value) } : {}) });
const workflow = (value: ComfyUITemplateSnapshot): CreateJobInput => ({ kind: 'workflow', provider: 'workflow', prompt: 'Fictional workflow', options: { steps: [{ kind: 'image', provider: 'comfyui', prompt: 'Fictional image', executionTemplate: pin(value) }] } });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function runtime(value: ComfyUITemplateSnapshot) {
  let validations = 0;
  const forbidden = async (): Promise<never> => { throw new Error('Template validation cannot execute anything.'); };
  const provider: PlatformProviderRuntime = {
    capabilities: () => [{ id: 'comfyui', name: 'Fictional reviewed template', enabled: true, keyConfigured: true, capabilities: ['image', 'video'], models: [], envVariables: [] }],
    captureComfyUITemplate: () => structuredClone(value),
    validateComfyUITemplate: (snapshot, binding) => { validations++; validateComfyUITemplateSnapshot(snapshot, binding); },
    streamChat: async function* () { throw new Error('No model request is permitted.'); }, executeJob: forbidden,
    createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
  };
  return { provider, validations: () => validations };
}

test('new capture requires a declared kind and refuses direct/workflow kind mismatches without executing', () => {
  const image = saved('image'), item = runtime(image);
  const accepted = bindExecutionTemplates(direct('image'), item.provider);
  assert.deepEqual(accepted.input.executionTemplate, pin(image)); assert.equal(accepted.comfyui!.job!.outputKind, 'image');
  assert.throws(() => bindExecutionTemplates(direct('video'), item.provider), code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  const mixed = { ...workflow(image), options: { steps: [{ kind: 'image', provider: 'comfyui', prompt: 'First image' }, { kind: 'video', provider: 'comfyui', prompt: 'Second video' }] } };
  assert.throws(() => bindExecutionTemplates(mixed, item.provider), code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  assert.throws(() => bindExecutionTemplates(direct('image'), runtime(saved()).provider), code('COMFYUI_TEMPLATE_UNAVAILABLE'));
});

test('unfinished legacy snapshots fail closed; only completed workflow steps retain the original missing-kind hash', () => {
  const legacy = saved(), input = workflow(legacy), policy = { comfyui: { steps: { '0': legacy } } }, item = runtime(saved('image'));
  assert.throws(() => validateExecutionTemplates(input, policy, item.provider), code('COMFYUI_TEMPLATE_INVALID'));
  const historical = validateExecutionTemplates(input, policy, item.provider, new Set([0]));
  assert.deepEqual(historical, policy.comfyui); assert.equal(item.validations(), 0);
  assert(!Object.hasOwn(historical!.steps!['0'], 'outputKind')); assert.equal(historical!.steps!['0'].hash, legacy.hash);
  assert.throws(() => validateExecutionTemplates(direct('image', legacy), { comfyui: { job: legacy } }, item.provider, new Set([0])), code('COMFYUI_TEMPLATE_INVALID'));
});

test('historical opt-in does not allow an explicit null/undefined kind or a changed legacy digest', () => {
  const legacy = saved(), input = workflow(legacy);
  for (const mutation of [{ ...legacy, outputKind: null }, { ...legacy, outputKind: undefined }, { ...legacy, hash: '0'.repeat(64) }]) {
    assert.throws(() => validateExecutionTemplates(input, { comfyui: { steps: { '0': mutation } } }, undefined, new Set([0])), code('COMFYUI_TEMPLATE_INVALID'));
  }
});

test('a valid opposite-kind snapshot cannot authorize the requested media, even for polling or completed history', () => {
  const video = saved('video'), item = runtime(video);
  assert.throws(() => validateExecutionTemplates(direct('image', video), { comfyui: { job: video } }, item.provider), code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  for (const completed of [new Set<number>(), new Set([0])]) {
    assert.throws(() => validateExecutionTemplates(workflow(video), { comfyui: { steps: { '0': video } } }, item.provider, completed), code('COMFYUI_OUTPUT_KIND_MISMATCH'));
  }
  assert.equal(item.validations(), 0);
});

test('completed indexes come only from completed checkpoint states and never waive an unfinished source', () => {
  const value = completedWorkflowStepIndexes([
    { index: 0, inputHash: 'a'.repeat(64), state: 'completed' },
    { index: 1, inputHash: 'b'.repeat(64), state: 'provider_task', providerTaskId: 'fictional-handle' },
    { index: 2, inputHash: 'c'.repeat(64), state: 'uncertain' },
  ]);
  assert.deepEqual([...value], [0]); assert.deepEqual([...completedWorkflowStepIndexes(undefined)], []);
  assert.deepEqual([...completedWorkflowStepIndexes([{ index: 1, inputHash: 'a'.repeat(64), state: 'completed' }])], []);
  assert.deepEqual([...completedWorkflowStepIndexes([{ index: 0, inputHash: 'not-a-checkpoint-hash', state: 'completed' }])], []);
  assert.deepEqual([...completedWorkflowStepIndexes([
    { index: 0, inputHash: 'a'.repeat(64), state: 'completed' }, { index: 0, inputHash: 'b'.repeat(64), state: 'completed' },
  ])], [0]);
});

test('public historical binding remains readable without exposing or recapturing the private graph', () => {
  const legacy = saved(); assert.deepEqual(safeJobExecutionTemplate({ comfyui: { job: legacy } }), pin(legacy));
  assert.deepEqual(Object.keys(safeJobExecutionTemplate({ comfyui: { job: legacy } })!), ['version', 'hash']);
});

test('real workflow restores a completed legacy receipt only with its normalized execution input hash', async () => {
  const legacy=saved(), input=workflow(legacy), step=(input.options!.steps as WorkflowStep[])[0], item=runtime(saved('image'));
  assert.equal(step.options,undefined);
  const fields={kind:step.kind,provider:step.provider,model:step.model,prompt:step.prompt,references:[],executionTemplate:step.executionTemplate};
  const exactHash=workflowHash({...fields,options:{}}),incorrectHash=workflowHash({...fields,options:undefined});assert.notEqual(exactHash,incorrectHash);
  const checkpoint={definitionHash:workflowDefinitionHash(input),revision:3,steps:[{index:0,state:'completed' as const,inputHash:exactHash,artifacts:[{attachmentId:'fictional-saved-image',name:'step-1-fictional.png',mime:'image/png',size:69}]}]};
  const context={jobId:'fictional-legacy-workflow',userId:'fictional-owner',workspaceDirectory:'/synthetic/unused-workflow-workspace',workflowCheckpoint:checkpoint,workflowComfyUITemplates:{'0':legacy},onWorkflowCheckpoint:async()=>{throw new Error('Completed historical receipts must not be written or replayed.');}};
  assert.deepEqual(await executeWorkflow(item.provider,input,context),{artifacts:[]});assert.equal(item.validations(),0);
  await assert.rejects(executeWorkflow(item.provider,input,{...context,workflowCheckpoint:{...checkpoint,steps:[{...checkpoint.steps[0],inputHash:incorrectHash}]}}),error=>error instanceof ProviderError&&error.code==='WORKFLOW_CHECKPOINT_INVALID');
});

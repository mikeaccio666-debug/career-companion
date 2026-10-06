import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionTemplateBinding, ProviderStatus, WorkflowTemplate } from '@companion/platform-contracts';
import { captureExecutionTemplate, captureWorkflowExecutionTemplates, executionTemplateBinding, executionTemplateReadiness, taskExecutionTemplates } from '../src/execution-template.ts';
import { creativePlanJob, creativeReadiness, freshCreativeDraft, serializeCreativeDraft } from '../src/creative-plan.ts';
import { draftFromTemplate, serializeWorkflowDraft, workflowJob, workflowReadiness } from '../src/workflow-editor.ts';

const first: ExecutionTemplateBinding = { version: 1, hash: 'a'.repeat(64) };
const second: ExecutionTemplateBinding = { version: 1, hash: 'b'.repeat(64) };
function comfy(binding: ExecutionTemplateBinding | undefined = first): ProviderStatus {
  return { id: 'comfyui', name: 'Fictional local generation', enabled: true, keyConfigured: true, capabilities: ['image', 'video'], models: [], envVariables: [], ...(binding ? { executionTemplate: structuredClone(binding) } : {}) };
}
const other: ProviderStatus = { ...comfy(), id: 'fal', models: ['fictional-model'], executionTemplate: first };

test('the public binding rejects malformed versions, digests and private template fields', () => {
  for (const value of [undefined, null, [], {}, { version: 2, hash: first.hash }, { version: 1, hash: 'not-a-digest' }, { ...first, graph: { fictional: {} } }, { ...first, path: '/fictional-template.json' }]) assert.equal(executionTemplateBinding(value), undefined);
  const original = structuredClone(first), parsed = executionTemplateBinding(original)!;
  original.hash = second.hash;
  assert.deepEqual(parsed, first);
});

test('an explicit creative review captures an immutable server binding and clears obsolete ComfyUI model input', () => {
  const provider = comfy(), draft = { ...freshCreativeDraft([provider]), prompt: 'Fictional generation.', model: 'obsolete-client-model' };
  const plan = serializeCreativeDraft(draft, [provider]), submitted = creativePlanJob(plan);
  assert.deepEqual(submitted.executionTemplate, first);
  assert.equal(Object.hasOwn(submitted, 'model'), false);
  assert.deepEqual(creativeReadiness(plan, [provider]), []);
  provider.executionTemplate!.hash = second.hash;
  draft.prompt = 'Changed editor text.';
  assert.deepEqual(plan.job.executionTemplate, first);
  assert.deepEqual(submitted.executionTemplate, first);
  assert.equal(submitted.prompt, 'Fictional generation.');
  assert.match(creativeReadiness(plan, [provider]).join(' '), /模板已更新.*重新审阅/);
  const renewed = serializeCreativeDraft(draft, [provider]);
  assert.deepEqual(renewed.job.executionTemplate, second);
  assert.deepEqual(creativeReadiness(renewed, [provider]), []);
});

test('a ComfyUI draft can be reviewed before configuration while missing or malformed versions keep creation closed', () => {
  const provider = comfy(undefined); delete provider.executionTemplate;
  const plan = serializeCreativeDraft({ ...freshCreativeDraft([provider]), prompt: 'Fictional unconfigured design.' }, [provider]);
  assert.equal(Object.hasOwn(plan.job, 'executionTemplate'), false);
  assert.match(creativeReadiness(plan, [provider]).join(' '), /模板版本尚未配置/);
  assert.match(creativeReadiness(plan, [comfy()]).join(' '), /尚未固定.*重新审阅/);
  assert.match(executionTemplateReadiness('comfyui', { ...first, graph: {} }, [comfy()]).join(' '), /尚未固定/);
  assert.match(executionTemplateReadiness('comfyui', first, [{ ...comfy(), executionTemplate: { version: 9, hash: first.hash } as never }]).join(' '), /尚未配置/);
});

test('non-ComfyUI creative and workflow steps never acquire a server template binding', () => {
  assert.equal(captureExecutionTemplate('fal', [other]), undefined);
  const draft = { ...freshCreativeDraft([other]), prompt: 'Fictional other provider.' };
  assert.equal(Object.hasOwn(serializeCreativeDraft(draft, [other]).job, 'executionTemplate'), false);
  assert.deepEqual(executionTemplateReadiness('fal', undefined, [other]), []);
  const template = captureWorkflowExecutionTemplates({ name: 'Fictional workflow', steps: [{ kind: 'image', provider: 'fal', prompt: '{{input}}', model: 'fictional-model', executionTemplate: first }] }, [other]);
  assert.equal(Object.hasOwn(template.steps[0], 'executionTemplate'), false);
  assert.equal(template.steps[0].model, 'fictional-model');
});

test('saved workflow designs discard old execution bindings and an explicit execution review pins each ComfyUI step', () => {
  const saved: WorkflowTemplate = { id: 'fictional-template', revision: 2, createdAt: '', updatedAt: '', name: 'Fictional mixed workflow', steps: [
    { kind: 'image', provider: 'comfyui', prompt: '{{input}}', model: 'obsolete-client-model', executionTemplate: first },
    { kind: 'video', provider: 'fal', prompt: '{{previous}}', model: 'fictional-model' },
    { kind: 'video', provider: 'comfyui', prompt: '{{input}}', executionTemplate: first },
  ] };
  const draft = draftFromTemplate(saved), design = serializeWorkflowDraft(draft), provider = comfy(second);
  assert.equal(Object.hasOwn(draft.steps[0], 'executionTemplate'), false);
  assert.equal(Object.hasOwn(design.steps[0], 'executionTemplate'), false);
  assert.equal(Object.hasOwn(design.steps[0], 'model'), false);
  const reviewed = captureWorkflowExecutionTemplates(design, [provider, other]), submitted = workflowJob(reviewed, 'Fictional goal.');
  assert.deepEqual(reviewed.steps[0].executionTemplate, second);
  assert.deepEqual(reviewed.steps[2].executionTemplate, second);
  assert.equal(Object.hasOwn(reviewed.steps[1], 'executionTemplate'), false);
  assert.deepEqual(workflowReadiness(reviewed.steps, [provider, other]), []);
  provider.executionTemplate!.hash = first.hash;
  assert.match(workflowReadiness(reviewed.steps, [provider, other]).join(' '), /第 1 步.*模板已更新/);
  assert.deepEqual((submitted.options!.steps as WorkflowTemplate['steps'])[0].executionTemplate, second);
  assert.deepEqual(saved.steps[0].executionTemplate, first);
});

test('jobs and approvals display the original bound version without recapturing a newer provider catalog', () => {
  const input = { kind: 'workflow', provider: 'workflow', options: { steps: [
    { kind: 'image', provider: 'comfyui', executionTemplate: first },
    { kind: 'video', provider: 'fal' },
    { kind: 'video', provider: 'comfyui', executionTemplate: second },
  ] } };
  assert.deepEqual(taskExecutionTemplates(input), [{ label: '第 1 步生成模板', binding: first }, { label: '第 3 步生成模板', binding: second }]);
  assert.deepEqual(taskExecutionTemplates({ kind: 'image', provider: 'comfyui' }), [{ label: '生成模板', binding: undefined }]);
  assert.deepEqual(taskExecutionTemplates({ kind: 'image', provider: 'comfyui', executionTemplate: { ...first, path: '/fictional.json' } }), [{ label: '生成模板', binding: undefined }]);
  assert.deepEqual(taskExecutionTemplates({ kind: 'image', provider: 'fal', executionTemplate: first }), []);
});

test('advanced parameters cannot override the reviewed ComfyUI identity or its server graph', () => {
  const provider = comfy(), draft = { ...freshCreativeDraft([provider]), prompt: 'Fictional graph boundary.' };
  for (const value of [{ executionTemplate: first }, { hash: second.hash }, { graph: {} }, { path: '/fictional.json' }]) {
    draft.optionsText = JSON.stringify(value);
    assert.throws(() => serializeCreativeDraft(draft, [provider]), /高级参数|审阅/);
    const design = draftFromTemplate({ id: 'fictional', revision: 1, name: 'Fictional design', createdAt: '', updatedAt: '', steps: [{ kind: 'image', provider: 'comfyui', prompt: '{{input}}' }] });
    design.steps[0].optionsText = JSON.stringify(value);
    assert.throws(() => serializeWorkflowDraft(design), /模板|审阅/);
  }
});

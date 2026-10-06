import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderStatus, WorkflowTemplate } from '@companion/platform-contracts';
import { canChangeWorkflowKind, draftFromTemplate, insertWorkflowPlaceholder, moveWorkflowStep, newWorkflowStep, nextWorkflowImageReference, removeWorkflowStep, serializeWorkflowDraft, workflowJob, workflowReadiness, type WorkflowDraft } from '../src/workflow-editor.ts';
import { createPlatformClient } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { listWorkflowTemplates, saveWorkflowTemplate } from '../src/workflow-api.ts';

const providers: ProviderStatus[] = [
  { id: 'text-fixture', name: 'Fictional text', keyConfigured: false, enabled: false, capabilities: ['chat'], models: ['fictional-text'], envVariables: [] },
  { id: 'image-fixture', name: 'Fictional image', keyConfigured: true, enabled: true, capabilities: ['image'], models: ['legacy-model'], modelsByCapability: { image: ['fictional-image'] }, envVariables: [] },
  { id: 'video-fixture', name: 'Fictional video', keyConfigured: true, enabled: true, capabilities: ['video'], models: ['fictional-video'], envVariables: [] },
];
function draft(): WorkflowDraft { return { name: 'Fictional reusable workflow', description: 'Fixture design only.', steps: [newWorkflowStep('chat', providers), newWorkflowStep('image', providers), newWorkflowStep('video', providers)] }; }

test('unconfigured services can be saved as designs but are identified before execution', () => {
  const input = serializeWorkflowDraft(draft());
  assert.equal(input.steps.length, 3);
  assert.equal(input.steps[1].model, 'fictional-image');
  assert.equal(workflowReadiness(input.steps, providers).length, 1);
  assert.match(workflowReadiness(input.steps, providers)[0], /第 1 步/);
  assert.equal(workflowReadiness(input.steps, providers.map((provider) => ({ ...provider, enabled: true, keyConfigured: true }))).length, 0);
});

test('readiness checks the selected capability model while allowing explicit models and ComfyUI', () => {
  const provider: ProviderStatus = { id: 'ark', name: 'Fictional Ark', enabled: true, keyConfigured: true, capabilities: ['chat', 'video'], models: ['fictional-chat'], modelsByCapability: { chat: ['fictional-chat'], video: [] }, envVariables: [] };
  const step = { kind: 'video' as const, provider: 'ark', prompt: '{{input}}' };
  assert.match(workflowReadiness([step], [provider])[0], /第 1 步.*视频.*模型/);
  assert.deepEqual(workflowReadiness([{ ...step, model: 'fictional-account-enabled-video' }], [provider]), []);
  assert.deepEqual(workflowReadiness([step], [{ ...provider, modelsByCapability: { video: ['fictional-video'] } }]), []);
  const executionTemplate = { version: 1 as const, hash: 'a'.repeat(64) };
  assert.deepEqual(workflowReadiness([{ ...step, provider: 'comfyui', executionTemplate }], [{ ...provider, id: 'comfyui', models: [], modelsByCapability: { video: [] }, executionTemplate }]), []);
  assert.match(workflowReadiness([{ ...step, model: ' ' }], [provider])[0], /模型/);
});

test('serialization rejects invalid JSON, unsupported shapes, empty prompts and oversized designs', () => {
  const input = draft();
  input.steps[0].optionsText = '{broken'; assert.throws(() => serializeWorkflowDraft(input), /第 1 步.*JSON/);
  input.steps[0].optionsText = '[]'; assert.throws(() => serializeWorkflowDraft(input), /JSON 对象/);
  input.steps[0].optionsText = ''; input.steps[0].prompt = '   '; assert.throws(() => serializeWorkflowDraft(input), /提示词/);
  input.steps = Array.from({ length: 9 }, () => newWorkflowStep('chat', providers)); assert.throws(() => serializeWorkflowDraft(input), /1 至 8/);
  input.steps = Array.from({ length: 8 }, () => ({ ...newWorkflowStep('chat', providers), prompt: '界'.repeat(20_000) })); assert.throws(() => serializeWorkflowDraft(input), /128 KiB/);
});

test('task snapshots omit template metadata and current goals never become saved template fields', () => {
  const input = serializeWorkflowDraft(draft());
  const job = workflowJob(input, '  Fictional run target.  ');
  assert.deepEqual(Object.keys(job).sort(), ['kind', 'options', 'prompt', 'provider']);
  assert.equal(job.prompt, 'Fictional run target.');
  assert.equal('prompt' in input, false);
  assert.equal('editorId' in input.steps[0], false);
  const original = input.steps[0].prompt;
  input.steps[0].prompt = 'Changed after review.';
  assert.equal((job.options!.steps as any[])[0].prompt, original);
  assert.throws(() => workflowJob(input, ' '), /本次目标/);
});

test('saved templates restore media references and advanced options without UI-only fields leaking', () => {
  const input = draft(); input.steps[2].referenceImages = [{ fromStep: 1, imageIndex: 0 }]; input.steps[2].optionsText = '{"duration":5,"referenceMode":"first_frame"}';
  const saved: WorkflowTemplate = { ...serializeWorkflowDraft(input), id: 'fictional-template', revision: 3, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' };
  const restored = draftFromTemplate(saved);
  assert.deepEqual(serializeWorkflowDraft(restored), serializeWorkflowDraft(input));
  assert.notEqual(restored.steps[0].editorId, input.steps[0].editorId);
});

test('media references must point to earlier image steps and fit supported limits', () => {
  const input = draft(); input.steps[2].referenceImages = [{ fromStep: 1 }];
  assert.deepEqual(serializeWorkflowDraft(input).steps[2].referenceImages, [{ fromStep: 1 }]);
  input.steps[2].referenceImages = [{ fromStep: 0 }]; assert.throws(() => serializeWorkflowDraft(input), /前面图片/);
  input.steps[2].referenceImages = [{ fromStep: 2 }]; assert.throws(() => serializeWorkflowDraft(input), /前面图片/);
  input.steps[2].referenceImages = [{ fromStep: 1, imageIndex: 8 }]; assert.throws(() => serializeWorkflowDraft(input), /序号/);
  input.steps[0].referenceImages = [{ fromStep: 1 }]; assert.throws(() => serializeWorkflowDraft(input), /图片或视频/);
});

test('image selections are unique by source and normalized index while allowing distinct results from one source', () => {
  const input = draft(); input.steps[2].referenceImages = [{ fromStep: 1 }, { fromStep: 1, imageIndex: 0 }];
  assert.throws(() => serializeWorkflowDraft(input), /不同的图片成果/);
  input.steps[2].referenceImages[1].imageIndex = 1;
  assert.equal(serializeWorkflowDraft(input).steps[2].referenceImages?.length, 2);
  assert.deepEqual(nextWorkflowImageReference([{ fromStep: 1 }], [1, 2]), { fromStep: 2, imageIndex: 0 });
  assert.deepEqual(nextWorkflowImageReference([{ fromStep: 1 }], [1]), { fromStep: 1, imageIndex: 1 });
  assert.equal(nextWorkflowImageReference([], []), undefined);
});

test('reordering updates references by step identity and rejects references to future results', () => {
  const input = draft(); input.steps[2].referenceImages = [{ fromStep: 1, imageIndex: 2 }];
  const reordered = moveWorkflowStep(input.steps, 1, -1);
  assert.equal(reordered[0].editorId, input.steps[1].editorId);
  assert.deepEqual(reordered[2].referenceImages, [{ fromStep: 0, imageIndex: 2 }]);
  assert.deepEqual(input.steps[2].referenceImages, [{ fromStep: 1, imageIndex: 2 }]);
  assert.throws(() => moveWorkflowStep(input.steps, 2, -1), /尚未生成/);
});

test('removal and source type changes preserve media dependencies or require explicit removal first', () => {
  const input = draft(); input.steps[2].referenceImages = [{ fromStep: 1 }];
  assert.throws(() => removeWorkflowStep(input.steps, 1), /先移除引用/);
  assert.throws(() => canChangeWorkflowKind(input.steps, 1, 'chat'), /先移除引用/);
  assert.doesNotThrow(() => canChangeWorkflowKind(input.steps, 1, 'image'));
  const removed = removeWorkflowStep(input.steps, 0);
  assert.deepEqual(removed[1].referenceImages, [{ fromStep: 0 }]);
  assert.throws(() => removeWorkflowStep([newWorkflowStep('chat', providers)], 0), /至少/);
});

test('placeholder insertion edits the chosen selection and never substitutes user text prematurely', () => {
  const result = insertWorkflowPlaceholder('before selected after', '{{previous}}', 7, 15);
  assert.deepEqual(result, { prompt: 'before {{previous}} after', cursor: 19 });
  const input = draft(); input.steps[0].prompt = '{{input}}';
  const job = workflowJob(serializeWorkflowDraft(input), 'Literal {{previous}} in user goal.');
  assert.equal(job.prompt, 'Literal {{previous}} in user goal.');
  assert.equal((job.options!.steps as any[])[0].prompt, '{{input}}');
});

test('template requests use private session routes and preserve optimistic update revisions', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const template: WorkflowTemplate = { ...serializeWorkflowDraft(draft()), id: 'fixture-id', revision: 4, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(init?.method ? { template } : { templates: [template] }); };
  const context = new AccountRequestContext(); context.changeSession('11111111-1111-4111-8111-111111111111');
  const transport = createPlatformClient(createPlatformEndpoints(), undefined, context).capture();
  try {
    assert.equal((await listWorkflowTemplates(transport))[0].id, template.id);
    await saveWorkflowTemplate(serializeWorkflowDraft(draft()), { id: template.id, revision: 3 }, transport);
    await saveWorkflowTemplate(serializeWorkflowDraft(draft()), undefined, transport);
    assert.equal(calls[0].url, '/api/platform/workflow-templates');
    assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(calls[1].init?.method, 'PUT');
    assert.equal(JSON.parse(String(calls[1].init?.body)).revision, 3);
    assert.equal(calls[2].init?.method, 'POST');
    assert.equal('revision' in JSON.parse(String(calls[2].init?.body)), false);
    assert.ok(calls.every((call) => !call.url.includes('openai')));
  } finally { globalThis.fetch = originalFetch; }
});


test('a retained workflow callback cannot list or save under a later account', async () => {
  const context = new AccountRequestContext(); context.changeSession('11111111-1111-4111-8111-111111111111'); let requests = 0;
  const transport = createPlatformClient(createPlatformEndpoints(), async () => { ++requests; return Response.json({}); }, context).capture();
  context.changeSession('22222222-2222-4222-8222-222222222222');
  await assert.rejects(listWorkflowTemplates(transport), { name: 'AbortError' });
  await assert.rejects(saveWorkflowTemplate(serializeWorkflowDraft(draft()), undefined, transport), { name: 'AbortError' });
  assert.equal(requests, 0);
});

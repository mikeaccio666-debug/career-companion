import type { CreateJobInput, WorkflowStep, WorkflowCheckpoint, WorkflowCheckpointEvent, WorkflowStepCheckpoint,
  WorkflowArtifactRef, JobExecutionContext, JobExecutionResult, PlatformProviderRuntime, ProviderAttachment } from '@companion/platform-contracts';
import { ProviderError, invalid } from './errors.ts';
import { validateMediaReferenceBinding, validateMediaJobInput } from './media-input.ts';
import { workflowHash } from './json-hash.ts';
import { parseExecutionTemplateBinding } from './comfyui-template.ts';
export { workflowHash } from './json-hash.ts';

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
type WithoutRevision<T> = T extends unknown ? Omit<T, 'expectedRevision'> : never;
type WorkflowEventDraft = WithoutRevision<WorkflowCheckpointEvent>;
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function stepsOf(input: CreateJobInput): WorkflowStep[] {
  const steps = input.options?.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) invalid('Select a workflow with between 1 and 8 explicit steps.');
  return steps.map((value: unknown, index: number) => {
    if (!plain(value) || !['chat', 'image', 'video', 'speech'].includes(String(value.kind)) || typeof value.provider !== 'string' ||
        !value.provider.length || value.provider.length > 80 || typeof value.prompt !== 'string' || !value.prompt.length || value.prompt.length > 20_000)
      invalid('Each workflow step requires a supported kind, provider, and prompt.');
    if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.length || value.model.length > 160)) invalid('The workflow step model is invalid.');
    if (value.options !== undefined && !plain(value.options)) invalid('Workflow step options must be an object.');
    const refs = value.referenceImages === undefined ? [] : value.referenceImages;
    if (!Array.isArray(refs) || refs.length > 4) invalid('Each workflow step supports at most four reference images.');
    const seenRefs = new Set<string>();
    const referenceImages = refs.map((ref: unknown) => {
      if (!plain(ref) || !Number.isInteger(ref.fromStep) || Number(ref.fromStep) < 0 || Number(ref.fromStep) >= index ||
          ref.imageIndex !== undefined && !Number.isInteger(ref.imageIndex) || Number(ref.imageIndex ?? 0) < 0 || Number(ref.imageIndex ?? 0) > 7)
        invalid('Reference images must select an earlier image step.');
      const source = steps[Number(ref.fromStep)];
      if (!source || source.kind !== 'image' || !['image', 'video'].includes(String(value.kind))) invalid('Only image and video steps can reference an earlier image step.');
      const key = `${ref.fromStep}:${ref.imageIndex ?? 0}`;
      if (seenRefs.has(key)) invalid('Select distinct private reference images.');
      seenRefs.add(key);
      return { fromStep: Number(ref.fromStep), imageIndex: Number(ref.imageIndex ?? 0) };
    });
    const step: WorkflowStep = { kind: value.kind as WorkflowStep['kind'], provider: value.provider, prompt: value.prompt,
      ...(value.model === undefined ? {} : { model: value.model as string }), options: value.options as Record<string, unknown> ?? {}, referenceImages,
      ...(value.executionTemplate === undefined ? {} : { executionTemplate: parseExecutionTemplateBinding(value.executionTemplate) }) };
    if (step.executionTemplate && (step.provider !== 'comfyui' || !['image', 'video'].includes(step.kind))) invalid('Only ComfyUI generation steps use a server template version.');
    workflowHash(step); return step;
  });
}

/** Only immutable execution fields are hashed; retry/review flags in job options are excluded. */
export function workflowDefinitionHash(input: CreateJobInput): string {
  if (typeof input.prompt !== 'string' || !input.prompt.length || input.prompt.length > 20_000) invalid('The workflow goal is invalid.');
  return workflowHash({ version: 1, prompt: input.prompt, steps: stepsOf(input) });
}

const uncertain = () => new ProviderError('WORKFLOW_STEP_UNCERTAIN', 'A workflow step has an unconfirmed external result. Review it before starting another request.', 409);
const checkpointError = () => new ProviderError('WORKFLOW_CHECKPOINT_INVALID', 'The saved workflow checkpoint does not match this execution.', 409);
const safeLocalFailures = new Set(['INVALID_PROVIDER_INPUT', 'MODEL_NOT_CONFIGURED', 'INVALID_PROVIDER_CONFIG', 'INVALID_COMFYUI_TEMPLATE', 'COMFYUI_TEMPLATE_UNBOUND', 'COMFYUI_TEMPLATE_BINDING_INVALID', 'COMFYUI_TEMPLATE_SNAPSHOT_INVALID', 'COMFYUI_SERVER_CHANGED', 'PROVIDER_UNSUPPORTED', 'PROVIDER_NOT_CONFIGURED']);
const terminalFailures = new Set(['VIDEO_GENERATION_FAILED', 'MEDIA_GENERATION_FAILED', 'COMFYUI_FAILED', 'COMFYUI_NO_OUTPUT', 'COMFYUI_REJECTED']);
function resumable(step: WorkflowStep): boolean {
  return step.provider === 'ark' && step.kind === 'video' || ['fal', 'comfyui'].includes(step.provider) && ['image', 'video'].includes(step.kind);
}
function validateCheckpoint(value: WorkflowCheckpoint, hash: string, count: number): WorkflowCheckpoint {
  if (!plain(value) || value.definitionHash !== hash || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.steps) || value.steps.length > count) throw checkpointError();
  for (const [index, step] of value.steps.entries()) {
    if (!plain(step) || step.index !== index || typeof step.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(step.inputHash) ||
        !['started', 'provider_task', 'completed', 'failed', 'uncertain'].includes(step.state) || index < value.steps.length - 1 && step.state !== 'completed') throw checkpointError();
    if (step.providerTaskId !== undefined && (typeof step.providerTaskId !== 'string' || !step.providerTaskId.length || step.providerTaskId.length > 4096 || /[\u0000-\u001f\u007f]/.test(step.providerTaskId))) throw checkpointError();
    if (step.state === 'provider_task' && !step.providerTaskId || step.state === 'started' && step.providerTaskId) throw checkpointError();
    if (step.text !== undefined && (typeof step.text !== 'string' || Buffer.byteLength(step.text) > MAX_TEXT_BYTES)) throw checkpointError();
    if (step.errorCode !== undefined && (typeof step.errorCode !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(step.errorCode))) throw checkpointError();
    if (step.state !== 'completed' && (step.text !== undefined || step.artifacts !== undefined)) throw checkpointError();
    if (step.artifacts !== undefined) {
      if (!Array.isArray(step.artifacts) || step.artifacts.length > 8) throw checkpointError();
      const seen = new Set<string>();
      let bytes = 0;
      for (const ref of step.artifacts) {
        if (!plain(ref) || typeof ref.attachmentId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(ref.attachmentId) || seen.has(ref.attachmentId) ||
            typeof ref.name !== 'string' || !ref.name.length || ref.name.length > 200 || /[\/\\\u0000-\u001f\u007f]/.test(ref.name) || typeof ref.mime !== 'string' || ref.mime.length > 100 || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(ref.mime) ||
            !Number.isSafeInteger(ref.size) || ref.size <= 0 || ref.size > 100 * 1024 * 1024) throw checkpointError();
        seen.add(ref.attachmentId);
        bytes += ref.size;
      }
      if (bytes > 200 * 1024 * 1024) throw checkpointError();
    }
    if (step.state === 'completed' && !step.artifacts?.length) throw checkpointError();
  }
  return structuredClone(value);
}
function imageRefs(step: WorkflowStep, checkpoint: WorkflowCheckpoint): WorkflowArtifactRef[] {
  return (step.referenceImages ?? []).map(binding => {
    const source = checkpoint.steps[binding.fromStep];
    if (source?.state !== 'completed') throw checkpointError();
    const ref = source.artifacts?.filter(artifact => imageMimes.has(artifact.mime))[binding.imageIndex ?? 0];
    if (!ref) throw new ProviderError('WORKFLOW_REFERENCE_UNAVAILABLE', 'The selected earlier step has no matching private reference image.', 409);
    return ref;
  });
}
async function hydrateImages(refs: WorkflowArtifactRef[], ctx: JobExecutionContext): Promise<ProviderAttachment[]> {
  if (refs.length && !ctx.readWorkflowArtifact) throw new ProviderError('WORKFLOW_REFERENCE_UNAVAILABLE', 'Authorized workflow artifact storage is unavailable.', 503);
  const images: ProviderAttachment[] = []; let bytes = 0;
  for (const ref of refs) {
    ctx.signal?.throwIfAborted();
    let image: ProviderAttachment;
    try { image = await ctx.readWorkflowArtifact!(ref.attachmentId); }
    catch { throw new ProviderError('WORKFLOW_REFERENCE_UNAVAILABLE', 'A completed workflow reference is unavailable. It will not be regenerated automatically.', 409); }
    ctx.signal?.throwIfAborted(); bytes += image.bytes.byteLength;
    if (image.mime !== ref.mime || image.bytes.byteLength !== ref.size || !imageMimes.has(image.mime) || !image.bytes.length || bytes > MAX_IMAGE_BYTES)
      throw new ProviderError('WORKFLOW_REFERENCE_UNAVAILABLE', 'The private reference does not match its completed-step receipt or exceeds the image size limit.', 409);
    images.push(image);
  }
  return images;
}
function checkedResult(result: JobExecutionResult, index: number, chat: boolean): JobExecutionResult {
  if (!result || !Array.isArray(result.artifacts) || !result.artifacts.length || result.artifacts.length > 8 ||
      result.text !== undefined && (typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_TEXT_BYTES))
    throw new ProviderError('WORKFLOW_OUTPUT_LIMIT', 'The workflow step produced an invalid or oversized result.', 413);
  let bytes = 0;
  const artifacts = result.artifacts.map(file => {
    if (!(file.bytes instanceof Uint8Array) || !file.bytes.byteLength || file.bytes.byteLength > 100 * 1024 * 1024 || typeof file.name !== 'string' || typeof file.mime !== 'string')
      throw new ProviderError('WORKFLOW_OUTPUT_LIMIT', 'The workflow step produced an invalid or oversized artifact.', 413);
    bytes += file.bytes.byteLength;
    const mime = file.mime.split(';')[0].trim();
    if (mime.length > 100 || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime)) throw new ProviderError('WORKFLOW_OUTPUT_LIMIT', 'The workflow step produced an invalid media type.', 413);
    const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160) || 'artifact.bin';
    return { ...file, mime, name: chat ? `step-${index + 1}.txt` : `step-${index + 1}-${name}` };
  });
  if (bytes > 200 * 1024 * 1024) throw new ProviderError('WORKFLOW_OUTPUT_LIMIT', 'The workflow step exceeds its aggregate output limit.', 413);
  return { ...result, artifacts };
}

/** Executes a linear frozen plan; durability and current-lease authorization belong to the worker port. */
export async function executeWorkflow(runtime: PlatformProviderRuntime, input: CreateJobInput, ctx: JobExecutionContext): Promise<JobExecutionResult> {
  if (input.attachmentIds?.length) invalid('Workflow uploads require an explicit binding. Select private image outputs from earlier steps instead.');
  const steps = stepsOf(input), hash = workflowDefinitionHash(input);
  if (!ctx.onWorkflowCheckpoint || !ctx.workflowCheckpoint) throw new ProviderError('WORKFLOW_CHECKPOINT_UNAVAILABLE', 'Workflow execution requires durable checkpoints and a current authorized worker lease.', 503);
  let checkpoint = validateCheckpoint(ctx.workflowCheckpoint, hash, steps.length);
  async function persist(event: WorkflowEventDraft): Promise<WorkflowStepCheckpoint> {
    const before = checkpoint;
    let saved: WorkflowCheckpoint;
    try { saved = validateCheckpoint(await ctx.onWorkflowCheckpoint!({ ...event, expectedRevision: before.revision } as WorkflowCheckpointEvent), hash, steps.length); }
    catch { throw new ProviderError('WORKFLOW_CHECKPOINT_UNCONFIRMED', 'The workflow checkpoint was not confirmed. Execution has stopped to prevent replay.', 409); }
    const step = saved.steps[event.index];
    if (saved.revision !== before.revision + 1 || saved.steps.length !== Math.max(before.steps.length, event.index + 1) || step?.inputHash !== event.inputHash || step.state !== event.type ||
        workflowHash(saved.steps.slice(0, event.index)) !== workflowHash(before.steps.slice(0, event.index))) throw checkpointError();
    if (event.type === 'provider_task' && step.providerTaskId !== event.providerTaskId) throw checkpointError();
    if (event.type === 'completed') {
      const refs = step.artifacts;
      if (step.text !== event.result.text || !refs || refs.length !== event.result.artifacts.length || !refs.every((ref, index) =>
        ref.name === event.result.artifacts[index].name && ref.mime === event.result.artifacts[index].mime && ref.size === event.result.artifacts[index].bytes.byteLength)) throw checkpointError();
    }
    checkpoint = saved; return step;
  }
  // Check every remaining supplier and binding before an earlier paid step is dispatched.
  const statuses = runtime.capabilities();
  for (const [index, step] of steps.entries()) {
    const receipt = checkpoint.steps[index];
    if (receipt?.state === 'completed') continue;
    if (['started', 'uncertain'].includes(receipt?.state ?? '') && (!receipt?.providerTaskId || !resumable(step))) {
      if (receipt!.state === 'started') await persist({ type: 'uncertain', index, inputHash: receipt!.inputHash, errorCode: 'WORKFLOW_STEP_UNCERTAIN' }).catch(() => {});
      throw uncertain();
    }
    if (receipt?.state === 'provider_task' && !resumable(step)) throw checkpointError();
    if (step.provider !== 'comfyui' && !step.model) invalid('Freeze an explicit model for every unfinished provider step before running a workflow.');
    const status = statuses.find(provider => provider.id === step.provider);
    if (!status?.enabled || !status.capabilities.includes(step.kind)) throw new ProviderError('WORKFLOW_PROVIDER_UNAVAILABLE', `Configure a provider for the ${step.kind} step before running this workflow.`, 503);
    if (step.provider === 'comfyui') {
      const snapshot = ctx.workflowComfyUITemplates?.[String(index)];
      if (!step.executionTemplate || !snapshot || !runtime.validateComfyUITemplate) throw new ProviderError('COMFYUI_TEMPLATE_UNBOUND', 'An unfinished workflow step has no saved generation template version. Prepare a new reviewed task.', 409);
      runtime.validateComfyUITemplate(snapshot, step.executionTemplate);
      if (step.model) invalid('The ComfyUI model is part of its server-reviewed template.');
    }
    if(step.kind==='image'||step.kind==='video')validateMediaJobInput({kind:step.kind,provider:step.provider,model:step.model,prompt:step.prompt,options:step.options,
      attachmentIds:(step.referenceImages??[]).map((_,refIndex)=>`preflight-reference-${refIndex}`)});
    else validateMediaReferenceBinding(step.provider, step.kind, step.options ?? {}, step.referenceImages?.length ?? 0);
  }
  let previous = '';
  for (const [index, step] of steps.entries()) {
    ctx.signal?.throwIfAborted();
    const prompt = step.prompt.replace(/\{\{(input|previous)\}\}/g, (_match, source) => source === 'input' ? input.prompt : previous);
    if (!prompt.length || prompt.length > 20_000 || step.kind === 'speech' && prompt.length > 4096) invalid('The combined workflow context exceeds the step input limit.');
    const refs = imageRefs(step, checkpoint);
    const inputHash = workflowHash({ kind: step.kind, provider: step.provider, model: step.model, options: step.options, prompt, references: refs, executionTemplate: step.executionTemplate });
    let receipt = checkpoint.steps[index];
    if (receipt && receipt.inputHash !== inputHash) throw checkpointError();
    if (receipt?.state === 'completed') {
      if (step.kind === 'chat' && receipt.text === undefined) throw checkpointError();
      previous = receipt.text ?? previous; await ctx.onProgress?.(Math.round((index + 1) / steps.length * 95)); continue;
    }
    let handle = receipt?.state === 'provider_task' || receipt?.state === 'uncertain' ? receipt.providerTaskId : undefined;
    const images = handle ? [] : await hydrateImages(refs, ctx);
    const virtualIds = images.map((_image, position) => `workflow-reference-${index}-${position}`);
    ctx.signal?.throwIfAborted();
    if (handle) {
      if (receipt?.state === 'uncertain') receipt = await persist({ type: 'provider_task', index, inputHash, providerTaskId: handle });
    } else receipt = await persist({ type: 'started', index, inputHash });
    try {
      ctx.signal?.throwIfAborted();
      let result: JobExecutionResult;
      if (step.kind === 'chat') {
        let text = '';
        for await (const event of runtime.streamChat({ provider: step.provider, model: step.model, mode: 'chat', messages: [{ role: 'user', content: prompt }] }, { signal: ctx.signal })) {
          if (event.type === 'delta') { text += event.text; if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new ProviderError('WORKFLOW_OUTPUT_LIMIT', 'The workflow text output exceeds its limit.', 413); }
        }
        result = { text, artifacts: [{ name: 'text.txt', mime: 'text/plain', bytes: new TextEncoder().encode(text) }] };
      } else result = await runtime.executeJob({ kind: step.kind, provider: step.provider, model: step.model, prompt, options: step.options, executionTemplate: step.executionTemplate, ...(virtualIds.length ? { attachmentIds: virtualIds } : {}) }, {
        ...ctx, jobId: `${ctx.jobId}-step-${index}`, previousProviderTaskId: handle, onProgress: undefined, workflowCheckpoint: undefined, onWorkflowCheckpoint: undefined,
        comfyuiTemplate: ctx.workflowComfyUITemplates?.[String(index)], workflowComfyUITemplates: undefined,
        readAttachment: async id => { const position = virtualIds.indexOf(id); if (position < 0) invalid('The workflow reference is not authorized for this step.'); return images[position]; },
        onProviderTask: async providerTaskId => { await persist({ type: 'provider_task', index, inputHash, providerTaskId }); handle = providerTaskId; },
      });
      ctx.signal?.throwIfAborted(); result = checkedResult(result, index, step.kind === 'chat');
      receipt = await persist({ type: 'completed', index, inputHash, result });
      previous = receipt.text ?? previous;
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'WORKFLOW_PROVIDER_FAILED';
      if (terminalFailures.has(code) || safeLocalFailures.has(code)) {
        await persist({ type: 'failed', index, inputHash, errorCode: code }); throw error;
      }
      // A confirmed queue handle can be polled again, but never submitted again.
      if (handle && resumable(step) && !['WORKFLOW_CHECKPOINT_UNCONFIRMED', 'WORKFLOW_CHECKPOINT_INVALID'].includes(code)) throw error;
      await persist({ type: 'uncertain', index, inputHash, errorCode: code }).catch(() => {}); throw uncertain();
    }
    await ctx.onProgress?.(Math.round((index + 1) / steps.length * 95));
  }
  // Every result was published by the durable completion callback, including results from prior leases.
  return { artifacts: [] };
}

import type { ComfyUITemplateSnapshot, CreateJobInput, ExecutionTemplateBinding, PlatformProviderRuntime, WorkflowStep } from '@companion/platform-contracts';
import { parseExecutionTemplateBinding, validateComfyUITemplateSnapshot } from '@companion/ai-core';
import { ApiError, invalid } from './errors.ts';

export interface ComfyUIExecutionPolicy { job?: ComfyUITemplateSnapshot; steps?: Record<string, ComfyUITemplateSnapshot>; }
const required = () => new ApiError(409, 'COMFYUI_TEMPLATE_REQUIRED', 'This task has no reviewed server template snapshot. Prepare a new task.');
const changed = () => new ApiError(409, 'COMFYUI_TEMPLATE_CHANGED', 'The reviewed server template binding changed. Prepare a new task.');
const malformed = () => new ApiError(409, 'COMFYUI_TEMPLATE_INVALID', 'The saved server template snapshot is invalid. Prepare a new task.');
const unavailable = () => new ApiError(503, 'COMFYUI_TEMPLATE_UNAVAILABLE', 'A reviewed server template snapshot is not available.');
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function binding(value: unknown): ExecutionTemplateBinding { try { return parseExecutionTemplateBinding(value); } catch { throw malformed(); } }
function publicBinding(snapshot: ComfyUITemplateSnapshot): ExecutionTemplateBinding { return { version: snapshot.version, hash: snapshot.hash }; }
function snapshot(value: unknown, expected?: ExecutionTemplateBinding): ComfyUITemplateSnapshot {
  try { return validateComfyUITemplateSnapshot(value, expected); } catch { throw malformed(); }
}
export function safeJobExecutionTemplate(policy: unknown): ExecutionTemplateBinding | undefined {
  if (!plain(policy) || !plain(policy.comfyui) || !plain(policy.comfyui.job)) return undefined;
  try { return binding({ version: policy.comfyui.job.version, hash: policy.comfyui.job.hash }); } catch { return undefined; }
}
export function assertExecutionTemplateApproval(input: CreateJobInput, args: unknown): void {
  if(input.provider!=='comfyui')return;
  if(!plain(args)||!input.executionTemplate)throw changed();
  const approved=binding(args.executionTemplate),current=binding(input.executionTemplate);
  if(approved.hash!==current.hash||approved.version!==current.version)throw changed();
}

/** Only the server runtime captures graphs; request bodies contain public digest bindings. */
export function bindExecutionTemplates(input: CreateJobInput, runtime: PlatformProviderRuntime): { input: CreateJobInput; comfyui?: ComfyUIExecutionPolicy } {
  if (input.provider !== 'comfyui' && input.executionTemplate !== undefined) throw invalid('Only ComfyUI tasks use a server execution-template binding.');
  let captured: ComfyUITemplateSnapshot | undefined;
  function capture(requested?: ExecutionTemplateBinding) {
    if (!runtime.captureComfyUITemplate || !runtime.validateComfyUITemplate) throw unavailable();
    if (!captured) {
      try { captured = snapshot(runtime.captureComfyUITemplate()); runtime.validateComfyUITemplate(captured, publicBinding(captured)); } catch { throw unavailable(); }
    }
    if (requested !== undefined) { const parsed = binding(requested); if (parsed.hash !== captured.hash || parsed.version !== captured.version) throw changed(); }
    return structuredClone(captured);
  }
  if (input.provider === 'comfyui') {
    if (!['image', 'video'].includes(input.kind)) throw invalid('ComfyUI server templates produce image or video tasks.');
    if(input.model)throw invalid('The ComfyUI model is part of its server-reviewed template.');
    const job = capture(input.executionTemplate);
    return { input: { ...input, executionTemplate: publicBinding(job) }, comfyui: { job } };
  }
  if (input.kind !== 'workflow') return { input };
  const steps = input.options?.steps as WorkflowStep[];
  const snapshots: Record<string, ComfyUITemplateSnapshot> = {};
  const bound = steps.map((step, index) => {
    if (step.provider !== 'comfyui') { if (step.executionTemplate !== undefined) throw invalid('Only ComfyUI steps use a server execution-template binding.'); return step; }
    if(step.model)throw invalid('The ComfyUI model is part of its server-reviewed template.');
    const saved = capture(step.executionTemplate); snapshots[String(index)] = saved;
    return { ...step, executionTemplate: publicBinding(saved) };
  });
  return { input: { ...input, options: { steps: bound } }, ...(Object.keys(snapshots).length ? { comfyui: { steps: snapshots } } : {}) };
}

/** Validate the original private policy without capturing a replacement from current configuration. */
export function validateExecutionTemplates(input: CreateJobInput, policy: unknown, runtime?: PlatformProviderRuntime, completedSteps: Set<number> = new Set()): ComfyUIExecutionPolicy | undefined {
  const expected = input.provider === 'comfyui' ? { kind:'job' as const, binding: input.executionTemplate } : input.kind === 'workflow' ? { kind:'steps' as const, steps: (input.options?.steps as WorkflowStep[]).flatMap((step, index) => step.provider === 'comfyui' ? [{ index, binding: step.executionTemplate }] : []) } : undefined;
  if (!expected || (expected.kind==='steps' && !expected.steps.length)) {
    if (plain(policy) && policy.comfyui !== undefined) throw malformed();
    return undefined;
  }
  if (!plain(policy) || !plain(policy.comfyui)) throw required();
  const saved = policy.comfyui;
  if (Object.keys(saved).some(key => !['job', 'steps'].includes(key))) throw malformed();
  const check = (value: unknown, wanted: ExecutionTemplateBinding | undefined, active: boolean) => {
    if (!wanted || value === undefined) throw required();
    const parsed = binding(wanted), result = snapshot(value, parsed);
    if (result.hash !== parsed.hash || result.version !== parsed.version) throw changed();
    if (active && runtime) {
      if (!runtime.validateComfyUITemplate) throw unavailable();
      try { runtime.validateComfyUITemplate(result, parsed); } catch { throw changed(); }
    }
    return result;
  };
  if (expected.kind==='job') {
    if (saved.steps !== undefined) throw malformed();
    return { job: check(saved.job, expected.binding, true) };
  }
  if (saved.job !== undefined || !plain(saved.steps)) throw malformed();
  const expectedKeys = new Set(expected.steps.map(step => String(step.index)));
  if (Object.keys(saved.steps).length !== expectedKeys.size || Object.keys(saved.steps).some(key => !expectedKeys.has(key))) throw malformed();
  const steps: Record<string, ComfyUITemplateSnapshot> = {};
  for (const step of expected.steps) steps[String(step.index)] = check(saved.steps[String(step.index)], step.binding, !completedSteps.has(step.index));
  return { steps };
}

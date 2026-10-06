import type { CreateJobInput, ProviderStatus, WorkflowStep, WorkflowTemplate, WorkflowTemplateInput } from '@companion/platform-contracts';
import { executionTemplateReadiness } from './execution-template.ts';

export const WORKFLOW_STEP_LIMIT = 8;
export const WORKFLOW_TEMPLATE_BYTES = 128 * 1024;
export const workflowKinds = ['chat', 'image', 'video', 'speech'] as const;
export const workflowKindLabels = { chat: '文字', image: '图片', video: '视频', speech: '配音' } as const;
export interface WorkflowStepDraft extends Omit<WorkflowStep, 'options' | 'executionTemplate'> { editorId: string; optionsText: string; }
export interface WorkflowDraft { name: string; description: string; steps: WorkflowStepDraft[]; }

const defaultPrompts: Record<WorkflowStep['kind'], string> = {
  chat: '根据目标生成内容：{{input}}',
  image: '为以下内容创作配图：{{previous}}',
  video: '根据以下内容生成视频：{{previous}}',
  speech: '{{previous}}',
};
export function providerForStep(providers: ProviderStatus[], kind: WorkflowStep['kind']): ProviderStatus | undefined {
  return providers.find((provider) => provider.capabilities.includes(kind) && provider.keyConfigured && provider.enabled)
    || providers.find((provider) => provider.capabilities.includes(kind));
}
export function modelsForStep(provider: ProviderStatus | undefined, kind: WorkflowStep['kind']): string[] {
  return provider?.modelsByCapability ? provider.modelsByCapability[kind] || [] : provider?.models || [];
}
export function newWorkflowStep(kind: WorkflowStep['kind'], providers: ProviderStatus[]): WorkflowStepDraft {
  const provider = providerForStep(providers, kind);
  return { editorId: crypto.randomUUID(), kind, provider: provider?.id || '', model: modelsForStep(provider, kind)[0] || '', prompt: defaultPrompts[kind], optionsText: '' };
}
export function draftFromTemplate(template: WorkflowTemplate): WorkflowDraft {
  return { name: template.name, description: template.description || '', steps: template.steps.map(({ executionTemplate: _binding, ...step }) => ({ ...step, editorId: crypto.randomUUID(), model: step.provider === 'comfyui' ? '' : step.model || '', optionsText: step.options ? JSON.stringify(step.options, null, 2) : '' })) };
}
export function serializeWorkflowDraft(draft: WorkflowDraft): WorkflowTemplateInput {
  const name = draft.name.trim();
  if (!name || name.length > 100) throw new Error('请填写不超过 100 字的流程名称。');
  if (draft.description.length > 1000) throw new Error('流程说明最多 1,000 字。');
  if (!draft.steps.length || draft.steps.length > WORKFLOW_STEP_LIMIT) throw new Error('流程需要 1 至 8 个步骤。');
  const steps = draft.steps.map((step, index): WorkflowStep => {
    const label = `第 ${index + 1} 步`;
    if (!workflowKinds.includes(step.kind)) throw new Error(`${label}的能力类型不受支持。`);
    if (!step.provider || step.provider.length > 80) throw new Error(`${label}需要选择模型服务。`);
    if (!step.prompt.trim() || step.prompt.length > 20_000) throw new Error(`${label}需要填写不超过 20,000 字的提示词。`);
    const model = step.provider === 'comfyui' ? '' : (step.model || '').trim();
    if (model.length > 150) throw new Error(`${label}的模型名称最多 150 字。`);
    let options: Record<string, unknown> | undefined;
    if (step.optionsText.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(step.optionsText); } catch { throw new Error(`${label}的高级参数需要有效的 JSON 对象。`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}的高级参数需要是 JSON 对象。`);
      options = parsed as Record<string, unknown>;
      if (Object.hasOwn(options, 'executionTemplate')) throw new Error(`${label}的生成模板版本由完整任务审阅固定，请从高级参数中移除。`);
      if (step.provider === 'comfyui' && Object.keys(options).length) throw new Error(`${label}的生成参数由固定模板决定，请清空高级参数。`);
    }
    const referenceImages = step.referenceImages?.length ? step.referenceImages.map((reference) => ({ ...reference })) : undefined;
    if (referenceImages) {
      if (!['image', 'video'].includes(step.kind) || referenceImages.length > 4) throw new Error(`${label}只在图片或视频能力中支持最多 4 个图片引用。`);
      const selectedImages = new Set<string>();
      for (const reference of referenceImages) {
        if (!Number.isInteger(reference.fromStep) || reference.fromStep < 0 || reference.fromStep >= index || draft.steps[reference.fromStep]?.kind !== 'image') throw new Error(`${label}只能引用前面图片步骤的成果。`);
        if (reference.imageIndex !== undefined && (!Number.isInteger(reference.imageIndex) || reference.imageIndex < 0 || reference.imageIndex > 7)) throw new Error(`${label}的图片成果序号需要在 1 至 8 之间。`);
        const selection = `${reference.fromStep}:${reference.imageIndex ?? 0}`;
        if (selectedImages.has(selection)) throw new Error(`${label}重复引用同一张图片，请选择不同的图片成果。`);
        selectedImages.add(selection);
      }
    }
    return { kind: step.kind, provider: step.provider, prompt: step.prompt.trim(), ...(model ? { model } : {}), ...(options ? { options } : {}), ...(referenceImages ? { referenceImages } : {}) };
  });
  const input = { name, ...(draft.description.trim() ? { description: draft.description.trim() } : {}), steps };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > WORKFLOW_TEMPLATE_BYTES) throw new Error('流程内容超过 128 KiB，请缩短提示词或高级参数。');
  return input;
}
export function nextWorkflowImageReference(references: NonNullable<WorkflowStep['referenceImages']>, sourceIndices: number[]): NonNullable<WorkflowStep['referenceImages']>[number] | undefined {
  for (let imageIndex = 0; imageIndex < 8; imageIndex++) {
    for (const fromStep of sourceIndices) if (!references.some((reference) => reference.fromStep === fromStep && (reference.imageIndex ?? 0) === imageIndex)) return { fromStep, imageIndex };
  }
  return undefined;
}
export function workflowReadiness(steps: WorkflowStep[], providers: ProviderStatus[]): string[] {
  return steps.flatMap((step, index) => {
    const provider = providers.find((item) => item.id === step.provider);
    if (!provider || !provider.capabilities.includes(step.kind)) return [`第 ${index + 1} 步：所选服务不支持${workflowKindLabels[step.kind]}。`];
    if (!provider.keyConfigured || !provider.enabled) return [`第 ${index + 1} 步：${provider.name}待配置或已停用。`];
    if (!step.model?.trim() && !modelsForStep(provider, step.kind).length && provider.id !== 'comfyui') return [`第 ${index + 1} 步：请为${workflowKindLabels[step.kind]}选择模型，或在服务端配置对应模型。`];
    return executionTemplateReadiness(step.provider, step.executionTemplate, providers).map((issue) => `第 ${index + 1} 步：${issue}`);
  });
}
export function workflowJob(template: WorkflowTemplateInput, prompt: string): CreateJobInput {
  if (!prompt.trim() || prompt.length > 20_000) throw new Error('请填写不超过 20,000 字的本次目标。');
  return { kind: 'workflow', provider: 'workflow', prompt: prompt.trim(), options: { steps: structuredClone(template.steps) } };
}
export function moveWorkflowStep(steps: WorkflowStepDraft[], index: number, direction: -1 | 1): WorkflowStepDraft[] {
  const target = index + direction;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return steps;
  const result = [...steps];
  [result[index], result[target]] = [result[target], result[index]];
  const oldToNew = new Map(steps.map((step, oldIndex) => [oldIndex, result.findIndex((item) => item.editorId === step.editorId)]));
  return result.map((step, newIndex) => {
    const referenceImages = step.referenceImages?.map((reference) => ({ ...reference, fromStep: oldToNew.get(reference.fromStep)! }));
    if (referenceImages?.some((reference) => reference.fromStep >= newIndex)) throw new Error('这个顺序会让步骤引用尚未生成的图片。请先移除图片引用，再调整顺序。');
    return referenceImages ? { ...step, referenceImages } : step;
  });
}
export function removeWorkflowStep(steps: WorkflowStepDraft[], index: number): WorkflowStepDraft[] {
  if (steps.length <= 1) throw new Error('流程至少需要保留一个步骤。');
  if (steps.some((step) => step.referenceImages?.some((reference) => reference.fromStep === index))) throw new Error('后面的步骤正在使用这一步的图片，请先移除引用再删除。');
  return steps.filter((_, position) => position !== index).map((step) => step.referenceImages?.length ? { ...step, referenceImages: step.referenceImages.map((reference) => ({ ...reference, fromStep: reference.fromStep > index ? reference.fromStep - 1 : reference.fromStep })) } : step);
}
export function canChangeWorkflowKind(steps: WorkflowStepDraft[], index: number, kind: WorkflowStep['kind']): void {
  if (steps[index]?.kind === 'image' && kind !== 'image' && steps.some((step) => step.referenceImages?.some((reference) => reference.fromStep === index))) throw new Error('后面的步骤正在使用这一步的图片，请先移除引用再改变能力。');
}
export function insertWorkflowPlaceholder(prompt: string, token: '{{input}}' | '{{previous}}', start = prompt.length, end = start): { prompt: string; cursor: number } {
  const from = Math.max(0, Math.min(prompt.length, start));
  const until = Math.max(from, Math.min(prompt.length, end));
  return { prompt: prompt.slice(0, from) + token + prompt.slice(until), cursor: from + token.length };
}

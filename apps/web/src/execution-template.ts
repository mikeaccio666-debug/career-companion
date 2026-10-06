import type { ExecutionTemplateBinding, ProviderStatus, WorkflowTemplateInput } from '@companion/platform-contracts';

export interface ExecutionTemplateEntry { label: string; binding?: ExecutionTemplateBinding; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Only the public server identity is accepted; graphs, paths and extra fields never enter a review. */
export function executionTemplateBinding(value: unknown): ExecutionTemplateBinding | undefined {
  if (!record(value) || Object.keys(value).some((key) => !['version', 'hash'].includes(key)) || value.version !== 1 || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) return;
  return { version: 1, hash: value.hash };
}
export function captureExecutionTemplate(providerId: string, providers: ProviderStatus[]): ExecutionTemplateBinding | undefined {
  if (providerId !== 'comfyui') return;
  return executionTemplateBinding(providers.find((provider) => provider.id === providerId)?.executionTemplate);
}
export function executionTemplateReadiness(providerId: string, reviewed: unknown, providers: ProviderStatus[]): string[] {
  if (providerId !== 'comfyui') return [];
  const current = captureExecutionTemplate(providerId, providers), binding = executionTemplateBinding(reviewed);
  if (!current) return ['生成模板版本尚未配置或不可用。可以保留草稿，配置后返回编辑并重新审阅。'];
  if (!binding) return ['本次审阅尚未固定生成模板版本。请返回编辑，使用当前模板重新审阅。'];
  if (binding.hash !== current.hash) return ['生成模板已更新，本次审阅仍保留原版本。请返回编辑，使用当前模板重新审阅后再开始。'];
  return [];
}
/** Saving a design does not bind execution; only an explicit full-task review captures the current identity. */
export function captureWorkflowExecutionTemplates(template: WorkflowTemplateInput, providers: ProviderStatus[]): WorkflowTemplateInput {
  return { ...structuredClone(template), steps: template.steps.map((source) => {
    const { executionTemplate: _oldBinding, ...step } = structuredClone(source);
    if (step.provider !== 'comfyui') return step;
    const { model: _model, ...templateStep } = step;
    const executionTemplate = captureExecutionTemplate(step.provider, providers);
    return { ...templateStep, ...(executionTemplate ? { executionTemplate } : {}) };
  }) };
}
/** Shared read-only presentation for owned jobs and their approval arguments. It never compares an already-bound task to a newer catalog. */
export function taskExecutionTemplates(input: unknown): ExecutionTemplateEntry[] {
  if (!record(input)) return [];
  if (input.provider === 'comfyui') return [{ label: '生成模板', binding: executionTemplateBinding(input.executionTemplate) }];
  if (input.kind !== 'workflow' || !record(input.options) || !Array.isArray(input.options.steps)) return [];
  return input.options.steps.flatMap((step, index) => record(step) && step.provider === 'comfyui' ? [{ label: `第 ${index + 1} 步生成模板`, binding: executionTemplateBinding(step.executionTemplate) }] : []);
}

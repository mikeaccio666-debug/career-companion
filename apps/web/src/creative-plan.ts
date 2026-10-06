import type { Attachment, CreateJobInput, ProviderStatus } from '@companion/platform-contracts';
import { captureExecutionTemplate, executionTemplateReadiness } from './execution-template.ts';

export const CREATIVE_IMAGE_LIMIT = 4;
export const CREATIVE_IMAGE_BYTES = 20 * 1024 * 1024;
export const CREATIVE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type CreativeKind = 'image' | 'video';
export type ReferenceBinding = 'openai_edits' | 'ark_video' | 'fal_input';
export interface ReferencePolicy { maxImages: number; maxTotalBytes: number; mimeTypes: string[]; binding: ReferenceBinding; }
export interface CreativeReference {
  attachment: Attachment;
  source: { kind: 'upload' } | { kind: 'artifact'; artifactId: string; jobId: string; jobPrompt?: string };
}
export interface CreativeDraft {
  kind: CreativeKind; provider: string; model: string; prompt: string; aspectRatio: string; duration: string;
  optionsText: string; referenceMode: 'first_frame' | 'first_last_frame' | 'reference_image';
  referenceField: 'image_url' | 'image_urls'; references: CreativeReference[];
}
export interface CreativePlan { job: CreateJobInput; references: CreativeReference[]; }

export function creativeModels(provider: ProviderStatus | undefined, kind: CreativeKind): string[] {
  return provider?.modelsByCapability ? provider.modelsByCapability[kind] || [] : provider?.models || [];
}
export function creativeAspectRatios(provider: ProviderStatus | undefined, kind: CreativeKind): string[] {
  const binding = creativeReferencePolicy(provider, kind)?.binding;
  if (binding === 'openai_edits' || provider?.id === 'openai' && kind === 'image') return ['16:9', '1:1', '9:16', '4:3'];
  if (binding === 'ark_video' || provider?.id === 'ark' && kind === 'video') return ['adaptive', '16:9', '1:1', '9:16', '4:3'];
  return [];
}
export function creativeReferencePolicy(provider: ProviderStatus | undefined, kind: CreativeKind): ReferencePolicy | undefined {
  const value = provider?.referenceImages?.[kind];
  if (!value || !Number.isSafeInteger(value.maxImages) || value.maxImages < 1 || !Number.isSafeInteger(value.maxTotalBytes) || value.maxTotalBytes < 1 || !Array.isArray(value.mimeTypes)) return;
  if (!['openai_edits', 'ark_video', 'fal_input'].includes(value.binding) || value.binding === 'openai_edits' && kind !== 'image' || value.binding === 'ark_video' && kind !== 'video') return;
  const mimeTypes = CREATIVE_IMAGE_MIMES.filter((mime) => value.mimeTypes.includes(mime));
  if (!mimeTypes.length) return;
  return { maxImages: Math.min(CREATIVE_IMAGE_LIMIT, value.maxImages), maxTotalBytes: Math.min(CREATIVE_IMAGE_BYTES, value.maxTotalBytes), mimeTypes, binding: value.binding };
}
export function validateCreativeReferences(references: CreativeReference[], policy: ReferencePolicy | undefined): void {
  if (!references.length) return;
  if (!policy) throw new Error('所选服务尚未提供这个能力的参考图片支持，请选择支持参考图片的服务，或移除图片。');
  if (references.length > policy.maxImages) throw new Error(`所选服务最多使用 ${policy.maxImages} 张参考图片。`);
  const ids = new Set<string>(); let total = 0;
  for (const reference of references) {
    const image = reference.attachment;
    if (!image || typeof image.id !== 'string' || !image.id || typeof image.name !== 'string' || typeof image.url !== 'string' || !image.url || !policy.mimeTypes.includes(image.mime) || !Number.isSafeInteger(image.size) || image.size < 1) throw new Error('参考图片记录不完整，或格式不受所选服务支持。请使用 PNG、JPEG 或 WebP。');
    if (ids.has(image.id)) throw new Error('同一张参考图片只能选择一次。');
    ids.add(image.id); total += image.size;
  }
  if (total > policy.maxTotalBytes) throw new Error(`参考图片总大小最多 ${(policy.maxTotalBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB，请移除较大的图片。`);
}
export function validateCreativeFiles(files: Pick<File, 'name' | 'type' | 'size'>[], current: CreativeReference[], policy: ReferencePolicy | undefined): void {
  if (!policy) throw new Error('请先选择支持参考图片的服务。');
  if (!files.length) return;
  if (current.length + files.length > policy.maxImages) throw new Error(`所选服务最多使用 ${policy.maxImages} 张参考图片，请减少选择。`);
  const total = current.reduce((sum, reference) => sum + reference.attachment.size, 0);
  if (files.some((file) => !policy.mimeTypes.includes(file.type) || !Number.isSafeInteger(file.size) || file.size < 1)) throw new Error('请选择 PNG、JPEG 或 WebP 图片；视频和其他文件不能用作这里的参考图片。');
  if (total + files.reduce((sum, file) => sum + file.size, 0) > policy.maxTotalBytes) throw new Error(`参考图片总大小最多 ${(policy.maxTotalBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB。`);
}
export function moveCreativeReference(references: CreativeReference[], index: number, direction: -1 | 1): CreativeReference[] {
  const next = [...references], target = index + direction;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]]; return next;
}
function advancedOptions(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('高级参数需要有效的 JSON 对象。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('高级参数需要是 JSON 对象。');
  for (const key of ['aspectRatio', 'duration', 'referenceMode', 'referenceField', 'attachmentIds', 'referenceImages', 'executionTemplate']) if (Object.hasOwn(value, key)) throw new Error(`${key} 由上方创作选项设置，请从高级参数中移除，避免覆盖已审阅的选择。`);
  let count = 0;
  function visit(item: unknown, depth: number) {
    if (++count > 2000 || depth > 6) throw new Error('高级参数过于复杂，请精简内容。');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('高级参数中的数字需要是有限数值。');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (/^(?:__proto__|prototype|constructor|authorization|headers|api[_-]?key|access[_-]?token|token|secret|password|credentials?|endpoint|base[_-]?url|connection)$/i.test(key)) throw new Error('高级参数不能包含密钥、认证或连接配置。');
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 20_000) throw new Error('高级参数最多 20,000 字节。');
  return value as Record<string, unknown>;
}
export function serializeCreativeDraft(draft: CreativeDraft, providers: ProviderStatus[]): CreativePlan {
  if (!['image', 'video'].includes(draft.kind)) throw new Error('请选择图片或视频创作。');
  if (!draft.provider || draft.provider.length > 80) throw new Error('请选择模型服务。');
  if (!draft.prompt.trim() || draft.prompt.length > 20_000) throw new Error('请填写不超过 20,000 字的创作描述。');
  const model = draft.provider === 'comfyui' ? '' : draft.model.trim();
  if (model.length > 150 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('模型名称最多 150 字，且不能包含控制字符。');
  const duration = Number(draft.duration);
  const provider = providers.find((entry) => entry.id === draft.provider), policy = creativeReferencePolicy(provider, draft.kind);
  const binding = policy?.binding || (provider?.id === 'openai' && draft.kind === 'image' ? 'openai_edits' : provider?.id === 'ark' && draft.kind === 'video' ? 'ark_video' : provider?.id === 'fal' ? 'fal_input' : undefined);
  const ratios = creativeAspectRatios(provider, draft.kind);
  if (ratios.length && !ratios.includes(draft.aspectRatio)) throw new Error('请选择所选服务支持的画幅比例。');
  if (binding === 'ark_video' && ![5, 10].includes(duration)) throw new Error('请选择 5 秒或 10 秒的视频时长。');
  validateCreativeReferences(draft.references, policy);
  const advanced = advancedOptions(draft.optionsText);
  if (provider?.id === 'comfyui' && Object.keys(advanced).length) throw new Error('此服务的创作参数由服务端模板决定，请清空高级参数。');
  if (binding === 'openai_edits' && Object.keys(advanced).length) throw new Error('此图片服务当前仅支持上方画幅选项，请清空高级参数。');
  if (binding === 'fal_input') {
    if (Object.keys(advanced).some((key) => key !== 'input')) throw new Error('所选服务的模型参数需要放在 input 对象中。');
    if (advanced.input !== undefined && (!advanced.input || typeof advanced.input !== 'object' || Array.isArray(advanced.input))) throw new Error('所选服务的 input 参数需要是对象。');
    const supplied = advanced.input as Record<string, unknown> | undefined;
    if (supplied && Object.hasOwn(supplied, 'prompt')) throw new Error('请使用上方创作描述，不要在高级 input 中再次填写 prompt。');
    if (supplied?.sync_mode !== undefined && supplied.sync_mode !== false) throw new Error('此任务通道使用持久队列，请移除 sync_mode 或将它设为 false。');
  }
  if (binding === 'ark_video') {
    if (Object.keys(advanced).some((key) => !['seed', 'resolution'].includes(key))) throw new Error('此视频服务的高级参数支持 seed 和 resolution；其余选项请在上方设置。');
    if (advanced.seed !== undefined && (typeof advanced.seed !== 'number' || !Number.isSafeInteger(advanced.seed) || advanced.seed < -1 || advanced.seed > 2 ** 32 - 1)) throw new Error('视频 seed 需要是 -1 至 4294967295 的整数。');
    if (advanced.resolution !== undefined && !['480p', '720p', '1080p'].includes(String(advanced.resolution))) throw new Error('请选择 480p、720p 或 1080p 分辨率。');
  }
  const options = { ...advanced, ...(ratios.length ? { aspectRatio: draft.aspectRatio } : {}), ...(binding === 'ark_video' ? { duration } : {}) } as Record<string, unknown>;
  if (draft.references.length && policy?.binding === 'ark_video') {
    if (!['first_frame', 'first_last_frame', 'reference_image'].includes(draft.referenceMode)) throw new Error('请选择图片在视频中的用途。');
    if (draft.referenceMode === 'first_frame' && draft.references.length !== 1) throw new Error('首帧模式需要恰好一张图片。');
    if (draft.referenceMode === 'first_last_frame' && draft.references.length !== 2) throw new Error('首尾帧模式需要恰好两张图片，顺序为首帧、尾帧。');
    options.referenceMode = draft.referenceMode;
  }
  if (draft.references.length && policy?.binding === 'fal_input') {
    if (!['image_url', 'image_urls'].includes(draft.referenceField) || draft.references.length > 1 && draft.referenceField !== 'image_urls') throw new Error('多张参考图片需要选择“多图输入”，并确认所选模型支持。');
    const supplied = options.input;
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))) throw new Error('所选服务的 input 参数需要是对象。');
    if (supplied && ['image_url', 'image_urls'].some((field) => Object.hasOwn(supplied, field))) throw new Error('参考图片已在上方选择，请移除高级 input 中的 image_url / image_urls，避免重复输入。');
    options.referenceField = draft.referenceField;
  }
  const executionTemplate = captureExecutionTemplate(draft.provider, providers);
  const job: CreateJobInput = { kind: draft.kind, provider: draft.provider, prompt: draft.prompt.trim(), ...(model ? { model } : {}), options, ...(executionTemplate ? { executionTemplate } : {}), ...(draft.references.length ? { attachmentIds: draft.references.map((reference) => reference.attachment.id) } : {}) };
  return { job, references: structuredClone(draft.references) };
}
export function creativeReadiness(plan: CreativePlan, providers: ProviderStatus[]): string[] {
  const provider = providers.find((entry) => entry.id === plan.job.provider), kind = plan.job.kind as CreativeKind;
  const issues: string[] = [];
  issues.push(...executionTemplateReadiness(plan.job.provider, plan.job.executionTemplate, providers));
  if (!provider || !provider.capabilities.includes(kind)) issues.push('所选服务当前不支持这个创作类型。');
  else {
    if (!provider.enabled || !provider.keyConfigured) issues.push(`${provider.name}待配置或已停用，可以继续编辑草稿。`);
    if (!plan.job.model && !creativeModels(provider, kind).length && provider.id !== 'comfyui') issues.push('请选择模型，或在服务端配置对应能力的默认模型。');
  }
  try { validateCreativeReferences(plan.references, creativeReferencePolicy(provider, kind)); } catch (error) { issues.push((error as Error).message); }
  const selected = plan.job.model || creativeModels(provider, kind)[0] || '';
  if (provider?.id === 'openai' && selected && plan.job.options?.aspectRatio && plan.job.options.aspectRatio !== '1:1' && !/^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(selected)) issues.push('这个图片模型当前只能通过本工作台使用 1:1 画幅。请返回编辑选择 1:1，或改用支持精确画幅的 GPT Image 2.5 模型。');
  if (provider?.id === 'ark' && plan.references.length && /^(?:doubao-)?seedance-2[-.]5(?:-|$)/.test(selected) && ['first_frame', 'first_last_frame'].includes(String(plan.job.options?.referenceMode)) && plan.job.options?.aspectRatio !== 'adaptive') issues.push('这个 Seedance 2.5 模型的首帧或首尾帧生成需要画幅选择“随参考图”。请返回编辑调整画幅。');
  return issues;
}
export function creativePlanJob(plan: CreativePlan): CreateJobInput { return structuredClone(plan.job); }
export function freshCreativeDraft(providers: ProviderStatus[], kind: CreativeKind = 'image', withReference = false): CreativeDraft {
  const available = providers.filter((entry) => entry.capabilities.includes(kind) && (!withReference || creativeReferencePolicy(entry, kind)));
  const provider = available.find((entry) => entry.enabled && entry.keyConfigured) || available[0];
  return { kind, provider: provider?.id || '', model: creativeModels(provider, kind)[0] || '', prompt: '', aspectRatio: creativeAspectRatios(provider, kind)[0] || '16:9', duration: '5', optionsText: '', referenceMode: 'first_frame', referenceField: 'image_url', references: [] };
}

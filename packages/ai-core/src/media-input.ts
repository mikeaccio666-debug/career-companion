import type { CreateJobInput, ProviderAttachment } from '@companion/platform-contracts';
import { invalid } from './errors.ts';

export const MEDIA_REFERENCE_MAX_IMAGES = 4;
export const MEDIA_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_REFERENCE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Header recognition only; provider-specific dimensions and decoding remain provider checks. */
export function mediaImageMime(bytes: Uint8Array): typeof MEDIA_REFERENCE_MIME_TYPES[number] | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  if (head.length === 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export function validateMediaReferenceImages(refs: readonly ProviderAttachment[]): void {
  if (!Array.isArray(refs) || refs.length > MEDIA_REFERENCE_MAX_IMAGES) invalid('Select at most four private reference images.');
  let total = 0;
  for (const ref of refs) {
    if (!ref || !(ref.bytes instanceof Uint8Array) || !ref.bytes.length ||
        !MEDIA_REFERENCE_MIME_TYPES.includes(ref.mime as typeof MEDIA_REFERENCE_MIME_TYPES[number]) ||
        mediaImageMime(ref.bytes) !== ref.mime) invalid('Private references must contain matching PNG, JPEG or WebP image data.');
    total += ref.bytes.byteLength;
    if (total > MEDIA_REFERENCE_MAX_BYTES) invalid('Private reference images must total at most 20 MiB.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function enumValue(value: unknown, values: readonly string[], message: string): void {
  if (typeof value !== 'string' || !values.includes(value)) invalid(message);
}
function integer(value: unknown, min: number, max: number, message: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(message);
}
function jsonInput(value: unknown): void {
  let entries = 0;
  function walk(item: unknown, depth: number): void {
    if (depth > 12 || ++entries > 512) invalid('The model input is too deeply nested or contains too many values.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return; }
    if (record(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Unsupported model input field.');
        walk(child, depth + 1);
      }
      return;
    }
    invalid('Model input must contain only JSON values.');
  }
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) invalid('Model parameters exceed the one MiB limit.');
}

/** Pure preflight: never reads images, performs inference, or interprets arbitrary fal model schemas. */
export function validateMediaReferenceBinding(provider: string, kind: string, options: Record<string, unknown>, count: number): void {
  if (!record(options)) invalid('Media options must be an object.');
  if (!Number.isSafeInteger(count) || count < 0 || count > MEDIA_REFERENCE_MAX_IMAGES) invalid('Select at most four private reference images.');
  if (!['image', 'video'].includes(kind)) { if (count) invalid('This step does not bind private reference images.'); return; }
  const allowed = provider === 'openai' && kind === 'image' ? ['aspectRatio'] :
    provider === 'ark' && kind === 'video' ? ['aspectRatio', 'duration', 'seed', 'resolution', 'referenceMode'] :
    provider === 'fal' && ['image', 'video'].includes(kind) ? ['referenceField', 'input'] : [];
  if (Object.keys(options).some(key => !allowed.includes(key))) invalid('This media adapter does not support one or more requested options.');
  if (provider === 'openai' && kind === 'image') {
    if (options.aspectRatio !== undefined) enumValue(options.aspectRatio, ['1:1', '16:9', '9:16', '4:3'], 'Select an image ratio of 1:1, 16:9, 9:16 or 4:3.');
    return;
  }
  if (provider === 'ark' && kind === 'video') {
    const mode = options.referenceMode ?? (count === 1 ? 'first_frame' : count === 2 ? 'first_last_frame' : 'reference_image');
    if (options.referenceMode !== undefined && !count) invalid('A reference mode requires private reference images.');
    enumValue(mode, ['first_frame', 'first_last_frame', 'reference_image'], 'Select a supported video reference mode.');
    if (count && (mode === 'first_frame' && count !== 1 || mode === 'first_last_frame' && count !== 2)) invalid('Choose one first frame, two first/last frames, or explicit reference images.');
    if (options.aspectRatio !== undefined) enumValue(options.aspectRatio, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'adaptive'], 'Select a supported video ratio.');
    if (options.resolution !== undefined) enumValue(options.resolution, ['480p', '720p', '1080p'], 'Select a supported video resolution.');
    if (options.duration !== undefined) integer(options.duration, -1, 30, 'Video duration must be an integer from 2 to 30, or -1 for a supported adaptive model.');
    if (options.duration === 0 || options.duration === 1) invalid('Video duration must be an integer from 2 to 30, or -1 for a supported adaptive model.');
    if (options.seed !== undefined) integer(options.seed, -1, 2 ** 32 - 1, 'Video seed must be an integer between -1 and 4294967295.');
    return;
  }
  if (provider === 'fal' && ['image', 'video'].includes(kind)) {
    const field = options.referenceField ?? 'image_url';
    if (options.referenceField !== undefined && !count) invalid('A reference field requires private reference images.');
    enumValue(field, ['image_url', 'image_urls'], 'Select image_url or image_urls for an endpoint supporting that private reference field.');
    if (count > 1 && field === 'image_url') invalid('Use image_urls for multiple references supported by the selected fal model.');
    if (options.input !== undefined) {
      if (!record(options.input)) invalid('fal input must be an object matching the selected model schema.');
      jsonInput(options.input);
      if (count && (Object.hasOwn(options.input, 'image_url') || Object.hasOwn(options.input, 'image_urls'))) invalid('Choose private reference images or model input image URL fields, not both.');
      if (options.input.prompt !== undefined) invalid('Use the task prompt instead of a second prompt in model input.');
      if (options.input.sync_mode !== undefined && options.input.sync_mode !== false) invalid('This durable queue adapter does not support synchronous data URI outputs.');
    }
    return;
  }
  if (count) invalid('This provider does not bind private reference images.');
}

export function validateMediaJobInput(input: CreateJobInput): void {
  if (input.options !== undefined && !record(input.options)) invalid('Media options must be an object.');
  if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) invalid('Select private image attachment IDs as an array.');
  const ids = input.attachmentIds ?? [];
  if (!Array.isArray(ids) || ids.length > MEDIA_REFERENCE_MAX_IMAGES || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id.length || id.length > 200)) invalid('Select at most four distinct authorized private image attachments.');
  validateMediaReferenceBinding(input.provider, input.kind, input.options ?? {}, ids.length);
  if (input.provider === 'ark' && input.kind === 'video' && input.model) validateArkModelOptions(input.model, input.options ?? {}, ids.length);
  if (input.provider === 'openai' && input.kind === 'image' && input.model) openAIImageSize(input.model, input.options?.aspectRatio);
}

export function openAIImageSize(selected: string, ratio: unknown): string {
  if (ratio === undefined) return '1536x1024';
  if (ratio === '1:1') return '1024x1024';
  if (!/^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(selected)) invalid('This image adapter supports exact landscape and portrait ratios only with the configured GPT Image 2.5 models. Select 1:1 or change the server model.');
  if (ratio === '16:9') return '1536x864';
  if (ratio === '9:16') return '864x1536';
  if (ratio === '4:3') return '1536x1152';
  invalid('Select a supported exact image ratio.');
}

export function isArkSeedance25Model(selected: string): boolean {
  return /^(?:doubao-)?seedance-2[-.]5(?:-|$)/.test(selected);
}
export function validateArkModelOptions(selected: string, options: Record<string, unknown>, count: number): void {
  const mode = options.referenceMode ?? (count === 1 ? 'first_frame' : count === 2 ? 'first_last_frame' : 'reference_image');
  if (isArkSeedance25Model(selected) && count && mode !== 'reference_image' &&
      options.aspectRatio !== undefined && options.aspectRatio !== 'adaptive') invalid('Seedance 2.5 first/last frame generation requires the adaptive ratio.');
  const duration = options.duration;
  if (duration === undefined) return;
  if (isArkSeedance25Model(selected)) { if (duration !== -1 && (Number(duration) < 4 || Number(duration) > 30)) invalid('Seedance 2.5 duration must be 4 to 30 seconds, or -1.'); }
  else if (/^(?:doubao-)?seedance-2[-.]0(?:-|$)/.test(selected)) { if (duration !== -1 && (Number(duration) < 4 || Number(duration) > 15)) invalid('Seedance 2.0 duration must be 4 to 15 seconds, or -1.'); }
  else if (/^(?:doubao-)?seedance-1[-.]0(?:-|$)/.test(selected)) { if (Number(duration) < 2 || Number(duration) > 12) invalid('Seedance 1.0 duration must be 2 to 12 seconds.'); }
}

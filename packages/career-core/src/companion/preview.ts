export interface CompanionModelPreview {
  readonly summary: string;
  readonly samples: readonly [string, string, string];
}

/** Internal transport bound, not a product copy-length requirement. */
export const COMPANION_PREVIEW_MAX_JSON_BYTES = 16 * 1024;
export const COMPANION_PREVIEW_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['summary', 'samples']),
  properties: Object.freeze({
    summary: Object.freeze({ type: 'string', minLength: 1 }),
    samples: Object.freeze({
      type: 'array', minItems: 3, maxItems: 3,
      items: Object.freeze({ type: 'string', minLength: 1 }),
    }),
  }),
});

export class CompanionPreviewError extends Error {
  readonly code = 'COMPANION_PREVIEW_INVALID';
  constructor() {
    super('The companion preview could not be parsed.');
    this.name = 'CompanionPreviewError';
  }
}
function invalid(): never { throw new CompanionPreviewError(); }
function boundedJson(text: string): void {
  if (text.length > COMPANION_PREVIEW_MAX_JSON_BYTES
    || new TextEncoder().encode(text).byteLength > COMPANION_PREVIEW_MAX_JSON_BYTES) invalid();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > COMPANION_PREVIEW_MAX_JSON_BYTES || !value.trim()
    || /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function samples(value: unknown): readonly [string, string, string] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  if (descriptors.length?.value !== 3 || Reflect.ownKeys(value).some(key => !['length', '0', '1', '2'].includes(key as string))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  const result: string[] = [];
  for (const key of ['0', '1', '2']) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable) invalid();
    result.push(text(descriptor.value));
  }
  return Object.freeze(result as [string, string, string]);
}

/**
 * 02 §§2.1, 2.6, 15.4: the model writes only a summary and three sample sentences.
 * This closed structural codec does not establish model completion, provenance,
 * output-policy approval, permission to display, or permission to persist.
 */
export function parseCompanionModelPreview(value: unknown): Readonly<CompanionModelPreview> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => !['summary', 'samples'].includes(key as string))
      || !Object.hasOwn(descriptors, 'summary') || !Object.hasOwn(descriptors, 'samples')
      || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
    const result = Object.freeze({ summary: text(descriptors.summary.value), samples: samples(descriptors.samples.value) });
    boundedJson(JSON.stringify(result));
    return result;
  } catch { throw new CompanionPreviewError(); }
}

/** Complete JSON only: reject fences, trailing output, and duplicate decoded keys. */
export function parseCompanionModelPreviewJson(value: string): Readonly<CompanionModelPreview> {
  try {
    if (typeof value !== 'string') invalid();
    boundedJson(value);
    let cursor = 0;
    const skipWhitespace = () => { while (/[\x20\t\r\n]/.test(value[cursor] ?? '') && cursor < value.length) cursor++; };
    const consume = (token: string) => {
      skipWhitespace();
      if (value[cursor] !== token) invalid();
      cursor++;
    };
    const readString = (): string => {
      skipWhitespace();
      if (value[cursor] !== '"') invalid();
      const start = cursor++;
      while (cursor < value.length) {
        const character = value[cursor++];
        if (character === '\\') {
          if (cursor >= value.length) invalid();
          cursor++;
        } else if (character === '"') {
          const decoded: unknown = JSON.parse(value.slice(start, cursor));
          if (typeof decoded !== 'string') invalid();
          return decoded;
        }
      }
      return invalid();
    };
    const readSamples = (): readonly [string, string, string] => {
      consume('[');
      const first = readString(); consume(',');
      const second = readString(); consume(',');
      const third = readString(); consume(']');
      return [first, second, third];
    };
    consume('{');
    const result: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < 2; index++) {
      if (index) consume(',');
      const key = readString();
      if (!['summary', 'samples'].includes(key) || Object.hasOwn(result, key)) invalid();
      consume(':');
      result[key] = key === 'summary' ? readString() : readSamples();
    }
    consume('}'); skipWhitespace();
    if (cursor !== value.length) invalid();
    return parseCompanionModelPreview(result);
  } catch { throw new CompanionPreviewError(); }
}

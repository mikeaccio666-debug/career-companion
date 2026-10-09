/** Counts reported for the whole call. Cache counts are subsets of total input.
 * An absent cache field means unknown, never a measured zero. */
export type ModelCallUsage = Readonly<{ status: 'reported'; inputTokens: number; outputTokens: number;
  cachedInputTokens?: number; cacheWriteInputTokens?: number }> | Readonly<{ status: 'missing' | 'invalid' }>;
const bad = (): never => { throw new Error('Invalid model usage record.'); };
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0) || value > 2147483647) return bad();
  return value;
}
/** Closed data-only boundary; neither arbitrary properties nor getters enter accounting. */
export function parseModelCallUsage(value: unknown): ModelCallUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string') || Object.values(d).some(v => !('value' in v) || !v.enumerable)) return bad();
  const status = d.status?.value;
  if (status === 'missing' || status === 'invalid') {
    if (Object.keys(d).length !== 1) return bad();
    return Object.freeze({ status });
  }
  if (status !== 'reported' || Object.keys(d).some(k => !['status', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'].includes(k))) return bad();
  const inputTokens = count(d.inputTokens?.value), outputTokens = count(d.outputTokens?.value);
  const cachedInputTokens = d.cachedInputTokens ? count(d.cachedInputTokens.value) : undefined;
  const cacheWriteInputTokens = d.cacheWriteInputTokens ? count(d.cacheWriteInputTokens.value) : undefined;
  if ((cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens) return bad();
  return Object.freeze({ status, inputTokens, outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}) });
}

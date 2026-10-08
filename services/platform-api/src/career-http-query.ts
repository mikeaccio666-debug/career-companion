import { ApiError } from './errors.ts';

/** Fastify's query parser uses its own empty prototype. Copy only own data
 * fields at the HTTP boundary; domain commands still require plain records.
 * Repeated parameters stay arrays so scalar domain codecs reject them. */
export function careerHttpQuery(value: unknown): Record<string, unknown> {
  const invalid = () => new ApiError(400, 'CAREER_QUERY_INVALID', 'Use supported query fields.');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw invalid();
    const field = descriptors[key];
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) throw invalid();
    Object.defineProperty(result, key, { value: field.value, enumerable: true });
  }
  return result;
}

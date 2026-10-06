import { createHash } from 'node:crypto';
import { invalid } from './errors.ts';

/** Stable JSON hashing survives PostgreSQL JSONB ordering without logging its input. */
export function workflowHash(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 20) invalid('Workflow data exceeds its nesting limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    const plain = item !== null && typeof item === 'object' && !Array.isArray(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item));
    if (!Array.isArray(item) && !plain) invalid('Workflow data must contain JSON values only.');
    if (active.has(item as object)) invalid('Workflow data cannot contain circular references.');
    active.add(item as object);
    let result: string;
    if (Array.isArray(item)) result = '[' + Array.from(item, entry => entry === undefined ? 'null' : encode(entry, depth + 1)).join(',') + ']';
    else { const data = item as Record<string, unknown>; result = '{' + Object.keys(data).filter(key => data[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + encode(data[key], depth + 1)).join(',') + '}'; }
    active.delete(item as object); return result;
  }
  const serialized = encode(value, 0);
  if (Buffer.byteLength(serialized) > 512 * 1024) invalid('Workflow data exceeds its size limit.');
  return createHash('sha256').update(serialized).digest('hex');
}

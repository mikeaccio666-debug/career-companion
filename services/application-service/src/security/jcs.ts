/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import { createHash } from 'node:crypto';

/**
 * Minimal RFC 8785 serializer for contract digest inputs.
 *
 * Digest builders in this repository construct plain JSON data and must fail
 * closed if an input accidentally contains a Date, bigint, undefined, sparse
 * array item, non-finite number, or another value JSON would silently coerce.
 */
export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

export function sha256Jcs(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')}`;
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw unsupported();
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw unsupported();
      items.push(serialize(value[index]));
    }
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw unsupported();
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`);
    return `{${members.join(',')}}`;
  }

  throw unsupported();
}

function unsupported(): Error {
  return new Error('JCS_UNSUPPORTED_VALUE');
}

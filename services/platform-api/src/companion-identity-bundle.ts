import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parseCompanionIdentityPolicy, type CompanionIdentityPolicy } from '@companion/career-core';

const MAX_BYTES = 256 * 1024;
export interface CompanionIdentityBundle {
  readonly schemaVersion: 1; readonly revision: number; readonly contentDigest: string;
  readonly sourceRefs: Readonly<{ names: string; seals: string; aliases: string }>;
  readonly policy: Readonly<CompanionIdentityPolicy>;
}
export class CompanionIdentityBundleError extends Error {
  readonly code = 'COMPANION_IDENTITY_BUNDLE_INVALID';
  constructor() { super('The companion identity bundle is not available.'); this.name = 'CompanionIdentityBundleError'; }
}
function invalid(): never { throw new CompanionIdentityBundleError(); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key].value]));
}
function reference(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 600
    || Array.from(value).length > 300 || /[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function content(value: unknown, requireDigest: boolean) {
  const required = ['schemaVersion', 'revision', 'sourceRefs', 'policy'];
  const data = record(value, requireDigest ? [...required, 'contentDigest'] : required, requireDigest ? [] : ['contentDigest']);
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1
    || (data.revision as number) > 2147483647 || Object.is(data.revision, -0)) invalid();
  const refs = record(data.sourceRefs, ['names', 'seals', 'aliases']);
  const sourceRefs = Object.freeze({ names: reference(refs.names), seals: reference(refs.seals), aliases: reference(refs.aliases) });
  const policy = parseCompanionIdentityPolicy(data.policy);
  const canonical = { schemaVersion: 1 as const, revision: data.revision as number, sourceRefs, policy };
  const bytes = Buffer.from(JSON.stringify(canonical), 'utf8');
  if (bytes.length > MAX_BYTES) invalid();
  return { canonical, digest: createHash('sha256').update(bytes).digest('hex'), supplied: data.contentDigest };
}
/** Content integrity only. A hash or provenance string cannot establish vocabulary review or tier-one membership. */
export function expectedCompanionIdentityBundleDigest(value: unknown): string {
  try { return content(value, false).digest; } catch { throw new CompanionIdentityBundleError(); }
}
export function parseCompanionIdentityBundle(value: unknown): Readonly<CompanionIdentityBundle> {
  try {
    const { canonical, digest, supplied } = content(value, true);
    if (typeof supplied !== 'string' || /^[0-9a-f]{64}$/.exec(supplied)?.[0] !== supplied || supplied !== digest) invalid();
    return Object.freeze({ ...canonical, contentDigest: digest });
  } catch { throw new CompanionIdentityBundleError(); }
}
/** Optional server asset reader. It creates no activation, companion, model request or public endpoint. */
export async function readCompanionIdentityBundle(filename?: string): Promise<Readonly<CompanionIdentityBundle> | null> {
  if (filename === undefined) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)) invalid();
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    if (offset > MAX_BYTES) invalid();
    return parseCompanionIdentityBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
  } catch { throw new CompanionIdentityBundleError(); }
  finally { try { await handle?.close(); } catch { throw new CompanionIdentityBundleError(); } }
}

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { ApiError } from './errors.ts';

const MAX_BYTES = 128 * 1024, MAX_REVISION = 2147483647;
export interface SafetyKeywordEntry {
  readonly id: string; readonly language: 'zh' | 'en'; readonly level: 'L1' | 'L2'; readonly phrases: readonly string[];
}
export interface SafetyDetectorProfile {
  readonly schemaVersion: 1; readonly revision: number; readonly digest: string; readonly reviewDigest: string;
  readonly instructions: string; readonly algorithm: 'literal_substring_v1'; readonly lexicon: readonly SafetyKeywordEntry[];
  readonly mergeRule: 'highest_level'; readonly fallbackNoHit: 'unavailable';
  readonly review: Readonly<{ reference: string; approvedAt: string }>;
}
export class SafetyDetectorProfileError extends Error {
  readonly code = 'SAFETY_DETECTOR_PROFILE_INVALID';
  constructor() { super('The safety detector profile is not available.'); this.name = 'SafetyDetectorProfileError'; }
}
function invalid(): never { throw new SafetyDetectorProfileError(); }
function bounded<T>(run: () => T): T {
  try { return run(); } catch { return invalid(); }
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string'
    || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= value.length))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(descriptors, index)) invalid();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum * 2 || Array.from(value).length > maximum
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function normalized(value: string): string { return value.normalize('NFC').toLowerCase(); }
function content(value: unknown, requireDigests: boolean) {
  const keys = ['schemaVersion', 'revision', 'instructions', 'algorithm', 'lexicon', 'mergeRule', 'fallbackNoHit', 'review'];
  const data = record(value, requireDigests ? [...keys, 'digest', 'reviewDigest'] : keys, requireDigests ? [] : ['digest', 'reviewDigest']);
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1
    || (data.revision as number) > MAX_REVISION || Object.is(data.revision, -0)
    || data.algorithm !== 'literal_substring_v1' || data.mergeRule !== 'highest_level' || data.fallbackNoHit !== 'unavailable') invalid();
  const identifiers = new Set<string>();
  const lexicon = array(data.lexicon, 128).map(item => {
    const entry = record(item, ['id', 'language', 'level', 'phrases']);
    if (typeof entry.id !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.exec(entry.id)?.[0] !== entry.id
      || identifiers.has(entry.id) || !['zh', 'en'].includes(entry.language as string) || !['L1', 'L2'].includes(entry.level as string)) invalid();
    identifiers.add(entry.id);
    const phrases = array(entry.phrases, 64).map(phrase => text(phrase, 256)), matches = phrases.map(normalized);
    if (new Set(matches).size !== phrases.length) invalid();
    return { id: entry.id, language: entry.language as 'zh' | 'en', level: entry.level as 'L1' | 'L2', phrases };
  });
  if (!lexicon.some(entry => entry.language === 'zh') || !lexicon.some(entry => entry.language === 'en')) invalid();
  const review = record(data.review, ['reference', 'approvedAt']);
  const reference = text(review.reference, 400);
  if (typeof review.approvedAt !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.exec(review.approvedAt)?.[0] !== review.approvedAt
    || !Number.isFinite(Date.parse(review.approvedAt)) || new Date(review.approvedAt).toISOString() !== review.approvedAt) invalid();
  const result = { schemaVersion: 1 as const, revision: data.revision as number, instructions: text(data.instructions, 4000),
    algorithm: 'literal_substring_v1' as const, lexicon, mergeRule: 'highest_level' as const, fallbackNoHit: 'unavailable' as const,
    review: { reference, approvedAt: review.approvedAt } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) invalid();
  return { result, data };
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** Fixed key order; lexicon/phrase order and exact reviewed strings remain part of the content digest. */
export function expectedSafetyProfileDigests(value: unknown): Readonly<{ digest: string; reviewDigest: string }> {
  return bounded(() => {
    const { result } = content(value, false);
    const { review, ...canonical } = result;
    return Object.freeze({ digest: sha(JSON.stringify(canonical)), reviewDigest: sha(JSON.stringify(review)) });
  });
}
/** Parsing checks syntax/integrity only. Review metadata does not establish professional approval or activate a policy. */
export function parseSafetyDetectorProfile(value: unknown): Readonly<SafetyDetectorProfile> {
  return bounded(() => {
    const { result, data } = content(value, true), expected = expectedSafetyProfileDigests(result);
    if (digest(data.digest) !== expected.digest || digest(data.reviewDigest) !== expected.reviewDigest
      || Buffer.byteLength(JSON.stringify({ ...result, ...expected }), 'utf8') > MAX_BYTES) invalid();
    const lexicon = Object.freeze(result.lexicon.map(entry => Object.freeze({ ...entry, phrases: Object.freeze(entry.phrases) })));
    return Object.freeze({ ...result, ...expected, lexicon, review: Object.freeze(result.review) });
  });
}
/** No file means unconfigured. Explicit unreadable/invalid files fail with a bounded error, without path or content. */
export async function readSafetyDetectorProfile(filename?: string): Promise<Readonly<SafetyDetectorProfile> | null> {
  if (filename === undefined) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (typeof filename !== 'string' || !filename.trim()) invalid();
    handle = await fs.open(filename, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) invalid();
    // A fixed-size buffer also bounds reads when the file grows after stat().
    const bytes = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    if (offset > MAX_BYTES) invalid();
    return parseSafetyDetectorProfile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
  } catch { throw new SafetyDetectorProfileError(); }
  finally { try { await handle?.close(); } catch { throw new SafetyDetectorProfileError(); } }
}
/** Literal matching only. The approved operator-supplied profile owns the phrases; there is no built-in clinical lexicon. */
export function runSafetyKeywords(profile: SafetyDetectorProfile, value: string, signal?: AbortSignal): 'L1' | 'L2' | null {
  signal?.throwIfAborted();
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid();
  const input = normalized(value); let result: 'L1' | 'L2' | null = null;
  for (const entry of profile.lexicon) for (const phrase of entry.phrases) {
    signal?.throwIfAborted();
    if (!input.includes(normalized(phrase))) continue;
    if (entry.level === 'L2') { signal?.throwIfAborted(); return 'L2'; }
    result = 'L1';
  }
  signal?.throwIfAborted(); return result;
}
export const safetyDetectorUnavailable = () => new ApiError(503, 'ONBOARDING_SAFETY_UNAVAILABLE', 'Intake detection is not available.');
/** SHARE belongs to the actual caller's transaction and serializes accepted starts/results against explicit activation changes. */
export async function assertActiveSafetyDetector(client: Pick<PoolClient, 'query'>, profile: SafetyDetectorProfile | null, signal?: AbortSignal): Promise<SafetyDetectorProfile> {
  signal?.throwIfAborted(); if (!profile) throw safetyDetectorUnavailable();
  const found = await client.query('SELECT revision,content_digest,review_digest FROM platform_safety_detector_policy WHERE singleton=true FOR SHARE');
  signal?.throwIfAborted(); const row = found.rows[0];
  if (!row || row.revision !== profile.revision || row.content_digest !== profile.digest || row.review_digest !== profile.reviewDigest) throw safetyDetectorUnavailable();
  return profile;
}

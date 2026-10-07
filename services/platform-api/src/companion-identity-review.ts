import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { parseCompanionIdentityBundle, type CompanionIdentityBundle } from './companion-identity-bundle.ts';
import { ApiError } from './errors.ts';

const MAX_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KEYS = ['schemaVersion', 'bundleRevision', 'bundleDigest', 'coverage', 'reviewerUserId',
  'reviewedAt', 'reviewEvidenceRef', 'tierOneSourceRef'] as const;

export interface CompanionIdentityReview {
  readonly schemaVersion: 1;
  readonly bundleRevision: number;
  readonly bundleDigest: string;
  /** Human attestation that the bundle contains the complete eligible tier-one
   * character domain, including eligible name initials, after all exclusions.
   * Parsing this label cannot establish its truth or activate the bundle. */
  readonly coverage: 'complete_eligible_level_one';
  readonly reviewerUserId: string;
  readonly reviewedAt: string;
  readonly reviewEvidenceRef: string;
  readonly tierOneSourceRef: string;
  readonly reviewDigest: string;
}
export class CompanionIdentityReviewError extends Error {
  readonly code = 'COMPANION_IDENTITY_REVIEW_INVALID';
  constructor() { super('The companion identity review is not available.'); this.name = 'CompanionIdentityReviewError'; }
}
function invalid(): never { throw new CompanionIdentityReviewError(); }
function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function record(value: unknown, requireDigest: boolean): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), required: readonly string[] = requireDigest ? [...KEYS, 'reviewDigest'] : KEYS;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...KEYS, 'reviewDigest'].includes(key as typeof KEYS[number]))
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
  const data = record(value, requireDigest);
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.bundleRevision) || (data.bundleRevision as number) < 1
    || (data.bundleRevision as number) > 2147483647 || Object.is(data.bundleRevision, -0)
    || !matches(DIGEST, data.bundleDigest) || data.coverage !== 'complete_eligible_level_one'
    || !matches(UUID, data.reviewerUserId)
    || !matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, data.reviewedAt)
    || !Number.isFinite(Date.parse(data.reviewedAt)) || new Date(data.reviewedAt).toISOString() !== data.reviewedAt) invalid();
  const canonical = { schemaVersion: 1 as const, bundleRevision: data.bundleRevision as number,
    bundleDigest: data.bundleDigest, coverage: 'complete_eligible_level_one' as const,
    reviewerUserId: data.reviewerUserId, reviewedAt: data.reviewedAt,
    reviewEvidenceRef: reference(data.reviewEvidenceRef), tierOneSourceRef: reference(data.tierOneSourceRef) };
  const bytes = Buffer.from(JSON.stringify(canonical), 'utf8');
  if (bytes.length > MAX_BYTES) invalid();
  return { canonical, digest: createHash('sha256').update(bytes).digest('hex'), supplied: data.reviewDigest };
}
/** Integrity only: the hash binds all canonical manifest fields except itself.
 * Evidence references and the coverage label are not review or activation proof. */
export function expectedCompanionIdentityReviewDigest(value: unknown): string {
  try { return content(value, false).digest; } catch { throw new CompanionIdentityReviewError(); }
}
export function parseCompanionIdentityReview(value: unknown): Readonly<CompanionIdentityReview> {
  try {
    const { canonical, digest, supplied } = content(value, true);
    if (!matches(DIGEST, supplied) || supplied !== digest) invalid();
    return Object.freeze({ ...canonical, reviewDigest: digest });
  } catch { throw new CompanionIdentityReviewError(); }
}
/** Optional server-controlled file; this reader creates no review or activation. */
export async function readCompanionIdentityReview(filename?: string): Promise<Readonly<CompanionIdentityReview> | null> {
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
    return parseCompanionIdentityReview(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
  } catch { throw new CompanionIdentityReviewError(); }
  finally { try { await handle?.close(); } catch { throw new CompanionIdentityReviewError(); } }
}
export const companionIdentityUnavailable = () => new ApiError(503, 'COMPANION_IDENTITY_UNAVAILABLE', 'Companion naming is not available.');

/** Must run inside the actual caller's transaction. SHARE locks last until that
 * transaction ends; this is not session authorization or a vocabulary certifier.
 * Lock order: policy, organization, sorted authority users, sorted role rows.
 * An operator changing these records must preserve that order as well. */
export async function assertActiveCompanionIdentityBundle(client: Pick<PoolClient, 'query'>,
  bundle: CompanionIdentityBundle | null, review: CompanionIdentityReview | null, signal?: AbortSignal): Promise<Readonly<CompanionIdentityBundle>> {
  signal?.throwIfAborted();
  try {
    if (!bundle || !review) throw companionIdentityUnavailable();
    // Snapshot before any await; caller mutation cannot change the accepted asset.
    const fixedBundle = parseCompanionIdentityBundle(bundle), fixedReview = parseCompanionIdentityReview(review);
    if (fixedReview.bundleRevision !== fixedBundle.revision || fixedReview.bundleDigest !== fixedBundle.contentDigest) throw companionIdentityUnavailable();
    const found = await client.query(`SELECT revision,content_digest,review_digest,reviewed_by,org_id,activated_by
      FROM platform_companion_identity_policy WHERE singleton=true FOR SHARE`);
    signal?.throwIfAborted();
    const policy = found.rows[0];
    if (found.rows.length !== 1 || policy.revision !== fixedBundle.revision || policy.content_digest !== fixedBundle.contentDigest
      || policy.review_digest !== fixedReview.reviewDigest || policy.reviewed_by !== fixedReview.reviewerUserId
      || !matches(UUID, policy.org_id) || !matches(UUID, policy.activated_by)) throw companionIdentityUnavailable();
    const org = await client.query('SELECT id,status FROM platform_orgs WHERE id=$1 FOR SHARE', [policy.org_id]);
    signal?.throwIfAborted();
    if (org.rows.length !== 1 || org.rows[0].id !== policy.org_id || org.rows[0].status !== 'active') throw companionIdentityUnavailable();
    const userIds = [...new Set([fixedReview.reviewerUserId, policy.activated_by])].sort();
    const users = await client.query('SELECT id,account_kind FROM platform_users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [userIds]);
    signal?.throwIfAborted();
    if (users.rows.length !== userIds.length || new Set(users.rows.map(row => row.id)).size !== userIds.length
      || users.rows.some(row => !userIds.includes(row.id) || row.account_kind !== 'staff')) throw companionIdentityUnavailable();
    const roles = await client.query(`SELECT org_id,user_id,role,status,revoked_at FROM platform_org_roles WHERE org_id=$1
      AND ((user_id=$2 AND role='content_reviewer') OR (user_id=$3 AND role IN ('ops','org_admin')))
      ORDER BY org_id,user_id,role FOR SHARE`, [policy.org_id, fixedReview.reviewerUserId, policy.activated_by]);
    signal?.throwIfAborted();
    const active = roles.rows.filter(row => row.org_id === policy.org_id && row.status === 'active' && row.revoked_at === null);
    if (!active.some(row => row.user_id === fixedReview.reviewerUserId && row.role === 'content_reviewer')
      || !active.some(row => row.user_id === policy.activated_by && ['ops', 'org_admin'].includes(row.role))) throw companionIdentityUnavailable();
    // Recheck the actual timestamp in PostgreSQL after all lock waits. Do not
    // truncate a timestamptz to a JavaScript Date or use transaction-start now().
    const current = await client.query(`SELECT singleton FROM platform_companion_identity_policy WHERE singleton=true
      AND revision=$1 AND content_digest=$2 AND review_digest=$3 AND reviewed_by=$4 AND org_id=$5 AND activated_by=$6
      AND $7::timestamptz<=activated_at AND activated_at<=clock_timestamp() FOR SHARE`,
    [fixedBundle.revision, fixedBundle.contentDigest, fixedReview.reviewDigest, fixedReview.reviewerUserId,
      policy.org_id, policy.activated_by, fixedReview.reviewedAt]);
    signal?.throwIfAborted();
    if (current.rows.length !== 1 || current.rows[0].singleton !== true) throw companionIdentityUnavailable();
    return fixedBundle;
  } catch {
    signal?.throwIfAborted();
    throw companionIdentityUnavailable();
  }
}

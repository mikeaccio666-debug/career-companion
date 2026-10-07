import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import type { LegalAvailability, PublicLegalDocuments } from '@companion/platform-contracts';
import { ApiError } from './errors.ts';

export interface LegalBundle {
  readonly version: string; readonly digest: string;
  readonly terms: Readonly<{ title: string; body: string }>;
  readonly privacy: Readonly<{ title: string; body: string }>;
  readonly dataNotice: string;
  readonly review: Readonly<{ reference: string; approvedAt: string }>;
  readonly reviewDigest: string;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) && Buffer.from(value,'utf8').toString('utf8')===value;
}
export function legalContentDigest(input: Pick<LegalBundle, 'version' | 'terms' | 'privacy' | 'dataNotice'>): string {
  return sha(JSON.stringify({ version: input.version, terms: { title: input.terms.title, body: input.terms.body },
    privacy: { title: input.privacy.title, body: input.privacy.body }, dataNotice: input.dataNotice }));
}
/** Metadata is provided by the responsible operator. Parsing is not legal approval or activation. */
export function parseLegalBundle(value: unknown): LegalBundle | null {
  if (!record(value) || Object.keys(value).some(key => !['version','digest','terms','privacy','dataNotice','review','reviewDigest'].includes(key))
    || typeof value.version !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.exec(value.version)?.[0] !== value.version
    || !record(value.terms) || !record(value.privacy) || !record(value.review)
    || [value.terms, value.privacy].some(doc => Object.keys(doc).some(key => !['title','body'].includes(key)) || !text(doc.title, 400) || !text(doc.body, 96 * 1024))
    || Object.keys(value.review).some(key => !['reference','approvedAt'].includes(key)) || !text(value.review.reference, 400)
    || typeof value.review.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.review.approvedAt)
    || !Number.isFinite(Date.parse(value.review.approvedAt)) || new Date(value.review.approvedAt).toISOString() !== value.review.approvedAt
    || !text(value.dataNotice, 4000)) return null;
  const input = { version: value.version, terms: {title:value.terms.title as string,body:value.terms.body as string},
    privacy: {title:value.privacy.title as string,body:value.privacy.body as string}, dataNotice:value.dataNotice };
  const digest = legalContentDigest(input), review = {reference:value.review.reference as string,approvedAt:value.review.approvedAt};
  const reviewDigest = sha(JSON.stringify(review));
  if (value.digest !== digest || value.reviewDigest !== undefined && value.reviewDigest !== reviewDigest) return null;
  return Object.freeze({...input,digest,terms:Object.freeze(input.terms),privacy:Object.freeze(input.privacy),review:Object.freeze(review),reviewDigest});
}
export async function loadLegalBundle(filename?: string): Promise<LegalBundle | null> {
  if (!filename) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const bytes = await handle.readFile(); if (bytes.byteLength > 256 * 1024) return null;
    return parseLegalBundle(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  } catch { return null; } finally { await handle?.close(); }
}
export const legalUnavailable = () => new ApiError(503,'LEGAL_DOCUMENTS_UNAVAILABLE','The current legal documents are not available.');
/** SHARE serializes accepted starts and confirmations against an explicit policy change. */
export async function assertActiveLegal(client: Pick<PoolClient,'query'>, bundle: LegalBundle | null, signal?: AbortSignal): Promise<LegalBundle> {
  signal?.throwIfAborted(); if (!bundle) throw legalUnavailable();
  const result = await client.query('SELECT terms_version,content_digest,review_digest FROM platform_terms_policy WHERE singleton=true FOR SHARE');
  signal?.throwIfAborted(); const row = result.rows[0];
  if (!row || row.terms_version !== bundle.version || row.content_digest !== bundle.digest || row.review_digest !== bundle.reviewDigest) throw legalUnavailable();
  return bundle;
}
export function legalAvailability(bundle: LegalBundle | null): LegalAvailability {
  return bundle ? {status:'available',version:bundle.version,digest:bundle.digest} : {status:'unavailable'};
}
export function publicLegalDocuments(bundle: LegalBundle | null): PublicLegalDocuments {
  return bundle ? {status:'available',version:bundle.version,digest:bundle.digest,terms:{...bundle.terms},privacy:{...bundle.privacy},dataNotice:bundle.dataNotice} : {status:'unavailable'};
}

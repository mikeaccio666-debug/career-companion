/** Owner-initiated job intake from one application URL. Mirrors AGENT-API-CONTRACT.md §4.1. */

import {
  parseUuid,
  type AgentSchemaEnvelope,
  type Uuid,
} from './common.ts';
import { ATS_PROVIDER_CODES, type AtsProviderCode } from './missions.ts';

/**
 * Add the posting at this URL to the catalog, so a Mission can be created for it.
 *
 * The catalog is normally filled by the scraping pipeline. This is the other
 * door: a person is looking at a posting the pipeline has not reached, and wants
 * to apply to it. Without it the whole product is bounded by what was scraped,
 * and a page the user found themselves can never be filled.
 *
 * It adds an identity, never an approval. The posting becomes a canonical job
 * the owner can then create a Mission for, and that Mission still has to be
 * approved before anything is filled -- this widens what can be applied to, and
 * moves no consent boundary.
 *
 * T6-14: for a Greenhouse posting the identity is verified on admission (the
 * official posting is fetched and materialized), so the Mission can be created
 * at once; the response shape is unchanged.
 *
 * `applicationUrl` is the only input because it is the only thing that decides
 * the identity: the promoter reads the URL and derives the board, the listing id
 * and the posting fingerprint from it alone. Nothing about the posting's content
 * is accepted from the caller, so a client cannot describe a job into existence.
 */
export interface CreateJobFromUrlRequest {
  readonly clientRequestId: Uuid;
  readonly applicationUrl: string;
}

/** §4.1 value-free identity projection: no title, company, location or body. */
export interface JobIntakeView {
  readonly canonicalJobId: Uuid;
  readonly listingId: Uuid;
  readonly atsProvider: AtsProviderCode;
  readonly canonicalOrigin: string;
  readonly applicationPathname: string;
}

export interface CreateJobFromUrlResponse extends AgentSchemaEnvelope {
  readonly job: JobIntakeView;
  /** False when this URL was already in the catalog; the identity is the same either way. */
  readonly created: boolean;
}

/**
 * Stable refusals, one per thing the registry actually distinguishes.
 *
 * A vendor we do not model, a vendor we model but have not switched on, and a
 * page shape the vendor's own parser rejects are three different answers, and
 * collapsing them would misreport the second as the third -- telling a user that
 * a Lever posting has an unparseable path when the truth is that Lever is not
 * turned on yet. None of them says anything about the catalog.
 */
export const JOB_INTAKE_ERROR_CODES = [
  'JOB_INTAKE_PROVIDER_UNSUPPORTED',
  'JOB_INTAKE_PROVIDER_NOT_ENABLED',
  'JOB_INTAKE_URL_UNPARSEABLE',
  /** T6-14: the provider answered and the posting is gone or unreadable; nothing was added. */
  'JOB_INTAKE_POSTING_UNAVAILABLE',
  /** T6-14: the provider could not be reached; the same URL may be retried later. */
  'JOB_INTAKE_PROVIDER_UNAVAILABLE',
] as const;
export type JobIntakeErrorCode = (typeof JOB_INTAKE_ERROR_CODES)[number];

/** The longest application URL admitted. Bounded so a body cannot be a payload. */
const MAX_APPLICATION_URL = 2048;

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/**
 * Strict shared decoder for the request.
 *
 * The URL is checked for shape only -- https, no credentials, no fragment, and
 * bounded. Whether it is a posting this system understands is the promoter's
 * decision, not this one, and it is deliberately not duplicated here: two places
 * deciding what a Greenhouse URL is would drift.
 */
export function parseCreateJobFromUrlRequest(value: unknown): CreateJobFromUrlRequest | null {
  if (!isRecordWithExactKeys(value, ['clientRequestId', 'applicationUrl'])) return null;
  const clientRequestId = parseUuid(value.clientRequestId);
  if (clientRequestId === null) return null;
  const raw = value.applicationUrl;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_APPLICATION_URL || raw !== raw.trim()) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  return Object.freeze({ clientRequestId, applicationUrl: raw });
}

/** Strict shared decoder for the answer; exact keys, so no field can be read past. */
export function parseCreateJobFromUrlResponse(value: unknown): CreateJobFromUrlResponse | null {
  if (!isRecordWithExactKeys(value, ['schemaVersion', 'job', 'created'])) return null;
  if (value.schemaVersion !== 1 || typeof value.created !== 'boolean') return null;
  if (!isRecordWithExactKeys(value.job, [
    'canonicalJobId', 'listingId', 'atsProvider', 'canonicalOrigin', 'applicationPathname',
  ])) return null;
  const job = value.job;
  const canonicalJobId = parseUuid(job.canonicalJobId);
  const listingId = parseUuid(job.listingId);
  if (
    canonicalJobId === null ||
    listingId === null ||
    !(ATS_PROVIDER_CODES as readonly string[]).includes(job.atsProvider as string) ||
    typeof job.canonicalOrigin !== 'string' ||
    typeof job.applicationPathname !== 'string' ||
    !job.canonicalOrigin.startsWith('https://') ||
    !job.applicationPathname.startsWith('/')
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    created: value.created,
    job: Object.freeze({
      canonicalJobId,
      listingId,
      atsProvider: job.atsProvider as AtsProviderCode,
      canonicalOrigin: job.canonicalOrigin,
      applicationPathname: job.applicationPathname,
    }),
  });
}

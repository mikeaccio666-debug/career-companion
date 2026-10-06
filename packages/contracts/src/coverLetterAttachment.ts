/**
 * Page-targeted cover-letter attachments (2026-09-27, additive).
 *
 * Owner decision (2026-09-27): whenever an application form has a cover-letter field,
 * required or optional, the extension attaches a letter written for that job. The Mission
 * materials entry (missionDock.ts) needs a Start-applying Mission; most store-extension users
 * have none, so these routes name the application page instead, like resume attachments
 * (resumeAtsAttachment.ts): `target = { canonicalOrigin, jobId: pathname }`.
 *
 * The server maps the page to its job. A page of a catalog job is written from the verified
 * catalog JD, and any `pageJob` the extension sends is ignored. A page outside the catalog is
 * written from the `pageJob` the extension read off that page: untrusted, bounded plain text,
 * quoted to the model as data, never instructions; the letter still only restates confirmed
 * Profile evidence. Such a letter is keyed to that exact page and released only to it.
 *
 * Every release passes the operator deny-list and is audited (`COVER_LETTER_ATS_RELEASED`);
 * neither the letter nor the page JD ever enters the trace. Nothing here submits anything
 * (RULE-EXT-NEVER-SUBMIT).
 *
 * Releases answer with MISSION_MATERIAL_HEADERS and MISSION_COVER_LETTER_MAX_TEXT_BYTES,
 * exactly like the Mission entry.
 */
import { parseIsoDateTime, parseUuid, type IsoDateTime, type Uuid } from './common.ts';
import { COVER_LETTER_GENERATION_CODES } from './coverLetterProduct.ts';
import { MISSION_COVER_LETTER_MAX_TEXT_BYTES } from './missionDock.ts';
import {
  parseResumeAtsAttachmentTargetV1,
  type ResumeAtsAttachmentTargetV1,
} from './resumeAtsAttachment.ts';

/** The page the letter is for: the resume attachment target, `jobId` being the page pathname. */
export type CoverLetterAttachmentTargetV1 = ResumeAtsAttachmentTargetV1;

/**
 * Where the letter's job description comes from. `CATALOG`: the verified catalog JD of the job
 * this page belongs to. `PAGE`: the page is not in the catalog; the extension must send `pageJob`.
 */
export const COVER_LETTER_JOB_SOURCES = ['CATALOG', 'PAGE'] as const;
export type CoverLetterJobSource = (typeof COVER_LETTER_JOB_SOURCES)[number];

/** How the extension found the text: a structured posting on the page, or the page's visible text. */
export const COVER_LETTER_PAGE_JOB_SOURCES = ['JOB_POSTING', 'PAGE_TEXT'] as const;
export type CoverLetterPageJobSource = (typeof COVER_LETTER_PAGE_JOB_SOURCES)[number];

/** Bounds in JavaScript string length (UTF-16 code units). */
export const COVER_LETTER_PAGE_JOB_BOUNDS = Object.freeze({
  titleMax: 300,
  companyMax: 200,
  descriptionMax: 20_000,
});

/**
 * The job as the application page shows it. Plain text only (no HTML): control characters other
 * than `\n` and `\t`, bidirectional overrides/isolates and lone surrogates are rejected. `company`
 * may be empty when the page does not name one.
 */
export interface CoverLetterPageJobV1 {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly company: string;
  readonly description: string;
  readonly source: CoverLetterPageJobSource;
}

/**
 * Domain failures of `prepare`: the cover-letter product codes plus the one this route adds.
 * `COVER_LETTER_JOB_NOT_IN_CATALOG`: the page is not in the catalog and no `pageJob` was sent.
 */
export const COVER_LETTER_ATTACHMENT_FAILURE_CODES = [
  ...COVER_LETTER_GENERATION_CODES,
  'COVER_LETTER_JOB_NOT_IN_CATALOG',
] as const;
export type CoverLetterAttachmentFailureCode = (typeof COVER_LETTER_ATTACHMENT_FAILURE_CODES)[number];

/** POST /api/v1/agent/cover-letter-attachments/lookup. Free: never reaches a model. */
export interface CoverLetterAttachmentLookupRequestV1 {
  readonly schemaVersion: 1;
  readonly target: CoverLetterAttachmentTargetV1;
}

/**
 * The newest letter this owner may attach on this page. No text here.
 *
 * For `PAGE`, `READY` is the newest letter written for this exact page. Some sites show many jobs
 * at one path (the job id in a query string), and only the page job tells them apart: before
 * releasing on a `PAGE` page, send `pageJob` to `prepare`, which hands the letter back for free
 * only when it was written for the same job (title and company) and writes one otherwise.
 */
export type CoverLetterAttachmentLookupV1 =
  | Readonly<{ schemaVersion: 1; state: 'NONE'; jobSource: CoverLetterJobSource }>
  | Readonly<{
      schemaVersion: 1;
      state: 'READY';
      jobSource: CoverLetterJobSource;
      artifactId: Uuid;
      generatedAt: IsoDateTime;
    }>;

/**
 * POST /api/v1/agent/cover-letter-attachments/prepare. Metered on `vibeid_generation` and
 * replayed by `clientRequestId`. `pageJob` is read only when the page is not in the catalog.
 */
export interface CoverLetterAttachmentPrepareRequestV1 {
  readonly schemaVersion: 1;
  readonly clientRequestId: Uuid;
  readonly target: CoverLetterAttachmentTargetV1;
  readonly pageJob?: CoverLetterPageJobV1;
}

/**
 * Domain failures answer 200 with the closed code set, like the cover-letter product.
 * `generated: false` means an existing letter was handed back and nothing was charged.
 */
export type CoverLetterAttachmentPrepareResultV1 =
  | Readonly<{
      schemaVersion: 1;
      ok: true;
      coverLetter: Readonly<{ state: 'READY'; artifactId: Uuid; generatedAt: IsoDateTime }>;
      generated: boolean;
    }>
  | Readonly<{ schemaVersion: 1; ok: false; code: CoverLetterAttachmentFailureCode }>;

/** POST /api/v1/agent/cover-letter-attachments/text and …/pdf. */
export interface CoverLetterAttachmentReleaseRequestV1 {
  readonly schemaVersion: 1;
  readonly artifactId: Uuid;
  readonly target: CoverLetterAttachmentTargetV1;
}

/** …/text: the letter for a textarea or plain-text editor. …/pdf answers the rendered file. */
export interface CoverLetterAttachmentTextV1 {
  readonly schemaVersion: 1;
  readonly artifactId: Uuid;
  readonly text: string;
}

/** The released PDF's file name, the same on the Mission entry. */
export const COVER_LETTER_ATTACHMENT_PDF_FILE_NAME = 'Cover Letter.pdf';

export function parseCoverLetterPageJobV1(value: unknown): CoverLetterPageJobV1 | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'title', 'company', 'description', 'source']) ||
    value.schemaVersion !== 1 ||
    !isPageText(value.title, 1, COVER_LETTER_PAGE_JOB_BOUNDS.titleMax) ||
    !isPageText(value.company, 0, COVER_LETTER_PAGE_JOB_BOUNDS.companyMax) ||
    !isPageText(value.description, 1, COVER_LETTER_PAGE_JOB_BOUNDS.descriptionMax) ||
    !isMember(value.source, COVER_LETTER_PAGE_JOB_SOURCES)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    title: value.title,
    company: value.company,
    description: value.description,
    source: value.source,
  });
}

export function parseCoverLetterAttachmentLookupRequestV1(
  value: unknown,
): CoverLetterAttachmentLookupRequestV1 | null {
  if (!hasExactRecordKeys(value, ['schemaVersion', 'target']) || value.schemaVersion !== 1) return null;
  const target = parseTarget(value.target);
  return target === null ? null : Object.freeze({ schemaVersion: 1, target });
}

/**
 * 2026-09-28：后端先发的加法（多一个字段）从前让旧包整条求职信路停掉；现在多出来的成员不解释、不转发，
 * 认得的字段照旧逐项校验。按 `state` 分形，不再按键集：这一版不认识的状态读作 NONE、绝不当 READY（于是经
 * `prepare` 要，已有的那一封服务端免费交回）；不认识的 `jobSource` 读作 PAGE，走更严的那条路（已有的信不直接附，
 * 带上这一页的职位描述经 `prepare`，由服务端再认一遍）。不像闭集成员的值（小写、空、非字符串）照旧整条拒。
 */
export function parseCoverLetterAttachmentLookupV1(value: unknown): CoverLetterAttachmentLookupV1 | null {
  if (!hasRequiredRecordKeys(value, ['schemaVersion', 'state', 'jobSource']) || value.schemaVersion !== 1) {
    return null;
  }
  const jobSource = answerJobSource(value.jobSource);
  if (jobSource === null || !isAnswerToken(value.state, 32)) return null;
  if (value.state !== 'READY') return Object.freeze({ schemaVersion: 1, state: 'NONE', jobSource });
  if (!hasRequiredRecordKeys(value, ['schemaVersion', 'state', 'jobSource', 'artifactId', 'generatedAt'])) return null;
  const artifactId = parseUuid(value.artifactId);
  const generatedAt = parseIsoDateTime(value.generatedAt);
  return artifactId === null || generatedAt === null
    ? null
    : Object.freeze({ schemaVersion: 1, state: 'READY', jobSource, artifactId, generatedAt });
}

export function parseCoverLetterAttachmentPrepareRequestV1(
  value: unknown,
): CoverLetterAttachmentPrepareRequestV1 | null {
  const withPageJob = hasExactRecordKeys(value, ['schemaVersion', 'clientRequestId', 'target', 'pageJob']);
  if (
    (!withPageJob && !hasExactRecordKeys(value, ['schemaVersion', 'clientRequestId', 'target'])) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const clientRequestId = parseUuid(value.clientRequestId);
  const target = parseTarget(value.target);
  if (clientRequestId === null || target === null) return null;
  if (!withPageJob) return Object.freeze({ schemaVersion: 1, clientRequestId, target });
  const pageJob = parseCoverLetterPageJobV1(value.pageJob);
  return pageJob === null ? null : Object.freeze({ schemaVersion: 1, clientRequestId, target, pageJob });
}

/**
 * 2026-09-28：后端先发的加法从前让旧包整条停掉；现在顶层与 `coverLetter` 里多出来的成员不解释、不转发，认得的
 * 字段照旧逐项校验。按 `ok` 分形，不再按键集。这一版不认识的失败码读作 COVER_LETTER_UNAVAILABLE：这次确实没
 * 写成，只是原因这一版说不上来。信本身的 `state` 照旧只认 READY。
 */
export function parseCoverLetterAttachmentPrepareResultV1(
  value: unknown,
): CoverLetterAttachmentPrepareResultV1 | null {
  if (hasRequiredRecordKeys(value, ['schemaVersion', 'ok', 'code']) && value.ok === false) {
    const code = answerFailureCode(value.code);
    return value.schemaVersion === 1 && code !== null ? Object.freeze({ schemaVersion: 1, ok: false, code }) : null;
  }
  if (
    !hasRequiredRecordKeys(value, ['schemaVersion', 'ok', 'coverLetter', 'generated']) ||
    value.schemaVersion !== 1 ||
    value.ok !== true ||
    typeof value.generated !== 'boolean' ||
    !hasRequiredRecordKeys(value.coverLetter, ['state', 'artifactId', 'generatedAt']) ||
    value.coverLetter.state !== 'READY'
  ) {
    return null;
  }
  const artifactId = parseUuid(value.coverLetter.artifactId);
  const generatedAt = parseIsoDateTime(value.coverLetter.generatedAt);
  if (artifactId === null || generatedAt === null) return null;
  return Object.freeze({
    schemaVersion: 1,
    ok: true,
    coverLetter: Object.freeze({ state: 'READY', artifactId, generatedAt }),
    generated: value.generated,
  });
}

export function parseCoverLetterAttachmentReleaseRequestV1(
  value: unknown,
): CoverLetterAttachmentReleaseRequestV1 | null {
  if (!hasExactRecordKeys(value, ['schemaVersion', 'artifactId', 'target']) || value.schemaVersion !== 1) {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  const target = parseTarget(value.target);
  return artifactId === null || target === null ? null : Object.freeze({ schemaVersion: 1, artifactId, target });
}

export function parseCoverLetterAttachmentTextV1(value: unknown): CoverLetterAttachmentTextV1 | null {
  // 2026-09-28：多出来的成员不解释、不转发（从前多一个字段整条拒）；id 与信文照旧逐项校验，结果只用它们重建。
  if (!hasRequiredRecordKeys(value, ['schemaVersion', 'artifactId', 'text']) || value.schemaVersion !== 1) {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  if (
    artifactId === null ||
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    new TextEncoder().encode(value.text).length > MISSION_COVER_LETTER_MAX_TEXT_BYTES ||
    // eslint-disable-next-line no-control-regex -- the release fence rejects these exact control characters
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/u.test(value.text)
  ) {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, artifactId, text: value.text });
}

function parseTarget(value: unknown): CoverLetterAttachmentTargetV1 | null {
  const target = parseResumeAtsAttachmentTargetV1(value);
  return target === null
    ? null
    : Object.freeze({ canonicalOrigin: target.canonicalOrigin, jobId: target.jobId });
}

/**
 * Bounded plain text: only `\n` and `\t` among control characters, no bidirectional
 * override/isolate, well-formed UTF-16. A required field must hold a non-whitespace character.
 */
function isPageText(value: unknown, min: 0 | 1, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (min === 0 || value.trim().length > 0) &&
    // eslint-disable-next-line no-control-regex -- the page-job fence rejects these exact characters
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(value) &&
    isWellFormed(value)
  );
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isMember<const T extends readonly string[]>(value: unknown, members: T): value is T[number] {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * 答复里这一版不认识、但长得像闭集成员的值（2026-09-28）：大写字母开头，只含大写字母、数字与下划线。
 * 状态与岗位来源最长 32；失败码最长 64，与 client 收服务端错误码的口径一致（现有的码已有 33 个字符）。
 */
function isAnswerToken(value: unknown, maxLength: 32 | 64): value is string {
  return typeof value === 'string' && value.length <= maxLength && /^[A-Z][A-Z0-9_]*$/u.test(value);
}

/** 不认识的岗位来源读作 PAGE（见 `parseCoverLetterAttachmentLookupV1`）。 */
function answerJobSource(value: unknown): CoverLetterJobSource | null {
  if (isMember(value, COVER_LETTER_JOB_SOURCES)) return value;
  return isAnswerToken(value, 32) ? 'PAGE' : null;
}

/** 不认识的失败码读作笼统的 COVER_LETTER_UNAVAILABLE（见 `parseCoverLetterAttachmentPrepareResultV1`）。 */
function answerFailureCode(value: unknown): CoverLetterAttachmentFailureCode | null {
  if (isMember(value, COVER_LETTER_ATTACHMENT_FAILURE_CODES)) return value;
  return isAnswerToken(value, 64) ? 'COVER_LETTER_UNAVAILABLE' : null;
}

/**
 * 答复用（2026-09-28）：认得的键一个都不能少、都得是答复自己的；多出来的不拒——后端先发的加法从前让旧包
 * 整条停掉。调用方只用认得的字段重建结果，多出来的不解释、不转发。`__proto__`、`constructor`、`prototype`
 * 不是加法，一律拒。请求（插件发出去的东西）照旧用 `hasExactRecordKeys`。
 */
function hasRequiredRecordKeys(
  value: unknown,
  requiredKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
  );
}

function hasExactRecordKeys(
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

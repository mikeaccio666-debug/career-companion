/**
 * 这一页的岗位上下文（argoland `src/career-team/contracts/applicationPage.ts` 的拷贝）。
 *
 * 权威在 argoland（RULE-EXT-CONTRACT-CONSUMER）；本仓只跟版，不单方面改形状。
 *
 * 2026-09-18 实测：插件原来的「生成申请卡片」打的是
 * `POST /api/v1/agent/jobs/from-url`，那条路**在 argoland 里没有控制器**，
 * 生产 404，按钮按下去没有任何反应。而 `missions/page-context` 收的正是同一组
 * 输入（canonicalOrigin + pathname），返回的东西还更多：
 *
 *   canonicalJobId  → 建 mission 要它（没有 mission 就没有 Autofill）
 *   job.jobId       → 就是 catalogSelector，求职信那一问（cover-letter/requirement）要的正是它
 *   job.title/company → 申请卡片要显示的，比从页面 DOM 刮出来的可靠
 *
 * 所以改指它，而不是去补一条新端点。
 */

import { parseUuid, type Uuid } from './common.ts';

/** A browser-observed lookup key. It carries no job or execution authority. */
export interface ApplicationPageReference {
  readonly canonicalOrigin: string;
  readonly pathname: string;
}

export interface ApplicationPageJob {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
}

export interface CreateApplicationPageContextRequest extends ApplicationPageReference {
  readonly schemaVersion: 1;
  readonly clientRequestId: Uuid;
  readonly generationLocale: 'en-US' | 'zh-CN';
}

/** Context for explicit resume selection and the existing Mission create API. */
export interface CreateApplicationPageContextResponse {
  readonly schemaVersion: 1;
  readonly conversationId: Uuid;
  readonly canonicalJobId: Uuid;
  readonly job: ApplicationPageJob;
  readonly page: ApplicationPageReference;
}

export function parseApplicationPageReference(value: unknown): ApplicationPageReference | null {
  if (!exactRecord(value, ['canonicalOrigin', 'pathname'])) return null;
  const { canonicalOrigin, pathname } = value;
  if (
    typeof canonicalOrigin !== 'string' ||
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    (canonicalOrigin + pathname).length > 512
  )
    return null;
  try {
    const origin = new URL(canonicalOrigin);
    const page = new URL(canonicalOrigin + pathname);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== canonicalOrigin ||
      page.origin !== canonicalOrigin ||
      page.pathname !== pathname ||
      page.search ||
      page.hash ||
      /[\p{Cc}\p{Cs}\s]/u.test(canonicalOrigin + pathname)
    )
      return null;
    return Object.freeze({ canonicalOrigin, pathname });
  } catch {
    return null;
  }
}

export function parseCreateApplicationPageContextRequest(
  value: unknown,
): CreateApplicationPageContextRequest | null {
  if (
    !exactRecord(value, [
      'schemaVersion',
      'clientRequestId',
      'canonicalOrigin',
      'pathname',
      'generationLocale',
    ])
  )
    return null;
  const clientRequestId = parseUuid(value.clientRequestId);
  const page = parseApplicationPageReference({
    canonicalOrigin: value.canonicalOrigin,
    pathname: value.pathname,
  });
  if (
    value.schemaVersion !== 1 ||
    !clientRequestId ||
    !page ||
    !['en-US', 'zh-CN'].includes(value.generationLocale as string)
  )
    return null;
  return Object.freeze({
    schemaVersion: 1,
    clientRequestId,
    ...page,
    generationLocale: value.generationLocale as 'en-US' | 'zh-CN',
  });
}

export function parseCreateApplicationPageContextResponse(
  value: unknown,
): CreateApplicationPageContextResponse | null {
  if (!exactRecord(value, ['schemaVersion', 'conversationId', 'canonicalJobId', 'job', 'page']))
    return null;
  const conversationId = parseUuid(value.conversationId);
  const canonicalJobId = parseUuid(value.canonicalJobId);
  const page = parseApplicationPageReference(value.page);
  const job = parseApplicationPageJob(value.job);
  if (value.schemaVersion !== 1 || !conversationId || !canonicalJobId || !page || !job) return null;
  return Object.freeze({ schemaVersion: 1, conversationId, canonicalJobId, page, job });
}

export function parseApplicationPageJob(value: unknown): ApplicationPageJob | null {
  if (
    !exactRecord(value, ['jobId', 'title', 'company']) ||
    !boundedText(value.jobId, 512) ||
    !boundedText(value.title, 256) ||
    !boundedText(value.company, 256)
  )
    return null;
  return Object.freeze({ jobId: value.jobId, title: value.title, company: value.company });
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

import {
  APPLICATION_QUESTION_DRAFT_FAILURE_CODES,
  APPLICATION_QUESTION_DRAFT_LIMITS,
  parseCreateApplicationQuestionDraftsRequestV1,
  type ApplicationQuestionDraftJobV1,
  type ApplicationQuestionDraftQuestionV1,
  type ApplicationQuestionDraftV1,
} from '@edaix/contracts';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * AI 起草开放题（P3-13）：内容脚本说在哪一页、这一份岗位是什么、要起草哪几道题；凭据与 requestId
 * 都在 worker。用户点了面板上的「让 AI 起草」这条消息才会发——题目与岗位会上行到 EdAIX，按钮文案写明。
 */
export interface DockQuestionDraftIntent {
  readonly kind: 'dock/question-draft-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
  readonly job: ApplicationQuestionDraftJobV1;
  readonly questions: readonly ApplicationQuestionDraftQuestionV1[];
}

export type DockQuestionDraftFailureCode = 'AUTH_REQUIRED' | 'PAYWALL_REQUIRED' | 'QUOTA_EXCEEDED' | 'REJECTED' | 'UNAVAILABLE';

export type DockQuestionDraftReply =
  | Readonly<{ kind: 'QUESTION_DRAFTS'; drafts: readonly ApplicationQuestionDraftV1[] }>
  | Readonly<{ kind: 'REFUSED'; code: DockQuestionDraftFailureCode }>;

const KEYS = ['kind', 'version', 'origin', 'pathname', 'job', 'questions'] as const;
/** 契约解析器要一个 uuid；意图里没有（requestId 由 worker 铸），用一个固定占位过形状校验。 */
const PLACEHOLDER_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const FAILURE_CODES: readonly string[] = ['AUTH_REQUIRED', 'PAYWALL_REQUIRED', 'QUOTA_EXCEEDED', 'REJECTED', 'UNAVAILABLE'];

export function parseDockQuestionDraftIntent(value: unknown): DockQuestionDraftIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  // 精确键集：多一个字段就是一种我们没约定过的形状，而这条消息会走到一次带凭据、计配额的调用。
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/question-draft-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  const request = parseCreateApplicationQuestionDraftsRequestV1({
    schemaVersion: 1,
    requestId: PLACEHOLDER_REQUEST_ID,
    job: candidate.job,
    questions: candidate.questions,
  });
  if (request === null) return null;
  return Object.freeze({
    kind: 'dock/question-draft-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
    job: request.job,
    questions: request.questions,
  });
}

export function createDockQuestionDraftIntent(
  origin: string,
  pathname: string,
  job: ApplicationQuestionDraftJobV1,
  questions: readonly ApplicationQuestionDraftQuestionV1[],
): DockQuestionDraftIntent | null {
  return parseDockQuestionDraftIntent({
    kind: 'dock/question-draft-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    job,
    questions,
  });
}

/** 内容脚本解码 worker 的答复；草稿是要摆进面板的文字，逐条按上限校验。 */
export function parseDockQuestionDraftReply(value: unknown): DockQuestionDraftReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'REFUSED') {
    return typeof candidate.code === 'string' && FAILURE_CODES.includes(candidate.code)
      ? Object.freeze({ kind: 'REFUSED', code: candidate.code as DockQuestionDraftFailureCode })
      : null;
  }
  if (candidate.kind !== 'QUESTION_DRAFTS' || !Array.isArray(candidate.drafts)) return null;
  if (candidate.drafts.length > APPLICATION_QUESTION_DRAFT_LIMITS.questions) return null;
  const drafts: ApplicationQuestionDraftV1[] = [];
  for (const raw of candidate.drafts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.questionId !== 'string' || item.questionId === '' || item.questionId.length > 128) return null;
    if (typeof item.text !== 'string' || item.text.trim() === '' || item.text.length > APPLICATION_QUESTION_DRAFT_LIMITS.draftText) return null;
    drafts.push(Object.freeze({ questionId: item.questionId, text: item.text }));
  }
  return Object.freeze({ kind: 'QUESTION_DRAFTS', drafts: Object.freeze(drafts) });
}

export { APPLICATION_QUESTION_DRAFT_FAILURE_CODES };

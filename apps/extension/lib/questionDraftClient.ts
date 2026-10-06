import {
  createApplicationQuestionDrafts,
  parseCreateApplicationQuestionDraftsResponseV1,
  type ApplicationQuestionDraftV1,
  type CreateApplicationQuestionDraftsRequestV1,
} from '@edaix/contracts';
import type { DockQuestionDraftFailureCode } from './questionDraftIntent';

export type QuestionDraftResult =
  | Readonly<{ ok: true; value: readonly ApplicationQuestionDraftV1[] }>
  | Readonly<{ ok: false; code: DockQuestionDraftFailureCode }>;

export interface QuestionDraftClient {
  create(request: CreateApplicationQuestionDraftsRequestV1): Promise<QuestionDraftResult>;
}

/** 起草要等模型；比答案记忆的 8s 长，但仍然有界——超时是「没能起草」，不是挂着。 */
const DEFAULT_TIMEOUT_MS = 50_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * 与答案记忆客户端同一条边界：凭据只在 worker，401 刷新一次，402/403 是付费墙，429 是配额，
 * 其余非 200 一律 UNAVAILABLE；应答按契约解析，题目 id 对不上请求的整份不要。
 */
export function createQuestionDraftClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}>): QuestionDraftClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const failure = (code: DockQuestionDraftFailureCode): QuestionDraftResult => ({ ok: false, code });
  function request(body: unknown, token: string, signal: AbortSignal): Promise<Response> {
    return fetchFn(new URL(createApplicationQuestionDrafts.path, input.apiBase).toString(), {
      method: 'POST',
      cache: 'no-store',
      signal,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return Object.freeze({
    async create(draftRequest: CreateApplicationQuestionDraftsRequestV1): Promise<QuestionDraftResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let token = await input.getAccessToken();
        if (token === null || token === '') return failure('AUTH_REQUIRED');
        let response = await request(draftRequest, token, controller.signal);
        if (response.status === 401 && input.refreshAccessToken !== undefined) {
          token = await input.refreshAccessToken();
          if (token === null || token === '') return failure('AUTH_REQUIRED');
          response = await request(draftRequest, token, controller.signal);
        }
        if (response.status === 401) return failure('AUTH_REQUIRED');
        if (response.status === 402 || response.status === 403) return failure('PAYWALL_REQUIRED');
        if (response.status === 429) return failure('QUOTA_EXCEEDED');
        if (response.status !== 200) return failure('UNAVAILABLE');
        const raw = await response.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) return failure('UNAVAILABLE');
        let body: unknown;
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          return failure('UNAVAILABLE');
        }
        const parsed = parseCreateApplicationQuestionDraftsResponseV1(body, draftRequest);
        if (parsed === null) return failure('UNAVAILABLE');
        if (!parsed.ok) return failure('REJECTED');
        return { ok: true, value: parsed.drafts };
      } catch {
        return failure('UNAVAILABLE');
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

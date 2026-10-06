import {
  getCoverLetterRequirement,
  listResumeSelectionOptions,
  parseCoverLetterRequirementResultV1,
  parseListResumeSelectionOptionsResponseV1,
  type CoverLetterRequirementContextV1,
  type ListResumeSelectionOptionsResponseV1,
} from '@edaix/contracts';

/**
 * dock 走完一次申请要问后端的两件事（docs/DOCK-APPLY-FLOW.md ②③）：
 * **这次能用哪几份简历**，和**这个岗位要不要求职信**。
 *
 * ## 为什么不复用 assistant 那套
 *
 * `assistant/features/commerce/owner-commerce.ts` 已经在读同样两个端点，但那是
 * **staging 彩排包**专用的：`wxt.config.ts` 里 `ASSISTANT_READ_ENABLED` 要求
 * 显式指向一个非生产环境，指向生产直接抛 `ASSISTANT_READ_BUILD_REALM_INVALID`，
 * 商店包的 entrypoints 更是硬钉成 `['background', 'apply']`。dock 在商店包里，
 * 拿不到那条路。共用的是**契约与解码器**，不是传输。
 *
 * ## 失败一律显式，而且分档
 *
 * 与 `missionPageBindingClient` 那种「不是证明了的 yes 就是 no」不同，这里
 * 任何一档都不能塌缩成一个乐观默认值：
 *
 * - 简历读不到 ≠ 用户没有简历。前者该说「暂时读不到」，后者才该请他去上传。
 *   把前者显示成后者，等于当着一个上传过三版简历的人说他一份都没有。
 * - 求职信那一问读不到 ≠ 这个岗位不要求职信。塌缩成 NOT_REQUIRED 会让一份
 *   必须写求职信的申请直接走上 A 路，漏掉那一栏。
 *
 * 所以两个读都返回带稳定码的 Result（RULE-GLOBAL-ERROR-CONTRACT），由调用方
 * 决定怎么呈现和要不要重试。
 */

export type ApplyMaterialsFailureCode =
  /** 没有可用的登录态。下一步是让用户连接 ArgoLand。 */
  | 'AUTH_REQUIRED'
  /** 订阅闸挡下了。下一步在产品里，不在这一页。 */
  | 'PAYWALL_REQUIRED'
  /** 这个岗位后端不认识（求职信那一问才可能）。 */
  | 'JOB_NOT_FOUND'
  /** 网络、超时、非 200、body 解不出——都归这里。 */
  | 'UNAVAILABLE';

export type ApplyMaterialsResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: ApplyMaterialsFailureCode }>;

export interface ApplyMaterialsClient {
  /** 这次可以用哪几份简历。空清单是一个**成功**的答案：他确实还没有。 */
  listResumes(): Promise<ApplyMaterialsResult<ListResumeSelectionOptionsResponseV1>>;
  /**
   * 这个岗位要不要求职信。
   *
   * 成功时连同 canonical job 的那几个 revision 一起交出去：后续生成要原样带回，
   * 对不上后端答 `COVER_LETTER_JOB_STALE`。调用方不该自己去凑这几个值。
   */
  coverLetterRequirement(jobId: string): Promise<ApplyMaterialsResult<CoverLetterRequirementContextV1>>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function createApplyMaterialsClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}>): ApplyMaterialsClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  async function send(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
  ): Promise<ApplyMaterialsResult<unknown>> {
    let token = await input.getAccessToken();
    if (token === null || token === '') return failure('AUTH_REQUIRED');
    let response = await request(path, method, body, token);
    if (response.status === 401 && input.refreshAccessToken !== undefined) {
      token = await input.refreshAccessToken();
      if (token === null || token === '') return failure('AUTH_REQUIRED');
      response = await request(path, method, body, token);
    }
    if (response.status === 401) return failure('AUTH_REQUIRED');
    // 402/403 的产品含义不一样，但对这一幕是同一件事：下一步在产品里。
    // 归一成一个码，免得界面上多出一档它并不知道怎么说的文案。
    if (response.status === 402 || response.status === 403) return failure('PAYWALL_REQUIRED');
    if (response.status === 404) return failure('JOB_NOT_FOUND');
    if (response.status !== 200) return failure('UNAVAILABLE');
    return { ok: true, value: await safeJson(response) };
  }

  function request(path: string, method: 'GET' | 'POST', body: unknown, token: string): Promise<Response> {
    return fetchFn(new URL(path, input.apiBase).toString(), {
      method,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  return Object.freeze({
    async listResumes() {
      const read = await guard(send(listResumeSelectionOptions.path, 'GET', undefined), timeoutMs);
      if (!read.ok) return read;
      const parsed = parseListResumeSelectionOptionsResponseV1(read.value);
      // 解不出就是读不到。半份清单比没有清单危险：用户会以为那就是他的全部简历。
      return parsed === null ? failure('UNAVAILABLE') : { ok: true as const, value: parsed };
    },

    async coverLetterRequirement(jobId: string) {
      if (jobId === '') return failure('JOB_NOT_FOUND');
      const read = await guard(
        send(getCoverLetterRequirement.path, 'POST', { jobId }),
        timeoutMs,
      );
      if (!read.ok) return read;
      const parsed = parseCoverLetterRequirementResultV1(read.value);
      if (parsed === null) return failure('UNAVAILABLE');
      // 200 里带着 ok:false 的失败体：它答了，但答的是「给不出」。
      // 当成读不到，而不是当成 NOT_REQUIRED。
      return parsed.ok ? { ok: true as const, value: parsed.context } : failure('UNAVAILABLE');
    },
  });
}

function failure(code: ApplyMaterialsFailureCode): Readonly<{ ok: false; code: ApplyMaterialsFailureCode }> {
  return Object.freeze({ ok: false as const, code });
}

/**
 * 超时与抛错都收进 UNAVAILABLE。
 *
 * 超时**不能**当成一个答案：`missionPageBindingClient` 那边超时解析成 false 是
 * 对的（它问的是「能不能填」，不确定就不提供），这里问的是事实，不确定就得说
 * 不确定。
 */
async function guard(
  operation: Promise<ApplyMaterialsResult<unknown>>,
  timeoutMs: number,
): Promise<ApplyMaterialsResult<unknown>> {
  const timeout = new Promise<ApplyMaterialsResult<unknown>>((resolve) => {
    setTimeout(() => resolve(failure('UNAVAILABLE')), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return failure('UNAVAILABLE');
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

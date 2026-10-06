/**
 * 档案取数客户端（刀九；2026-08-15 按 §5.8 正式契约切片 e4191043 对齐）。
 *
 * GET /api/v1/agent/application-profile——Agent 填表链**唯一**的档案值
 * 读取面。三道绑定（全部以已验签 JWS 为准，缺一不可）：
 *  1. 请求 header `X-EdAIX-Profile-Field-Keys` = JWS fieldKeys（升序去重
 *     逗号相连，无 PII）——它选择 snapshotDigest 的摘要上下文；
 *  2. 响应 fieldSchemaVersion/fieldKeys 必须与 JWS 完全相等；
 *  3. 响应 revision/deletionEpoch/snapshotDigest 必须与 JWS profile 三元
 *     完全相等——**任一不符丢弃整份、停止填表（restart execution）**，
 *     禁止拿旧 Intent 自动重取/合并。这挡住"claim 后档案更新，旧值混进
 *     绑定旧 revision 的 Intent"。
 *
 * 响应的 profile 恒带齐我们认得的全部键（string|null）；即使校验全过，
 * 也只把 JWS fieldKeys 允许的值交给填表链。no-store：不缓存每 run 现取。
 *
 * 2026-09-21 改：**多出来的键忽略，不再整份拒收。** 键表随插件版本走，而后端
 * 一次纯加法（P1-5 档案键扩展）会同时到达所有装着旧版的插件；原来的 exact-shape
 * 会让那一刻起每一次自动填写都报 PROFILE_RESPONSE_MALFORMED——后端加一个键，
 * 把插件打死。忽略是安全的：陌生键的值从不进 draft（只按 fieldKeys 取），
 * 敏感键绊线照旧在前面拦。缺键、值不是 string|null 仍然整份拒收。
 */

import { APPLICATION_PROFILE_FIELD_KEYS, APPLICATION_PROFILE_FIELD_KEYS_HEADER } from '@edaix/contracts';
import type { HttpFailure } from './diagnosticsUploader';
import { httpFailureOf } from './httpFailure';
import type { ApplyProfileDraft } from '@edaix/apply-kernel/profileDraft';

export const PROFILE_CLIENT_DIAG_CODES = [
  'PROFILE_AUTH_UNAVAILABLE', // 未登录——上游按全字段 NO_VALUE 收口
  'PROFILE_FETCH_FAILED', // 网络/5xx
  'PROFILE_REJECTED', // 4xx（校验拒/无权限）
  'PROFILE_RESPONSE_MALFORMED',
  'PROFILE_BINDING_MISMATCH', // §5.8 三道绑定任一不符——停止填表等重签
  'PROFILE_SENSITIVE_SMUGGLED', // 响应携带敏感/EEO 类键——整份拒收（C-b 绊线）
  'PROFILE_UNKNOWN_KEYS_IGNORED', // 响应多带了本版本不认得的键——忽略之，只记一笔
  'PROFILE_FETCH_TIMEOUT', // 到点没答完（2026-10-04：从前没有时限，后端卡住时浮层一直转）
  'PROFILE_BUSY_RETRIED', // 503 AGENT_UNAVAILABLE（门户正在保存档案，argoland #710 的读锁）：等一下再读了一次
  'PROFILE_BUSY', // 再读一次还是在保存
] as const;

/** 取数绑定：全部来自已验签 JWS（经 ExecutionGrant 透传）。 */
export interface ProfileBinding {
  readonly fieldKeys: readonly string[];
  readonly fieldSchemaVersion: number;
  /**
   * 已验签 JWS 里那一份档案快照的身份；`null` = **没有可比对的那一份**。
   *
   * 绑 mission 那条路里它永远非空：比对存在的意义是「拿到的档案就是用户在
   * chat 里批准的那一份」。无 mission 那条路（浮层里按 Autofill，填自己的
   * 资料）没有那一步批准，也就没有东西可比——用 `null` 说出这件事，而不是
   * 拿一个假的快照去骗过比对，也不是给这道闸加一个布尔开关。
   *
   * 其余检查一条不少：偷带敏感键、未知键、非 string|null 照旧当场失败。
   */
  readonly profileSnapshot: {
    readonly revision: string;
    readonly deletionEpoch: string;
    readonly snapshotDigest: string;
  } | null;
}

export type ProfileFetchResult =
  | { readonly ok: true; readonly draft: ApplyProfileDraft }
  /**
   * stale=true：绑定失配（档案已变）——停止填表，重新走签发。
   * `reason`（2026-10-04）：说得出的两种——`TIMEOUT` 到点没答完；`BUSY` 门户正在保存档案（再读一次也还在保存）。
   * 缺省 = 别的失败（没登录、网络、4xx、形状不对）。
   */
  | { readonly ok: false; readonly stale: boolean; readonly reason?: 'TIMEOUT' | 'BUSY' };

export interface ProfileClientDeps {
  readonly apiBase: string;
  readonly getAccessToken: () => Promise<string | null>;
  /** 401 时强制换新一次再重试（authClient.forceRefresh）。 */
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
  /** 稳定码；HTTP 失败另带状态码与 x-request-id（只进上报，httpFailure.ts）。 */
  readonly onDiagnostic?: (code: string, detail?: Readonly<{ http: HttpFailure }>) => void;
  /** 每一次请求的时限（含读答复体），缺省 PROFILE_REQUEST_TIMEOUT_MS。 */
  readonly timeoutMs?: number;
  /** 等一会儿（503 AGENT_UNAVAILABLE 之后再读那一次之前）；测试注入。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** [0, 1) 的随机数（等多久的抖动）；测试注入。 */
  readonly random?: () => number;
}

/**
 * 每一次请求的时限（2026-10-04）。与资料目录那条传输同一个数：后端这几个接口平时 1–2 秒，门户正在保存时读锁最多再等
 * 2 秒（argoland #710），8 秒还没答完就是卡住了——照实说，不让浮层一直停在「正在对照你的资料」。
 */
export const PROFILE_REQUEST_TIMEOUT_MS = 8_000;
/** 503 AGENT_UNAVAILABLE 之后等多久再读一次：约 1 秒，±20% 抖动（别让同时撞上的几页一起再撞一次）。 */
const BUSY_RETRY_DELAY_MS = 1_000;

export interface ProfileProvider {
  getProfile(binding: ProfileBinding): Promise<ProfileFetchResult>;
}

const EXACT_PROFILE_KEYS: ReadonlySet<string> = new Set(APPLICATION_PROFILE_FIELD_KEYS);

/** 敏感/EEO 类键黑名单（别名从宽）——exact-shape 之上的纵深绊线（C-b）。 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'gender', 'sex', 'race', 'ethnicity', 'veteran', 'veteranStatus',
  'disability', 'disabilityStatus', 'lgbtq', 'sexualOrientation',
  'transgender', 'pronouns', 'eeo', 'eeoAnswers', 'selfIdentification',
]);

const sameStringArray = (a: readonly string[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function createProfileProvider(deps: ProfileClientDeps): ProfileProvider {
  const fetchFn = deps.fetchFn ?? fetch;
  const diag = (code: string, detail?: Readonly<{ http: HttpFailure }>) => (detail === undefined ? deps.onDiagnostic?.(code) : deps.onDiagnostic?.(code, detail));
  const fail = (stale = false, reason?: 'TIMEOUT' | 'BUSY'): ProfileFetchResult =>
    (reason === undefined ? { ok: false, stale } : { ok: false, stale, reason });
  const timeoutMs = deps.timeoutMs ?? PROFILE_REQUEST_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = deps.random ?? Math.random;
  /** 答复体里的错误码（argoland 的错误信封顶层就是 `code`）；读不出就是 null。 */
  const errorCode = async (response: Response): Promise<unknown> => {
    try {
      return ((await response.json()) as { code?: unknown } | null)?.code ?? null;
    } catch {
      return null;
    }
  };

  return {
    async getProfile(binding) {
      let token: string | null;
      try {
        token = await deps.getAccessToken();
      } catch {
        token = null;
      }
      if (token === null) {
        diag('PROFILE_AUTH_UNAVAILABLE');
        return fail();
      }

      // header value 直接取自已验签 JWS fieldKeys（验签层已保证升序去重）。
      const headerValue = binding.fieldKeys.join(',');
      // 每一次请求各有时限（读答复体也算在里面：信号一断，体也读不下去）。
      let signal: AbortSignal | null = null;
      const timedOut = (): boolean => signal?.aborted === true;
      const doFetch = (bearer: string) => {
        signal = AbortSignal.timeout(timeoutMs);
        return fetchFn(new URL('/api/v1/agent/application-profile', deps.apiBase).toString(), {
          method: 'GET',
          headers: {
            authorization: `Bearer ${bearer}`,
            [APPLICATION_PROFILE_FIELD_KEYS_HEADER]: headerValue,
          },
          signal,
        });
      };

      let response: Response;
      try {
        let bearer = token;
        response = await doFetch(bearer);
        // 401 看码分流（§2.2 警告）：仅 LOGIN_REQUIRED 换新重放。
        if (response.status === 401 && deps.refreshAccessToken) {
          let body: unknown = null;
          try {
            body = await response.json();
          } catch {
            // 非 JSON 401 → 不换新。
          }
          if ((body as { code?: unknown } | null)?.code === 'LOGIN_REQUIRED') {
            const renewed = await deps.refreshAccessToken();
            if (renewed !== null) {
              bearer = renewed;
              response = await doFetch(bearer);
            }
          } else {
            response = { ok: false, status: 401, json: async () => body } as Response;
          }
        }
        // 门户正在保存档案（argoland #710：执行侧读档案等共享锁最多 2 秒，等不到答可重试的 503 AGENT_UNAVAILABLE）：
        // 等约 1 秒再读一次——保存最长约 2.4 秒，第一次本来就在服务端等过 2 秒。还是在保存就照实说，不再重试。
        if (response.status === 503 && (await errorCode(response)) === 'AGENT_UNAVAILABLE') {
          diag('PROFILE_BUSY_RETRIED');
          await sleep(Math.round(BUSY_RETRY_DELAY_MS * (0.8 + 0.4 * random())));
          response = await doFetch(bearer);
          if (response.status === 503 && (await errorCode(response)) === 'AGENT_UNAVAILABLE') {
            diag('PROFILE_BUSY');
            return fail(false, 'BUSY');
          }
        }
      } catch {
        if (timedOut()) {
          diag('PROFILE_FETCH_TIMEOUT');
          return fail(false, 'TIMEOUT');
        }
        diag('PROFILE_FETCH_FAILED');
        return fail();
      }
      if (!response.ok) {
        diag(response.status >= 400 && response.status < 500 ? 'PROFILE_REJECTED' : 'PROFILE_FETCH_FAILED', { http: httpFailureOf(response) });
        return fail();
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // 读答复体时到了点：照实说超时，不说形状不对。
        if (timedOut()) {
          diag('PROFILE_FETCH_TIMEOUT');
          return fail(false, 'TIMEOUT');
        }
        body = null;
      }
      if (typeof body !== 'object' || body === null) {
        diag('PROFILE_RESPONSE_MALFORMED');
        return fail();
      }
      const envelope = body as Record<string, unknown>;
      if (envelope['schemaVersion'] !== 1) {
        diag('PROFILE_RESPONSE_MALFORMED');
        return fail();
      }

      // §5.8 绑定校验第 2/3 道：与已验签 JWS 完全相等，不等即停。
      //
      // `binding.snapshot === null` 是**无 mission 那条路**（用户在我们浮层里
      // 按 Autofill，填他自己的资料）：那里没有 chat 批准过的那一份档案，也就
      // 没有可比对的东西——他要的就是他此刻的档案。下面的形状检查一条不少：
      // 偷带敏感键、未知键、非 string|null 照旧当场失败。
      const responseFieldKeys = envelope['fieldKeys'];
      if (
        envelope['fieldSchemaVersion'] !== binding.fieldSchemaVersion ||
        !Array.isArray(responseFieldKeys) ||
        !sameStringArray(binding.fieldKeys, responseFieldKeys)
      ) {
        diag('PROFILE_BINDING_MISMATCH');
        return fail(true);
      }
      const snapshot = binding.profileSnapshot;
      if (
        snapshot !== null && (
          envelope['revision'] !== snapshot.revision ||
          envelope['deletionEpoch'] !== snapshot.deletionEpoch ||
          envelope['snapshotDigest'] !== snapshot.snapshotDigest
        )
      ) {
        diag('PROFILE_BINDING_MISMATCH');
        return fail(true);
      }

      const rawProfile = envelope['profile'];
      if (typeof rawProfile !== 'object' || rawProfile === null || Array.isArray(rawProfile)) {
        diag('PROFILE_RESPONSE_MALFORMED');
        return fail();
      }
      const profileRecord = rawProfile as Record<string, unknown>;
      // 恒带齐我们认得的键、值 string|null；多出来的键忽略（见头注），敏感键先拦。
      let unknownKeys = 0;
      for (const key of Object.keys(profileRecord)) {
        if (SENSITIVE_KEYS.has(key)) {
          diag('PROFILE_SENSITIVE_SMUGGLED');
          return fail();
        }
        if (!EXACT_PROFILE_KEYS.has(key)) unknownKeys += 1;
      }
      if (unknownKeys > 0) diag('PROFILE_UNKNOWN_KEYS_IGNORED');
      for (const key of EXACT_PROFILE_KEYS) {
        const value = profileRecord[key];
        if (value !== null && typeof value !== 'string') {
          diag('PROFILE_RESPONSE_MALFORMED');
          return fail();
        }
        if (!(key in profileRecord)) {
          diag('PROFILE_RESPONSE_MALFORMED');
          return fail();
        }
      }

      // 校验全过后，也只把 JWS fieldKeys 允许的值交给填表链（§5.8 末条）。
      const draft: Record<string, string> = {};
      for (const key of binding.fieldKeys) {
        const value = profileRecord[key];
        if (typeof value === 'string' && value !== '') draft[key] = value;
      }
      return { ok: true, draft: draft as ApplyProfileDraft };
    },
  };
}

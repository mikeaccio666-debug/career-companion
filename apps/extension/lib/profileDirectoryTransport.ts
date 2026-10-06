/**
 * The worker half of the standing profile directory: it holds the token, and
 * that is the whole reason it exists.
 *
 * The panel that shows a user their saved details runs in the page's content
 * script, which must never hold an access token. So the request is made here
 * and the answer is handed back. What is *not* here is the checking: the four
 * response shapes are verified by `profileDirectoryClient.ts`, in the bundle
 * that consumes them. That is not a size concession — the values are on their
 * way to the panel either way, and a check belongs where the value is used —
 * but it is worth being exact about why the split is safe here and would not be
 * safe for the fill chain. `profileClient.ts` keeps its checking in the worker
 * because a smuggled value on that path gets written into a real employer's
 * form. Nothing here is ever written to a host page; the panel only displays it.
 *
 * This module names operations, never URLs. A caller asks for
 * `PERSONAL_READ`, not for a path, so a content script that has been taken over
 * still cannot aim this worker's bearer token at an address of its choosing.
 * Adding a reachable endpoint has to happen here, in reviewed code.
 */

import { httpFailureOf } from './httpFailure';

/** Every request the panel is allowed to ask the worker to make. */
export const PROFILE_DIRECTORY_OPERATIONS = [
  'PERSONAL_READ', 'PERSONAL_SAVE',
  'WORK_AUTHORIZATION_READ', 'WORK_AUTHORIZATION_SAVE',
  'EEO_READ', 'EEO_SAVE',
  'PREFERENCES_READ', 'PREFERENCES_SAVE',
  // 2026-09-16: the owner's full Profile V2 -- the one door argoland.ai actually
  // serves today. The directory channels above are still the contract's, but
  // production answers 404 to every one of them, so the dock reads and writes
  // the basic facts through V2 and shows the rest read-only.
  'PROFILE_V2_READ', 'PROFILE_V2_SAVE',
  // 2026-09-23：资料页那一格「代填条款、声明与签名」的同意。起初插件只读；同一天负责人要求资料能在
  // 插件里直接改，于是插件的资料编辑器也能同意与撤回（与门户同一对端点）。
  'SIGNING_CONSENT_READ', 'SIGNING_CONSENT_GRANT', 'SIGNING_CONSENT_REVOKE',
  // 资料编辑器里的「默认简历」：读简历库、把某一条设为默认（带库的 revision 做乐观锁）。
  'RESUME_LIBRARY_READ', 'RESUME_DEFAULT_SET',
] as const;
export type ProfileDirectoryOperation = (typeof PROFILE_DIRECTORY_OPERATIONS)[number];

declare const directoryResponseTextBrand: unique symbol;
/**
 * An answer that has not been checked yet, carried as text on purpose.
 *
 * Text has no fields, so no caller can read a value off it by accident; the
 * only way forward is through the client's parser. A deliberate `JSON.parse`
 * elsewhere would still be possible, and is exactly what a reviewer — and the
 * panel side's own test — should refuse.
 */
export type DirectoryResponseText = string & {
  readonly [directoryResponseTextBrand]: 'DirectoryResponseText';
};

export type ProfileDirectoryTransportCode =
  /** No API origin configured — the required default-off state. */
  | 'DISABLED'
  | 'LOGIN_REQUIRED'
  | 'UNAVAILABLE'
  /** Someone else saved first; re-read the section and let the user redecide. */
  | 'STALE'
  /**
   * worker 认不出提问的这一页，所以它不回答。
   *
   * 那道闸是对的：只有在 hello 时登记过、且此刻 URL 与登记的逐字相等的那一页
   * 才问得动用户的档案。缺的是**它拒绝时说一声**——从前它 `return undefined`，
   * 面板收到 undefined、在 `openedV2` 里读 `.ok` 抛 TypeError、被一个 catch 兜住，
   * 于是画出「暂时无法读取完整资料，请稍后刷新」。
   *
   * 那句话是错的，而且错得有代价：真正该做的是刷新这一页（重新报到），
   * 不是等一会儿再试。2026-09-18 实测：本机 API 一次请求都没收到过，
   * 面板却让用户「稍后刷新」。
   */
  | 'PAGE_NOT_REGISTERED'
  /** 答复超过了大小上限（MAX_RESPONSE_BYTES）；与服务器答不上来分开说（2026-09-27）。 */
  | 'RESPONSE_TOO_LARGE'
  /** 到点（TIMEOUT_MS）没答完（2026-10-04）：与服务器答不上来分开说——存的那一下可能已经落了，也可能没有。 */
  | 'TIMEOUT'
  /**
   * 门户正在保存档案（2026-10-04）：argoland #710 的档案锁等不到，答可重试的 503 AGENT_UNAVAILABLE；等约 1 秒再试一次
   * 还是这样才交回这个码。
   */
  | 'BUSY'
  /** 写的这一份是上一个人的（2026-10-04）：worker 此刻登录的已经换了人，一个字都没写。 */
  | 'SESSION_CHANGED'
  /**
   * 问出去了，但没有任何回答回来。
   *
   * 与上面那条分开：这条说的是通道本身（worker 睡着了、消息丢了），
   * 而不是「worker 听见了、拒绝了」。RULE-GLOBAL-ERROR-CONTRACT：
   * 跨边界的失败要有名字，不能靠 `undefined` 顺着类型断言混进结果里。
   */
  | 'NO_REPLY';

export type ProfileDirectoryTransportResult =
  | Readonly<{ ok: true; text: DirectoryResponseText }>
  /**
   * `status`：非 2xx 答复的 HTTP 状态码；`requestId`：服务端回的 x-request-id。两样都只进诊断（UNAVAILABLE 一个词分不清
   * 404 与 5xx；请求号在 Loki 里对得上那一次请求，2026-10-04 体检 11-3）。
   */
  | Readonly<{ ok: false; code: ProfileDirectoryTransportCode; status?: number; requestId?: string }>;

export interface ProfileDirectoryTransport {
  readonly run: (
    operation: ProfileDirectoryOperation,
    body?: unknown,
  ) => Promise<ProfileDirectoryTransportResult>;
}

export interface ProfileDirectoryTransportInput {
  /** Null is the required default-off state. */
  readonly apiBase: string | null;
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
  /** 每一次请求的时限，缺省 TIMEOUT_MS；测试注入。 */
  readonly timeoutMs?: number;
  /** 等一会儿（503 AGENT_UNAVAILABLE 之后再试那一次之前）；测试注入。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** [0, 1) 的随机数（等多久的抖动）；测试注入。 */
  readonly random?: () => number;
}

/**
 * The path and verb behind each operation. Contracts stays the authority:
 * `profile-directory-transport.test.ts` compares every entry against
 * `OWNER_PROFILE_V2_ENDPOINTS` and fails if either side moves. Reading that
 * table at runtime instead would cost this worker 22KB of definitions for
 * endpoints it never calls, against a budget with about 4KB to spare.
 */
const ROUTES: Readonly<Record<ProfileDirectoryOperation, readonly [string, string]>> = Object.freeze({
  PERSONAL_READ: ['GET', '/users/me/profile-directory/personal'],
  PERSONAL_SAVE: ['PATCH', '/users/me/profile-directory/personal'],
  WORK_AUTHORIZATION_READ: ['GET', '/users/me/profile-directory/work-authorization'],
  WORK_AUTHORIZATION_SAVE: ['PATCH', '/users/me/profile-directory/work-authorization'],
  // EEO 在 argoland 只有 agent 路由（`@Controller('api/v1/agent/eeo-self-identification')`）；
  // 从前写成 /users/me/… 在生产上一直 404（2026-09-21 测试台实测 EEO_ANSWERS_FETCH_FAILED）。
  EEO_READ: ['GET', '/api/v1/agent/eeo-self-identification'],
  EEO_SAVE: ['PATCH', '/api/v1/agent/eeo-self-identification'],
  PREFERENCES_READ: ['GET', '/users/me/profile-directory/preferences'],
  PREFERENCES_SAVE: ['PATCH', '/users/me/profile-directory/preferences'],
  PROFILE_V2_READ: ['GET', '/users/me/application-profile'],
  PROFILE_V2_SAVE: ['PATCH', '/users/me/application-profile'],
  SIGNING_CONSENT_READ: ['GET', '/api/v1/agent/consents/application-signing'],
  SIGNING_CONSENT_GRANT: ['POST', '/api/v1/agent/consents/application-signing'],
  SIGNING_CONSENT_REVOKE: ['DELETE', '/api/v1/agent/consents/application-signing'],
  RESUME_LIBRARY_READ: ['GET', '/api/v1/agent/resume-library'],
  // `:trackId` 只从请求体里那个校验过的 UUID 换进来；路径的其余部分仍是这里写死的。
  RESUME_DEFAULT_SET: ['POST', '/api/v1/agent/resume-library/tracks/:trackId/default'],
});

export const PROFILE_DIRECTORY_ROUTES = ROUTES;

/**
 * 答复的大小上限跟着契约的容量走（2026-09-27）。从前是 128 KB：负责人一个简历导入的新账号（104 条技能、8 个项目、
 * 6 段教育与经历）完整档案 144,659 字节，worker 把一次正常的 200 丢掉，资料编辑器「暂时读不到你的资料」，填写时
 * 经历与教育也一起读不出来。契约允许 120 条技能、24 段经历、40 个项目（描述各 12,000 字）、100 条成就……整份最多
 * 3 MB 多，这里取 4 MiB。仍是一道上限：超了照实说 RESPONSE_TOO_LARGE，不混进 UNAVAILABLE。
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
/** 503 AGENT_UNAVAILABLE 之后等多久再试：约 1 秒，±20% 抖动（argoland 的保存最长约 2.4 秒，第一次本来就在服务端等过 2 秒）。 */
const BUSY_RETRY_DELAY_MS = 1_000;

export function createProfileDirectoryTransport(
  input: ProfileDirectoryTransportInput,
): ProfileDirectoryTransport {
  const origin = resolveOrigin(input.apiBase);
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = input.random ?? Math.random;

  const transport: ProfileDirectoryTransport = {
    async run(operation, body) {
      const route = ROUTES[operation];
      // An operation with no route behind it is not a request we know how to
      // authorise, so nothing is sent and no token is spent on it.
      if (route === undefined) return { ok: false, code: 'UNAVAILABLE' };
      if (origin === null) return { ok: false, code: 'DISABLED' };
      const [method, template] = route;
      // 唯一带路径参数的一条：把请求体里的 trackId 换进路径，发出去的体只剩 expectedLibraryRevision。
      // trackId 必须是 UUID、revision 必须是十进制数——否则一个请求都不发。
      let path = template;
      if (template.includes(':trackId')) {
        const record = body as { trackId?: unknown; expectedLibraryRevision?: unknown } | null | undefined;
        const trackId = record?.trackId;
        const revision = record?.expectedLibraryRevision;
        if (typeof trackId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(trackId)
          || typeof revision !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/u.test(revision)) {
          return { ok: false, code: 'UNAVAILABLE' };
        }
        path = template.replace(':trackId', trackId);
        body = { expectedLibraryRevision: revision };
      }

      // 每一次请求各有时限（读答复体也算在里面）；到点了与别的失败分开说（TIMEOUT）。
      let signal: AbortSignal | null = null;
      const send = (token: string): Promise<Response> => {
        signal = AbortSignal.timeout(timeoutMs);
        return fetchFn(new URL(path, origin).toString(), {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal,
        });
      };
      /**
       * 门户正在保存档案：503，错误信封里的码是 AGENT_UNAVAILABLE（只在 503 时读答复体）。这一半照旧不把答复变成对象
       * （见头注与 directory-parse-boundary 那道闸）：只在一小段错误文本里找那一个稳定码，什么值都不往外交。
       */
      const busy = async (response: Response): Promise<boolean> => {
        if (response.status !== 503) return false;
        try {
          return /"code"\s*:\s*"AGENT_UNAVAILABLE"/u.test((await response.text()).slice(0, 4096));
        } catch {
          return false;
        }
      };

      try {
        let token = await input.getAccessToken();
        if (!token) return { ok: false, code: 'LOGIN_REQUIRED' };
        let response = await send(token);
        if (response.status === 401 && input.refreshAccessToken) {
          token = await input.refreshAccessToken();
          if (!token) return { ok: false, code: 'LOGIN_REQUIRED' };
          response = await send(token);
        }
        if (response.status === 401) return { ok: false, code: 'LOGIN_REQUIRED' };
        // 门户正在保存档案（argoland #710）：等约 1 秒再试一次，还是这样就照实说。存（PATCH）等锁失败时什么都没写，
        // 再试一次是安全的；就算写了，expectedRevision 会让第二次答 412。
        if (await busy(response)) {
          await sleep(Math.round(BUSY_RETRY_DELAY_MS * (0.8 + 0.4 * random())));
          response = await send(token);
          if (await busy(response)) return { ok: false, code: 'BUSY' };
        }
        // 412/409 is the optimistic-concurrency fence: another surface saved
        // between this panel's read and its save. Nothing is retried over them.
        if (response.status === 412 || response.status === 409) return { ok: false, code: 'STALE' };
        if (!response.ok || !isJson(response.headers.get('content-type'))) {
          const { requestId } = httpFailureOf(response);
          return { ok: false, code: 'UNAVAILABLE', status: response.status, ...(requestId === undefined ? {} : { requestId }) };
        }
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
          return { ok: false, code: 'RESPONSE_TOO_LARGE' };
        }
        return { ok: true, text: text as DirectoryResponseText };
      } catch {
        return { ok: false, code: (signal as AbortSignal | null)?.aborted === true ? 'TIMEOUT' : 'UNAVAILABLE' };
      }
    },
  };
  return Object.freeze(transport);
}

function isJson(contentType: string | null): boolean {
  return contentType !== null
    && contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/** Only an absolute http(s) origin is usable; anything else stays default-off. */
function resolveOrigin(apiBase: string | null): string | null {
  if (apiBase === null || apiBase === '') return null;
  try {
    const url = new URL(apiBase);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

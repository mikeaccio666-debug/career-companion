/**
 * 扩展侧登录态客户端（刀八，T22 扩展半；2026-08-14 审计修复批重写）。
 *
 * 登录态怎么进扩展（契约 §2.3 扩展绑定交接）：
 *  1. 扩展生成一次性 state（≥128 bit 随机）交给已登录的门户页；
 *  2. 门户页以自己的 web 会话调 POST /auth/extension-handoffs 换一张
 *     短时效、一次性的交接码；
 *  3. 门户把码递回扩展，扩展拿 码+state 调 redeem（public 端点）换
 *     ExtensionTokenPair——从此扩展独立持有登录态；
 *  4. 兑换成功登记本安装（POST /api/v1/agent/extension-installs，幂等可重放）。
 *     注意前缀：裸 `/extension/installs` 是 Vibe ID 自己的安装登记，另一个
 *     产品、另一张表；写进去不会报错，但 Career Team 这边永远认不到。
 *
 * 存储分层（契约 §2.2）：**refresh token + userId 持久化**（storage.local，
 * 扩展隔离区）；**access token 只活在 SW 内存**——SW 冷启动用一次轮转换新。
 *
 * 轮转纪律（§2.1/§2.2，审计 [1][2][5]）：refresh token 一次性轮转，且
 * **旧 token 复用会撤销该用户全部会话**（含 web 端）。因此：
 *  - 刷新单飞（并发共享 in-flight）；
 *  - 发起前落"结局不明"日志位（journal），成功/确定失败才清——SW 在
 *    "服务端已轮转、本地未落盘"窗口死亡后绝不重放旧 token（宁可牺牲
 *    本会话保住用户其他会话）；
 *  - 任意 post-dispatch 5xx/429/断网都可能发生在网关超时但后端已 commit
 *    之后，必须保留 journal、绝不重放；4xx = 会话不可恢复 → 清空；内存里
 *    未到期的 access token 用到真到期，之后清空等新交接。
 *    （transport 歧义的根治 = 后端给 rotation 幂等宽限——对齐清单⑧。）
 *  - logout 用会话纪元防"在途刷新落盘复活"。
 *
 * 凭证纪律（铁律 1）：token 只活在扩展 storage/内存；诊断只出稳定码。
 */

import {
  AUTH_USER_ROLES,
  parseAttestExtensionInstallResponse,
  parseUuid,
  type AttestExtensionInstallRequest,
  type ExtensionTokenPair,
  type AuthServerRefreshRequest,
  type AuthServerLogoutRequest,
  type LinkExtensionInstallRequest,
  type LinkExtensionInstallResponse,
  type RedeemExtensionHandoffRequest,
  type Uuid,
} from '@edaix/contracts';
import type { ExtensionConnectionReadinessState } from '@edaix/contracts/draft';

export const AUTH_CLIENT_DIAG_CODES = [
  'AUTH_REDEEM_FAILED', // 交接码兑换失败（过期/已用/state 不符/网络）
  'AUTH_REFRESH_FAILED', // 会话不可恢复（4xx/结局不明弃用/旧日志位残留）——已清空
  'AUTH_REFRESH_TRANSPORT', // post-dispatch 结局不明——保 tombstone、绝不重放
  'AUTH_INSTALL_LINK_FAILED', // install 登记失败（不阻塞登录态；只允许显式 owner-gated 重试）
  'AUTH_INSTALL_ATTESTATION_FAILED', // fresh owner/install 只读证明失败
  'AUTH_LOGOUT_NOTIFY_FAILED', // 本地已清空，但后端作废通知没送达
  'AUTH_RESPONSE_MALFORMED',
  'AUTH_STORAGE_UNAVAILABLE',
  'AUTH_INVALIDATION_OBSERVER_FAILED',
  'AUTH_EXP_UNPARSEABLE', // access token 的 exp 解不出——用保守本地 TTL
] as const;

/** 注入的键值存储（真实现 = browser.storage.local；测试用内存表）。 */
export interface AuthKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface AuthClientDeps {
  /** Value-free notification before a session transition; observers must not throw. */
  readonly onSessionInvalidated?: () => void;
  readonly apiBase: string;
  readonly store: AuthKeyValueStore;
  readonly fetchFn?: typeof fetch;
  /** Unix 秒。 */
  readonly now?: () => number;
  readonly onDiagnostic?: (code: string) => void;
  /**
   * 提前轮换的登记：拿到一枚 access token 就告诉调用方「到期前 120s 把我叫醒」。
   *
   * MV3 的 worker 随时被杀。不主动叫醒，第一次轮换几乎必然发生在某次冷启动里——
   * 而 worker 死在「服务端已轮换、客户端未落盘」之间，就是会话 15 分钟必死的那条路
   * （2026-09-18 实测：批测 08:53 开跑，09:08 起浮层全说「未连接」）。
   * 调用方用 chrome.alarms 实现；这里只报时间，不碰浏览器 API，好让它可测。
   */
  readonly scheduleRotation?: (whenUnixSeconds: number) => void;
  /**
   * Logout cleanup receives only the currently valid in-memory bearer. The
   * caller may bind it to one deletion-only transport; public token methods
   * stay fenced for the full logout promise.
   */
  readonly onBeforeLogout?: (accessToken: string | null) => Promise<void>;
}

export interface AuthClient {
  /** 有效 access token；无会话/续期不可行 → null（fail-closed）。 */
  getAccessToken(): Promise<string | null>;
  /** 强制换新一次（401 重试路径用；共享单飞）。 */
  forceRefresh(): Promise<string | null>;
  /** 当前登录用户 id（验签 sub 必查的期望值）；无会话 → null。 */
  getUserId(): Promise<string | null>;
  /** 本安装稳定 UUID（首次调用生成并持久化；存储坏时进程内恒定）。 */
  getInstallId(): Promise<string>;
  /** 显式补登记入口；不得在 worker startup 无 owner fence 自动调用。 */
  ensureInstallLinked(): Promise<boolean>;
  /**
   * Fresh owner/install attestation for a Portal connection handshake. Never
   * trusts the persisted linked marker: it requires a new exact API status
   * read. An owner mismatch is rejected before refresh or API traffic.
   */
  attestInstallLinked(
    expectedOwnerId: Uuid,
  ): Promise<Readonly<{ userId: Uuid; installId: Uuid }> | null>;
  /** Closed projection for the external-port capability handshake. */
  readConnectionReadiness(
    expectedOwnerId: string,
  ): Promise<ExtensionConnectionReadinessState>;
  /** §2.3 兑换交接码；只有登录态与 install 登记都成功才返回 true。 */
  redeemHandoff(input: { code: string; state: string; extensionId: string }): Promise<boolean>;
  /** 清空本地会话（并尽力通知后端作废 refresh token）。 */
  logout(): Promise<void>;
}

const SESSION_KEY = 'authSession'; // 持久层：{ refreshToken, userId }
const INSTALL_ID_KEY = 'extensionInstallId';
const INSTALL_LINKED_KEY = 'extensionInstallLinked';
const ROTATION_JOURNAL_KEY = 'authRotationInFlight'; // 轮转"结局不明"日志位
/** access token 到期前提前续期的窗口（秒）。 */
const REFRESH_SKEW_SECONDS = 60;
/** 提前轮换：到期前这么多秒叫醒 worker。要大于 REFRESH_SKEW_SECONDS，否则醒了也不换。 */
const ROTATION_LEAD_SECONDS = 120;
/** 所有 credential-bearing POST 的硬超时；hung fetch 不得永久占住会话队列。 */
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
/** Auth JSON responses are tiny; cap bytes before decoding untrusted transport. */
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const AUTH_JSON_MAX_DEPTH = 128;
const AUTH_JSON_MAX_NODES = 20_000;
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
/** exp 解析失败时的保守本地 TTL（秒）。必须明显大于续期提前窗，否则
 *  每次取 token 都触发轮转（refresh token 高频空转）。 */
const UNPARSEABLE_EXP_TTL_SECONDS = 300;

interface PersistedSession {
  readonly refreshToken: string;
  readonly userId: string;
}

interface MemoryAccess {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly userId: string;
}

interface AuthPostResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_AUTH_RESPONSE_BYTES) {
      throw new Error('AUTH_RESPONSE_TOO_LARGE');
    }
  }

  let source: string;
  // Unit-test transports and older fetch shims may not expose a ReadableStream.
  // Require raw text so duplicate members can still be rejected before parse.
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (typeof response.text !== 'function') throw new Error('AUTH_RESPONSE_UNSCANNABLE');
    source = await response.text();
    if (new TextEncoder().encode(source).byteLength > MAX_AUTH_RESPONSE_BYTES) {
      throw new Error('AUTH_RESPONSE_TOO_LARGE');
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_AUTH_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error('AUTH_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (source.length === 0) return null;
  if (!scanStrictJson(source)) throw new Error('AUTH_RESPONSE_INVALID_JSON');
  return JSON.parse(source);
}

/** Browser-safe pre-parser: JSON.parse alone silently accepts last-key-wins objects. */
function scanStrictJson(source: string): boolean {
  let offset = 0;
  let nodes = 0;

  const skipWhitespace = (): void => {
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      offset += 1;
    }
  };

  const parseString = (capture: boolean): string | undefined => {
    if (source[offset] !== '"') throw new Error('INVALID_JSON');
    offset += 1;
    let captured = '';
    const append = (value: string): void => {
      if (capture) captured += value;
    };
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return captured;
      }
      if (code <= 0x1f) throw new Error('INVALID_JSON');
      if (code === 0x5c) {
        offset += 1;
        const escape = source[offset];
        if (escape === 'u') {
          const hex = source.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('INVALID_JSON');
          append(String.fromCharCode(Number.parseInt(hex, 16)));
          offset += 5;
          continue;
        }
        const decoded = decodeJsonEscape(escape);
        if (decoded === null) throw new Error('INVALID_JSON');
        append(decoded);
        offset += 1;
        continue;
      }
      append(source[offset] ?? '');
      offset += 1;
    }
    throw new Error('INVALID_JSON');
  };

  const parseNumber = (): void => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (!match) throw new Error('INVALID_JSON');
    offset += match[0].length;
  };

  const parseValue = (depth: number): void => {
    nodes += 1;
    if (nodes > AUTH_JSON_MAX_NODES || depth > AUTH_JSON_MAX_DEPTH) {
      throw new Error('INVALID_JSON');
    }
    skipWhitespace();
    const character = source[offset];
    if (character === '"') {
      parseString(false);
      return;
    }
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const seen = new Set<string>();
      if (source[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const key = parseString(true);
        if (key === undefined || DANGEROUS_JSON_KEYS.has(key) || seen.has(key)) {
          throw new Error('INVALID_JSON');
        }
        seen.add(key);
        skipWhitespace();
        if (source[offset] !== ':') throw new Error('INVALID_JSON');
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return;
        }
        if (source[offset] !== ',') throw new Error('INVALID_JSON');
        offset += 1;
        skipWhitespace();
      }
      throw new Error('INVALID_JSON');
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      if (source[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === ']') {
          offset += 1;
          return;
        }
        if (source[offset] !== ',') throw new Error('INVALID_JSON');
        offset += 1;
      }
      throw new Error('INVALID_JSON');
    }
    if (source.startsWith('true', offset)) {
      offset += 4;
      return;
    }
    if (source.startsWith('false', offset)) {
      offset += 5;
      return;
    }
    if (source.startsWith('null', offset)) {
      offset += 4;
      return;
    }
    parseNumber();
  };

  try {
    skipWhitespace();
    parseValue(0);
    skipWhitespace();
    return offset === source.length;
  } catch {
    return false;
  }
}

function decodeJsonEscape(value: string | undefined): string | null {
  switch (value) {
    case '"':
    case '\\':
    case '/':
      return value;
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return null;
  }
}

/** 只解 exp 做续期排程——不验签（token 是自家后端签的，验证在服务端）。 */
export function parseJwtExpiry(token: string): number {
  const parts = token.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * 兑换与续期答复里要用的那几项（2026-10-03 体检 10-7）：两个非空 token、用户的 uuid、非空邮箱、认得的角色，逐项照旧严格验；
 * 两层多出来的字段不拒、不认，也不往下传——交回的是只有这几项的新对象。argoland 的 TokenPair 网页登录也在用，后端在任何一层
 * 加一个字段（RULE-EXT-CONTRACT-CONSUMER 定的正路：先在 argoland 加，插件跟版本），从前每一个装着的插件都登录不了、续不了期。
 * 角色仍是闭集：插件不拿它做判断，但一个不认得的角色是契约变了（不是加字段），该先在 argoland 加、插件跟版本。
 */
function tokenPairOf(value: unknown): ExtensionTokenPair | null {
  const own = (record: unknown, key: string): unknown =>
    typeof record === 'object' && record !== null && !Array.isArray(record) && Object.hasOwn(record, key)
      ? (record as Record<string, unknown>)[key] : undefined;
  const accessToken = own(value, 'accessToken');
  const refreshToken = own(value, 'refreshToken');
  const user = own(value, 'user');
  const id = parseUuid(own(user, 'id'));
  const email = own(user, 'email');
  const role = AUTH_USER_ROLES.find((known) => known === own(user, 'role'));
  if (typeof accessToken !== 'string' || accessToken === '' || typeof refreshToken !== 'string' || refreshToken === ''
    || id === null || typeof email !== 'string' || email === '' || role === undefined) return null;
  return Object.freeze({ accessToken, refreshToken, user: Object.freeze({ id, email, role }) });
}

function isExactOkResponseBody(value: unknown): value is LinkExtensionInstallResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && body['ok'] === true;
}

export function createAuthClient(deps: AuthClientDeps): AuthClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const diag = (code: string) => deps.onDiagnostic?.(code);

  // access token 只活在 SW 内存（§2.2）；SW 重启即空，用轮转换新。
  let memoryAccess: MemoryAccess | null = null;
  // 会话纪元：logout 递增；跨纪元的在途刷新结果一律丢弃（审计 [1]）。
  let epoch = 0;
  // Set synchronously when logout is invoked. New credential/readiness calls
  // fail closed while local credential removal proceeds; diagnostics cleanup
  // runs outside the transition queue so it cannot deadlock on token access.
  let logoutInProgressEpoch: number | null = null;
  // 刷新单飞：refresh token 轮转经不起并发双刷。
  let refreshing: { epoch: number; promise: Promise<string | null> } | null = null;
  // refresh/redeem/logout 共用的进程内 transition queue。调用 redeem/logout
  // 会先同步递增 epoch，再排队；因此已经在网络中的旧 generation 即使先
  // 返回，也只能作废自己，不能覆盖后来选中的账号。
  let transitionTail: Promise<void> = Promise.resolve();
  // 存储坏时的进程内恒定兜底（审计 [3]）。
  let fallbackInstallId: Uuid | null = null;

  async function storeGet(key: string): Promise<unknown> {
    try {
      return await deps.store.get(key);
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return undefined;
    }
  }
  async function storeSet(key: string, value: unknown): Promise<boolean> {
    try {
      await deps.store.set(key, value);
      return true;
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return false;
    }
  }
  async function storeMatches(
    key: string,
    predicate: (value: unknown) => boolean,
  ): Promise<boolean> {
    try {
      return predicate(await deps.store.get(key));
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return false;
    }
  }
  async function persistRotationTombstone(): Promise<boolean> {
    return (await storeSet(ROTATION_JOURNAL_KEY, true)) &&
      storeMatches(ROTATION_JOURNAL_KEY, (value) => value === true);
  }
  async function persistSession(session: PersistedSession): Promise<boolean> {
    return (await storeSet(SESSION_KEY, session)) &&
      storeMatches(SESSION_KEY, (value) => {
        if (typeof value !== 'object' || value === null) return false;
        const stored = value as Record<string, unknown>;
        return stored['refreshToken'] === session.refreshToken && stored['userId'] === session.userId;
      });
  }
  async function storeRemove(key: string): Promise<boolean> {
    try {
      await deps.store.remove(key);
      // A resolved storage call is not enough for the rotation tombstone:
      // confirm the credential is actually absent before removing the journal.
      return (await deps.store.get(key)) === undefined;
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return false;
    }
  }

  async function readSession(): Promise<PersistedSession | null> {
    const raw = await storeGet(SESSION_KEY);
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s['refreshToken'] !== 'string' || typeof s['userId'] !== 'string') return null;
    return raw as unknown as PersistedSession;
  }

  type AuthoritySessionRead =
    | { readonly state: 'AVAILABLE'; readonly session: PersistedSession }
    | { readonly state: 'MISSING' }
    | { readonly state: 'UNAVAILABLE' };

  async function readSessionAuthority(): Promise<AuthoritySessionRead> {
    let raw: unknown;
    try {
      raw = await deps.store.get(SESSION_KEY);
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return { state: 'UNAVAILABLE' };
    }
    if (raw === undefined) return { state: 'MISSING' };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { state: 'UNAVAILABLE' };
    }
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !== 'refreshToken,userId' ||
      typeof value.refreshToken !== 'string' ||
      value.refreshToken === '' ||
      parseUuid(value.userId) === null
    ) return { state: 'UNAVAILABLE' };
    return { state: 'AVAILABLE', session: raw as PersistedSession };
  }

  type AuthorityInstallRead =
    | { readonly state: 'AVAILABLE'; readonly installId: Uuid }
    | { readonly state: 'MISSING' }
    | { readonly state: 'UNAVAILABLE' };

  async function readInstallIdAuthority(): Promise<AuthorityInstallRead> {
    let raw: unknown;
    try {
      raw = await deps.store.get(INSTALL_ID_KEY);
    } catch {
      diag('AUTH_STORAGE_UNAVAILABLE');
      return { state: 'UNAVAILABLE' };
    }
    if (raw === undefined) return { state: 'MISSING' };
    const installId = parseUuid(raw);
    return installId === null
      ? { state: 'UNAVAILABLE' }
      : { state: 'AVAILABLE', installId };
  }

  function notifySessionInvalidated(): void {
    try { deps.onSessionInvalidated?.(); }
    catch { diag('AUTH_INVALIDATION_OBSERVER_FAILED'); }
  }

  async function clearSession(): Promise<boolean> {
    notifySessionInvalidated();
    memoryAccess = null;
    // Tombstone first. If credential deletion fails, journal MUST survive so a
    // later worker cannot replay the still-persisted one-time refresh token.
    const tombstonePersisted = await persistRotationTombstone();
    const credentialRemoved = await storeRemove(SESSION_KEY);
    if (credentialRemoved) await storeRemove(ROTATION_JOURNAL_KEY);
    await storeRemove(INSTALL_LINKED_KEY);
    return credentialRemoved || tombstonePersisted;
  }

  function withSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = transitionTail;
    let release!: () => void;
    transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return predecessor.then(operation).finally(release);
  }

  async function notifyLogout(refreshToken: string, bearer: string): Promise<boolean> {
    const response = await postJson(
      '/auth/logout',
      { refreshToken } satisfies AuthServerLogoutRequest,
      bearer,
      true,
    );
    return response?.ok === true &&
      response.status === 201 &&
      isExactOkResponseBody(response.body);
  }

  async function revokePairBestEffort(pair: ExtensionTokenPair): Promise<void> {
    if (!(await notifyLogout(pair.refreshToken, pair.accessToken))) {
      diag('AUTH_LOGOUT_NOTIFY_FAILED');
    }
  }

  function applyAccessToken(accessToken: string, userId: string): void {
    const exp = parseJwtExpiry(accessToken);
    if (exp === 0) diag('AUTH_EXP_UNPARSEABLE');
    const expiresAt = exp === 0 ? now() + UNPARSEABLE_EXP_TTL_SECONDS : exp;
    memoryAccess = { accessToken, expiresAt, userId };
    // 趁 worker 还醒着，把下一次轮换约在到期之前。见 AuthClientDeps.scheduleRotation。
    try {
      deps.scheduleRotation?.(expiresAt - ROTATION_LEAD_SECONDS);
    } catch {
      diag('AUTH_ROTATION_SCHEDULE_FAILED');
    }
  }

  async function postJson(
    path: string,
    body: unknown,
    bearer?: string,
    readJsonBody = false,
  ): Promise<AuthPostResponse | null> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
      const request = (async (): Promise<AuthPostResponse | null> => {
        const response = await fetchFn(new URL(path, deps.apiBase).toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (
          typeof response?.ok !== 'boolean' ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        ) return null;
        if (!response.ok || !readJsonBody) {
          return { ok: response.ok, status: response.status, body: null };
        }
        try {
          return {
            ok: true,
            status: response.status,
            body: await readBoundedJsonResponse(response),
          };
        } catch {
          if (controller.signal.aborted) throw new Error('AUTH_RESPONSE_ABORTED');
          return { ok: true, status: response.status, body: null };
        }
      })().catch(() => null);
      const deadline = new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, AUTH_REQUEST_TIMEOUT_MS);
      });
      return await Promise.race([request, deadline]);
    } catch {
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }

  /** 单次轮转。返回新 access token；null = 本次拿不到（会话可能仍在）。 */
  async function rotateOnce(expectedEpoch = epoch): Promise<string | null> {
    if (epoch !== expectedEpoch) return null;
    const session = await readSession();
    if (session === null || epoch !== expectedEpoch) return null;

    // 上一次轮转结局不明（SW 死在落盘前 / 网络中断）。
    //
    // 2026-09-20 之前这里直接 clearSession()：理由是复用已轮转的 token 会撤销用户
    // **全部**会话（§2.2），宁可让他重登。实测这条路是「会话 15 分钟必死」的主因——
    // MV3 worker 随时被杀，第一次轮换几乎必然死在半路。
    //
    // 现在服务端有 60s 宽限窗：R0 已轮换、但后继 R1 **从未被使用**时，再次出示 R0
    // 会吊销 R1 并签发 R2，不再判盗用。所以带着 R0 问**一次**是安全的：
    //   201 → 落盘、清日志位；4xx → 确实不可恢复，清会话；5xx/断网 → 日志位留着。
    // 日志位本身不清——问的结果决定它的去留。
    if ((await storeGet(ROTATION_JOURNAL_KEY)) === true) diag('AUTH_REFRESH_GRACE_ATTEMPT');

    const epochAtStart = expectedEpoch;
    const journalPersisted = await persistRotationTombstone();
    if (!journalPersisted) {
      // The old refresh token is still unspent. Without a durable journal we
      // must not cross the one-time rotation boundary: a worker crash after a
      // successful server rotation could otherwise replay the old token and
      // revoke every active session for this user.
      return null;
    }
    if (epoch !== epochAtStart) {
      // 还没发送网络；旧 token 未烧毁，移除本 generation 的 journal。
      await storeRemove(ROTATION_JOURNAL_KEY);
      return null;
    }
    const response = await postJson(
      '/auth/refresh',
      { refreshToken: session.refreshToken } satisfies AuthServerRefreshRequest,
      undefined,
      true,
    );

    if (response === null) {
      // 网络中断 = 结局不明：日志位留着（下次不重放）；内存里未到期的
      // access token 继续可用到真到期——网络抖动不当场杀会话（审计 [5]）。
      diag('AUTH_REFRESH_TRANSPORT');
      return null;
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        // A gateway may synthesize 5xx/429 after old Auth committed R0 -> R1.
        // The client cannot prove the mutation boundary was not crossed, so
        // keep the journal and never replay R0.
        diag('AUTH_REFRESH_TRANSPORT');
        return null;
      }
      // 4xx：会话不可恢复（已作废/已轮转被复用）——清空等新交接。
      diag('AUTH_REFRESH_FAILED');
      await clearSession();
      return null;
    }
    if (response.status !== 201) {
      // Unexpected success status is outcome-unknown: old Auth may already
      // have committed R0 -> R1. Keep the journal and never replay R0.
      diag('AUTH_REFRESH_TRANSPORT');
      return null;
    }

    const pair = tokenPairOf(response.body);
    if (pair === null) {
      diag('AUTH_RESPONSE_MALFORMED');
      diag('AUTH_REFRESH_TRANSPORT');
      return null;
    }
    if (pair.user.id !== session.userId) {
      diag('AUTH_RESPONSE_MALFORMED');
      await revokePairBestEffort(pair);
      await clearSession();
      return null;
    }
    if (epoch !== epochAtStart) {
      // 刷新期间用户登出：丢弃新对、不落盘，并尽力作废它（审计 [1]）。
      if (!(await notifyLogout(pair.refreshToken, pair.accessToken))) {
        diag('AUTH_LOGOUT_NOTIFY_FAILED');
      }
      return null;
    }
    const persisted = await persistSession({
      refreshToken: pair.refreshToken,
      userId: pair.user.id,
    } satisfies PersistedSession);
    if (!persisted) {
      // 新对没落住盘：内存里仍可用这口气，但日志位保留——下一实例不重放。
      applyAccessToken(pair.accessToken, pair.user.id);
      return pair.accessToken;
    }
    await storeRemove(ROTATION_JOURNAL_KEY);
    applyAccessToken(pair.accessToken, pair.user.id);
    return pair.accessToken;
  }

  function refreshSingleFlight(expectedEpoch = epoch): Promise<string | null> {
    if (epoch !== expectedEpoch) return Promise.resolve(null);
    if (refreshing?.epoch === expectedEpoch) return refreshing.promise;
    const promise = withSessionTransition(async () => {
      if (epoch !== expectedEpoch) return null;
      return rotateOnce(expectedEpoch);
    }).finally(() => {
      if (refreshing?.promise === promise) refreshing = null;
    });
    refreshing = { epoch: expectedEpoch, promise };
    return promise;
  }

  async function getInstallIdInner(): Promise<Uuid> {
    const existing = parseUuid(await storeGet(INSTALL_ID_KEY));
    if (existing !== null) return existing;
    if (fallbackInstallId === null) {
      const generated = parseUuid(crypto.randomUUID());
      if (generated === null) throw new TypeError();
      fallbackInstallId = generated;
    }
    await storeSet(INSTALL_ID_KEY, fallbackInstallId);
    return fallbackInstallId;
  }

  async function linkInstall(
    accessToken: string,
    userId: string,
    expectedEpoch = epoch,
  ): Promise<boolean> {
    const installId = await getInstallIdInner();
    if (epoch !== expectedEpoch) return false;
    const request = { installId } satisfies LinkExtensionInstallRequest;
    // 路径见 AUTH_SESSION_ENDPOINTS.linkExtensionInstall（测试钉着两者一致）。
    const response = await postJson(
      '/api/v1/agent/extension-installs',
      request,
      accessToken,
      true,
    );
    if (
      response?.ok &&
      response.status === 202 &&
      isExactOkResponseBody(response.body) &&
      epoch === expectedEpoch
    ) {
      await storeSet(INSTALL_LINKED_KEY, userId);
      return epoch === expectedEpoch;
    } else if (epoch === expectedEpoch) {
      // 登录态可保留以便安全重试，但 Portal 绑定必须 fail closed。
      diag('AUTH_INSTALL_LINK_FAILED');
    }
    return false;
  }

  type ConnectionAuthorityResult =
    | {
      readonly state: 'READY';
      readonly connection: Readonly<{ userId: Uuid; installId: Uuid }>;
    }
    | {
      readonly state: Exclude<ExtensionConnectionReadinessState, 'READY'>;
    };

  async function readConnectionAuthority(
    expectedOwnerId: string,
  ): Promise<ConnectionAuthorityResult> {
    if (logoutInProgressEpoch !== null) {
      return { state: 'AUTHORITY_UNAVAILABLE' };
    }
    const ownerId = parseUuid(expectedOwnerId);
    if (ownerId === null) return { state: 'AUTHORITY_UNAVAILABLE' };
    const requestedEpoch = epoch;
    return withSessionTransition(async () => {
      if (epoch !== requestedEpoch) return { state: 'AUTHORITY_UNAVAILABLE' };
      const initialSessionRead = await readSessionAuthority();
      if (epoch !== requestedEpoch) return { state: 'AUTHORITY_UNAVAILABLE' };
      if (initialSessionRead.state === 'UNAVAILABLE') {
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      if (initialSessionRead.state === 'MISSING') return { state: 'UNAUTHENTICATED' };
      let session = initialSessionRead.session;
      const sessionOwnerId = parseUuid(session.userId);
      if (sessionOwnerId === null) return { state: 'AUTHORITY_UNAVAILABLE' };
      // Local owner mismatch is a complete denial: zero refresh/status traffic.
      if (sessionOwnerId !== ownerId) return { state: 'OWNER_MISMATCH' };

      // An outcome-unknown one-time refresh forbids reuse of the old bearer.
      if (!(await storeMatches(
        ROTATION_JOURNAL_KEY,
        (value) => value === undefined,
      ))) return { state: 'AUTHORITY_UNAVAILABLE' };

      // Readiness may attest only an existing install identity. Generating or
      // persisting a new ID here would turn a read-only status probe into an
      // ownership mutation and could mislabel storage failure as unlinked.
      const initialInstallRead = await readInstallIdAuthority();
      if (initialInstallRead.state === 'UNAVAILABLE') {
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      if (initialInstallRead.state === 'MISSING') return { state: 'INSTALL_UNLINKED' };
      const installId = initialInstallRead.installId;

      let token =
        memoryAccess &&
        memoryAccess.userId === session.userId &&
        memoryAccess.expiresAt - REFRESH_SKEW_SECONDS > now()
          ? memoryAccess.accessToken
          : null;
      if (token === null) token = await rotateOnce(requestedEpoch);
      if (token === null || epoch !== requestedEpoch) {
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      const currentSessionRead = await readSessionAuthority();
      if (currentSessionRead.state !== 'AVAILABLE') {
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      session = currentSessionRead.session;
      if (parseUuid(session.userId) !== ownerId) return { state: 'OWNER_MISMATCH' };
      if (!(await storeMatches(
        ROTATION_JOURNAL_KEY,
        (value) => value === undefined,
      ))) return { state: 'AUTHORITY_UNAVAILABLE' };

      const currentInstallRead = await readInstallIdAuthority();
      if (
        currentInstallRead.state !== 'AVAILABLE' ||
        currentInstallRead.installId !== installId ||
        epoch !== requestedEpoch
      ) return { state: 'AUTHORITY_UNAVAILABLE' };
      const request = { installId } satisfies AttestExtensionInstallRequest;
      const response = await postJson(
        '/api/v1/agent/extension-installs/status',
        request,
        token,
        true,
      );
      if (epoch !== requestedEpoch) return { state: 'AUTHORITY_UNAVAILABLE' };
      if (!response?.ok || response.status !== 200) {
        diag('AUTH_INSTALL_ATTESTATION_FAILED');
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      const attestation = parseAttestExtensionInstallResponse(response.body);
      if (attestation === null) {
        diag('AUTH_INSTALL_ATTESTATION_FAILED');
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      if (!attestation.connected) return { state: 'INSTALL_UNLINKED' };
      if (
        attestation.userId !== ownerId ||
        attestation.installId !== installId
      ) {
        diag('AUTH_INSTALL_ATTESTATION_FAILED');
        return { state: 'AUTHORITY_UNAVAILABLE' };
      }
      return {
        state: 'READY',
        connection: Object.freeze({ userId: ownerId, installId }),
      };
    });
  }

  return {
    async getAccessToken() {
      if (logoutInProgressEpoch !== null) return null;
      const requestedEpoch = epoch;
      const available = await withSessionTransition(async () => {
        if (epoch !== requestedEpoch || logoutInProgressEpoch !== null) return null;
        const session = await readSession();
        if (epoch !== requestedEpoch || session === null) return null;
        return memoryAccess &&
          memoryAccess.userId === session.userId &&
          memoryAccess.expiresAt - REFRESH_SKEW_SECONDS > now()
          ? memoryAccess.accessToken
          : null;
      });
      if (epoch !== requestedEpoch) return null;
      if (available !== null) return available;
      const rotated = await refreshSingleFlight(requestedEpoch);
      if (epoch !== requestedEpoch) return null;
      if (rotated !== null) return rotated;
      // 换新失败但内存 token 还没真到期（transport 场景）：用到真到期。
      const session = await readSession();
      if (
        epoch === requestedEpoch &&
        session !== null &&
        memoryAccess &&
        memoryAccess.userId === session.userId &&
        memoryAccess.expiresAt > now()
      ) return memoryAccess.accessToken;
      return null;
    },
    async forceRefresh() {
      if (logoutInProgressEpoch !== null) return null;
      const requestedEpoch = epoch;
      const rotated = await refreshSingleFlight(requestedEpoch);
      return epoch === requestedEpoch ? rotated : null;
    },
    async getUserId() {
      if (logoutInProgressEpoch !== null) return null;
      return (await readSession())?.userId ?? null;
    },
    async getInstallId() {
      return getInstallIdInner();
    },
    async ensureInstallLinked() {
      if (logoutInProgressEpoch !== null) return false;
      const requestedEpoch = epoch;
      return withSessionTransition(async () => {
        if (epoch !== requestedEpoch) return false;
        const session = await readSession();
        if (session === null || epoch !== requestedEpoch) return false;
        if ((await storeGet(INSTALL_LINKED_KEY)) === session.userId) return true;
        let token =
          memoryAccess &&
          memoryAccess.userId === session.userId &&
          memoryAccess.expiresAt - REFRESH_SKEW_SECONDS > now()
            ? memoryAccess.accessToken
            : null;
        if (token === null) token = await rotateOnce(requestedEpoch);
        if (token !== null && epoch === requestedEpoch) {
          return linkInstall(token, session.userId, requestedEpoch);
        }
        return false;
      });
    },
    async attestInstallLinked(expectedOwnerId) {
      const result = await readConnectionAuthority(expectedOwnerId);
      return result.state === 'READY' ? result.connection : null;
    },
    async readConnectionReadiness(expectedOwnerId) {
      return (await readConnectionAuthority(expectedOwnerId)).state;
    },
    async redeemHandoff({ code, state, extensionId }) {
      const transitionEpoch = ++epoch;
      notifySessionInvalidated();
      return withSessionTransition(async () => {
        if (epoch !== transitionEpoch) return false;
        const previous = await readSession();
        const previousBearer = memoryAccess?.accessToken;
        const request: RedeemExtensionHandoffRequest = { code, extensionId, state };
        const response = await postJson(
          '/auth/extension-handoffs/redeem',
          request,
          undefined,
          true,
        );
        if (!response || !response.ok) {
          diag('AUTH_REDEEM_FAILED');
          return false;
        }
        if (response.status !== 201) {
          diag('AUTH_RESPONSE_MALFORMED');
          return false;
        }
        const pair = tokenPairOf(response.body);
        if (pair === null) {
          diag('AUTH_RESPONSE_MALFORMED');
          return false;
        }
        if (epoch !== transitionEpoch) {
          await revokePairBestEffort(pair);
          return false;
        }
        const persisted = await persistSession({
          refreshToken: pair.refreshToken,
          userId: pair.user.id,
        } satisfies PersistedSession);
        if (!persisted) {
          await revokePairBestEffort(pair);
          return false;
        }
        if (epoch !== transitionEpoch) {
          await revokePairBestEffort(pair);
          await clearSession();
          return false;
        }
        await storeRemove(ROTATION_JOURNAL_KEY); // 新会话，旧日志位不再相干
        applyAccessToken(pair.accessToken, pair.user.id);
        if (previous && previous.refreshToken !== pair.refreshToken) {
          if (
            previousBearer === undefined ||
            !(await notifyLogout(previous.refreshToken, previousBearer))
          ) {
            diag('AUTH_LOGOUT_NOTIFY_FAILED');
          }
        }
        const installLinked = await linkInstall(
          pair.accessToken,
          pair.user.id,
          transitionEpoch,
        );
        if (epoch !== transitionEpoch) {
          await revokePairBestEffort(pair);
          await clearSession();
          return false;
        }
        return installLinked;
      });
    },
    async logout() {
      const cleanupAccessToken = memoryAccess !== null && memoryAccess.expiresAt > now()
        ? memoryAccess.accessToken
        : null;
      const logoutEpoch = ++epoch;
      notifySessionInvalidated();
      logoutInProgressEpoch = logoutEpoch;
      const diagnosticsCleanup = Promise.resolve()
        .then(() => deps.onBeforeLogout?.(cleanupAccessToken))
        .catch(() => {
          // Telemetry cleanup has its own stable diagnostics and must never
          // keep an auth session alive when the user asked to log out.
        });
      const credentialRemoval = withSessionTransition(async () => {
        let session = await readSession();
        let access = memoryAccess;
        let bearer = access !== null &&
          session !== null &&
          access.userId === session.userId &&
          access.expiresAt > now()
          ? access.accessToken
          : undefined;
        // SW 冷启动或 access 已过期时，旧 Auth 的 public logout 不能在无
        // bearer 下撤销。先以一次安全 rotation 取得新 pair，再撤销新 refresh。
        if (session !== null && bearer === undefined && epoch === logoutEpoch) {
          await rotateOnce(logoutEpoch);
          session = await readSession();
          access = memoryAccess;
          bearer = access !== null &&
            session !== null &&
            access.userId === session.userId &&
            access.expiresAt > now()
            ? access.accessToken
            : undefined;
        }
        const durableSafe = await clearSession();
        if (!durableSafe) {
          // If both tombstone and credential removal failed, burning the
          // server token would turn a later recovered local copy into replay.
          diag('AUTH_LOGOUT_NOTIFY_FAILED');
          return;
        }
        if (session && bearer !== undefined) {
          if (!(await notifyLogout(session.refreshToken, bearer))) {
            diag('AUTH_LOGOUT_NOTIFY_FAILED');
          }
        } else if (session) {
          diag('AUTH_LOGOUT_NOTIFY_FAILED');
        }
      });
      try {
        await credentialRemoval;
      } finally {
        await diagnosticsCleanup;
        if (logoutInProgressEpoch === logoutEpoch) {
          logoutInProgressEpoch = null;
        }
      }
    },
  };
}

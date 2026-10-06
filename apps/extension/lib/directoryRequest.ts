import {
  PROFILE_DIRECTORY_OPERATIONS,
  type ProfileDirectoryOperation,
} from './profileDirectoryTransport';

/**
 * What the panel may ask the worker to fetch on its behalf.
 *
 * The panel names an operation, never a URL — the route table and the bearer
 * token both stay in the worker. This parser is where that stays true: an
 * operation it cannot name reaches no route, and a request shaped differently
 * than agreed reaches nothing at all.
 *
 * The body is passed through unread. A save's contents are the caller's
 * business and the server validates them again; what matters here is that the
 * *destination* is one of eight fixed things.
 */
export interface DirectoryRequest {
  readonly operation: ProfileDirectoryOperation;
  readonly body: unknown;
  /**
   * 写的时候：内容脚本认为这一份资料是谁的（会话代号，lib/sessionStamp.ts；没登录是 null，2026-10-04）。worker 此刻登录的
   * 不是这个人就不写——上一个人的修改绝不存进下一个人的资料。缺省 = 不核（还不知道是谁）。
   */
  readonly session?: string | null;
}

const KEYS_WITHOUT_BODY = ['kind', 'operation'] as const;
const KEYS_WITH_BODY = ['kind', 'operation', 'body'] as const;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export function parseDirectoryRequest(value: unknown): DirectoryRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const all = Object.keys(value);
  const withSession = all.includes('session');
  const keys = all.filter((key) => key !== 'session');
  const expected = keys.length === KEYS_WITH_BODY.length ? KEYS_WITH_BODY : KEYS_WITHOUT_BODY;
  // Exact keys: an extra field is a shape we did not agree to, and this message
  // is one hop from a request the worker signs with the user's token.
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'profile-directory/run') return null;
  const operation = PROFILE_DIRECTORY_OPERATIONS
    .find((known) => known === candidate.operation);
  if (operation === undefined) return null;
  const session = candidate.session;
  if (withSession && session !== null && (typeof session !== 'string' || !SESSION_PATTERN.test(session))) return null;
  return Object.freeze({ operation, body: candidate.body, ...(withSession ? { session: session as string | null } : {}) });
}

/** The message a panel sends. Null for an operation this build does not have. */
export function createDirectoryRequest(
  operation: ProfileDirectoryOperation,
  body?: unknown,
  session?: string | null,
): Readonly<Record<string, unknown>> | null {
  const message = {
    kind: 'profile-directory/run',
    operation,
    ...(body === undefined ? {} : { body }),
    ...(session === undefined ? {} : { session }),
  };
  return parseDirectoryRequest(message) === null ? null : Object.freeze(message);
}

/**
 * 「我的资料」上一次读到的那一份（2026-10-04，先显示旧的、后台换新）：面板只问这一句，不带任何东西。worker 只交回当前账号
 * 记在 storage.session 里的那几格（lib/profileDirectoryCache.ts），而且只答报到过、还停在那一页的标签页。
 */
export const DIRECTORY_CACHED_REQUEST = Object.freeze({ kind: 'profile-directory/cached' as const });

export function isDirectoryCachedRequest(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { kind?: unknown }).kind === 'profile-directory/cached';
}

import { platformAccountId, type User } from '@companion/platform-contracts';
import { request as platformRequest } from './api.ts';
import { WORKSPACE_CONNECTION_TIMEOUT_MS, type BootstrapTiming } from './pwa-runtime.ts';

/** This cookie-authenticated observation is enough to bind a resource viewer;
 * it carries no ordinary admission, provider, or execution permission. */
export interface ResourceSession { readonly scope: 'support_resources'; readonly user: Readonly<User>; }
function invalid(): never { throw new Error('暂时无法确认支持资源所属的账号。'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function parseResourceSession(value: unknown): Readonly<ResourceSession> {
  const result = record(value, ['scope', 'user']); if (result.scope !== 'support_resources') invalid();
  const user = record(result.user, ['id', 'email', 'name', 'emailVerified']);
  if (!platformAccountId(user.id) || typeof user.email !== 'string' || !user.email.length || user.email.length > 254
    || typeof user.name !== 'string' || user.name.length > 120 || typeof user.emailVerified !== 'boolean') invalid();
  return Object.freeze({ scope: 'support_resources', user: Object.freeze({ id: user.id as string, email: user.email, name: user.name, emailVerified: user.emailVerified }) });
}
export async function readResourceSession(signal: AbortSignal,
  read: (path: string, options: { signal: AbortSignal }) => Promise<unknown> = platformRequest,
  timing: BootstrapTiming = { setTimer: (run, delay) => setTimeout(run, delay), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }): Promise<Readonly<ResourceSession>> {
  signal.throwIfAborted(); const request = new AbortController();
  const cancel = () => request.abort(); signal.addEventListener('abort', cancel, { once: true });
  let rejectCancelled: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = () => reject(new DOMException('Connection interrupted.', 'AbortError')); });
  request.signal.addEventListener('abort', rejectCancelled, { once: true });
  const timer = timing.setTimer(() => request.abort(), WORKSPACE_CONNECTION_TIMEOUT_MS);
  try {
    const value = await Promise.race([read('/auth/resource-session', { signal: request.signal }), cancelled]);
    signal.throwIfAborted(); request.signal.throwIfAborted(); return parseResourceSession(value);
  } finally {
    timing.clearTimer(timer); signal.removeEventListener('abort', cancel);
    request.signal.removeEventListener('abort', rejectCancelled); request.abort();
  }
}

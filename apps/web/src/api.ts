import { ApiError } from './api-error.ts';
export { ApiError } from './api-error.ts';
import { PLATFORM_ACCOUNT_HEADER, platformAccountId } from '@companion/platform-contracts';
import { createPlatformEndpoints, type PlatformEndpoints, type PrivateFileOptions } from './platform-endpoints.ts';
import { AccountRequestContext, AccountRequestInvalidated, platformAccountContext, type AccountRequestLease, type CapturedAccount } from './account-context.ts';
const endpoints = createPlatformEndpoints(import.meta.env?.VITE_PLATFORM_API_ORIGIN);
export const apiUrl = endpoints.apiUrl;
export function privateFileUrl(value: unknown, options: PrivateFileOptions & { account?: CapturedAccount } = {}): string | undefined {
  if (options.account) return platformAccountContext.isCurrent(options.account) ? endpoints.privateFileUrl(value, { ...options, accountId: options.account.accountId }) : undefined;
  return endpoints.privateFileUrl(value, { ...options, accountId: options.accountId ?? platformAccountContext.capture()?.accountId });
}
export type SuccessfulAuthPath = '/auth/login' | '/auth/register' | '/auth/password-reset/complete';
export interface SuccessfulAuthResponse { readonly path: SuccessfulAuthPath; }
export interface PlatformClientOptions { onAuthResponseHeaders?: (event: SuccessfulAuthResponse) => void; }
const authResponseListeners = new Set<(event: SuccessfulAuthResponse) => void>();
/** Neutral notification port. No response identity or cookie value is supplied to subscribers. */
export function subscribeAuthResponseHeaders(listener: (event: SuccessfulAuthResponse) => void): () => void {
  authResponseListeners.add(listener); return () => authResponseListeners.delete(listener);
}
function publishAuthResponseHeaders(event: SuccessfulAuthResponse) { for (const listener of [...authResponseListeners]) { try { void Promise.resolve(listener(event)).catch(() => {}); } catch { /* A failed notification cannot reinterpret a completed authentication response. */ } } }
/** HTTP delay seconds or an HTTP date; unavailable/malformed headers leave fallback timing to the caller. */
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) { const delay = Number(text) * 1000; return Number.isSafeInteger(delay) ? delay : undefined; }
  const day = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)', month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const modern = new RegExp(`^${day}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`);
  const obsolete = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
  const asctime = new RegExp(`^${day} ${month} {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}$`);
  if (!modern.test(text) && !obsolete.test(text) && !asctime.test(text)) return undefined;
  const date = Date.parse(asctime.test(text) ? `${text} GMT` : text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export const request = <T>(path: string, init: RequestInit = {}): Promise<T> => client.request<T>(path, init);
export const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const remove = (path: string) => request(path, { method: 'DELETE' });
export function collection<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key])) return (data as Record<string, T[]>)[key];
  return [];
}
export function entity<T>(data: unknown, key: string): T {
  if (data && typeof data === 'object' && key in data) return (data as Record<string, T>)[key];
  return data as T;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
export interface StreamEvent { event: string; data: any }
export function parseEventBlock(block: string): StreamEvent | null {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) parts.push(line.slice(5).trimStart());
  }
  if (!parts.length) return null;
  const content = parts.join('\n');
  if (content === '[DONE]') return { event: 'done', data: {} };
  try { return { event, data: JSON.parse(content) }; } catch { return { event, data: { text: content } }; }
}
async function readMessageStream(response: Response, onEvent: (event: StreamEvent) => void, lease: AccountRequestLease): Promise<void> {
  if (!response.body) throw new ApiError('服务没有返回可读取的响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  lease.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      lease.assertCurrent();
      const { value, done } = await lease.wait(reader.read());
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseEventBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) { lease.assertCurrent(); onEvent(parsed); if (parsed.event === 'done' || parsed.event === 'error') terminal = true; }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) { const parsed = parseEventBlock(buffer); if (parsed) { lease.assertCurrent(); onEvent(parsed); terminal ||= parsed.event === 'done' || parsed.event === 'error'; } }
    lease.assertCurrent();
    if (!terminal) throw new ApiError('响应连接提前结束。请刷新会话确认已保存的内容。');
  } finally { lease.signal.removeEventListener('abort', cancel); if (!terminal || lease.signal.aborted) cancel(); reader.releaseLock(); }
}

export interface BoundPlatformClient {
  readonly account: CapturedAccount;
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  remove(path: string): Promise<unknown>;
  streamMessage(id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void>;
  privateFileUrl(value: unknown, options?: { download?: boolean }): string | undefined;
  readPrivateFileText(value: unknown, signal?: AbortSignal): Promise<string>;
  readCompanionSealPNG(assetId: string, signal?: AbortSignal): Promise<Blob>;
  cleanup(path: '/auth/logout' | '/voice/session/release', init?: RequestInit): Promise<void>;
}

/** Exact method/path exemptions only; a public GET never grants access to a private POST. */
export function isPublicPlatformRequest(path: string, method = 'GET'): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return ['/health', '/live', '/ready', '/execution-ready', '/capabilities', '/features', '/auth/options', '/auth/me', '/auth/resource-session', '/auth/legal-documents'].includes(path);
  return verb === 'POST' && ['/auth/login', '/auth/register', '/auth/password-reset/request', '/auth/password-reset/complete'].includes(path);
}
function parsedBody(body: string): any { try { return body ? JSON.parse(body) : null; } catch { return null; } }
function responseError(response: Response, data: any): ApiError {
  const detail = data?.error ?? data;
  return new ApiError(typeof detail === 'string' ? detail : detail?.message || `请求失败 (${response.status})`, response.status, detail?.code, retryAfterMilliseconds(response.headers.get('Retry-After')));
}
function waitForSignal<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** All private work captures intent before its first await; it never adopts a later window account. */
export function createPlatformClient(target: PlatformEndpoints, transport: typeof fetch = (input, init) => fetch(input, init), context: AccountRequestContext = platformAccountContext, options: PlatformClientOptions = {}) {
  const capture = (): CapturedAccount => {
    const account = context.capture();
    if (!account) { context.invalidate('account-context-required'); throw new ApiError('请重新确认账号后继续。', 409, 'ACCOUNT_CONTEXT_REQUIRED'); }
    return account;
  };
  const invalidation = (error: ApiError, account?: CapturedAccount) => {
    if (!account || !context.isCurrent(account)) return;
    if (error.status === 401) context.invalidate('authentication-required');
    else if (error.status === 409 && error.code === 'ACCOUNT_CONTEXT_CHANGED') context.invalidate('account-context-changed');
    else if (error.status === 409 && error.code === 'ACCOUNT_CONTEXT_REQUIRED') context.invalidate('account-context-required');
  };
  const headersFor = (init: RequestInit, account?: CapturedAccount) => {
    const headers = new Headers(init.headers);
    headers.delete(PLATFORM_ACCOUNT_HEADER);
    if (account) headers.set(PLATFORM_ACCOUNT_HEADER, account.accountId);
    if (init.body != null && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return headers;
  };
  async function fetchResponse(url: string, init: RequestInit, lease?: AccountRequestLease): Promise<Response> {
    lease?.assertCurrent(); init.signal?.throwIfAborted();
    try { const work = transport(url, { ...init, credentials: 'include', redirect: 'error', ...(lease ? { signal: lease.signal } : {}) }); return lease ? await lease.wait(work) : await work; }
    catch (error) { lease?.assertCurrent(); if (init.signal?.aborted) throw error; throw new ApiError('无法连接工作台 API。请检查服务地址和网络连接。'); }
  }
  async function requestCaptured<T>(path: string, init: RequestInit = {}, fixed?: CapturedAccount): Promise<T> {
    const url = target.apiUrl(path), account = isPublicPlatformRequest(path, init.method) ? undefined : fixed ?? capture();
    const requestSession = context.getSnapshot();
    const changesCookie = init.method?.toUpperCase() === 'POST' && ['/auth/login', '/auth/register', '/auth/password-reset/complete'].includes(path);
    const lease = account ? context.lease(account, init.signal) : undefined;
    try {
      const response = await fetchResponse(url, { ...init, headers: headersFor(init, account) }, lease);
      // Set-Cookie takes effect at headers, before body parsing or the caller's mounted/live check.
      if (response.ok && changesCookie) {
        if (context.getSnapshot() !== requestSession) context.invalidate('local-auth-change');
        try { void Promise.resolve(options.onAuthResponseHeaders?.(Object.freeze({ path: path as SuccessfulAuthPath }))).catch(() => {}); } catch { /* Notify failures do not adopt response identity or replay authentication. */ }
      }
      const body = lease ? await lease.wait(response.text()) : await waitForSignal(response.text(), init.signal);
      init.signal?.throwIfAborted(); lease?.assertCurrent();
      if (response.ok && changesCookie && context.getSnapshot() !== requestSession) throw new AccountRequestInvalidated();
      const data = parsedBody(body);
      if (!response.ok) { const error = responseError(response, data); invalidation(error, account); throw error; }
      return data as T;
    } finally { lease?.dispose(); }
  }
  async function streamCaptured(id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void, fixed?: CapturedAccount): Promise<void> {
    const url = target.apiUrl(`/conversations/${encodeURIComponent(id)}/messages`), account = fixed ?? capture();
    const lease = context.lease(account, signal);
    try {
      const init = { method: 'POST', body: JSON.stringify(body), headers: { Accept: 'text/event-stream' } };
      const response = await fetchResponse(url, { ...init, headers: headersFor(init, account) }, lease);
      if (!response.ok) { const error = responseError(response, parsedBody(await lease.wait(response.text()))); invalidation(error, account); throw error; }
      await readMessageStream(response, onEvent, lease);
    } finally { lease.dispose(); }
  }
  const client = {
    request: requestCaptured,
    streamMessage: streamCaptured,
    capture(account: CapturedAccount = capture()): BoundPlatformClient {
      if (!platformAccountId(account.accountId) || !Number.isSafeInteger(account.generation) || account.generation < 0) throw new Error('账号上下文无效。');
      const fixed = Object.freeze({ accountId: account.accountId, generation: account.generation });
      return Object.freeze({
        account: fixed,
        isCurrent: () => context.isCurrent(fixed),
        subscribe: context.subscribe,
        request: <T>(path: string, init: RequestInit = {}) => requestCaptured<T>(path, init, fixed),
        post: <T>(path: string, body: unknown = {}) => requestCaptured<T>(path, { method: 'POST', body: JSON.stringify(body) }, fixed),
        remove: (path: string) => requestCaptured(path, { method: 'DELETE' }, fixed),
        streamMessage: (id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void) => streamCaptured(id, body, signal, onEvent, fixed),
        privateFileUrl: (value: unknown, options?: { download?: boolean }) => context.isCurrent(fixed) ? target.privateFileUrl(value, { ...options, accountId: fixed.accountId }) : undefined,
        async readPrivateFileText(value: unknown, signal?: AbortSignal): Promise<string> {
          const url = target.privateFileUrl(value, { accountId: fixed.accountId });
          if (!url) throw new Error('私人文件地址无效。');
          const lease = context.lease(fixed, signal);
          try {
            const response = await fetchResponse(url, { signal, headers: headersFor({}, fixed) }, lease);
            const text = await lease.wait(response.text());
            if (!response.ok) { const error = responseError(response, parsedBody(text)); invalidation(error, fixed); throw error; }
            lease.assertCurrent(); return text;
          } finally { lease.dispose(); }
        },
        async readCompanionSealPNG(assetId: string, signal?: AbortSignal): Promise<Blob> {
          if (typeof assetId !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(assetId)?.[0] !== assetId) throw new Error('印章地址无效。');
          const lease = context.lease(fixed, signal);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let body: ReadableStream<Uint8Array> | null = null;
          try {
            const response = await fetchResponse(target.apiUrl('/companion/seals/' + assetId + '/png'), {
              signal, headers: headersFor({ headers: { Accept: 'image/png' } }, fixed),
            }, lease);
            body = response.body;
            if (!response.ok) {
              const error = responseError(response, parsedBody(await lease.wait(response.text()))); invalidation(error, fixed); throw error;
            }
            if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'image/png' || !response.body) throw new Error('印章暂时无法读取。');
            const declared = response.headers.get('Content-Length');
            if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > 32768)) throw new Error('印章暂时无法读取。');
            reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let length = 0;
            while (true) {
              const part = await lease.wait(reader.read()); if (part.done) break;
              length += part.value.byteLength; if (length > 32768) throw new Error('印章暂时无法读取。');
              chunks.push(Uint8Array.from(part.value));
            }
            const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            if (length < 33 || ![137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte)) throw new Error('印章暂时无法读取。');
            lease.assertCurrent(); return new Blob([bytes], { type: 'image/png' });
          } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else if (body) { void body.cancel().catch(() => {}); } lease.dispose(); }
        },
        async cleanup(path: '/auth/logout' | '/voice/session/release', init: RequestInit = {}): Promise<void> {
          if (!['/auth/logout', '/voice/session/release'].includes(path) || init.method && init.method.toUpperCase() !== 'POST') throw new Error('账号清理路径无效。');
          // Cleanup is narrowly allowed after invalidation, always under A's assertion; no identity or private result is published.
          const input = { ...init, method: 'POST', keepalive: true };
          const response = await fetchResponse(target.apiUrl(path), { ...input, headers: headersFor(input, fixed) });
          if (!response.ok) throw responseError(response, parsedBody(await response.text()));
        },
      });
    },
  };
  return client;
}
const client = createPlatformClient(endpoints, undefined, platformAccountContext, { onAuthResponseHeaders: publishAuthResponseHeaders });
export const capturePlatformClient = (account?: CapturedAccount): BoundPlatformClient | null => {
  const captured = account ?? platformAccountContext.capture();
  return captured ? client.capture(captured) : null;
};
export const streamMessage = (id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void> => client.streamMessage(id, body, signal, onEvent);

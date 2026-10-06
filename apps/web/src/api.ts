import { createPlatformEndpoints, type PlatformEndpoints } from './platform-endpoints.ts';
const endpoints = createPlatformEndpoints(import.meta.env?.VITE_PLATFORM_API_ORIGIN);
export const apiUrl = endpoints.apiUrl;
export const privateFileUrl = endpoints.privateFileUrl;
export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  constructor(message: string, status = 0, code?: string, retryAfterMs?: number) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}
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
async function readMessageStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const detail = error?.error ?? error;
    throw new ApiError(typeof detail === 'string' ? detail : detail?.message || `请求失败 (${response.status})`, response.status, detail?.code, retryAfterMilliseconds(response.headers.get('Retry-After')));
  }
  if (!response.body) throw new ApiError('服务没有返回可读取的响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseEventBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) { onEvent(parsed); if (parsed.event === 'done' || parsed.event === 'error') terminal = true; }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) { const parsed = parseEventBlock(buffer); if (parsed) { onEvent(parsed); terminal ||= parsed.event === 'done' || parsed.event === 'error'; } }
    if (!terminal) throw new ApiError('响应连接提前结束。请刷新会话确认已保存的内容。');
  } finally { reader.releaseLock(); }
}

/** The same transport is used in production and tests; uploads keep browser multipart boundaries. */
export function createPlatformClient(target: PlatformEndpoints, transport: typeof fetch = (input, init) => fetch(input, init)) {
  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const url = target.apiUrl(path);
      const headers = new Headers(init.headers);
      if (init.body != null && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      let response: Response;
      try { response = await transport(url, { ...init, credentials: 'include', redirect: 'error', headers }); }
      catch (error) { if (init.signal?.aborted) throw error; throw new ApiError('无法连接工作台 API。请检查服务地址和网络连接。'); }
      const body = await response.text();
      let data: any = null;
      try { data = body ? JSON.parse(body) : null; } catch { /* HTTP errors can be plain text. */ }
      if (!response.ok) {
        const detail = data?.error ?? data;
        throw new ApiError(typeof detail === 'string' ? detail : detail?.message || `请求失败 (${response.status})`, response.status, detail?.code, retryAfterMilliseconds(response.headers.get('Retry-After')));
      }
      return data as T;
    },
    async streamMessage(id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void> {
      const url = target.apiUrl(`/conversations/${encodeURIComponent(id)}/messages`);
      const response = await transport(url, { method: 'POST', credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
      await readMessageStream(response, onEvent);
    },
  };
}
const client = createPlatformClient(endpoints);
export const streamMessage = (id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void> => client.streamMessage(id, body, signal, onEvent);

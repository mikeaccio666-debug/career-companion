import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { McpCatalogEntry } from './mcp-config.ts';
import { ApiError } from './errors.ts';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SESSION_BYTES = 1024 * 1024;
const allowedHeaders = new Set(['accept', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id', 'authorization']);
export function publicMcpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  let normalized: string; try { normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return false; }
  const [a, b] = normalized.split(':').map(part => Number.parseInt(part || '0', 16));
  return a >= 0x2000 && a < 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8));
}
const denied = () => new ApiError(503, 'MCP_ENDPOINT_REJECTED', 'This MCP endpoint does not meet the server connection policy.');
const interrupted = () => new ApiError(502, 'MCP_INTERRUPTED', 'The MCP connection was interrupted or timed out.');

/** Node HTTP pins the checked address while TLS still verifies the reviewed hostname. */
export function createMcpFetch(entry: McpCatalogEntry, fixtureOrigins: readonly string[], sessionSignal: AbortSignal): FetchLike {
  const endpoint = new URL(entry.url);
  const fixture = fixtureOrigins.includes(endpoint.origin) && endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== 'https:' && !fixture || !fixture && isIP(endpoint.hostname.replace(/^\[|\]$/g, ''))) throw denied();
  let count = 0, sessionBytes = 0;
  return async (target, init = {}) => {
    if (new URL(target).href !== endpoint.href || ++count > 24) throw denied();
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['POST', 'GET', 'DELETE'].includes(method)) throw denied();
    const incoming = new Headers(init.headers);
    if (incoming.has('cookie') || incoming.has('x-companion-account') || incoming.has('proxy-authorization') || incoming.has('host')) throw denied();
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    let headerBytes = 0;
    for (const [name, value] of incoming) {
      if (!allowedHeaders.has(name) && !/^mcp-param-[a-z0-9][a-z0-9_-]{0,80}$/.test(name) || (headerBytes += name.length + value.length) > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw denied();
      if (name === 'authorization' && (!entry.bearerToken || value !== `Bearer ${entry.bearerToken}`)) throw denied();
      headers[name] = value;
    }
    let body: string | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string' || method !== 'POST' || Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) throw denied();
      body = init.body;
    }
    const signal = AbortSignal.any([sessionSignal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(5000)]);
    if (signal.aborted) throw interrupted();
    const resolve = fixture ? Promise.resolve([{ address: endpoint.hostname === '[::1]' ? '::1' : '127.0.0.1', family: endpoint.hostname === '[::1]' ? 6 : 4 }]) : lookup(endpoint.hostname, { all: true });
    const addresses = await new Promise<Awaited<typeof resolve>>((accept, reject) => {
      const stop = () => { signal.removeEventListener('abort', stop); reject(interrupted()); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) { stop(); return; }
      void resolve.then(value => { signal.removeEventListener('abort', stop); accept(value); }, () => { signal.removeEventListener('abort', stop); reject(denied()); });
    });
    if (!addresses.length || !fixture && addresses.some(item => !publicMcpAddress(item.address))) throw denied();
    const pinned = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => callback(null, options.all ? [pinned] : pinned.address, pinned.family);
    if (signal.aborted) throw interrupted();
    return new Promise<Response>((accept, reject) => {
      let response: http.IncomingMessage | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false, ended = false, bytes = 0;
      const finish = () => { signal.removeEventListener('abort', stop); };
      const fail = (error: ApiError) => {
        if (ended) return;
        ended = true; finish();
        response?.destroy(); request.destroy();
        if (settled) { try { controller?.error(error); } catch {} } else { settled = true; reject(error); }
      };
      const stop = () => fail(interrupted());
      const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
        method, headers, agent: false, lookup: pinnedLookup, family: pinned.family, maxHeaderSize: 16 * 1024,
        ...(endpoint.protocol === 'https:' ? { servername: endpoint.hostname } : {}),
      }, incomingResponse => {
        response = incomingResponse; response.pause();
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) { fail(denied()); return; }
        const encoding = response.headers['content-encoding'];
        const length = Number(response.headers['content-length'] ?? 0);
        if (status >= 300 && status < 400 || encoding && encoding !== 'identity') { fail(denied()); return; }
        if (!Number.isFinite(length) || length < 0 || length > MAX_RESPONSE_BYTES) { fail(new ApiError(502, 'MCP_RESPONSE_TOO_LARGE', 'The MCP response exceeds the connection limit.')); return; }
        const resultHeaders = new Headers();
        for (const name of ['content-type', 'content-length', 'mcp-protocol-version', 'mcp-session-id', 'www-authenticate']) {
          const value = response.headers[name]; if (typeof value === 'string') resultHeaders.set(name, value);
        }
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          pull() { response?.resume(); },
          cancel() { if (!ended) { ended = true; finish(); response?.destroy(); request.destroy(); } },
        }, { highWaterMark: 1 });
        response.on('data', (chunk: Buffer) => {
          if (ended) return;
          bytes += chunk.byteLength; sessionBytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES || sessionBytes > MAX_SESSION_BYTES) { fail(new ApiError(502, 'MCP_RESPONSE_TOO_LARGE', 'The MCP response exceeds the connection limit.')); return; }
          controller!.enqueue(new Uint8Array(chunk)); if ((controller!.desiredSize ?? 0) <= 0) response!.pause();
        });
        response.once('end', () => { if (!ended) { ended = true; finish(); controller!.close(); } });
        response.once('error', () => fail(interrupted()));
        response.once('aborted', () => fail(interrupted()));
        settled = true;
        if ([204, 205, 304].includes(status)) { ended = true; finish(); response.resume(); accept(new Response(null, { status, headers: resultHeaders })); }
        else accept(new Response(stream, { status, headers: resultHeaders }));
      });
      request.once('error', () => fail(interrupted()));
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) { stop(); return; }
      request.end(body);
    });
  };
}

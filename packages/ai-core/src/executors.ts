import { chromium, type Browser, type BrowserContext } from 'playwright';
import { lookup } from 'node:dns/promises';
import { isIP, type Socket } from 'node:net';
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, chown, open, opendir, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { CreateJobInput, GeneratedArtifact, JobExecutionContext, JobExecutionResult, BrowserCheckpoint, BrowserCheckpointEvent } from '@companion/platform-contracts';
import { CLI_INPUT_MAX_FILES as MAX_INPUT_FILES, CLI_INPUT_MAX_FILE_BYTES as MAX_INPUT_FILE_BYTES, CLI_INPUT_MAX_TOTAL_BYTES as MAX_INPUT_TOTAL_BYTES } from '@companion/platform-contracts';
import { ProviderError } from './errors.ts';
import { executeCliRelay } from './cli-relay.ts';
import { cliModelConfiguration } from './cli-model.ts';
import { cliMediaMime } from './cli-artifact-mime.ts';
import { parseBrowserTaskOptions, browserDefinitionHash, performBrowserAction, captureBrowserResult } from './browser-actions.ts';
import { browserFixtureOrigins } from './browser-origins.ts';
import { BROWSER_ISOLATION_SCRIPT } from './browser-isolation.ts';
import { ownBrowserServer } from './owned-browser.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_REQUESTS = 80;
const MAX_MATERIAL_FILES = 20;
const MAX_MATERIAL_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MATERIAL_DEPTH = 3;
const MAX_MATERIAL_ENTRIES = 100;

function fail(code: string, message: string, status = 400): never {
  throw new ProviderError(code, message, status);
}
function cancelled(): ProviderError { return new ProviderError('JOB_CANCELLED', 'The task was cancelled.', 409); }
function timeout(): ProviderError { return new ProviderError('EXECUTOR_TIMEOUT', 'The execution exceeded its time limit.', 504); }
function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail('EXECUTOR_CONFIGURATION', 'An execution limit is invalid.', 503);
  return number;
}
function deadline(signal: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), milliseconds);
  return { signal: controller.signal, abort: (reason: ProviderError) => controller.abort(reason), dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!controller.signal.aborted) controller.abort(cancelled()); } };
}
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw signal.reason; }
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function parseUrl(value: unknown): URL {
  return new URL(parseBrowserTaskOptions({ url: value }).url);
}
function hostName(url: URL) { return url.hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
function isLoopback(host: string) { return host === 'localhost' || host === '127.0.0.1' || host === '::1'; }
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global-unicast space; exclude documentation, Teredo/special-purpose and 6to4.
    const parts = address.toLowerCase().split(':');
    const first = Number.parseInt(parts[0], 16), second = Number.parseInt(parts[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8));
  }
  return false;
}
function localOrigins(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(browserFixtureOrigins(env.PLATFORM_BROWSER_ALLOWED_ORIGINS));
}
async function addressFor(url: URL, allowed: Set<string>, signal: AbortSignal) {
  checkAbort(signal);
  const host = hostName(url), fixture = allowed.has(url.origin) && isLoopback(host);
  if (!fixture && (url.protocol !== 'https:' || /(^|\.)(localhost|local|internal|metadata|instance-data)$/.test(host)))
    fail('BROWSER_ADDRESS_BLOCKED', 'Only public HTTPS pages are allowed.');
  if (fixture && !['http:', 'https:'].includes(url.protocol)) fail('BROWSER_ADDRESS_BLOCKED', 'This URL scheme is not allowed.');
  let records: Array<{ address: string; family: number }>;
  try { records = isIP(host) ? [{ address: host, family: isIP(host) }] : await withAbort(lookup(host, { all: true, verbatim: true }), signal); }
  catch { checkAbort(signal); return fail('BROWSER_ADDRESS_BLOCKED', 'The page address could not be safely resolved.'); }
  checkAbort(signal);
  if (!records.length || records.some(record => fixture ? !['127.0.0.1', '::1'].includes(record.address) : !isPublicAddress(record.address)))
    fail('BROWSER_ADDRESS_BLOCKED', 'Private, local, reserved and metadata addresses are blocked.');
  return records.find(record => record.family === 4) || records[0];
}
interface ReadResponse { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string; }
interface NetworkBudget { requests: number; bytes: number; }
async function readUrl(url: URL, method: string, allowed: Set<string>, budget: NetworkBudget, signal: AbortSignal, redirects = 0): Promise<ReadResponse> {
  if (++budget.requests > MAX_REQUESTS) fail('BROWSER_LIMIT_EXCEEDED', 'The page exceeded the request limit.');
  const address = await addressFor(url, allowed, signal);
  const response = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, agent: false, signal, family: address.family,
      headers: { 'user-agent': 'CompanionReadOnlyBrowser/1.0', 'accept-encoding': 'identity', accept: '*/*' },
      // The checked IP is also the connected IP; retain the original hostname for TLS/SNI.
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      maxHeaderSize: 16 * 1024,
    }, response => {
      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy(); resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); return;
      }
      const length = Number(response.headers['content-length']);
      if (length > MAX_RESPONSE_BYTES) { response.destroy(); reject(new ProviderError('BROWSER_LIMIT_EXCEEDED', 'The page response is too large.', 413)); return; }
      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (encoding && encoding !== 'identity' && !decoder) { response.destroy(); reject(new ProviderError('BROWSER_RESPONSE_UNSUPPORTED', 'The page uses an unsupported response encoding.')); return; }
      const stream = decoder ? response.pipe(decoder) : response;
      const chunks: Buffer[] = []; let bytes = 0;
      const onError = (error: Error) => { stream.destroy(); response.destroy(); reject(error); };
      response.on('error', onError);
      if (decoder) decoder.on('error', onError);
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length; budget.bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES || budget.bytes > MAX_TOTAL_BYTES) { onError(new ProviderError('BROWSER_LIMIT_EXCEEDED', 'The page exceeded the response-size limit.', 413)); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(timeout()));
    request.end();
  });
  checkAbort(signal);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (!response.headers.location || redirects >= 5) fail('BROWSER_REDIRECT_BLOCKED', 'The page redirect could not be safely followed.');
    // Never hand a redirect to Chromium: Playwright does not re-route every redirected URL.
    return readUrl(parseUrl(new URL(response.headers.location, url).href), method, allowed, budget, signal, redirects + 1);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined && !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return { status: response.status, headers, body: response.body, finalUrl: url.href };
}

/** Isolated public rendering with separately gated reviewed actions and no authenticated submission. */
export async function executeBrowser(input: CreateJobInput, ctx: JobExecutionContext, env: NodeJS.ProcessEnv): Promise<JobExecutionResult> {
  if (env.PLATFORM_ENABLE_BROWSER !== '1') fail('BROWSER_DISABLED', 'Browser execution is disabled on this server.', 503);
  if(input.attachmentIds?.length)fail('INVALID_PROVIDER_INPUT','Browser execution does not use reference attachments.');
  const options = parseBrowserTaskOptions(input.options), actions = options.actions ?? [];
  const url = parseUrl(options.url), allowed = localOrigins(env), hash = browserDefinitionHash(input);
  if (actions.length && env.PLATFORM_ENABLE_BROWSER_ACTIONS !== '1') fail('BROWSER_ACTIONS_DISABLED', 'Reviewed browser actions are disabled on this server.', 503);
  let checkpoint = ctx.browserCheckpoint;
  if (actions.length) {
    if (!ctx.onBrowserCheckpoint || !ctx.assertBrowserAuthorized || !checkpoint) fail('BROWSER_CHECKPOINT_UNAVAILABLE', 'Reviewed browser actions require durable checkpoints and current authorization.', 503);
    if (checkpoint.definitionHash !== hash || checkpoint.revision !== 0 || checkpoint.nextIndex !== 0 || checkpoint.state !== 'ready')
      fail('BROWSER_REPLAY_BLOCKED', 'Browser contexts cannot be resumed or replayed. Review a new task instead.', 409);
  }
  const clock = deadline(ctx.signal, boundedNumber(env.PLATFORM_BROWSER_TIMEOUT_MS, 30_000, 500, 120_000));
  async function authorized() {
    checkAbort(clock.signal);
    if (ctx.assertBrowserAuthorized) {
      try { await withAbort(ctx.assertBrowserAuthorized!(), clock.signal); }
      catch { checkAbort(clock.signal); fail('BROWSER_AUTH_REVOKED', 'This reviewed browser task is no longer authorized to execute.', 409); }
    }
    checkAbort(clock.signal);
  }
  async function persist(index: number, type: 'started' | 'completed', result?: JobExecutionResult) {
    await authorized();
    const before = checkpoint!;
    const event: BrowserCheckpointEvent = type === 'started' ? { type, definitionHash: hash, index, expectedRevision: before.revision } :
      { type, definitionHash: hash, index, expectedRevision: before.revision, result: result! };
    let saved: BrowserCheckpoint;
    try { saved = await withAbort(ctx.onBrowserCheckpoint!(event), clock.signal); }
    catch { checkAbort(clock.signal); fail('BROWSER_CHECKPOINT_UNCONFIRMED', 'The browser action checkpoint was not confirmed. Execution has stopped.', 409); }
    const nextIndex = type === 'completed' ? index + 1 : index;
    const state = type === 'started' ? 'started' : nextIndex === actions.length ? 'completed' : 'ready';
    if (!saved || saved.definitionHash !== hash || saved.revision !== before.revision + 1 || saved.nextIndex !== nextIndex || saved.state !== state)
      fail('BROWSER_CHECKPOINT_UNCONFIRMED', 'The browser action checkpoint acknowledgment does not match this execution.', 409);
    checkpoint = saved;
    await authorized();
  }
  let browser: Browser | undefined, context: BrowserContext | undefined, denyProxy: Server | undefined, navigationError: unknown;
  const proxySockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let owned: ReturnType<typeof ownBrowserServer> | undefined;
  const close = (force = false) => {
    for (const socket of proxySockets) socket.destroy();
    if (owned) {
      const pending = owned.close(force);
      closing ??= pending;
      // Keep the original rejection for finally, even if abort precedes navigation rejection.
      void pending.catch(() => {});
    }
  };
  const abortClose = () => close(true);
  clock.signal.addEventListener('abort', abortClose, { once: true });
  try {
    await authorized();
    await addressFor(url, allowed, clock.signal);
    await ctx.onProgress?.(10); checkAbort(clock.signal);
    // Native preconnect/background traffic can bypass page routes. It gets no network-capable proxy.
    denyProxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
    denyProxy.on('connect', (_request, socket) => socket.destroy());
    denyProxy.on('upgrade', (_request, socket) => socket.destroy());
    denyProxy.on('connection', socket => {
      proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket));
      socket.setTimeout(2_000); socket.on('timeout', () => socket.destroy());
    });
    denyProxy.maxConnections = 20;
    await new Promise<void>((resolve, reject) => { denyProxy!.once('error', reject); denyProxy!.listen(0, '127.0.0.1', resolve); });
    const proxyAddress = denyProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') fail('BROWSER_EXECUTION_FAILED', 'The browser network guard could not start.', 503);
    checkAbort(clock.signal);
    const browserServer = await chromium.launchServer({ host: '127.0.0.1', port: 0, headless: true, chromiumSandbox: true, timeout: Math.min(15_000, boundedNumber(env.PLATFORM_BROWSER_TIMEOUT_MS, 30_000, 500, 120_000)),
      env: { PATH: env.PATH || process.env.PATH || '/usr/bin:/bin' },
      proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
      ...(env.PLATFORM_BROWSER_EXECUTABLE ? { executablePath: env.PLATFORM_BROWSER_EXECUTABLE } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--disable-quic', '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    owned = ownBrowserServer(browserServer);
    checkAbort(clock.signal);
    // The unguessable control endpoint stays private to this task on loopback.
    // No exposeNetwork option is used; the original deny proxy and page routes remain in force.
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15_000 });
    checkAbort(clock.signal);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: true });
    context.setDefaultTimeout(10_000);
    await context.addInitScript({ content: BROWSER_ISOLATION_SCRIPT });
    await context.routeWebSocket('**/*', route => route.close());
    const page = await context.newPage();
    async function guardCounter(): Promise<number> {
      checkAbort(clock.signal);
      const state = await page.evaluate(() => ({
        ready: (globalThis as unknown as { __companionBrowserGuardReady: unknown }).__companionBrowserGuardReady,
        counter: (globalThis as unknown as { __companionBlockedSubmissions: unknown }).__companionBlockedSubmissions,
      }));
      checkAbort(clock.signal);
      if (state.ready !== true || !Number.isSafeInteger(state.counter) || Number(state.counter) < 0)
        fail('BROWSER_GUARD_UNAVAILABLE', 'The complete isolated page guard is unavailable.', 503);
      return state.counter as number;
    }
    page.on('dialog', dialog => { void dialog.dismiss(); });
    context.on('page', popup => { if (popup !== page) void popup.close(); });
    let renderedUrl = url.href;
    const budget: NetworkBudget = { requests: 0, bytes: 0 };
    await context.route('**/*', async route => {
      const request = route.request();
      const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
      try {
        if (!['GET', 'HEAD'].includes(request.method())) fail('BROWSER_METHOD_BLOCKED', 'Only GET and HEAD requests are allowed.');
        const data = await readUrl(parseUrl(request.url()), request.method(), allowed, budget, clock.signal);
        if (main) renderedUrl = data.finalUrl;
        await route.fulfill({ status: data.status, headers: data.headers, body: data.body });
      } catch (error) {
        if (main) navigationError = error;
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await guardCounter();
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await authorized(); if (navigationError) throw navigationError;
    await guardCounter();
    await ctx.onProgress?.(65);
    if (!actions.length) {
      const result = await captureBrowserResult(page, url.href, renderedUrl, 0);
      await guardCounter(); await authorized(); await ctx.onProgress?.(100); await authorized(); return result;
    }
    for (const [index, action] of actions.entries()) {
      await authorized(); await guardCounter(); navigationError = undefined;
      await persist(index, 'started');
      await authorized();
      const beforeSubmit = await guardCounter();
      await performBrowserAction(page, action);
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      await authorized(); if (navigationError) throw navigationError;
      const afterSubmit = await guardCounter();
      if (afterSubmit > beforeSubmit) fail('BROWSER_TARGET_BLOCKED', 'A form submission attempt was blocked. Review the page with user participation.', 409);
      const result = await captureBrowserResult(page, url.href, renderedUrl, index + 1);
      await guardCounter(); await authorized(); if (navigationError) throw navigationError;
      await persist(index, 'completed', result);
      await ctx.onProgress?.(Math.round(65 + (index + 1) / actions.length * 35));
    }
    return { artifacts: [] };
  } catch (error) {
    if (clock.signal.aborted) throw clock.signal.reason;
    // No raw URL/page/process errors enter public errors or application logs.
    if (error instanceof ProviderError) throw error;
    if (navigationError instanceof ProviderError) throw navigationError;
    throw new ProviderError('BROWSER_EXECUTION_FAILED', 'The reviewed page operation could not complete in the isolated browser.');
  } finally {
    const force = clock.signal.aborted;
    clock.signal.removeEventListener('abort', abortClose); clock.dispose();
    try { close(force); await closing; }
    finally {
      await context?.close().catch(() => {});
      for (const socket of proxySockets) socket.destroy();
      if (denyProxy?.listening) { denyProxy.closeAllConnections(); await new Promise<void>(resolve => denyProxy!.close(() => resolve())); }
    }
  }
}

function dockerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: env.PATH || process.env.PATH || '/usr/bin:/bin' };
  // HOME selects Docker Desktop/Colima client configuration. It is never a container -e variable.
  for (const key of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) if (env[key]) result[key] = env[key];
  return result;
}
async function docker(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, input?: string, outputLimit = MAX_OUTPUT_BYTES): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (signal?.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, env: dockerEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, failure: unknown;
    const abort = () => { failure = signal?.reason || cancelled(); child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) { failure = new ProviderError('CLI_OUTPUT_LIMIT', 'The CLI exceeded its output limit.', 413); child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => { signal?.removeEventListener('abort', abort); reject(new ProviderError('CLI_UNAVAILABLE', 'The Docker runtime is unavailable.', 503)); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ProviderError('CLI_EXECUTION_FAILED', 'The configured container command did not complete successfully.'));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input || '');
  });
}

const inputExtensions: Record<string, string> = {
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'application/json': '.json',
  'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/webm': '.webm',
  'audio/mp4': '.m4a', 'video/webm': '.webm', 'video/mp4': '.mp4',
};
async function privateDirectory(path: string, user: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path)
    fail('CLI_UNSAFE_FILE', 'A CLI input or output path is unsafe.');
  if (process.getuid?.() === 0) { const [uid, gid] = user.split(':').map(Number); await chown(path, uid, gid); }
}
async function stageAttachments(input: CreateJobInput, ctx: JobExecutionContext, workspace: string, user: string, signal: AbortSignal): Promise<string[]> {
  const ids = input.attachmentIds || [];
  if (!Array.isArray(ids) || ids.length > MAX_INPUT_FILES || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 200))
    fail('INVALID_PROVIDER_INPUT', 'CLI tasks support at most four distinct attached files.');
  if (ids.length && !ctx.readAttachment) fail('INVALID_PROVIDER_INPUT', 'Authorized attachment access is unavailable for this task.');
  const paths: string[] = []; let total = 0;
  for (const id of ids) {
    checkAbort(signal);
    // The server callback authorizes this attachment for ctx.userId. Never interpret names as host paths.
    const attachment = await withAbort(ctx.readAttachment!(id), signal);
    if (!(attachment.bytes instanceof Uint8Array)) fail('INVALID_PROVIDER_INPUT', 'An attached file is invalid.');
    total += attachment.bytes.byteLength;
    if (attachment.bytes.byteLength > MAX_INPUT_FILE_BYTES || total > MAX_INPUT_TOTAL_BYTES)
      fail('CLI_INPUT_LIMIT', 'CLI attachments exceed the size limit.', 413);
    const filename = randomUUID() + (Object.hasOwn(inputExtensions, attachment.mime) ? inputExtensions[attachment.mime] : '.bin');
    const handle = await open(join(workspace, 'input', filename), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(attachment.bytes);
      if (process.getuid?.() === 0) { const [uid, gid] = user.split(':').map(Number); await handle.chown(uid, gid); }
    } finally { await handle.close(); }
    paths.push(`/workspace/input/${filename}`);
  }
  return paths;
}
function materialMime(name: string, bytes: Buffer): string {
  const extension = extname(name).toLowerCase();
  const media = cliMediaMime(extension, bytes);
  if (media) return media;
  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (extension === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (extension === '.pdf' && bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (['.txt', '.md', '.csv', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.css', '.sql', '.yaml', '.yml', '.toml', '.sh'].includes(extension)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!bytes.includes(0)) return 'text/plain'; } catch { /* Download unknown or invalid bytes, never render executable markup. */ }
  }
  return 'application/octet-stream';
}
async function collectMaterials(workspace: string, signal: AbortSignal, collect = true): Promise<GeneratedArtifact[]> {
  const artifacts: GeneratedArtifact[] = [];
  let total = 0, entries = 0, files = 0;
  async function visit(path: string, relative: string, depth: number): Promise<void> {
    checkAbort(signal);
    const directory = await lstat(path);
    if (directory.isSymbolicLink() || !directory.isDirectory() || await realpath(path) !== path)
      fail('CLI_UNSAFE_FILE', 'CLI output may not contain links or special files.');
    const reader = await opendir(path);
    for await (const entry of reader) {
      checkAbort(signal);
      if (++entries > MAX_MATERIAL_ENTRIES) fail('CLI_MATERIAL_LIMIT', 'The CLI produced too many output entries.', 413);
      const child = join(path, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(child);
      if (info.isSymbolicLink()) fail('CLI_UNSAFE_FILE', 'CLI output may not contain links or special files.');
      if (info.isDirectory()) {
        if (depth >= MAX_MATERIAL_DEPTH) fail('CLI_MATERIAL_LIMIT', 'The CLI output directory exceeds the depth limit.', 413);
        await visit(child, name, depth + 1); continue;
      }
      if (!info.isFile() || info.nlink !== 1) fail('CLI_UNSAFE_FILE', 'CLI output may not contain links or special files.');
      if (++files > MAX_MATERIAL_FILES || info.size > MAX_MATERIAL_FILE_BYTES || total + info.size > MAX_MATERIAL_TOTAL_BYTES)
        fail('CLI_MATERIAL_LIMIT', 'The CLI output exceeds the file-count or size limit.', 413);
      if (!collect) { total += info.size; continue; }
      const handle = await open(child, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino)
          fail('CLI_UNSAFE_FILE', 'A CLI output file changed while being collected.');
        // A fixed buffer and an extra byte bound reads even if a file changes after lstat.
        const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_MATERIAL_FILE_BYTES + 1));
        let length = 0;
        while (length < buffer.length) {
          checkAbort(signal);
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > info.size || length > MAX_MATERIAL_FILE_BYTES || total + length > MAX_MATERIAL_TOTAL_BYTES)
          fail('CLI_MATERIAL_LIMIT', 'The CLI output exceeds the size limit.', 413);
        bytes = Buffer.from(buffer.subarray(0, length));
      } finally { await handle.close(); }
      total += bytes.length;
      // Generated download names never contain a host path, control character or path separator.
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'artifact.bin';
      artifacts.push({ name: `cli-output-${artifacts.length + 1}-${safeName}`, mime: materialMime(name, bytes), bytes });
    }
  }
  await visit(join(workspace, 'output'), '', 0);
  return artifacts;
}

/** Runs only a server-selected coding harness in an existing container image. */
export async function executeCli(input: CreateJobInput, ctx: JobExecutionContext, env: NodeJS.ProcessEnv): Promise<JobExecutionResult> {
  const image = env.PLATFORM_CLI_IMAGE;
  if (env.PLATFORM_ENABLE_CLI !== '1' || !image) fail('CLI_DISABLED', 'No isolated CLI image is configured on this server.', 503);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) fail('EXECUTOR_CONFIGURATION', 'The CLI image reference is invalid.', 503);
  let command: unknown;
  try { command = JSON.parse(env.PLATFORM_CLI_COMMAND || '["codex","exec","--json","--skip-git-repo-check","--sandbox","workspace-write","--ephemeral","-"]'); }
  catch { return fail('EXECUTOR_CONFIGURATION', 'The CLI command configuration is invalid.', 503); }
  if (!Array.isArray(command) || command.length < 1 || command.length > 32 || command.some(x => typeof x !== 'string' || x.length > 2048 || x.includes('\0')) ||
      !['codex', 'opencode'].includes(basename(command[0]))) fail('EXECUTOR_CONFIGURATION', 'The CLI must be a server-configured Codex or OpenCode command.', 503);
  if (basename(command[0]) === 'codex' && (command as string[]).slice(1).some(arg =>
      /^-(?:c|p|m)/.test(arg) || /^(?:--config|--profile|--model|--enable|--disable|--local-provider)(?:=|$)/.test(arg) || ['--ignore-user-config', '--oss'].includes(arg)))
    fail('EXECUTOR_CONFIGURATION', 'Codex configuration, feature, profile and model overrides must use the reviewed wrapper configuration.', 503);
  const externalSandbox = (command as string[]).some(arg => arg.includes('danger-full-access') || ['--dangerously-bypass-approvals-and-sandbox', '--yolo'].includes(arg));
  if (externalSandbox && (env.PLATFORM_CLI_EXTERNAL_SANDBOX !== '1' || basename(command[0]) !== 'codex'))
    fail('EXECUTOR_CONFIGURATION', 'Using Docker as the only coding sandbox requires an explicit server opt-in.', 503);
  if (input.options?.command !== undefined || input.options?.env !== undefined) fail('INVALID_PROVIDER_INPUT', 'User-defined commands and environment variables are not supported.');
  if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > MAX_TEXT_BYTES) fail('INVALID_PROVIDER_INPUT', 'The CLI prompt exceeds the input limit.');
  if (input.attachmentIds && (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > MAX_INPUT_FILES))
    fail('INVALID_PROVIDER_INPUT', 'CLI tasks support at most four distinct attached files.');
  const network = env.PLATFORM_CLI_NETWORK || 'none';
  if (network !== 'none') fail('EXECUTOR_CONFIGURATION', 'CLI containers must remain disconnected from external networks.', 503);
  const relay = env.PLATFORM_CLI_MODEL_RELAY === '1';
  if (relay && !ctx.requestModel) fail('CLI_MODEL_RELAY_UNAVAILABLE', 'This task has no authorized model relay.', 503);
  if (relay && basename(command[0]) !== 'codex') fail('EXECUTOR_CONFIGURATION', 'The stdio model relay currently supports Codex only.', 503);
  const relayModel = relay ? cliModelConfiguration(env).model : '';
  if (relay && !/^[a-zA-Z0-9._:/-]{1,160}$/.test(relayModel)) fail('EXECUTOR_CONFIGURATION', 'The server CLI model is invalid.', 503);
  const user = env.PLATFORM_CLI_USER || `${process.getuid?.() || 65532}:${process.getgid?.() || 65532}`;
  if (!/^[1-9][0-9]*:[0-9]+$/.test(user)) fail('EXECUTOR_CONFIGURATION', 'The CLI container must use a non-root numeric user.', 503);
  if (process.getuid && process.getuid() !== 0 && Number(user.split(':')[0]) !== process.getuid())
    fail('EXECUTOR_CONFIGURATION', 'The CLI numeric user must own its private workspace.', 503);
  const clock = deadline(ctx.signal, boundedNumber(env.PLATFORM_CLI_TIMEOUT_MS, 120_000, 500, 600_000));
  const suffix = createHash('sha256').update(JSON.stringify([ctx.userId, ctx.jobId])).digest('hex').slice(0, 24);
  const name = `companion-cli-${suffix}-${randomUUID().slice(0, 8)}`;
  let started = false, workspace: string | undefined, monitor: ReturnType<typeof setInterval> | undefined, monitoring: Promise<void> | undefined;
  try {
    checkAbort(clock.signal);
    // Resolve a locally installed immutable image ID. --pull=never below forbids automatic pulls.
    const inspected = await docker(['image', 'inspect', '--format', '{{.Id}}', image], env, clock.signal, undefined, 16 * 1024);
    const imageId = inspected.stdout.toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail('CLI_IMAGE_UNAVAILABLE', 'A valid locally installed CLI image is required.', 503);
    await mkdir(ctx.workspaceDirectory, { recursive: true, mode: 0o700 });
    if ((await lstat(ctx.workspaceDirectory)).isSymbolicLink()) fail('EXECUTOR_CONFIGURATION', 'The CLI workspace root must not be a symbolic link.', 503);
    const root = await realpath(ctx.workspaceDirectory);
    workspace = await mkdtemp(join(root, `cli-${suffix}-`));
    if ((await lstat(workspace)).isSymbolicLink() || !(await lstat(workspace)).isDirectory() || await realpath(workspace) !== workspace || /[,\n\r]/.test(workspace))
      fail('EXECUTOR_CONFIGURATION', 'The CLI workspace is invalid.', 503);
    if (process.getuid?.() === 0) { const [uid, gid] = user.split(':').map(Number); await chown(workspace, uid, gid); }
    await privateDirectory(join(workspace, 'input'), user); await privateDirectory(join(workspace, 'output'), user);
    const paths = await stageAttachments(input, ctx, workspace, user, clock.signal);
    const prompt = `${input.prompt}\n\nExecution workspace: /workspace/output\n${paths.length ? `Explicitly attached read-only input files:\n${paths.join('\n')}\n` : ''}Write deliverable files into /workspace/output. Only that directory is collected as downloadable output.`;
    await ctx.onProgress?.(10); await ctx.onProviderTask?.(name); checkAbort(clock.signal);
    const args = ['run', '--rm', '--name', name, '--pull=never', '--network', network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--user', user, '--log-driver', 'none', '--no-healthcheck',
      '--ulimit', `fsize=${MAX_MATERIAL_FILE_BYTES}:${MAX_MATERIAL_FILE_BYTES}`,
      '--workdir', '/workspace/output', '--mount', `type=bind,source=${workspace},target=/workspace,readonly,bind-recursive=disabled`,
      '--mount', `type=bind,source=${join(workspace, 'output')},target=/workspace/output,bind-recursive=disabled`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--init', '-i', '--entrypoint', relay ? 'node' : command[0], imageId,
      ...(relay ? ['/opt/companion/harness/relay-wrapper.mjs'] : command.slice(1))];
    // This is a soft aggregate limit; production workers must also enforce filesystem quotas.
    monitor = setInterval(() => {
      if (monitoring || clock.signal.aborted) return;
      monitoring = collectMaterials(workspace!, clock.signal, false).then(() => {}, error => {
        if (!clock.signal.aborted) clock.abort(error instanceof ProviderError ? error : new ProviderError('CLI_UNSAFE_FILE', 'CLI output could not be safely inspected.'));
      }).finally(() => { monitoring = undefined; });
    }, 100);
    started = true;
    const result = relay ? await executeCliRelay(args, dockerEnvironment(env), clock.signal, { prompt, model: relayModel, command: command as string[] }, ctx.requestModel!)
      : await docker(args, env, clock.signal, prompt);
    clearInterval(monitor); monitor = undefined; await monitoring; checkAbort(clock.signal);
    const materials = await collectMaterials(workspace, clock.signal);
    checkAbort(clock.signal); await ctx.onProgress?.(100);
    return { providerTaskId: name, text: result.stdout.toString('utf8').slice(0, MAX_TEXT_BYTES), artifacts: [
      { name: 'cli-stdout.txt', mime: 'text/plain', bytes: result.stdout },
      ...(result.stderr.length ? [{ name: 'cli-stderr.txt', mime: 'text/plain', bytes: result.stderr }] : []),
      ...materials,
    ] };
  } catch (error) {
    if (error instanceof ProviderError && error.code.startsWith('MODEL_RELAY_')) throw error;
    if (clock.signal.aborted) throw clock.signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('CLI_EXECUTION_FAILED', 'The isolated CLI task could not complete.');
  } finally {
    if (monitor) clearInterval(monitor);
    clock.dispose(); await monitoring;
    // Killing the docker client does not kill its container. Always remove the named container.
    if (started) {
      const cleanup = deadline(undefined, 5_000);
      try {
        try { await docker(['rm', '--force', name], env, cleanup.signal, undefined, 16 * 1024); }
        catch {
          // --rm may already have removed a completed container. Confirm absence, not a guessed stop.
          const remaining = await docker(['container', 'ls', '--all', '--filter', `name=${name}`, '--format', '{{.Names}}'], env, cleanup.signal, undefined, 16 * 1024);
          if (remaining.stdout.toString().trim()) throw new Error('Container remains');
        }
      } catch {
        throw new ProviderError('CLI_CLEANUP_UNCONFIRMED', 'Container shutdown could not be confirmed. Review the execution before retrying.', 503);
      } finally { cleanup.dispose(); }
    }
    // Only remove the private bind after container absence is confirmed. Durable artifacts are returned as bytes.
    if (workspace) {
      try { await rm(workspace, { recursive: true, force: true }); }
      catch { throw new ProviderError('CLI_WORKSPACE_CLEANUP_FAILED', 'The temporary execution files could not be removed.', 503); }
    }
  }
}

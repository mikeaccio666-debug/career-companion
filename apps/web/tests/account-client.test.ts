import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createPlatformClient, isPublicPlatformRequest, type StreamEvent } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const artifact = '/api/platform/artifacts/30000000-0000-4000-8000-000000000003';
function context() { const value = new AccountRequestContext(); value.changeSession(A); return value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const endpoints = createPlatformEndpoints('https://api.example.test');

test('public exemptions are exact method/path pairs; missing private context sends nothing', async () => {
  for (const path of ['/health', '/live', '/ready', '/execution-ready', '/capabilities', '/auth/options', '/auth/me']) assert.equal(isPublicPlatformRequest(path), true);
  for (const path of ['/auth/login', '/auth/register', '/auth/password-reset/request', '/auth/password-reset/complete']) assert.equal(isPublicPlatformRequest(path, 'POST'), true);
  for (const path of ['/live', '/ready', '/execution-ready']) {
    assert.equal(isPublicPlatformRequest(path, 'HEAD'), true);
    assert.equal(isPublicPlatformRequest(path, 'POST'), false);
    assert.equal(isPublicPlatformRequest(path + '?alias=1', 'GET'), false);
  }
  for (const [path, method] of [['/auth/logout', 'POST'], ['/auth/email-verification/request', 'POST'], ['/auth/email-verification/complete', 'POST'], ['/auth/me', 'POST'], ['/auth/login', 'GET'], ['/auth/me?alias=1', 'GET'], ['/jobs', 'GET']]) assert.equal(isPublicPlatformRequest(path, method), false);
  let calls = 0; const scope = new AccountRequestContext(), client = createPlatformClient(endpoints, async (_, init) => { calls++; assert.equal(new Headers(init?.headers).has(PLATFORM_ACCOUNT_HEADER), false); return Response.json({ user: null }); }, scope);
  await client.request('/auth/me', { headers: { [PLATFORM_ACCOUNT_HEADER]: B } });
  await assert.rejects(client.request('/jobs'), (error) => error instanceof ApiError && error.code === 'ACCOUNT_CONTEXT_REQUIRED'); assert.equal(calls, 1);
});

test('bound deferred callbacks never read a new global account; custom assertion headers cannot replace A', async () => {
  const scope = context(); let calls = 0;
  const client = createPlatformClient(endpoints, async (_, init) => { calls++; assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), A); return Response.json({ ok: true }); }, scope);
  const AClient = client.capture(); await AClient.request('/jobs', { headers: { [PLATFORM_ACCOUNT_HEADER]: B } });
  const later = () => AClient.post('/conversations', { title: 'Fictional A draft.' }); scope.changeSession(B);
  await assert.rejects(later(), { name: 'AbortError' }); assert.equal(calls, 1); assert.equal(AClient.isCurrent(), false); assert.equal(AClient.privateFileUrl(artifact), undefined);
});

test('switching account promptly aborts a request even if fetch ignores abort; late A response cannot invalidate B', async () => {
  const scope = context(), fetch = deferred<Response>(); let requestSignal!: AbortSignal;
  const client = createPlatformClient(endpoints, async (_, init) => { requestSignal = init!.signal!; return fetch.promise; }, scope);
  const pending = client.request('/jobs'); scope.changeSession(B); assert.equal(requestSignal.aborted, true);
  await assert.rejects(pending, { name: 'AbortError' }); const before = scope.getSnapshot();
  fetch.resolve(Response.json({ error: { code: 'ACCOUNT_CONTEXT_CHANGED' } }, { status: 409 })); await Promise.resolve(); await Promise.resolve(); assert.equal(scope.getSnapshot(), before);
});

test('private 401 and both account 409 errors synchronously invalidate; public auth/me 401 stays anonymous bootstrap', async () => {
  for (const [status, code, reason] of [[409, 'ACCOUNT_CONTEXT_CHANGED', 'account-context-changed'], [409, 'ACCOUNT_CONTEXT_REQUIRED', 'account-context-required'], [401, 'AUTH_REQUIRED', 'authentication-required']] as const) {
    const scope = context(); let observed = '';
    const client = createPlatformClient(endpoints, async () => Response.json({ error: { code, message: 'Fictional mismatch.' } }, { status }), scope);
    scope.subscribeInvalidation((value) => { observed = value; assert.equal(scope.getSnapshot().accountId, null); });
    await assert.rejects(client.request('/jobs'), (error) => error instanceof ApiError && error.status === status && error.code === code); assert.equal(observed, reason);
  }
  const scope = context(), before = scope.getSnapshot(), client = createPlatformClient(endpoints, async () => Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }), scope);
  await assert.rejects(client.request('/auth/me'), (error) => error instanceof ApiError && error.status === 401); assert.equal(scope.getSnapshot(), before);
});

test('SSE stops between same-chunk events after a session change and never publishes old completion', async () => {
  const scope = context(), events: StreamEvent[] = [];
  const client = createPlatformClient(endpoints, async (_, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), A);
    return new Response('event: delta\ndata: {"text":"Fictional A partial."}\n\nevent: done\ndata: {"text":"Fictional A completion."}\n\n');
  }, scope);
  await assert.rejects(client.streamMessage('fictional', {}, new AbortController().signal, (event) => { events.push(event); scope.changeSession(B); }), { name: 'AbortError' });
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'Fictional A partial.' } }]); assert.equal(scope.getSnapshot().accountId, B);
});

test('waiting SSE is canceled synchronously even if its underlying response stream ignores the fetch signal', async () => {
  const scope = context(); let canceled = false, fetched!: () => void; const ready = new Promise<void>((resolve) => { fetched = resolve; });
  const client = createPlatformClient(endpoints, async () => { fetched(); return new Response(new ReadableStream({ cancel() { canceled = true; } })); }, scope);
  const events: StreamEvent[] = [], pending = client.streamMessage('fictional', {}, new AbortController().signal, (event) => events.push(event));
  await ready; await Promise.resolve(); await Promise.resolve(); scope.invalidate('external-auth-change');
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(canceled, true); assert.deepEqual(events, []);
});

test('narrow stale cleanup preserves A assertion and never invalidates B or permits unrelated writes', async () => {
  const scope = context(), seen: string[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => { seen.push(String(url)); assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), A); assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error'); assert.equal(init?.keepalive, true); assert.equal(init?.method, 'POST'); return Response.json({ error: { code: 'ACCOUNT_CONTEXT_CHANGED' } }, { status: 409 }); }, scope);
  const fixed = client.capture(); scope.changeSession(B); const before = scope.getSnapshot();
  await assert.rejects(fixed.cleanup('/auth/logout'), (error) => error instanceof ApiError && error.code === 'ACCOUNT_CONTEXT_CHANGED');
  await assert.rejects(fixed.cleanup('/voice/session/release', { body: JSON.stringify({ sessionId: '30000000-0000-4000-8000-000000000003' }) }));
  await assert.rejects(fixed.cleanup('/jobs' as any), /清理路径无效/); await assert.rejects(fixed.cleanup('/auth/logout', { method: 'GET' }), /清理路径无效/);
  assert.equal(scope.getSnapshot(), before); assert.equal(seen.length, 2);
});

test('private text file reads use only fixed platform UUID URLs with both assertions and discard late content', async () => {
  const scope = context(); let body!: ReadableStreamDefaultController<Uint8Array>, fetched!: () => void;
  const ready = new Promise<void>((resolve) => { fetched = resolve; }); let calls = 0;
  const client = createPlatformClient(endpoints, async (url, init) => { calls++; assert.equal(url, `https://api.example.test${artifact}?expectedAccount=${A}`); assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), A); fetched(); return new Response(new ReadableStream({ start(value) { body = value; } })); }, scope);
  const fixed = client.capture();
  await assert.rejects(fixed.readPrivateFileText('https://external.example.invalid/SDP'), /私人文件地址无效/); assert.equal(calls, 0);
  const pending = fixed.readPrivateFileText(artifact); await ready; scope.changeSession(B); await assert.rejects(pending, { name: 'AbortError' });
  body.enqueue(new TextEncoder().encode('Fictional A-only secret.')); body.close(); assert.equal(scope.getSnapshot().accountId, B); assert.equal(calls, 1);
});

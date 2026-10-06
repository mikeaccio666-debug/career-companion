import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformClient, request, subscribeAuthResponseHeaders, type SuccessfulAuthResponse } from '../src/api.ts';
import { AccountRequestContext, platformAccountContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const endpoints = createPlatformEndpoints();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('each successful cookie-changing auth response notifies at headers even when body decoding rejects', async () => {
  for (const path of ['/auth/login', '/auth/register', '/auth/password-reset/complete']) {
    const events: SuccessfulAuthResponse[] = [], scope = new AccountRequestContext(), before = scope.getSnapshot();
    const client = createPlatformClient(endpoints, async () => new Response(new ReadableStream({ start(body) { body.error(new Error('Fictional body unavailable.')); } })), scope, { onAuthResponseHeaders: (event) => events.push(event) });
    await assert.rejects(client.request(path, { method: 'POST', body: '{}' }), /Fictional body unavailable/);
    assert.deepEqual(events, [{ path }]); assert.deepEqual(Object.keys(events[0]), ['path']); assert.equal(scope.getSnapshot(), before);
  }
});

test('body cancellation promptly rejects but cannot retract the already emitted cookie notification', async () => {
  const scope = new AccountRequestContext(), controller = new AbortController(), headers = deferred<void>(); let content!: ReadableStreamDefaultController<Uint8Array>;
  let notifications = 0;
  const client = createPlatformClient(endpoints, async () => new Response(new ReadableStream({ start(value) { content = value; } })), scope, { onAuthResponseHeaders() { notifications++; headers.resolve(); } });
  const pending = client.request('/auth/login', { method: 'POST', body: '{}', signal: controller.signal });
  await headers.promise; assert.equal(notifications, 1); assert.equal(scope.getSnapshot().accountId, null);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  content.enqueue(new TextEncoder().encode(JSON.stringify({ user: { id: A } }))); content.close(); await Promise.resolve(); assert.equal(notifications, 1); assert.equal(scope.getSnapshot().accountId, null);
});

test('already aborted at successful header arrival still notifies before rejecting, without accepting identity', async () => {
  const controller = new AbortController(), scope = new AccountRequestContext(), events: SuccessfulAuthResponse[] = [];
  const client = createPlatformClient(endpoints, async () => { controller.abort(); return Response.json({ user: { id: A } }); }, scope, { onAuthResponseHeaders: (event) => events.push(event) });
  await assert.rejects(client.request('/auth/register', { method: 'POST', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(events, [{ path: '/auth/register' }]); assert.equal(scope.getSnapshot().accountId, null);
});

test('stale successful auth headers invalidate the local newer session, notify others once, and discard old identity', async () => {
  const scope = new AccountRequestContext(); scope.changeSession(A); const response = deferred<Response>(), headers = deferred<void>();
  const seen: string[] = [], client = createPlatformClient(endpoints, async () => response.promise, scope, { onAuthResponseHeaders(event) { assert.equal(scope.getSnapshot().accountId, null); seen.push(event.path); headers.resolve(); } });
  scope.subscribeInvalidation((reason) => seen.push(reason));
  const pending = client.request('/auth/login', { method: 'POST', body: '{}' }); scope.changeSession(B);
  response.resolve(Response.json({ user: { id: A } })); await headers.promise;
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(seen, ['local-auth-change', '/auth/login']); assert.equal(scope.getSnapshot().accountId, null);
});

test('session change during a delayed auth body rejects the old result and never establishes its identity', async () => {
  const scope = new AccountRequestContext(), headers = deferred<void>(); let content!: ReadableStreamDefaultController<Uint8Array>;
  const client = createPlatformClient(endpoints, async () => new Response(new ReadableStream({ start(value) { content = value; } })), scope, { onAuthResponseHeaders() { headers.resolve(); } });
  const pending = client.request('/auth/login', { method: 'POST' }); await headers.promise; scope.changeSession(B);
  content.enqueue(new TextEncoder().encode(JSON.stringify({ user: { id: A } }))); content.close();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(scope.getSnapshot().accountId, B);
});

test('failed auth responses and read-only bootstrap/reset-request successes never announce cookie changes', async () => {
  let notifications = 0;
  for (const status of [400, 401, 409, 500]) {
    const client = createPlatformClient(endpoints, async () => Response.json({ error: { code: 'FIXTURE_REJECTED' } }, { status }), new AccountRequestContext(), { onAuthResponseHeaders() { notifications++; } });
    for (const path of ['/auth/login', '/auth/register', '/auth/password-reset/complete']) await assert.rejects(client.request(path, { method: 'POST' }));
  }
  const client = createPlatformClient(endpoints, async () => Response.json({ ok: true }), new AccountRequestContext(), { onAuthResponseHeaders() { notifications++; } });
  for (const path of ['/auth/me', '/auth/options', '/health', '/capabilities']) await client.request(path);
  await client.request('/auth/password-reset/request', { method: 'POST' }); assert.equal(notifications, 0);
});

test('throwing or rejected notification sinks cannot produce unhandled activity or reinterpret authentication', async () => {
  for (const observer of [() => { throw new Error('Fictional notification failed.'); }, async () => { throw new Error('Fictional asynchronous notification failed.'); }]) {
    const scope = new AccountRequestContext(), before = scope.getSnapshot();
    const client = createPlatformClient(endpoints, async () => Response.json({ user: { id: A } }), scope, { onAuthResponseHeaders: observer });
    assert.deepEqual(await client.request('/auth/login', { method: 'POST' }), { user: { id: A } }); assert.equal(scope.getSnapshot(), before);
  }
});

test('the real singleton uses a removable neutral event port, without importing session UI or adopting user data', async () => {
  const originalFetch = globalThis.fetch, events: SuccessfulAuthResponse[] = [], before = platformAccountContext.getSnapshot();
  const stop = subscribeAuthResponseHeaders((event) => events.push(event));
  globalThis.fetch = async () => Response.json({ user: { id: A } });
  try {
    await request('/auth/login', { method: 'POST' }); assert.deepEqual(events, [{ path: '/auth/login' }]); assert.equal(platformAccountContext.getSnapshot(), before);
    stop(); await request('/auth/register', { method: 'POST' }); assert.equal(events.length, 1);
  } finally { stop(); globalThis.fetch = originalFetch; }
});

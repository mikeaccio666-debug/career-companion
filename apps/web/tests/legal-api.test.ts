import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { acceptStudentConsent, readPublicLegalDocuments, readStudentConsent } from '../src/legal-api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { AccountOperationScope, executeAccountOperation } from '../src/account-operations.ts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const acceptance = { accepted: true as const, version: 'fictional-v1', digest: 'a'.repeat(64) }, consent = { userId: A, status: 'current' as const, version: acceptance.version, digest: acceptance.digest };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const endpoints = createPlatformEndpoints('https://api.example.invalid');

test('anonymous legal reads carry no account assertion; account-bound consent requests carry exact version and owner', async () => {
  const context = new AccountRequestContext(), seen: { path: string; method: string; account: string | null; body?: string }[] = [];
  let cookieNotifications = 0;
  const client = createPlatformClient(endpoints, async (url, init) => {
    seen.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', account: new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), body: init?.body as string | undefined });
    return Response.json(String(url).endsWith('/auth/legal-documents') ? { status: 'unavailable' } : { consent });
  }, context, { onAuthResponseHeaders() { cookieNotifications++; } });
  assert.deepEqual(await readPublicLegalDocuments(undefined, client.request), { status: 'unavailable' });
  await assert.rejects(client.request('/auth/consent')); assert.equal(seen.length, 1);
  context.changeSession(A); const fixed = client.capture(); assert.deepEqual(await readStudentConsent(fixed), consent); assert.deepEqual(await acceptStudentConsent(fixed, acceptance), consent);
  assert.deepEqual(seen, [
    { path: '/api/platform/auth/legal-documents', method: 'GET', account: null, body: undefined },
    { path: '/api/platform/auth/consent', method: 'GET', account: A, body: undefined },
    { path: '/api/platform/auth/consent', method: 'POST', account: A, body: JSON.stringify(acceptance) },
  ]); assert.equal(cookieNotifications, 0);
});

test('late consent success or 401 cannot apply, invalidate or finish loading for a later account or same-account generation', async () => {
  for (const next of [A, B]) for (const status of [200, 401]) {
    const context = new AccountRequestContext(); context.changeSession(A); const response = deferred<Response>();
    const client = createPlatformClient(endpoints, async () => response.promise, context), fixed = client.capture();
    const scope = new AccountOperationScope(); scope.changeSession(A); let applied = 0, failed = 0, finished = 0;
    const result = executeAccountOperation(scope, scope.begin('student-consent')!, () => acceptStudentConsent(fixed, acceptance), { apply: () => applied++, onError: () => failed++, finally: () => finished++ });
    context.changeSession(next); scope.changeSession(next); const before = context.getSnapshot();
    response.resolve(Response.json(status === 200 ? { consent } : { error: { code: 'AUTH_REQUIRED' } }, { status }));
    assert.deepEqual(await result, { status: 'discarded' }); assert.deepEqual([applied, failed, finished], [0, 0, 0]); assert.equal(context.getSnapshot(), before);
    await assert.rejects(acceptStudentConsent(fixed, acceptance), { name: 'AbortError' });
  }
});

test('a different response owner and incomplete current record cannot establish consent', async () => {
  for (const value of [{ ...consent, userId: B }, { ...consent, digest: null }]) {
    const context = new AccountRequestContext(); context.changeSession(A);
    const client = createPlatformClient(endpoints, async () => Response.json({ consent: value }), context);
    await assert.rejects(readStudentConsent(client.capture()));
  }
});

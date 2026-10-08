import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER, type CompanionNamingAccepted, type CompanionNamingProgress } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { acceptCompanionNaming, parseCompanionNamingAccepted, parseCompanionNamingInput, parseCompanionNamingProgress,
  parseCompanionNamingRequest, parseCompanionNamingState, readCompanionNaming, readCompanionNamingOperation } from '../src/companion-naming-api.ts';

const id = (n: number) => `22000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = id(1), taskId = id(2), submissionId = id(3), dispatchId = id(4), operationId = id(5), companionId = id(6);
const endpoints = createPlatformEndpoints('https://api.example.invalid');
const command = { taskId, expectedEntryRevision: 0, expectedIdentityRevision: 0, operationId, name: '  Fictional raw name\n第二行  ' };
const pending: CompanionNamingProgress = { dispatchId, taskId, submissionId, submittedRevision: 1, phase: 'queued', hold: null,
  detection: { status: 'pending', generation: 0, level: null, mode: null },
  application: { status: 'pending', rejectedCategory: null, identityRevision: null }, resource: 'not_determined' };
const accepted: CompanionNamingAccepted = { acceptance: { dispatchId, taskId, submissionId,
  operation: { id: operationId, appliedRevision: 1, replayed: false } }, progress: pending };
const state = { kind: 'naming', entry: { taskId, companionId, revision: 1, latestSubmissionId: submissionId }, latest: pending };
function scope() { const context = new AccountRequestContext(); context.changeSession(account); return context; }

test('raw naming transport preserves blank, multiline, Unicode and semantically invalid names within exact UTF8 bounds', () => {
  for (const name of ['', '   ', '\r\n', '  Juno  ', '妈妈', '\u0000raw', '😀'.repeat(1024), 'a'.repeat(4096)]) {
    const parsed = parseCompanionNamingRequest({ ...command, name });
    assert.equal(parsed.name, name); assert.equal(Object.isFrozen(parsed), true);
    const { operationId: _, ...input } = { ...command, name };
    assert.deepEqual(parseCompanionNamingInput(input), input);
  }
  for (const name of ['a'.repeat(4097), '😀'.repeat(1025), '\ud800', '\udfff'])
    assert.throws(() => parseCompanionNamingRequest({ ...command, name }));
});

test('closed naming input captures descriptors and rejects authority or noncanonical coordinates without executing getters', () => {
  let evaluated = 0;
  const getter = Object.defineProperty({ ...command }, 'name', { enumerable: true, get() { evaluated++; return 'Fictional'; } });
  for (const input of [getter, { ...command, handled: true }, { ...command, provider: 'openai' }, { ...command, [Symbol('extra')]: 1 },
    { ...command, operationId: operationId + '\n' }, { ...command, taskId: id(0xab).toUpperCase() },
    { ...command, expectedEntryRevision: -0 }, { ...command, expectedIdentityRevision: 2147483647 },
    { ...command, expectedEntryRevision: 0.5 }, Object.create(command), new Date()])
    assert.throws(() => parseCompanionNamingRequest(input));
  assert.equal(evaluated, 0);
  const data = { ...command }; const parsed = parseCompanionNamingRequest(data); data.name = 'Changed fictional input';
  assert.equal(parsed.name, command.name);
});

test('observed naming phases reject fabricated classification, application or resource readiness', () => {
  const detected: CompanionNamingProgress = { ...pending, phase: 'detected',
    detection: { status: 'detected', generation: 1, level: 'L0', mode: 'full' },
    application: { status: 'applied', rejectedCategory: null, identityRevision: 1 }, resource: 'not_required' };
  const held: CompanionNamingProgress = { ...detected, phase: 'held', hold: 'authorization_required' };
  for (const input of [pending, detected, held, { ...pending, phase: 'checking', detection: { ...pending.detection, status: 'running', generation: 1 } },
    { ...pending, phase: 'held', hold: 'requires_review', detection: { ...pending.detection, generation: 1 } },
    { ...detected, detection: { ...detected.detection, level: 'L2', mode: 'keyword_only' }, application: { ...pending.application, status: 'not_eligible' }, resource: 'ready' }]) {
    const parsed = parseCompanionNamingProgress(input); assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed.detection), true); assert.equal(Object.isFrozen(parsed.application), true);
  }
  for (const input of [{ ...pending, rawName: 'Private fictional input' }, { ...pending, phase: 'complete' }, { ...pending, resource: 'not_required' },
    { ...pending, hold: 'requires_review' }, { ...pending, phase: 'held' }, { ...pending, phase: 'checking' },
    { ...pending, detection: { ...pending.detection, level: 'L0' } }, { ...pending, detection: { ...pending.detection, status: 'running' } },
    { ...detected, detection: { ...detected.detection, mode: 'keyword_only' } },
    { ...detected, application: { ...detected.application, identityRevision: null } },
    { ...pending, application: detected.application }, { ...detected, resource: 'ready' },
    { ...detected, application: { ...detected.application, rejectedCategory: 'length' } },
    { ...detected, application: { status: 'name_rejected', rejectedCategory: null, identityRevision: null } }])
    assert.throws(() => parseCompanionNamingProgress(input));
  let evaluated = 0;
  const getter = Object.defineProperty({ ...pending.detection }, 'status', { enumerable: true, get() { evaluated++; return 'detected'; } });
  assert.throws(() => parseCompanionNamingProgress({ ...pending, detection: getter })); assert.equal(evaluated, 0);
});

test('state and acceptance codecs bind genuine returned coordinates and keep current-head and own-operation projections separate', () => {
  assert.deepEqual(parseCompanionNamingAccepted(accepted), accepted);
  assert.deepEqual(parseCompanionNamingState(state), state);
  assert.deepEqual(parseCompanionNamingState({ kind: 'not_started' }), { kind: 'not_started' });
  assert.deepEqual(parseCompanionNamingState({ ...state, latest: null }), { ...state, latest: null });
  for (const input of [{ ...accepted, name: 'Private fictional' }, { ...accepted, progress: { ...pending, dispatchId: id(9) } },
    { ...accepted, acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, appliedRevision: 2 } } }])
    assert.throws(() => parseCompanionNamingAccepted(input));
  for (const input of [{ ...state, latest: { ...pending, taskId: id(9) } }, { ...state, entry: { ...state.entry, revision: 2 } },
    { kind: 'not_started', permitted: true }, { ...state, entry: { ...state.entry, originalSessionHash: 'fictional-private' } }])
    assert.throws(() => parseCompanionNamingState(input));
});

test('captured naming client sends exact raw input and binds every GET and POST to its original account', async () => {
  const context = scope(), seen: { path: string; method: string; body: unknown }[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), account);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    seen.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(init?.method === 'POST' ? accepted : path.endsWith(operationId) ? { accepted } : { state });
  }, context).capture();
  const mutable = { ...command }; const submitted = acceptCompanionNaming(client, mutable); mutable.name = 'Later fictional input';
  assert.deepEqual(await submitted, accepted);
  assert.deepEqual(await readCompanionNaming(client), state);
  assert.deepEqual(await readCompanionNamingOperation(client, operationId), accepted);
  assert.deepEqual(seen, [
    { path: '/companion/naming/submissions', method: 'POST', body: command },
    { path: '/companion/naming', method: 'GET', body: null },
    { path: '/companion/naming/submissions/' + operationId, method: 'GET', body: null },
  ]);
  context.changeSession(id(99));
  await assert.rejects(readCompanionNaming(client), { name: 'AbortError' });
  await assert.rejects(readCompanionNamingOperation(client, operationId), { name: 'AbortError' });
  await assert.rejects(acceptCompanionNaming(client, command), { name: 'AbortError' }); assert.equal(seen.length, 3);
});

test('wrong operation, cross-task receipts and private response fields are refused rather than displayed as accepted', async () => {
  for (const data of [{ ...accepted, acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, id: id(9) } } },
    { ...accepted, acceptance: { ...accepted.acceptance, taskId: id(9) }, progress: { ...pending, taskId: id(9) } },
    { ...accepted, progress: { ...pending, submittedRevision: 2 }, acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, appliedRevision: 2 } } },
    { ...accepted, sourceCipher: 'fictional-private' }]) {
    const client = createPlatformClient(endpoints, async () => Response.json(data), scope()).capture();
    await assert.rejects(acceptCompanionNaming(client, command));
  }
  const wrong = { ...accepted, acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, id: id(9) } } };
  const client = createPlatformClient(endpoints, async () => Response.json({ accepted: wrong }), scope()).capture();
  await assert.rejects(readCompanionNamingOperation(client, operationId));
  const absent = createPlatformClient(endpoints, async () => Response.json({ accepted: null }), scope()).capture();
  assert.equal(await readCompanionNamingOperation(absent, operationId), null);
});

test('pre-aborted naming requests, malformed IDs and accessor commands make no network request', async () => {
  let requests = 0, evaluated = 0;
  const client = createPlatformClient(endpoints, async () => { requests++; return Response.json(accepted); }, scope()).capture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(acceptCompanionNaming(client, command, abort.signal), { name: 'AbortError' });
  await assert.rejects(readCompanionNaming(client, abort.signal), { name: 'AbortError' });
  await assert.rejects(readCompanionNamingOperation(client, operationId, abort.signal), { name: 'AbortError' });
  await assert.rejects(readCompanionNamingOperation(client, operationId + '\n'));
  const getter = Object.defineProperty({ ...command }, 'name', { enumerable: true, get() { evaluated++; return ''; } });
  await assert.rejects(acceptCompanionNaming(client, getter)); assert.equal(evaluated, 0); assert.equal(requests, 0);
});

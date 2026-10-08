import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { actSafetyResource, claimSafetyQuestion, parseSafetyBodyProjection, parseSafetyQuestionClaim,
  parseSafetyQuestionReservation, parseSafetyQuestionState, parseSafetyResourceBody, parseSafetyResourceIndex,
  parseSafetyResourceState, presentSafetyQuestion, publishSafetyResource, readSafetyBody, readSafetyQuestion,
  readSafetyResource, readSafetyResources, reserveSafetyQuestion, safetyResourceHref } from '../src/safety-resource-api.ts';
import { at, body, claim, grantToken, id, projection, questionState, receipt, reservationToken, resourceState } from './fixtures/safety-resource.ts';

const target = { sourceKind: 'companion_name' as const, publicationId: id(3) };
const sourceRef = { kind: target.sourceKind, submissionId: id(4) };
const endpoints = createPlatformEndpoints('https://api.example.invalid');
function clientFor(response: (path: string, init: RequestInit, data: any) => unknown | Promise<unknown>) {
  const context = new AccountRequestContext(); context.changeSession(id(1));
  const calls: { path: string; method: string; data: any }[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), id(1)); assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    const path = new URL(String(url)).pathname.replace('/api/platform', ''), data = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method: init?.method ?? 'GET', data }); return Response.json(await response(path, init!, data));
  }, context).capture();
  return { client, context, calls };
}
test('support transport binds the genuine account client and exact closed source-aware routes without old039 calls', async () => {
  const h = clientFor((path, _, d) => {
    if (path === '/companion/support') return { index: { sources: [{ sourceRef, availability: 'ready', publication: resourceState() }] } };
    if (path.includes('/publications')) return { publication: { ...target, submissionId: id(4), edition: 1, replayed: false } };
    if (path === '/companion/support/body') return { projection: projection() };
    if (path === '/companion/support/actions') return { result: { state: resourceState({ revision: 1, presented: true }),
      operation: { id: d.operationId, appliedRevision: 1, replayed: false }, presentationReceipt: receipt } };
    if (path.includes('/questions/')) return { state: questionState() };
    return { state: resourceState() };
  });
  assert.equal((await readSafetyResources(h.client)).sources.length, 1);
  await publishSafetyResource(h.client, { sourceRef, operationId: id(10), expectedEdition: 0 });
  await publishSafetyResource(h.client, { sourceRef, operationId: id(11), expectedEdition: 1 }, true);
  await readSafetyResource(h.client, target); await readSafetyBody(h.client, target); await readSafetyQuestion(h.client, target);
  const command = { ...target, operationId: id(12), expectedPublicationRevision: 0, action: { kind: 'present_body' as const, bodyProjectionId: id(5) } };
  assert.equal((await actSafetyResource(h.client, command)).presentationReceipt, receipt);
  assert.deepEqual(h.calls.map(x => [x.method, x.path]), [['GET', '/companion/support'], ['POST', '/companion/support/publications'],
    ['POST', '/companion/support/publications/recovery'], ['GET', `/companion/support/companion_name/${id(3)}`],
    ['POST', '/companion/support/body'], ['GET', `/companion/support/questions/companion_name/${id(3)}`], ['POST', '/companion/support/actions']]);
  assert.deepEqual(h.calls[1].data, { sourceRef, operationId: id(10), expectedEdition: 0 }); assert.deepEqual(h.calls[4].data, target);
});
test('body, index, state, question read and reservations reject embedded questions, secrets, legacy exposure payloads and caller authority', () => {
  const p = projection(), s = resourceState();
  for (const extra of [{ question: 'Fictional question?' }, { grantPresentationToken: grantToken }, { reviewed: true }, { rawText: 'Fictional raw' }]) {
    assert.throws(() => parseSafetyResourceBody({ ...body, ...extra })); assert.throws(() => parseSafetyBodyProjection({ ...p, ...extra }));
    assert.throws(() => parseSafetyResourceState({ ...s, ...extra })); assert.throws(() => parseSafetyQuestionState({ ...questionState(), ...extra }));
  }
  assert.throws(() => parseSafetyResourceIndex({ sources: [{ sourceRef, availability: 'ready', publication: { ...s, response: body } }] }));
  assert.throws(() => parseSafetyResourceIndex({ sources: [{ sourceRef, availability: 'ready', publication: s }, { sourceRef, availability: 'ready', publication: s }] }));
  assert.throws(() => parseSafetyResourceIndex({ sources: [{ sourceRef: { ...sourceRef, kind: 'onboarding' }, availability: 'ready', publication: s }] }));
  const r = { ...target, occurrenceId: id(6), reservationId: id(8), generation: 1, reservedUntil: at, scopeRevision: 1,
    reservationToken, operation: { id: id(10), appliedRevision: 1, replayed: false } };
  assert.throws(() => parseSafetyQuestionReservation({ ...r, question: 'Fictional forbidden question?' }));
  assert.throws(() => parseSafetyQuestionReservation({ ...r, operation: { ...r.operation, replayed: true } }));
});
test('accessors and sparse/exotic arrays are rejected without evaluation and every parsed body is an immutable detached snapshot', () => {
  let called = false; const value = { ...body }; Object.defineProperty(value, 'text', { enumerable: true, get() { called = true; return 'Fictional'; } });
  assert.throws(() => parseSafetyResourceBody(value)); assert.equal(called, false);
  const contacts = [...body.resourceCard.contacts]; Object.defineProperty(contacts, '0', { enumerable: true, get() { called = true; return body.resourceCard.contacts[0]; } });
  assert.throws(() => parseSafetyResourceBody({ ...body, resourceCard: { ...body.resourceCard, contacts } })); assert.equal(called, false);
  assert.throws(() => parseSafetyResourceBody({ ...body, resourceCard: { ...body.resourceCard, contacts: new Array(1) } }));
  const snapshot = parseSafetyResourceBody(body); assert.notEqual(snapshot.resourceCard.contacts, body.resourceCard.contacts);
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.resourceCard) && Object.isFrozen(snapshot.resourceCard.contacts[0].actions[0]));
});
test('resource links are validated and SMS text is encoded without manufacturing contact actions', () => {
  for (const url of ['javascript:alert(1)', 'http://example.com/', 'https://user:password@example.com/'])
    assert.throws(() => safetyResourceHref({ kind: 'web', url, label: 'Fictional' }));
  assert.throws(() => safetyResourceHref({ kind: 'call', number: '123456?body=external', label: 'Fictional' }));
  assert.equal(safetyResourceHref({ kind: 'sms', number: '123456', body: 'A&B + C', label: 'Fictional' }), 'sms:123456?body=A%26B%20%2B%20C');
});
test('question claims are bound to the actual target, owner, generation and operation and nonlive claims carry no question or token', async () => {
  const command = { operationId: id(10), occurrenceId: id(6), reservationId: id(8), reservationToken, generation: 1, renderOwnerId: id(9) };
  for (const patch of [{ publicationId: id(99) }, { sourceKind: 'onboarding' }, { occurrenceId: id(99) }, { generation: 2 }, { renderOwnerId: id(99) },
    { operation: { id: id(99), appliedRevision: 2, replayed: false } }]) {
    const h = clientFor(() => ({ claim: { ...claim(command), ...patch } })); await assert.rejects(claimSafetyQuestion(h.client, command, target));
  }
  const live = claim(command), { question: _, grantPresentationToken: __, displayUntil: ___, serverNow: ____, remainingDisplayMs: _____, ...nonlive } = live;
  assert.equal(parseSafetyQuestionClaim({ ...nonlive, status: 'declared' }).status, 'declared');
  assert.throws(() => parseSafetyQuestionClaim({ ...nonlive, status: 'delivery_uncertain', question: live.question }));
  assert.throws(() => parseSafetyQuestionClaim({ ...nonlive, status: 'declared', grantPresentationToken: grantToken }));
});
test('claim timing rejects inconsistent, expired, nonfinite or excessive browser display tickets', () => {
  const live = claim({ operationId: id(10), occurrenceId: id(6), generation: 1, renderOwnerId: id(9) });
  for (const patch of [{ remainingDisplayMs: 0 }, { remainingDisplayMs: NaN }, { remainingDisplayMs: Infinity }, { remainingDisplayMs: 10001 },
    { serverNow: live.displayUntil }, { displayUntil: at }, { remainingDisplayMs: 86400001 }, { serverNow: 'yesterday' }])
    assert.throws(() => parseSafetyQuestionClaim({ ...live, ...patch }));
});
test('reservation and presentation results cannot adopt another operation or occurrence; hash-only body retry does not fabricate a receipt', async () => {
  const reserve = { ...target, operationId: id(10), expectedQuestionScopeRevision: 0, renderOwnerId: id(9) };
  const reservation = { ...target, occurrenceId: id(6), reservationId: id(8), generation: 1, reservedUntil: at, scopeRevision: 1,
    reservationToken, operation: { id: reserve.operationId, appliedRevision: 1, replayed: false } };
  for (const patch of [{ sourceKind: 'onboarding' }, { publicationId: id(99) }, { operation: { id: id(99), appliedRevision: 1, replayed: false } }]) {
    const h = clientFor(() => ({ reservation: { ...reservation, ...patch } })); await assert.rejects(reserveSafetyQuestion(h.client, reserve));
  }
  const present = { operationId: id(11), occurrenceId: id(6), grantId: id(7), grantPresentationToken: grantToken, renderOwnerId: id(9) };
  const h = clientFor(() => ({ presentation: { occurrenceId: id(99), receiptReceivedAt: at, scopeRevision: 3, operation: { id: present.operationId, appliedRevision: 3, replayed: false } } }));
  await assert.rejects(presentSafetyQuestion(h.client, present));
  const command = { ...target, operationId: id(12), expectedPublicationRevision: 0, action: { kind: 'present_body' as const, bodyProjectionId: id(5) } };
  const replay = clientFor(() => ({ result: { state: resourceState({ revision: 1, presented: true }), operation: { id: id(12), appliedRevision: 1, replayed: true } } }));
  assert.equal((await actSafetyResource(replay.client, command)).presentationReceipt, undefined);
});
test('known-unavailable publication is null and cannot be treated as a displayed or handled resource', async () => {
  const h = clientFor(() => ({ publication: null })); assert.equal(await publishSafetyResource(h.client, { sourceRef, operationId: id(10), expectedEdition: 0 }), null);
});
test('same-account re-login and account switching discard late support responses even if the transport ignores cancellation', async () => {
  for (const account of [id(1), id(2)]) {
    let resolve!: (v: unknown) => void; const response = new Promise<unknown>(done => { resolve = done; }); const h = clientFor(() => response);
    const pending = readSafetyBody(h.client, target); h.context.changeSession(account); await assert.rejects(pending, { name: 'AbortError' });
    resolve({ projection: projection() }); assert.equal(h.client.isCurrent(), false); assert.equal(h.calls.length, 1);
  }
});

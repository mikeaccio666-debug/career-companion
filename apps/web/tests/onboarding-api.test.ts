import test from 'node:test';
import assert from 'node:assert/strict';
import type { OnboardingCommand, OnboardingFollowupCommand, OnboardingSafetyPublication } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createPlatformClient } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { onboardingResourceHref, parseOnboardingFollowupState, parsePublicOnboardingDraft, readOnboardingEntry, readOnboardingFollowup,
  retryOnboardingSafety, saveOnboardingDraft, saveOnboardingFollowup } from '../src/onboarding-api.ts';
import { acknowledgeOnboardingPresentation, onboardingContinuationAvailable, onboardingDraftCommand, replaceOnboardingPresentation } from '../src/onboarding-ui.ts';

const id = (number: number) => `10000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const A = id(1), B = id(2), at = '2026-10-07T12:00:00.000Z';
const draft = { schemaVersion: 1 as const, questionnaireRevision: 1 as const, rulesRevision: 1 as const, id: id(3), userId: A,
  revision: 1, step: 'O2' as const, currentQuestion: 'study' as const, state: 'collecting' as const, fastTrack: false, answersPartial: {}, updatedAt: at };
const publication: OnboardingSafetyPublication = { publicationId: id(4), responseId: id(5), submissionId: id(6), level: 'L2', publishedAt: at,
  retentionUntil: '2026-11-07T12:00:00.000Z', presented: true, acknowledged: true, handled: false, clarifiedAt: null,
  response: { text: 'Fictional reviewed response.', question: 'Fictional reviewed question?', resourceCard: { title: 'Fictional resources', schoolUnknown: 'Fictional school lookup instruction.', footer: 'Fictional no contact action.',
    outsideUs: { label: 'Fictional outside-US option', text: 'Fictional local resource instruction.' }, contacts: [{ id: 'fictional-resource', verifiedAt: at, name: 'Fictional contact', description: 'Fictional description.', actions: [
      { kind: 'call', number: '123456', label: 'Fictional call button' }, { kind: 'sms', number: '123456', body: 'FICTIONAL TEST', label: 'Fictional SMS button' }, { kind: 'web', url: 'https://example.com/', label: 'Fictional website button' },
    ] }] } } };
const followup = { draft, publications: [publication], pendingResponses: [], safety: { status: 'blocked', pendingCount: 0, blockedLevel: 'L2' } };
const entry = { ...followup, freeTextAvailable: false, answerSummaries: [], question: { questionId: 'study', prompt: 'Fictional server question?', choices: [{ value: 'cs', label: 'Fictional CS' }] } };
const endpoints = createPlatformEndpoints('https://api.example.invalid');
function context() { const scope = new AccountRequestContext(); scope.changeSession(A); return scope; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('real account client binds onboarding and resource requests, exact operation IDs and cancellation to the rendered account', async () => {
  const scope = context(), seen: { path: string; method: string; account: string | null; body: unknown }[] = [];
  const command: OnboardingCommand = { expectedRevision: 1, operationId: id(7), action: { kind: 'skip', questionId: 'study' } };
  const action: OnboardingFollowupCommand = { expectedDraftRevision: 1, operationId: id(8), publicationId: publication.publicationId, action: { kind: 'present' } };
  const client = createPlatformClient(endpoints, async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    seen.push({ path, method: init?.method ?? 'GET', account: new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(path === '/onboarding' && init?.method === 'PATCH' ? { result: { draft: { ...draft, revision: 2, currentQuestion: 'graduation', answersPartial: { study: { kind: 'skipped', reason: 'user', appliedRevision: 2 } } }, operation: { id: command.operationId, appliedRevision: 2, replayed: false } } }
      : path === '/onboarding/safety' && init?.method === 'POST' ? { result: { draft, operation: { id: action.operationId, appliedRevision: 1, replayed: false }, publicationId: publication.publicationId, resumeStatus: 'not_requested', presentationReceipt: 'fictional-memory-only-receipt' } }
      : path === '/onboarding/safety' ? { followup } : { entry });
  }, scope).capture();
  assert.equal((await readOnboardingEntry(client)).draft?.userId, A);
  assert.equal((await saveOnboardingDraft(client, command)).draft.revision, 2);
  assert.equal((await retryOnboardingSafety(client)).freeTextAvailable, false);
  assert.equal((await readOnboardingFollowup(client)).publications[0]?.publicationId, publication.publicationId);
  assert.equal((await saveOnboardingFollowup(client, action)).presentationReceipt, 'fictional-memory-only-receipt');
  assert.deepEqual(seen, [
    { path: '/onboarding', method: 'GET', account: A, body: null },
    { path: '/onboarding', method: 'PATCH', account: A, body: command },
    { path: '/onboarding/safety/retry', method: 'POST', account: A, body: {} },
    { path: '/onboarding/safety', method: 'GET', account: A, body: null },
    { path: '/onboarding/safety', method: 'POST', account: A, body: action },
  ]);
  scope.changeSession(B); await assert.rejects(readOnboardingEntry(client), { name: 'AbortError' }); await assert.rejects(readOnboardingFollowup(client), { name: 'AbortError' }); assert.equal(seen.length, 5);
});
test('an old account or same-account generation cannot publish a late onboarding or resource response even when transport ignores abort', async () => {
  for (const nextAccount of [A, B]) for (const read of [readOnboardingEntry, readOnboardingFollowup]) {
    const scope = context(), response = deferred<Response>(); let transportSignal!: AbortSignal;
    const client = createPlatformClient(endpoints, async (_, init) => { transportSignal = init!.signal!; return response.promise; }, scope).capture();
    const pending = read(client); scope.changeSession(nextAccount); assert.equal(transportSignal.aborted, true);
    await assert.rejects(pending, { name: 'AbortError' }); response.resolve(Response.json(read === readOnboardingEntry ? { entry } : { followup }));
    assert.equal(client.isCurrent(), false);
  }
});
test('pre-aborted onboarding and resource requests send nothing', async () => {
  const scope = context(); let requests = 0; const client = createPlatformClient(endpoints, async () => { requests++; return Response.json({ entry }); }, scope).capture();
  const abort = new AbortController(); abort.abort();
  for (const read of [readOnboardingEntry, readOnboardingFollowup, retryOnboardingSafety]) await assert.rejects(read(client, abort.signal), { name: 'AbortError' });
  assert.equal(requests, 0);
});
test('the public boundary rejects wrong owners, raw text, internal reviewer references and forged classification modes', () => {
  assert.deepEqual(parsePublicOnboardingDraft(draft, A), draft);
  for (const value of [{ ...draft, userId: B }, { ...draft, text: 'Fictional private submission' }, { ...draft, active: true },
    { ...draft, state: 'safety_pending' }, { ...draft, safety: { textId: id(9), questionId: 'study', submittedAtRevision: 1, level: 'L0', detectorRevision: 1, mode: 'keyword_only' } }]) assert.throws(() => parsePublicOnboardingDraft(value, A));
  assert.throws(() => parseOnboardingFollowupState({ ...followup, publications: [{ ...publication, response: { ...publication.response, reviewRef: 'fictional-internal-ref' } }] }, A));
  assert.throws(() => parseOnboardingFollowupState({ ...followup, publications: [publication, publication] }, A));
  assert.throws(() => parseOnboardingFollowupState({ ...followup, publications: [{ ...publication, presented: false }] }, A));
  const detached = parseOnboardingFollowupState(followup, A); assert.notEqual(detached.publications[0]?.response.resourceCard.contacts, publication.response.resourceCard.contacts);
});
test('unknown choices, unclosed resource actions, accessors and unsafe external links fail before rendering or opening them', () => {
  let called = false; const getter = { ...draft }; Object.defineProperty(getter, 'state', { get() { called = true; return 'collecting'; } });
  assert.throws(() => parsePublicOnboardingDraft(getter, A)); assert.equal(called, false);
  for (const value of [new Date(), { ...draft, [Symbol('extra')]: true }]) assert.throws(() => parsePublicOnboardingDraft(value, A));
  for (const url of ['javascript:alert(1)', 'http://example.com/', 'https://user:password@example.com/']) assert.throws(() => onboardingResourceHref({ kind: 'web', url, label: 'Fictional' }));
  assert.throws(() => onboardingResourceHref({ kind: 'call', number: '123456?body=external', label: 'Fictional' }));
  assert.throws(() => onboardingResourceHref({ kind: 'call', number: '123456', label: 'Fictional', handled: true } as never));
  assert.equal(onboardingResourceHref({ kind: 'sms', number: '123456', body: 'A&B + C', label: 'Fictional' }), 'sms:123456?body=A%26B%20%2B%20C');
  assert.equal(onboardingResourceHref({ kind: 'call', number: '123456', label: 'Fictional' }), 'tel:123456');
});
test('a malformed or wrong-owner response cannot acknowledge an operation or invent successful continuation', async () => {
  const command: OnboardingFollowupCommand = { expectedDraftRevision: 1, operationId: id(8), publicationId: publication.publicationId, action: { kind: 'present' } };
  const result = { draft, operation: { id: command.operationId, appliedRevision: 1, replayed: false }, publicationId: publication.publicationId, resumeStatus: 'not_requested', presentationReceipt: 'fictional-receipt' };
  for (const changed of [{ draft: { ...draft, userId: B } }, { operation: { ...result.operation, id: id(999) } }, { publicationId: id(999) },
    { resumeStatus: 'clinically_cleared' }, { presentationReceipt: undefined }, { rawText: 'Fictional private message' }]) {
    const client = createPlatformClient(endpoints, async () => Response.json({ result: { ...result, ...changed } }), context()).capture();
    await assert.rejects(saveOnboardingFollowup(client, command));
  }
  const mismatched = createPlatformClient(endpoints, async () => Response.json({ entry: { ...entry, question: { ...entry.question, questionId: 'Q2' } } }), context()).capture();
  await assert.rejects(readOnboardingEntry(mismatched));
});
test('historical acknowledgment does not authorize a new presentation receipt; receipt replacement and refresh require another explicit acknowledgment', () => {
  assert.equal(publication.acknowledged, true);
  assert.equal(onboardingContinuationAvailable(publication, undefined), false);
  const first = replaceOnboardingPresentation('fictional-first'); assert.equal(onboardingContinuationAvailable(publication, first), false);
  const acknowledged = acknowledgeOnboardingPresentation(first, first.receipt); assert.equal(onboardingContinuationAvailable(publication, acknowledged), true);
  const replaced = replaceOnboardingPresentation('fictional-second'); assert.equal(onboardingContinuationAvailable(publication, replaced), false);
  assert.throws(() => acknowledgeOnboardingPresentation(replaced, first.receipt));
  assert.equal(onboardingContinuationAvailable({ ...publication, handled: true }, acknowledged), false);
  assert.deepEqual(first, { receipt: 'fictional-first', acknowledgedReceipt: null });
});
test('a loaded fresh account can start with revision zero without fabricating a draft; other actions require persisted progress', async () => {
  const fresh = { ...entry, draft: null, publications: [], question: null, safety: { status: 'clear' as const, pendingCount: 0, blockedLevel: null } };
  for (const mode of ['standard', 'fast_track'] as const) {
    const command = onboardingDraftCommand(fresh, { kind: 'start', mode }, id(12));
    assert.deepEqual(command, { operationId: id(12), expectedRevision: 0, action: { kind: 'start', mode } });
    const client = createPlatformClient(endpoints, async (_, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), command);
      return Response.json({ result: { draft: { ...draft, fastTrack: mode === 'fast_track' }, operation: { id: id(12), appliedRevision: 1, replayed: false } } });
    }, context()).capture();
    assert.equal((await saveOnboardingDraft(client, command)).draft.revision, 1);
  }
  assert.equal(fresh.draft, null);
  assert.throws(() => onboardingDraftCommand(fresh, { kind: 'skip', questionId: 'study' }, id(12)));
  assert.throws(() => onboardingDraftCommand(fresh, { kind: 'text', questionId: 'extra', text: 'Fictional' }, id(12)));
  assert.equal(onboardingDraftCommand({ ...entry, safety: { status: 'blocked' as const, pendingCount: 0, blockedLevel: 'L2' as const } }, { kind: 'skip', questionId: 'study' }, id(12)).expectedRevision, draft.revision);
});
test('answer summaries bind every saved answer in canonical order and reject current questions, duplicates, lost entries and changed provenance', async () => {
  const answered = { ...draft, revision: 3, currentQuestion: 'roles', answersPartial: {
    study: { kind: 'answered', value: { degreeField: 'cs', programChoice: null }, source: 'user_entered', appliedRevision: 2 },
    graduation: { kind: 'skipped', reason: 'user', appliedRevision: 3 },
  } };
  const study = { questionId: 'study', prompt: 'Fictional fixed study prompt.', label: 'CS', appliedRevision: 2, kind: 'answered' };
  const graduation = { questionId: 'graduation', prompt: 'Fictional fixed graduation prompt.', label: '已跳过', appliedRevision: 3, kind: 'skipped', reason: 'user' };
  const state = { ...entry, draft: answered, question: { questionId: 'roles', prompt: 'Fictional roles prompt.', choices: [] }, answerSummaries: [study, graduation] };
  const read = async (value: unknown) => readOnboardingEntry(createPlatformClient(endpoints, async () => Response.json({ entry: value }), context()).capture());
  assert.deepEqual((await read(state)).answerSummaries, [study, graduation]);
  for (const answerSummaries of [[study], [study, graduation, graduation], [graduation, study], [study, { ...graduation, appliedRevision: 2 }],
    [study, { ...graduation, kind: 'answered' }], [study, { ...graduation, reason: 'remaining' }], [{ ...study, reason: 'user' }, graduation],
    [study, { ...graduation, questionId: 'roles' }], [study, { ...graduation, rawText: 'Fictional private text.' }]]) await assert.rejects(read({ ...state, answerSummaries }));
  await assert.rejects(read({ ...entry, answerSummaries: [study] }));
  const fresh = { ...entry, draft: null, question: null, answerSummaries: [] };
  assert.deepEqual((await read(fresh)).answerSummaries, []); await assert.rejects(read({ ...fresh, answerSummaries: [study] }));
});

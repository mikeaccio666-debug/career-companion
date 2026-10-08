import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER, type CompanionStudentJourneyState } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { parseCompanionJourney, parseCompanionSealSelectionSaved, readCompanionJourney,
  readCompanionSealOperation, saveCompanionSealSelection, resumeCompanionNamePreparation } from '../src/companion-journey-api.ts';

const id = (n: number) => `24000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = id(1), taskId = id(2), companionId = id(3), operationId = id(4), submissionId = id(5), dispatchId = id(6);
const endpoints = createPlatformEndpoints('https://api.example.invalid');
const preview = { taskId, companionId, revision: 1 as const, generatedBy: 'fallback' as const,
  summary: '虚构性格预览', samples: ['虚构示例一', '虚构示例二', '虚构示例三'] as const, inkToken: 'dai' as const };
const identity = { taskId, companionId, previewRevision: 1 as const, revision: 1, name: 'Milo', nameOrigin: 'user_typed' as const,
  sealCandidates: [{ char: '米', reason: '虚构读音候选' }, { char: '稳', reason: '虚构性格候选' }, { char: '启', reason: '虚构阶段候选' }] as const, inkToken: 'dai' as const };
const selection = { taskId, companionId, previewRevision: 1 as const, identityRevision: 1, revision: 0, selectedSeal: null };
const progress = { dispatchId, taskId, submissionId, submittedRevision: 1, phase: 'detected' as const, hold: null,
  detection: { status: 'detected' as const, generation: 1, level: 'L0' as const, mode: 'full' as const },
  application: { status: 'applied' as const, rejectedCategory: null, identityRevision: 1 }, resource: 'not_required' as const };
const naming = { kind: 'naming' as const, entry: { taskId, companionId, revision: 1, latestSubmissionId: submissionId }, latest: progress };
const journey: CompanionStudentJourneyState = { kind: 'journey', taskId, companionId, stage: 'seal_ready', preview, naming, latestNamingOperationId: operationId, identity, selection };
const saved = { selection: { ...selection, revision: 1, selectedSeal: '稳' }, operation: { id: operationId, appliedRevision: 1, replayed: false } };
const accepted = { acceptance: { dispatchId, taskId, submissionId, operation: { id: operationId, appliedRevision: 1, replayed: true } }, progress };
const input = { taskId, expectedIdentityRevision: 1, expectedRevision: 0, operationId, sealChar: '稳' };

test('journey observes persisted preview, name and selection without claiming birth or authority', () => {
  const pre = { kind: 'journey', taskId, companionId, stage: 'preview', preview, naming: { kind: 'not_started' }, latestNamingOperationId: null, identity: null, selection: null };
  const processing = { ...journey, stage: 'naming', identity: null, selection: null,
    naming: { ...naming, latest: { ...progress, phase: 'queued', detection: { status: 'pending', generation: 0, level: null, mode: null },
      application: { status: 'pending', rejectedCategory: null, identityRevision: null }, resource: 'not_determined' } } };
  for (const state of [{ kind: 'not_started', naming: { kind: 'not_started' } }, pre, processing, journey,
    { ...journey, stage: 'seal_saved', selection: saved.selection }, { ...journey, latestNamingOperationId: null }]) {
    assert.deepEqual(parseCompanionJourney(state), state); assert(Object.isFrozen(parseCompanionJourney(state)));
  }
});

test('closed journey rejects authority, accessors, sparse candidate arrays and incoherent source coordinates', () => {
  let calls = 0;
  const getter = Object.defineProperty({ ...journey }, 'identity', { enumerable: true, get() { calls++; return identity; } });
  const sparse = new Array(3); sparse[0] = identity.sealCandidates[0]; sparse[2] = identity.sealCandidates[2];
  for (const value of [getter, Object.create(journey), { ...journey, canBirth: true }, { ...journey, [Symbol('private')]: 1 },
    { ...journey, preview: { ...preview, taskId: id(9) } }, { ...journey, identity: { ...identity, companionId: id(9) } },
    { ...journey, identity: { ...identity, sealCandidates: sparse } },
    { ...journey, identity: { ...identity, sealCandidates: [identity.sealCandidates[0], identity.sealCandidates[0], identity.sealCandidates[2]] } },
    { ...journey, selection: { ...selection, identityRevision: 2 } }, { ...journey, stage: 'seal_saved' },
    { ...journey, stage: 'seal_saved', selection: { ...saved.selection, selectedSeal: '舟' } },
    { ...journey, stage: 'preview' }, { kind: 'not_started', naming },
    { ...journey, latestNamingOperationId: 'not-a-saved-operation' },
    { ...journey, latestNamingOperationId: '24A00000-0000-4000-8000-000000000004' },
    { ...journey, naming: { kind: 'not_started' } },
    { ...journey, resumeAllowed: true }]) assert.throws(() => parseCompanionJourney(value));
  assert.equal(calls, 0);
});

test('own seal receipt keeps original committed revision alongside a later current selection', () => {
  const later = { selection: { ...saved.selection, revision: 3, selectedSeal: '启' }, operation: { ...saved.operation, replayed: true } };
  assert.deepEqual(parseCompanionSealSelectionSaved(later), later);
  for (const value of [{ ...saved, rawName: 'private' }, { ...saved, operation: { ...saved.operation, appliedRevision: 2 } },
    { ...saved, selection: { ...selection, selectedSeal: '稳' } }, { ...saved, operation: { ...saved.operation, replayed: 'yes' } }])
    assert.throws(() => parseCompanionSealSelectionSaved(value));
});

test('real captured account transport uses closed paths and never normalizes or imports authority', async () => {
  const context = new AccountRequestContext(); context.changeSession(account);
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), account);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    const path = new URL(String(url)).pathname.replace('/api/platform', ''), method = init?.method ?? 'GET';
    requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(path.endsWith('name-preparation') ? { accepted } : path === '/companion/journey' ? { journey } : { saved });
  }, context).capture();
  assert.deepEqual(await readCompanionJourney(client), journey);
  const mutable = { ...input }; const pending = saveCompanionSealSelection(client, mutable); mutable.sealChar = '启';
  assert.deepEqual(await pending, saved); assert.deepEqual(await readCompanionSealOperation(client, taskId, operationId), saved);
  assert.deepEqual(await resumeCompanionNamePreparation(client, operationId), accepted);
  assert.deepEqual(requests, [{ path: '/companion/journey', method: 'GET', body: null },
    { path: '/companion/journey/seal', method: 'POST', body: input },
    { path: '/companion/journey/seal/' + taskId + '/operations/' + operationId, method: 'GET', body: null },
    { path: '/companion/journey/name-preparation', method: 'POST', body: { operationId } }]);
  context.changeSession(id(99)); await assert.rejects(readCompanionJourney(client), { name: 'AbortError' });
  await assert.rejects(saveCompanionSealSelection(client, input), { name: 'AbortError' });
  await assert.rejects(readCompanionSealOperation(client, taskId, operationId), { name: 'AbortError' });
  await assert.rejects(resumeCompanionNamePreparation(client, operationId), { name: 'AbortError' }); assert.equal(requests.length, 4);
});

test('foreign-operation and cross-task responses never masquerade as this selection or preparation', async () => {
  const context = new AccountRequestContext(); context.changeSession(account);
  for (const payload of [{ saved: { ...saved, operation: { ...saved.operation, id: id(77) } } },
    { saved: { ...saved, selection: { ...saved.selection, taskId: id(77) } } },
    { saved: { ...saved, operation: { ...saved.operation, appliedRevision: 2 }, selection: { ...saved.selection, revision: 2 } } }]) {
    const client = createPlatformClient(endpoints, async () => Response.json(payload), context).capture();
    await assert.rejects(saveCompanionSealSelection(client, input));
  }
  const client = createPlatformClient(endpoints, async () => Response.json({ accepted: { ...accepted,
    acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, id: id(77) } } } }), context).capture();
  await assert.rejects(resumeCompanionNamePreparation(client, operationId));
});

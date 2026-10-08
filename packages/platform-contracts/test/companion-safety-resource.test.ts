import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanionSafetyPublicationRequest, parseCompanionSafetyResourceCommand, parseCompanionSafetyQuestionReserveCommand,
  parseCompanionSafetyTargetRequest } from '../src/companion-safety-resource.ts';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const receipt = 'a'.repeat(43);
test('closed source-aware publication requests do not provide a caller level, evidence or execution permission', () => {
  const input = { sourceRef: { kind: 'onboarding', submissionId: id(1) }, operationId: id(2), expectedEdition: 0 };
  const parsed = parseCompanionSafetyPublicationRequest(input);
  assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed.sourceRef));
  for (const value of [{ ...input, level: 'L0' }, { ...input, sourceRef: { ...input.sourceRef, kind: 'extra' } },
    { ...input, sourceRef: { ...input.sourceRef, approved: true } }, { ...input, expectedEdition: -0 },
    { ...input, sourceRef: { kind: 'companion_name', submissionId: id(1).toUpperCase() + '\n' } }]) {
    assert.throws(() => parseCompanionSafetyPublicationRequest(value));
  }
});
test('intake and name continuation match their true family and keep genuine receipt and explicit clarification fields', () => {
  const input = { sourceKind: 'onboarding', operationId: id(1), publicationId: id(2), expectedPublicationRevision: 4,
    action: { kind: 'continue_intake', presentationReceipt: receipt } };
  assert.deepEqual(parseCompanionSafetyResourceCommand(input), input);
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...input, sourceKind: 'companion_name' }));
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...input, action: { kind: 'continue_naming', presentationReceipt: receipt } }));
  const clarification = { ...input, action: { kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: true, exaggeration: true } };
  assert.deepEqual(parseCompanionSafetyResourceCommand(clarification), clarification);
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...clarification, action: { ...clarification.action, safe: false } }));
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...clarification, action: { ...clarification.action, handled: true } }));
});
test('body present transports one actual projection while support needs neither a fake receipt nor implied acknowledgment', () => {
  const input = { sourceKind: 'companion_name', operationId: id(1), publicationId: id(2), expectedPublicationRevision: 0,
    action: { kind: 'present_body', bodyProjectionId: id(3) } };
  assert.deepEqual(parseCompanionSafetyResourceCommand(input), input);
  assert.deepEqual(parseCompanionSafetyResourceCommand({ ...input, action: { kind: 'need_support' } }).action, { kind: 'need_support' });
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...input, action: { ...input.action, asked: true } }));
});
test('source-aware question reservation carries only a concrete public target and live render owner', () => {
  const input = { sourceKind: 'onboarding', operationId: id(1), publicationId: id(2), expectedQuestionScopeRevision: 0, renderOwnerId: id(3) };
  assert.deepEqual(parseCompanionSafetyQuestionReserveCommand(input), input);
  for (const value of [{ ...input, sourceKind: 'extra' }, { ...input, generation: 1 }, { ...input, asked: false },
    { ...input, expectedQuestionScopeRevision: 0.5 }, { ...input, renderOwnerId: id(3) + '\n' }]) {
    assert.throws(() => parseCompanionSafetyQuestionReserveCommand(value));
  }
  assert.deepEqual(parseCompanionSafetyTargetRequest({ sourceKind: 'companion_name', publicationId: id(2) }), { sourceKind: 'companion_name', publicationId: id(2) });
});
test('accessor/prototype/symbol/hidden injections are rejected before any source or action getter runs', () => {
  let reads = 0;
  const input = { sourceKind: 'onboarding', operationId: id(1), publicationId: id(2), expectedPublicationRevision: 0,
    action: { get kind() { reads++; return 'need_support'; } } };
  assert.throws(() => parseCompanionSafetyResourceCommand(input));
  assert.throws(() => parseCompanionSafetyPublicationRequest({ sourceRef: { get kind() { reads++; return 'onboarding'; }, submissionId: id(1) }, operationId: id(2), expectedEdition: 0 }));
  assert.throws(() => parseCompanionSafetyResourceCommand({ ...input, action: Object.assign(Object.create({ inherited: true }), { kind: 'need_support' }) }));
  assert.throws(() => parseCompanionSafetyTargetRequest({ sourceKind: 'onboarding', publicationId: id(2), [Symbol('extra')]: true }));
  assert.throws(() => parseCompanionSafetyTargetRequest(Object.defineProperty({ sourceKind: 'onboarding', publicationId: id(2) }, 'publicationId', { enumerable: false })));
  assert.equal(reads, 0);
});

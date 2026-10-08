import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NameSafetyResourceContractError,
  parseNameSafetyPublicationCommand,
  parseNameSafetyResourceCommand,
  parseSafetyQuestionClaimCommand,
  parseSafetyQuestionPresentCommand,
  parseSafetyQuestionReserveCommand,
} from '@companion/platform-contracts';

const operationId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000003';
const receipt = 'F'.repeat(43); // Fictional transport shape, never an issued capability.
const publication = () => ({operationId, submissionId: sourceId, expectedEdition: 0});
const body = () => ({operationId, publicationId: sourceId, expectedPublicationRevision: 0,
  action: {kind: 'acknowledge', presentationReceipt: receipt}});
const reserve = () => ({operationId, publicationId: sourceId, expectedQuestionScopeRevision: 0, renderOwnerId: ownerId});
const claim = () => ({operationId, occurrenceId: sourceId, reservationId: sourceId,
  reservationToken: receipt, generation: 1, renderOwnerId: ownerId});
const present = () => ({operationId, occurrenceId: sourceId, grantId: sourceId,
  grantPresentationToken: receipt, renderOwnerId: ownerId});
const shapes: readonly {parse: (value: unknown) => object; make: () => Record<string, unknown>}[] = [
  {parse: parseNameSafetyPublicationCommand, make: publication},
  {parse: parseNameSafetyResourceCommand, make: body},
  {parse: parseSafetyQuestionReserveCommand, make: reserve},
  {parse: parseSafetyQuestionClaimCommand, make: claim},
  {parse: parseSafetyQuestionPresentCommand, make: present},
];
const rejects = (parse: (value: unknown) => unknown, input: unknown) => assert.throws(() => parse(input),
  (error: unknown) => error instanceof NameSafetyResourceContractError && error.code === 'INVALID_INPUT');

test('resource and question commands snapshot only the closed transport input', () => {
  for (const {parse, make} of shapes) {
    const input = make(), saved = parse(input);
    assert.deepEqual(saved, input);
    assert.ok(Object.isFrozen(saved));
    input.operationId = sourceId;
    assert.equal((saved as {operationId: string}).operationId, operationId);
  }
  const input = body(), saved = parseNameSafetyResourceCommand(input);
  assert.ok(Object.isFrozen(saved.action));
  input.action.presentationReceipt = 'G'.repeat(43);
  assert.equal(saved.action.kind, 'acknowledge');
  assert.equal('presentationReceipt' in saved.action && saved.action.presentationReceipt, receipt);
});

test('client risk, handling, identity and timestamp assertions cannot enter these commands', () => {
  for (const {parse, make} of shapes) {
    for (const [key, value] of Object.entries({level: 'L0', handled: true, userId: ownerId,
      legalVersion: 'fictional', askedAt: '2026-01-01T00:00:00.000Z'})) {
      rejects(parse, {...make(), [key]: value});
    }
    const symbolInput = make();
    Object.defineProperty(symbolInput, Symbol('hidden authority'), {value: true});
    rejects(parse, symbolInput);
    rejects(parse, Object.assign(Object.create({handled: true}), make()));
  }
  rejects(parseNameSafetyResourceCommand, {...body(), action: {...body().action, handled: true}});
});

test('parsing rejects executable accessors without evaluating their values', () => {
  let called = 0;
  for (const {parse, make} of shapes) {
    const input = make();
    Object.defineProperty(input, 'operationId', {enumerable: true, get() {called++; return operationId;}});
    rejects(parse, input);
  }
  const input = body();
  Object.defineProperty(input.action, 'kind', {enumerable: true, get() {called++; return 'acknowledge';}});
  rejects(parseNameSafetyResourceCommand, input);
  assert.equal(called, 0);
});

test('continuation and clarification retain explicit action and receipt boundaries', () => {
  const base = {operationId, publicationId: sourceId, expectedPublicationRevision: 2};
  for (const kind of ['acknowledge', 'continue_naming'] as const) {
    assert.equal(parseNameSafetyResourceCommand({...base, action: {kind, presentationReceipt: receipt}}).action.kind, kind);
    rejects(parseNameSafetyResourceCommand, {...base, action: {kind}});
    rejects(parseNameSafetyResourceCommand, {...base, action: {kind, presentationReceipt: receipt, safe: true}});
  }
  assert.deepEqual(parseNameSafetyResourceCommand({...base,
    action: {kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: true, exaggeration: true}}).action,
    {kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: true, exaggeration: true});
  for (const flag of [false, null, 'true', 1, undefined]) {
    rejects(parseNameSafetyResourceCommand, {...base,
      action: {kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: flag, exaggeration: true}});
    rejects(parseNameSafetyResourceCommand, {...base,
      action: {kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: true, exaggeration: flag}});
  }
  assert.equal(parseNameSafetyResourceCommand({...base, action: {kind: 'need_support'}}).action.kind, 'need_support');
  rejects(parseNameSafetyResourceCommand, {...base, action: {kind: 'need_support', handled: true}});
  assert.equal(parseNameSafetyResourceCommand({...base,
    action: {kind: 'present_body', bodyProjectionId: sourceId}}).action.kind, 'present_body');
  rejects(parseNameSafetyResourceCommand, {...base, action: {kind: 'present_body', presentationReceipt: receipt}});
});

test('question reservation, claim and display declarations use distinct closed capabilities', () => {
  rejects(parseSafetyQuestionReserveCommand, {...reserve(), question: 'Fictional question'});
  rejects(parseSafetyQuestionClaimCommand, {...claim(), grantPresentationToken: receipt});
  rejects(parseSafetyQuestionPresentCommand, {...present(), reservationToken: receipt});
  for (const bad of ['', receipt.slice(1), receipt + 'F', receipt.slice(1) + '=', receipt + '\n']) {
    rejects(parseSafetyQuestionClaimCommand, {...claim(), reservationToken: bad});
    rejects(parseSafetyQuestionPresentCommand, {...present(), grantPresentationToken: bad});
    rejects(parseNameSafetyResourceCommand, {...body(), action: {...body().action, presentationReceipt: bad}});
  }
  rejects(parseSafetyQuestionClaimCommand, {...claim(), generation: 0});
});

test('revision and identity fields cannot be coerced or ambiguously encoded', () => {
  for (const bad of [-0, -1, 0.5, 2147483647, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
    rejects(parseNameSafetyPublicationCommand, {...publication(), expectedEdition: bad});
    rejects(parseNameSafetyResourceCommand, {...body(), expectedPublicationRevision: bad});
    rejects(parseSafetyQuestionReserveCommand, {...reserve(), expectedQuestionScopeRevision: bad});
  }
  for (const {parse, make} of shapes) {
    for (const bad of [operationId + '\n', operationId + ' ', 'ABCDEF00-0000-4000-8000-000000000001', 'not-a-uuid']) {
      rejects(parse, {...make(), operationId: bad});
    }
    const hidden = make();
    Object.defineProperty(hidden, 'operationId', {value: operationId, enumerable: false});
    rejects(parse, hidden);
    for (const bad of [null, [], true, 'fictional']) rejects(parse, bad);
  }
});

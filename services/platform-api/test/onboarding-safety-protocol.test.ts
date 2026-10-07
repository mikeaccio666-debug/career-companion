import test from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingError } from '@companion/career-core';
import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS } from '@companion/platform-contracts';
import { parseOnboardingSafetyClaim, parseOnboardingSafetyDecision, type OnboardingSafetyClaim } from '../src/onboarding-safety-protocol.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
type MutableClaim = { -readonly [K in keyof OnboardingSafetyClaim]: OnboardingSafetyClaim[K] };
const fixture = (): MutableClaim => ({ userId: id(1), submissionId: id(2), operationId: id(3), draftId: id(4),
  questionId: 'extra', submittedAtRevision: 5, authVersion: '0', generation: 1, leaseToken: id(6), detectorRevision: 7 });
const rejects = (run: () => unknown) => assert.throws(run, (e: unknown) => e instanceof OnboardingError && e.code === 'ONBOARDING_INVALID_INPUT');

test('claim parser freezes a self-owned canonical snapshot and preserves initial auth version zero', () => {
  const original = fixture(), parsed = parseOnboardingSafetyClaim(original);
  assert.deepEqual(parsed, original); assert.notEqual(parsed, original); assert.equal(Object.isFrozen(parsed), true);
  original.questionId = 'Q1'; original.authVersion = '1'; assert.equal(parsed.questionId, 'extra'); assert.equal(parsed.authVersion, '0');
});
test('claim parser accepts only its complete fixed coordinate set and no accessors or inherited payloads', () => {
  for (const key of Object.keys(fixture())) { const input: Record<string, unknown> = { ...fixture() }; delete input[key]; rejects(() => parseOnboardingSafetyClaim(input)); }
  for (const key of ['ownerId', 'text', 'rawText', 'level', 'mode', 'resolution', 'leaseUntil', 'approved', 'completed']) rejects(() => parseOnboardingSafetyClaim({ ...fixture(), [key]: 'fictional' }));
  for (const input of [null, [], new Date(), Object.create(fixture()), { ...fixture(), [Symbol('extra')]: 1 }]) rejects(() => parseOnboardingSafetyClaim(input));
  let called = false; const input = { ...fixture() }; Object.defineProperty(input, 'userId', { get() { called = true; return id(1); } });
  rejects(() => parseOnboardingSafetyClaim(input)); assert.equal(called, false);
});
test('claim UUID coordinates reject normalization ambiguities and terminal control characters', () => {
  for (const field of ['userId', 'submissionId', 'operationId', 'draftId', 'leaseToken']) {
    for (const value of [id(0xabcdef).toUpperCase(), ' '+id(1), id(1)+' ', '', 1,
      ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(suffix => id(1)+suffix)]) rejects(() => parseOnboardingSafetyClaim({ ...fixture(), [field]: value }));
  }
});
test('claim integers use positive PostgreSQL bounds and only known question keys', () => {
  for (const field of ['submittedAtRevision', 'generation', 'detectorRevision'] as const) {
    for (const value of [0, -0, -1, 0.5, 2147483648, Infinity, NaN, '1']) rejects(() => parseOnboardingSafetyClaim({ ...fixture(), [field]: value }));
    assert.equal(parseOnboardingSafetyClaim({ ...fixture(), [field]: 2147483647 })[field], 2147483647);
  }
  for (const questionId of [...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra']) assert.equal(parseOnboardingSafetyClaim({ ...fixture(), questionId }).questionId, questionId);
  for (const questionId of ['O4', 'q1', 'school', 'extra\n', '', null]) rejects(() => parseOnboardingSafetyClaim({ ...fixture(), questionId }));
});
test('auth version is an exact nonnegative decimal string within PostgreSQL bigint', () => {
  for (const authVersion of ['0', '1', '9007199254740993', '9223372036854775807']) assert.equal(parseOnboardingSafetyClaim({ ...fixture(), authVersion }).authVersion, authVersion);
  for (const authVersion of ['', '00', '01', '+1', '-0', '-1', '1.0', '1e2', ' 1', '1 ', '9223372036854775808', '9'.repeat(100), 1,
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(suffix => '1'+suffix)]) rejects(() => parseOnboardingSafetyClaim({ ...fixture(), authVersion }));
});
test('decision binds operation text reference and detector version exclusively from the claim', () => {
  const claim = fixture(), result = parseOnboardingSafetyDecision({ level: 'L0', mode: 'full' }, claim);
  assert.deepEqual(result, { textId: claim.operationId, submittedAtRevision: claim.submittedAtRevision, detectorRevision: claim.detectorRevision, level: 'L0', mode: 'full' });
  assert.notEqual(result.textId, claim.submissionId); assert.equal(Object.isFrozen(result), true);
  claim.operationId = id(99); assert.equal(result.textId, id(3));
  for (const field of Object.keys(fixture()).concat('textId','detectorVersion','rawText','completed')) rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', [field]: 1 }, fixture()));
});
test('choice decisions require an exact matching resolution while extra forbids one', () => {
  const claim = { ...fixture(), questionId: 'Q1' as const };
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full' }, claim));
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution: { kind: 'answer', questionId: 'Q2', value: 'A' } }, claim));
  const matched = parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution: { kind: 'answer', questionId: 'Q1', value: 'C' } }, claim);
  assert.deepEqual(matched.resolution, { kind: 'answer', questionId: 'Q1', value: 'C' });
  assert.equal(parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } }, claim).resolution?.kind, 'unmatched');
  for (const resolution of [{ kind: 'unmatched' }, { kind: 'answer', questionId: 'Q1', value: 'A' }]) rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution }, fixture()));
});
test('degraded L0 and every explicit non-L0 resolution field are refused', () => {
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'keyword_only' }, fixture()));
  for (const level of ['L1', 'L2']) for (const mode of ['full', 'keyword_only']) {
    for (const claim of [fixture(), { ...fixture(), questionId: 'Q1' as const }]) {
      assert.equal(parseOnboardingSafetyDecision({ level, mode }, claim).level, level);
      for (const resolution of [undefined, null, { kind: 'unmatched' }]) rejects(() => parseOnboardingSafetyDecision({ level, mode, resolution }, claim));
    }
  }
});
test('decision parsing copies and deeply freezes nested resolution values without touching caller data', () => {
  const roles = ['mle', 'swe'], decision = { level: 'L0', mode: 'full', resolution: { kind: 'answer', questionId: 'roles', value: { kind: 'selected', roles } } };
  const result = parseOnboardingSafetyDecision(decision, { ...fixture(), questionId: 'roles' });
  roles.push('ds'); assert.equal(Object.isFrozen(decision.resolution.value.roles), false);
  assert.deepEqual(result.resolution, { kind: 'answer', questionId: 'roles', value: { kind: 'selected', roles: ['swe', 'mle'] } });
  assert.equal(Object.isFrozen(result.resolution), true);
  if (result.resolution?.kind === 'answer' && result.resolution.questionId === 'roles') {
    assert.equal(Object.isFrozen(result.resolution.value), true);
    if (result.resolution.value.kind === 'selected') assert.equal(Object.isFrozen(result.resolution.value.roles), true);
  }
});
test('decision rejects getter-driven payloads, unknown nested fields, and invalid claim snapshots', () => {
  let called = false; const decision = { level: 'L0', mode: 'full' };
  Object.defineProperty(decision, 'mode', { get() { called = true; return 'full'; } });
  rejects(() => parseOnboardingSafetyDecision(decision, fixture())); assert.equal(called, false);
  const resolution = { kind: 'answer', questionId: 'Q1', value: 'A' };
  Object.defineProperty(resolution, 'value', { get() { called = true; return 'A'; } });
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution }, { ...fixture(), questionId: 'Q1' })); assert.equal(called, false);
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full' }, { ...fixture(), authVersion: '01' }));
  rejects(() => parseOnboardingSafetyDecision({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched', approved: true } }, { ...fixture(), questionId: 'Q1' }));
});

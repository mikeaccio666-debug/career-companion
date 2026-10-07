import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOnboardingDraft, resolveOnboardingText, transitionOnboardingDraft } from '@companion/career-core';
import type { ClassifiedOnboardingText } from '@companion/career-core';
import type { OnboardingAction, OnboardingDraft, OnboardingScenarioQuestion } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { parseCapturedCompanionAnswers, prepareCapturedCompanionDimensions } from '../src/companion-captured-answers.ts';

// These snapshots are extracted from actual pure reducer transitions. The
// historical codec must validate their saved shape without fabricating a draft,
// pending-text pointer, current safety pointer or authorization grant.
const at = '2026-10-07T12:00:00.000Z';
const neutral = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
const scenarios: readonly OnboardingScenarioQuestion[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'DATA_STORAGE_UNAVAILABLE';
const clone = <T>(value: T): T => structuredClone(value);
function action(draft: OnboardingDraft, value: OnboardingAction) {
  return transitionOnboardingDraft(draft, { expectedRevision: draft.revision, operationId: randomUUID(), action: value }, { at });
}
function begin(mode: 'standard' | 'fast_track' = 'standard') {
  return action(createOnboardingDraft({ id: randomUUID(), userId: randomUUID(), at }), { kind: 'start', mode });
}
function basic(draft: OnboardingDraft) {
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = action(draft, { kind: 'skip', questionId: draft.currentQuestion }); }
  return draft;
}
function complete(mode: 'standard' | 'fast_track' = 'standard', choices?: readonly string[]) {
  let draft = basic(begin(mode));
  if (choices) for (const [index, questionId] of scenarios.entries()) {
    draft = action(draft, { kind: 'answer', questionId, value: choices[index] } as OnboardingAction);
  }
  while (draft.currentQuestion) draft = action(draft, { kind: 'skip', questionId: draft.currentQuestion });
  assert.equal(draft.state, 'intake_ready'); return draft;
}
function capture(draft: OnboardingDraft) {
  return { schemaVersion: 1, id: randomUUID(), userId: draft.userId, sourceDraftId: draft.id,
    sourceRevision: draft.revision, fastTrack: draft.fastTrack, answersPartial: clone(draft.answersPartial) };
}
function withExtra() {
  let draft = basic(begin());
  for (const [index, questionId] of scenarios.entries()) draft = action(draft,
    { kind: 'answer', questionId, value: ['B', 'C', 'A', 'A', 'C', 'B', 'B'][index] } as OnboardingAction);
  const textId = randomUUID(), text = '说话直一点，别催我，短一点，多用英文；Synthetic unrelated private context.';
  draft = transitionOnboardingDraft(draft, { expectedRevision: draft.revision, operationId: textId,
    action: { kind: 'text', questionId: 'extra', text } }, { at });
  const submittedAtRevision = draft.revision;
  draft = resolveOnboardingText(draft, { textId, submittedAtRevision, level: 'L0', detectorRevision: 29, mode: 'full' }, { at });
  const provenExtra: ClassifiedOnboardingText = { textId, questionId: 'extra', submittedAtRevision,
    level: 'L0', detectorRevision: 29, mode: 'full', text };
  return { value: capture(draft), provenExtra };
}

test('captured answers are an independently frozen canonical copy, with no current draft or authorization fields', () => {
  const original = capture(complete('fast_track')), saved = parseCapturedCompanionAnswers(original);
  assert.deepEqual(saved, original); assert.notEqual(saved, original); assert.notEqual(saved.answersPartial, original.answersPartial);
  assert(Object.isFrozen(saved)); assert(Object.isFrozen(saved.answersPartial));
  for (const answer of Object.values(saved.answersPartial)) assert(Object.isFrozen(answer));
  assert.deepEqual(Object.keys(saved).sort(), ['answersPartial', 'fastTrack', 'id', 'schemaVersion', 'sourceDraftId', 'sourceRevision', 'userId']);
  assert.deepEqual(prepareCapturedCompanionDimensions(saved), neutral);
  original.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2,
    value: { degreeField: 'cs', programChoice: '24_month' } };
  assert.equal(saved.answersPartial.study?.kind, 'skipped');
  const dimensions = prepareCapturedCompanionDimensions(saved); assert(Object.isFrozen(dimensions));
});

test('captured standard choices preserve the ordered rule caps independently of basic facts', () => {
  const value = capture(complete('standard', ['C', 'C', 'D', 'B', 'C', 'B', 'C']));
  assert.deepEqual(prepareCapturedCompanionDimensions(parseCapturedCompanionAnswers(value)),
    { warmth: -1, directness: 1, drive: -1, structure: 1, levity: -1, code_mix: 0, length: 'medium' });
  const changedFacts = clone(value);
  changedFacts.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2,
    value: { degreeField: 'other_stem', programChoice: null } };
  assert.deepEqual(prepareCapturedCompanionDimensions(parseCapturedCompanionAnswers(changedFacts)),
    prepareCapturedCompanionDimensions(parseCapturedCompanionAnswers(value)));
});

test('fast_track and skip_remaining have distinct valid revision batches and reject counterfeit mixtures', () => {
  const fast = capture(complete('fast_track'));
  assert.deepEqual(prepareCapturedCompanionDimensions(parseCapturedCompanionAnswers(fast)), neutral);
  let draft = basic(begin()); draft = action(draft, { kind: 'answer', questionId: 'Q1', value: 'C' });
  draft = action(draft, { kind: 'skip_remaining' }); draft = action(draft, { kind: 'skip', questionId: 'extra' });
  const remaining = capture(draft), parsed = parseCapturedCompanionAnswers(remaining);
  assert.equal(parsed.answersPartial.Q1?.kind, 'answered');
  assert.deepEqual(prepareCapturedCompanionDimensions(parsed), { ...neutral, directness: 1 });
  const mixed = clone(fast); mixed.answersPartial.Q2 = { kind: 'skipped', reason: 'remaining', appliedRevision: fast.sourceRevision };
  const unequal = clone(fast); unequal.answersPartial.Q3 = { kind: 'skipped', reason: 'fast_track', appliedRevision: fast.sourceRevision - 1 };
  const interrupted = clone(remaining); interrupted.answersPartial.Q4 = { kind: 'skipped', reason: 'user', appliedRevision: remaining.sourceRevision - 1 };
  const wrongExtra = clone(remaining); wrongExtra.answersPartial.extra = { kind: 'skipped', reason: 'remaining', appliedRevision: remaining.sourceRevision };
  for (const invalid of [mixed, unequal, interrupted, wrongExtra]) assert.throws(() => parseCapturedCompanionAnswers(invalid), unavailable);
});

test('capture rejects unknown authority, missing answers, noncanonical ids and revision bounds without invoking getters', () => {
  const value = capture(complete()), missing = clone(value); delete missing.answersPartial.Q4;
  const future = clone(value); future.answersPartial.Q1!.appliedRevision = value.sourceRevision + 1;
  const duplicate = clone(value); duplicate.answersPartial.Q2!.appliedRevision = duplicate.answersPartial.Q1!.appliedRevision;
  const last = clone(value); last.sourceRevision++;
  let accesses = 0;
  const getter = Object.defineProperty(clone(value), 'fastTrack', { enumerable: true, get() { accesses++; return false; } });
  const nested = clone(value); Object.defineProperty(nested.answersPartial.Q1!, 'reason', { enumerable: true, get() { accesses++; return 'user'; } });
  const hidden = clone(value); Object.defineProperty(hidden, 'approval', { value: true, enumerable: false });
  const symbol = clone(value); Object.defineProperty(symbol, Symbol('authority'), { value: true });
  for (const invalid of [null, [], {}, missing, future, duplicate, last, getter, nested, hidden, symbol,
    { ...value, schemaVersion: 2 }, { ...value, id: value.id.toUpperCase() }, { ...value, userId: randomUUID() + '\n' },
    { ...value, sourceRevision: -0 }, { ...value, sourceRevision: 0 }, { ...value, sourceRevision: 2147483648 },
    { ...value, sourceRevision: 1.5 }, { ...value, sourceRevision: Number.NaN }, { ...value, fastTrack: 'false' },
    { ...value, safety: { level: 'L0', mode: 'full' } }, { ...value, state: 'intake_ready' },
    { ...value, model: 'fictional-injected-model' }, { ...value, birthPermission: true }, Object.assign(new Date(), value)]) {
    assert.throws(() => parseCapturedCompanionAnswers(invalid), unavailable);
  }
  assert.equal(accesses, 0);
});

test('answer values and text references are closed, canonical and immutable at every nested level', () => {
  const value = capture(complete()), badValue = clone(value), injected = clone(value), malformedText = clone(value);
  badValue.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2,
    value: { degreeField: 'cs', programChoice: '24_month', instructions: 'injected' } } as never;
  injected.answersPartial.Q1 = { kind: 'answered', source: 'user_entered', appliedRevision: 8, value: 'E' } as never;
  malformedText.answersPartial.study = { kind: 'skipped', reason: 'unmatched_text', appliedRevision: 2, textId: randomUUID() };
  for (const invalid of [badValue, injected, malformedText]) assert.throws(() => parseCapturedCompanionAnswers(invalid), unavailable);
  const fact = clone(value); fact.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2,
    value: { degreeField: 'cs', programChoice: '24_month' } };
  const parsed = parseCapturedCompanionAnswers(fact);
  assert(parsed.answersPartial.study?.kind === 'answered'); assert(Object.isFrozen(parsed.answersPartial.study.value));
});

test('extra preferences consume only the exact independently proven full L0 source and never persist raw context', () => {
  const { value, provenExtra } = withExtra(), saved = parseCapturedCompanionAnswers(value);
  assert.throws(() => prepareCapturedCompanionDimensions(saved), unavailable);
  const dimensions = prepareCapturedCompanionDimensions(saved, provenExtra);
  assert.deepEqual(dimensions, { warmth: 1, directness: 1, drive: 0, structure: 0, levity: 0, code_mix: 1, length: 'short' });
  assert(Object.isFrozen(dimensions)); assert.equal(JSON.stringify(saved).includes(provenExtra.text), false);
  for (const proof of [{ ...provenExtra, textId: randomUUID() }, { ...provenExtra, questionId: 'study' },
    { ...provenExtra, submittedAtRevision: provenExtra.submittedAtRevision - 1 }, { ...provenExtra, level: 'L1' },
    { ...provenExtra, mode: 'keyword_only' }, { ...provenExtra, detectorRevision: -0 }, { ...provenExtra, detectorRevision: 2147483648 },
    { ...provenExtra, text: ' ' }, { ...provenExtra, text: 'x'.repeat(4001) }, { ...provenExtra, text: 'bad\u0000text' },
    { ...provenExtra, text: '\ud800' }, { ...provenExtra, approved: true }]) {
    assert.throws(() => prepareCapturedCompanionDimensions(saved, proof as never), unavailable);
  }
  assert.throws(() => prepareCapturedCompanionDimensions(parseCapturedCompanionAnswers(capture(complete())), provenExtra), unavailable);
  let accesses = 0;
  const proofGetter = Object.defineProperty({ ...provenExtra }, 'text', { enumerable: true, get() { accesses++; return provenExtra.text; } });
  assert.throws(() => prepareCapturedCompanionDimensions(saved, proofGetter), unavailable); assert.equal(accesses, 0);
});

test('an unmatched basic-fact reference remains distinct from an extra preference source', () => {
  let draft = begin(), textId = randomUUID();
  draft = transitionOnboardingDraft(draft, { expectedRevision: draft.revision, operationId: textId,
    action: { kind: 'text', questionId: 'study', text: '别催我；Synthetic unmatched study context.' } }, { at });
  draft = resolveOnboardingText(draft, { textId, submittedAtRevision: draft.revision, level: 'L0', detectorRevision: 29,
    mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  draft = basic(draft);
  for (const [index, questionId] of scenarios.entries()) draft = action(draft,
    { kind: 'answer', questionId, value: ['D', 'A', 'B', 'D', 'A', 'A', 'A'][index] } as OnboardingAction);
  draft = action(draft, { kind: 'skip', questionId: 'extra' });
  const saved = parseCapturedCompanionAnswers(capture(draft));
  assert.equal(saved.answersPartial.study?.kind, 'skipped');
  assert.deepEqual(prepareCapturedCompanionDimensions(saved),
    { warmth: 1, directness: -1, drive: 1, structure: 0, levity: 1, code_mix: 1, length: 'short' });
});

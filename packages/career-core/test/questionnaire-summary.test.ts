import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS, type OnboardingAction, type OnboardingDraft } from '@companion/platform-contracts';
import { createOnboardingDraft, onboardingAnswerSummaries, onboardingQuestionDefinition, resolveOnboardingText, transitionOnboardingDraft } from '../src/index.ts';

const at = '2026-10-07T12:00:00.000Z', id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
let sequence = 10;
const send = (draft: OnboardingDraft, action: OnboardingAction) => transitionOnboardingDraft(draft, { expectedRevision: draft.revision, operationId: id(++sequence), action }, { at });
const started = (fast = false) => send(createOnboardingDraft({ id: id(1), userId: id(2), at }), { kind: 'start', mode: fast ? 'fast_track' : 'standard' });
function basics(fast = false) { let draft = started(fast); for (const questionId of ONBOARDING_BASIC_QUESTIONS) draft = send(draft, { kind: 'skip', questionId }); return draft; }
function extra() { let draft = basics(); for (const questionId of ONBOARDING_SCENARIO_QUESTIONS) draft = send(draft, { kind: 'skip', questionId }); return draft; }

test('answer summaries are ordered fixed projections of persisted answers, without unanswered or current questions', () => {
  assert.deepEqual(onboardingAnswerSummaries(started()), []);
  let draft = send(started(), { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: '16_month' } });
  draft = send(draft, { kind: 'answer', questionId: 'graduation', value: { month: '2027-05', graduated: false } });
  draft = send(draft, { kind: 'answer', questionId: 'roles', value: { kind: 'selected', roles: ['mle', 'swe', 'other'] } });
  const snapshot = structuredClone(draft), summaries = onboardingAnswerSummaries(draft);
  assert.deepEqual(summaries.map(summary => [summary.questionId, summary.label, summary.kind, summary.appliedRevision]), [
    ['study', 'CS · 一年半', 'answered', 2], ['graduation', '2027-05 · 预计毕业', 'answered', 3], ['roles', 'SWE、MLE、其他方向', 'answered', 4],
  ]);
  assert.equal(summaries.some(summary => summary.questionId === draft.currentQuestion), false);
  assert(summaries.every(summary => summary.prompt === onboardingQuestionDefinition(summary.questionId).prompt));
  assert(Object.isFrozen(summaries)); summaries.forEach(summary => assert(Object.isFrozen(summary))); assert.deepEqual(draft, snapshot);
});
test('summary labels retain explicit study, graduation, undecided and identity choices without inferred facts', () => {
  let draft = send(started(), { kind: 'answer', questionId: 'study', value: { degreeField: 'ece_ee', programChoice: null } });
  draft = send(draft, { kind: 'answer', questionId: 'graduation', value: { month: '2026-08', graduated: true } });
  draft = send(draft, { kind: 'answer', questionId: 'roles', value: { kind: 'undecided' } });
  draft = send(draft, { kind: 'answer', questionId: 'search_stage', value: 'graduated_looking' });
  draft = send(draft, { kind: 'answer', questionId: 'emotion_language', value: 'either' });
  draft = send(draft, { kind: 'answer', questionId: 'identity_stage', value: 'prefer_not_say' });
  assert.deepEqual(onboardingAnswerSummaries(draft).map(summary => summary.label), ['ECE / EE', '2026-08 · 已毕业', '还不确定', '已毕业，在找工作', '都行', '不想说']);
  assert.doesNotMatch(JSON.stringify(onboardingAnswerSummaries(draft)), /eligible|confirmed|memory|学制/);
});
test('all scenario answers use their question-specific fixed labels, never raw choice codes or invented traits', () => {
  let draft = basics();
  for (const questionId of ONBOARDING_SCENARIO_QUESTIONS) draft = send(draft, { kind: 'answer', questionId, value: 'C' });
  const summaries = onboardingAnswerSummaries(draft).slice(6);
  assert.deepEqual(summaries.map(summary => summary.questionId), [...ONBOARDING_SCENARIO_QUESTIONS]);
  summaries.forEach(summary => assert.equal(summary.label, onboardingQuestionDefinition(summary.questionId).choices.find(choice => choice.value === 'C')?.label));
  assert.equal(summaries.some(summary => summary.questionId === 'extra'), false);
});
test('user, remaining, fast-track and unmatched-text skips keep distinct reasons and do not become facts', () => {
  const user = onboardingAnswerSummaries(send(started(), { kind: 'skip', questionId: 'study' }))[0];
  let remaining = send(basics(), { kind: 'answer', questionId: 'Q1', value: 'A' }); remaining = send(remaining, { kind: 'skip_remaining' });
  const later = onboardingAnswerSummaries(remaining).find(summary => summary.questionId === 'Q2');
  const fast = onboardingAnswerSummaries(basics(true)).find(summary => summary.questionId === 'Q1');
  const pending = send(started(), { kind: 'text', questionId: 'study', text: 'Fictional unmatched message.' });
  const resolved = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
    level: 'L0', detectorRevision: 1, mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  const unmatched = onboardingAnswerSummaries(resolved)[0];
  assert.deepEqual([user, later, fast, unmatched].map(summary => summary?.kind === 'skipped' && summary.reason), ['user', 'remaining', 'fast_track', 'unmatched_text']);
  assert.equal(new Set([user, later, fast, unmatched].map(summary => summary?.label)).size, 4);
  assert.doesNotMatch(JSON.stringify(onboardingAnswerSummaries(resolved)), /Fictional unmatched|textId|user_entered/);
});
test('extra submits and skips have reference-free fixed labels, never echoing text or implying long-term memory', () => {
  const pending = send(extra(), { kind: 'text', questionId: 'extra', text: 'Fictional private preference with sensitive words.' });
  const ready = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L0', detectorRevision: 1, mode: 'full' }, { at });
  const submitted = onboardingAnswerSummaries(ready).at(-1)!;
  assert.equal(submitted.questionId, 'extra'); assert.equal(submitted.label, '补充已提交'); assert.equal(submitted.kind, 'answered');
  for (const skipped of [send(extra(), { kind: 'skip', questionId: 'extra' }), basics(true)]) {
    const summary = onboardingAnswerSummaries(skipped).at(-1)!; assert.equal(summary.label, '补充已跳过'); assert.equal(summary.kind, 'skipped');
  }
  assert.doesNotMatch(JSON.stringify(onboardingAnswerSummaries(ready)), /Fictional private|textId|00000000|memory|authorized|长期记忆/);
});
test('paused and pending risk submissions never become summaries or skips; corrupt drafts fail before projection', () => {
  const before = send(started(), { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: '24_month' } });
  const pending = send(before, { kind: 'text', questionId: 'graduation', text: 'Fictional high-risk text.' });
  const paused = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L2', detectorRevision: 1, mode: 'full' }, { at });
  assert.deepEqual(onboardingAnswerSummaries(paused), onboardingAnswerSummaries(before));
  assert.deepEqual(onboardingAnswerSummaries(pending), onboardingAnswerSummaries(before));
  assert.equal(paused.answersPartial.graduation, undefined); assert.equal(paused.safety?.level, 'L2');
  assert.throws(() => onboardingAnswerSummaries({ ...before, answersPartial: { ...before.answersPartial, Q1: { kind: 'answered', value: 'A', source: 'user_entered', appliedRevision: 2 } } }));
});

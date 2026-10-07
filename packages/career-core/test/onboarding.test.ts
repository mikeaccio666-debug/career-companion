import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS, type OnboardingAction, type OnboardingDraft } from '@companion/platform-contracts';
import { OnboardingError, createOnboardingDraft, parseOnboardingCommand, parseOnboardingDraft, resolveOnboardingText, transitionOnboardingDraft } from '../src/index.ts';

const at = '2026-10-07T12:00:00.000Z';
const id = (number = 1) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const create = () => createOnboardingDraft({ id: id(1), userId: id(2), at });
let sequence = 10;
const send = (draft: OnboardingDraft, action: OnboardingAction) => transitionOnboardingDraft(draft, { expectedRevision: draft.revision, operationId: id(++sequence), action }, { at });
const started = (fast = false) => send(create(), { kind: 'start', mode: fast ? 'fast_track' : 'standard' });
function basic(fast = false) { let draft = started(fast); for (const questionId of ONBOARDING_BASIC_QUESTIONS) draft = send(draft, { kind: 'skip', questionId }); return draft; }
function extra() { let draft = basic(); for (const questionId of ONBOARDING_SCENARIO_QUESTIONS) draft = send(draft, { kind: 'skip', questionId }); return draft; }
const rejects = (run: () => unknown, code: OnboardingError['code'] = 'ONBOARDING_INVALID_INPUT') => assert.throws(run, (error: unknown) => error instanceof OnboardingError && error.code === code);

test('initial draft is a strict revision-zero O1 draft, not a companion or completed onboarding', () => {
  const draft = create(); assert.equal(draft.revision, 0); assert.equal(draft.step, 'O1'); assert.equal(draft.currentQuestion, null);
  assert.deepEqual(draft.answersPartial, {}); assert.equal(draft.state, 'collecting');
  assert.deepEqual(parseOnboardingDraft(JSON.parse(JSON.stringify(draft))), draft);
  for (const field of ['active', 'completed', 'firstLetterDelivered', 'persona', 'profileConfirmed', 'companionId']) rejects(() => parseOnboardingDraft({ ...draft, [field]: true }), 'ONBOARDING_INVALID_STATE');
});
test('command parser rejects authority, cursor and unclosed nested fields', () => {
  const command = { expectedRevision: 0, operationId: id(3), action: { kind: 'start', mode: 'standard' } };
  for (const field of ['userId', 'ownerId', 'safety', 'step', 'completed', 'rulesRevision']) rejects(() => parseOnboardingCommand({ ...command, [field]: id(2) }));
  for (const action of [{ kind: 'start', mode: 'standard', completed: true }, { kind: 'skip_remaining', questionId: 'Q1' },
    { kind: 'skip', questionId: 'study', reason: 'unmatched_text', textId: id(4) },
    { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: null, school: 'Fictional School' } },
    { kind: 'answer', questionId: 'extra', value: { textId: id(4) } }, { kind: 'text', questionId: 'extra', text: 'fictional', level: 'L0' }]) rejects(() => parseOnboardingCommand({ ...command, action }));
});
test('identifiers and revisions use exact closed bounds including terminal controls', () => {
  const command = { expectedRevision: 0, operationId: id(3), action: { kind: 'start', mode: 'standard' } };
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) rejects(() => parseOnboardingCommand({ ...command, operationId: command.operationId + suffix }));
  for (const expectedRevision of [-1, 0.5, Infinity, 2147483647, '0']) rejects(() => parseOnboardingCommand({ ...command, expectedRevision }));
  assert.equal(parseOnboardingCommand({ ...command, expectedRevision: 2147483646 }).expectedRevision, 2147483646);
  const pending = send(started(), { kind: 'text', questionId: 'study', text: 'Fictional pending text.' });
  assert.equal(parseOnboardingDraft({ ...pending, revision: 2147483647,
    pendingText: { ...pending.pendingText!, submittedAtRevision: 2147483647 } }).revision, 2147483647);
});
test('parsed commands and returned drafts do not retain mutable caller values', () => {
  const value = { kind: 'selected', roles: ['mle', 'swe'] };
  const parsed = parseOnboardingCommand({ expectedRevision: 3, operationId: id(4).toUpperCase(), action: { kind: 'answer', questionId: 'roles', value } });
  value.roles.push('ds'); assert.deepEqual(parsed.action, { kind: 'answer', questionId: 'roles', value: { kind: 'selected', roles: ['swe', 'mle'] } });
  const initial = create(), next = send(initial, { kind: 'start', mode: 'standard' }); next.answersPartial.study = { kind: 'skipped', reason: 'user', appliedRevision: 2 };
  assert.deepEqual(initial.answersPartial, {}); assert.equal(initial.revision, 0);
});
test('accessors and non-data inputs are rejected without evaluating a getter', () => {
  let called = false; const input = { expectedRevision: 0, operationId: id(3), action: { kind: 'start', mode: 'standard' } };
  Object.defineProperty(input, 'expectedRevision', { get() { called = true; return 0; } }); rejects(() => parseOnboardingCommand(input)); assert.equal(called, false);
  rejects(() => parseOnboardingDraft(new Date()), 'ONBOARDING_INVALID_STATE');
});
test('basic facts remain explicit user-entered draft choices and do not derive a program type', () => {
  let draft = started(); draft = send(draft, { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: null } });
  draft = send(draft, { kind: 'answer', questionId: 'graduation', value: { month: '2027-05', graduated: false } });
  assert.deepEqual(draft.answersPartial.study, { kind: 'answered', value: { degreeField: 'cs', programChoice: null }, source: 'user_entered', appliedRevision: 2 });
  assert.deepEqual(draft.answersPartial.graduation, { kind: 'answered', value: { month: '2027-05', graduated: false }, source: 'user_entered', appliedRevision: 3 });
  const explicit = send(started(), { kind: 'answer', questionId: 'study', value: { degreeField: 'ece_ee', programChoice: '16_month' } });
  assert.equal(explicit.answersPartial.study?.kind, 'answered'); assert.equal(Object.hasOwn(explicit, 'profile'), false);
});
test('question-specific schemas reject invalid options, guessed fields and duplicate role values', () => {
  for (const [questionId, value] of [['Q2', 'D'], ['study', { degreeField: 'cs', programChoice: '18_month' }],
    ['graduation', { month: '2027-13', graduated: false }], ['graduation', { month: '2027-05\n', graduated: false }],
    ['roles', { kind: 'selected', roles: ['swe', 'swe'] }], ['roles', { kind: 'undecided', roles: [] }],
    ['identity_stage', 'eligible_for_opt'], ['emotion_language', 'auto']]) rejects(() => parseOnboardingCommand({ expectedRevision: 1, operationId: id(3), action: { kind: 'answer', questionId, value } }));
});
test('stale revision and out-of-order questions cannot overwrite progress', () => {
  const draft = started(); rejects(() => transitionOnboardingDraft(draft, { expectedRevision: 0, operationId: id(3), action: { kind: 'skip', questionId: 'study' } }, { at }), 'ONBOARDING_REVISION_CHANGED');
  rejects(() => send(draft, { kind: 'skip', questionId: 'graduation' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
  rejects(() => send(draft, { kind: 'start', mode: 'fast_track' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
  assert.equal(draft.revision, 1); assert.deepEqual(draft.answersPartial, {});
});
test('fast track asks all basic questions then explicitly skips scenarios and O4', () => {
  let draft = started(true); for (const questionId of ONBOARDING_BASIC_QUESTIONS.slice(0, -1)) draft = send(draft, { kind: 'skip', questionId });
  assert.equal(draft.step, 'O2'); assert.equal(draft.currentQuestion, 'identity_stage'); assert.equal(draft.answersPartial.Q1, undefined);
  draft = send(draft, { kind: 'skip', questionId: 'identity_stage' }); assert.equal(draft.step, 'O5'); assert.equal(draft.state, 'intake_ready');
  for (const questionId of [...ONBOARDING_SCENARIO_QUESTIONS, 'extra'] as const) assert.deepEqual(draft.answersPartial[questionId], { kind: 'skipped', reason: 'fast_track', appliedRevision: draft.revision });
  rejects(() => send(draft, { kind: 'skip', questionId: 'extra' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
});
test('fast track preserves an unmatched basic text reference before its atomic scenario skips', () => {
  let draft = started(true);
  for (const questionId of ONBOARDING_BASIC_QUESTIONS.slice(0, -1)) draft = send(draft, { kind: 'skip', questionId });
  const pending = send(draft, { kind: 'text', questionId: 'identity_stage', text: 'Fictional unmatched identity answer.' });
  draft = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
    level: 'L0', detectorRevision: 1, mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  assert.equal(draft.state, 'intake_ready'); assert.equal(draft.step, 'O5');
  assert.deepEqual(draft.answersPartial.identity_stage, { kind: 'skipped', reason: 'unmatched_text', textId: pending.pendingText!.id, appliedRevision: draft.revision });
  for (const questionId of [...ONBOARDING_SCENARIO_QUESTIONS, 'extra'] as const) assert.deepEqual(draft.answersPartial[questionId], { kind: 'skipped', reason: 'fast_track', appliedRevision: draft.revision });
  assert.deepEqual(parseOnboardingDraft(JSON.parse(JSON.stringify(draft))), draft);
});
test('skip remaining preserves answered scenarios and does not imply skipping O4', () => {
  let draft = basic(); draft = send(draft, { kind: 'answer', questionId: 'Q1', value: 'C' });
  const first = draft.answersPartial.Q1; draft = send(draft, { kind: 'skip_remaining' });
  assert.deepEqual(draft.answersPartial.Q1, first); assert.equal(draft.step, 'O4'); assert.equal(draft.state, 'collecting');
  for (const questionId of ONBOARDING_SCENARIO_QUESTIONS.slice(1)) assert.deepEqual(draft.answersPartial[questionId], { kind: 'skipped', reason: 'remaining', appliedRevision: draft.revision });
  assert.equal(draft.answersPartial.extra, undefined); rejects(() => send(started(), { kind: 'skip_remaining' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
});
test('normal skipped answers distinguish unanswered, skipped and answered', () => {
  let draft = basic(); assert.equal(draft.answersPartial.Q1, undefined);
  draft = send(draft, { kind: 'skip', questionId: 'Q1' }); assert.equal(draft.answersPartial.Q1?.kind, 'skipped');
  draft = send(draft, { kind: 'answer', questionId: 'Q2', value: 'B' }); assert.equal(draft.answersPartial.Q2?.kind, 'answered');
  assert.deepEqual(parseOnboardingDraft(JSON.parse(JSON.stringify(draft))), draft);
});
test('every typed question uses pending classification without copying raw text into the draft', () => {
  const draft = send(started(), { kind: 'text', questionId: 'study', text: 'A fictional school and course.' });
  assert.equal(draft.state, 'safety_pending'); assert.equal(draft.currentQuestion, 'study'); assert.equal(draft.answersPartial.study, undefined);
  assert.equal(JSON.stringify(draft).includes('fictional school'), false); assert.equal(draft.pendingText?.submittedAtRevision, draft.revision);
  rejects(() => send(draft, { kind: 'skip', questionId: 'study' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
  rejects(() => transitionOnboardingDraft(started(), { expectedRevision: 1, operationId: id(3), action: { kind: 'text', questionId: 'study', text: 'fictional' } }, { at, textId: id(4) }));
});
test('replacing pending text invalidates the old submission and safety result', () => {
  const first = send(extra(), { kind: 'text', questionId: 'extra', text: '别催我' });
  const second = send(first, { kind: 'text', questionId: 'extra', text: '说话直一点' });
  rejects(() => resolveOnboardingText(second, { textId: first.pendingText!.id, submittedAtRevision: first.revision, level: 'L0', detectorRevision: 1, mode: 'full' }, { at }), 'ONBOARDING_TEXT_STALE');
  assert.equal(second.state, 'safety_pending'); assert.equal(second.revision, first.revision + 1);
});
test('L0 extra resolves to an immutable reference and only intake readiness', () => {
  const pending = send(extra(), { kind: 'text', questionId: 'extra', text: '别催我' });
  const draft = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L0', detectorRevision: 2, mode: 'full' }, { at });
  assert.equal(draft.state, 'intake_ready'); assert.equal(draft.step, 'O5'); assert.equal(draft.pendingText, undefined);
  assert.deepEqual(draft.answersPartial.extra, { kind: 'answered', value: { textId: pending.pendingText!.id }, source: 'user_entered', textId: pending.pendingText!.id, appliedRevision: draft.revision });
  assert.equal(Object.hasOwn(draft, 'completed'), false); assert.equal(pending.state, 'safety_pending');
});
test('full L0 unmatched skips a basic choice with its text reference and advances without inventing a fact', () => {
  const pending = send(started(), { kind: 'text', questionId: 'study', text: 'A fictional explanation that matches no choice.' });
  const draft = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L0', detectorRevision: 1, mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  assert.equal(draft.state, 'collecting'); assert.equal(draft.currentQuestion, 'graduation');
  assert.deepEqual(draft.answersPartial.study, { kind: 'skipped', reason: 'unmatched_text', textId: pending.pendingText!.id, appliedRevision: draft.revision });
  assert.equal(JSON.stringify(draft).includes('fictional explanation'), false);
  assert.deepEqual(parseOnboardingDraft(JSON.parse(JSON.stringify(draft))), draft);
  const chosen = send(draft, { kind: 'skip', questionId: 'graduation' }); assert.equal(chosen.currentQuestion, 'roles');
  assert.deepEqual(chosen.answersPartial.graduation, { kind: 'skipped', reason: 'user', appliedRevision: chosen.revision });
});
test('full L0 unmatched skips a scenario with zero increments and advances across the scenario boundary', () => {
  let draft = basic();
  for (const questionId of ONBOARDING_SCENARIO_QUESTIONS.slice(0, -1)) draft = send(draft, { kind: 'skip', questionId });
  const pending = send(draft, { kind: 'text', questionId: 'Q7', text: 'Fictional answer with no matching option.' });
  const next = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
    level: 'L0', detectorRevision: 1, mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  assert.equal(next.step, 'O4'); assert.equal(next.currentQuestion, 'extra');
  assert.deepEqual(next.answersPartial.Q7, { kind: 'skipped', reason: 'unmatched_text', textId: pending.pendingText!.id, appliedRevision: next.revision });
});
test('codec requires the unmatched context reference and exact full L0 receipt binding', () => {
  const pending = send(started(), { kind: 'text', questionId: 'study', text: 'Fictional unmatched text.' });
  const draft = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
    level: 'L0', detectorRevision: 1, mode: 'full', resolution: { kind: 'unmatched' } }, { at });
  for (const study of [
    { kind: 'skipped', reason: 'unmatched_text', appliedRevision: draft.revision },
    { kind: 'skipped', reason: 'unmatched_text', textId: id(999), appliedRevision: draft.revision },
    { kind: 'skipped', reason: 'unmatched_text', textId: pending.pendingText!.id, appliedRevision: draft.revision - 1 },
    { kind: 'skipped', reason: 'user', textId: pending.pendingText!.id, appliedRevision: draft.revision },
  ]) rejects(() => parseOnboardingDraft({ ...draft, answersPartial: { study } }), 'ONBOARDING_INVALID_STATE');
  rejects(() => parseOnboardingDraft({ ...draft, currentQuestion: 'study' }), 'ONBOARDING_INVALID_STATE');
  const ordinary = send(extra(), { kind: 'skip', questionId: 'extra' });
  rejects(() => parseOnboardingDraft({ ...ordinary, answersPartial: { ...ordinary.answersPartial,
    extra: { kind: 'skipped', reason: 'unmatched_text', textId: id(999), appliedRevision: ordinary.revision } } }), 'ONBOARDING_INVALID_STATE');
});
test('classified structured answers must resolve this exact question and remain user-entered drafts', () => {
  const pending = send(started(), { kind: 'text', questionId: 'study', text: 'CS' }), result = { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L0' as const, detectorRevision: 1, mode: 'full' as const };
  rejects(() => resolveOnboardingText(pending, { ...result, resolution: { kind: 'answer', questionId: 'Q1', value: 'A' } }, { at }));
  rejects(() => resolveOnboardingText(pending, result, { at }));
  const draft = resolveOnboardingText(pending, { ...result, resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: null } } }, { at });
  assert.equal(draft.currentQuestion, 'graduation'); assert.equal(draft.answersPartial.study?.kind, 'answered');
  assert.equal(draft.answersPartial.study?.kind === 'answered' && draft.answersPartial.study.textId, pending.pendingText!.id);
});
for (const level of ['L1', 'L2'] as const) test(`${level} pauses at the unresolved question without treating risk as a skip`, () => {
  const pending = send(extra(), { kind: 'text', questionId: 'extra', text: 'Fictional safety test message.' });
  const result = { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level, detectorRevision: 1, mode: 'keyword_only' as const };
  const draft = resolveOnboardingText(pending, result, { at }); assert.equal(draft.state, 'safety_paused'); assert.equal(draft.step, 'O4');
  assert.equal(draft.answersPartial.extra, undefined); assert.equal(draft.currentQuestion, 'extra');
  rejects(() => send(draft, { kind: 'skip', questionId: 'extra' }), 'ONBOARDING_ACTION_NOT_ALLOWED');
  rejects(() => resolveOnboardingText(pending, { ...result, resolution: { kind: 'unmatched' } }, { at }));
});
test('keyword-only detection cannot approve L0 text or advance a pending question', () => {
  for (const before of [started(), extra()]) {
    const questionId = before.currentQuestion!, pending = send(before, { kind: 'text', questionId, text: 'Fictional detector fallback test.' });
    const snapshot = structuredClone(pending);
    rejects(() => resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
      level: 'L0', detectorRevision: 1, mode: 'keyword_only', ...(questionId === 'extra' ? {} : { resolution: { kind: 'unmatched' as const } }) }, { at }));
    assert.deepEqual(pending, snapshot); assert.equal(pending.state, 'safety_pending'); assert.equal(pending.answersPartial[questionId], undefined);
  }
});
test('decrypted-state codec refuses a keyword-only L0 receipt even on an otherwise ready draft', () => {
  const pending = send(extra(), { kind: 'text', questionId: 'extra', text: '别催我' });
  const ready = resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision,
    level: 'L0', detectorRevision: 1, mode: 'full' }, { at });
  rejects(() => parseOnboardingDraft({ ...ready, safety: { ...ready.safety!, mode: 'keyword_only' } }), 'ONBOARDING_INVALID_STATE');
  assert.equal(parseOnboardingDraft(ready).safety?.mode, 'full');
});
test('invalid text, timestamps, missing or forged classification bindings fail closed', () => {
  for (const value of ['', '  ', 'a\0b', '\ud800', 'x'.repeat(4001)]) rejects(() => send(extra(), { kind: 'text', questionId: 'extra', text: value }));
  for (const at of ['2026-10-07', '2026-02-31T12:00:00.000Z', '2026-10-07T12:00:00.000Z\n']) rejects(() => createOnboardingDraft({ id: id(1), userId: id(2), at }));
  const pending = send(extra(), { kind: 'text', questionId: 'extra', text: 'fictional' });
  for (const changed of [{ textId: id(999) }, { submittedAtRevision: pending.revision - 1 }, { detectorRevision: 0 }, { mode: 'assumed' }, { level: 'UNKNOWN' }]) {
    assert.throws(() => resolveOnboardingText(pending, { textId: pending.pendingText!.id, submittedAtRevision: pending.revision, level: 'L0', detectorRevision: 1, mode: 'full', ...changed } as never, { at }), OnboardingError);
  }
});
test('decrypted-state codec rejects unknown revisions and contradictory cursor/answer/safety states', () => {
  const draft = started();
  for (const changed of [{ schemaVersion: 2 }, { questionnaireRevision: 2 }, { rulesRevision: 0 }, { revision: 2147483648 },
    { currentQuestion: 'graduation' }, { step: 'O5', currentQuestion: null, state: 'intake_ready' }, { state: 'safety_pending' },
    { answersPartial: { Q1: { kind: 'answered', value: 'A', source: 'user_entered', appliedRevision: 1 } } },
    { answersPartial: { study: { kind: 'skipped', reason: 'fast_track', appliedRevision: 1 } } },
    { answersPartial: { study: { kind: 'skipped', reason: 'unmatched_text', appliedRevision: 1 } } }]) rejects(() => parseOnboardingDraft({ ...draft, ...changed }), 'ONBOARDING_INVALID_STATE');
});
test('codec rejects impossible partial skip-remaining and split fast-track batches', () => {
  let draft = basic(); draft = send(draft, { kind: 'skip_remaining' });
  const split = structuredClone(draft); split.answersPartial.Q4 = { kind: 'skipped', reason: 'user', appliedRevision: draft.revision };
  rejects(() => parseOnboardingDraft(split), 'ONBOARDING_INVALID_STATE');
  const missing = structuredClone(draft); delete missing.answersPartial.Q7; missing.step = 'O3'; missing.currentQuestion = 'Q7';
  rejects(() => parseOnboardingDraft(missing), 'ONBOARDING_INVALID_STATE');
  const fast = basic(true); fast.answersPartial.extra = { kind: 'skipped', reason: 'fast_track', appliedRevision: fast.revision - 1 };
  rejects(() => parseOnboardingDraft(fast), 'ONBOARDING_INVALID_STATE');
});
test('codec rejects shared ordinary revisions and premature text resolution while preserving legitimate batches', () => {
  const draft = send(send(started(), { kind: 'skip', questionId: 'study' }), { kind: 'skip', questionId: 'graduation' });
  rejects(() => parseOnboardingDraft({ ...draft, revision: 2, answersPartial: {
    study: { kind: 'skipped', reason: 'user', appliedRevision: 2 },
    graduation: { kind: 'skipped', reason: 'user', appliedRevision: 2 },
  } }), 'ONBOARDING_INVALID_STATE');
  rejects(() => parseOnboardingDraft({ ...draft, answersPartial: {
    study: { kind: 'answered', value: { degreeField: 'cs', programChoice: null }, source: 'user_entered', appliedRevision: 2 },
    graduation: { kind: 'skipped', reason: 'user', appliedRevision: 2 },
  } }), 'ONBOARDING_INVALID_STATE');
  const first = send(started(), { kind: 'skip', questionId: 'study' });
  rejects(() => parseOnboardingDraft({ ...first, answersPartial: { study: { kind: 'skipped', reason: 'user', appliedRevision: 1 } } }), 'ONBOARDING_INVALID_STATE');
  rejects(() => parseOnboardingDraft({ ...first, answersPartial: {
    study: { kind: 'skipped', reason: 'unmatched_text', textId: id(999), appliedRevision: 2 },
  } }), 'ONBOARDING_INVALID_STATE');
  const fast = basic(true); assert.deepEqual(parseOnboardingDraft(fast), fast);
  const remaining = send(basic(), { kind: 'skip_remaining' });
  assert.deepEqual(parseOnboardingDraft(remaining), remaining);
});
test('ready intake cannot have a later draft revision than its final immutable answer or batch', () => {
  const fast = basic(true), normal = send(extra(), { kind: 'skip', questionId: 'extra' });
  for (const draft of [fast, normal]) rejects(() => parseOnboardingDraft({ ...draft, revision: draft.revision + 1 }), 'ONBOARDING_INVALID_STATE');
});
test('valid Unicode text survives parsing intact for encrypted persistence', () => {
  const raw = 'Fictional text 🧭\n别催我';
  const parsed = parseOnboardingCommand({ expectedRevision: 1, operationId: id(3), action: { kind: 'text', questionId: 'study', text: raw } });
  assert.equal(parsed.action.kind === 'text' && parsed.action.text, raw);
});

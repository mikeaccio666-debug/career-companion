import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS,
  type OnboardingAction, type OnboardingAnswer, type OnboardingAnswersPartial, type OnboardingCommand, type OnboardingDraft,
  type OnboardingQuestion, type OnboardingQuestionValues, type OnboardingSafetyResult, type OnboardingTextResolution } from '@companion/platform-contracts';
import { ROLE_FAMILIES } from '../contracts.ts';

const MAX_REVISION = 2147483647;
export const ONBOARDING_TEXT_MAX_CHARACTERS = 4000;
const questions: readonly OnboardingQuestion[] = [...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra'];
export type OnboardingErrorCode = 'ONBOARDING_INVALID_INPUT' | 'ONBOARDING_INVALID_STATE' | 'ONBOARDING_REVISION_CHANGED'
  | 'ONBOARDING_ACTION_NOT_ALLOWED' | 'ONBOARDING_TEXT_STALE' | 'ONBOARDING_SAFETY_REQUIRED';
export class OnboardingError extends Error {
  constructor(readonly code: OnboardingErrorCode) { super(code); this.name = 'OnboardingError'; }
}
function fail(code: OnboardingErrorCode = 'ONBOARDING_INVALID_INPUT'): never { throw new OnboardingError(code); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) fail();
  return value as Record<string, unknown>;
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(); return value as T;
}
function integer(value: unknown, minimum = 0, maximum = MAX_REVISION): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(value)?.[0] !== value) fail();
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.exec(value)?.[0] !== value
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function question(value: unknown): OnboardingQuestion { return member(value, questions); }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > ONBOARDING_TEXT_MAX_CHARACTERS
    || /[\ud800-\udfff]/u.test(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(); return value;
}
function valueFor<K extends OnboardingQuestion>(id: K, value: unknown): OnboardingQuestionValues[K] {
  let parsed: unknown;
  if (id === 'study') {
    const data = record(value, ['degreeField', 'programChoice']);
    parsed = { degreeField: member(data.degreeField, ['cs', 'ds_statistics', 'ece_ee', 'other_stem']),
      programChoice: data.programChoice === null ? null : member(data.programChoice, ['12_month', '16_month', '24_month', 'other']) };
  } else if (id === 'graduation') {
    const data = record(value, ['month', 'graduated']);
    if (typeof data.month !== 'string' || /^\d{4}-(0[1-9]|1[0-2])$/.exec(data.month)?.[0] !== data.month || data.month.startsWith('0000')) fail();
    parsed = { month: data.month, graduated: boolean(data.graduated) };
  } else if (id === 'roles') {
    const data = record(value, ['kind'], ['roles']);
    if (data.kind === 'undecided') { if (Object.hasOwn(data, 'roles')) fail(); parsed = { kind: 'undecided' }; }
    else {
      if (data.kind !== 'selected' || !Array.isArray(data.roles) || !data.roles.length || data.roles.length > ROLE_FAMILIES.length) fail();
      const selected = data.roles.map(role => member(role, ROLE_FAMILIES)); if (new Set(selected).size !== selected.length) fail();
      parsed = { kind: 'selected', roles: ROLE_FAMILIES.filter(role => selected.includes(role)) };
    }
  } else if (id === 'search_stage') parsed = member(value, ['not_started', 'applying', 'interviewing', 'offer', 'graduated_looking']);
  else if (id === 'emotion_language') parsed = member(value, ['zh', 'en', 'either']);
  else if (id === 'identity_stage') parsed = member(value, ['f1_student', 'opt', 'stem_opt', 'other', 'prefer_not_say']);
  else if (id === 'extra') parsed = { textId: uuid(record(value, ['textId']).textId) };
  else parsed = member(value, ['Q1', 'Q3', 'Q4'].includes(id) ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C']);
  return parsed as OnboardingQuestionValues[K];
}
function guarded<T>(run: () => T, code: OnboardingErrorCode = 'ONBOARDING_INVALID_INPUT'): T {
  try { return run(); } catch (error) { if (error instanceof OnboardingError) {
    if (code === 'ONBOARDING_INVALID_STATE' && error.code === 'ONBOARDING_INVALID_INPUT') fail(code); throw error;
  } fail(code); }
}
function parseAction(value: unknown): OnboardingAction {
  const base = record(value, ['kind'], ['mode', 'questionId', 'value', 'text']);
  if (base.kind === 'start') { const data = record(value, ['kind', 'mode']); return { kind: 'start', mode: member(data.mode, ['standard', 'fast_track']) }; }
  if (base.kind === 'skip_remaining') { record(value, ['kind']); return { kind: 'skip_remaining' }; }
  if (base.kind === 'skip') { const data = record(value, ['kind', 'questionId']); return { kind: 'skip', questionId: question(data.questionId) }; }
  if (base.kind === 'text') { const data = record(value, ['kind', 'questionId', 'text']); return { kind: 'text', questionId: question(data.questionId), text: text(data.text) }; }
  if (base.kind === 'answer') {
    const data = record(value, ['kind', 'questionId', 'value']), id = question(data.questionId); if (id === 'extra') fail();
    return { kind: 'answer', questionId: id, value: valueFor(id, data.value) } as OnboardingAction;
  }
  fail();
}
/** Copies canonical values; callers cannot mutate a parsed command while a database operation awaits. */
export function parseOnboardingCommand(value: unknown): OnboardingCommand {
  return guarded(() => { const data = record(value, ['expectedRevision', 'operationId', 'action']);
    return { expectedRevision: integer(data.expectedRevision, 0, MAX_REVISION - 1), operationId: uuid(data.operationId), action: parseAction(data.action) }; });
}
function parseAnswers(value: unknown, revision: number): OnboardingAnswersPartial {
  const input = record(value, [], questions), parsed: Record<string, OnboardingAnswer<unknown>> = {};
  for (const id of questions) {
    if (!Object.hasOwn(input, id)) continue;
    const base = record(input[id], ['kind', 'appliedRevision'], ['value', 'source', 'textId', 'reason']);
    const appliedRevision = integer(base.appliedRevision, 1, revision);
    if (base.kind === 'skipped') {
      const reason = member(base.reason, ['user', 'fast_track', 'remaining', 'unmatched_text']);
      if (reason === 'unmatched_text') {
        const data = record(input[id], ['kind', 'appliedRevision', 'reason', 'textId']);
        parsed[id] = { kind: 'skipped', reason, appliedRevision, textId: uuid(data.textId) };
      } else {
        record(input[id], ['kind', 'appliedRevision', 'reason']);
        parsed[id] = { kind: 'skipped', reason, appliedRevision };
      }
    } else {
      const data = record(input[id], ['kind', 'appliedRevision', 'value', 'source'], ['textId']);
      if (data.kind !== 'answered' || data.source !== 'user_entered') fail();
      const answer: OnboardingAnswer<unknown> = { kind: 'answered', value: valueFor(id, data.value), source: 'user_entered', appliedRevision };
      if (Object.hasOwn(data, 'textId')) answer.textId = uuid(data.textId);
      if (id === 'extra' && answer.textId !== (answer.value as { textId: string }).textId) fail();
      parsed[id] = answer;
    }
  }
  return parsed as OnboardingAnswersPartial;
}
function position(answers: OnboardingAnswersPartial): { step: OnboardingDraft['step']; currentQuestion: OnboardingQuestion | null } {
  for (const id of ONBOARDING_BASIC_QUESTIONS) if (!answers[id]) return { step: 'O2', currentQuestion: id };
  for (const id of ONBOARDING_SCENARIO_QUESTIONS) if (!answers[id]) return { step: 'O3', currentQuestion: id };
  return answers.extra ? { step: 'O5', currentQuestion: null } : { step: 'O4', currentQuestion: 'extra' };
}
function parseSafety(value: unknown): NonNullable<OnboardingDraft['safety']> {
  const data = record(value, ['textId', 'questionId', 'submittedAtRevision', 'level', 'detectorRevision', 'mode']);
  const level = member(data.level, ['L0', 'L1', 'L2']), mode = member(data.mode, ['full', 'keyword_only']);
  // A degraded keyword-only detector cannot establish an L0 approval (09 §4).
  if (level === 'L0' && mode === 'keyword_only') fail();
  return { textId: uuid(data.textId), questionId: question(data.questionId), submittedAtRevision: integer(data.submittedAtRevision, 1),
    level, detectorRevision: integer(data.detectorRevision, 1), mode };
}
function checkState(draft: OnboardingDraft): void {
  let gap = false, lastRevision = 1, previous: OnboardingAnswer<unknown> | undefined;
  for (const id of questions) {
    const answer = draft.answersPartial[id]; if (!answer) { gap = true; continue; }
    const sameRevisionBatch = answer.kind === 'skipped' && (answer.reason === 'fast_track'
      || answer.reason === 'remaining' && previous?.kind === 'skipped' && previous.reason === 'remaining');
    if (gap || answer.appliedRevision < lastRevision || answer.appliedRevision === lastRevision && !sameRevisionBatch) fail();
    if ('textId' in answer && answer.appliedRevision < 3) fail();
    lastRevision = answer.appliedRevision; previous = answer;
    if (answer.kind === 'skipped') {
      if (ONBOARDING_BASIC_QUESTIONS.includes(id as never) && !['user', 'unmatched_text'].includes(answer.reason)) fail();
      if (answer.reason === 'unmatched_text' && id === 'extra') fail();
      if (answer.reason === 'remaining' && !ONBOARDING_SCENARIO_QUESTIONS.includes(id as never)) fail();
      if ((answer.reason === 'fast_track') !== (draft.fastTrack && !ONBOARDING_BASIC_QUESTIONS.includes(id as never))) fail();
    } else if (draft.fastTrack && !ONBOARDING_BASIC_QUESTIONS.includes(id as never)) fail();
  }
  const firstRemaining = ONBOARDING_SCENARIO_QUESTIONS.findIndex(id => {
    const answer = draft.answersPartial[id]; return answer?.kind === 'skipped' && answer.reason === 'remaining';
  });
  if (firstRemaining >= 0) {
    const first = draft.answersPartial[ONBOARDING_SCENARIO_QUESTIONS[firstRemaining]!]!;
    for (const id of ONBOARDING_SCENARIO_QUESTIONS.slice(firstRemaining)) {
      const answer = draft.answersPartial[id];
      if (answer?.kind !== 'skipped' || answer.reason !== 'remaining' || answer.appliedRevision !== first.appliedRevision) fail();
    }
  }
  if (draft.step === 'O1') {
    if (draft.revision !== 0 || draft.fastTrack || Object.keys(draft.answersPartial).length || draft.currentQuestion !== null
      || draft.state !== 'collecting' || draft.pendingText || draft.safety) fail(); return;
  }
  if (draft.revision < 1) fail();
  const expected = position(draft.answersPartial);
  if (draft.step !== expected.step || draft.currentQuestion !== expected.currentQuestion) fail();
  if (draft.fastTrack && draft.step !== 'O2' && draft.step !== 'O5') fail();
  if (draft.fastTrack && draft.step === 'O5') {
    const appliedRevision = draft.answersPartial.identity_stage!.appliedRevision;
    if ([...ONBOARDING_SCENARIO_QUESTIONS, 'extra'].some(id => draft.answersPartial[id as OnboardingQuestion]?.appliedRevision !== appliedRevision)) fail();
  }
  if ((draft.state === 'intake_ready') !== (draft.step === 'O5')) fail();
  if (draft.state === 'intake_ready' && lastRevision !== draft.revision) fail();
  if ((draft.state === 'safety_pending') !== !!draft.pendingText) fail();
  if (draft.pendingText && (draft.pendingText.questionId !== draft.currentQuestion || draft.pendingText.submittedAtRevision !== draft.revision || draft.safety)) fail();
  if (draft.safety && draft.safety.submittedAtRevision >= draft.revision) fail();
  if (draft.state === 'safety_paused') {
    if (!draft.safety || draft.safety.level === 'L0' || draft.safety.questionId !== draft.currentQuestion
      || draft.safety.submittedAtRevision + 1 !== draft.revision) fail();
  } else if (draft.safety && draft.safety.level !== 'L0') fail();
  if (draft.safety?.level === 'L0') {
    const resolved = draft.answersPartial[draft.safety.questionId];
    if (!resolved || resolved.appliedRevision !== draft.safety.submittedAtRevision + 1
      || (resolved.kind === 'skipped' && resolved.reason !== 'unmatched_text')
      || !('textId' in resolved) || resolved.textId !== draft.safety.textId) fail();
  }
  const extra = draft.answersPartial.extra;
  if (extra?.kind === 'answered' && (!draft.safety || draft.safety.level !== 'L0' || draft.safety.questionId !== 'extra'
    || draft.safety.textId !== extra.value.textId || draft.safety.submittedAtRevision + 1 !== extra.appliedRevision)) fail();
}
/** Strict decrypted-state codec: corrupt/unknown state is never replaced with an empty draft. */
export function parseOnboardingDraft(value: unknown): OnboardingDraft {
  return guarded(() => {
    const data = record(value, ['schemaVersion', 'questionnaireRevision', 'rulesRevision', 'id', 'userId', 'revision', 'step', 'currentQuestion', 'state', 'fastTrack', 'answersPartial', 'updatedAt'], ['pendingText', 'safety']);
    if (data.schemaVersion !== 1 || data.questionnaireRevision !== 1 || data.rulesRevision !== 1) fail();
    const revision = integer(data.revision);
    const draft: OnboardingDraft = { schemaVersion: 1, questionnaireRevision: 1, rulesRevision: 1, id: uuid(data.id), userId: uuid(data.userId), revision,
      step: member(data.step, ['O1', 'O2', 'O3', 'O4', 'O5']), currentQuestion: data.currentQuestion === null ? null : question(data.currentQuestion),
      state: member(data.state, ['collecting', 'safety_pending', 'safety_paused', 'intake_ready']), fastTrack: boolean(data.fastTrack),
      answersPartial: parseAnswers(data.answersPartial, revision), updatedAt: timestamp(data.updatedAt) };
    if (Object.hasOwn(data, 'pendingText')) {
      const pending = record(data.pendingText, ['id', 'questionId', 'submittedAtRevision']);
      draft.pendingText = { id: uuid(pending.id), questionId: question(pending.questionId), submittedAtRevision: integer(pending.submittedAtRevision, 1) };
    }
    if (Object.hasOwn(data, 'safety')) draft.safety = parseSafety(data.safety);
    checkState(draft); return draft;
  }, 'ONBOARDING_INVALID_STATE');
}
export function createOnboardingDraft(input: { id: string; userId: string; at: string }): OnboardingDraft {
  const data = record(input, ['id', 'userId', 'at']);
  return parseOnboardingDraft({ schemaVersion: 1, questionnaireRevision: 1, rulesRevision: 1, id: uuid(data.id), userId: uuid(data.userId), revision: 0,
    step: 'O1', currentQuestion: null, state: 'collecting', fastTrack: false, answersPartial: {}, updatedAt: timestamp(data.at) });
}
function saveAnswer(draft: OnboardingDraft, id: OnboardingQuestion, value: OnboardingAnswer<unknown>): void {
  // The value has already been validated against this exact question's contract.
  (draft.answersPartial as Record<string, OnboardingAnswer<unknown>>)[id] = value;
}
function advance(draft: OnboardingDraft): void {
  if (draft.fastTrack && ONBOARDING_BASIC_QUESTIONS.every(id => !!draft.answersPartial[id])) {
    for (const id of [...ONBOARDING_SCENARIO_QUESTIONS, 'extra'] as const) saveAnswer(draft, id, { kind: 'skipped', reason: 'fast_track', appliedRevision: draft.revision });
  }
  const next = position(draft.answersPartial); draft.step = next.step; draft.currentQuestion = next.currentQuestion;
  draft.state = next.step === 'O5' ? 'intake_ready' : 'collecting';
}
/** No database, crypto, classification, replay, generation or authority lives in this reducer. */
export function transitionOnboardingDraft(value: OnboardingDraft, input: OnboardingCommand, context: { at: string; textId?: string }): OnboardingDraft {
  const draft = parseOnboardingDraft(value), command = parseOnboardingCommand(input), ctx = record(context, ['at'], ['textId']);
  if (command.expectedRevision !== draft.revision) fail('ONBOARDING_REVISION_CHANGED');
  const action = command.action;
  if (draft.state === 'intake_ready' || draft.state === 'safety_paused'
    || draft.state === 'safety_pending' && action.kind !== 'text') fail('ONBOARDING_ACTION_NOT_ALLOWED');
  draft.updatedAt = timestamp(ctx.at); ++draft.revision;
  if (action.kind === 'start') {
    if (draft.step !== 'O1') fail('ONBOARDING_ACTION_NOT_ALLOWED');
    draft.fastTrack = action.mode === 'fast_track'; draft.step = 'O2'; draft.currentQuestion = 'study';
  } else {
    if (draft.step === 'O1' || draft.currentQuestion === null) fail('ONBOARDING_ACTION_NOT_ALLOWED');
    if (action.kind === 'skip_remaining') {
      if (draft.step !== 'O3') fail('ONBOARDING_ACTION_NOT_ALLOWED');
      for (const id of ONBOARDING_SCENARIO_QUESTIONS) if (!draft.answersPartial[id]) saveAnswer(draft, id, { kind: 'skipped', reason: 'remaining', appliedRevision: draft.revision });
      advance(draft);
    } else {
      if (action.questionId !== draft.currentQuestion) fail('ONBOARDING_ACTION_NOT_ALLOWED');
      if (action.kind === 'text') {
        const id = ctx.textId === undefined ? command.operationId : uuid(ctx.textId); if (id !== command.operationId) fail();
        draft.pendingText = { id, questionId: action.questionId, submittedAtRevision: draft.revision };
        delete draft.safety; draft.state = 'safety_pending';
      } else {
        saveAnswer(draft, action.questionId, action.kind === 'skip' ? { kind: 'skipped', reason: 'user', appliedRevision: draft.revision }
          : { kind: 'answered', value: action.value, source: 'user_entered', appliedRevision: draft.revision });
        advance(draft);
      }
    }
  }
  return parseOnboardingDraft(draft);
}
function parseResolution(value: unknown): OnboardingTextResolution {
  const data = record(value, ['kind'], ['questionId', 'value']);
  if (data.kind === 'unmatched') { record(value, ['kind']); return { kind: 'unmatched' }; }
  const action = parseAction(value); if (action.kind !== 'answer') fail(); return action;
}
/** A trusted port must persist and bind a real result. A caller cannot send this through the action parser. */
export function resolveOnboardingText(value: OnboardingDraft, input: OnboardingSafetyResult, context: { at: string }): OnboardingDraft {
  const draft = parseOnboardingDraft(value), data = record(input, ['textId', 'submittedAtRevision', 'level', 'detectorRevision', 'mode'], ['resolution']);
  const id = uuid(data.textId), submittedAtRevision = integer(data.submittedAtRevision, 1), level = member(data.level, ['L0', 'L1', 'L2']);
  const detectorRevision = integer(data.detectorRevision, 1), mode = member(data.mode, ['full', 'keyword_only']);
  if (draft.state !== 'safety_pending' || !draft.pendingText || draft.pendingText.id !== id
    || draft.pendingText.submittedAtRevision !== submittedAtRevision || draft.revision !== submittedAtRevision) fail('ONBOARDING_TEXT_STALE');
  if (level === 'L0' && mode === 'keyword_only') fail();
  if (draft.revision === MAX_REVISION) fail('ONBOARDING_INVALID_STATE');
  const questionId = draft.pendingText.questionId;
  const resolution = Object.hasOwn(data, 'resolution') ? parseResolution(data.resolution) : undefined;
  if (level !== 'L0' && resolution || questionId === 'extra' && resolution || level === 'L0' && questionId !== 'extra' && !resolution) fail();
  draft.updatedAt = timestamp(record(context, ['at']).at); ++draft.revision;
  draft.safety = { textId: id, questionId, submittedAtRevision, level, detectorRevision, mode }; delete draft.pendingText;
  if (level !== 'L0') draft.state = 'safety_paused';
  else if (questionId === 'extra') {
    saveAnswer(draft, 'extra', { kind: 'answered', value: { textId: id }, source: 'user_entered', textId: id, appliedRevision: draft.revision }); advance(draft);
  } else if (resolution?.kind === 'answer') {
    if (resolution.questionId !== questionId) fail();
    saveAnswer(draft, questionId, { kind: 'answered', value: resolution.value, source: 'user_entered', textId: id, appliedRevision: draft.revision }); advance(draft);
  } else {
    // 05 §2.1: unmatched L0 text skips this choice, retaining encrypted context only by reference.
    saveAnswer(draft, questionId, { kind: 'skipped', reason: 'unmatched_text', textId: id, appliedRevision: draft.revision }); advance(draft);
  }
  return parseOnboardingDraft(draft);
}

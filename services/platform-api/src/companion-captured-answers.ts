import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS,
  type OnboardingAnswer, type OnboardingAnswersPartial, type OnboardingQuestion } from '@companion/platform-contracts';
import { mapCompanionDimensions, onboardingPreferences, parseOnboardingCommand,
  type ClassifiedOnboardingText, type CompanionDimensions, type OnboardingScenarioSelections } from '@companion/career-core';
import { intakeUnavailable } from './onboarding-storage.ts';

const MAX_REVISION = 2147483647;
export const CAPTURED_ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = Object.freeze([
  ...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra',
]);
/** Exactly the saved answer fields, not a reconstructed historical intake draft. */
export interface CapturedCompanionAnswers {
  readonly schemaVersion: 1; readonly id: string; readonly userId: string; readonly sourceDraftId: string;
  readonly sourceRevision: number; readonly fastTrack: boolean; readonly answersPartial: Readonly<OnboardingAnswersPartial>;
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw intakeUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw intakeUnavailable();
  return Object.fromEntries(keys.map(key => [key, descriptors[key as string].value]));
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) throw intakeUnavailable();
  return value;
}
function revision(value: unknown, maximum = MAX_REVISION): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 1 || (value as number) > maximum) throw intakeUnavailable();
  return value as number;
}
/** Snapshot nested data before the existing pure question-value codec sees it. */
function jsonSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 5) throw intakeUnavailable();
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object') throw intakeUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (value.length > 32 || keys.length !== value.length + 1
      || !('value' in descriptors.length) || descriptors.length.value !== value.length
      || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= value.length))) throw intakeUnavailable();
    return Object.freeze(Array.from({ length: value.length }, (_, index) => {
      const item = descriptors[String(index)];
      if (!item || !('value' in item) || !item.enumerable) throw intakeUnavailable();
      return jsonSnapshot(item.value, depth + 1);
    }));
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.length > 16
    || keys.some(key => typeof key !== 'string')
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw intakeUnavailable();
  return Object.freeze(Object.fromEntries(keys.map(key => [key, jsonSnapshot(descriptors[key as string].value, depth + 1)])));
}
function frozenValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenValue));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenValue(item)])));
  return value;
}
function answer(value: unknown, id: OnboardingQuestion, maximum: number, captureId: string): OnboardingAnswer<unknown> {
  const base = record(value, ['kind', 'appliedRevision'], ['reason', 'value', 'source', 'textId']);
  const appliedRevision = revision(base.appliedRevision, maximum);
  if (base.kind === 'skipped') {
    const reason = base.reason;
    if (!['user', 'fast_track', 'remaining', 'unmatched_text'].includes(reason as string)) throw intakeUnavailable();
    const data = record(value, ['kind', 'appliedRevision', 'reason'], reason === 'unmatched_text' ? ['textId'] : []);
    if (reason === 'unmatched_text') {
      if (id === 'extra' || !Object.hasOwn(data, 'textId') || appliedRevision < 3) throw intakeUnavailable();
      return Object.freeze({ kind: 'skipped', reason, appliedRevision, textId: uuid(data.textId) });
    }
    return Object.freeze({ kind: 'skipped', reason: reason as 'user' | 'fast_track' | 'remaining', appliedRevision });
  }
  const data = record(value, ['kind', 'appliedRevision', 'value', 'source'], ['textId']);
  if (data.kind !== 'answered' || data.source !== 'user_entered') throw intakeUnavailable();
  const textId = Object.hasOwn(data, 'textId') ? uuid(data.textId) : undefined;
  if (textId !== undefined && appliedRevision < 3) throw intakeUnavailable();
  let parsed: unknown;
  if (id === 'extra') {
    const extra = record(data.value, ['textId']);
    if (textId === undefined || textId !== uuid(extra.textId)) throw intakeUnavailable();
    parsed = Object.freeze({ textId });
  } else {
    // Reuse the pure question-value codec only. This creates no operation or
    // evidence of an applied answer; the store separately proves real commands.
    const command = parseOnboardingCommand({ expectedRevision: appliedRevision - 1, operationId: captureId,
      action: { kind: 'answer', questionId: id, value: jsonSnapshot(data.value) } });
    if (command.action.kind !== 'answer') throw intakeUnavailable();
    parsed = frozenValue(command.action.value);
  }
  return Object.freeze({ kind: 'answered', value: parsed, source: 'user_entered' as const, appliedRevision, ...(textId ? { textId } : {}) });
}
/** Closed complete-answer codec. No state, safety pointer, timestamp or old legal
 * manifest is invented. Canonical original operations/results still need proof. */
export function parseCapturedCompanionAnswers(value: unknown): Readonly<CapturedCompanionAnswers> {
  try {
    const data = record(value, ['schemaVersion', 'id', 'userId', 'sourceDraftId', 'sourceRevision', 'fastTrack', 'answersPartial']);
    if (data.schemaVersion !== 1 || typeof data.fastTrack !== 'boolean') throw intakeUnavailable();
    const id = uuid(data.id), userId = uuid(data.userId), sourceDraftId = uuid(data.sourceDraftId), sourceRevision = revision(data.sourceRevision);
    const input = record(data.answersPartial, CAPTURED_ONBOARDING_QUESTIONS), answers: Record<string, OnboardingAnswer<unknown>> = {};
    let last = 1, previous: OnboardingAnswer<unknown> | undefined;
    for (const question of CAPTURED_ONBOARDING_QUESTIONS) {
      const item = answer(input[question], question, sourceRevision, id);
      const batch = item.kind === 'skipped' && (item.reason === 'fast_track'
        || item.reason === 'remaining' && previous?.kind === 'skipped' && previous.reason === 'remaining');
      if (item.appliedRevision < 2 || item.appliedRevision < last || item.appliedRevision === last && !batch) throw intakeUnavailable();
      if (item.kind === 'skipped') {
        if (ONBOARDING_BASIC_QUESTIONS.includes(question as never) && !['user', 'unmatched_text'].includes(item.reason)
          || item.reason === 'remaining' && !ONBOARDING_SCENARIO_QUESTIONS.includes(question as never)
          || (item.reason === 'fast_track') !== (data.fastTrack && !ONBOARDING_BASIC_QUESTIONS.includes(question as never))) throw intakeUnavailable();
      } else if (data.fastTrack && !ONBOARDING_BASIC_QUESTIONS.includes(question as never)) throw intakeUnavailable();
      answers[question] = item; previous = item; last = item.appliedRevision;
    }
    const firstRemaining = ONBOARDING_SCENARIO_QUESTIONS.findIndex(question => {
      const item = answers[question]!; return item.kind === 'skipped' && item.reason === 'remaining';
    });
    if (firstRemaining >= 0) for (const question of ONBOARDING_SCENARIO_QUESTIONS.slice(firstRemaining)) {
      const item = answers[question]!;
      if (item.kind !== 'skipped' || item.reason !== 'remaining' || item.appliedRevision !== answers[ONBOARDING_SCENARIO_QUESTIONS[firstRemaining]!]!.appliedRevision) throw intakeUnavailable();
    }
    if (data.fastTrack && [...ONBOARDING_SCENARIO_QUESTIONS, 'extra'].some(question =>
      answers[question]!.appliedRevision !== answers.identity_stage!.appliedRevision)) throw intakeUnavailable();
    if (last !== sourceRevision) throw intakeUnavailable();
    return Object.freeze({ schemaVersion: 1, id, userId, sourceDraftId, sourceRevision, fastTrack: data.fastTrack,
      answersPartial: Object.freeze(answers) as Readonly<OnboardingAnswersPartial> });
  } catch { throw intakeUnavailable(); }
}
/** Pure original-choice derivation, never source proof or current admission. */
export function prepareCapturedCompanionDimensions(value: Readonly<CapturedCompanionAnswers>, originalExtra?: Readonly<ClassifiedOnboardingText>): Readonly<CompanionDimensions> {
  try {
    const capture = parseCapturedCompanionAnswers(value), selections: OnboardingScenarioSelections = {};
    for (const id of ONBOARDING_SCENARIO_QUESTIONS) {
      const item = capture.answersPartial[id];
      if (item?.kind === 'answered') (selections as Record<string, string>)[id] = item.value;
    }
    let preferences: ReturnType<typeof onboardingPreferences> = [];
    const extra = capture.answersPartial.extra!;
    if (extra.kind === 'answered') {
      const data = record(originalExtra, ['textId', 'questionId', 'submittedAtRevision', 'level', 'detectorRevision', 'mode', 'text']);
      if (data.textId !== extra.value.textId || data.questionId !== 'extra' || data.level !== 'L0' || data.mode !== 'full'
        || revision(data.submittedAtRevision) + 1 !== extra.appliedRevision || revision(data.detectorRevision) < 1) throw intakeUnavailable();
      preferences = onboardingPreferences(data.text as string);
    } else if (originalExtra !== undefined) throw intakeUnavailable();
    return Object.freeze(mapCompanionDimensions({ answers: selections, preferences }));
  } catch { throw intakeUnavailable(); }
}

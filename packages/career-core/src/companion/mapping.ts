import { ONBOARDING_SCENARIO_QUESTIONS, type OnboardingDraft, type OnboardingQuestionValues, type OnboardingScenarioQuestion } from '@companion/platform-contracts';
import { OnboardingError, ONBOARDING_TEXT_MAX_CHARACTERS, parseOnboardingDraft } from './onboarding.ts';

export type CompanionDimensionValue = -1 | 0 | 1;
export interface CompanionDimensions {
  warmth: CompanionDimensionValue; directness: CompanionDimensionValue; drive: CompanionDimensionValue;
  structure: CompanionDimensionValue; levity: CompanionDimensionValue; code_mix: CompanionDimensionValue;
  length: 'short' | 'medium' | 'long';
}
export type OnboardingScenarioSelections = { [K in OnboardingScenarioQuestion]?: OnboardingQuestionValues[K] };
export type OnboardingPreference = 'more_space' | 'more_direct' | 'less_warmth' | 'less_humor' | 'shorter' | 'more_chinese' | 'more_english';
const preferences = Object.freeze([
  ['别催我', 'more_space'], ['说话直一点', 'more_direct'], ['别灌鸡汤', 'less_warmth'], ['少开玩笑', 'less_humor'],
  ['短一点', 'shorter'], ['多用中文', 'more_chinese'], ['多用英文', 'more_english'],
] as const);
function invalid(): never { throw new OnboardingError('ONBOARDING_INVALID_INPUT'); }
function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  return value as Record<string, unknown>;
}
function boundedText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\ud800-\udfff]/u.test(value) || Array.from(value).length > ONBOARDING_TEXT_MAX_CHARACTERS
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(); return value;
}
/** Pure parsing, not safety approval. Unknown clauses remain context; no inferred preferences or memory. */
export function onboardingPreferences(value: string): OnboardingPreference[] {
  const clauses = boundedText(value).split(/[，,。；;\n\r]+/).map(clause => clause.trim());
  return preferences.filter(([phrase]) => clauses.includes(phrase)).map(([, preference]) => preference);
}
/** Deterministic rule table only. No personal facts, model request, personality prose or authority. */
export function mapCompanionDimensions(input: { answers: OnboardingScenarioSelections; preferences?: readonly OnboardingPreference[] }): CompanionDimensions {
  const data = ownRecord(input, ['answers', 'preferences']), answers = ownRecord(data.answers, ONBOARDING_SCENARIO_QUESTIONS);
  for (const question of ONBOARDING_SCENARIO_QUESTIONS) if (Object.hasOwn(answers, question)) {
    const choices = ['Q1', 'Q3', 'Q4'].includes(question) ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C'];
    if (typeof answers[question] !== 'string' || !choices.includes(answers[question] as string)) invalid();
  }
  const chosenPreferences = data.preferences === undefined ? [] : data.preferences;
  if (!Array.isArray(chosenPreferences) || chosenPreferences.length > preferences.length
    || chosenPreferences.some(value => !preferences.some(([, key]) => key === value))
    || new Set(chosenPreferences).size !== chosenPreferences.length) invalid();
  let warmth = 0, directness = 0, drive = 0, structure = 0, levity = 0;
  let code_mix = answers.Q6 === 'A' ? 1 : answers.Q6 === 'C' ? -1 : 0;
  let length: CompanionDimensions['length'] = answers.Q5 === 'A' ? 'short' : answers.Q5 === 'B' ? 'long' : 'medium';
  // Direct increments, then ordered decision-table additions (02 §2.3).
  if (answers.Q1 === 'A') { --drive; ++warmth; }
  if (answers.Q1 === 'B') ++structure;
  if (answers.Q1 === 'C') ++directness;
  if (answers.Q1 === 'D') { ++warmth; ++levity; }
  if (answers.Q2 === 'A') --directness;
  if (answers.Q2 === 'B') ++structure;
  if (answers.Q2 === 'C') ++directness;
  if (answers.Q5 === 'C') ++structure;
  if (answers.Q7 === 'A') ++levity;
  if (answers.Q7 === 'C') --levity;
  if (answers.Q3 === 'A') ++structure;
  if (answers.Q3 === 'B') { ++warmth; ++drive; }
  if (answers.Q3 === 'C') ++warmth;
  if (answers.Q3 === 'D') { --warmth; ++directness; --drive; }
  if (answers.Q4 === 'A') { ++drive; ++warmth; }
  if (answers.Q4 === 'B') { --drive; ++directness; }
  if (answers.Q4 === 'B' && answers.Q2 === 'C') ++structure;
  if (answers.Q4 === 'C') { ++warmth; ++levity; }
  if (answers.Q4 === 'D') { ++structure; ++drive; }
  const clamp = (value: number): CompanionDimensionValue => Math.max(-1, Math.min(1, value)) as CompanionDimensionValue;
  warmth = clamp(warmth); directness = clamp(directness); drive = clamp(drive); structure = clamp(structure); levity = clamp(levity);
  // Caps apply after clamping, in table order; explicit whitelist preferences apply last.
  if (answers.Q3 === 'A') { drive = Math.min(0, drive); directness = Math.min(0, directness); }
  if (length === 'short') structure = Math.min(0, structure);
  for (const [, preference] of preferences) if (chosenPreferences.includes(preference)) {
    if (preference === 'more_space') drive = Math.min(0, drive);
    if (preference === 'more_direct') directness = 1;
    if (preference === 'less_warmth') warmth = Math.min(0, warmth);
    if (preference === 'less_humor') levity = -1;
    if (preference === 'shorter') { length = 'short'; structure = Math.min(0, structure); }
    if (preference === 'more_chinese') code_mix = -1;
    if (preference === 'more_english') code_mix = 1;
  }
  return { warmth: clamp(warmth), directness: clamp(directness), drive: clamp(drive), structure: clamp(structure),
    levity: clamp(levity), code_mix: clamp(code_mix), length };
}
/** Decrypted text supplied by the trusted store/classification port, never by the student action. */
export interface ClassifiedOnboardingText {
  textId: string; questionId: 'extra'; submittedAtRevision: number;
  level: 'L0'; detectorRevision: number; mode: 'full' | 'keyword_only'; text: string;
}
export interface OnboardingDimensionPreparation {
  draftId: string; draftRevision: number; questionnaireRevision: 1; rulesRevision: 1; dimensions: CompanionDimensions;
}
/** Application entry: require a complete intake and the exact classified/decrypted O4 text binding. */
export function prepareOnboardingDimensions(value: OnboardingDraft, classifiedText?: ClassifiedOnboardingText): OnboardingDimensionPreparation {
  const draft = parseOnboardingDraft(value);
  if (draft.state !== 'intake_ready') throw new OnboardingError('ONBOARDING_ACTION_NOT_ALLOWED');
  const answers: OnboardingScenarioSelections = {};
  for (const id of ONBOARDING_SCENARIO_QUESTIONS) {
    const answer = draft.answersPartial[id];
    if (answer?.kind === 'answered') (answers as Record<string, string>)[id] = answer.value;
  }
  let selectedPreferences: OnboardingPreference[] = [];
  if (draft.answersPartial.extra?.kind === 'answered') {
    if (!classifiedText) throw new OnboardingError('ONBOARDING_SAFETY_REQUIRED');
    const data = ownRecord(classifiedText, ['textId', 'questionId', 'submittedAtRevision', 'level', 'detectorRevision', 'mode', 'text']), safety = draft.safety;
    if (!safety || data.textId !== safety.textId || data.textId !== draft.answersPartial.extra.value.textId || data.questionId !== 'extra'
      || data.submittedAtRevision !== safety.submittedAtRevision || data.level !== 'L0' || data.mode !== 'full'
      || data.detectorRevision !== safety.detectorRevision || data.mode !== safety.mode) throw new OnboardingError('ONBOARDING_SAFETY_REQUIRED');
    selectedPreferences = onboardingPreferences(boundedText(data.text));
  } else if (classifiedText !== undefined) throw new OnboardingError('ONBOARDING_SAFETY_REQUIRED');
  return { draftId: draft.id, draftRevision: draft.revision, questionnaireRevision: 1, rulesRevision: 1,
    dimensions: mapCompanionDimensions({ answers, preferences: selectedPreferences }) };
}

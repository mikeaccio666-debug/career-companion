/** O1–O4 draft data only. None of these values proves a companion birth or first-letter delivery. */
export const ONBOARDING_SCHEMA_VERSION = 1 as const;
export const ONBOARDING_QUESTIONNAIRE_REVISION = 1 as const;
export const ONBOARDING_RULES_REVISION = 1 as const;
export const ONBOARDING_BASIC_QUESTIONS = Object.freeze(['study', 'graduation', 'roles', 'search_stage', 'emotion_language', 'identity_stage'] as const);
export const ONBOARDING_SCENARIO_QUESTIONS = Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const);
export type OnboardingBasicQuestion = typeof ONBOARDING_BASIC_QUESTIONS[number];
export type OnboardingScenarioQuestion = typeof ONBOARDING_SCENARIO_QUESTIONS[number];
export type OnboardingQuestion = OnboardingBasicQuestion | OnboardingScenarioQuestion | 'extra';
/** Kept as the user's explicit draft choice; never inferred from a graduation month. */
export type OnboardingProgramChoice = '12_month' | '16_month' | '24_month' | 'other';
/** Runtime validation uses career-core's single ROLE_FAMILIES catalogue. */
export type OnboardingRoleFamily = 'swe' | 'mle' | 'ds' | 'da' | 'de' | 'hw' | 'other';
export interface OnboardingQuestionValues {
  study: { degreeField: 'cs' | 'ds_statistics' | 'ece_ee' | 'other_stem'; programChoice: OnboardingProgramChoice | null };
  graduation: { month: string; graduated: boolean };
  roles: { kind: 'selected'; roles: OnboardingRoleFamily[] } | { kind: 'undecided' };
  search_stage: 'not_started' | 'applying' | 'interviewing' | 'offer' | 'graduated_looking';
  emotion_language: 'zh' | 'en' | 'either';
  identity_stage: 'f1_student' | 'opt' | 'stem_opt' | 'other' | 'prefer_not_say';
  Q1: 'A' | 'B' | 'C' | 'D'; Q2: 'A' | 'B' | 'C'; Q3: 'A' | 'B' | 'C' | 'D'; Q4: 'A' | 'B' | 'C' | 'D';
  Q5: 'A' | 'B' | 'C'; Q6: 'A' | 'B' | 'C'; Q7: 'A' | 'B' | 'C';
  /** Reference to an encrypted, classified submission; no unclassified text in the public draft. */
  extra: { textId: string };
}
export type OnboardingSkipReason = 'user' | 'fast_track' | 'remaining' | 'unmatched_text';
export type OnboardingAnswer<T> =
  | { kind: 'answered'; value: T; source: 'user_entered'; appliedRevision: number; textId?: string }
  | { kind: 'skipped'; reason: Exclude<OnboardingSkipReason, 'unmatched_text'>; appliedRevision: number }
  /** Full-mode L0 text could not resolve a choice; retain context by reference, never as a fact. */
  | { kind: 'skipped'; reason: 'unmatched_text'; appliedRevision: number; textId: string };
/** Absent key means unanswered. Answered and skipped are mutually exclusive. */
export type OnboardingAnswersPartial = { [K in OnboardingQuestion]?: OnboardingAnswer<OnboardingQuestionValues[K]> };
export interface OnboardingTextReference { id: string; questionId: OnboardingQuestion; submittedAtRevision: number; }
export interface OnboardingSafetyReceipt {
  textId: string; questionId: OnboardingQuestion; submittedAtRevision: number;
  /** Runtime codec rejects L0 with keyword_only: a degraded detector cannot approve text. */
  level: 'L0' | 'L1' | 'L2'; detectorRevision: number; mode: 'full' | 'keyword_only';
}
export interface OnboardingDraft {
  schemaVersion: 1; questionnaireRevision: 1; rulesRevision: 1;
  id: string; userId: string; revision: number;
  /** O5 is a waiting boundary only; this protocol cannot start generation. */
  step: 'O1' | 'O2' | 'O3' | 'O4' | 'O5'; currentQuestion: OnboardingQuestion | null;
  state: 'collecting' | 'safety_pending' | 'safety_paused' | 'intake_ready';
  fastTrack: boolean; answersPartial: OnboardingAnswersPartial;
  pendingText?: OnboardingTextReference; safety?: OnboardingSafetyReceipt;
  updatedAt: string;
}
export type OnboardingAnswerAction = { [K in Exclude<OnboardingQuestion, 'extra'>]:
  { kind: 'answer'; questionId: K; value: OnboardingQuestionValues[K] }
}[Exclude<OnboardingQuestion, 'extra'>];
export type OnboardingAction =
  | { kind: 'start'; mode: 'standard' | 'fast_track' }
  | OnboardingAnswerAction
  | { kind: 'skip'; questionId: OnboardingQuestion }
  | { kind: 'skip_remaining' }
  | { kind: 'text'; questionId: OnboardingQuestion; text: string };
/** Identity, cursor, status and safety results are never accepted from an HTTP caller. */
export interface OnboardingCommand { expectedRevision: number; operationId: string; action: OnboardingAction; }
export type OnboardingTextResolution = { kind: 'unmatched' } | { [K in Exclude<OnboardingQuestion, 'extra'>]:
  { kind: 'answer'; questionId: K; value: OnboardingQuestionValues[K] }
}[Exclude<OnboardingQuestion, 'extra'>];
/** Trusted classification port result, not an HTTP command or permission grant. L0 requires full mode. */
export interface OnboardingSafetyResult {
  textId: string; submittedAtRevision: number; level: 'L0' | 'L1' | 'L2';
  detectorRevision: number; mode: 'full' | 'keyword_only'; resolution?: OnboardingTextResolution;
}
/** Real persistence owns replay: recheck identity/consent, compare canonical encrypted input, return current draft. */
export interface OnboardingSaveResult {
  draft: OnboardingDraft; operation: { id: string; appliedRevision: number; replayed: boolean };
}

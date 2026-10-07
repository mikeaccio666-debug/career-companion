import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS,
  type OnboardingQuestion, type OnboardingSafetyResult } from '@companion/platform-contracts';
import { OnboardingError, parseOnboardingSafetyResult } from '@companion/career-core';

/** Internal database/lease coordinates, never a caller-supplied permission or detector result. */
export interface OnboardingSafetyClaim {
  readonly userId: string; readonly submissionId: string; readonly operationId: string; readonly draftId: string;
  readonly questionId: OnboardingQuestion; readonly submittedAtRevision: number; readonly authVersion: string;
  readonly generation: number; readonly leaseToken: string; readonly detectorRevision: number;
}
/** A detector may classify and resolve a choice; identity and detector version come from the claim. */
export type OnboardingSafetyDecision = Pick<OnboardingSafetyResult, 'level' | 'mode' | 'resolution'>;
const MAX_INT = 2147483647;
const MAX_AUTH_VERSION = '9223372036854775807';
const questions: readonly OnboardingQuestion[] = [...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra'];
function invalid(): never { throw new OnboardingError('ONBOARDING_INVALID_INPUT'); }
function guarded<T>(run: () => T): T {
  try { return run(); } catch (error) { if (error instanceof OnboardingError) throw error; invalid(); }
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_INT) invalid(); return value;
}
function authVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_AUTH_VERSION.length || /^(0|[1-9][0-9]*)$/.exec(value)?.[0] !== value
    || value.length === MAX_AUTH_VERSION.length && value > MAX_AUTH_VERSION) invalid(); return value;
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
/** Copies and freezes only exact canonical server coordinates. It does not verify a live lease. */
export function parseOnboardingSafetyClaim(value: unknown): Readonly<OnboardingSafetyClaim> {
  return guarded(() => {
    const data = record(value, ['userId', 'submissionId', 'operationId', 'draftId', 'questionId', 'submittedAtRevision',
      'authVersion', 'generation', 'leaseToken', 'detectorRevision']);
    if (typeof data.questionId !== 'string' || !questions.includes(data.questionId as OnboardingQuestion)) invalid();
    return Object.freeze({ userId: uuid(data.userId), submissionId: uuid(data.submissionId), operationId: uuid(data.operationId),
      draftId: uuid(data.draftId), questionId: data.questionId as OnboardingQuestion, submittedAtRevision: positive(data.submittedAtRevision),
      authVersion: authVersion(data.authVersion), generation: positive(data.generation), leaseToken: uuid(data.leaseToken),
      detectorRevision: positive(data.detectorRevision) });
  });
}
/** Binds a closed decision to a copied claim, then validates the actual question's resolution contract. */
export function parseOnboardingSafetyDecision(value: unknown, claim: OnboardingSafetyClaim): Readonly<OnboardingSafetyResult> {
  return guarded(() => {
    const fixed = parseOnboardingSafetyClaim(claim), data = record(value, ['level', 'mode'], ['resolution']);
    const result = parseOnboardingSafetyResult({ textId: fixed.operationId, submittedAtRevision: fixed.submittedAtRevision,
      detectorRevision: fixed.detectorRevision, level: data.level, mode: data.mode,
      ...(Object.hasOwn(data, 'resolution') ? { resolution: data.resolution } : {}) });
    if (fixed.questionId === 'extra' && result.resolution
      || fixed.questionId !== 'extra' && result.level === 'L0' && !result.resolution
      || result.resolution?.kind === 'answer' && result.resolution.questionId !== fixed.questionId) invalid();
    return freeze(result);
  });
}

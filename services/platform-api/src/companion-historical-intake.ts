import type { OnboardingCommand, OnboardingQuestion, OnboardingSafetyResult } from '@companion/platform-contracts';
import { parseOnboardingCommand, parseOnboardingSafetyResult,
  type ClassifiedOnboardingText, type CompanionDimensions } from '@companion/career-core';
import { intakeUnavailable } from './onboarding-storage.ts';
import { CAPTURED_ONBOARDING_QUESTIONS, parseCapturedCompanionAnswers, prepareCapturedCompanionDimensions,
  type CapturedCompanionAnswers } from './companion-captured-answers.ts';

export interface CapturedCompanionOperationProduct {
  readonly operationId: string; readonly userId: string; readonly draftId: string; readonly appliedRevision: number;
  readonly command: Readonly<OnboardingCommand>;
}
export interface CapturedCompanionSubmissionProduct {
  readonly submissionId: string; readonly operationId: string; readonly userId: string; readonly draftId: string;
  readonly questionId: OnboardingQuestion; readonly submittedRevision: number; readonly status: 'detected';
  readonly generation: number; readonly authVersion: string; readonly detectorRevision: number;
  readonly level: 'L0' | 'L1' | 'L2'; readonly mode: 'full' | 'keyword_only'; readonly result: Readonly<OnboardingSafetyResult>;
}
/** Value products only, never an authenticated source or execution grant. The
 * source-prefix verifier constructs these from actual authenticated original rows
 * and may consume them only after matching the independent manifest exactly. */
export interface CapturedCompanionSourceProducts {
  readonly operations: readonly Readonly<CapturedCompanionOperationProduct>[];
  readonly submissions: readonly Readonly<CapturedCompanionSubmissionProduct>[];
  readonly handledSubmissionIds: readonly string[];
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw intakeUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw intakeUnavailable();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw intakeUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Reflect.ownKeys(value), size = descriptors.length, count = size?.value;
  if (!size || !('value' in size) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
    || keys.length !== count + 1
    || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= count))) throw intakeUnavailable();
  return Array.from({ length: count }, (_, index) => {
    const item = descriptors[String(index)];
    if (!item || !('value' in item) || !item.enumerable) throw intakeUnavailable();
    return item.value;
  });
}
function jsonData(value: unknown, depth = 0): unknown {
  if (depth > 8) throw intakeUnavailable();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return array(value).map(item => jsonData(item, depth + 1));
  if (!value || typeof value !== 'object') throw intakeUnavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw intakeUnavailable();
  return Object.fromEntries(Object.entries(record(value, keys as string[])).map(([key, item]) => [key, jsonData(item, depth + 1)]));
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) throw intakeUnavailable();
  return value;
}
function revision(value: unknown, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 1 || (value as number) > maximum) throw intakeUnavailable();
  return value as number;
}

/** Pure consistency and choice derivation. This performs zero SQL, decryption,
 * recovery or authorization and makes no historical-draft or clinical claim. */
export function deriveCapturedCompanionDimensions(value: Readonly<CapturedCompanionAnswers>,
  products: Readonly<CapturedCompanionSourceProducts>): Readonly<CompanionDimensions> {
  try {
    const capture = parseCapturedCompanionAnswers(value), input = record(products, ['operations', 'submissions', 'handledSubmissionIds']);
    const operations = array(input.operations).map(value => {
      const data = record(value, ['operationId', 'userId', 'draftId', 'appliedRevision', 'command']);
      const operationId = uuid(data.operationId), appliedRevision = revision(data.appliedRevision, capture.sourceRevision);
      const command = parseOnboardingCommand(jsonData(data.command));
      if (data.userId !== capture.userId || data.draftId !== capture.sourceDraftId
        || command.operationId !== operationId || command.expectedRevision + 1 !== appliedRevision) throw intakeUnavailable();
      return { operationId, appliedRevision, command };
    });
    const byRevision = new Map<number, typeof operations[number]>(), byId = new Map<string, typeof operations[number]>();
    let lastRevision = 0;
    for (const item of operations) {
      if (byRevision.has(item.appliedRevision) || byId.has(item.operationId) || item.appliedRevision <= lastRevision) throw intakeUnavailable();
      byRevision.set(item.appliedRevision, item); byId.set(item.operationId, item); lastRevision = item.appliedRevision;
    }
    const starts = operations.filter(item => item.command.action.kind === 'start'), first = starts[0];
    if (starts.length !== 1 || first?.appliedRevision !== 1 || first.command.expectedRevision !== 0
      || first.command.action.kind !== 'start' || first.command.action.mode !== (capture.fastTrack ? 'fast_track' : 'standard')) throw intakeUnavailable();
    const texts = operations.filter(item => item.command.action.kind === 'text'), results = new Map<string, OnboardingSafetyResult>();
    const submissionIds = new Set<string>();
    const submissions = array(input.submissions).map(value => {
      const data = record(value, ['submissionId', 'operationId', 'userId', 'draftId', 'questionId', 'submittedRevision',
        'status', 'generation', 'authVersion', 'detectorRevision', 'level', 'mode', 'result']);
      const id = uuid(data.submissionId), operationId = uuid(data.operationId), operation = byId.get(operationId);
      const submittedRevision = revision(data.submittedRevision, capture.sourceRevision), result = parseOnboardingSafetyResult(jsonData(data.result));
      revision(data.generation); revision(data.detectorRevision);
      if (typeof data.authVersion !== 'string' || /^(0|[1-9][0-9]*)$/.exec(data.authVersion)?.[0] !== data.authVersion
        || BigInt(data.authVersion) > 9223372036854775807n || data.userId !== capture.userId || data.draftId !== capture.sourceDraftId
        || data.status !== 'detected' || !operation || operation.command.action.kind !== 'text'
        || data.questionId !== operation.command.action.questionId || submittedRevision !== operation.appliedRevision
        || result.textId !== operationId || result.submittedAtRevision !== submittedRevision || result.detectorRevision !== data.detectorRevision
        || result.level !== data.level || result.mode !== data.mode || submissionIds.has(id) || results.has(operationId)
        || result.level === 'L0' && (data.questionId === 'extra' ? result.resolution !== undefined : !result.resolution)
        || result.resolution?.kind === 'answer' && result.resolution.questionId !== data.questionId) throw intakeUnavailable();
      submissionIds.add(id); results.set(operationId, result);
      return { id, level: result.level, mode: result.mode };
    });
    if (submissions.length !== texts.length) throw intakeUnavailable();
    const handledIds = array(input.handledSubmissionIds).map(uuid), handled = new Set(handledIds);
    if (handled.size !== handledIds.length || handledIds.some(id => !submissions.some(row => row.id === id && row.level !== 'L0'))
      || submissions.some(row => !handled.has(row.id) && (row.level !== 'L0' || row.mode !== 'full'))) throw intakeUnavailable();
    const usedOperations = new Set([first.operationId, ...texts.map(item => item.operationId)]);
    let extra: ClassifiedOnboardingText | undefined;
    for (const question of CAPTURED_ONBOARDING_QUESTIONS) {
      const answer = capture.answersPartial[question]!;
      if (answer.kind === 'skipped' && answer.reason === 'fast_track') continue;
      if (answer.kind === 'skipped' && answer.reason === 'remaining') {
        const operation = byRevision.get(answer.appliedRevision);
        if (operation?.command.action.kind !== 'skip_remaining') throw intakeUnavailable();
        usedOperations.add(operation.operationId); continue;
      }
      const textId = 'textId' in answer ? answer.textId : undefined;
      if (textId !== undefined) {
        const operation = byId.get(textId), result = results.get(textId);
        if (!operation || operation.command.action.kind !== 'text' || operation.command.action.questionId !== question
          || !result || result.level !== 'L0' || result.mode !== 'full' || result.submittedAtRevision + 1 !== answer.appliedRevision) throw intakeUnavailable();
        if (question === 'extra') {
          if (answer.kind !== 'answered' || result.resolution !== undefined) throw intakeUnavailable();
          extra = { textId, questionId: 'extra', submittedAtRevision: result.submittedAtRevision,
            level: 'L0', detectorRevision: result.detectorRevision, mode: 'full', text: operation.command.action.text };
        } else if (answer.kind === 'answered') {
          if (result.resolution?.kind !== 'answer' || result.resolution.questionId !== question
            || JSON.stringify(result.resolution.value) !== JSON.stringify(answer.value)) throw intakeUnavailable();
        } else if (answer.reason !== 'unmatched_text' || result.resolution?.kind !== 'unmatched') throw intakeUnavailable();
      } else {
        const operation = byRevision.get(answer.appliedRevision), action = operation?.command.action;
        if (!action || action.kind !== (answer.kind === 'answered' ? 'answer' : 'skip') || !('questionId' in action) || action.questionId !== question
          || answer.kind === 'answered' && (action.kind !== 'answer' || JSON.stringify(action.value) !== JSON.stringify(answer.value))) throw intakeUnavailable();
        usedOperations.add(operation!.operationId);
      }
    }
    if (operations.some(item => !usedOperations.has(item.operationId))) throw intakeUnavailable();
    return prepareCapturedCompanionDimensions(capture, extra);
  } catch { throw intakeUnavailable(); }
}

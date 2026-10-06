import {
  PILOT_UA5_COMPLETED_STATES,
  parsePilotUa5ReadOnlyScan,
  type PilotUa5ReadOnlyScan,
} from '@edaix/contracts/draft/pilot-ua5-certification';
import {
  PILOT_UA4_TERMINAL_STATES,
  type PilotUa4TerminalState,
  type PilotUa4WriteEffect,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import type { PilotUa5ProgressEvent } from '../lib/pilotUa5Orchestrator';
import { parsePilotLocalWizardProjection, type PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';

export const PRODUCT_PANEL_VIEW_MODEL_INVALID = 'PRODUCT_PANEL_VIEW_MODEL_INVALID' as const;

/** The panel consumes UA-5's ledger states; it does not own a second taxonomy. */
export const PRODUCT_PANEL_QUESTION_STATUSES = PILOT_UA4_TERMINAL_STATES;

export type ProductPanelQuestionStatus = PilotUa4TerminalState;
export type ProductPanelRequirement = 'REQUIRED' | 'OPTIONAL';
export type ProductPanelEntryState = 'READY' | 'NEEDS_ATTENTION' | 'UNAVAILABLE';
export type ProductPanelContinuation =
  | Readonly<{ status: 'SCANNING' | 'UNAVAILABLE' }>
  | Readonly<{ status: 'SCANNED'; scan: PilotUa5ReadOnlyScan }>;

export type ProductPanelQuestion = Readonly<{
  /** Value-free UA-5 logical question identity, unchanged. */
  id: string;
  order: number;
  requirement: ProductPanelRequirement;
  status: ProductPanelQuestionStatus;
  writeEffect?: PilotUa4WriteEffect;
}>;

export type ProductPanelViewModel = Readonly<{
  revision: number;
  entries: Readonly<{
    currentJob: ProductPanelEntryState;
    autofillInformation: ProductPanelEntryState;
    resume: ProductPanelEntryState;
    coverLetter: ProductPanelEntryState;
  }>;
  run: null | Readonly<{
    /** UI-local identity only; it is not page or Mission authority. */
    id: string;
    /** Counts-only UA-5 progress. */
    progress: PilotUa5ProgressEvent;
    /** Canonical rows derived from the parsed UA-5 run projection. */
    questions: readonly ProductPanelQuestion[];
    /**
     * Whether the run observed the whole page, and how many regions it reached
     * but could not observe into. The questions above are the OBSERVED ones;
     * these two facts keep any percentage from reading as the whole page.
     * Null until the run is SETTLED: before that nothing is established.
     */
    completeness: null | Readonly<{
      discoveryComplete: boolean;
      unobservedRegions: number;
    }>;
    /** Optional read-only observation; questions/progress above become history. */
    continuation?: ProductPanelContinuation;
    wizard?: PilotLocalWizardProjection;
    /** One UI intent; it does not authorize navigation or writing. */
    continueIntent: null | Readonly<{
      kind: 'CONTINUE_TO_NEXT_PAGE';
      intentId: string;
    }>;
  }>;
}>;

export type ProductPanelValidationResult =
  | Readonly<{ ok: true; model: ProductPanelViewModel }>
  | Readonly<{ ok: false; code: typeof PRODUCT_PANEL_VIEW_MODEL_INVALID }>;

export type ProductPanelSummary = Readonly<{
  continuation?: ProductPanelContinuation;
  wizard?: PilotLocalWizardProjection;
  phase: PilotUa5ProgressEvent['phase'] | null;
  observedControls: number | null;
  authorizedQuestions: number | null;
  detected: number;
  requiredFilled: number;
  requiredTotal: number;
  /** Over OBSERVED required questions only; see `discoveryComplete`. */
  requiredPercentage: number;
  /** Null until SETTLED; false means the percentage is not a whole-page figure. */
  discoveryComplete: boolean | null;
  unobservedRegions: number;
  required: readonly ProductPanelQuestion[];
  optional: readonly ProductPanelQuestion[];
}>;

const ENTRY_STATES = new Set<ProductPanelEntryState>([
  'READY',
  'NEEDS_ATTENTION',
  'UNAVAILABLE',
]);
const QUESTION_STATUSES = new Set<ProductPanelQuestionStatus>(PRODUCT_PANEL_QUESTION_STATUSES);
const REQUIREMENTS = new Set<ProductPanelRequirement>(['REQUIRED', 'OPTIONAL']);
const COMPLETED_STATES = new Set<ProductPanelQuestionStatus>(PILOT_UA5_COMPLETED_STATES);
const UA5_SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const LOCAL_SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_ITEMS = 500;

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function exactDataValues(
  candidate: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(candidate)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) return null;
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
    values[key] = descriptor.value;
  }
  return values;
}

function isSafeIndex(candidate: unknown): candidate is number {
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0;
}

function boundedCount(candidate: unknown): candidate is number {
  return isSafeIndex(candidate) && candidate <= MAX_ITEMS;
}

function exactArrayValues(candidate: unknown): readonly unknown[] | null {
  if (!Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    !boundedCount(lengthDescriptor.value)
  ) return null;
  const length = lengthDescriptor.value;
  const expectedKeys = new Set<string>([
    'length',
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
  ) return null;
  const values: unknown[] = [];
  for (const key of Array.from({ length }, (_, index) => String(index))) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function canonicalProgress(candidate: unknown): PilotUa5ProgressEvent | null {
  const observed = exactDataValues(candidate, ['phase', 'observedControls']);
  if (
    observed?.phase === 'OBSERVED' &&
    boundedCount(observed.observedControls)
  ) return Object.freeze({ phase: 'OBSERVED', observedControls: observed.observedControls });

  const composed = exactDataValues(candidate, [
    'phase',
    'observableQuestions',
    'authorizedQuestions',
  ]);
  if (
    composed?.phase === 'COMPOSED' &&
    boundedCount(composed.observableQuestions) &&
    boundedCount(composed.authorizedQuestions) &&
    composed.authorizedQuestions <= composed.observableQuestions
  ) {
    return Object.freeze({
      phase: 'COMPOSED',
      observableQuestions: composed.observableQuestions,
      authorizedQuestions: composed.authorizedQuestions,
    });
  }

  const settled = exactDataValues(candidate, [
    'phase',
    'requiredCompleted',
    'requiredQuestions',
  ]);
  if (
    settled?.phase === 'SETTLED' &&
    boundedCount(settled.requiredCompleted) &&
    boundedCount(settled.requiredQuestions) &&
    settled.requiredCompleted <= settled.requiredQuestions
  ) {
    return Object.freeze({
      phase: 'SETTLED',
      requiredCompleted: settled.requiredCompleted,
      requiredQuestions: settled.requiredQuestions,
    });
  }
  return null;
}

function canonicalQuestion(candidate: unknown): ProductPanelQuestion | null {
  const changed = exactDataValues(candidate, ['id', 'order', 'requirement', 'status', 'writeEffect']);
  if (changed && (changed.status !== 'POLICY_BLOCKED' || changed.writeEffect !== 'MAY_HAVE_CHANGED')) return null;
  const values = exactDataValues(candidate, ['id', 'order', 'requirement', 'status']) ?? changed;
  if (
    values === null ||
    typeof values.id !== 'string' ||
    !UA5_SAFE_ID.test(values.id) ||
    !isSafeIndex(values.order) ||
    values.order >= MAX_ITEMS ||
    typeof values.requirement !== 'string' ||
    !REQUIREMENTS.has(values.requirement as ProductPanelRequirement) ||
    typeof values.status !== 'string' ||
    !QUESTION_STATUSES.has(values.status as ProductPanelQuestionStatus)
  ) return null;
  return Object.freeze({
    id: values.id,
    order: values.order,
    requirement: values.requirement as ProductPanelRequirement,
    status: values.status as ProductPanelQuestionStatus,
    ...(changed ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
  });
}

function invalid(): ProductPanelValidationResult {
  return Object.freeze({ ok: false, code: PRODUCT_PANEL_VIEW_MODEL_INVALID });
}

function validateProductPanelViewModelUnsafe(candidate: unknown): ProductPanelValidationResult {
  const values = exactDataValues(candidate, ['revision', 'entries', 'run']);
  if (values === null || !isSafeIndex(values.revision)) return invalid();
  const entryValues = exactDataValues(values.entries, [
    'currentJob',
    'autofillInformation',
    'resume',
    'coverLetter',
  ]);
  if (entryValues === null) return invalid();
  const entryStates = [
    entryValues.currentJob,
    entryValues.autofillInformation,
    entryValues.resume,
    entryValues.coverLetter,
  ];
  if (entryStates.some((entry) =>
    typeof entry !== 'string' || !ENTRY_STATES.has(entry as ProductPanelEntryState))) {
    return invalid();
  }
  const entries = Object.freeze({
    currentJob: entryValues.currentJob as ProductPanelEntryState,
    autofillInformation: entryValues.autofillInformation as ProductPanelEntryState,
    resume: entryValues.resume as ProductPanelEntryState,
    coverLetter: entryValues.coverLetter as ProductPanelEntryState,
  });
  if (values.run === null) {
    return Object.freeze({
      ok: true,
      model: Object.freeze({ revision: values.revision, entries, run: null }),
    });
  }
  const runKeys = [
    'id',
    'progress',
    'questions',
    'completeness',
    'continueIntent',
  ];
  const continuedValues = exactDataValues(values.run, [...runKeys, 'continuation']);
  const wizardValues = exactDataValues(values.run, [...runKeys, 'wizard']);
  const bothValues = exactDataValues(values.run, [...runKeys, 'continuation', 'wizard']);
  const runValues = exactDataValues(values.run, runKeys) ?? continuedValues ?? wizardValues ?? bothValues;
  if (
    runValues === null ||
    typeof runValues.id !== 'string' ||
    !LOCAL_SAFE_ID.test(runValues.id)
  ) return invalid();
  const progress = canonicalProgress(runValues.progress);
  let wizard: PilotLocalWizardProjection | undefined;
  if (wizardValues !== null || bothValues !== null) {
    const parsed = parsePilotLocalWizardProjection(runValues.wizard);
    if (!parsed.ok || progress?.phase !== 'SETTLED') return invalid();
    wizard = parsed.value;
  }
  let continuation: ProductPanelContinuation | undefined;
  if (continuedValues !== null || bothValues !== null) {
    const state = exactDataValues(runValues.continuation, ['status']);
    const scanned = exactDataValues(runValues.continuation, ['status', 'scan']);
    if (state?.status === 'SCANNING' || state?.status === 'UNAVAILABLE') {
      continuation = Object.freeze({ status: state.status });
    } else if (scanned?.status === 'SCANNED') {
      const result = parsePilotUa5ReadOnlyScan(scanned.scan);
      if (!result.ok) return invalid();
      continuation = Object.freeze({ status: 'SCANNED', scan: result.value });
    } else return invalid();
    if (progress?.phase !== 'SETTLED' || runValues.continueIntent !== null) return invalid();
  }
  const questionValues = exactArrayValues(runValues.questions);
  if (progress === null || questionValues === null) return invalid();
  let completeness: NonNullable<ProductPanelViewModel['run']>['completeness'] = null;
  if (runValues.completeness !== null) {
    const completenessValues = exactDataValues(runValues.completeness, [
      'discoveryComplete',
      'unobservedRegions',
    ]);
    if (
      completenessValues === null ||
      typeof completenessValues.discoveryComplete !== 'boolean' ||
      typeof completenessValues.unobservedRegions !== 'number' ||
      !Number.isSafeInteger(completenessValues.unobservedRegions) ||
      completenessValues.unobservedRegions < 0 ||
      completenessValues.unobservedRegions > MAX_ITEMS
    ) return invalid();
    completeness = Object.freeze({
      discoveryComplete: completenessValues.discoveryComplete,
      unobservedRegions: completenessValues.unobservedRegions,
    });
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  const questions: ProductPanelQuestion[] = [];
  for (const candidateQuestion of questionValues) {
    const question = canonicalQuestion(candidateQuestion);
    if (question === null || ids.has(question.id) || orders.has(question.order)) return invalid();
    ids.add(question.id);
    orders.add(question.order);
    questions.push(question);
  }
  questions.sort((left, right) => left.order - right.order);
  if (progress.phase !== 'SETTLED' && (questions.length !== 0 || completeness !== null)) {
    return invalid();
  }
  if (progress.phase === 'SETTLED') {
    const required = questions.filter((question) => question.requirement === 'REQUIRED');
    const completed = required.filter((question) => COMPLETED_STATES.has(question.status));
    if (
      completeness === null ||
      progress.requiredQuestions !== required.length ||
      progress.requiredCompleted !== completed.length
    ) return invalid();
    // Same rule as the ledger and the projection: a run is complete exactly
    // when no question is DISCOVERY_INCOMPLETE and no region went unobserved.
    // A view model that says otherwise would let the panel show a whole-page
    // total over a partially observed page.
    const incomplete =
      completeness.unobservedRegions > 0 ||
      questions.some((question) => question.status === 'DISCOVERY_INCOMPLETE');
    if (completeness.discoveryComplete === incomplete) return invalid();
  }
  let continueIntent: NonNullable<ProductPanelViewModel['run']>['continueIntent'] = null;
  if (runValues.continueIntent !== null) {
    const intentValues = exactDataValues(runValues.continueIntent, ['kind', 'intentId']);
    if (
      progress.phase !== 'SETTLED' ||
      intentValues === null ||
      intentValues.kind !== 'CONTINUE_TO_NEXT_PAGE' ||
      typeof intentValues.intentId !== 'string' ||
      !LOCAL_SAFE_ID.test(intentValues.intentId)
    ) return invalid();
    continueIntent = Object.freeze({
      kind: 'CONTINUE_TO_NEXT_PAGE',
      intentId: intentValues.intentId,
    });
  }
  const run = Object.freeze({
    id: runValues.id,
    progress,
    questions: Object.freeze(questions),
    completeness,
    continueIntent,
    ...(continuation === undefined ? {} : { continuation }),
    ...(wizard === undefined ? {} : { wizard }),
  });
  return Object.freeze({
    ok: true,
    model: Object.freeze({ revision: values.revision, entries, run }),
  });
}

export function validateProductPanelViewModel(candidate: unknown): ProductPanelValidationResult {
  try {
    return validateProductPanelViewModelUnsafe(candidate);
  } catch {
    return invalid();
  }
}

export function summarizeProductPanel(model: ProductPanelViewModel): ProductPanelSummary {
  const questions = [...(model.run?.questions ?? [])].sort((left, right) => left.order - right.order);
  const required = questions.filter((question) => question.requirement === 'REQUIRED');
  const optional = questions.filter((question) => question.requirement === 'OPTIONAL');
  const requiredFilled = required.filter((question) => COMPLETED_STATES.has(question.status)).length;
  const progress = model.run?.progress ?? null;
  return Object.freeze({
    phase: progress?.phase ?? null,
    ...(model.run?.continuation === undefined ? {} : { continuation: model.run.continuation }),
    ...(model.run?.wizard === undefined ? {} : { wizard: model.run.wizard }),
    observedControls: progress?.phase === 'OBSERVED' ? progress.observedControls : null,
    authorizedQuestions: progress?.phase === 'COMPOSED' ? progress.authorizedQuestions : null,
    detected: progress?.phase === 'COMPOSED' ? progress.observableQuestions : questions.length,
    requiredFilled,
    requiredTotal: required.length,
    requiredPercentage: required.length === 0
      ? 0
      : Math.round((requiredFilled / required.length) * 100),
    discoveryComplete: model.run?.completeness?.discoveryComplete ?? null,
    unobservedRegions: model.run?.completeness?.unobservedRegions ?? 0,
    required: Object.freeze(required),
    optional: Object.freeze(optional),
  });
}

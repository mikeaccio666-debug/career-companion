import {
  parsePilotUa4TerminalLedger,
  type PilotUa4FinalDisposition,
  type PilotUa4TerminalLedger,
  type PilotUa4UnobservedRegion,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';

import type { PilotUa1DiscoveryFailureCode } from './pilotUa1DiscoveryProtocol';

/**
 * Dormant CAP-AF-039 predecessor. This file is deliberately not wired to an
 * Extension entrypoint and owns no discovery, answer, writer, navigation,
 * host-control, or terminal-ledger authority. It never invokes Continue, Next,
 * or Submit and never inspects a host value, label, selector, URL, or HTML.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const DEFAULT_DEBOUNCE_MS = 450;
const DEFAULT_MAX_SETTLE_MS = 10_000;
const DEFAULT_MAX_REDISCOVERIES = 4;
const MAX_PAGES = 64;
const MAX_SETTLE_MS = 60_000;
const MAX_REDISCOVERIES = 16;

export type PilotMultipageFailureCode = Extract<
  PilotUa1DiscoveryFailureCode,
  | 'PILOT_CAPABILITY_DISABLED'
  | 'PILOT_DISCOVERY_UNAVAILABLE'
  | 'PILOT_NOT_USER_TRIGGERED'
  | 'PILOT_TARGET_DRIFT'
>;

export interface MultipageStablePageIdentity {
  readonly missionStepDigest: string;
  readonly stepIdentityDigest: string;
  /** Digest only. Raw URL/query/hash never enters this module. */
  readonly exactPageUrlDigest: string;
  readonly pageOrdinal: number;
}

export interface MultipageObservationIdentity extends MultipageStablePageIdentity {
  readonly documentEpoch: number;
  readonly historyEpoch: number;
}

export interface MultipageRequiredQuestionDisposition {
  readonly questionId: string;
  readonly disposition: PilotUa4FinalDisposition;
}

export interface MultipageLedgerFacts {
  readonly binding: PilotUa4TerminalLedger['binding'];
  readonly currentGenerationDiscoveryComplete: boolean;
  readonly requiredDispositions: readonly MultipageRequiredQuestionDisposition[];
  readonly unobservedRegions: readonly PilotUa4UnobservedRegion[];
}

/** Shared by Mission and LOCAL_SESSION checkpoints; neither derives its own ledger. */
export function readMultipageLedgerFacts(ledger: unknown):
  | Readonly<{ ok: true; value: MultipageLedgerFacts }>
  | Readonly<{ ok: false; code: 'PILOT_DISCOVERY_UNAVAILABLE' }> {
  try {
    const parsed = parsePilotUa4TerminalLedger(ledger);
    if (!parsed.ok) return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    const dispositionsById = new Map(parsed.value.dispositions.map((entry) => [entry.questionId, entry.disposition]));
    const requiredDispositions: MultipageRequiredQuestionDisposition[] = [];
    for (const question of parsed.value.questions) {
      if (!question.required) continue;
      const disposition = dispositionsById.get(question.questionId);
      if (disposition === undefined) return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
      requiredDispositions.push(Object.freeze({ disposition, questionId: question.questionId }));
    }
    return Object.freeze({ ok: true, value: Object.freeze({
      binding: parsed.value.binding,
      currentGenerationDiscoveryComplete: parsed.value.discoveryComplete,
      requiredDispositions: Object.freeze(requiredDispositions),
      unobservedRegions: parsed.value.unobservedRegions,
    }) });
  } catch { return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); }
}

export interface CreateMultipagePageCheckpointInput {
  /** Opaque idempotency key, not a payload-integrity claim. */
  readonly checkpointId: string;
  readonly identity: MultipageObservationIdentity;
  readonly predecessorCheckpointId: string | null;
  /** Parsed by the canonical UA-4 parser; caller summaries are never accepted. */
  readonly terminalLedger: unknown;
}

export interface MultipagePageCheckpoint {
  readonly checkpointId: string;
  readonly identity: MultipageObservationIdentity;
  readonly predecessorCheckpointId: string | null;
  readonly sourceDomGenerationDigest: string;
  /** Exact-generation fact copied from canonical UA-4, never whole-wizard completeness. */
  readonly currentGenerationDiscoveryComplete: boolean;
  readonly requiredDispositions: readonly MultipageRequiredQuestionDisposition[];
  /** Canonical v2 regions remain separate from the observed question denominator. */
  readonly unobservedRegions: readonly PilotUa4UnobservedRegion[];
}

export type CreateMultipagePageCheckpointResult =
  | Readonly<{ ok: true; checkpoint: MultipagePageCheckpoint }>
  | Readonly<{
      ok: false;
      code: Extract<PilotMultipageFailureCode, 'PILOT_DISCOVERY_UNAVAILABLE' | 'PILOT_TARGET_DRIFT'>;
    }>;

export interface MultipageRequiredDispositionRef {
  readonly checkpointId: string;
  readonly pageOrdinal: number;
  readonly stepIdentityDigest: string;
  readonly questionId: string;
  readonly disposition: PilotUa4FinalDisposition;
}

export interface MultipageObservedDispositionAggregate {
  readonly canUndoPriorSteps: false;
  readonly observedPageCount: number;
  readonly requiredDispositions: readonly MultipageRequiredDispositionRef[];
  readonly unobservedRegions: readonly MultipageUnobservedRegionRef[];
}

export type MultipageUnobservedRegionRef = PilotUa4UnobservedRegion & Readonly<{
  checkpointId: string;
  pageOrdinal: number;
  stepIdentityDigest: string;
}>;

export interface MultipageCheckpointProjection {
  readonly checkpoints: readonly MultipagePageCheckpoint[];
  readonly aggregate: MultipageObservedDispositionAggregate;
}

export type ProjectMultipageCheckpointResult =
  | Readonly<{ ok: true; projection: MultipageCheckpointProjection }>
  | Readonly<{
      ok: false;
      code: Extract<PilotMultipageFailureCode, 'PILOT_DISCOVERY_UNAVAILABLE' | 'PILOT_TARGET_DRIFT'>;
    }>;

type DataRecord = Readonly<Record<string, unknown>>;

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeStableIdentity(value: unknown): MultipageStablePageIdentity | null {
  const record = exactDataRecord(value, [
    'missionStepDigest', 'stepIdentityDigest', 'exactPageUrlDigest', 'pageOrdinal',
  ]);
  if (
    record === null ||
    !isDigest(record.missionStepDigest) ||
    !isDigest(record.stepIdentityDigest) ||
    !isDigest(record.exactPageUrlDigest) ||
    !Number.isSafeInteger(record.pageOrdinal) ||
    (record.pageOrdinal as number) < 0 ||
    (record.pageOrdinal as number) >= MAX_PAGES
  ) return null;
  return Object.freeze({
    exactPageUrlDigest: record.exactPageUrlDigest,
    missionStepDigest: record.missionStepDigest,
    pageOrdinal: record.pageOrdinal as number,
    stepIdentityDigest: record.stepIdentityDigest,
  });
}

function normalizeObservationIdentity(value: unknown): MultipageObservationIdentity | null {
  const record = exactDataRecord(value, [
    'missionStepDigest', 'stepIdentityDigest', 'exactPageUrlDigest', 'pageOrdinal',
    'documentEpoch', 'historyEpoch',
  ]);
  if (record === null) return null;
  const stable = normalizeStableIdentity({
    exactPageUrlDigest: record.exactPageUrlDigest,
    missionStepDigest: record.missionStepDigest,
    pageOrdinal: record.pageOrdinal,
    stepIdentityDigest: record.stepIdentityDigest,
  });
  if (stable === null || !isEpoch(record.documentEpoch) || !isEpoch(record.historyEpoch)) {
    return null;
  }
  return Object.freeze({
    ...stable,
    documentEpoch: record.documentEpoch,
    historyEpoch: record.historyEpoch,
  });
}

const trustedCheckpoints = new WeakSet<object>();
/** Exact predecessor object proven by live root/identity/generation validation. */
const observedTransitionPredecessors = new WeakMap<object, MultipagePageCheckpoint>();
const trustedProjections = new WeakSet<object>();

export function createMultipagePageCheckpoint(
  input: CreateMultipagePageCheckpointInput,
): CreateMultipagePageCheckpointResult {
  try {
    const record = exactDataRecord(input, [
      'checkpointId', 'identity', 'predecessorCheckpointId', 'terminalLedger',
    ]);
    if (record === null) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    const identity = normalizeObservationIdentity(record.identity);
    if (
      identity === null ||
      !isDigest(record.checkpointId) ||
      (record.predecessorCheckpointId !== null && !isDigest(record.predecessorCheckpointId)) ||
      (identity.pageOrdinal === 0 && record.predecessorCheckpointId !== null) ||
      (identity.pageOrdinal > 0 && record.predecessorCheckpointId === null)
    ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    const facts = readMultipageLedgerFacts(record.terminalLedger);
    if (!facts.ok) {
      return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    }
    const checkpoint: MultipagePageCheckpoint = Object.freeze({
      checkpointId: record.checkpointId,
      currentGenerationDiscoveryComplete: facts.value.currentGenerationDiscoveryComplete,
      identity,
      predecessorCheckpointId: record.predecessorCheckpointId,
      requiredDispositions: facts.value.requiredDispositions,
      sourceDomGenerationDigest: facts.value.binding.domGeneration,
      unobservedRegions: facts.value.unobservedRegions,
    });
    trustedCheckpoints.add(checkpoint);
    return Object.freeze({ ok: true, checkpoint });
  } catch {
    return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  }
}

function projectionFrom(
  checkpoints: readonly MultipagePageCheckpoint[],
): MultipageCheckpointProjection | null {
  const requiredDispositions: MultipageRequiredDispositionRef[] = [];
  const unobservedRegions: MultipageUnobservedRegionRef[] = [];
  for (const checkpoint of checkpoints) {
    for (const entry of checkpoint.requiredDispositions) {
      requiredDispositions.push(Object.freeze({
        checkpointId: checkpoint.checkpointId,
        disposition: entry.disposition,
        pageOrdinal: checkpoint.identity.pageOrdinal,
        questionId: entry.questionId,
        stepIdentityDigest: checkpoint.identity.stepIdentityDigest,
      }));
    }
    for (const region of checkpoint.unobservedRegions) {
      unobservedRegions.push(Object.freeze({
        ...region,
        checkpointId: checkpoint.checkpointId,
        pageOrdinal: checkpoint.identity.pageOrdinal,
        stepIdentityDigest: checkpoint.identity.stepIdentityDigest,
      }));
    }
  }
  const aggregate: MultipageObservedDispositionAggregate = Object.freeze({
    canUndoPriorSteps: false,
    observedPageCount: checkpoints.length,
    requiredDispositions: Object.freeze(requiredDispositions),
    unobservedRegions: Object.freeze(unobservedRegions),
  });
  const projection: MultipageCheckpointProjection = Object.freeze({
    aggregate,
    checkpoints: Object.freeze([...checkpoints]),
  });
  trustedProjections.add(projection);
  return projection;
}

function epochsAdvance(
  previous: MultipageObservationIdentity,
  next: MultipageObservationIdentity,
): boolean {
  return next.documentEpoch >= previous.documentEpoch &&
    next.historyEpoch >= previous.historyEpoch &&
    (next.documentEpoch > previous.documentEpoch || next.historyEpoch > previous.historyEpoch);
}

function isSameLogicalPage(
  previous: MultipageStablePageIdentity,
  next: MultipageStablePageIdentity,
): boolean {
  return previous.missionStepDigest === next.missionStepDigest &&
    next.pageOrdinal === previous.pageOrdinal &&
    next.stepIdentityDigest === previous.stepIdentityDigest;
}

function isNextLogicalPage(
  previous: MultipageStablePageIdentity,
  next: MultipageStablePageIdentity,
): boolean {
  return previous.missionStepDigest === next.missionStepDigest &&
    next.pageOrdinal === previous.pageOrdinal + 1 &&
    next.stepIdentityDigest !== previous.stepIdentityDigest;
}

function validRevisionOrSuccessor(
  previous: MultipagePageCheckpoint,
  next: MultipagePageCheckpoint,
): boolean {
  if (!epochsAdvance(previous.identity, next.identity)) return false;
  if (isSameLogicalPage(previous.identity, next.identity)) {
    if (
      next.predecessorCheckpointId !== previous.predecessorCheckpointId ||
      next.checkpointId === previous.checkpointId
    ) return false;
    return next.identity.exactPageUrlDigest === previous.identity.exactPageUrlDigest ||
      next.identity.historyEpoch > previous.identity.historyEpoch;
  }
  return isNextLogicalPage(previous.identity, next.identity) &&
    next.predecessorCheckpointId === previous.checkpointId &&
    next.checkpointId !== previous.checkpointId;
}

export function projectMultipageCheckpoint(
  current: MultipageCheckpointProjection,
  candidate: MultipagePageCheckpoint,
): ProjectMultipageCheckpointResult {
  if (!trustedProjections.has(current) || !trustedCheckpoints.has(candidate)) {
    return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  }
  const checkpoints = current.checkpoints;
  if (checkpoints.length === 0) {
    return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  }

  const last = checkpoints.at(-1)!;
  if (last === candidate) return Object.freeze({ ok: true, projection: current });
  if (
    observedTransitionPredecessors.get(candidate) !== last ||
    checkpoints.some((checkpoint) => checkpoint.checkpointId === candidate.checkpointId) ||
    !validRevisionOrSuccessor(last, candidate)
  ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

  let updated: readonly MultipagePageCheckpoint[];
  if (candidate.identity.pageOrdinal === last.identity.pageOrdinal) {
    updated = Object.freeze([...checkpoints.slice(0, -1), candidate]);
  } else {
    if (
      checkpoints.length >= MAX_PAGES ||
      checkpoints.some(
        (checkpoint) => checkpoint.identity.stepIdentityDigest === candidate.identity.stepIdentityDigest,
      )
    ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    updated = Object.freeze([...checkpoints, candidate]);
  }
  const projection = projectionFrom(updated);
  return projection === null
    ? Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' })
    : Object.freeze({ ok: true, projection });
}

export interface MultipageMutationObserverLike {
  readonly observe: (target: Node, options: MutationObserverInit) => void;
  readonly disconnect: () => void;
}

export type MultipageMutationObserverCallback = (
  records: readonly MutationRecord[],
) => void;

export type MultipageMutationObserverFactory = (
  callback: MultipageMutationObserverCallback,
) => MultipageMutationObserverLike;

export type MultipageHistorySignal = 'pushState' | 'replaceState' | 'popstate';

export interface PilotMultipageFoundationInput {
  readonly enabled: boolean;
  /** Existing intent owner must authenticate and consume this opaque proof. */
  readonly consumeUserContinueProof: (
    proof: object,
    previousCheckpoint: MultipagePageCheckpoint,
  ) => boolean;
  readonly getDocumentElement: () => Element | null;
  /** Caller-owned cheap added-node prefilter; no selector is copied here. */
  readonly mutationMayRevealControls: (records: readonly MutationRecord[]) => boolean;
  readonly readPageIdentity: () => MultipageStablePageIdentity | null;
  /** Fresh UA-1 binding evidence; only its value-free DOM-generation digest crosses. */
  readonly readCurrentDomGenerationDigest: () => string | null;
  readonly rediscover: (
    identity: MultipageObservationIdentity,
  ) => Promise<MultipagePageCheckpoint | null> | MultipagePageCheckpoint | null;
  readonly invalidateCurrentPageAuthority: () => boolean;
  readonly observerFactory?: MultipageMutationObserverFactory;
  readonly now?: () => number;
  readonly maxSettleMs?: number;
  readonly maxRediscoveries?: number;
}

export type MultipageTransitionResult =
  | Readonly<{ ok: true; checkpoint: MultipagePageCheckpoint }>
  | Readonly<{
      ok: false;
      code: 'PILOT_DISCOVERY_UNAVAILABLE';
      /** Fresh incomplete observation for display only; no successful transition or write authority. */
      observedCheckpoint: MultipagePageCheckpoint;
    }>
  | Readonly<{ ok: false; code: PilotMultipageFailureCode }>;

export type CreateInitialMultipageProjectionResult =
  | Readonly<{ ok: true; projection: MultipageCheckpointProjection }>
  | Readonly<{ ok: false; code: PilotMultipageFailureCode }>;

export type ArmMultipageFoundationResult =
  | Readonly<{ ok: true; completion: Promise<MultipageTransitionResult> }>
  | Readonly<{ ok: false; code: PilotMultipageFailureCode }>;

export interface PilotMultipageFoundation {
  /** Live-binds the page-zero checkpoint before it may seed aggregation. */
  readonly createInitialProjection: (
    checkpoint: MultipagePageCheckpoint,
  ) => CreateInitialMultipageProjectionResult;
  readonly armFromUserContinue: (input: Readonly<{
    proof: object;
    previousCheckpoint: MultipagePageCheckpoint;
  }>) => ArmMultipageFoundationResult;
  readonly notifyHistoryChange: (kind: MultipageHistorySignal) => void;
  readonly notifyDocumentReplaced: () => void;
  readonly notifyPageHide: (input: Readonly<{ persisted: boolean }>) => void;
  readonly notifyPageShow: (input: Readonly<{ persisted: boolean }>) => void;
  readonly dispose: () => void;
}

interface ActiveTransition {
  readonly previousCheckpoint: MultipagePageCheckpoint;
  readonly observer: MultipageMutationObserverLike;
  readonly resolve: (result: MultipageTransitionResult) => void;
  readonly deadlineAtMs: number;
  root: Element;
  documentEpoch: number;
  historyEpoch: number;
  generation: number;
  attempts: number;
  inFlight: boolean;
  pending: boolean;
  suspended: boolean;
  phase: 'observing' | 'retiring' | 'settled';
  retirementFailure: PilotMultipageFailureCode | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  scanToken: object | null;
}

const createNativeObserver: MultipageMutationObserverFactory = (callback) => {
  const observer = new MutationObserver((records) => callback(records));
  return Object.freeze({
    disconnect: () => observer.disconnect(),
    observe: (target: Node, options: MutationObserverInit) => observer.observe(target, options),
  });
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): Readonly<{ ok: true; value: number }> | Readonly<{ ok: false }> {
  if (value === undefined) return Object.freeze({ ok: true, value: fallback });
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return Object.freeze({ ok: false });
  }
  return Object.freeze({ ok: true, value });
}

function rejectWithObserver(
  observer: MultipageMutationObserverLike,
  code: PilotMultipageFailureCode,
): Extract<ArmMultipageFoundationResult, { ok: false }> {
  try {
    observer.disconnect();
  } catch {
    return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  }
  return Object.freeze({ ok: false, code });
}

function sameStableIdentity(
  left: MultipageStablePageIdentity,
  right: MultipageStablePageIdentity,
): boolean {
  return left.missionStepDigest === right.missionStepDigest &&
    left.stepIdentityDigest === right.stepIdentityDigest &&
    left.exactPageUrlDigest === right.exactPageUrlDigest &&
    left.pageOrdinal === right.pageOrdinal;
}

function checkpointMatchesObservation(
  checkpoint: MultipagePageCheckpoint,
  observation: MultipageObservationIdentity,
  previous: MultipagePageCheckpoint,
): boolean {
  return trustedCheckpoints.has(checkpoint) &&
    checkpoint.identity.missionStepDigest === observation.missionStepDigest &&
    checkpoint.identity.stepIdentityDigest === observation.stepIdentityDigest &&
    checkpoint.identity.exactPageUrlDigest === observation.exactPageUrlDigest &&
    checkpoint.identity.pageOrdinal === observation.pageOrdinal &&
    checkpoint.identity.documentEpoch === observation.documentEpoch &&
    checkpoint.identity.historyEpoch === observation.historyEpoch &&
    validRevisionOrSuccessor(previous, checkpoint);
}

export function createPilotMultipageFoundation(
  input: PilotMultipageFoundationInput,
): PilotMultipageFoundation {
  const settle = boundedInteger(input.maxSettleMs, DEFAULT_MAX_SETTLE_MS, 1, MAX_SETTLE_MS);
  const attempts = boundedInteger(
    input.maxRediscoveries, DEFAULT_MAX_REDISCOVERIES, 1, MAX_REDISCOVERIES,
  );
  const configurationValid = settle.ok && attempts.ok;
  const debounceMs = DEFAULT_DEBOUNCE_MS;
  const maxSettleMs = settle.ok ? settle.value : DEFAULT_MAX_SETTLE_MS;
  const maxRediscoveries = attempts.ok ? attempts.value : DEFAULT_MAX_REDISCOVERIES;
  const now = input.now ?? Date.now;
  const consumedProofs = new WeakSet<object>();
  let lastNowMs: number | null = null;
  let active: ActiveTransition | null = null;
  let disposed = false;
  let arming = false;
  let validatingInitial = false;

  const readNow = (): number | null => {
    try {
      const value = now();
      if (!isEpoch(value) || (lastNowMs !== null && value < lastNowMs)) return null;
      lastNowMs = value;
      return value;
    } catch {
      return null;
    }
  };

  const clearTimers = (transition: ActiveTransition): void => {
    if (transition.debounceTimer !== null) {
      clearTimeout(transition.debounceTimer);
      transition.debounceTimer = null;
    }
    if (transition.deadlineTimer !== null) {
      clearTimeout(transition.deadlineTimer);
      transition.deadlineTimer = null;
    }
  };

  const finish = (transition: ActiveTransition, result: MultipageTransitionResult): void => {
    if (active !== transition || transition.phase !== 'observing') return;
    transition.phase = 'retiring';
    clearTimers(transition);
    transition.scanToken = null;
    transition.inFlight = false;
    transition.pending = false;
    try {
      // Keep the active slot occupied, but continue recording invalidation while
      // external cleanup runs. Neither reentry nor cancellation may clean twice.
      transition.observer.disconnect();
    } catch {
      result = Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    }
    const candidate = result.ok
      ? result.checkpoint
      : 'observedCheckpoint' in result ? result.observedCheckpoint : null;
    if (candidate !== null && !disposed && transition.retirementFailure === null) {
      const failure = revalidateRetiringCheckpoint(transition, candidate);
      transition.retirementFailure ??= failure;
    }
    if (disposed) {
      result = Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    } else if (transition.retirementFailure !== null) {
      result = Object.freeze({ ok: false, code: transition.retirementFailure });
    }
    transition.phase = 'settled';
    active = null;
    // Publish projection eligibility only after retirement, with no external
    // callback between this binding and delivery of the result.
    if (result.ok) observedTransitionPredecessors.set(result.checkpoint, transition.previousCheckpoint);
    else if ('observedCheckpoint' in result) {
      observedTransitionPredecessors.set(result.observedCheckpoint, transition.previousCheckpoint);
    }
    transition.resolve(Object.freeze(result));
  };

  const fail = (transition: ActiveTransition, code: PilotMultipageFailureCode): void => {
    if (active === transition && transition.phase === 'retiring') {
      transition.retirementFailure ??= code;
      return;
    }
    finish(transition, Object.freeze({ ok: false, code }));
  };

  const readStableIdentity = (): MultipageStablePageIdentity | null => {
    try {
      return normalizeStableIdentity(input.readPageIdentity());
    } catch {
      return null;
    }
  };

  const readDomGenerationDigest = (): string | null => {
    try {
      const value = input.readCurrentDomGenerationDigest();
      return isDigest(value) ? value : null;
    } catch {
      return null;
    }
  };

  const isCurrent = (transition: ActiveTransition): boolean =>
    !disposed && active === transition && transition.phase === 'observing';

  const isObservable = (transition: ActiveTransition): boolean =>
    isCurrent(transition) && !transition.suspended;

  const remainingMs = (transition: ActiveTransition): number | null => {
    const current = readNow();
    return current === null ? null : Math.max(0, transition.deadlineAtMs - current);
  };

  const revalidateRetiringCheckpoint = (
    transition: ActiveTransition,
    candidate: MultipagePageCheckpoint,
  ): PilotMultipageFailureCode | null => {
    let currentRoot: Element | null;
    try {
      currentRoot = input.getDocumentElement();
    } catch {
      return 'PILOT_DISCOVERY_UNAVAILABLE';
    }
    const currentIdentity = readStableIdentity();
    const currentDomGeneration = readDomGenerationDigest();
    const remaining = remainingMs(transition);
    if (
      currentRoot !== transition.root || currentIdentity === null ||
      !sameStableIdentity(currentIdentity, candidate.identity) ||
      currentDomGeneration !== candidate.sourceDomGenerationDigest ||
      transition.documentEpoch !== candidate.identity.documentEpoch ||
      transition.historyEpoch !== candidate.identity.historyEpoch
    ) return 'PILOT_TARGET_DRIFT';
    if (remaining === null || remaining <= 0) return 'PILOT_DISCOVERY_UNAVAILABLE';
    // Reentrant signals from these reads remain latched in retirementFailure;
    // finish checks that latch and disposal after the last external callback.
    return null;
  };

  const startDeadline = (transition: ActiveTransition): boolean => {
    const remaining = remainingMs(transition);
    if (!isObservable(transition) || remaining === null || remaining <= 0) return false;
    if (transition.deadlineTimer !== null) clearTimeout(transition.deadlineTimer);
    transition.deadlineTimer = setTimeout(() => {
      transition.deadlineTimer = null;
      fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
    }, remaining);
    return true;
  };

  const rebindObserver = (transition: ActiveTransition, force: boolean): boolean => {
    try {
      const root = input.getDocumentElement();
      if (!isObservable(transition) || root === null) return false;
      if (!force && root === transition.root) return true;
      transition.observer.disconnect();
      if (!isObservable(transition)) return false;
      transition.observer.observe(root, { childList: true, subtree: true });
      if (!isObservable(transition)) return false;
      transition.root = root;
      return true;
    } catch {
      return false;
    }
  };

  let scheduleRediscovery: (transition: ActiveTransition) => void;

  const runRediscovery = (transition: ActiveTransition): void => {
    if (active !== transition || transition.suspended || transition.phase !== 'observing') return;
    const remaining = remainingMs(transition);
    if (
      !isCurrent(transition) || remaining === null || remaining <= 0 ||
      transition.attempts >= maxRediscoveries
    ) {
      fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      return;
    }
    const stableBefore = readStableIdentity();
    if (
      !isCurrent(transition) ||
      stableBefore === null ||
      (!isSameLogicalPage(transition.previousCheckpoint.identity, stableBefore) &&
        !isNextLogicalPage(transition.previousCheckpoint.identity, stableBefore))
    ) {
      fail(transition, 'PILOT_TARGET_DRIFT');
      return;
    }
    const observation: MultipageObservationIdentity = Object.freeze({
      ...stableBefore,
      documentEpoch: transition.documentEpoch,
      historyEpoch: transition.historyEpoch,
    });
    const generation = transition.generation;
    const root = transition.root;
    const scanToken = Object.freeze({});
    transition.scanToken = scanToken;
    transition.inFlight = true;
    transition.pending = false;
    transition.attempts += 1;

    const supersededOrStopped = (): boolean => {
      if (
        !isCurrent(transition) || transition.scanToken !== scanToken ||
        transition.suspended
      ) return true;
      if (transition.generation === generation && !transition.pending) return false;
      transition.inFlight = false;
      transition.scanToken = null;
      transition.pending = false;
      scheduleRediscovery(transition);
      return true;
    };
    let domGenerationBefore: string | null = null;

    void Promise.resolve()
      .then(() => {
        // This microtask may run after dispose, pagehide, expiry or another signal.
        if (supersededOrStopped()) return null;
        const remainingBeforeScan = remainingMs(transition);
        if (supersededOrStopped()) return null;
        if (remainingBeforeScan === null || remainingBeforeScan <= 0) {
          fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
          return null;
        }
        let rootBefore: Element | null;
        try {
          rootBefore = input.getDocumentElement();
        } catch {
          fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
          return null;
        }
        if (supersededOrStopped()) return null;
        const identityBeforeScan = readStableIdentity();
        if (supersededOrStopped()) return null;
        domGenerationBefore = readDomGenerationDigest();
        if (supersededOrStopped()) return null;
        if (
          rootBefore !== root || identityBeforeScan === null || domGenerationBefore === null ||
          !sameStableIdentity(stableBefore, identityBeforeScan)
        ) {
          fail(transition, 'PILOT_TARGET_DRIFT');
          return null;
        }
        return input.rediscover(observation);
      })
      .then((candidate) => {
        if (supersededOrStopped()) return;
        let currentRoot: Element | null = null;
        try {
          currentRoot = input.getDocumentElement();
        } catch {
          currentRoot = null;
        }
        if (supersededOrStopped()) return;
        const stableAfter = readStableIdentity();
        if (supersededOrStopped()) return;
        const domGenerationAfter = readDomGenerationDigest();
        if (supersededOrStopped()) return;
        if (
          currentRoot !== root ||
          stableAfter === null ||
          domGenerationAfter === null ||
          !sameStableIdentity(stableBefore, stableAfter)
        ) {
          fail(transition, 'PILOT_TARGET_DRIFT');
          return;
        }
        if (candidate === null) {
          fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
          return;
        }
        if (!checkpointMatchesObservation(candidate, observation, transition.previousCheckpoint)) {
          fail(transition, 'PILOT_TARGET_DRIFT');
          return;
        }
        if (
          candidate.sourceDomGenerationDigest !== domGenerationAfter ||
          candidate.sourceDomGenerationDigest === domGenerationBefore ||
          candidate.sourceDomGenerationDigest ===
            transition.previousCheckpoint.sourceDomGenerationDigest
        ) {
          fail(transition, 'PILOT_TARGET_DRIFT');
          return;
        }
        const remainingAfterScan = remainingMs(transition);
        if (supersededOrStopped()) return;
        if (remainingAfterScan === null || remainingAfterScan <= 0) {
          fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
          return;
        }
        if (supersededOrStopped()) return;
        if (!candidate.currentGenerationDiscoveryComplete) {
          finish(transition, Object.freeze({
            ok: false,
            code: 'PILOT_DISCOVERY_UNAVAILABLE',
            observedCheckpoint: candidate,
          }));
          return;
        }
        finish(transition, Object.freeze({ ok: true, checkpoint: candidate }));
      })
      .catch(() => {
        if (
          !isCurrent(transition) || transition.scanToken !== scanToken ||
          transition.suspended
        ) return;
        if (transition.generation !== generation || transition.pending) {
          transition.inFlight = false;
          transition.scanToken = null;
          transition.pending = false;
          scheduleRediscovery(transition);
          return;
        }
        transition.inFlight = false;
        transition.scanToken = null;
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      });
  };

  scheduleRediscovery = (transition: ActiveTransition): void => {
    if (active !== transition || transition.suspended || transition.phase !== 'observing') return;
    if (transition.inFlight) {
      transition.pending = true;
      return;
    }
    if (transition.attempts >= maxRediscoveries) {
      fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      return;
    }
    if (transition.debounceTimer !== null) clearTimeout(transition.debounceTimer);
    transition.debounceTimer = setTimeout(() => {
      transition.debounceTimer = null;
      runRediscovery(transition);
    }, debounceMs);
  };

  const increment = (value: number): number | null => {
    const next = value + 1;
    return Number.isSafeInteger(next) ? next : null;
  };

  const signal = (
    transition: ActiveTransition,
    kind: 'document' | 'history',
    forceRebind: boolean,
  ): void => {
    if (active !== transition || transition.phase === 'settled') return;
    if (transition.phase === 'retiring') {
      fail(transition, 'PILOT_TARGET_DRIFT');
      return;
    }
    if (transition.suspended) return;
    if (!rebindObserver(transition, forceRebind)) {
      if (isCurrent(transition) && !transition.suspended) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      }
      return;
    }
    if (!isCurrent(transition)) return;
    const nextEpoch = increment(
      kind === 'document' ? transition.documentEpoch : transition.historyEpoch,
    );
    const nextGeneration = increment(transition.generation);
    if (nextEpoch === null || nextGeneration === null) {
      fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      return;
    }
    if (kind === 'document') transition.documentEpoch = nextEpoch;
    else transition.historyEpoch = nextEpoch;
    transition.generation = nextGeneration;
    scheduleRediscovery(transition);
  };

  const createInitialProjection: PilotMultipageFoundation['createInitialProjection'] = (
    checkpoint,
  ) => {
    if (!input.enabled || disposed) {
      return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    }
    if (!configurationValid) {
      return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    }
    if (active !== null || arming || validatingInitial) {
      return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    }
    if (
      !trustedCheckpoints.has(checkpoint) ||
      checkpoint.identity.pageOrdinal !== 0 ||
      checkpoint.predecessorCheckpointId !== null
    ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    validatingInitial = true;
    try {
      let rootBefore: Element | null = null;
      try {
        rootBefore = input.getDocumentElement();
      } catch {
        rootBefore = null;
      }
      const identityBefore = readStableIdentity();
      const domGenerationBefore = readDomGenerationDigest();
      if (disposed || active !== null || arming) {
        return Object.freeze({
          ok: false,
          code: disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT',
        });
      }
      if (
        rootBefore === null || identityBefore === null || domGenerationBefore === null
      ) return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

      let rootAfter: Element | null = null;
      try {
        rootAfter = input.getDocumentElement();
      } catch {
        rootAfter = null;
      }
      const identityAfter = readStableIdentity();
      const domGenerationAfter = readDomGenerationDigest();
      if (disposed || active !== null || arming) {
        return Object.freeze({
          ok: false,
          code: disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT',
        });
      }
      if (
        rootAfter !== rootBefore ||
        identityAfter === null ||
        !sameStableIdentity(identityBefore, identityAfter) ||
        domGenerationAfter !== domGenerationBefore ||
        !sameStableIdentity(identityAfter, checkpoint.identity) ||
        checkpoint.sourceDomGenerationDigest !== domGenerationAfter
      ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

      const projection = projectionFrom([checkpoint]);
      return projection === null
        ? Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' })
        : Object.freeze({ ok: true, projection });
    } finally {
      validatingInitial = false;
    }
  };

  const armFromUserContinue: PilotMultipageFoundation['armFromUserContinue'] = (armInput) => {
    if (!input.enabled || disposed) {
      return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    }
    if (!configurationValid) {
      return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    }
    if (active !== null || arming || validatingInitial) {
      return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    }
    if (!trustedCheckpoints.has(armInput.previousCheckpoint)) {
      return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    }
    if (
      typeof armInput.proof !== 'object' ||
      armInput.proof === null ||
      consumedProofs.has(armInput.proof)
    ) return Object.freeze({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });

    arming = true;
    consumedProofs.add(armInput.proof);
    try {
      let consumed = false;
      try {
        consumed = input.consumeUserContinueProof(
          armInput.proof, armInput.previousCheckpoint,
        ) === true;
      } catch {
        consumed = false;
      }
      if (!consumed) {
        return Object.freeze({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
      }
      if (disposed || active !== null) {
        return Object.freeze({
          ok: false,
          code: disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT',
        });
      }

      let root: Element | null = null;
      try {
        root = input.getDocumentElement();
      } catch {
        root = null;
      }
      if (disposed || active !== null || root === null) {
        if (disposed) return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
        if (active !== null) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });
        return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
      }
      const currentPageIdentity = readStableIdentity();
      const currentDomGeneration = readDomGenerationDigest();
      if (disposed || active !== null) {
        return Object.freeze({
          ok: false,
          code: disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT',
        });
      }
      if (
        currentPageIdentity === null ||
        !sameStableIdentity(currentPageIdentity, armInput.previousCheckpoint.identity) ||
        currentDomGeneration === null ||
        currentDomGeneration !== armInput.previousCheckpoint.sourceDomGenerationDigest
      ) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

      const owner: { transition: ActiveTransition | null } = { transition: null };
      let observer: MultipageMutationObserverLike;
      try {
        observer = (input.observerFactory ?? createNativeObserver)((records) => {
          const transition = owner.transition;
          if (
            transition === null || active !== transition ||
            transition.phase === 'settled' ||
            (transition.suspended && transition.phase === 'observing')
          ) return;
          let relevant = false;
          try {
            relevant = input.mutationMayRevealControls(records);
          } catch {
            fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
            return;
          }
          if (relevant) signal(transition, 'document', false);
        });
      } catch {
        return Object.freeze({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
      }
      if (disposed || active !== null) {
        return rejectWithObserver(observer, disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT');
      }

      let invalidated = false;
      try {
        invalidated = input.invalidateCurrentPageAuthority() === true;
      } catch {
        invalidated = false;
      }
      if (!invalidated) {
        return rejectWithObserver(observer, 'PILOT_DISCOVERY_UNAVAILABLE');
      }
      if (disposed || active !== null) {
        return rejectWithObserver(observer, disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT');
      }

      try {
        observer.observe(root, { childList: true, subtree: true });
      } catch {
        return rejectWithObserver(observer, 'PILOT_DISCOVERY_UNAVAILABLE');
      }
      if (disposed || active !== null) {
        return rejectWithObserver(observer, disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT');
      }
      let observedRoot: Element | null = null;
      try {
        observedRoot = input.getDocumentElement();
      } catch {
        observedRoot = null;
      }
      const observedPageIdentity = readStableIdentity();
      const observedDomGeneration = readDomGenerationDigest();
      if (disposed || active !== null) {
        return rejectWithObserver(observer, disposed ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_TARGET_DRIFT');
      }
      if (
        observedRoot !== root ||
        observedPageIdentity === null ||
        !sameStableIdentity(observedPageIdentity, armInput.previousCheckpoint.identity) ||
        observedDomGeneration !== currentDomGeneration
      ) {
        return rejectWithObserver(observer, 'PILOT_TARGET_DRIFT');
      }
      const startedAtMs = readNow();
      if (
        disposed || active !== null || startedAtMs === null ||
        !Number.isSafeInteger(startedAtMs + maxSettleMs)
      ) {
        return rejectWithObserver(observer, disposed
            ? 'PILOT_CAPABILITY_DISABLED'
            : active !== null
              ? 'PILOT_TARGET_DRIFT'
              : 'PILOT_DISCOVERY_UNAVAILABLE');
      }
      let resolveCompletion!: (result: MultipageTransitionResult) => void;
      const completion = new Promise<MultipageTransitionResult>((resolve) => {
        resolveCompletion = resolve;
      });
      const transition: ActiveTransition = {
        attempts: 0,
        deadlineAtMs: startedAtMs + maxSettleMs,
        deadlineTimer: null,
        debounceTimer: null,
        documentEpoch: armInput.previousCheckpoint.identity.documentEpoch,
        generation: 0,
        historyEpoch: armInput.previousCheckpoint.identity.historyEpoch,
        inFlight: false,
        observer,
        pending: false,
        phase: 'observing',
        previousCheckpoint: armInput.previousCheckpoint,
        resolve: resolveCompletion,
        retirementFailure: null,
        root,
        scanToken: null,
        suspended: false,
      };
      owner.transition = transition;
      active = transition;
      if (!startDeadline(transition)) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      }
      return Object.freeze({ ok: true, completion });
    } finally {
      arming = false;
    }
  };

  return Object.freeze({
    armFromUserContinue,
    createInitialProjection,
    notifyDocumentReplaced: () => {
      if (active !== null) signal(active, 'document', true);
    },
    notifyHistoryChange: (_kind: MultipageHistorySignal) => {
      // Payload-free kind cannot carry a URL or arbitrary host data.
      if (active !== null) signal(active, 'history', false);
    },
    notifyPageHide: ({ persisted }: Readonly<{ persisted: boolean }>) => {
      const transition = active;
      if (transition === null || transition.phase === 'settled') return;
      if (transition.phase === 'retiring') {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      if (!persisted) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      clearTimers(transition);
      transition.suspended = true;
      transition.pending = false;
      transition.inFlight = false;
      transition.scanToken = null;
      const nextGeneration = increment(transition.generation);
      if (nextGeneration === null) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      transition.generation = nextGeneration;
      try {
        transition.observer.disconnect();
      } catch {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
      }
    },
    notifyPageShow: ({ persisted }: Readonly<{ persisted: boolean }>) => {
      const transition = active;
      if (transition === null || !persisted || transition.phase === 'settled') return;
      if (transition.phase === 'retiring') {
        fail(transition, 'PILOT_TARGET_DRIFT');
        return;
      }
      if (!transition.suspended) return;
      const suspendedGeneration = transition.generation;
      const remaining = remainingMs(transition);
      if (
        !isCurrent(transition) || !transition.suspended ||
        transition.generation !== suspendedGeneration
      ) return;
      if (remaining === null || remaining <= 0) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      transition.suspended = false;
      if (!rebindObserver(transition, true)) {
        if (
          isCurrent(transition) && !transition.suspended &&
          transition.generation === suspendedGeneration
        ) fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      if (
        !isObservable(transition) || transition.generation !== suspendedGeneration
      ) return;
      const nextDocumentEpoch = increment(transition.documentEpoch);
      const nextHistoryEpoch = increment(transition.historyEpoch);
      const nextGeneration = increment(transition.generation);
      if (
        nextDocumentEpoch === null || nextHistoryEpoch === null || nextGeneration === null
      ) {
        fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        return;
      }
      transition.documentEpoch = nextDocumentEpoch;
      transition.historyEpoch = nextHistoryEpoch;
      transition.generation = nextGeneration;
      if (!startDeadline(transition)) {
        if (isCurrent(transition) && !transition.suspended) {
          fail(transition, 'PILOT_DISCOVERY_UNAVAILABLE');
        }
        return;
      }
      if (!isObservable(transition) || transition.generation !== nextGeneration) return;
      scheduleRediscovery(transition);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (active !== null) fail(active, 'PILOT_CAPABILITY_DISABLED');
    },
  });
}

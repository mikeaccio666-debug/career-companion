import type { Result, ScanRoot } from '../contracts';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import type { WriteTicket } from '../undo';
import {
  attachHostFile,
  clearHostFile,
  hasSafeResumeFileIdentity,
  isApprovedResumeFileTarget,
  matchesFileAccept,
  type AttachedFileConfirmation,
  type AttachHostFileError,
  type ClearHostFileError,
} from './setFile';
import {
  classifyHostValidation,
  settleAfterHostWrite,
  type HostValidationSignals,
} from './verify';

/**
 * Dormant file-input semantic-settle leaf.
 *
 * This module deliberately has no runner, Extension, channel, or UA wiring.
 * It accepts one already resolved target and one in-memory File, performs no
 * fetch, logs no value, touches no Submit control, and never claims that
 * clearing the DOM FileList reverses a host's persistent upload or parsing.
 */

export type ResumeFileSettlePhase = 'INITIAL_SETTLE' | 'LATE_RECHECK';

export const RESUME_FILE_LATE_RECHECK_MS = 250;
export const RESUME_FILE_SETTLE_TIMEOUT_MS = 2_000;
export const RESUME_FILE_SETTLE_TIMEOUT_MAX_MS = 5_000;

export type ResumeFileSemanticSettleError =
  | AttachHostFileError
  | 'FILE_TARGET_UNAPPROVED'
  | 'FILE_TARGET_REPLACED'
  | 'FILE_TARGET_CHANGED'
  | 'FILE_CLEARED_DURING_SETTLE'
  | 'FILE_REPLACED_DURING_SETTLE'
  | 'FILE_OWNERSHIP_UNVERIFIED'
  | 'FILE_HOST_REJECTED'
  | 'FILE_HOST_UNVERIFIED'
  | 'FILE_WRITE_AUTHORITY_REQUIRED'
  | 'FILE_SETTLE_CONFIG_INVALID'
  | 'FILE_SETTLE_TIMEOUT'
  | 'FILE_SETTLE_ABORTED'
  | 'FILE_SETTLE_FAILED';

export type ResumeFileUndoError =
  | ClearHostFileError
  | 'FILE_UNDO_NOT_OWNED'
  | 'FILE_UNDO_AUTHORITY_REQUIRED';

type LeafResult<T, E extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: E };

export interface ResumeFileOwnedUndo {
  /** Exact DOM node + exact File object ownership, never name/size equality. */
  readonly isOwnedState: () => boolean;
  /** Clears only that exact owned File and dispatches the existing file events. */
  readonly restore: (
    authority: HostWriteAuthority,
  ) => LeafResult<void, ResumeFileUndoError>;
  /** Retires this local capability; it does not mutate the host. */
  readonly dispose: () => void;
}

export interface ResumeFileSemanticSettleInput {
  readonly element: HTMLInputElement;
  /**
   * Rule-/signature-owned exact target lookup. A same-shaped replacement node
   * must resolve as a different object and is therefore rejected.
   */
  readonly resolveCurrentTarget: () => HTMLInputElement | null;
  readonly file: File;
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  /** Required host verdict; absence/throw/unknown is not success. */
  readonly readHostValidation: (element: HTMLInputElement) => HostValidationSignals;
  readonly signal?: AbortSignal;
  /** Total deadline shared by initial settle and late recheck. */
  readonly settleTimeoutMs?: number;
  /** Injectable scheduler for deterministic tests; production default remains bounded. */
  readonly settle?: (
    phase: ResumeFileSettlePhase,
    signal?: AbortSignal,
  ) => Promise<void> | void;
}

export type ResumeFileSemanticSettleResult =
  | {
      readonly ok: true;
      readonly status: 'SETTLED';
      readonly undo: ResumeFileOwnedUndo;
    }
  | {
      readonly ok: false;
      readonly code: ResumeFileSemanticSettleError;
      /** Present only when the exact in-memory File is still provably owned. */
      readonly recovery?: ResumeFileOwnedUndo;
    };

type OwnedStateFailure =
  | 'FILE_TARGET_REPLACED'
  | 'FILE_TARGET_CHANGED'
  | 'FILE_CLEARED_DURING_SETTLE'
  | 'FILE_REPLACED_DURING_SETTLE'
  | 'FILE_OWNERSHIP_UNVERIFIED';

type PhaseOutcome = 'ok' | 'timeout' | 'aborted' | 'failed';

class ResumeFileSettleAbortedError extends Error {
  constructor() {
    super('Resume file settle aborted.');
    this.name = 'ResumeFileSettleAbortedError';
  }
}

function exactResolvedTarget(input: ResumeFileSemanticSettleInput): boolean {
  try {
    return input.resolveCurrentTarget() === input.element;
  } catch {
    return false;
  }
}

function inspectOwnedState(input: ResumeFileSemanticSettleInput): OwnedStateFailure | null {
  try {
    if (
      !input.element.isConnected ||
      !exactResolvedTarget(input) ||
      !input.root.querySelectorAll('input[type="file"]').includes(input.element)
    ) {
      return 'FILE_TARGET_REPLACED';
    }
  } catch {
    return 'FILE_TARGET_REPLACED';
  }
  try {
    if (!hasSafeResumeFileIdentity(input.element, input.root)) {
      return 'FILE_TARGET_CHANGED';
    }
  } catch {
    return 'FILE_TARGET_CHANGED';
  }

  let files: FileList | null;
  try {
    files = input.element.files;
  } catch {
    return 'FILE_OWNERSHIP_UNVERIFIED';
  }
  if (files === null || files.length === 0) return 'FILE_CLEARED_DURING_SETTLE';
  if (files.length !== 1 || files[0] !== input.file) {
    return 'FILE_REPLACED_DURING_SETTLE';
  }
  return null;
}

/**
 * Semantic success requires both exact-object ownership and compatibility with
 * the target's current accept rules. Compatibility is deliberately not part
 * of the ownership predicate: an accept drift must fail, but it must not hide
 * our authority to compensate the exact File object we attached.
 */
function inspectSemanticState(
  input: ResumeFileSemanticSettleInput,
): OwnedStateFailure | 'VALUE_COERCED' | null {
  const ownershipFailure = inspectOwnedState(input);
  if (ownershipFailure !== null) return ownershipFailure;
  try {
    if (!matchesFileAccept(input.element.getAttribute('accept') ?? '', input.file)) {
      return 'VALUE_COERCED';
    }
  } catch {
    return 'VALUE_COERCED';
  }
  return null;
}

type InternalCompensationError =
  | ClearHostFileError
  | 'FILE_UNDO_NOT_OWNED'
  | 'FILE_WRITE_AUTHORITY_REQUIRED';

interface OwnedFileControl {
  readonly undo: ResumeFileOwnedUndo;
  readonly compensate: (
    authority: HostWriteAuthority,
  ) => LeafResult<void, InternalCompensationError>;
}

function createOwnedFileControl(input: ResumeFileSemanticSettleInput): OwnedFileControl {
  let disposed = false;

  const isOwnedState = (): boolean =>
    !disposed && input.ticket.ok && inspectOwnedState(input) === null;

  const clearOwned = <E extends 'FILE_WRITE_AUTHORITY_REQUIRED' | 'FILE_UNDO_AUTHORITY_REQUIRED'>(
    authority: HostWriteAuthority,
    purpose: 'fill' | 'undo',
    purposeError: E,
  ): LeafResult<void, ClearHostFileError | 'FILE_UNDO_NOT_OWNED' | E> => {
    if (authority.purpose !== purpose) return { ok: false, code: purposeError };
    if (!isOwnedState()) return { ok: false, code: 'FILE_UNDO_NOT_OWNED' };
    if (!input.ticket.ok) return { ok: false, code: 'FILE_UNDO_NOT_OWNED' };
    let restored: LeafResult<void, ClearHostFileError>;
    try {
      restored = clearHostFile({
        element: input.element,
        expectedFile: input.file,
        authority,
        ticket: input.ticket.value,
      });
    } catch {
      return { ok: false, code: 'VALUE_COERCED' };
    }
    if (!restored.ok) return restored;
    disposed = true;
    return restored;
  };

  const undo = Object.freeze<ResumeFileOwnedUndo>({
    isOwnedState,
    restore(authority: HostWriteAuthority): LeafResult<void, ResumeFileUndoError> {
      return clearOwned(authority, 'undo', 'FILE_UNDO_AUTHORITY_REQUIRED');
    },
    dispose(): void {
      disposed = true;
    },
  });
  return Object.freeze({
    undo,
    compensate(authority: HostWriteAuthority): LeafResult<void, InternalCompensationError> {
      return clearOwned(authority, 'fill', 'FILE_WRITE_AUTHORITY_REQUIRED');
    },
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: () => void) => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      outcome();
    };
    const abort = () => finish(() => reject(new ResumeFileSettleAbortedError()));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(resolve), ms);
  });
}

function defaultSettle(
  phase: ResumeFileSettlePhase,
  signal?: AbortSignal,
): Promise<void> {
  return phase === 'INITIAL_SETTLE'
    ? settleAfterHostWrite(signal)
    : abortableDelay(RESUME_FILE_LATE_RECHECK_MS, signal);
}

function classifySettleError(error: unknown): Exclude<PhaseOutcome, 'ok'> {
  if (
    error instanceof ResumeFileSettleAbortedError ||
    (error instanceof Error && error.name === 'WriteVerificationAbortedError')
  ) {
    return 'aborted';
  }
  if (error instanceof Error && error.name === 'WriteVerificationTimeoutError') {
    return 'timeout';
  }
  return 'failed';
}

async function runBoundedPhase(
  input: ResumeFileSemanticSettleInput,
  phase: ResumeFileSettlePhase,
  deadlineAt: number,
): Promise<PhaseOutcome> {
  if (input.signal?.aborted) return 'aborted';
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 'timeout';

  const settle = input.settle ?? defaultSettle;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  return new Promise<PhaseOutcome>((resolve) => {
    const finish = (outcome: PhaseOutcome) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish('aborted');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      finish('aborted');
      return;
    }

    timer = setTimeout(() => finish('timeout'), remaining);
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(settle(phase, input.signal));
    } catch (error) {
      finish(classifySettleError(error));
      return;
    }
    operation.then(
      () => finish('ok'),
      (error: unknown) => finish(classifySettleError(error)),
    );
  });
}

function phaseError(outcome: Exclude<PhaseOutcome, 'ok'>): ResumeFileSemanticSettleError {
  if (outcome === 'timeout') return 'FILE_SETTLE_TIMEOUT';
  if (outcome === 'aborted') return 'FILE_SETTLE_ABORTED';
  return 'FILE_SETTLE_FAILED';
}

function validateHostAndOwnership(
  input: ResumeFileSemanticSettleInput,
): ResumeFileSemanticSettleError | null {
  if (input.signal?.aborted) return 'FILE_SETTLE_ABORTED';
  const beforeValidation = inspectSemanticState(input);
  if (beforeValidation !== null) return beforeValidation;

  let signals: HostValidationSignals;
  try {
    signals = input.readHostValidation(input.element);
  } catch {
    return 'FILE_HOST_UNVERIFIED';
  }
  if (input.signal?.aborted) return 'FILE_SETTLE_ABORTED';
  // The injected DOM reader is an execution boundary: it may synchronously
  // replace the target or FileList while returning accepted-looking data.
  const afterValidation = inspectSemanticState(input);
  if (afterValidation !== null) return afterValidation;
  let verdict: ReturnType<typeof classifyHostValidation>;
  try {
    verdict = classifyHostValidation(signals);
  } catch {
    return 'FILE_HOST_UNVERIFIED';
  }
  if (verdict === 'rejected') return 'FILE_HOST_REJECTED';
  if (verdict !== 'accepted') return 'FILE_HOST_UNVERIFIED';
  return null;
}

function failAfterWrite(
  input: ResumeFileSemanticSettleInput,
  code: ResumeFileSemanticSettleError,
  control: OwnedFileControl = createOwnedFileControl(input),
): ResumeFileSemanticSettleResult {
  const recovery = control.undo;
  if (!recovery.isOwnedState()) {
    recovery.dispose();
    return { ok: false, code };
  }

  // Best-effort synchronous compensation is safe only for the exact File
  // object on the exact still-current target. Failure retains the same sealed
  // handle; a third state never receives an Undo capability.
  const compensated = control.compensate(input.authority);
  if (compensated.ok) return { ok: false, code };
  if (recovery.isOwnedState()) return { ok: false, code, recovery };
  recovery.dispose();
  return { ok: false, code };
}

export async function settleResumeFileWrite(
  input: ResumeFileSemanticSettleInput,
): Promise<ResumeFileSemanticSettleResult> {
  const timeoutMs = input.settleTimeoutMs ?? RESUME_FILE_SETTLE_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RESUME_FILE_SETTLE_TIMEOUT_MAX_MS
  ) {
    return { ok: false, code: 'FILE_SETTLE_CONFIG_INVALID' };
  }
  if (input.signal?.aborted) {
    return { ok: false, code: 'FILE_SETTLE_ABORTED' };
  }
  if (input.authority.purpose !== 'fill') {
    return { ok: false, code: 'FILE_WRITE_AUTHORITY_REQUIRED' };
  }
  let targetApproved = false;
  try {
    targetApproved =
      exactResolvedTarget(input) &&
      isApprovedResumeFileTarget(input.element, input.root);
  } catch {
    targetApproved = false;
  }
  if (!targetApproved) {
    return { ok: false, code: 'FILE_TARGET_UNAPPROVED' };
  }
  if (input.signal?.aborted) {
    return { ok: false, code: 'FILE_SETTLE_ABORTED' };
  }

  try {
    const preWriteFiles = input.element.files;
    if (preWriteFiles === null) {
      return { ok: false, code: 'FILE_OWNERSHIP_UNVERIFIED' };
    }
    if (preWriteFiles.length !== 0) {
      return { ok: false, code: 'NOT_EMPTY' };
    }
  } catch {
    return { ok: false, code: 'FILE_OWNERSHIP_UNVERIFIED' };
  }
  if (input.signal?.aborted) {
    return { ok: false, code: 'FILE_SETTLE_ABORTED' };
  }

  // This leaf proves ownership and the host verdict itself (see
  // `validateHostAndOwnership`), so it ignores the attach-time confirmation.
  let attached: Result<AttachedFileConfirmation, AttachHostFileError>;
  try {
    attached = attachHostFile({
      element: input.element,
      file: input.file,
      root: input.root,
      authority: input.authority,
      ticket: input.ticket,
      policy: input.policy,
    });
  } catch {
    return failAfterWrite(input, 'FILE_SETTLE_FAILED');
  }
  if (input.signal?.aborted) {
    return failAfterWrite(input, 'FILE_SETTLE_ABORTED');
  }
  if (!attached.ok) return failAfterWrite(input, attached.code);

  const deadlineAt = Date.now() + timeoutMs;
  for (const phase of ['INITIAL_SETTLE', 'LATE_RECHECK'] as const) {
    const outcome = await runBoundedPhase(input, phase, deadlineAt);
    if (outcome !== 'ok') return failAfterWrite(input, phaseError(outcome));
    const validationFailure = validateHostAndOwnership(input);
    if (validationFailure !== null) return failAfterWrite(input, validationFailure);
  }

  if (input.signal?.aborted) {
    return failAfterWrite(input, 'FILE_SETTLE_ABORTED');
  }
  const finalControl = createOwnedFileControl(input);
  const undo = finalControl.undo;
  if (!undo.isOwnedState()) {
    undo.dispose();
    return { ok: false, code: 'FILE_OWNERSHIP_UNVERIFIED' };
  }
  // The final ownership proof invokes the exact resolver, which is itself an
  // execution boundary. Re-read both the current File object and accept rules
  // after that proof and immediately before exposing SETTLED/Undo.
  const finalSemanticFailure = inspectSemanticState(input);
  if (finalSemanticFailure !== null) {
    return failAfterWrite(input, finalSemanticFailure, finalControl);
  }
  if (input.signal?.aborted) {
    return failAfterWrite(input, 'FILE_SETTLE_ABORTED', finalControl);
  }
  return { ok: true, status: 'SETTLED', undo };
}

/**
 * Selector-free fill-first settlement shared by non-text semantic controls.
 *
 * The caller owns exact DOM identity and the one permitted forward mutation.
 * This module owns the ordering around that mutation: fresh authorization,
 * pre-state recheck, readback, host validation, a positive late window, and a
 * batch-final read-only observation. It never receives a pre-write value or a
 * restoration callback, so no failure or disposal path can clear the host.
 */

import { APPLY_ERROR_CODES, type ApplyErrorCode } from '../contracts.ts';
import {
  classifyHostValidation,
  isWriteVerificationTimeout,
  settleAfterHostWrite,
  WRITE_VERIFICATION_TIMEOUT_MS,
  type HostValidationSignals,
} from './verify.ts';

export interface FillOnlySemanticObservation {
  readonly check: () => ApplyErrorCode | null;
  readonly finalize: (retireConsumer?: () => boolean) => ApplyErrorCode | null;
  readonly dispose: () => void;
}

export type FillOnlySemanticResult =
  | Readonly<{ ok: true; observation: FillOnlySemanticObservation }>
  | Readonly<{
      ok: false;
      code: ApplyErrorCode;
      writeEffect?: 'MAY_HAVE_CHANGED';
    }>;

declare const FILL_ONLY_HOST_WRITE_AUTHORITY: unique symbol;

/**
 * One synchronous, one-shot host-mutation capability minted only after the
 * leaf's fresh authorization and final empty-state proof. It carries no target
 * or answer and cannot be persisted or replayed after `writeForward` returns.
 */
export interface FillOnlyHostWriteAuthority {
  readonly [FILL_ONLY_HOST_WRITE_AUTHORITY]: 'fill-only-host-write';
}

type FillOnlyHostWriteState = { active: boolean; spent: boolean };
const fillOnlyHostWriteStates = new WeakMap<object, FillOnlyHostWriteState>();

/** Used only by a host-mutation primitive at the last synchronous boundary. */
export function consumeFillOnlyHostWriteAuthority(
  authority: FillOnlyHostWriteAuthority,
): boolean {
  try {
    const state = fillOnlyHostWriteStates.get(authority);
    if (state === undefined || !state.active || state.spent) return false;
    state.spent = true;
    return true;
  } catch {
    return false;
  }
}

export interface FillOnlySemanticInput {
  /** Fresh answer + execution authorization. Exact `true` only. */
  readonly authorizeWrite: () => Promise<boolean>;
  /** Current page, deadline, Submit, and caller-owned execution fence. */
  readonly executionFence: () => ApplyErrorCode | null;
  /** Exact target/group/widget identity; null means current. */
  readonly targetFence: () => ApplyErrorCode | null;
  /** True only for the caller-defined empty state captured at preparation. */
  readonly isAtPreWriteState: () => boolean;
  /** Exact semantic answer readback, never a raw display-value guess. */
  readonly isAtWrittenState: () => boolean;
  /** The sole forward mutation. No restore capability may be passed here. */
  readonly writeForward: (authority: FillOnlyHostWriteAuthority) => boolean;
  readonly readHostValidation: () => HostValidationSignals;
  readonly lateRecheckMs: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void> | void;
}

type StepOutcome = 'ok' | 'aborted' | 'timeout' | 'failed';
const DEFAULT_OPERATION_TIMEOUT_MS = WRITE_VERIFICATION_TIMEOUT_MS + 100;
const MAX_OPERATION_TIMEOUT_MS = 10_000;

function runBoundedStep(
  operation: (signal: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<StepOutcome> {
  if (parentSignal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operationAbort = new AbortController();
    const finish = (outcome: StepOutcome) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const stop = (outcome: Exclude<StepOutcome, 'ok'>) => {
      operationAbort.abort();
      finish(outcome);
    };
    const onAbort = () => stop('aborted');
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => operation(operationAbort.signal))
      .then(
        () => finish(parentSignal?.aborted ? 'aborted' : 'ok'),
        // 结算的看门狗超时就是超时（VERIFY_TIMEOUT），不是这一步的语义失败。
        (error: unknown) => finish(
          parentSignal?.aborted ? 'aborted' : isWriteVerificationTimeout(error) ? 'timeout' : 'failed',
        ),
      );
  });
}

function abortAwareDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function stableCode(value: unknown): ApplyErrorCode {
  return typeof value === 'string' && APPLY_ERROR_CODES.includes(value as ApplyErrorCode)
    ? value as ApplyErrorCode
    : 'ABORTED';
}

/** Execute exactly once. Every post-attempt failure truthfully preserves state. */
export async function executeFillOnlySemanticWrite(
  input: FillOnlySemanticInput,
): Promise<FillOnlySemanticResult> {
  let attempted = false;
  let disposed = false;
  const timeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const fail = (code: ApplyErrorCode): FillOnlySemanticResult => Object.freeze({
    ok: false,
    code,
    ...(attempted ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
  });
  const fence = (): ApplyErrorCode | null => {
    try {
      if (disposed || input.signal?.aborted) return 'ABORTED';
      const execution = input.executionFence();
      if (execution !== null) return stableCode(execution);
      if (disposed || input.signal?.aborted) return 'ABORTED';
      const target = input.targetFence();
      // A target proof is callback-capable and can synchronously revoke the
      // page/session while still returning an otherwise-current target. Read
      // the monotonic execution fence again before its result can authorize a
      // setter or another host event.
      if (disposed || input.signal?.aborted) return 'ABORTED';
      const afterTarget = input.executionFence();
      if (afterTarget !== null) return stableCode(afterTarget);
      if (disposed || input.signal?.aborted) return 'ABORTED';
      return target === null ? null : stableCode(target);
    } catch {
      return 'ABORTED';
    }
  };
  const checkpoint = (late: boolean): ApplyErrorCode | null => {
    const before = fence();
    if (before !== null) return before;
    let written = false;
    let validation: ReturnType<typeof classifyHostValidation> = 'unknown';
    try {
      written = input.isAtWrittenState() === true;
      validation = classifyHostValidation(input.readHostValidation());
    } catch {
      return 'HOST_REJECTED';
    }
    const after = fence();
    if (after !== null) return after;
    if (!written) return late ? 'LATE_REVERTED' : 'HOST_REJECTED';
    return validation === 'accepted' ? null : 'HOST_REJECTED';
  };
  const stepCode = (
    outcome: StepOutcome,
    failure: ApplyErrorCode,
  ): ApplyErrorCode | null => outcome === 'ok' ? null
    : outcome === 'aborted' ? 'ABORTED'
      : outcome === 'timeout' ? 'VERIFY_TIMEOUT'
        : failure;

  if (
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_OPERATION_TIMEOUT_MS ||
    !Number.isFinite(input.lateRecheckMs) || input.lateRecheckMs <= 0
  ) return fail('CAPABILITY_DISABLED');

  let code = fence();
  if (code !== null) return fail(code);
  try {
    if (input.isAtPreWriteState() !== true) return fail('IDENTITY_CHANGED');
  } catch {
    return fail('IDENTITY_CHANGED');
  }
  code = fence();
  if (code !== null) return fail(code);

  let authorized = false;
  let outcome = await runBoundedStep(async () => {
    authorized = await input.authorizeWrite() === true;
  }, timeoutMs, input.signal);
  code = stepCode(outcome, 'CAPABILITY_DISABLED');
  if (code !== null) return fail(code);
  if (!authorized) return fail('CAPABILITY_DISABLED');

  code = fence();
  if (code !== null) return fail(code);
  try {
    if (input.isAtPreWriteState() !== true) return fail('IDENTITY_CHANGED');
  } catch {
    return fail('IDENTITY_CHANGED');
  }
  // The empty-state proof is caller-owned too. Never carry an execution
  // verdict from before that callback across the first mutation boundary.
  code = fence();
  if (code !== null) return fail(code);

  attempted = true;
  const hostWriteState: FillOnlyHostWriteState = { active: true, spent: false };
  const hostWriteAuthority = Object.freeze({}) as FillOnlyHostWriteAuthority;
  fillOnlyHostWriteStates.set(hostWriteAuthority, hostWriteState);
  try {
    if (input.writeForward(hostWriteAuthority) !== true) {
      return fail('HOST_REJECTED');
    }
  } catch {
    return fail('HOST_REJECTED');
  } finally {
    hostWriteState.active = false;
    fillOnlyHostWriteStates.delete(hostWriteAuthority);
  }
  code = fence();
  if (code !== null) return fail(code);

  const settle = async (signal: AbortSignal) => {
    if (input.settle) await input.settle(signal);
    await settleAfterHostWrite(signal);
  };
  outcome = await runBoundedStep(settle, timeoutMs, input.signal);
  code = stepCode(outcome, 'HOST_REJECTED') ?? checkpoint(false);
  if (code !== null) return fail(code);

  outcome = await runBoundedStep(async (signal) => {
    await Promise.all([
      abortAwareDelay(input.lateRecheckMs, signal),
      input.lateRecheckDelay?.(input.lateRecheckMs, signal),
    ]);
  }, timeoutMs + input.lateRecheckMs, input.signal);
  code = stepCode(outcome, 'LATE_REVERTED') ?? checkpoint(true);
  if (code !== null) return fail(code);

  outcome = await runBoundedStep(settle, timeoutMs, input.signal);
  code = stepCode(outcome, 'LATE_REVERTED') ?? checkpoint(true);
  if (code !== null) return fail(code);

  return Object.freeze({
    ok: true,
    observation: Object.freeze({
      check: () => {
        if (disposed) return 'IDENTITY_CHANGED';
        try { return checkpoint(true); } catch { return 'HOST_REJECTED'; }
      },
      finalize: (retireConsumer?: () => boolean) => {
        let terminal: ApplyErrorCode | null;
        try { terminal = disposed ? 'IDENTITY_CHANGED' : checkpoint(true); }
        catch { terminal = 'HOST_REJECTED'; }
        try {
          if (retireConsumer !== undefined && retireConsumer() !== true) {
            terminal ??= 'HOST_REJECTED';
          }
        } catch {
          terminal ??= 'HOST_REJECTED';
        }
        // Consumer retirement may synchronously change the page. Re-read once
        // more while this observation remains active; never mutate in response.
        try { terminal ??= checkpoint(true); }
        catch { terminal ??= 'HOST_REJECTED'; }
        disposed = true;
        return terminal;
      },
      dispose: () => { disposed = true; },
    }),
  });
}

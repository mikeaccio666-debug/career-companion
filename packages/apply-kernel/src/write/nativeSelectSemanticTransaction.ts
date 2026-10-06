/**
 * Dormant native-select semantic transaction for CAP-AF-044.
 *
 * This leaf deliberately has no package export, runner/session wiring, vendor
 * selector, or production activation. It accepts a complete caller-owned
 * option membership and proves selection by the exact HTMLOptionElement and
 * its native selected state. A raw select/option value is identity metadata
 * only; it is never success or Undo ownership evidence.
 */

import { APPLY_ERROR_CODES, type ApplyErrorCode } from '../contracts.ts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant.ts';
import type { WriteTicket } from '../undo.ts';
import { dispatchHostEvent } from './allowlist.ts';
import {
  executeFillOnlySemanticWrite,
  type FillOnlySemanticResult,
} from './fillOnlySemantic.ts';
import {
  classifyHostValidation,
  settleAfterHostWrite,
  WRITE_VERIFICATION_TIMEOUT_MS,
  type HostValidationSignals,
} from './verify.ts';

export interface NativeSelectOptionInput {
  readonly element: HTMLOptionElement;
  /** Opaque rule/planner identity. DOM value and visible text are not answer IDs. */
  readonly optionId: string;
}

export interface PrepareNativeSelectSemanticTransactionInput {
  readonly select: HTMLSelectElement;
  /** Complete, ordered membership matching HTMLSelectElement.options exactly. */
  readonly options: readonly NativeSelectOptionInput[];
}

export type PrepareNativeSelectSemanticTransactionError =
  | 'INVALID_SELECT'
  | 'INVALID_OPTION_ID'
  | 'DUPLICATE_OPTION_ID'
  | 'INCOMPLETE_OPTION_MEMBERSHIP'
  | 'OPTION_STATE_UNAVAILABLE';

export type NativeSelectUndoError =
  | 'UNDO_RETIRED'
  | 'UNDO_NOT_OWNED'
  | 'UNDO_VERIFY_FAILED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'CAPABILITY_DISABLED'
  | 'HOST_SUBMITTED'
  | 'ABORTED';

export interface NativeSelectUndoRestoreInput {
  readonly authority: HostWriteAuthority;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly operationTimeoutMs?: number;
}

export interface NativeSelectSemanticUndo {
  readonly wasExternallyEdited: () => boolean;
  readonly isAtWrittenState: () => boolean;
  readonly restorePreWrite: (
    input: NativeSelectUndoRestoreInput,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: NativeSelectUndoError }
  >;
  readonly isAtPreWriteState: () => boolean;
  readonly dispose: () => void;
}

export interface NativeSelectSemanticWriteInput {
  readonly optionId: string;
  /** Required only if this is not the zero-write PREFILLED path. */
  readonly authority?: HostWriteAuthority;
  /** Required only if this is not the zero-write PREFILLED path. */
  readonly ticket?: WriteTicket;
  readonly readHostValidation: (select: HTMLSelectElement) => HostValidationSignals;
  readonly executionFence: () => ApplyErrorCode | null;
  /** A positive second window is mandatory; zero can never become success. */
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly operationTimeoutMs?: number;
}

/**
 * Fill-first boundary for one native select. It intentionally accepts no
 * HostWriteAuthority, WriteTicket, previous value, or restoration callback.
 */
export interface NativeSelectSemanticFillOnlyInput {
  readonly optionId: string;
  /** Explicit host-declared placeholder option IDs; -1 is also empty. */
  readonly emptyOptionIds: readonly string[];
  readonly authorizeWrite: () => Promise<boolean>;
  readonly readHostValidation: (select: HTMLSelectElement) => HostValidationSignals;
  readonly executionFence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly operationTimeoutMs?: number;
}

export type NativeSelectSemanticWriteResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly disposition: 'FILLED' | 'PREFILLED';
        readonly selectedOptionId: string;
        readonly undo: NativeSelectSemanticUndo | null;
      };
    }
  | {
      readonly ok: false;
      readonly code: ApplyErrorCode;
      /** Never present after HOST_SUBMITTED. */
      readonly recovery?: NativeSelectSemanticUndo;
    };

export interface NativeSelectSemanticTransaction {
  readonly optionIds: readonly string[];
  readonly isEmpty: (emptyOptionIds: readonly string[]) => boolean;
  readonly isSelected: (optionId: string) => boolean;
  readonly fillOnly: (
    input: NativeSelectSemanticFillOnlyInput,
  ) => Promise<FillOnlySemanticResult>;
  readonly write: (
    input: NativeSelectSemanticWriteInput,
  ) => Promise<NativeSelectSemanticWriteResult>;
}

export type PrepareNativeSelectSemanticTransactionResult =
  | { readonly ok: true; readonly value: NativeSelectSemanticTransaction }
  | { readonly ok: false; readonly error: PrepareNativeSelectSemanticTransactionError };

interface SelectAccess {
  readonly get: () => number;
  readonly set: (index: number) => void;
}

interface OptionAccess {
  readonly getSelected: () => boolean;
}

interface OptionSeal {
  readonly element: HTMLOptionElement;
  readonly optionId: string;
  readonly text: string;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly parent: Node;
  readonly parentDisabled: boolean;
  readonly parentHidden: boolean;
  readonly parentLabel: string | null;
  readonly access: OptionAccess;
}

interface SelectIdentity {
  readonly select: HTMLSelectElement;
  readonly root: Node;
  readonly parent: Node;
  readonly form: HTMLFormElement | null;
  readonly name: string;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly access: SelectAccess;
  readonly options: readonly OptionSeal[];
}

type StepOutcome = 'ok' | 'aborted' | 'timeout' | 'failed';
type CompensationOutcome = 'RESTORED' | 'NOT_RESTORED' | 'HOST_SUBMITTED';
type EventName = 'input' | 'change';

interface OwnershipWatcher {
  readonly dispatch: (event: EventName) => boolean;
  readonly wasExternal: () => boolean;
  /** Locally retires first, then best-effort removes every listener. */
  readonly dispose: () => boolean;
}

const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODES: ReadonlySet<string> = new Set(APPLY_ERROR_CODES);
const DEFAULT_OPERATION_TIMEOUT_MS = WRITE_VERIFICATION_TIMEOUT_MS + 100;
const MAX_OPERATION_TIMEOUT_MS = 10_000;
const WATCHED_EVENTS = ['beforeinput', 'input', 'change', 'click', 'reset'] as const;

function isApplyErrorCode(value: unknown): value is ApplyErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function selectAccess(select: HTMLSelectElement): SelectAccess | null {
  try {
    const prototype = select.ownerDocument.defaultView?.HTMLSelectElement.prototype;
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'selectedIndex')
      : undefined;
    if (typeof descriptor?.get !== 'function' || typeof descriptor.set !== 'function') return null;
    return Object.freeze({
      get: () => descriptor.get!.call(select) as number,
      set: (index: number) => { descriptor.set!.call(select, index); },
    });
  } catch {
    return null;
  }
}

function optionAccess(option: HTMLOptionElement): OptionAccess | null {
  try {
    const prototype = option.ownerDocument.defaultView?.HTMLOptionElement.prototype;
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'selected')
      : undefined;
    if (typeof descriptor?.get !== 'function') return null;
    return Object.freeze({
      getSelected: () => descriptor.get!.call(option) as boolean,
    });
  } catch {
    return null;
  }
}

function parentFacts(parent: Node | null): {
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly label: string | null;
} {
  if (parent && 'tagName' in parent && parent.tagName === 'OPTGROUP') {
    const group = parent as HTMLOptGroupElement;
    return { disabled: group.disabled, hidden: group.hidden, label: group.label };
  }
  return { disabled: false, hidden: false, label: null };
}

function sameElements(left: readonly Element[], right: readonly Element[]): boolean {
  return left.length === right.length && left.every((element, index) => element === right[index]);
}

function identityIsCurrent(identity: SelectIdentity): boolean {
  try {
    const { select } = identity;
    if (
      !select.isConnected ||
      select.getRootNode() !== identity.root ||
      select.parentNode !== identity.parent ||
      select.form !== identity.form ||
      select.name !== identity.name ||
      select.required !== identity.required ||
      select.disabled !== identity.disabled ||
      select.hidden !== identity.hidden ||
      select.multiple
    ) return false;

    const current = [...select.options];
    if (!sameElements(current, identity.options.map((option) => option.element))) return false;
    for (const option of identity.options) {
      const parent = parentFacts(option.element.parentNode);
      if (
        !option.element.isConnected ||
        option.element.getRootNode() !== identity.root ||
        option.element.parentNode !== option.parent ||
        option.element.text !== option.text ||
        option.element.value !== option.value ||
        option.element.label !== option.label ||
        option.element.disabled !== option.disabled ||
        option.element.hidden !== option.hidden ||
        parent.disabled !== option.parentDisabled ||
        parent.hidden !== option.parentHidden ||
        parent.label !== option.parentLabel
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Returns an exact semantic option index, or null for an invalid/ambiguous native state. */
function readSelection(identity: SelectIdentity): number | null {
  if (!identityIsCurrent(identity)) return null;
  try {
    const selectedIndex = identity.access.get();
    if (!Number.isInteger(selectedIndex) || selectedIndex < -1 || selectedIndex >= identity.options.length) {
      return null;
    }
    const vector = identity.options.map((option) => option.access.getSelected());
    if (selectedIndex === -1) return vector.every((selected) => !selected) ? -1 : null;
    return vector.every((selected, index) => selected === (index === selectedIndex))
      ? selectedIndex
      : null;
  } catch {
    return null;
  }
}

function exactSelection(identity: SelectIdentity, expected: number): boolean {
  return readSelection(identity) === expected;
}

function optionIsWritable(identity: SelectIdentity, index: number): boolean {
  const option = identity.options[index];
  return Boolean(
    option &&
    !identity.disabled &&
    !option.disabled &&
    !option.hidden &&
    !option.parentDisabled &&
    !option.parentHidden,
  );
}

function createOwnershipWatcher(select: HTMLSelectElement): OwnershipWatcher {
  let disposed = false;
  let external = false;
  let expected: EventName | null = null;
  let sawExpected = false;

  const observe = (event: Event) => {
    if (disposed) return;
    if (
      event.target === select &&
      expected === event.type &&
      sawExpected === false
    ) {
      sawExpected = true;
      return;
    }
    external = true;
  };
  for (const event of WATCHED_EVENTS) select.addEventListener(event, observe, true);
  const form = select.form;
  form?.addEventListener('reset', observe, true);

  return Object.freeze({
    dispatch(event: EventName): boolean {
      if (disposed || external) return false;
      expected = event;
      sawExpected = false;
      try {
        dispatchHostEvent(select, event);
      } catch {
        external = true;
      } finally {
        expected = null;
      }
      if (!sawExpected) external = true;
      return !external;
    },
    wasExternal: () => disposed || external,
    dispose(): boolean {
      if (disposed) return true;
      disposed = true;
      let clean = true;
      for (const event of WATCHED_EVENTS) {
        try { select.removeEventListener(event, observe, true); }
        catch { clean = false; }
      }
      if (form !== null) {
        try { form.removeEventListener('reset', observe, true); }
        catch { clean = false; }
      }
      return clean;
    },
  });
}

function operationTimeout(input: { readonly operationTimeoutMs?: number }): number | null {
  const timeout = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  return Number.isFinite(timeout) && timeout > 0 && timeout <= MAX_OPERATION_TIMEOUT_MS
    ? timeout
    : null;
}

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
        () => finish(parentSignal?.aborted ? 'aborted' : 'failed'),
      );
  });
}

function abortAwareDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function readFence(input: NativeSelectSemanticWriteInput): ApplyErrorCode | null {
  if (input.signal?.aborted) return 'ABORTED';
  try {
    const result: unknown = input.executionFence();
    if (result === null) return null;
    return isApplyErrorCode(result) ? result : 'ABORTED';
  } catch {
    return 'ABORTED';
  }
}

function checkFillAuthority(
  input: NativeSelectSemanticWriteInput,
): ApplyErrorCode | null {
  if (
    !input.authority ||
    !input.ticket ||
    input.ticket.purpose !== 'fill' ||
    input.authority.purpose !== 'fill'
  ) {
    return 'CAPABILITY_DISABLED';
  }
  void input.ticket;
  const access = checkActiveCapability(input.authority, 'set-select');
  return access.ok ? null : access.code;
}

function semanticProof(
  identity: SelectIdentity,
  watcher: OwnershipWatcher,
  expected: number,
  semanticFailure: ApplyErrorCode,
): ApplyErrorCode | null {
  if (!identityIsCurrent(identity)) return 'IDENTITY_CHANGED';
  if (!exactSelection(identity, expected)) return semanticFailure;
  return watcher.wasExternal() ? 'ABORTED' : null;
}

function proofAfterFence(
  identity: SelectIdentity,
  watcher: OwnershipWatcher,
  expected: number,
  input: NativeSelectSemanticWriteInput,
  semanticFailure: ApplyErrorCode,
): ApplyErrorCode | null {
  const before = semanticProof(identity, watcher, expected, semanticFailure);
  if (before !== null) return before;
  const fence = readFence(input);
  if (fence !== null) return fence;
  return semanticProof(identity, watcher, expected, semanticFailure);
}

function readValidation(
  identity: SelectIdentity,
  input: NativeSelectSemanticWriteInput,
): 'accepted' | 'rejected' | 'unknown' {
  try {
    return classifyHostValidation(input.readHostValidation(identity.select));
  } catch {
    return 'unknown';
  }
}

async function settlePhase(
  identity: SelectIdentity,
  watcher: OwnershipWatcher,
  expected: number,
  input: NativeSelectSemanticWriteInput,
  timeoutMs: number,
  semanticFailure: ApplyErrorCode,
): Promise<ApplyErrorCode | null> {
  const outcome = await runBoundedStep(
    async (signal) => {
      if (input.settle) await input.settle(signal);
      // The injected hook may add hostile work, but it can never replace the
      // real controlled-host settle window used by production.
      await settleAfterHostWrite(signal);
    },
    timeoutMs,
    input.signal,
  );
  if (outcome === 'aborted') return 'ABORTED';
  if (outcome === 'timeout') return 'VERIFY_TIMEOUT';
  if (outcome === 'failed') return semanticFailure;

  const settled = proofAfterFence(identity, watcher, expected, input, semanticFailure);
  if (settled !== null) return settled;
  const validation = readValidation(identity, input);
  const afterValidation = proofAfterFence(identity, watcher, expected, input, semanticFailure);
  if (afterValidation !== null) return afterValidation;
  if (validation === 'rejected') return 'HOST_REJECTED';
  if (validation === 'unknown') return 'CAPABILITY_DISABLED';
  return null;
}

function createSemanticUndo(input: {
  readonly identity: SelectIdentity;
  readonly watcher: OwnershipWatcher;
  readonly before: number;
  readonly written: number;
  readonly write: NativeSelectSemanticWriteInput;
}): NativeSelectSemanticUndo {
  let retired = false;
  let restored = false;
  let ownershipLost = false;

  const atWritten = () => {
    if (retired || ownershipLost) return false;
    if (input.watcher.wasExternal() || !exactSelection(input.identity, input.written)) {
      // Once a third state is observed, ownership loss is monotonic and an
      // ABA return cannot re-arm it. A transition that is both silent and
      // wholly unobserved needs external monotonic provenance before this
      // dormant handle may be wired as deferred product Undo.
      ownershipLost = true;
      return false;
    }
    return true;
  };

  const undoFence = (): Extract<NativeSelectUndoError, 'HOST_SUBMITTED' | 'ABORTED'> | null => {
    const fence = readFence(input.write);
    if (fence === null) return null;
    return fence === 'HOST_SUBMITTED' ? 'HOST_SUBMITTED' : 'ABORTED';
  };

  const retireFailure = (
    error: NativeSelectUndoError,
  ): { readonly ok: false; readonly error: NativeSelectUndoError } => {
    retired = true;
    input.watcher.dispose();
    return { ok: false, error };
  };

  const undo = Object.freeze<NativeSelectSemanticUndo>({
    wasExternallyEdited(): boolean {
      if (restored) return false;
      return !atWritten();
    },
    isAtWrittenState: atWritten,
    async restorePreWrite(restore): Promise<
      | { readonly ok: true }
      | { readonly ok: false; readonly error: NativeSelectUndoError }
    > {
      if (retired) return { ok: false, error: 'UNDO_RETIRED' };
      // Capture every caller-owned property before the final semantic/fence
      // proof. Accessors are caller code and may themselves drift host state.
      const timeoutMs = operationTimeout(restore);
      const restoreSignal = restore.signal;
      const restoreSettle = restore.settle;
      const restoreAuthority = restore.authority;
      if (restoreAuthority.purpose !== 'undo') {
        return { ok: false, error: 'CAPABILITY_DISABLED' };
      }
      const access = checkActiveCapability(restoreAuthority, 'set-select');
      if (!access.ok) return { ok: false, error: access.code };
      if (timeoutMs === null || restoreSignal?.aborted) {
        return { ok: false, error: 'UNDO_VERIFY_FAILED' };
      }
      const beforeRestoreFence = undoFence();
      if (beforeRestoreFence !== null) return retireFailure(beforeRestoreFence);
      if (!atWritten()) return { ok: false, error: 'UNDO_NOT_OWNED' };

      // Nothing callback-capable may sit between this final active-authority
      // proof and the first restoration setter.
      const finalRestoreAccess = checkActiveCapability(restoreAuthority, 'set-select');
      if (!finalRestoreAccess.ok) return retireFailure(finalRestoreAccess.code);

      // Atomic proof -> restore setter: there is no callback or await between
      // the exact written seal above and this first restoration mutation.
      try {
        input.identity.access.set(input.before);
      } catch {
        return retireFailure('UNDO_VERIFY_FAILED');
      }
      const afterSetterFence = undoFence();
      if (afterSetterFence !== null) return retireFailure(afterSetterFence);
      if (!exactSelection(input.identity, input.before)) {
        return retireFailure('UNDO_VERIFY_FAILED');
      }
      if (!checkActiveCapability(restoreAuthority, 'set-select').ok ||
          !input.watcher.dispatch('input') ||
          !exactSelection(input.identity, input.before)) {
        return retireFailure('UNDO_VERIFY_FAILED');
      }
      const afterInputFence = undoFence();
      if (afterInputFence !== null) return retireFailure(afterInputFence);
      if (!exactSelection(input.identity, input.before)) return retireFailure('UNDO_VERIFY_FAILED');
      if (!checkActiveCapability(restoreAuthority, 'set-select').ok ||
          !input.watcher.dispatch('change') ||
          !exactSelection(input.identity, input.before)) {
        return retireFailure('UNDO_VERIFY_FAILED');
      }
      const afterChangeFence = undoFence();
      if (afterChangeFence !== null) return retireFailure(afterChangeFence);
      if (!exactSelection(input.identity, input.before)) return retireFailure('UNDO_VERIFY_FAILED');
      const outcome = await runBoundedStep(
        async (signal) => {
          if (restoreSettle) await restoreSettle(signal);
          await settleAfterHostWrite(signal);
        },
        timeoutMs,
        restoreSignal,
      );
      const afterSettleFence = undoFence();
      if (afterSettleFence !== null) return retireFailure(afterSettleFence);
      if (outcome !== 'ok' || !exactSelection(input.identity, input.before)) {
        return retireFailure('UNDO_VERIFY_FAILED');
      }
      restored = true;
      retired = true;
      input.watcher.dispose();
      return { ok: true };
    },
    isAtPreWriteState(): boolean {
      return restored && exactSelection(input.identity, input.before);
    },
    dispose(): void {
      retired = true;
      input.watcher.dispose();
    },
  });
  return undo;
}

async function compensateExactWrite(input: {
  readonly identity: SelectIdentity;
  readonly watcher: OwnershipWatcher;
  readonly before: number;
  readonly written: number;
  readonly write: NativeSelectSemanticWriteInput;
  readonly timeoutMs: number;
}): Promise<CompensationOutcome> {
  if (readFence(input.write) === 'HOST_SUBMITTED') return 'HOST_SUBMITTED';
  if (
    input.write.authority?.purpose !== 'fill' ||
    !input.write.ticket ||
    !checkActiveCapability(input.write.authority, 'set-select').ok ||
    input.watcher.wasExternal() ||
    !exactSelection(input.identity, input.written)
  ) return 'NOT_RESTORED';
  // The execution callback itself may change semantic state. Re-prove the
  // exact written seal after it and immediately before the first rollback
  // setter.
  if (!exactSelection(input.identity, input.written)) return 'NOT_RESTORED';
  try {
    input.identity.access.set(input.before);
  } catch {
    return 'NOT_RESTORED';
  }
  if (readFence(input.write) === 'HOST_SUBMITTED') return 'HOST_SUBMITTED';
  if (!exactSelection(input.identity, input.before)) return 'NOT_RESTORED';
  if (!checkActiveCapability(input.write.authority, 'set-select').ok ||
      !input.watcher.dispatch('input') ||
      !exactSelection(input.identity, input.before)) return 'NOT_RESTORED';
  if (readFence(input.write) === 'HOST_SUBMITTED') return 'HOST_SUBMITTED';
  if (!exactSelection(input.identity, input.before)) return 'NOT_RESTORED';
  if (!checkActiveCapability(input.write.authority, 'set-select').ok ||
      !input.watcher.dispatch('change') ||
      !exactSelection(input.identity, input.before)) return 'NOT_RESTORED';
  if (readFence(input.write) === 'HOST_SUBMITTED') return 'HOST_SUBMITTED';
  if (!exactSelection(input.identity, input.before)) return 'NOT_RESTORED';
  const outcome = await runBoundedStep(
    async (signal) => {
      if (input.write.settle) await input.write.settle(signal);
      await settleAfterHostWrite(signal);
    },
    input.timeoutMs,
  );
  if (readFence(input.write) === 'HOST_SUBMITTED') return 'HOST_SUBMITTED';
  return outcome === 'ok' && exactSelection(input.identity, input.before)
    ? 'RESTORED'
    : 'NOT_RESTORED';
}

function prepareIdentity(
  input: PrepareNativeSelectSemanticTransactionInput,
):
  | { readonly ok: true; readonly value: SelectIdentity }
  | { readonly ok: false; readonly error: PrepareNativeSelectSemanticTransactionError } {
  const { select } = input;
  try {
    if (!select.isConnected || select.multiple || select.tagName !== 'SELECT') {
      return { ok: false, error: 'INVALID_SELECT' };
    }
    const currentOptions = [...select.options];
    if (
      currentOptions.length === 0 ||
      !sameElements(currentOptions, input.options.map((option) => option.element))
    ) return { ok: false, error: 'INCOMPLETE_OPTION_MEMBERSHIP' };
    const ids = input.options.map((option) => option.optionId);
    if (ids.some((id) => !SAFE_OPAQUE_ID.test(id))) {
      return { ok: false, error: 'INVALID_OPTION_ID' };
    }
    if (new Set(ids).size !== ids.length) {
      return { ok: false, error: 'DUPLICATE_OPTION_ID' };
    }
    const access = selectAccess(select);
    if (access === null) return { ok: false, error: 'OPTION_STATE_UNAVAILABLE' };
    const root = select.getRootNode();
    const options: OptionSeal[] = [];
    for (const optionInput of input.options) {
      const option = optionInput.element;
      const optionState = optionAccess(option);
      if (
        optionState === null ||
        !option.isConnected ||
        option.getRootNode() !== root ||
        option.parentNode === null
      ) return { ok: false, error: 'OPTION_STATE_UNAVAILABLE' };
      const parent = parentFacts(option.parentNode);
      options.push(Object.freeze({
        element: option,
        optionId: optionInput.optionId,
        text: option.text,
        value: option.value,
        label: option.label,
        disabled: option.disabled,
        hidden: option.hidden,
        parent: option.parentNode,
        parentDisabled: parent.disabled,
        parentHidden: parent.hidden,
        parentLabel: parent.label,
        access: optionState,
      }));
    }
    const identity: SelectIdentity = Object.freeze({
      select,
      root,
      parent: select.parentNode as Node,
      form: select.form,
      name: select.name,
      required: select.required,
      disabled: select.disabled,
      hidden: select.hidden,
      access,
      options: Object.freeze(options),
    });
    if (!identityIsCurrent(identity) || readSelection(identity) === null) {
      return { ok: false, error: 'OPTION_STATE_UNAVAILABLE' };
    }
    return { ok: true, value: identity };
  } catch {
    return { ok: false, error: 'OPTION_STATE_UNAVAILABLE' };
  }
}

async function fillOnlySelect(
  identity: SelectIdentity,
  input: NativeSelectSemanticFillOnlyInput,
): Promise<FillOnlySemanticResult> {
  let desired = -1;
  let emptyIds: Set<string>;
  try {
    if (
      !SAFE_OPAQUE_ID.test(input.optionId) ||
      !Array.isArray(input.emptyOptionIds) ||
      input.emptyOptionIds.some((id) => typeof id !== 'string' || !SAFE_OPAQUE_ID.test(id))
    ) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
    emptyIds = new Set(input.emptyOptionIds);
    if (emptyIds.size !== input.emptyOptionIds.length) {
      return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
    }
    desired = identity.options.findIndex((option) => option.optionId === input.optionId);
    if (desired < 0) return Object.freeze({ ok: false, code: 'NO_OPTION_MATCH' });
    if (
      emptyIds.has(input.optionId) ||
      [...emptyIds].some((id) => !identity.options.some((option) => option.optionId === id))
    ) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
  } catch {
    return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
  }
  if (!identityIsCurrent(identity)) {
    return Object.freeze({ ok: false, code: 'IDENTITY_CHANGED' });
  }
  if (!optionIsWritable(identity, desired)) {
    return Object.freeze({ ok: false, code: 'TARGET_NOT_WRITABLE' });
  }

  const watcher = createOwnershipWatcher(identity.select);
  let watcherRetired = false;
  const targetFence = (): ApplyErrorCode | null => {
    if (!identityIsCurrent(identity)) return 'IDENTITY_CHANGED';
    if (!optionIsWritable(identity, desired)) return 'TARGET_NOT_WRITABLE';
    return !watcherRetired && watcher.wasExternal() ? 'ABORTED' : null;
  };
  const forwardFenceCurrent = (): boolean => {
    try {
      if (input.signal?.aborted || input.executionFence() !== null) return false;
      if (targetFence() !== null || input.signal?.aborted) return false;
      return input.executionFence() === null && !input.signal?.aborted;
    } catch {
      return false;
    }
  };
  const result = await executeFillOnlySemanticWrite({
    authorizeWrite: input.authorizeWrite,
    executionFence: input.executionFence,
    targetFence,
    isAtPreWriteState: () => {
      const current = readSelection(identity);
      return current === -1 || current !== null && emptyIds.has(identity.options[current]!.optionId);
    },
    isAtWrittenState: () => exactSelection(identity, desired),
    writeForward: () => {
      identity.access.set(desired);
      if (!exactSelection(identity, desired) || !forwardFenceCurrent() ||
          !watcher.dispatch('input')) return false;
      if (!forwardFenceCurrent() || !exactSelection(identity, desired) ||
          !forwardFenceCurrent() || !watcher.dispatch('change')) return false;
      return forwardFenceCurrent() && exactSelection(identity, desired);
    },
    readHostValidation: () => input.readHostValidation(identity.select),
    lateRecheckMs: input.lateRecheckMs,
    operationTimeoutMs: input.operationTimeoutMs,
    signal: input.signal,
    settle: input.settle,
    lateRecheckDelay: input.lateRecheckDelay,
  });
  if (!result.ok) {
    watcherRetired = true;
    watcher.dispose();
    return result;
  }

  return Object.freeze({
    ok: true,
    observation: Object.freeze({
      check: result.observation.check,
      finalize: (retireConsumer?: () => boolean) => result.observation.finalize(() => {
        let clean = true;
        try {
          if (retireConsumer !== undefined && retireConsumer() !== true) clean = false;
        } catch {
          clean = false;
        }
        if (watcher.wasExternal()) clean = false;
        watcherRetired = true;
        if (!watcher.dispose()) clean = false;
        return clean;
      }),
      dispose: () => {
        result.observation.dispose();
        watcherRetired = true;
        watcher.dispose();
      },
    }),
  });
}

export function prepareNativeSelectSemanticTransaction(
  input: PrepareNativeSelectSemanticTransactionInput,
): PrepareNativeSelectSemanticTransactionResult {
  const prepared = prepareIdentity(input);
  if (!prepared.ok) return prepared;
  const identity = prepared.value;
  let consumed = false;

  const transaction = Object.freeze<NativeSelectSemanticTransaction>({
    optionIds: Object.freeze(identity.options.map((option) => option.optionId)),
    isEmpty: (emptyOptionIds: readonly string[]) => {
      if (!Array.isArray(emptyOptionIds)) return false;
      const current = readSelection(identity);
      return current === -1 || current !== null &&
        emptyOptionIds.includes(identity.options[current]!.optionId);
    },
    isSelected: (optionId: string) => {
      const index = identity.options.findIndex((option) => option.optionId === optionId);
      return index >= 0 && exactSelection(identity, index);
    },
    async fillOnly(fillInput): Promise<FillOnlySemanticResult> {
      if (consumed) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
      consumed = true;
      return fillOnlySelect(identity, fillInput);
    },
    async write(writeInput): Promise<NativeSelectSemanticWriteResult> {
      if (consumed) return { ok: false, code: 'CAPABILITY_DISABLED' };
      consumed = true;
      const timeoutMs = operationTimeout(writeInput);
      if (
        timeoutMs === null ||
        !Number.isFinite(writeInput.lateRecheckMs) ||
        writeInput.lateRecheckMs <= 0 ||
        !SAFE_OPAQUE_ID.test(writeInput.optionId)
      ) return { ok: false, code: 'CAPABILITY_DISABLED' };
      const desired = identity.options.findIndex((option) => option.optionId === writeInput.optionId);
      if (desired < 0) return { ok: false, code: 'NO_OPTION_MATCH' };
      if (!identityIsCurrent(identity)) return { ok: false, code: 'IDENTITY_CHANGED' };
      if (!optionIsWritable(identity, desired)) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
      const before = readSelection(identity);
      if (before === null) return { ok: false, code: 'IDENTITY_CHANGED' };
      const watcher = createOwnershipWatcher(identity.select);

      const finishFailure = async (code: ApplyErrorCode): Promise<NativeSelectSemanticWriteResult> => {
        if (code === 'HOST_SUBMITTED' || readFence(writeInput) === 'HOST_SUBMITTED') {
          watcher.dispose();
          return { ok: false, code: 'HOST_SUBMITTED' };
        }
        const compensation = await compensateExactWrite({
          identity,
          watcher,
          before,
          written: desired,
          write: writeInput,
          timeoutMs,
        });
        if (compensation === 'HOST_SUBMITTED') {
          watcher.dispose();
          return { ok: false, code: 'HOST_SUBMITTED' };
        }
        if (compensation === 'RESTORED') {
          watcher.dispose();
          return { ok: false, code };
        }
        if (!watcher.wasExternal() && exactSelection(identity, desired)) {
          return {
            ok: false,
            code,
            recovery: createSemanticUndo({
              identity,
              watcher,
              before,
              written: desired,
              write: writeInput,
            }),
          };
        }
        watcher.dispose();
        return { ok: false, code };
      };

      // PREFILLED is an explicit no-write path. It needs no authority/ticket,
      // emits no events and produces no semantic Undo, but it is still only a
      // success after accepted host validation and the mandatory late proof.
      if (before === desired) {
        let failure = await settlePhase(
          identity,
          watcher,
          desired,
          writeInput,
          timeoutMs,
          'LATE_REVERTED',
        );
        if (failure === null) {
          const delay = await runBoundedStep(
            async (signal) => {
              if (writeInput.lateRecheckDelay) {
                await writeInput.lateRecheckDelay(writeInput.lateRecheckMs, signal);
              }
              // A test/integration hook cannot collapse the mandatory timer.
              await abortAwareDelay(writeInput.lateRecheckMs, signal);
            },
            timeoutMs,
            writeInput.signal,
          );
          failure = delay === 'ok'
            ? await settlePhase(
                identity,
                watcher,
                desired,
                writeInput,
                timeoutMs,
                'LATE_REVERTED',
              )
            : delay === 'aborted'
              ? 'ABORTED'
              : delay === 'timeout'
                ? 'VERIFY_TIMEOUT'
                : 'LATE_REVERTED';
        }
        if (failure !== null) {
          // A failed host hook may itself begin submission before throwing.
          // PREFILLED performs no compensation, but it must still surface the
          // fresh session fence so a future runner aborts the remaining plan.
          const failedFence = readFence(writeInput);
          if (failedFence !== null) failure = failedFence;
        } else {
          failure = proofAfterFence(
            identity,
            watcher,
            desired,
            writeInput,
            'LATE_REVERTED',
          );
        }
        watcher.dispose();
        return failure === null
          ? {
              ok: true,
              value: { disposition: 'PREFILLED', selectedOptionId: writeInput.optionId, undo: null },
            }
          : { ok: false, code: failure };
      }

      const authorityFailure = checkFillAuthority(writeInput);
      if (authorityFailure !== null) {
        watcher.dispose();
        return { ok: false, code: authorityFailure };
      }
      const initialFence = proofAfterFence(
        identity,
        watcher,
        before,
        writeInput,
        'IDENTITY_CHANGED',
      );
      if (initialFence !== null) {
        watcher.dispose();
        return { ok: false, code: initialFence };
      }
      // executionFence is caller code and may revoke authority while returning
      // null. Re-check immediately before the first host mutation.
      const finalSetterAuthority = checkFillAuthority(writeInput);
      if (finalSetterAuthority !== null) {
        watcher.dispose();
        return { ok: false, code: finalSetterAuthority };
      }
      try {
        identity.access.set(desired);
      } catch {
        watcher.dispose();
        return { ok: false, code: 'WRITE_REVERTED' };
      }
      let failure = semanticProof(identity, watcher, desired, 'WRITE_REVERTED');
      if (failure === null) failure = checkFillAuthority(writeInput);
      if (failure === null && !watcher.dispatch('input')) failure = 'ABORTED';
      if (failure === null) {
        failure = proofAfterFence(identity, watcher, desired, writeInput, 'VALUE_COERCED');
      }
      if (failure === null) failure = checkFillAuthority(writeInput);
      if (failure === null && !watcher.dispatch('change')) failure = 'ABORTED';
      if (failure === null) {
        failure = proofAfterFence(identity, watcher, desired, writeInput, 'VALUE_COERCED');
      }
      if (failure !== null) return finishFailure(failure);

      failure = await settlePhase(
        identity,
        watcher,
        desired,
        writeInput,
        timeoutMs,
        'VALUE_COERCED',
      );
      if (failure !== null) return finishFailure(failure);
      const postInitialSettleAuthority = checkFillAuthority(writeInput);
      if (postInitialSettleAuthority !== null) return finishFailure(postInitialSettleAuthority);
      const delay = await runBoundedStep(
        async (signal) => {
          if (writeInput.lateRecheckDelay) {
            await writeInput.lateRecheckDelay(writeInput.lateRecheckMs, signal);
          }
          await abortAwareDelay(writeInput.lateRecheckMs, signal);
        },
        timeoutMs,
        writeInput.signal,
      );
      if (delay !== 'ok') {
        return finishFailure(
          delay === 'aborted'
            ? 'ABORTED'
            : delay === 'timeout'
              ? 'VERIFY_TIMEOUT'
              : 'LATE_REVERTED',
        );
      }
      const postDelayAuthority = checkFillAuthority(writeInput);
      if (postDelayAuthority !== null) return finishFailure(postDelayAuthority);
      failure = await settlePhase(
        identity,
        watcher,
        desired,
        writeInput,
        timeoutMs,
        'LATE_REVERTED',
      );
      if (failure !== null) return finishFailure(failure);
      const postLateSettleAuthority = checkFillAuthority(writeInput);
      if (postLateSettleAuthority !== null) return finishFailure(postLateSettleAuthority);
      const finalFence = proofAfterFence(
        identity,
        watcher,
        desired,
        writeInput,
        'LATE_REVERTED',
      );
      if (finalFence !== null) return finishFailure(finalFence);
      const finalAuthority = checkFillAuthority(writeInput);
      if (finalAuthority !== null) return finishFailure(finalAuthority);

      return {
        ok: true,
        value: {
          disposition: 'FILLED',
          selectedOptionId: writeInput.optionId,
          undo: createSemanticUndo({
            identity,
            watcher,
            before,
            written: desired,
            write: writeInput,
          }),
        },
      };
    },
  });
  return { ok: true, value: transaction };
}

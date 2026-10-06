/**
 * Content-local UA-5 ownership for the narrow connected-development writer.
 *
 * The only supported forward mutation is one empty, ordinary input/textarea.
 * Exact Elements and Data-L1 values live only in this object; neither can cross
 * the runtime response, terminal ledger, logs, storage, telemetry, or Panel.
 */

import {
  parsePilotUa5ProfileBinding,
  type PilotUa5ProfileBinding,
  type PilotUa5ProfilePayloadEntry,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { PILOT_UA1_MAX_CONTROLS } from '@edaix/contracts/draft';
import type { ApplyErrorCode } from '@edaix/apply-kernel/contracts';
import {
  type PilotUa4CompiledQuestion,
  type PilotUa4LeafPlan,
  type PilotUa4OwnedUndo,
} from '@edaix/apply-kernel/pilotUa4Writer';
import {
  classifyHostValidation,
  type HostValidationSignals,
} from '@edaix/apply-kernel/verify';
import {
  prepareNativeSelectSemanticTransaction,
  type NativeSelectSemanticTransaction,
} from '@edaix/apply-kernel/nativeSelectSemanticTransaction';
import {
  prepareChoiceGroup,
  type ChoiceAnswer,
  type ChoiceGroup,
} from '@edaix/apply-kernel/choiceGroup';
import { resolveSelectOption } from '@edaix/apply-kernel/setValue';
import { prepareComboboxFillOnly } from '@edaix/apply-kernel/comboboxFillOnly';
import { prepareNativeDateFillOnly } from '@edaix/apply-kernel/nativeDateFillOnly';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';
import type { PilotUa1PageBinding } from '@edaix/contracts/draft';
import {
  executeTextFillOnlyWrite,
  type TextFillOnlyResult,
  createTextSemanticTargetAuthority,
  createTextSemanticWriteAuthority,
  disposeTextSemanticTargetAuthority,
  invalidateTextSemanticWriteAuthority,
  settleTextSemanticWrite,
  type TextSemanticSettlementInput,
  type TextSemanticSettlementResult,
  type TextSemanticTargetAuthority,
  type TextSemanticTransaction,
  type TextSemanticUndoOwnership,
  type TextSemanticUndoTransfer,
  type TextSemanticWriteAuthority,
  type TextTargetState,
} from '@edaix/apply-kernel/textSemanticSettlement';
import type { PilotUa1LiveObservation } from './pilotUa1DiscoveryRuntime';
import type { PilotUa5LeafWriteAuthorization } from './pilotUa5ConnectedProtocol';
import {
  createPilotUa4LeafHostExecutor,
  createPilotUa4WriterRuntime,
  type PilotUa4WriterRuntime,
  type PilotUa4WriterRuntimeInput,
  type PilotUa4WriterRuntimeResult,
} from './pilotUa4WriterRuntime';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SAFE_SCALAR_LENGTH = 320;
const DEFAULT_LATE_RECHECK_MS = 250;

/**
 * There is no browser primitive that observes every `value` transition.
 * MutationObserver does not observe WebIDL property writes, and the page can
 * call a previously captured native value setter without dispatching an event.
 * Endpoint reads therefore cannot distinguish expected from
 * expected -> other -> expected (ABA). Patching an instance/prototype is not a
 * proof because that captured native setter bypasses the patch and mutating a
 * host prototype is itself outside this writer's authority.
 *
 * Keep the legacy restoration lane fail closed until a browser-backed witness
 * exists. The separately authorized FILL_ONLY lane claims current endpoint
 * verification and no restoration ownership. PREFILLED remains read-only.
 */
const EVENTLESS_VALUE_TRANSITION_WITNESS_AVAILABLE = false;

type TextControl = HTMLInputElement | HTMLTextAreaElement;
type ValidationControl = TextControl | HTMLSelectElement;

export interface PilotUa5LiveContentSessionInput {
  readonly enabled: boolean;
  readonly document?: Document;
  readonly view?: Window;
  readonly location?: Location;
  /** Monotonic high-water clock used only for forward-write expiry fencing. */
  readonly now?: () => number;
  /** Absolute build cutoff. Required by the exact-canary forward writer. */
  readonly writeNotAfterMs?: number;
  readonly lateRecheckMs?: number;
  readonly operationTimeoutMs?: number;
  readonly readHostValidation?: (target: ValidationControl) => HostValidationSignals;
  readonly settle?: TextSemanticSettlementInput['settle'];
  readonly lateRecheckDelay?: TextSemanticSettlementInput['lateRecheckDelay'];
  /**
   * FILL_ONLY is the current default-off connected lane; EXACT_CANARY_SETTER_ONLY
   * is a frozen synthetic legacy seam. Both use only the native value setter
   * and dispatch no host event that could trigger form submission.
   */
  readonly forwardWriteMode?: 'EXACT_CANARY_SETTER_ONLY' | 'FILL_ONLY';
  /** Fresh, value-free background authorization immediately before a setter. */
  readonly authorizeLeafWrite?: (input: Readonly<{
    questionId: string;
    binding: PilotUa1PageBinding;
  }>) => Promise<boolean | PilotUa5LeafWriteAuthorization>;
  /**
   * Independent proof over the original owner-bound answer/version, checked for
   * each forward setter after its leaf grant. Connected P1 obtains this from
   * the authenticated original-source comparison. A grant or TTL is not this proof.
   */
  readonly isProfileCurrent?: (expected: Readonly<{
    profileBinding: PilotUa5ProfileBinding;
    questionId: string;
    answerDigest: string;
  }>) => Promise<boolean>;
  /** Read-only capture of the canonical terminal before the existing registry cleanup. */
  readonly onTerminalLedger?: (observation: PilotUa1LiveObservation, result: PilotUa4WriterRuntimeResult) => boolean;
}

type BoundPayload = Pick<PilotUa5ProfilePayloadEntry, 'questionId' | 'answerDigest' | 'value'>;

function normalizedChoiceText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function exactChoiceOptionId(
  options: readonly Readonly<{ identityDigest: string; accessibleName: string }>[],
  value: string,
): string | null {
  const wanted = normalizedChoiceText(value);
  if (wanted.length === 0) return null;
  const matches = options.filter(
    (option) => normalizedChoiceText(option.accessibleName) === wanted,
  );
  return matches.length === 1 ? matches[0]!.identityDigest : null;
}

function canonicalBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' ? true : normalized === 'false' ? false : null;
}

function nativeValueAccess(target: TextControl): Readonly<{
  get: () => string | null;
  set: (value: string) => boolean;
}> | null {
  try {
    const prototype = target instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : null;
    if (prototype === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.get === undefined || descriptor.set === undefined) return null;
    return Object.freeze({
      get: () => {
        try {
          const value: unknown = descriptor.get!.call(target);
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      },
      set: (value: string) => {
        try {
          descriptor.set!.call(target, value);
          return true;
        } catch {
          return false;
        }
      },
    });
  } catch {
    return null;
  }
}

function nodeIsConnected(node: Node): boolean {
  try {
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')?.get;
    return getter !== undefined && getter.call(node) === true;
  } catch {
    return false;
  }
}

function defaultHostValidation(target: ValidationControl): HostValidationSignals {
  try {
    const getAttribute = (name: string) => Element.prototype.getAttribute.call(target, name);
    const describedBy = [getAttribute('aria-errormessage'), getAttribute('aria-describedby')]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .flatMap((value) => value.split(/\s+/u))
      .filter(Boolean);
    const errorText = describedBy
      .map((id) => target.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    return {
      ariaInvalid: getAttribute('aria-invalid'),
      willValidate: target.willValidate,
      valid: target.validity.valid,
      ...(errorText.length > 0 ? { errorText } : {}),
    };
  } catch {
    // An unreadable host verdict is unknown, which settlement fails closed.
    return {};
  }
}

function aggregateChoiceHostValidation(
  elements: readonly HTMLInputElement[],
  readHostValidation: (target: ValidationControl) => HostValidationSignals,
): HostValidationSignals {
  let allAccepted = elements.length > 0;
  for (const element of elements) {
    const verdict = classifyHostValidation(readHostValidation(element));
    if (verdict === 'rejected') return Object.freeze({ ariaInvalid: 'true' });
    if (verdict !== 'accepted') allAccepted = false;
  }
  return allAccepted
    ? Object.freeze({ ariaInvalid: 'false' })
    : Object.freeze({});
}

function eligibleNativeKind(
  target: Element,
  question: PilotUa4CompiledQuestion,
): target is TextControl {
  if (question.identityDigests.length !== 1) return false;
  if (question.controlKind === 'TEXT') {
    if (!(target instanceof HTMLInputElement)) return false;
  } else if (question.controlKind === 'TEXTAREA') {
    if (!(target instanceof HTMLTextAreaElement)) return false;
  } else {
    return false;
  }
  try {
    return target.disabled !== true && target.readOnly !== true;
  } catch {
    return false;
  }
}

function stableFailure(code: ApplyErrorCode): TextSemanticSettlementResult {
  return Object.freeze({ ok: false, code });
}

function createForwardTextTransaction(input: Readonly<{
  target: TextControl;
  expected: string;
  previous: string;
  registryCurrent: () => boolean;
  document: Document;
  documentRoot: Element;
  view: Window;
  location: Location;
  exactHref: string;
  signal: AbortSignal;
  lateRecheckMs: number;
  operationTimeoutMs?: number;
  readHostValidation: (target: TextControl) => HostValidationSignals;
  settle?: TextSemanticSettlementInput['settle'];
  lateRecheckDelay?: TextSemanticSettlementInput['lateRecheckDelay'];
  authorizeWrite: () => Promise<boolean>;
  writeTimeCurrent: () => boolean;
}>): Readonly<{ execute: () => Promise<TextSemanticSettlementResult> }> | null {
  const access = nativeValueAccess(input.target);
  if (access === null || access.get() !== input.previous) return null;
  const targetAuthority = createTextSemanticTargetAuthority(input.target);
  if (targetAuthority === null) return null;

  let writeAuthority: TextSemanticWriteAuthority | null = null;
  let owner: 'PREWRITE' | 'TRANSACTION' | 'UNDO' | 'RESTORED' | 'DISPOSED' = 'PREWRITE';
  let prepared = false;
  let externallyInvalidated = false;
  let userEditGeneration = 0;
  let executed = false;

  const targetState = (): TextTargetState => {
    try {
      if (!nodeIsConnected(input.target)) return 'DETACHED';
      if (
        input.target.ownerDocument !== input.document ||
        input.document.documentElement !== input.documentRoot ||
        input.view.top !== input.view.self ||
        input.location.href !== input.exactHref ||
        !input.registryCurrent()
      ) return 'REPLACED';
      return 'CURRENT';
    } catch {
      return 'REPLACED';
    }
  };
  const ownsWrittenState = () =>
    !externallyInvalidated &&
    targetState() === 'CURRENT' &&
    access.get() === input.expected;
  const ownsPreWriteState = () =>
    !externallyInvalidated &&
    targetState() === 'CURRENT' &&
    access.get() === input.previous;

  const dispose = () => {
    if (owner === 'DISPOSED') return;
    owner = 'DISPOSED';
    prepared = false;
    try { input.target.removeEventListener('beforeinput', onExternalValueEvent, true); } catch { /* retired */ }
    try { input.target.removeEventListener('input', onExternalValueEvent, true); } catch { /* retired */ }
    try { input.target.removeEventListener('change', onExternalValueEvent, true); } catch { /* retired */ }
    try { input.view.removeEventListener('pagehide', onNavigation, true); } catch { /* retired */ }
    try { input.view.removeEventListener('beforeunload', onNavigation, true); } catch { /* retired */ }
  };
  const invalidate = (kind: 'VALUE_TRANSITION' | 'USER_EDIT' | 'OWNERSHIP_REVOKED') => {
    externallyInvalidated = true;
    if (kind === 'USER_EDIT') userEditGeneration += 1;
    if (writeAuthority !== null) invalidateTextSemanticWriteAuthority(writeAuthority, { kind });
  };
  function onExternalValueEvent(event: Event): void {
    if (owner === 'DISPOSED') return;
    invalidate(event.isTrusted ? 'USER_EDIT' : 'VALUE_TRANSITION');
  }
  function onNavigation(): void {
    if (owner === 'DISPOSED') return;
    if (writeAuthority !== null) {
      invalidateTextSemanticWriteAuthority(writeAuthority, {
        kind: 'EXECUTION_STOP',
        code: 'IDENTITY_CHANGED',
      });
    }
  }

  const restore = (expectedOwner: 'TRANSACTION' | 'UNDO'): boolean => {
    if (
      owner !== expectedOwner || externallyInvalidated ||
      !ownsWrittenState()
    ) return false;
    // Forward cancellation blocks every future setter through executionFence,
    // but it must not destroy an already-sealed exact-owned compensator. Page,
    // element, value and trusted-edit ownership are still re-proved above.
    // Spend ownership before host callbacks; raw ABA cannot re-arm it.
    owner = 'RESTORED';
    prepared = false;
    if (!access.set(input.previous)) {
      dispose();
      return false;
    }
    if (!ownsPreWriteState()) {
      externallyInvalidated = true;
      return false;
    }
    return true;
  };

  try {
    input.target.addEventListener('beforeinput', onExternalValueEvent, true);
    input.target.addEventListener('input', onExternalValueEvent, true);
    input.target.addEventListener('change', onExternalValueEvent, true);
    input.view.addEventListener('pagehide', onNavigation, true);
    input.view.addEventListener('beforeunload', onNavigation, true);
  } catch {
    dispose();
    disposeTextSemanticTargetAuthority(targetAuthority);
    return null;
  }

  const transaction: TextSemanticTransaction = Object.freeze({
    targetAuthority,
    writeUserEditGeneration: 0,
    userEditGeneration: () => userEditGeneration,
    targetState,
    wasUserEdited: () => externallyInvalidated,
    isAtPreWriteState: () => owner === 'PREWRITE' && ownsPreWriteState(),
    isAtWrittenState: (writtenValue: string) =>
      (owner === 'TRANSACTION' || prepared) &&
      writtenValue === input.expected &&
      ownsWrittenState(),
    captureWrittenState: (
      writtenValue: string,
      publishPrepared: (transfer: TextSemanticUndoTransfer) => void,
    ) => {
      if (owner !== 'TRANSACTION' || prepared || writtenValue !== input.expected || !ownsWrittenState()) {
        return;
      }
      prepared = true;
      const undo: TextSemanticUndoOwnership = Object.freeze({
        targetAuthority,
        writeUserEditGeneration: 0,
        userEditGeneration: () => userEditGeneration,
        targetState,
        wasUserEdited: () => externallyInvalidated,
        isAtWrittenState: () =>
          (prepared || owner === 'UNDO') && ownsWrittenState(),
        restorePreWrite: () => restore('UNDO'),
        isAtPreWriteState: () => owner === 'RESTORED' && ownsPreWriteState(),
        dispose,
      });
      let spent = false;
      publishPrepared(Object.freeze({
        undo,
        commit: () => {
          if (spent || !prepared || owner !== 'TRANSACTION' || !ownsWrittenState()) return false;
          spent = true;
          prepared = false;
          owner = 'UNDO';
          return true;
        },
        cancel: () => {
          if (spent) return;
          spent = true;
          prepared = false;
        },
      }));
    },
    restorePreWriteFromWrittenState: (writtenValue: string) =>
      writtenValue === input.expected && restore('TRANSACTION'),
    dispose,
  });

  writeAuthority = createTextSemanticWriteAuthority(targetAuthority, transaction, {
    previous: input.previous,
    expected: input.expected,
  });
  if (writeAuthority === null) {
    dispose();
    disposeTextSemanticTargetAuthority(targetAuthority);
    return null;
  }
  const authority = writeAuthority;

  const executionFence = (): ApplyErrorCode | null => {
    if (input.signal.aborted) return 'ABORTED';
    if (!input.writeTimeCurrent()) return 'ABORTED';
    if (targetState() !== 'CURRENT') return 'IDENTITY_CHANGED';
    return null;
  };

  return Object.freeze({
    async execute(): Promise<TextSemanticSettlementResult> {
      if (executed) return stableFailure('CAPABILITY_DISABLED');
      executed = true;
      const finishSettlement = async (): Promise<TextSemanticSettlementResult> => {
        try {
          return await settleTextSemanticWrite({
            writeAuthority: authority,
            readHostValidation: input.readHostValidation,
            executionFence,
            lateRecheckMs: input.lateRecheckMs,
            signal: input.signal,
            settle: input.settle,
            lateRecheckDelay: input.lateRecheckDelay,
            operationTimeoutMs: input.operationTimeoutMs,
          });
        } catch {
          dispose();
          disposeTextSemanticTargetAuthority(targetAuthority);
          return stableFailure('ABORTED');
        }
      };
      const before = executionFence();
      if (before !== null || owner !== 'PREWRITE' || !ownsPreWriteState()) {
        invalidateTextSemanticWriteAuthority(authority, {
          kind: 'EXECUTION_STOP',
          code: before ?? 'IDENTITY_CHANGED',
        });
        return finishSettlement();
      }

      let leafAuthorized = false;
      try { leafAuthorized = await input.authorizeWrite(); } catch { /* fail closed */ }
      const afterAuthorization = executionFence();
      if (
        !leafAuthorized || afterAuthorization !== null ||
        owner !== 'PREWRITE' || !ownsPreWriteState()
      ) {
        invalidateTextSemanticWriteAuthority(authority, {
          kind: 'EXECUTION_STOP',
          code: afterAuthorization ?? 'ABORTED',
        });
        return finishSettlement();
      }

      // This is deliberately the last observable check before the only host
      // setter. A delayed grant cannot spend authority after either deadline.
      const beforeSetter = executionFence();
      if (beforeSetter !== null) {
        invalidateTextSemanticWriteAuthority(authority, {
          kind: 'EXECUTION_STOP',
          code: beforeSetter,
        });
        return finishSettlement();
      }

      owner = 'TRANSACTION';
      if (!access.set(input.expected)) {
        invalidateTextSemanticWriteAuthority(authority, {
          kind: 'EXECUTION_STOP', code: 'WRITE_REVERTED',
        });
      }
      return finishSettlement();
    },
  });
}

// Captured in the content realm before caller hooks can participate in retirement.
const FILL_ONLY_DOCUMENT_ADD = typeof Document === 'undefined' ? null : Document.prototype.addEventListener;
const FILL_ONLY_DOCUMENT_REMOVE = typeof Document === 'undefined' ? null : Document.prototype.removeEventListener;
const FILL_ONLY_WINDOW_ADD = typeof window === 'undefined' ? null : window.addEventListener;
const FILL_ONLY_WINDOW_REMOVE = typeof window === 'undefined' ? null : window.removeEventListener;

/** Current fill-first lane. No restore function, journal, or host event dispatch. */
function createFillOnlyTextTransaction(input: Parameters<typeof createForwardTextTransaction>[0]) {
  return Object.freeze({
    async execute(): Promise<TextFillOnlyResult> {
      const access = nativeValueAccess(input.target);
      const targetAuthority = createTextSemanticTargetAuthority(input.target);
      if (access === null || targetAuthority === null) {
        if (targetAuthority !== null) disposeTextSemanticTargetAuthority(targetAuthority);
        return Object.freeze({ ok: false, code: 'IDENTITY_CHANGED' });
      }
      let edited = false;
      let navigated = false;
      let submitted = false;
      const onEdit = (event: Event) => { if (event.target === input.target) edited = true; };
      const onNavigate = () => { navigated = true; };
      const onSubmit = () => { submitted = true; };
      const revocation = (): ApplyErrorCode | null => {
        if (submitted) return 'HOST_SUBMITTED';
        if (edited || input.signal.aborted) return 'ABORTED';
        return navigated ? 'IDENTITY_CHANGED' : null;
      };
      for (const name of ['beforeinput', 'input', 'change']) input.document.addEventListener(name, onEdit, true);
      for (const name of ['pagehide', 'popstate', 'hashchange']) input.view.addEventListener(name, onNavigate, true);
      input.document.addEventListener('submit', onSubmit, true);
      let released = false;
      let releasedCleanly = true;
      const release = (): boolean => {
        if (released) return releasedCleanly;
        released = true;
        const listeners: ReadonlyArray<readonly [EventTarget, string, EventListener]> = [
          ...['beforeinput', 'input', 'change'].map((name) => [input.document, name, onEdit] as const),
          ...['pagehide', 'popstate', 'hashchange'].map((name) => [input.view, name, onNavigate] as const),
          [input.document, 'submit', onSubmit],
        ];
        // Later removals may emit events whose ordinary listener was already
        // removed. Temporary guards cover the entire caller-controlled cleanup;
        // captured intrinsic removal retires them without another caller hook.
        const guards = listeners.map(([target, name, listener]) =>
          [target, name, (event: Event) => listener(event)] as const);
        for (const [target, name, listener] of guards) {
          const add = target === input.document ? FILL_ONLY_DOCUMENT_ADD : FILL_ONLY_WINDOW_ADD;
          try {
            if (typeof add !== 'function') releasedCleanly = false;
            else Reflect.apply(add, target, [name, listener, true]);
          }
          catch { releasedCleanly = false; }
        }
        for (const [target, name, listener] of listeners) {
          try { target.removeEventListener(name, listener, true); }
          catch {
            releasedCleanly = false;
            // The caller hook may throw before removing the original listener.
            // Retire that same registration without reentering the failed hook.
            const remove = target === input.document ? FILL_ONLY_DOCUMENT_REMOVE : FILL_ONLY_WINDOW_REMOVE;
            try {
              if (typeof remove === 'function') Reflect.apply(remove, target, [name, listener, true]);
            }
            catch { releasedCleanly = false; }
          }
        }
        for (const [target, name, listener] of guards) {
          const remove = target === input.document ? FILL_ONLY_DOCUMENT_REMOVE : FILL_ONLY_WINDOW_REMOVE;
          try {
            if (typeof remove !== 'function') releasedCleanly = false;
            else Reflect.apply(remove, target, [name, listener, true]);
          }
          catch { releasedCleanly = false; }
        }
        return releasedCleanly;
      };
      const result = await executeTextFillOnlyWrite({
        target: targetAuthority, expected: input.expected,
        authorizeWrite: input.authorizeWrite,
        writeForward: () => access.set(input.expected),
        executionFence: () => {
          const before = revocation();
          if (before !== null) return before;
          const code = input.document.documentElement !== input.documentRoot ||
              input.location.href !== input.exactHref || !input.registryCurrent()
            ? 'IDENTITY_CHANGED'
            : input.writeTimeCurrent() ? null : 'CAPABILITY_DISABLED';
          // Registry/clock callbacks may dispatch submit, edit or navigation,
          // or abort the session, while still returning a successful result.
          return revocation() ?? code;
        },
        readHostValidation: () => input.readHostValidation(input.target),
        lateRecheckMs: input.lateRecheckMs, operationTimeoutMs: input.operationTimeoutMs,
        signal: input.signal, settle: input.settle, lateRecheckDelay: input.lateRecheckDelay,
      });
      if (!result.ok) { release(); return result; }
      return Object.freeze({ ok: true, observation: Object.freeze({
        check: result.observation.check,
        finalize: () => {
          const code = result.observation.finalize(release);
          // Include cleanup-time events in the verdict after the kernel's last
          // readback. Missing or failed consumer retirement cannot prove success.
          return revocation() ?? (released && releasedCleanly ? code : 'HOST_REJECTED');
        },
        dispose: () => { result.observation.dispose(); release(); },
      }) });
    },
  });
}

type FillOnlyPageInput = Readonly<{
  document: Document;
  documentRoot: Element;
  view: Window;
  location: Location;
  exactHref: string;
  signal: AbortSignal;
  registryCurrent: () => boolean;
  writeTimeCurrent: () => boolean;
  revokeForward: () => void;
}>;

/**
 * Page/session fence shared by event-publishing fill-only controls. Their
 * kernel transactions own exact target-event provenance; this wrapper owns
 * Submit, navigation, registry generation, cancellation, and deadline.
 */
async function executeSemanticFillOnlyOnPage(
  input: FillOnlyPageInput,
  run: (executionFence: () => ApplyErrorCode | null) => Promise<TextFillOnlyResult>,
): Promise<TextFillOnlyResult> {
  let navigated = false;
  let submitted = false;
  const onNavigate = () => { navigated = true; input.revokeForward(); };
  const onSubmit = () => { submitted = true; input.revokeForward(); };
  const revocation = (): ApplyErrorCode | null => {
    if (submitted) return 'HOST_SUBMITTED';
    if (input.signal.aborted) return 'ABORTED';
    return navigated ? 'IDENTITY_CHANGED' : null;
  };
  const executionFence = (): ApplyErrorCode | null => {
    const before = revocation();
    if (before !== null) return before;
    let code: ApplyErrorCode | null = null;
    try {
      code = input.document.documentElement !== input.documentRoot ||
          input.location.href !== input.exactHref || !input.registryCurrent()
        ? 'IDENTITY_CHANGED'
        : input.writeTimeCurrent() ? null : 'CAPABILITY_DISABLED';
    } catch {
      code = 'IDENTITY_CHANGED';
    }
    return revocation() ?? code;
  };

  const listeners: ReadonlyArray<readonly [EventTarget, string, EventListener]> = [
    ...['pagehide', 'popstate', 'hashchange'].map(
      (name) => [input.view, name, onNavigate] as const,
    ),
    [input.document, 'submit', onSubmit],
  ];
  let released = false;
  let releasedCleanly = true;
  const release = (): boolean => {
    if (released) return releasedCleanly;
    released = true;
    const guards = listeners.map(([target, name, listener]) =>
      [target, name, (event: Event) => listener(event)] as const);
    for (const [target, name, listener] of guards) {
      const add = target === input.document ? FILL_ONLY_DOCUMENT_ADD : FILL_ONLY_WINDOW_ADD;
      try {
        if (typeof add !== 'function') releasedCleanly = false;
        else Reflect.apply(add, target, [name, listener, true]);
      } catch { releasedCleanly = false; }
    }
    for (const [target, name, listener] of listeners) {
      try { target.removeEventListener(name, listener, true); }
      catch {
        releasedCleanly = false;
        const remove = target === input.document ? FILL_ONLY_DOCUMENT_REMOVE : FILL_ONLY_WINDOW_REMOVE;
        try {
          if (typeof remove === 'function') Reflect.apply(remove, target, [name, listener, true]);
        } catch { releasedCleanly = false; }
      }
    }
    for (const [target, name, listener] of guards) {
      const remove = target === input.document ? FILL_ONLY_DOCUMENT_REMOVE : FILL_ONLY_WINDOW_REMOVE;
      try {
        if (typeof remove !== 'function') releasedCleanly = false;
        else Reflect.apply(remove, target, [name, listener, true]);
      } catch { releasedCleanly = false; }
    }
    return releasedCleanly;
  };

  try {
    for (const [target, name, listener] of listeners) {
      target.addEventListener(name, listener, true);
    }
  } catch {
    release();
    return Object.freeze({ ok: false, code: revocation() ?? 'CAPABILITY_DISABLED' });
  }

  let result: TextFillOnlyResult;
  try {
    result = await run(executionFence);
  } catch {
    release();
    return Object.freeze({ ok: false, code: revocation() ?? 'ABORTED' });
  }
  if (!result.ok) {
    release();
    const code = revocation();
    return code === null ? result : Object.freeze({
      ok: false,
      code,
      ...(result.writeEffect ? { writeEffect: result.writeEffect } : {}),
    });
  }
  return Object.freeze({
    ok: true,
    observation: Object.freeze({
      check: result.observation.check,
      finalize: () => {
        const code = result.observation.finalize(release);
        return revocation() ?? (released && releasedCleanly ? code : 'HOST_REJECTED');
      },
      dispose: () => { result.observation.dispose(); release(); },
    }),
  });
}

function writerFailure(
  code: 'PILOT_CAPABILITY_DISABLED' | 'PILOT_TARGET_DRIFT',
): PilotUa4WriterRuntimeResult {
  return Object.freeze({ ok: false, code });
}

function asTextUndo(undo: PilotUa4OwnedUndo): TextSemanticUndoOwnership | null {
  try {
    return (
      'restorePreWrite' in undo && typeof undo.restorePreWrite === 'function' &&
      'isAtWrittenState' in undo && typeof undo.isAtWrittenState === 'function' &&
      'isAtPreWriteState' in undo && typeof undo.isAtPreWriteState === 'function' &&
      'targetState' in undo && typeof undo.targetState === 'function' &&
      'wasUserEdited' in undo && typeof undo.wasUserEdited === 'function' &&
      'userEditGeneration' in undo && typeof undo.userEditGeneration === 'function' &&
      'writeUserEditGeneration' in undo &&
      'targetAuthority' in undo
    ) ? undo as TextSemanticUndoOwnership : null;
  } catch {
    return null;
  }
}

/**
 * The session hands its caller a consuming Undo: either restore outcome is
 * terminal and therefore always releases the raw kernel facade, its target
 * authority, and the content-owned host/navigation listeners before return.
 */
function consumingTextUndo(undo: TextSemanticUndoOwnership): TextSemanticUndoOwnership {
  // The kernel facade already owns one-shot restoration and disposed predicates.
  // This boundary only guarantees release after the caller's targeted attempt.
  return Object.freeze({
    ...undo,
    restorePreWrite: () => {
      try { return undo.restorePreWrite() === true; }
      catch { return false; }
      finally { undo.dispose(); }
    },
  });
}

/**
 * Owns one observation → payload binding → UA-4 writer run. Completion clears
 * the live registry and both Data-L1 maps. Fill-first retains no Undo; the
 * frozen legacy test seam alone can retain its exact Undo ownership.
 */
export function createPilotUa5LiveContentSession(
  input: PilotUa5LiveContentSessionInput,
) {
  const doc = input.document ?? document;
  const view = input.view ?? window;
  const loc = input.location ?? location;
  const readHostValidation = input.readHostValidation ?? defaultHostValidation;
  const lateRecheckMs = input.lateRecheckMs ?? DEFAULT_LATE_RECHECK_MS;
  const now = input.now ?? Date.now;
  const writeNotAfterMs = input.writeNotAfterMs;
  let writeTimeHighWaterMs: number | null = null;
  let forwardRevoked = false;
  // A later Profile mismatch revokes future writes, not an earlier leaf's
  // read-only observation. Page, clock, edit and submit fences still apply.
  let profileForwardRevoked = false;
  let grantWriteNotAfterMs: number | null = null;
  const writeDeadlineConfigured = Number.isSafeInteger(writeNotAfterMs) &&
    Number(writeNotAfterMs) > 0;
  const currentTime = (): number | null => {
    try {
      const value = now();
      if (!Number.isSafeInteger(value) || value < 0 ||
          (writeTimeHighWaterMs !== null && value < writeTimeHighWaterMs)) {
        forwardRevoked = true;
        return null;
      }
      writeTimeHighWaterMs = value;
      return value;
    } catch {
      forwardRevoked = true;
      return null;
    }
  };
  const writeTimeCurrent = (): boolean => {
    const time = currentTime();
    if (time === null || forwardRevoked || !writeDeadlineConfigured ||
        time >= Math.min(Number(writeNotAfterMs), grantWriteNotAfterMs ?? Number(writeNotAfterMs))) {
      forwardRevoked = true;
      return false;
    }
    return true;
  };
  let live: PilotUa1LiveObservation | null = null;
  let disposed = false;
  let aborted = false;
  let runInFlight = false;
  let runController: AbortController | null = null;
  const payloadByRef = new Map<string, BoundPayload>();
  const refByQuestion = new Map<string, string>();
  let profileBinding: PilotUa5ProfileBinding | null = null;

  const clearPayloads = () => {
    payloadByRef.clear();
    refByQuestion.clear();
    profileBinding = null;
  };
  const resolver = Object.freeze({
    resolve(question: PilotUa4CompiledQuestion): PilotUa4LeafPlan | null {
      const current = live;
      const expectedProfile = profileBinding;
      if (disposed || profileForwardRevoked || !runInFlight || current === null || !current.registry.isCurrent()) return null;
      const expectedRef = refByQuestion.get(question.questionId);
      const payload = payloadByRef.get(question.payloadRef);
      if (
        expectedRef !== question.payloadRef || payload === undefined ||
        payload.questionId !== question.questionId ||
        payload.answerDigest !== question.answerDigest
      ) return null;

      const semanticFillOnly = input.forwardWriteMode === 'FILL_ONLY' &&
        question.undoPolicy === 'FROZEN' &&
        typeof input.authorizeLeafWrite === 'function' && writeDeadlineConfigured;
      if (
        semanticFillOnly &&
        (question.controlKind === 'NATIVE_SELECT' ||
          question.controlKind === 'COMBOBOX' ||
          question.controlKind === 'RADIO_GROUP' ||
          question.controlKind === 'CHECKBOX_GROUP' ||
          question.controlKind === 'DATE')
      ) {
        const controller = runController;
        const documentRoot = doc.documentElement;
        if (controller === null || documentRoot === null) return null;
        const packetControls = current.observation.packet.controls;
        const structureEntries = current.observation.structure?.entries;
        if (structureEntries === undefined) return null;
        const members: Array<Readonly<{
          identityDigest: string;
          elementToken: string;
          element: Element;
          packet: (typeof packetControls)[number];
        }>> = [];
        for (const identityDigest of question.identityDigests) {
          const packetMatches = packetControls.filter(
            (control) => control.identityDigest === identityDigest,
          );
          const entryMatches = structureEntries.filter(
            (entry) => entry.identityDigest === identityDigest,
          );
          if (packetMatches.length !== 1 || entryMatches.length !== 1) return null;
          const entry = entryMatches[0]!;
          if (entry.disabled || entry.readOnly || entry.multiple) return null;
          const element = current.registry.resolveForWrite({
            identityDigest,
            elementToken: entry.elementToken,
          });
          if (element === null) return null;
          members.push(Object.freeze({
            identityDigest,
            elementToken: entry.elementToken,
            element,
            packet: packetMatches[0]!,
          }));
        }
        const registryCurrent = () => current.registry.isCurrent() && members.every((member) =>
          current.registry.resolveForWrite({
            identityDigest: member.identityDigest,
            elementToken: member.elementToken,
          }) === member.element);
        const authorizeWrite = async (): Promise<boolean> => {
          if (profileForwardRevoked) return false;
          const authorization = await input.authorizeLeafWrite!({
            questionId: question.questionId,
            binding: current.observation.packet.binding,
          });
          if (authorization !== true) {
            if (authorization === false || authorization.allowed !== true ||
                !Number.isSafeInteger(authorization.writeNotAfterMs) ||
                authorization.writeNotAfterMs <= 0) return false;
            grantWriteNotAfterMs = Math.min(
              grantWriteNotAfterMs ?? Infinity,
              authorization.writeNotAfterMs,
            );
          }
          let profileCurrent = false;
          try {
            profileCurrent = expectedProfile !== null && await input.isProfileCurrent?.(Object.freeze({
              profileBinding: expectedProfile,
              questionId: question.questionId,
              answerDigest: payload.answerDigest,
            })) === true;
          } catch { profileCurrent = false; }
          if (!profileCurrent) profileForwardRevoked = true;
          return profileCurrent;
        };
        const pageInput: FillOnlyPageInput = Object.freeze({
          document: doc,
          documentRoot,
          view,
          location: loc,
          exactHref: loc.href,
          signal: controller.signal,
          registryCurrent,
          writeTimeCurrent,
          revokeForward: () => { forwardRevoked = true; },
        });

        if (question.controlKind === 'DATE') {
          if (
            members.length !== 1 ||
            !(members[0]!.element instanceof HTMLInputElement) ||
            (members[0]!.packet.inputType !== 'date' &&
              members[0]!.packet.inputType !== 'month') ||
            members[0]!.element.type !== members[0]!.packet.inputType
          ) return null;
          const target = members[0]!.element;
          const transaction = prepareNativeDateFillOnly({
            target,
            expected: payload.value,
            exactTargetCurrent: registryCurrent,
          });
          if (transaction === null) return null;
          if (transaction.isAtAnswer()) {
            return Object.freeze({
              kind: 'PREFILLED',
              readCurrentSemantic: transaction.isAtAnswer,
            });
          }
          if (!transaction.isEmpty()) return null;
          return Object.freeze({
            kind: 'SEMANTIC_FILL_ONLY',
            control: 'DATE',
            execute: () => executeSemanticFillOnlyOnPage(pageInput, (executionFence) =>
              transaction.fillOnly({
                authorizeWrite,
                executionFence,
                readHostValidation: (element) => readHostValidation(element),
                lateRecheckMs,
                operationTimeoutMs: input.operationTimeoutMs,
                signal: controller.signal,
                settle: input.settle,
                lateRecheckDelay: input.lateRecheckDelay,
              })),
          });
        }

        if (question.controlKind === 'NATIVE_SELECT') {
          if (members.length !== 1 || !(members[0]!.element instanceof HTMLSelectElement)) return null;
          const select = members[0]!.element;
          const packetOptions = members[0]!.packet.options;
          let domOptions: readonly HTMLOptionElement[];
          try { domOptions = [...select.options]; } catch { return null; }
          if (domOptions.length === 0 || domOptions.length !== packetOptions.length) return null;
          const prepared = prepareNativeSelectSemanticTransaction({
            select,
            options: domOptions.map((element, index) => Object.freeze({
              element,
              optionId: packetOptions[index]!.identityDigest,
            })),
          });
          if (!prepared.ok) return null;
          const transaction: NativeSelectSemanticTransaction = prepared.value;
          const structure = structureEntries.find(
            (entry) => entry.identityDigest === members[0]!.identityDigest,
          )!;
          const placeholders = new Set(structure.placeholderOptionIndexes);
          const candidateIndexes = domOptions.flatMap(
            (_option, index) => placeholders.has(index) ? [] : [index],
          );
          const resolution = resolveSelectOption(
            candidateIndexes.map((index) => ({
              value: domOptions[index]!.value,
              text: domOptions[index]!.text,
            })),
            payload.value,
          );
          if (resolution === 'NO_OPTION_MATCH' || resolution === 'AMBIGUOUS_OPTION') return null;
          const desiredIndex = candidateIndexes[resolution.index];
          if (desiredIndex === undefined) return null;
          const optionId = packetOptions[desiredIndex]!.identityDigest;
          const emptyOptionIds = structure.placeholderOptionIndexes.map(
            (index) => packetOptions[index]?.identityDigest,
          ).filter((id): id is string => id !== undefined);
          if (transaction.isSelected(optionId)) {
            return Object.freeze({
              kind: 'PREFILLED',
              readCurrentSemantic: () => registryCurrent() && transaction.isSelected(optionId),
            });
          }
          if (!transaction.isEmpty(emptyOptionIds)) return null;
          return Object.freeze({
            kind: 'SEMANTIC_FILL_ONLY',
            control: 'NATIVE_SELECT',
            execute: () => executeSemanticFillOnlyOnPage(pageInput, (executionFence) =>
              transaction.fillOnly({
                optionId,
                emptyOptionIds,
                authorizeWrite,
                executionFence,
                readHostValidation: (target) => readHostValidation(target),
                lateRecheckMs,
                operationTimeoutMs: input.operationTimeoutMs,
                signal: controller.signal,
                settle: input.settle,
                lateRecheckDelay: input.lateRecheckDelay,
              })),
          });
        }

        if (question.controlKind === 'COMBOBOX') {
          if (members.length !== 1 || !(members[0]!.element instanceof HTMLInputElement)) {
            return null;
          }
          const member = members[0]!;
          const trigger = member.element as HTMLInputElement;
          const optionId = exactChoiceOptionId(member.packet.options, payload.value);
          if (optionId === null) return null;
          const exactIdentity = Object.freeze({
            identityDigest: member.identityDigest,
            elementToken: member.elementToken,
          });
          const optionSet = current.registry.resolveOptionsForWrite(exactIdentity);
          if (
            optionSet === null || optionSet.options.length !== member.packet.options.length ||
            !optionSet.options.every((option, index) =>
              option.identityDigest === member.packet.options[index]?.identityDigest)
          ) return null;
          const scanRoot = createScanRoot(documentRoot, []);
          const exactMembershipCurrent = (): boolean => {
            const fresh = current.registry.resolveOptionsForWrite(exactIdentity);
            return fresh !== null && fresh.container === optionSet.container &&
              fresh.options.length === optionSet.options.length &&
              fresh.options.every((option, index) =>
                option.identityDigest === optionSet.options[index]?.identityDigest &&
                option.element === optionSet.options[index]?.element);
          };
          const transaction = prepareComboboxFillOnly({
            trigger,
            optionContainer: optionSet.container,
            options: optionSet.options.map((option) => Object.freeze({
              optionId: option.identityDigest,
              element: option.element,
            })),
            root: scanRoot,
            exactMembershipCurrent,
          });
          if (transaction === null) return null;
          if (transaction.isSelected(optionId)) {
            return Object.freeze({
              kind: 'PREFILLED',
              readCurrentSemantic: () => transaction.isSelected(optionId),
            });
          }
          if (!transaction.isEmpty()) return null;
          const comboboxPageInput: FillOnlyPageInput = Object.freeze({
            ...pageInput,
            // The reviewed registry is expected to retire when the host marks
            // selection or collapses its popup. From that synchronous point
            // onward the transaction proves exact trigger/container/options
            // directly; it never rebinds selectors or a replacement node.
            registryCurrent: () => transaction.canRetireRegistry()
              ? transaction.exactTargetPresent()
              : registryCurrent(),
          });
          return Object.freeze({
            kind: 'SEMANTIC_FILL_ONLY',
            control: 'COMBOBOX',
            execute: () => executeSemanticFillOnlyOnPage(
              comboboxPageInput,
              (executionFence) => transaction.execute({
                optionId,
                authorizeWrite,
                executionFence,
                readHostValidation: (target) => readHostValidation(target),
                lateRecheckMs,
                operationTimeoutMs: input.operationTimeoutMs,
                signal: controller.signal,
                settle: input.settle,
                lateRecheckDelay: input.lateRecheckDelay,
              }),
            ),
          });
        }

        if (!members.every((member) => member.element instanceof HTMLInputElement)) return null;
        const groupEntries = question.identityDigests.map((identityDigest) =>
          structureEntries.find((entry) => entry.identityDigest === identityDigest)!);
        const groupKey = groupEntries[0]?.groupKeyDigest ?? null;
        if (groupKey === null || groupEntries.some((entry) => entry.groupKeyDigest !== groupKey)) return null;
        const prepared = prepareChoiceGroup({
          questionId: question.questionId,
          options: members.map((member) => Object.freeze({
            element: member.element as HTMLInputElement,
            optionId: member.identityDigest,
          })),
        });
        if (!prepared.ok) return null;
        const group: ChoiceGroup = prepared.value;
        let answer: ChoiceAnswer;
        if (question.controlKind === 'RADIO_GROUP') {
          const optionId = exactChoiceOptionId(members.map((member) => ({
            identityDigest: member.identityDigest,
            accessibleName: member.packet.accessibleName ?? member.packet.label ?? '',
          })), payload.value);
          if (optionId === null) return null;
          answer = Object.freeze({ kind: 'SINGLE_CHOICE', optionId });
        } else {
          // Scalar payloads can only describe one boolean checkbox. Typed
          // checkbox sets remain closed until their structured source exists.
          if (question.compilerControlKind !== 'CHECKBOX_SINGLE' || members.length !== 1) return null;
          const checked = canonicalBoolean(payload.value);
          if (checked === null) return null;
          if (!checked) {
            return group.isEmpty()
              ? Object.freeze({
                  kind: 'PREFILLED',
                  readCurrentSemantic: () => registryCurrent() && group.isEmpty(),
                })
              : null;
          }
          answer = Object.freeze({
            kind: 'MULTI_CHOICE',
            optionIds: Object.freeze([members[0]!.identityDigest]),
          });
        }
        if (group.isAtAnswer(answer)) {
          return Object.freeze({
            kind: 'PREFILLED',
            readCurrentSemantic: () => registryCurrent() && group.isAtAnswer(answer),
          });
        }
        if (!group.isEmpty()) return null;
        return Object.freeze({
          kind: 'SEMANTIC_FILL_ONLY',
          control: question.controlKind,
          execute: () => executeSemanticFillOnlyOnPage(pageInput, (executionFence) =>
            group.fillOnly({
              answer,
              authorizeWrite,
              executionFence,
              readHostValidation: (elements) =>
                aggregateChoiceHostValidation(elements, readHostValidation),
              lateRecheckMs,
              operationTimeoutMs: input.operationTimeoutMs,
              signal: controller.signal,
              settle: input.settle,
              lateRecheckDelay: input.lateRecheckDelay,
            })),
        });
      }

      if (question.identityDigests.length !== 1) return null;
      const identityDigest = question.identityDigests[0]!;
      const entries = current.observation.structure?.entries.filter(
        (entry) => entry.identityDigest === identityDigest,
      ) ?? [];
      if (entries.length !== 1) return null;
      const entry = entries[0]!;
      if (entry.disabled || entry.readOnly || entry.multiple) return null;
      // Profile resolution happened over the network after UA-1 first sight.
      // Repeat the whole bounded, selector-free UA-1 semantic scan now, before
      // every leaf decision, to catch CSSOM/geometry/honeypot drift while still
      // requiring the same exact Element and generation.
      const target = current.registry.resolveForWrite({
        identityDigest,
        elementToken: entry.elementToken,
      });
      if (target === null || !eligibleNativeKind(target, question)) return null;
      const valueAccess = nativeValueAccess(target);
      const previous = valueAccess?.get() ?? null;
      if (previous === null) return null;
      if (previous === payload.value) {
        return Object.freeze({
          kind: 'PREFILLED',
          readCurrentSemantic: () =>
            current.registry.isCurrent() &&
            current.registry.resolve({ identityDigest, elementToken: entry.elementToken }) === target &&
            nativeValueAccess(target)?.get() === payload.value,
        });
      }
      // The first connected-dev slice is fill-empty only. Never replace an
      // answer the person or host has already put in the field.
      if (previous !== '') return null;
      // Exact endpoint equality cannot prove that no eventless native-setter
      // ABA occurred. Without a monotonic witness, do not call any setter and
      // do not mint transaction/Undo ownership.
      const fillOnly = input.forwardWriteMode === 'FILL_ONLY' && question.undoPolicy === 'FROZEN' &&
        typeof input.authorizeLeafWrite === 'function' && writeDeadlineConfigured;
      if (input.forwardWriteMode === 'FILL_ONLY' && !fillOnly) return null;
      const canarySetterOnly = input.forwardWriteMode === 'EXACT_CANARY_SETTER_ONLY' &&
        typeof input.authorizeLeafWrite === 'function' &&
        writeDeadlineConfigured;
      if (!fillOnly && !EVENTLESS_VALUE_TRANSITION_WITNESS_AVAILABLE && !canarySetterOnly) return null;
      const controller = runController;
      const documentRoot = doc.documentElement;
      if (controller === null || documentRoot === null) return null;
      const expectedAnswerDigest = payload.answerDigest;
      const transactionInput: Parameters<typeof createForwardTextTransaction>[0] = {
        target,
        expected: payload.value,
        previous,
        registryCurrent: () =>
          current.registry.isCurrent() &&
          current.registry.resolveForWrite({
            identityDigest,
            elementToken: entry.elementToken,
          }) === target,
        document: doc,
        documentRoot,
        view,
        location: loc,
        exactHref: loc.href,
        signal: controller.signal,
        lateRecheckMs,
        operationTimeoutMs: input.operationTimeoutMs,
        readHostValidation,
        authorizeWrite: async () => {
          if (profileForwardRevoked) return false;
          const authorization = await input.authorizeLeafWrite!({
            questionId: question.questionId,
            binding: current.observation.packet.binding,
          });
          if (authorization !== true) {
            if (authorization === false || authorization.allowed !== true ||
                !Number.isSafeInteger(authorization.writeNotAfterMs) || authorization.writeNotAfterMs <= 0) return false;
            grantWriteNotAfterMs = Math.min(grantWriteNotAfterMs ?? Infinity, authorization.writeNotAfterMs);
          }
          let profileCurrent = false;
          try {
            profileCurrent = expectedProfile !== null && await input.isProfileCurrent?.(Object.freeze({
              profileBinding: expectedProfile, questionId: question.questionId, answerDigest: expectedAnswerDigest,
            })) === true;
          } catch { profileCurrent = false; }
          if (!profileCurrent) profileForwardRevoked = true;
          return profileCurrent;
        },
        writeTimeCurrent,
        settle: input.settle,
        lateRecheckDelay: input.lateRecheckDelay,
      };
      if (fillOnly) return Object.freeze({ kind: 'TEXT_FILL_ONLY', execute: createFillOnlyTextTransaction(transactionInput).execute });
      const transaction = createForwardTextTransaction(transactionInput);
      return transaction === null
        ? null
        : Object.freeze({ kind: 'TEXT_TRANSACTION', execute: transaction.execute });
    },
  });
  const executor = createPilotUa4LeafHostExecutor(resolver);
  const baseWriter = createPilotUa4WriterRuntime({ enabled: input.enabled }, executor);
  let terminalCaptured = false;
  const writer: PilotUa4WriterRuntime = Object.freeze({
    async execute(writerInput: PilotUa4WriterRuntimeInput): Promise<PilotUa4WriterRuntimeResult> {
      terminalCaptured = false;
      if (!input.enabled) return writerFailure('PILOT_CAPABILITY_DISABLED');
      if (
        disposed || aborted || runInFlight || live === null || !live.registry.isCurrent()
      ) return writerFailure('PILOT_TARGET_DRIFT');
      runInFlight = true;
      runController = new AbortController();
      try {
        // Fill-first failures preserve the host page. Earlier verified leaves
        // remain in the canonical ledger when a later gate closes.
        const result = await baseWriter.execute(writerInput);
        if (result.ok && live !== null && input.onTerminalLedger) {
          // Capture failure removes only the optional read-only checkpoint.
          // The already canonical write result and original cleanup are preserved.
          try { terminalCaptured = input.onTerminalLedger(live, result) === true; }
          catch { terminalCaptured = false; }
        }
        return result;
      } finally {
        runInFlight = false;
        runController = null;
        clearPayloads();
        if (!executor.hasOwnedUndo()) {
          live?.registry.dispose();
          live = null;
        }
      }
    },
  });

  return Object.freeze({
    didCaptureTerminal: () => terminalCaptured,
    observe(observation: PilotUa1LiveObservation): boolean {
      if (disposed || !input.enabled) {
        observation.registry.dispose();
        return false;
      }
      let current = false;
      try {
        current = observation.registry.isCurrent() &&
          observation.observation.structure !== null &&
          observation.observation.packet.binding.origin === loc.origin &&
          observation.observation.packet.binding.pathname === loc.pathname;
      } catch {
        current = false;
      }
      if (!current) {
        observation.registry.dispose();
        return false;
      }
      runController?.abort();
      live?.registry.dispose();
      executor.revokeUndo();
      clearPayloads();
      live = observation;
      return true;
    },
    bindPayloads(payloads: readonly PilotUa5ProfilePayloadEntry[], binding?: PilotUa5ProfileBinding): boolean {
      const boundProfile = parsePilotUa5ProfileBinding(binding);
      if (
        disposed || runInFlight || live === null || !live.registry.isCurrent() || boundProfile === null ||
        !Array.isArray(payloads) || payloads.length === 0 ||
        payloads.length > PILOT_UA1_MAX_CONTROLS
      ) {
        clearPayloads();
        return false;
      }
      const nextByRef = new Map<string, BoundPayload>();
      const nextByQuestion = new Map<string, string>();
      try {
        for (const payload of payloads) {
          if (
            typeof payload.questionId !== 'string' || !SAFE_ID.test(payload.questionId) ||
            typeof payload.payloadRef !== 'string' || !SAFE_ID.test(payload.payloadRef) ||
            typeof payload.answerDigest !== 'string' || !SHA256.test(payload.answerDigest) ||
            typeof payload.value !== 'string' || payload.value.length === 0 ||
            payload.value.length > MAX_SAFE_SCALAR_LENGTH ||
            nextByRef.has(payload.payloadRef) || nextByQuestion.has(payload.questionId)
          ) {
            clearPayloads();
            return false;
          }
          nextByRef.set(payload.payloadRef, Object.freeze({
            questionId: payload.questionId,
            answerDigest: payload.answerDigest,
            value: payload.value,
          }));
          nextByQuestion.set(payload.questionId, payload.payloadRef);
        }
      } catch {
        clearPayloads();
        return false;
      }
      clearPayloads();
      profileBinding = boundProfile;
      for (const [ref, payload] of nextByRef) payloadByRef.set(ref, payload);
      for (const [questionId, ref] of nextByQuestion) refByQuestion.set(questionId, ref);
      return true;
    },
    resolvePayloadRef(authorization: Readonly<{
      questionId: string;
      answerDigest: string;
    }>): string | null {
      if (disposed || runInFlight || live === null || !live.registry.isCurrent()) return null;
      try {
        const ref = refByQuestion.get(authorization.questionId);
        if (ref === undefined) return null;
        const payload = payloadByRef.get(ref);
        return payload !== undefined && payload.answerDigest === authorization.answerDigest
          ? ref
          : null;
      } catch {
        return null;
      }
    },
    currentTime,
    isCurrent: () => !disposed && live !== null && live.registry.isCurrent(),
    writer,
    takeUndo(questionId: string): TextSemanticUndoOwnership | null {
      const owned = executor.takeUndo(questionId);
      if (owned === null) return null;
      const textUndo = asTextUndo(owned);
      if (textUndo !== null) return consumingTextUndo(textUndo);
      // This session resolves only text leaves. A different ownership shape is
      // an impossible composition and must be revoked rather than leaked.
      try { owned.dispose(); } catch { /* revoked before returning */ }
      return null;
    },
    abort() {
      aborted = true;
      runController?.abort();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      runController?.abort();
      runController = null;
      runInFlight = false;
      clearPayloads();
      live?.registry.dispose();
      live = null;
      executor.dispose();
    },
  });
}

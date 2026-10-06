/**
 * Legacy text/textarea restoration settlement and the separate fill-first lane.
 * Legacy settlement requires an exact Undo seal. The explicit fill-first lane
 * below performs one content-owned setter and read-only verification, with no
 * restoration capability. Neither lane enables a production writer.
 */

import { APPLY_ERROR_CODES, type ApplyErrorCode } from '../contracts';
import {
  classifyHostValidation,
  settleAfterHostWrite,
  WRITE_VERIFICATION_TIMEOUT_MS,
  type HostValidationSignals,
} from './verify';

export type TextTargetState = 'CURRENT' | 'DETACHED' | 'REPLACED';

const TEXT_TARGET_AUTHORITY: unique symbol = Symbol('TextSemanticTargetAuthority');
const TEXT_WRITE_AUTHORITY: unique symbol = Symbol('TextSemanticWriteAuthority');
const ALLOWED_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url']);
const PROTECTED_TARGET_ATTRIBUTES = ['type', 'autocomplete', 'role', 'aria-haspopup', 'hidden'] as const;
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'webauthn',
]);
interface AbortSignalIntrinsics {
  readonly aborted: () => boolean;
  readonly add: (listener: () => void) => void;
  readonly remove: (listener: () => void) => void;
}

function readKnownPrototypeMember(
  prototype: object | null,
  property: 'aborted' | 'addEventListener' | 'removeEventListener',
  kind: 'getter' | 'method',
): ((...args: unknown[]) => unknown) | null {
  const seen = new Set<object>();
  while (prototype !== null && !seen.has(prototype)) {
    seen.add(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    const candidate = kind === 'getter' ? descriptor?.get : descriptor?.value;
    if (typeof candidate === 'function') return candidate;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

const ABORT_SIGNAL_INTRINSICS = new WeakMap<object, AbortSignalIntrinsics | null>();
const ABORT_SIGNAL_ABORTED_GETTER = typeof AbortSignal === 'undefined'
  ? null
  : readKnownPrototypeMember(AbortSignal.prototype, 'aborted', 'getter');
const EVENT_TARGET_ADD = typeof EventTarget === 'undefined'
  ? null
  : readKnownPrototypeMember(EventTarget.prototype, 'addEventListener', 'method');
const EVENT_TARGET_REMOVE = typeof EventTarget === 'undefined'
  ? null
  : readKnownPrototypeMember(EventTarget.prototype, 'removeEventListener', 'method');

/**
 * One-shot, pre-write proof that the exact live DOM node is an ordinary text
 * control. Runtime authority is held in a module-private WeakMap; structural
 * casts cannot mint it.
 */
export interface TextSemanticTargetAuthority {
  readonly [TEXT_TARGET_AUTHORITY]: true;
}

/** Pre-write binding between one target authority and one transaction. */
export interface TextSemanticWriteAuthority {
  readonly [TEXT_WRITE_AUTHORITY]: true;
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface TextTargetSignature {
  readonly localName: 'input' | 'textarea';
  readonly typeAttribute: string | null;
  readonly effectiveType: string;
  readonly autocomplete: string | null;
  readonly role: string | null;
  readonly ariaHasPopup: string | null;
  readonly hidden: boolean;
}

interface TextTargetRecord {
  readonly target: TextControl;
  readonly signature: TextTargetSignature;
  readonly observer: MutationObserver;
  readonly parent: Node;
  readonly previousSibling: ChildNode | null;
  readonly nextSibling: ChildNode | null;
  claimed: boolean;
  bound: boolean;
  closed: boolean;
  drifted: boolean;
  removed: boolean;
}

const TEXT_TARGET_RECORDS = new WeakMap<TextSemanticTargetAuthority, TextTargetRecord>();
interface TextWriteRecord {
  readonly targetAuthority: TextSemanticTargetAuthority;
  readonly targetRecord: TextTargetRecord;
  readonly transaction: TextSemanticTransaction;
  readonly previous: string;
  readonly expected: string;
  claimed: boolean;
  epoch: number;
  sealedEpoch: number | null;
  owner: 'TRANSACTION' | 'UNDO' | 'DISPOSED';
  undoOwner: TextSemanticUndoOwnership | null;
  committedRawTransfer: object | null;
  committedRawUndo: object | null;
  revoked: boolean;
  stopCode: ApplyErrorCode | null;
}
const TEXT_WRITE_RECORDS = new WeakMap<TextSemanticWriteAuthority, TextWriteRecord>();

/**
 * Monotonic events observed by the future controlled-host integration.
 *
 * The authorized forward setter is deliberately not an invalidation. Every
 * later value transition (including an ABA that returns before the first
 * read), trusted edit, ownership loss, or execution stop must be reported
 * through this exact authority. This remains a dormant leaf seam; no runtime
 * watcher is installed by CAP-AF-055.
 */
export type TextSemanticWriteInvalidation =
  | { readonly kind: 'VALUE_TRANSITION' }
  | { readonly kind: 'USER_EDIT' }
  | { readonly kind: 'OWNERSHIP_REVOKED' }
  | { readonly kind: 'EXECUTION_STOP'; readonly code: ApplyErrorCode };

export function invalidateTextSemanticWriteAuthority(
  authority: TextSemanticWriteAuthority,
  invalidation: TextSemanticWriteInvalidation,
): void {
  const record = TEXT_WRITE_RECORDS.get(authority);
  if (record === undefined || record.owner === 'DISPOSED') return;
  let kind: TextSemanticWriteInvalidation['kind'];
  let executionCode: ApplyErrorCode | null = null;
  try {
    kind = invalidation.kind;
    if (kind === 'EXECUTION_STOP') {
      const candidateCode: unknown = Reflect.get(invalidation as object, 'code');
      executionCode = isApplyErrorCode(candidateCode) ? candidateCode : 'ABORTED';
    }
  } catch {
    kind = 'EXECUTION_STOP';
    executionCode = 'ABORTED';
  }
  record.epoch += 1;
  const code = kind === 'VALUE_TRANSITION'
    ? null
    : kind === 'USER_EDIT'
      ? 'ABORTED'
      : kind === 'EXECUTION_STOP'
        ? executionCode ?? 'ABORTED'
        : 'IDENTITY_CHANGED';
  if (code !== null && (record.stopCode === null || code === 'HOST_SUBMITTED')) {
    record.stopCode = code;
  }
  if (kind !== 'EXECUTION_STOP') record.revoked = true;
}

/**
 * Opaque ownership of one exact, transaction-written text state. A future
 * integrator may place this handle in an Undo journal only after this leaf
 * returns success (or expose `recovery` on a failed compensation).
 */
export interface TextSemanticUndoOwnership {
  /** Exact target authority this ownership proof is scoped to. */
  readonly targetAuthority: TextSemanticTargetAuthority;
  /** Monotonic generation captured before the authorized forward write. */
  readonly writeUserEditGeneration: number;
  /** Current monotonic trusted-user-edit generation. */
  readonly userEditGeneration: () => number;
  readonly targetState: () => TextTargetState;
  readonly wasUserEdited: () => boolean;
  readonly isAtWrittenState: () => boolean;
  readonly restorePreWrite: () => boolean;
  readonly isAtPreWriteState: () => boolean;
  /** Must permanently revoke this owner before returning or throwing. */
  readonly dispose: () => void;
}

/**
 * Pre-write checkpoint over one exact input/textarea target.
 *
 * `captureWrittenState` only prepares a candidate. The transaction remains
 * the sole recovery owner until the published transfer commits successfully;
 * no publication, throw, invalid/distinct duplicate publication, cancel, or
 * failed commit can transfer it. Re-publication of the exact same raw transfer
 * is idempotent and reads/commits that candidate only once. Injected async operations must cooperate with their
 * AbortSignal, and every ownership proof must be monotonic rather than
 * re-arming from raw-value ABA.
 */
export interface TextSemanticTransaction {
  /** Exact target authority this pre-write checkpoint is scoped to. */
  readonly targetAuthority: TextSemanticTargetAuthority;
  /** Monotonic generation captured before the authorized forward write. */
  readonly writeUserEditGeneration: number;
  /** Current monotonic trusted-user-edit generation. */
  readonly userEditGeneration: () => number;
  readonly targetState: () => TextTargetState;
  readonly wasUserEdited: () => boolean;
  readonly isAtPreWriteState: () => boolean;
  /** Exact transaction ownership before a durable Undo handle is available. */
  readonly isAtWrittenState: (writtenValue: string) => boolean;
  readonly captureWrittenState: (
    writtenValue: string,
    publishPrepared: (transfer: TextSemanticUndoTransfer) => void,
  ) => void;
  /**
   * One-shot compensation when a durable Undo handle cannot be sealed. The
   * implementation must restore only while this exact transaction still owns
   * `writtenValue`; raw equality by itself is not sufficient authority.
   */
  readonly restorePreWriteFromWrittenState: (writtenValue: string) => boolean;
  /**
   * Must permanently revoke the transaction, every prepared or unpublished
   * transfer, and any retained publisher before returning or throwing.
   */
  readonly dispose: () => void;
}

/**
 * Prepared ownership transfer. Until `commit()` returns true, the transaction
 * remains the sole recovery owner and `undo` is only a candidate. A failed or
 * throwing commit retains the transaction; `cancel()` permanently revokes the
 * candidate. Cancellation must revoke before returning or throwing. A
 * successful commit atomically makes `undo` the sole owner.
 */
export interface TextSemanticUndoTransfer {
  readonly undo: TextSemanticUndoOwnership;
  readonly commit: () => boolean;
  readonly cancel: () => void;
}

export interface TextSemanticSettlementInput {
  readonly writeAuthority: TextSemanticWriteAuthority;
  /**
   * Selector-free, read-only host signals; DOM collection remains outside
   * apply-kernel. This callback must not dispatch events or mutate the host.
   */
  readonly readHostValidation: (
    target: TextControl,
  ) => HostValidationSignals;
  /** Existing runner safety fence (abort, policy, identity, submission, etc.). */
  readonly executionFence: () => ApplyErrorCode | null;
  /** A positive late window is mandatory; zero cannot silently mean success. */
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  /** Test/integration seam. The default is the bounded controlled-host settle. */
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  /** Test/integration seam. The default is an abort-aware timer. */
  readonly lateRecheckDelay?: (milliseconds: number, signal?: AbortSignal) => Promise<void> | void;
  /** Bounds injected host operations as well as the production defaults. */
  readonly operationTimeoutMs?: number;
}

type ResolvedTextSemanticSettlementInput = TextSemanticSettlementInput & {
  readonly target: TextSemanticTargetAuthority;
  readonly transaction: TextSemanticTransaction;
  readonly writeRecord: TextWriteRecord;
  readonly expected: string;
  readonly previous: string;
};

export type TextSemanticSettlementResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly writtenValue: string;
        readonly undo: TextSemanticUndoOwnership;
      };
    }
  | {
      readonly ok: false;
      readonly code: ApplyErrorCode;
      /** Present only while the exact transaction-written state is still proven. */
      readonly recovery?: TextSemanticUndoOwnership;
    };

type FailedSettlement = Extract<TextSemanticSettlementResult, { readonly ok: false }>;
type AsyncStepOutcome = 'ok' | 'aborted' | 'failed';
type CaptureOutcome =
  | { readonly state: 'SEALED'; readonly undo: TextSemanticUndoOwnership }
  | { readonly state: 'RETAINED' };

const APPLY_ERROR_CODE_SET: ReadonlySet<string> = new Set(APPLY_ERROR_CODES);
const DEFAULT_OPERATION_TIMEOUT_MS = WRITE_VERIFICATION_TIMEOUT_MS + 100;

function readAttribute(target: Element, name: string): string | null {
  try {
    return Element.prototype.getAttribute.call(target, name);
  } catch {
    return null;
  }
}

function normalizedAttribute(target: Element, name: string): string | null {
  const value = readAttribute(target, name);
  return value === null ? null : value.trim().toLowerCase();
}

function readConnected(target: Node): boolean | null {
  try {
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')?.get;
    if (getter === undefined) return null;
    const connected: unknown = getter.call(target);
    return typeof connected === 'boolean' ? connected : null;
  } catch {
    return null;
  }
}

function readEffectiveInputType(target: HTMLInputElement): string | null {
  try {
    const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type')?.get;
    if (getter === undefined) return null;
    const value: unknown = getter.call(target);
    return typeof value === 'string' ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function readTargetSignature(target: Element): TextTargetSignature | null {
  try {
    const localName = target instanceof HTMLInputElement
      ? 'input'
      : target instanceof HTMLTextAreaElement
        ? 'textarea'
        : null;
    if (localName === null) return null;
    const effectiveType = localName === 'input'
      ? readEffectiveInputType(target as HTMLInputElement) ?? ''
      : 'textarea';

    return {
      localName,
      typeAttribute: readAttribute(target, 'type'),
      effectiveType,
      autocomplete: readAttribute(target, 'autocomplete'),
      role: readAttribute(target, 'role'),
      ariaHasPopup: readAttribute(target, 'aria-haspopup'),
      hidden: Element.prototype.hasAttribute.call(target, 'hidden'),
    };
  } catch {
    return null;
  }
}

function signaturesEqual(left: TextTargetSignature, right: TextTargetSignature): boolean {
  return (
    left.localName === right.localName &&
    left.typeAttribute === right.typeAttribute &&
    left.effectiveType === right.effectiveType &&
    left.autocomplete === right.autocomplete &&
    left.role === right.role &&
    left.ariaHasPopup === right.ariaHasPopup &&
    left.hidden === right.hidden
  );
}

function hasSensitiveAutocomplete(target: Element): boolean {
  const autocomplete = normalizedAttribute(target, 'autocomplete');
  if (autocomplete === null || autocomplete === '') return false;
  return autocomplete
    .split(/\s+/u)
    .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith('cc-'));
}

function isEligibleTextTarget(target: Element, signature: TextTargetSignature): target is TextControl {
  if (readConnected(target) !== true || signature.hidden) return false;
  if (signature.localName === 'input' && !ALLOWED_INPUT_TYPES.has(signature.effectiveType)) return false;
  const role = normalizedAttribute(target, 'role');
  if (role !== null && role !== '' && role !== 'textbox' && role !== 'searchbox') return false;
  const popup = normalizedAttribute(target, 'aria-haspopup');
  if (popup !== null && popup !== '' && popup !== 'false') return false;
  return !hasSensitiveAutocomplete(target);
}

/**
 * Mint exact target authority before any setter, event dispatch, or transaction
 * construction. Ineligible controls fail closed and receive no token.
 */
export function createTextSemanticTargetAuthority(
  target: Element,
): TextSemanticTargetAuthority | null {
  if (typeof MutationObserver !== 'function') return null;
  const signature = readTargetSignature(target);
  if (signature === null || !isEligibleTextTarget(target, signature)) return null;
  const parent = target.parentNode;
  if (parent === null) return null;

  const token = Object.freeze({
    [TEXT_TARGET_AUTHORITY]: true as const,
  }) as TextSemanticTargetAuthority;
  const record: TextTargetRecord = {
    target,
    signature,
    observer: new MutationObserver((mutations) => recordTargetMutations(record, mutations)),
    parent,
    previousSibling: target.previousSibling,
    nextSibling: target.nextSibling,
    claimed: false,
    bound: false,
    closed: false,
    drifted: false,
    removed: false,
  };
  record.observer.observe(target, {
    attributes: true,
    attributeFilter: [...PROTECTED_TARGET_ATTRIBUTES],
  });
  let observedNode: Node = target;
  for (;;) {
    const root = observedNode.getRootNode();
    record.observer.observe(root, { childList: true, subtree: true });
    if (!(root instanceof ShadowRoot)) break;
    observedNode = root.host;
  }
  TEXT_TARGET_RECORDS.set(token, record);
  return token;
}

/**
 * Retire an unexecuted content-owned target proof. This is cleanup only: it
 * cannot mint, re-arm or inspect write authority, and a later settlement over
 * the retired target fails closed.
 */
export function disposeTextSemanticTargetAuthority(
  authority: TextSemanticTargetAuthority,
): void {
  const record = TEXT_TARGET_RECORDS.get(authority);
  if (record === undefined) return;
  record.drifted = true;
  closeTargetRecord(record);
}

function recordTargetMutations(
  record: TextTargetRecord,
  mutations: readonly MutationRecord[],
): void {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes' && mutation.target === record.target) {
      record.drifted = true;
      continue;
    }
    if (mutation.type !== 'childList') continue;
    const containsTarget = (node: Node) => {
      try {
        let cursor: Node = record.target;
        for (;;) {
          if (node === cursor || Node.prototype.contains.call(node, cursor)) return true;
          const root = cursor.getRootNode();
          if (!(root instanceof ShadowRoot)) return false;
          cursor = root.host;
        }
      } catch {
        return true;
      }
    };
    if ([...mutation.removedNodes].some(containsTarget)) record.removed = true;
    if (record.removed && [...mutation.addedNodes].some(containsTarget)) record.drifted = true;
  }
}

function detachedSlotWasReplaced(record: TextTargetRecord): boolean {
  try {
    const occupant = record.previousSibling === null
      ? record.parent.firstChild
      : record.previousSibling.nextSibling;
    return occupant !== record.nextSibling && occupant !== record.target;
  } catch {
    return true;
  }
}

function closeTargetRecord(record: TextTargetRecord): void {
  if (record.closed) return;
  record.closed = true;
  record.observer.disconnect();
}

function targetAuthorityFailure(record: TextTargetRecord): ApplyErrorCode | null {
  if (record.closed) return 'IDENTITY_CHANGED';
  try {
    recordTargetMutations(record, record.observer.takeRecords());
  } catch {
    record.drifted = true;
  }
  if (record.drifted) return 'IDENTITY_CHANGED';
  try {
    if (readConnected(record.target) !== true) {
      return detachedSlotWasReplaced(record) ? 'IDENTITY_CHANGED' : 'DETACHED';
    }
    if (record.removed) return 'IDENTITY_CHANGED';
  } catch {
    return 'IDENTITY_CHANGED';
  }
  const current = readTargetSignature(record.target);
  if (current === null || !signaturesEqual(record.signature, current)) {
    record.drifted = true;
    return 'IDENTITY_CHANGED';
  }
  return null;
}

/**
 * Bind the exact pre-write target proof and transaction before the authorized
 * setter or event dispatch. Cross-target and raw-value mismatches fail before
 * any provider callback; a same-target transaction must then pass its
 * read-only pre-write proof before the authority is minted.
 */
export function createTextSemanticWriteAuthority(
  targetAuthority: TextSemanticTargetAuthority,
  transaction: TextSemanticTransaction,
  plan: Readonly<{ readonly previous: string; readonly expected: string }>,
): TextSemanticWriteAuthority | null {
  const targetRecord = TEXT_TARGET_RECORDS.get(targetAuthority);
  let previous: unknown;
  let expected: unknown;
  try {
    previous = plan.previous;
    expected = plan.expected;
  } catch {
    return null;
  }
  if (
    targetRecord === undefined ||
    targetRecord.closed ||
    targetRecord.claimed ||
    targetRecord.bound ||
    targetAuthorityFailure(targetRecord) !== null ||
    typeof previous !== 'string' ||
    typeof expected !== 'string' ||
    readValue(targetRecord.target) !== previous
  ) {
    return null;
  }
  const cachedTransaction = readTransaction(transaction);
  if (cachedTransaction === null || cachedTransaction.targetAuthority !== targetAuthority) return null;
  try {
    if (
      cachedTransaction.userEditGeneration() !== cachedTransaction.writeUserEditGeneration ||
      cachedTransaction.wasUserEdited() !== false ||
      cachedTransaction.targetState() !== 'CURRENT' ||
      cachedTransaction.isAtPreWriteState() !== true
    ) return null;
  } catch {
    return null;
  }
  if (
    targetAuthorityFailure(targetRecord) !== null ||
    readValue(targetRecord.target) !== previous
  ) return null;

  const authority = Object.freeze({
    [TEXT_WRITE_AUTHORITY]: true as const,
  }) as TextSemanticWriteAuthority;
  targetRecord.bound = true;
  TEXT_WRITE_RECORDS.set(authority, {
    targetAuthority,
    targetRecord,
    transaction: cachedTransaction,
    previous,
    expected,
    claimed: false,
    epoch: 0,
    sealedEpoch: null,
    owner: 'TRANSACTION',
    undoOwner: null,
    committedRawTransfer: null,
    committedRawUndo: null,
    revoked: false,
    stopCode: null,
  });
  return authority;
}

function claimWriteRecord(authority: TextSemanticWriteAuthority): TextWriteRecord | null {
  const record = TEXT_WRITE_RECORDS.get(authority);
  if (
    record === undefined ||
    record.claimed ||
    record.targetRecord.closed ||
    record.targetRecord.claimed
  ) {
    return null;
  }
  record.claimed = true;
  record.targetRecord.claimed = true;
  return record;
}

function isApplyErrorCode(value: unknown): value is ApplyErrorCode {
  return typeof value === 'string' && APPLY_ERROR_CODE_SET.has(value);
}

function failure(code: ApplyErrorCode): FailedSettlement {
  return { ok: false, code };
}

function latchWriteStop(record: TextWriteRecord, code: ApplyErrorCode): void {
  if (record.stopCode === null || code === 'HOST_SUBMITTED') {
    record.stopCode = code;
    record.epoch += 1;
  }
}

function revokeWriteRecord(record: TextWriteRecord, code: ApplyErrorCode): void {
  if (!record.revoked) {
    record.revoked = true;
    record.epoch += 1;
  }
  if (record.stopCode === null || code === 'HOST_SUBMITTED') record.stopCode = code;
}

function writeRecordFailure(
  record: TextWriteRecord,
  expectedOwner: 'TRANSACTION' | 'UNDO',
  requireSealedEpoch: boolean,
): ApplyErrorCode | null {
  if (record.stopCode !== null) return record.stopCode;
  if (record.revoked || record.owner !== expectedOwner) return 'IDENTITY_CHANGED';
  if (expectedOwner === 'UNDO' && record.undoOwner === null) return 'IDENTITY_CHANGED';
  if (
    requireSealedEpoch &&
    (record.sealedEpoch === null || record.epoch !== record.sealedEpoch)
  ) {
    return 'IDENTITY_CHANGED';
  }
  return null;
}

function compensatingWriteRecordFailure(
  record: TextWriteRecord,
  expectedOwner: 'TRANSACTION' | 'UNDO',
  undoOwner?: TextSemanticUndoOwnership,
): ApplyErrorCode | null {
  if (record.revoked || record.owner !== expectedOwner) {
    return record.stopCode ?? 'IDENTITY_CHANGED';
  }
  if (
    expectedOwner === 'UNDO' &&
    (record.sealedEpoch === null || record.undoOwner === null || record.undoOwner !== undoOwner)
  ) return 'IDENTITY_CHANGED';
  if (
    record.stopCode === 'HOST_SUBMITTED' ||
    record.stopCode === 'IDENTITY_CHANGED' ||
    record.stopCode === 'DETACHED'
  ) return record.stopCode;
  return null;
}

function disposeWriteRecord(record: TextWriteRecord): void {
  if (record.owner === 'DISPOSED') return;
  record.owner = 'DISPOSED';
  record.epoch += 1;
  record.revoked = true;
}

function safeDispose(value: unknown): void {
  try {
    if (value === null || typeof value !== 'object') return;
    const targetAuthority: unknown = Reflect.get(value, 'targetAuthority');
    const dispose: unknown = Reflect.get(value, 'dispose');
    if (typeof targetAuthority === 'object' && typeof dispose === 'function') {
      Reflect.apply(dispose, value, []);
    }
  } catch {
    // Disposal cannot grant write/restore authority or change the stable code.
  }
}

function disposeOwned(record: TextTargetRecord, value: unknown): void {
  if (targetAuthorityFailure(record) === null) safeDispose(value);
  closeTargetRecord(record);
}

function readTransaction(value: unknown): TextSemanticTransaction | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const targetAuthority: unknown = Reflect.get(value, 'targetAuthority');
    const writeUserEditGeneration: unknown = Reflect.get(value, 'writeUserEditGeneration');
    const userEditGeneration: unknown = Reflect.get(value, 'userEditGeneration');
    const targetState: unknown = Reflect.get(value, 'targetState');
    const wasUserEditedCallback: unknown = Reflect.get(value, 'wasUserEdited');
    const isAtPreWriteState: unknown = Reflect.get(value, 'isAtPreWriteState');
    const isAtWrittenState: unknown = Reflect.get(value, 'isAtWrittenState');
    const captureWrittenState: unknown = Reflect.get(value, 'captureWrittenState');
    const restorePreWriteFromWrittenState: unknown = Reflect.get(
      value,
      'restorePreWriteFromWrittenState',
    );
    const dispose: unknown = Reflect.get(value, 'dispose');
    if (
      typeof targetAuthority !== 'object' ||
      !Number.isSafeInteger(writeUserEditGeneration) ||
      (writeUserEditGeneration as number) < 0 ||
      typeof userEditGeneration !== 'function' ||
      typeof targetState !== 'function' ||
      typeof wasUserEditedCallback !== 'function' ||
      typeof isAtPreWriteState !== 'function' ||
      typeof isAtWrittenState !== 'function' ||
      typeof captureWrittenState !== 'function' ||
      typeof restorePreWriteFromWrittenState !== 'function' ||
      typeof dispose !== 'function'
    ) return null;
    return Object.freeze({
      targetAuthority: targetAuthority as TextSemanticTargetAuthority,
      writeUserEditGeneration: writeUserEditGeneration as number,
      userEditGeneration: () => Reflect.apply(userEditGeneration, value, []),
      targetState: () => Reflect.apply(targetState, value, []),
      wasUserEdited: () => Reflect.apply(wasUserEditedCallback, value, []),
      isAtPreWriteState: () => Reflect.apply(isAtPreWriteState, value, []),
      isAtWrittenState: (writtenValue: string) =>
        Reflect.apply(isAtWrittenState, value, [writtenValue]),
      captureWrittenState: (
        writtenValue: string,
        publishPrepared: (transfer: TextSemanticUndoTransfer) => void,
      ) => {
        Reflect.apply(captureWrittenState, value, [writtenValue, publishPrepared]);
      },
      restorePreWriteFromWrittenState: (writtenValue: string) =>
        Reflect.apply(restorePreWriteFromWrittenState, value, [writtenValue]),
      dispose: () => {
        Reflect.apply(dispose, value, []);
      },
    });
  } catch {
    return null;
  }
}

function readUndoOwnership(
  value: unknown,
  disposeOnce: (() => void) | null,
  continueReading: () => boolean,
): TextSemanticUndoOwnership | null {
  try {
    if (value === null || typeof value !== 'object' || disposeOnce === null) return null;
    const targetAuthority: unknown = Reflect.get(value, 'targetAuthority');
    if (!continueReading()) return null;
    const writeUserEditGeneration: unknown = Reflect.get(value, 'writeUserEditGeneration');
    if (!continueReading()) return null;
    const userEditGeneration: unknown = Reflect.get(value, 'userEditGeneration');
    if (!continueReading()) return null;
    const targetState: unknown = Reflect.get(value, 'targetState');
    if (!continueReading()) return null;
    const wasUserEditedCallback: unknown = Reflect.get(value, 'wasUserEdited');
    if (!continueReading()) return null;
    const isAtWrittenState: unknown = Reflect.get(value, 'isAtWrittenState');
    if (!continueReading()) return null;
    const restorePreWrite: unknown = Reflect.get(value, 'restorePreWrite');
    if (!continueReading()) return null;
    const isAtPreWriteState: unknown = Reflect.get(value, 'isAtPreWriteState');
    if (!continueReading()) return null;
    if (
      typeof targetAuthority !== 'object' ||
      !Number.isSafeInteger(writeUserEditGeneration) ||
      (writeUserEditGeneration as number) < 0 ||
      typeof userEditGeneration !== 'function' ||
      typeof targetState !== 'function' ||
      typeof wasUserEditedCallback !== 'function' ||
      typeof isAtWrittenState !== 'function' ||
      typeof restorePreWrite !== 'function' ||
      typeof isAtPreWriteState !== 'function'
    ) return null;
    return Object.freeze({
      targetAuthority: targetAuthority as TextSemanticTargetAuthority,
      writeUserEditGeneration: writeUserEditGeneration as number,
      userEditGeneration: () => Reflect.apply(userEditGeneration, value, []),
      targetState: () => Reflect.apply(targetState, value, []),
      wasUserEdited: () => Reflect.apply(wasUserEditedCallback, value, []),
      isAtWrittenState: () => Reflect.apply(isAtWrittenState, value, []),
      restorePreWrite: () => Reflect.apply(restorePreWrite, value, []),
      isAtPreWriteState: () => Reflect.apply(isAtPreWriteState, value, []),
      dispose: disposeOnce,
    });
  } catch {
    return null;
  }
}

interface CachedUndoTransfer {
  readonly rawTransfer: object;
  readonly rawUndo: object;
  readonly undo: TextSemanticUndoOwnership;
  readonly commit: () => boolean;
  readonly cancel: () => void;
}

interface ReadUndoTransferResult {
  readonly rawTransfer: object | null;
  readonly rawUndo: object | null;
  readonly transfer: CachedUndoTransfer | null;
  readonly cancelOnce: (() => void) | null;
  readonly disposeUndoOnce: (() => void) | null;
}

interface CachedUndoCandidate {
  readonly undo: TextSemanticUndoOwnership | null;
  readonly disposeOnce: (() => void) | null;
}

function readUndoCandidate(
  rawUndo: object,
  cache: WeakMap<object, CachedUndoCandidate | 'READING'>,
  continueReading: () => boolean,
): CachedUndoCandidate {
  const cached = cache.get(rawUndo);
  if (cached === 'READING') return { undo: null, disposeOnce: null };
  if (cached !== undefined) return cached;
  cache.set(rawUndo, 'READING');
  let disposeMethod: unknown = null;
  try {
    disposeMethod = Reflect.get(rawUndo, 'dispose');
  } catch {
    disposeMethod = null;
  }
  if (!continueReading()) {
    const blocked = { undo: null, disposeOnce: null };
    cache.set(rawUndo, blocked);
    return blocked;
  }
  let disposeSpent = false;
  const disposeOnce = typeof disposeMethod === 'function'
    ? () => {
        if (disposeSpent) return;
        disposeSpent = true;
        Reflect.apply(disposeMethod, rawUndo, []);
      }
    : null;
  const candidate = {
    undo: readUndoOwnership(rawUndo, disposeOnce, continueReading),
    disposeOnce,
  };
  cache.set(rawUndo, candidate);
  return candidate;
}

function readUndoTransfer(
  value: unknown,
  undoCache: WeakMap<object, CachedUndoCandidate | 'READING'>,
  continueReading: () => boolean,
): ReadUndoTransferResult {
  if (value === null || typeof value !== 'object') {
    return {
      rawTransfer: null,
      rawUndo: null,
      transfer: null,
      cancelOnce: null,
      disposeUndoOnce: null,
    };
  }
  const rawTransfer = value;
  let rawUndoValue: unknown = null;
  let cancelMethod: unknown = null;
  try {
    cancelMethod = Reflect.get(rawTransfer, 'cancel');
  } catch {
    cancelMethod = null;
  }
  if (!continueReading()) {
    return {
      rawTransfer,
      rawUndo: null,
      transfer: null,
      cancelOnce: null,
      disposeUndoOnce: null,
    };
  }
  try {
    rawUndoValue = Reflect.get(rawTransfer, 'undo');
  } catch {
    rawUndoValue = null;
  }
  const rawUndo = rawUndoValue !== null && typeof rawUndoValue === 'object'
    ? rawUndoValue
    : null;
  if (!continueReading()) {
    return {
      rawTransfer,
      rawUndo,
      transfer: null,
      cancelOnce: null,
      disposeUndoOnce: null,
    };
  }

  let cancelSpent = false;
  const cancelOnce = typeof cancelMethod === 'function'
    ? () => {
        if (cancelSpent) return;
        cancelSpent = true;
        Reflect.apply(cancelMethod, rawTransfer, []);
      }
    : null;

  const cachedUndo = rawUndo === null
    ? { undo: null, disposeOnce: null }
    : readUndoCandidate(rawUndo, undoCache, continueReading);
  const undo = cachedUndo.undo;
  const disposeUndoOnce = cachedUndo.disposeOnce;
  if (!continueReading()) {
    return {
      rawTransfer,
      rawUndo,
      transfer: null,
      cancelOnce: null,
      disposeUndoOnce: null,
    };
  }

  let commitMethod: unknown = null;
  try {
    commitMethod = Reflect.get(rawTransfer, 'commit');
  } catch {
    commitMethod = null;
  }
  if (!continueReading()) {
    return {
      rawTransfer,
      rawUndo,
      transfer: null,
      cancelOnce: null,
      disposeUndoOnce: null,
    };
  }
  let commitAttempted = false;
  const commit = typeof commitMethod === 'function'
    ? () => {
        if (commitAttempted) return false;
        commitAttempted = true;
        return Reflect.apply(commitMethod, rawTransfer, []) === true;
      }
    : null;

  return {
    rawTransfer,
    rawUndo,
    cancelOnce,
    disposeUndoOnce,
    transfer: undo !== null && rawUndo !== null && commit !== null && cancelOnce !== null
      ? {
          rawTransfer,
          rawUndo,
          undo,
          commit,
          cancel: cancelOnce,
        }
      : null,
  };
}

function readTargetState(
  owner: Pick<TextSemanticTransaction, 'targetState'> | Pick<TextSemanticUndoOwnership, 'targetState'>,
): TextTargetState | null {
  try {
    const state = owner.targetState();
    return state === 'CURRENT' || state === 'DETACHED' || state === 'REPLACED'
      ? state
      : null;
  } catch {
    return null;
  }
}

function targetFailure(state: TextTargetState | null): ApplyErrorCode | null {
  if (state === 'CURRENT') return null;
  if (state === 'DETACHED') return 'DETACHED';
  return 'IDENTITY_CHANGED';
}

function effectiveTargetState(
  record: TextTargetRecord,
  owner: Pick<TextSemanticTransaction, 'targetState'> | Pick<TextSemanticUndoOwnership, 'targetState'>,
): TextTargetState | null {
  const claimed = readTargetState(owner);
  if (claimed === 'REPLACED' || claimed === 'DETACHED' || claimed === null) return claimed;
  const authorityCode = targetAuthorityFailure(record);
  if (authorityCode === null) return 'CURRENT';
  return authorityCode === 'DETACHED' ? 'DETACHED' : 'REPLACED';
}

function targetFailureFor(
  record: TextTargetRecord,
  owner: Pick<TextSemanticTransaction, 'targetState'> | Pick<TextSemanticUndoOwnership, 'targetState'>,
): ApplyErrorCode | null {
  return targetFailure(effectiveTargetState(record, owner));
}

function wasUserEdited(
  owner: Pick<TextSemanticTransaction, 'wasUserEdited' | 'userEditGeneration' | 'writeUserEditGeneration'>
    | Pick<TextSemanticUndoOwnership, 'wasUserEdited' | 'userEditGeneration' | 'writeUserEditGeneration'>,
): boolean {
  try {
    const generation = owner.userEditGeneration();
    return (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      generation !== owner.writeUserEditGeneration
    );
  } catch {
    return true;
  }
}

function readValue(target: TextControl): string | null {
  try {
    const prototype = target instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    const getter = Object.getOwnPropertyDescriptor(prototype, 'value')?.get;
    if (getter === undefined) return null;
    const value: unknown = getter.call(target);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function readAbortSignalIntrinsics(value: unknown): AbortSignalIntrinsics | null {
  if (value === null || typeof value !== 'object') return null;
  const cached = ABORT_SIGNAL_INTRINSICS.get(value);
  if (cached !== undefined) return cached;
  try {
    if (
      ABORT_SIGNAL_ABORTED_GETTER === null ||
      EVENT_TARGET_ADD === null ||
      EVENT_TARGET_REMOVE === null
    ) {
      ABORT_SIGNAL_INTRINSICS.set(value, null);
      return null;
    }
    if (typeof Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, value, []) !== 'boolean') {
      ABORT_SIGNAL_INTRINSICS.set(value, null);
      return null;
    }
    const intrinsics: AbortSignalIntrinsics = Object.freeze({
      aborted: () => Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, value, []) === true,
      add: (listener: () => void) => {
        Reflect.apply(EVENT_TARGET_ADD, value, ['abort', listener, { once: true }]);
      },
      remove: (listener: () => void) => {
        Reflect.apply(EVENT_TARGET_REMOVE, value, ['abort', listener]);
      },
    });
    ABORT_SIGNAL_INTRINSICS.set(value, intrinsics);
    return intrinsics;
  } catch {
    ABORT_SIGNAL_INTRINSICS.set(value, null);
    return null;
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  return readAbortSignalIntrinsics(value) !== null;
}

function signalIsAborted(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  const intrinsics = readAbortSignalIntrinsics(signal);
  if (intrinsics === null) return true;
  try {
    return intrinsics.aborted();
  } catch {
    return true;
  }
}

function addAbortListener(signal: AbortSignal | undefined, listener: () => void): boolean {
  if (signal === undefined) return true;
  const intrinsics = readAbortSignalIntrinsics(signal);
  if (intrinsics === null) return false;
  try {
    intrinsics.add(listener);
    return true;
  } catch {
    return false;
  }
}

function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (signal === undefined) return;
  try {
    readAbortSignalIntrinsics(signal)?.remove(listener);
  } catch {
    // Listener cleanup cannot be allowed to strand the bounded operation.
  }
}

function readExecutionFence(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
): ApplyErrorCode | null {
  const existing = writeRecordFailure(
    input.writeRecord,
    input.writeRecord.owner === 'UNDO' ? 'UNDO' : 'TRANSACTION',
    input.writeRecord.owner === 'UNDO',
  );
  if (existing !== null) return existing;
  const before = targetAuthorityFailure(record);
  if (before !== null) return before;
  if (signalIsAborted(input.signal)) return 'ABORTED';
  try {
    const code: unknown = input.executionFence();
    const after = targetAuthorityFailure(record);
    if (after !== null) return after;
    if (signalIsAborted(input.signal)) return 'ABORTED';
    const callbackState = writeRecordFailure(
      input.writeRecord,
      input.writeRecord.owner === 'UNDO' ? 'UNDO' : 'TRANSACTION',
      input.writeRecord.owner === 'UNDO',
    );
    if (
      callbackState !== null &&
      !(input.writeRecord.revoked && input.writeRecord.stopCode === null)
    ) return callbackState;
    if (code === null) return null;
    const stableCode = isApplyErrorCode(code) ? code : 'ABORTED';
    latchWriteStop(input.writeRecord, stableCode);
    return stableCode;
  } catch {
    const code = targetAuthorityFailure(record) ?? 'ABORTED';
    latchWriteStop(input.writeRecord, code);
    return code;
  }
}

function abortAwareDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signalIsAborted(signal)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      removeAbortListener(signal, finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    if (!addAbortListener(signal, finish) || signalIsAborted(signal)) finish();
  });
}

function runBoundedStep(
  operation: (signal: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<AsyncStepOutcome> {
  if (signalIsAborted(parentSignal)) return Promise.resolve('aborted');

  return new Promise((resolve) => {
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operationAbort = new AbortController();
    const finish = (outcome: AsyncStepOutcome) => {
      if (complete) return;
      complete = true;
      if (timer !== null) clearTimeout(timer);
      removeAbortListener(parentSignal, onAbort);
      resolve(outcome);
    };
    const stop = (outcome: Exclude<AsyncStepOutcome, 'ok'>) => {
      operationAbort.abort();
      finish(outcome);
    };
    const onAbort = () => stop('aborted');

    timer = setTimeout(() => stop('failed'), timeoutMs);
    if (!addAbortListener(parentSignal, onAbort) || signalIsAborted(parentSignal)) {
      onAbort();
      return;
    }

    void Promise.resolve()
      .then(() => operation(operationAbort.signal))
      .then(
        () => finish(signalIsAborted(parentSignal) ? 'aborted' : 'ok'),
        () => (signalIsAborted(parentSignal) ? stop('aborted') : stop('failed')),
      );
  });
}

function exactWrittenState(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  undo: TextSemanticUndoOwnership,
  writtenValue: string,
): boolean {
  if (undo.targetAuthority !== input.target) return false;
  if (targetAuthorityFailure(record) !== null) return false;
  if (readValue(record.target) !== writtenValue) return false;
  if (wasUserEdited(undo)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  if (effectiveTargetState(record, undo) !== 'CURRENT') return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  try {
    if (undo.isAtWrittenState() !== true) return false;
  } catch {
    return false;
  }
  if (targetAuthorityFailure(record) !== null) return false;
  if (readValue(record.target) !== writtenValue) return false;
  if (wasUserEdited(undo)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  return (
    targetAuthorityFailure(record) === null &&
    readValue(record.target) === writtenValue
  );
}

function exactTransactionWrittenState(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  transaction: TextSemanticTransaction,
  writtenValue: string,
): boolean {
  if (transaction.targetAuthority !== input.target) return false;
  if (targetAuthorityFailure(record) !== null) return false;
  if (readValue(record.target) !== writtenValue) return false;
  if (wasUserEdited(transaction)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  if (effectiveTargetState(record, transaction) !== 'CURRENT') return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  try {
    if (transaction.isAtWrittenState(writtenValue) !== true) return false;
  } catch {
    return false;
  }
  if (targetAuthorityFailure(record) !== null) return false;
  if (readValue(record.target) !== writtenValue) return false;
  if (wasUserEdited(transaction)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) return false;
  return (
    targetAuthorityFailure(record) === null &&
    readValue(record.target) === writtenValue
  );
}

function exactPreWriteState(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  owner: Pick<TextSemanticTransaction, 'targetAuthority' | 'targetState' | 'wasUserEdited' | 'isAtPreWriteState' | 'userEditGeneration' | 'writeUserEditGeneration'>
    | Pick<TextSemanticUndoOwnership, 'targetAuthority' | 'targetState' | 'wasUserEdited' | 'isAtPreWriteState' | 'userEditGeneration' | 'writeUserEditGeneration'>,
): boolean {
  if (owner.targetAuthority !== input.target) return false;
  if (targetAuthorityFailure(record) !== null) return false;
  if (readValue(record.target) !== input.previous) return false;
  if (wasUserEdited(owner)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== input.previous) return false;
  if (effectiveTargetState(record, owner) !== 'CURRENT') return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== input.previous) return false;
  try {
    if (owner.isAtPreWriteState() !== true) return false;
  } catch {
    return false;
  }
  if (targetAuthorityFailure(record) !== null) return false;
  if (wasUserEdited(owner)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== input.previous) return false;
  return (
    targetAuthorityFailure(record) === null &&
    readValue(record.target) === input.previous
  );
}

function guardedUndo(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  source: TextSemanticUndoOwnership,
  writtenValue: string,
  restoreBlocked = false,
  restoreAlreadySpent = false,
  allowStoppedCompensation = false,
): TextSemanticUndoOwnership {
  let disposed = false;
  let restoreSpent = restoreAlreadySpent;
  let revoked = false;
  let restored = false;
  const currentWriteFailure = () => {
    if (
      restoreBlocked &&
      input.writeRecord.stopCode === 'HOST_SUBMITTED' &&
      !input.writeRecord.revoked &&
      input.writeRecord.owner === 'UNDO'
    ) return null;
    if (allowStoppedCompensation) {
      return compensatingWriteRecordFailure(input.writeRecord, 'UNDO', source);
    }
    const code = writeRecordFailure(input.writeRecord, 'UNDO', true);
    if (code !== null) return code;
    return input.writeRecord.undoOwner === source ? null : 'IDENTITY_CHANGED';
  };
  const fenceBlocksRestore = (code: ApplyErrorCode | null) =>
    code !== null && (!allowStoppedCompensation || currentWriteFailure() !== null);
  const signalBlocksRestore = () =>
    !allowStoppedCompensation && signalIsAborted(input.signal);
  const proveWritten = () => {
    if (disposed || revoked || restored) return false;
    if (currentWriteFailure() !== null) {
      revoked = true;
      return false;
    }
    if (!exactWrittenState(input, record, source, writtenValue)) {
      revoked = true;
      revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
      return false;
    }
    if (currentWriteFailure() !== null) {
      revoked = true;
      return false;
    }
    return true;
  };
  const readGeneration = () => {
    if (disposed || revoked) return Number.MAX_SAFE_INTEGER;
    try {
      const generation = source.userEditGeneration();
      if (
        !Number.isSafeInteger(generation) ||
        generation !== source.writeUserEditGeneration
      ) {
        revoked = true;
        revokeWriteRecord(input.writeRecord, 'ABORTED');
      }
      if (currentWriteFailure() !== null) revoked = true;
      return generation;
    } catch {
      revoked = true;
      revokeWriteRecord(input.writeRecord, 'ABORTED');
      return Number.MAX_SAFE_INTEGER;
    }
  };
  return {
    targetAuthority: input.target,
    writeUserEditGeneration: source.writeUserEditGeneration,
    userEditGeneration: readGeneration,
    targetState: () => {
      if (disposed || (revoked && !restored)) return 'REPLACED';
      const state = effectiveTargetState(record, source) ?? 'REPLACED';
      if (state !== 'CURRENT' || currentWriteFailure() !== null) {
        revoked = true;
        if (state !== 'CURRENT') {
          revokeWriteRecord(input.writeRecord, targetFailure(state) ?? 'IDENTITY_CHANGED');
        }
      }
      return revoked && state === 'CURRENT' ? 'REPLACED' : state;
    },
    wasUserEdited: () => {
      if (disposed || revoked) return true;
      const edited = wasUserEdited(source);
      if (edited) revokeWriteRecord(input.writeRecord, 'ABORTED');
      if (
        edited ||
        targetAuthorityFailure(record) !== null ||
        currentWriteFailure() !== null
      ) revoked = true;
      return revoked;
    },
    isAtWrittenState: proveWritten,
    restorePreWrite: () => {
      if (disposed || revoked || restored || restoreBlocked || restoreSpent) return false;
      // Spend before any opaque proof so a re-entrant callback cannot race a
      // second provider restore through this one-shot facade.
      restoreSpent = true;
      const fence = readExecutionFence(input, record);
      if (fenceBlocksRestore(fence) || !proveWritten()) {
        revoked = true;
        return false;
      }
      const proofEpoch = input.writeRecord.epoch;
      const finalFence = readExecutionFence(input, record);
      const edited = wasUserEdited(source);
      if (
        fenceBlocksRestore(finalFence) ||
        edited ||
        currentWriteFailure() !== null ||
        input.writeRecord.epoch !== proofEpoch ||
        signalBlocksRestore() ||
        targetAuthorityFailure(record) !== null ||
        readValue(record.target) !== writtenValue
      ) {
        revoked = true;
        return false;
      }
      // Undo is a one-shot capability. Spend it before invoking untrusted host
      // restoration so an ABA return to the same raw value cannot re-arm it.
      const restoreEpoch = input.writeRecord.epoch;
      let providerRestored = false;
      try {
        providerRestored = source.restorePreWrite() === true;
      } catch {
        providerRestored = false;
      }
      if (
        targetAuthorityFailure(record) !== null ||
        input.writeRecord.epoch !== restoreEpoch ||
        signalBlocksRestore() ||
        currentWriteFailure() !== null
      ) {
        revoked = true;
        return false;
      }
      if (!providerRestored) {
        if (readValue(record.target) !== writtenValue) {
          revoked = true;
          revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
        }
        return false;
      }
      restored = exactPreWriteState(input, record, source);
      const postRestoreFence = readExecutionFence(input, record);
      if (fenceBlocksRestore(postRestoreFence)) restored = false;
      if (
        currentWriteFailure() !== null ||
        signalBlocksRestore() ||
        targetAuthorityFailure(record) !== null ||
        readValue(record.target) !== input.previous
      ) restored = false;
      if (!restored) {
        revoked = true;
        revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
      }
      return restored;
    },
    isAtPreWriteState: () =>
      !disposed &&
      restored &&
      currentWriteFailure() === null &&
      exactPreWriteState(input, record, source) &&
      currentWriteFailure() === null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      revoked = true;
      if (targetAuthorityFailure(record) === null) safeDispose(source);
      disposeWriteRecord(input.writeRecord);
      closeTargetRecord(record);
    },
  };
}

function guardedTransactionRecovery(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  source: TextSemanticTransaction,
  writtenValue: string,
  restoreBlocked: boolean,
  restoreAlreadySpent: boolean,
  allowStoppedCompensation = false,
): TextSemanticUndoOwnership {
  let disposed = false;
  let restoreSpent = restoreAlreadySpent;
  let revoked = false;
  let restored = false;
  const currentWriteFailure = () => {
    if (
      restoreBlocked &&
      input.writeRecord.stopCode === 'HOST_SUBMITTED' &&
      !input.writeRecord.revoked &&
      input.writeRecord.owner === 'TRANSACTION'
    ) return null;
    if (allowStoppedCompensation) {
      return compensatingWriteRecordFailure(input.writeRecord, 'TRANSACTION');
    }
    return writeRecordFailure(input.writeRecord, 'TRANSACTION', false);
  };
  const fenceBlocksRestore = (code: ApplyErrorCode | null) =>
    code !== null && (!allowStoppedCompensation || currentWriteFailure() !== null);
  const signalBlocksRestore = () =>
    !allowStoppedCompensation && signalIsAborted(input.signal);
  const proveWritten = () => {
    if (disposed || revoked || restored) return false;
    if (currentWriteFailure() !== null) {
      revoked = true;
      return false;
    }
    if (!exactTransactionWrittenState(input, record, source, writtenValue)) {
      revoked = true;
      revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
      return false;
    }
    if (currentWriteFailure() !== null) {
      revoked = true;
      return false;
    }
    return true;
  };
  return {
    targetAuthority: input.target,
    writeUserEditGeneration: source.writeUserEditGeneration,
    userEditGeneration: () => {
      if (disposed || revoked) return Number.MAX_SAFE_INTEGER;
      try {
        const generation = source.userEditGeneration();
        if (
          !Number.isSafeInteger(generation) ||
          generation !== source.writeUserEditGeneration
        ) {
          revoked = true;
          revokeWriteRecord(input.writeRecord, 'ABORTED');
        }
        if (currentWriteFailure() !== null) revoked = true;
        return generation;
      } catch {
        revoked = true;
        revokeWriteRecord(input.writeRecord, 'ABORTED');
        return Number.MAX_SAFE_INTEGER;
      }
    },
    targetState: () => {
      if (disposed || (revoked && !restored)) return 'REPLACED';
      const state = effectiveTargetState(record, source) ?? 'REPLACED';
      if (
        state !== 'CURRENT' ||
        currentWriteFailure() !== null
      ) {
        revoked = true;
        if (state !== 'CURRENT') {
          revokeWriteRecord(input.writeRecord, targetFailure(state) ?? 'IDENTITY_CHANGED');
        }
      }
      return revoked && state === 'CURRENT' ? 'REPLACED' : state;
    },
    wasUserEdited: () => {
      if (disposed || revoked) return true;
      const edited = wasUserEdited(source);
      if (edited) revokeWriteRecord(input.writeRecord, 'ABORTED');
      if (
        edited ||
        targetAuthorityFailure(record) !== null ||
        currentWriteFailure() !== null
      ) revoked = true;
      return revoked;
    },
    isAtWrittenState: proveWritten,
    restorePreWrite: () => {
      if (disposed || revoked || restored || restoreBlocked || restoreSpent) return false;
      restoreSpent = true;
      const fence = readExecutionFence(input, record);
      if (fenceBlocksRestore(fence) || !proveWritten()) {
        revoked = true;
        return false;
      }
      const proofEpoch = input.writeRecord.epoch;
      const finalFence = readExecutionFence(input, record);
      const edited = wasUserEdited(source);
      if (
        fenceBlocksRestore(finalFence) ||
        edited ||
        currentWriteFailure() !== null ||
        input.writeRecord.epoch !== proofEpoch ||
        signalBlocksRestore() ||
        targetAuthorityFailure(record) !== null ||
        readValue(record.target) !== writtenValue
      ) {
        revoked = true;
        return false;
      }
      const restoreEpoch = input.writeRecord.epoch;
      let providerRestored = false;
      try {
        providerRestored = source.restorePreWriteFromWrittenState(writtenValue) === true;
      } catch {
        providerRestored = false;
      }
      if (
        targetAuthorityFailure(record) !== null ||
        input.writeRecord.epoch !== restoreEpoch ||
        signalBlocksRestore() ||
        currentWriteFailure() !== null
      ) {
        revoked = true;
        return false;
      }
      if (!providerRestored) {
        if (readValue(record.target) !== writtenValue) {
          revoked = true;
          revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
        }
        return false;
      }
      restored = exactPreWriteState(input, record, source);
      const postRestoreFence = readExecutionFence(input, record);
      if (fenceBlocksRestore(postRestoreFence)) restored = false;
      if (
        currentWriteFailure() !== null ||
        signalBlocksRestore() ||
        targetAuthorityFailure(record) !== null ||
        readValue(record.target) !== input.previous
      ) restored = false;
      if (!restored) {
        revoked = true;
        revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
      }
      return restored;
    },
    isAtPreWriteState: () =>
      !disposed &&
      restored &&
      currentWriteFailure() === null &&
      exactPreWriteState(input, record, source) &&
      currentWriteFailure() === null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      revoked = true;
      if (targetAuthorityFailure(record) === null) safeDispose(source);
      disposeWriteRecord(input.writeRecord);
      closeTargetRecord(record);
    },
  };
}

function cleanupSealedFailure(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  undo: TextSemanticUndoOwnership,
  writtenValue: string,
  requestedCode: ApplyErrorCode,
): FailedSettlement {
  let code = requestedCode;
  if (input.writeRecord.revoked) {
    code = input.writeRecord.stopCode ?? (
      readValue(record.target) === writtenValue ? 'IDENTITY_CHANGED' : requestedCode
    );
    if (targetAuthorityFailure(record) === null) safeDispose(undo);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(code);
  }
  const authorityCode = targetAuthorityFailure(record);
  if (authorityCode !== null) {
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(authorityCode);
  }
  const fenceCode = readExecutionFence(input, record);
  if (fenceCode !== null) code = fenceCode;

  const blockedRecovery = (): FailedSettlement => {
    const recovery = guardedUndo(input, record, undo, writtenValue, true, true);
    if (recovery.isAtWrittenState()) {
      return { ok: false, code: 'HOST_SUBMITTED', recovery };
    }
    recovery.dispose();
    return failure('HOST_SUBMITTED');
  };

  if (
    code === 'HOST_SUBMITTED' &&
    !input.writeRecord.revoked &&
    input.writeRecord.owner === 'UNDO' &&
    input.writeRecord.undoOwner === undo
  ) return blockedRecovery();

  const ownershipCode = compensatingWriteRecordFailure(input.writeRecord, 'UNDO', undo);
  if (ownershipCode !== null) {
    if (targetAuthorityFailure(record) === null) safeDispose(undo);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(ownershipCode);
  }

  if (exactPreWriteState(input, record, undo)) {
    const postProofCode = compensatingWriteRecordFailure(input.writeRecord, 'UNDO', undo);
    if (
      postProofCode === null &&
      targetAuthorityFailure(record) === null &&
      readValue(record.target) === input.previous
    ) {
      disposeOwned(record, undo);
      disposeWriteRecord(input.writeRecord);
      return failure(code);
    }
    if (targetAuthorityFailure(record) === null) safeDispose(undo);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(postProofCode ?? 'IDENTITY_CHANGED');
  }

  if (readValue(record.target) !== writtenValue) {
    disposeOwned(record, undo);
    disposeWriteRecord(input.writeRecord);
    return failure(code);
  }

  // All destructive compensation goes through the same guarded, one-shot
  // facade used by the returned Undo handle. Cleanup never invokes raw restore.
  const recovery = guardedUndo(input, record, undo, writtenValue, false, false, true);
  if (recovery.restorePreWrite()) {
    recovery.dispose();
    return failure(code);
  }

  if (
    input.writeRecord.stopCode === 'HOST_SUBMITTED' &&
    !input.writeRecord.revoked &&
    input.writeRecord.owner === 'UNDO' &&
    input.writeRecord.undoOwner === undo
  ) return blockedRecovery();

  if (input.writeRecord.stopCode !== null) code = input.writeRecord.stopCode;
  const terminalOwnershipCode = compensatingWriteRecordFailure(
    input.writeRecord,
    'UNDO',
    undo,
  );
  if (terminalOwnershipCode === null && recovery.isAtWrittenState()) {
    return { ok: false, code, recovery };
  }
  recovery.dispose();
  return failure(terminalOwnershipCode ?? code);
}

function retainedTransactionBoundaryIsStable(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  transaction: TextSemanticTransaction,
  writtenValue: string,
): boolean {
  if (writeRecordFailure(input.writeRecord, 'TRANSACTION', false) !== null) return false;
  if (targetAuthorityFailure(record) !== null || signalIsAborted(input.signal)) return false;
  if (readValue(record.target) !== writtenValue) return false;
  if (readExecutionFence(input, record) !== null) return false;
  if (targetAuthorityFailure(record) !== null || signalIsAborted(input.signal)) return false;
  if (wasUserEdited(transaction)) return false;
  if (targetAuthorityFailure(record) !== null || readValue(record.target) !== writtenValue) {
    return false;
  }
  if (targetFailureFor(record, transaction) !== null) return false;
  if (!exactTransactionWrittenState(input, record, transaction, writtenValue)) return false;
  if (readExecutionFence(input, record) !== null) return false;
  return (
    writeRecordFailure(input.writeRecord, 'TRANSACTION', false) === null &&
    targetAuthorityFailure(record) === null &&
    !signalIsAborted(input.signal) &&
    readValue(record.target) === writtenValue
  );
}

function captureUndo(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  transaction: TextSemanticTransaction,
  writtenValue: string,
): CaptureOutcome {
  if (!exactTransactionWrittenState(input, record, transaction, writtenValue)) {
    return { state: 'RETAINED' };
  }

  const publications: ReadUndoTransferResult[] = [];
  const publicationCache = new WeakMap<object, ReadUndoTransferResult | 'READING'>();
  const undoCandidateCache = new WeakMap<object, CachedUndoCandidate | 'READING'>();
  const cancelledTransfers = new WeakSet<object>();
  const disposedUndos = new WeakSet<object>();
  let captureOpen = true;
  let captureThrew = false;
  let selectedRawTransfer: object | null = null;
  let selectedRawUndo: object | null = null;
  const publicationTargetIsLive = (): boolean => {
    if (input.writeRecord.owner === 'DISPOSED') return false;
    const authorityCode = targetAuthorityFailure(record);
    if (authorityCode !== null) {
      // Once target identity is lost there is no safe provider callback left:
      // retire the record and ignore even transfer/Undo getters published late.
      revokeWriteRecord(input.writeRecord, authorityCode);
      disposeWriteRecord(input.writeRecord);
      closeTargetRecord(record);
      return false;
    }
    return true;
  };

  const readPublication = (candidate: unknown): ReadUndoTransferResult => {
    if (candidate !== null && typeof candidate === 'object') {
      const cached = publicationCache.get(candidate);
      if (cached === 'READING') {
        return {
          rawTransfer: candidate,
          rawUndo: null,
          transfer: null,
          cancelOnce: null,
          disposeUndoOnce: null,
        };
      }
      if (cached !== undefined) return cached;
      publicationCache.set(candidate, 'READING');
      const publication = readUndoTransfer(
        candidate,
        undoCandidateCache,
        publicationTargetIsLive,
      );
      publicationCache.set(candidate, publication);
      return publication;
    }
    return readUndoTransfer(candidate, undoCandidateCache, publicationTargetIsLive);
  };
  const cleanupPublication = (
    publication: ReadUndoTransferResult,
    preserveCurrentUndo = false,
  ): boolean => {
    if (!publicationTargetIsLive()) return false;
    if (
      publication.rawTransfer === selectedRawTransfer ||
      publication.rawTransfer === input.writeRecord.committedRawTransfer
    ) return true;
    let candidateRevoked = publication.rawTransfer === null || (
      publication.rawTransfer !== null && cancelledTransfers.has(publication.rawTransfer)
    ) || (
      publication.rawUndo !== null && disposedUndos.has(publication.rawUndo)
    );
    if (
      publication.rawTransfer !== null &&
      publication.cancelOnce !== null &&
      !cancelledTransfers.has(publication.rawTransfer)
    ) {
      cancelledTransfers.add(publication.rawTransfer);
      // Transfer contract: cancel revokes before either return or throw.
      candidateRevoked = true;
      try {
        publication.cancelOnce();
      } catch {
        // Cancellation is one-shot even when the provider throws.
      }
      if (!publicationTargetIsLive()) return candidateRevoked;
    }
    if (
      publication.rawUndo !== null &&
      !preserveCurrentUndo &&
      publication.disposeUndoOnce !== null &&
      !disposedUndos.has(publication.rawUndo)
    ) {
      disposedUndos.add(publication.rawUndo);
      // Undo contract: dispose revokes before either return or throw.
      candidateRevoked = true;
      try {
        publication.disposeUndoOnce();
      } catch {
        // Disposal is best effort and must never re-arm the candidate.
      }
    }
    if (!candidateRevoked) revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
    return candidateRevoked;
  };
  try {
    transaction.captureWrittenState(writtenValue, (candidate) => {
      if (!publicationTargetIsLive()) return;
      if (
        !captureOpen &&
        candidate !== null &&
        typeof candidate === 'object' &&
        (candidate === selectedRawTransfer || candidate === input.writeRecord.committedRawTransfer)
      ) return;
      const publication = readPublication(candidate);
      if (!publicationTargetIsLive()) return;
      if (!captureOpen) {
        const aliasesCurrentUndo = publication.rawUndo !== null && (
          publication.rawUndo === selectedRawUndo ||
          publication.rawUndo === input.writeRecord.committedRawUndo
        );
        if (aliasesCurrentUndo) {
          revokeWriteRecord(input.writeRecord, 'IDENTITY_CHANGED');
          cleanupPublication(publication, true);
          if (
            publicationTargetIsLive() &&
            input.writeRecord.owner === 'UNDO' &&
            input.writeRecord.undoOwner !== null
          ) {
            safeDispose(input.writeRecord.undoOwner);
          }
          return;
        }
        const candidateRevoked = cleanupPublication(publication);
        if (
          !candidateRevoked &&
          input.writeRecord.owner === 'UNDO' &&
          input.writeRecord.undoOwner !== null
        ) {
          safeDispose(input.writeRecord.undoOwner);
        }
        return;
      }
      publications.push(publication);
    });
  } catch {
    captureThrew = true;
  } finally {
    captureOpen = false;
  }

  if (publications.length === 0) return { state: 'RETAINED' };

  const uniquePublications: ReadUndoTransferResult[] = [];
  const seenTransfers = new WeakSet<object>();
  let primitivePublicationSeen = false;
  for (const publication of publications) {
    if (publication.rawTransfer === null) {
      if (!primitivePublicationSeen) uniquePublications.push(publication);
      primitivePublicationSeen = true;
      continue;
    }
    if (seenTransfers.has(publication.rawTransfer)) continue;
    seenTransfers.add(publication.rawTransfer);
    const cached = publicationCache.get(publication.rawTransfer);
    uniquePublications.push(
      cached !== undefined && cached !== 'READING' ? cached : publication,
    );
  }
  const cancelAllPublications = () => {
    for (const publication of uniquePublications) cleanupPublication(publication);
  };

  if (captureThrew || uniquePublications.length !== 1) {
    cancelAllPublications();
    return { state: 'RETAINED' };
  }
  const selectedPublication = uniquePublications[0];
  if (selectedPublication === undefined || selectedPublication.transfer === null) {
    cancelAllPublications();
    return { state: 'RETAINED' };
  }
  const transfer = selectedPublication.transfer;
  selectedRawTransfer = transfer.rawTransfer;
  selectedRawUndo = transfer.rawUndo;
  let cancelled = false;
  const cancelPrepared = () => {
    if (cancelled) return;
    cancelled = true;
    selectedRawTransfer = null;
    selectedRawUndo = null;
    cleanupPublication(selectedPublication);
  };

  if (
    !retainedTransactionBoundaryIsStable(input, record, transaction, writtenValue)
  ) {
    cancelPrepared();
    return { state: 'RETAINED' };
  }

  if (
    transfer.undo.targetAuthority !== input.target ||
    transfer.undo.writeUserEditGeneration !== transaction.writeUserEditGeneration ||
    !exactWrittenState(input, record, transfer.undo, writtenValue) ||
    !retainedTransactionBoundaryIsStable(input, record, transaction, writtenValue)
  ) {
    cancelPrepared();
    return { state: 'RETAINED' };
  }

  let committed = false;
  try {
    committed = transfer.commit();
  } catch {
    committed = false;
  }
  if (!committed) {
    cancelPrepared();
    return { state: 'RETAINED' };
  }

  // The provider contract makes this transfer atomic: transaction authority
  // ends only when commit returns true. The commit itself retires the source
  // transaction; invoking another provider callback here would create an
  // unproved side effect between commit and the caller's sealed checkpoint.
  input.writeRecord.owner = 'UNDO';
  input.writeRecord.epoch += 1;
  input.writeRecord.sealedEpoch = input.writeRecord.epoch;
  input.writeRecord.undoOwner = transfer.undo;
  input.writeRecord.committedRawTransfer = transfer.rawTransfer;
  input.writeRecord.committedRawUndo = transfer.rawUndo;
  return { state: 'SEALED', undo: transfer.undo };
}

function cleanupUnsealedFailure(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  transaction: TextSemanticTransaction,
  requestedCode: ApplyErrorCode,
): FailedSettlement {
  let code = requestedCode;
  if (input.writeRecord.revoked) {
    code = input.writeRecord.stopCode ?? (
      readValue(record.target) === input.expected ? 'IDENTITY_CHANGED' : requestedCode
    );
    if (targetAuthorityFailure(record) === null) safeDispose(transaction);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(code);
  }
  const authorityCode = targetAuthorityFailure(record);
  if (authorityCode !== null) {
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(authorityCode);
  }
  const fenceCode = readExecutionFence(input, record);
  if (fenceCode !== null) code = fenceCode;

  const blockedRecovery = (): FailedSettlement => {
    const recovery = guardedTransactionRecovery(
      input,
      record,
      transaction,
      input.expected,
      true,
      true,
    );
    if (recovery.isAtWrittenState()) {
      return { ok: false, code: 'HOST_SUBMITTED', recovery };
    }
    recovery.dispose();
    return failure('HOST_SUBMITTED');
  };

  if (
    code === 'HOST_SUBMITTED' &&
    !input.writeRecord.revoked &&
    input.writeRecord.owner === 'TRANSACTION'
  ) return blockedRecovery();

  const ownershipCode = compensatingWriteRecordFailure(input.writeRecord, 'TRANSACTION');
  if (ownershipCode !== null) {
    if (targetAuthorityFailure(record) === null) safeDispose(transaction);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(ownershipCode);
  }

  if (exactPreWriteState(input, record, transaction)) {
    const postProofCode = compensatingWriteRecordFailure(input.writeRecord, 'TRANSACTION');
    if (
      postProofCode === null &&
      targetAuthorityFailure(record) === null &&
      readValue(record.target) === input.previous
    ) {
      disposeOwned(record, transaction);
      disposeWriteRecord(input.writeRecord);
      return failure(code);
    }
    if (targetAuthorityFailure(record) === null) safeDispose(transaction);
    disposeWriteRecord(input.writeRecord);
    closeTargetRecord(record);
    return failure(postProofCode ?? 'IDENTITY_CHANGED');
  }

  if (readValue(record.target) !== input.expected) {
    disposeOwned(record, transaction);
    disposeWriteRecord(input.writeRecord);
    return failure(code);
  }

  const recovery = guardedTransactionRecovery(
    input,
    record,
    transaction,
    input.expected,
    false,
    false,
    true,
  );
  if (recovery.restorePreWrite()) {
    recovery.dispose();
    return failure(code);
  }

  if (
    input.writeRecord.stopCode === 'HOST_SUBMITTED' &&
    !input.writeRecord.revoked &&
    input.writeRecord.owner === 'TRANSACTION'
  ) return blockedRecovery();

  if (input.writeRecord.stopCode !== null) code = input.writeRecord.stopCode;
  const terminalOwnershipCode = compensatingWriteRecordFailure(
    input.writeRecord,
    'TRANSACTION',
  );
  if (terminalOwnershipCode === null && recovery.isAtWrittenState()) {
    return { ok: false, code, recovery };
  }
  recovery.dispose();
  return failure(terminalOwnershipCode ?? code);
}

function initialWrittenValue(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
): { readonly ok: true; readonly value: string } | FailedSettlement {
  const writeCode = writeRecordFailure(input.writeRecord, 'TRANSACTION', false);
  if (writeCode !== null) return failure(writeCode);
  const authorityCode = targetAuthorityFailure(record);
  if (authorityCode !== null) return failure(authorityCode);
  if (wasUserEdited(input.transaction)) return failure('ABORTED');
  const postUserCode = targetAuthorityFailure(record);
  if (postUserCode !== null) return failure(postUserCode);

  const stateCode = targetFailureFor(record, input.transaction);
  if (stateCode !== null) return failure(stateCode);

  const first = readValue(record.target);
  if (first === null) return failure('IDENTITY_CHANGED');
  if (first === input.previous) return failure('WRITE_REVERTED');
  if (first !== input.expected) return failure('VALUE_COERCED');

  // A getter/controlled render that changes between adjacent reads is not a
  // stable checkpoint and cannot be used to seal Undo ownership.
  const second = readValue(record.target);
  if (second === null) return failure('IDENTITY_CHANGED');
  if (second !== first) {
    return failure(second === input.previous ? 'WRITE_REVERTED' : 'VALUE_COERCED');
  }
  return { ok: true, value: first };
}

function sealedCheckpoint(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
  undo: TextSemanticUndoOwnership,
  writtenValue: string,
  phase: 'IMMEDIATE' | 'LATE',
): ApplyErrorCode | null {
  const directCode = (): ApplyErrorCode | null => {
    const authorityCode = targetAuthorityFailure(record);
    if (authorityCode !== null) return authorityCode;
    if (signalIsAborted(input.signal)) return 'ABORTED';
    const current = readValue(record.target);
    if (current === null) return 'IDENTITY_CHANGED';
    if (current !== writtenValue || current !== input.expected) {
      if (phase === 'LATE') return 'LATE_REVERTED';
      return current === input.previous ? 'WRITE_REVERTED' : 'VALUE_COERCED';
    }
    return writeRecordFailure(input.writeRecord, 'UNDO', true);
  };

  let code = directCode();
  if (code !== null) return code;
  const fence = readExecutionFence(input, record);
  if (fence !== null) return fence;
  code = directCode();
  if (code !== null) return code;
  if (wasUserEdited(undo)) return 'ABORTED';
  code = directCode();
  if (code !== null) return code;

  const stateCode = targetFailureFor(record, undo);
  if (stateCode !== null) return stateCode;
  code = directCode();
  if (code !== null) return code;

  // This is the final opaque callback. Everything below it is a code-owned
  // DOM/brand/signal/epoch read, so no stale proof can be reused after a fence
  // or provider callback side effect.
  let owned = false;
  try {
    owned = undo.isAtWrittenState() === true;
  } catch {
    owned = false;
  }
  code = directCode();
  if (code !== null) return code;
  return owned ? null : 'IDENTITY_CHANGED';
}

function hostValidationFailure(
  input: ResolvedTextSemanticSettlementInput,
  record: TextTargetRecord,
): ApplyErrorCode | null {
  const writeCode = writeRecordFailure(input.writeRecord, 'UNDO', true);
  if (writeCode !== null) return writeCode;
  const before = targetAuthorityFailure(record);
  if (before !== null) return before;
  if (signalIsAborted(input.signal)) return 'ABORTED';
  try {
    const verdict = classifyHostValidation(input.readHostValidation(record.target));
    const callbackWriteCode = writeRecordFailure(input.writeRecord, 'UNDO', true);
    if (callbackWriteCode !== null) return callbackWriteCode;
    const after = targetAuthorityFailure(record);
    if (after !== null) return after;
    if (signalIsAborted(input.signal)) return 'ABORTED';
    if (verdict === 'accepted') return null;
    return verdict === 'rejected' ? 'HOST_REJECTED' : 'CAPABILITY_DISABLED';
  } catch {
    return targetAuthorityFailure(record) ?? (
      signalIsAborted(input.signal) ? 'ABORTED' : 'CAPABILITY_DISABLED'
    );
  }
}

function stepFailure(outcome: AsyncStepOutcome): ApplyErrorCode | null {
  if (outcome === 'ok') return null;
  return outcome === 'aborted' ? 'ABORTED' : 'VERIFY_TIMEOUT';
}

function fallbackSettlementInput(
  writeAuthority: TextSemanticWriteAuthority,
  writeRecord: TextWriteRecord,
): ResolvedTextSemanticSettlementInput {
  return {
    writeAuthority,
    readHostValidation: () => ({}),
    executionFence: () => null,
    lateRecheckMs: 1,
    target: writeRecord.targetAuthority,
    transaction: writeRecord.transaction,
    writeRecord,
    expected: writeRecord.expected,
    previous: writeRecord.previous,
  };
}

function resolveSettlementInput(
  provided: object,
  writeAuthority: TextSemanticWriteAuthority,
  writeRecord: TextWriteRecord,
): ResolvedTextSemanticSettlementInput | null {
  try {
    const readHostValidation = Reflect.get(provided, 'readHostValidation');
    const executionFence = Reflect.get(provided, 'executionFence');
    const lateRecheckMs = Reflect.get(provided, 'lateRecheckMs');
    const signal = Reflect.get(provided, 'signal');
    const settle = Reflect.get(provided, 'settle');
    const lateRecheckDelay = Reflect.get(provided, 'lateRecheckDelay');
    const operationTimeoutMs = Reflect.get(provided, 'operationTimeoutMs');
    if (signal !== undefined && !isNativeAbortSignal(signal)) return null;
    return {
      writeAuthority,
      readHostValidation: readHostValidation as TextSemanticSettlementInput['readHostValidation'],
      executionFence: executionFence as TextSemanticSettlementInput['executionFence'],
      lateRecheckMs: lateRecheckMs as number,
      signal,
      settle: settle as TextSemanticSettlementInput['settle'],
      lateRecheckDelay: lateRecheckDelay as TextSemanticSettlementInput['lateRecheckDelay'],
      operationTimeoutMs: operationTimeoutMs as number | undefined,
      target: writeRecord.targetAuthority,
      transaction: writeRecord.transaction,
      writeRecord,
      expected: writeRecord.expected,
      previous: writeRecord.previous,
    };
  } catch {
    return null;
  }
}

/**
 * Finalize one already-authorized text/textarea write.
 *
 * Success is deliberately the last possible result: immediate controlled-host
 * settle, exact readback, Undo seal, host validation, mandatory late delay,
 * another settle, final validation, and a final exact read must all agree.
 */
export async function settleTextSemanticWrite(
  provided: TextSemanticSettlementInput,
): Promise<TextSemanticSettlementResult> {
  let providedObject: object;
  let writeAuthority: TextSemanticWriteAuthority;
  try {
    if (provided === null || typeof provided !== 'object') {
      return failure('CAPABILITY_DISABLED');
    }
    providedObject = provided;
    writeAuthority = Reflect.get(providedObject, 'writeAuthority') as TextSemanticWriteAuthority;
  } catch {
    return failure('CAPABILITY_DISABLED');
  }
  const writeRecord = claimWriteRecord(writeAuthority);
  if (writeRecord === null) return failure('CAPABILITY_DISABLED');
  const record = writeRecord.targetRecord;
  const input = resolveSettlementInput(providedObject, writeAuthority, writeRecord);
  if (input === null) {
    return cleanupUnsealedFailure(
      fallbackSettlementInput(writeAuthority, writeRecord),
      record,
      writeRecord.transaction,
      'CAPABILITY_DISABLED',
    );
  }
  const entryCode = targetAuthorityFailure(record);
  if (entryCode !== null) {
    disposeWriteRecord(writeRecord);
    closeTargetRecord(record);
    return failure(entryCode);
  }

  const operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (input.transaction.targetAuthority !== input.target) {
    disposeWriteRecord(writeRecord);
    closeTargetRecord(record);
    return failure('IDENTITY_CHANGED');
  }

  // Seal provisional ownership synchronously, before the first host await.
  // This is not a success verdict; it only guarantees that timeout, abort, or
  // an early submission fence cannot leave an anonymous write behind.
  const initial = initialWrittenValue(input, record);
  if (!initial.ok) return cleanupUnsealedFailure(input, record, input.transaction, initial.code);
  const writtenValue = initial.value;
  if (signalIsAborted(input.signal)) {
    return cleanupUnsealedFailure(input, record, input.transaction, 'ABORTED');
  }
  const capture = captureUndo(input, record, input.transaction, writtenValue);
  if (capture.state === 'RETAINED') {
    return cleanupUnsealedFailure(input, record, input.transaction, 'JOURNAL_UNAVAILABLE');
  }
  const undo = capture.undo;

  if (
    typeof input.readHostValidation !== 'function' ||
    typeof input.executionFence !== 'function' ||
    !Number.isFinite(input.lateRecheckMs) ||
    input.lateRecheckMs <= 0 ||
    !Number.isFinite(operationTimeoutMs) ||
    operationTimeoutMs <= 0
  ) {
    return cleanupSealedFailure(input, record, undo, writtenValue, 'CAPABILITY_DISABLED');
  }

  const settle = (stepSignal: AbortSignal) =>
    input.settle
      ? input.settle(stepSignal)
      : settleAfterHostWrite(stepSignal);

  let code = sealedCheckpoint(input, record, undo, writtenValue, 'IMMEDIATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  let step = await runBoundedStep(settle, operationTimeoutMs, input.signal);
  code = stepFailure(step);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);

  code = sealedCheckpoint(input, record, undo, writtenValue, 'IMMEDIATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  code = hostValidationFailure(input, record);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  // Host validation commonly runs blur listeners; its result is not final
  // until the value and semantic ownership are read again afterward.
  code = sealedCheckpoint(input, record, undo, writtenValue, 'IMMEDIATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);

  const lateDelay = async (stepSignal: AbortSignal) => {
    const minimumWindow = abortAwareDelay(input.lateRecheckMs, stepSignal);
    if (input.lateRecheckDelay) {
      await Promise.all([
        minimumWindow,
        Promise.resolve(input.lateRecheckDelay(input.lateRecheckMs, stepSignal)),
      ]);
      return;
    }
    await minimumWindow;
  };
  step = await runBoundedStep(
    lateDelay,
    input.lateRecheckMs + operationTimeoutMs,
    input.signal,
  );
  code = stepFailure(step);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);

  code = sealedCheckpoint(input, record, undo, writtenValue, 'LATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  step = await runBoundedStep(settle, operationTimeoutMs, input.signal);
  code = stepFailure(step);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);

  code = sealedCheckpoint(input, record, undo, writtenValue, 'LATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  code = hostValidationFailure(input, record);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  // A validation read can expose framework work already queued by blur/change.
  // Settle once more, then require both the value and host verdict to remain.
  step = await runBoundedStep(settle, operationTimeoutMs, input.signal);
  code = stepFailure(step);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  code = sealedCheckpoint(input, record, undo, writtenValue, 'LATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  code = hostValidationFailure(input, record);
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);
  // Final success boundary: all host work has settled, the read-only collector
  // has reported the final verdict, and no callback runs after this exact
  // semantic/Undo proof.
  code = sealedCheckpoint(input, record, undo, writtenValue, 'LATE');
  if (code !== null) return cleanupSealedFailure(input, record, undo, writtenValue, code);

  return {
    ok: true,
    value: { writtenValue, undo: guardedUndo(input, record, undo, writtenValue) },
  };
}


/** Fill-first verification has no restoration capability or retained pre-write value. */
export interface TextFillOnlyObservation {
  /** Read-only batch-final check; null means the verified answer remains current. */
  readonly check: () => ApplyErrorCode | null;
  /**
   * Complete live/retired callback checks while consumer listeners remain active,
   * then retire the consumer and recheck target/value without external callbacks.
   * Consumer retirement must report true only after all cleanup has completed.
   */
  readonly finalize: (retireConsumer?: () => boolean) => ApplyErrorCode | null;
  readonly dispose: () => void;
}

export type TextFillOnlyResult =
  | Readonly<{ ok: true; observation: TextFillOnlyObservation }>
  | Readonly<{ ok: false; code: ApplyErrorCode; writeEffect?: 'MAY_HAVE_CHANGED' }>;

export interface TextFillOnlyInput {
  readonly target: TextSemanticTargetAuthority;
  readonly expected: string;
  readonly authorizeWrite: () => Promise<boolean>;
  /** Exactly one content-owned native setter, with no host event dispatch. */
  readonly writeForward: () => boolean;
  readonly executionFence: () => ApplyErrorCode | null;
  readonly readHostValidation: () => HostValidationSignals;
  readonly lateRecheckMs: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly settle?: TextSemanticSettlementInput['settle'];
  readonly lateRecheckDelay?: TextSemanticSettlementInput['lateRecheckDelay'];
}

/**
 * Explicit FROZEN-Undo lane. Claims an opaque exact-target token before awaiting
 * a fresh grant, repeats empty-value and execution fences immediately before the
 * sole setter, then performs read-only verification. Failures never compensate.
 * Endpoint checks establish the current value, not a complete value history.
 */
export async function executeTextFillOnlyWrite(input: TextFillOnlyInput): Promise<TextFillOnlyResult> {
  const record = TEXT_TARGET_RECORDS.get(input.target);
  if (record === undefined || record.closed || record.claimed || record.bound) {
    return Object.freeze({ ok: false, code: 'IDENTITY_CHANGED' });
  }
  record.claimed = true;
  record.bound = true;
  let attempted = false;
  const fail = (code: ApplyErrorCode): TextFillOnlyResult => {
    closeTargetRecord(record);
    return Object.freeze({ ok: false, code,
      ...(attempted ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
    });
  };
  const targetFence = (retired = false): ApplyErrorCode | null => {
    if (signalIsAborted(input.signal)) return 'ABORTED';
    const signature = retired ? readTargetSignature(record.target) : null;
    const drift = retired
      ? record.drifted || record.removed || readConnected(record.target) !== true ||
        signature === null || !signaturesEqual(record.signature, signature) ? 'IDENTITY_CHANGED' : null
      : targetAuthorityFailure(record);
    if (drift !== null) return drift;
    if (record.target.disabled || record.target.readOnly) return 'IDENTITY_CHANGED';
    // Both the caller fence and target getters can synchronously revoke the run.
    return signalIsAborted(input.signal) ? 'ABORTED' : null;
  };
  const fence = (retired = false): ApplyErrorCode | null => {
    if (signalIsAborted(input.signal)) return 'ABORTED';
    const code = input.executionFence();
    if (code !== null) return isApplyErrorCode(code) ? code : 'ABORTED';
    return targetFence(retired);
  };
  const readback = (late: boolean): ApplyErrorCode | null => {
    const matches = readValue(record.target) === input.expected;
    if (signalIsAborted(input.signal)) return 'ABORTED';
    return matches ? null : late ? 'LATE_REVERTED' : 'HOST_REJECTED';
  };
  const checkpoint = (late: boolean, retired = false): ApplyErrorCode | null => {
    let code = fence(retired);
    if (code !== null) return code;
    if (readValue(record.target) !== input.expected) return late ? 'LATE_REVERTED' : 'HOST_REJECTED';
    if (classifyHostValidation(input.readHostValidation()) !== 'accepted') return 'HOST_REJECTED';
    code = fence(retired);
    if (code !== null) return code;
    return readback(late);
  };
  try {
    const timeout = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (typeof input.expected !== 'string' || input.expected.length === 0 ||
        !Number.isFinite(timeout) || timeout <= 0 ||
        !Number.isFinite(input.lateRecheckMs) || input.lateRecheckMs <= 0) return fail('CAPABILITY_DISABLED');
    let code = fence();
    if (code !== null) return fail(code);
    if (readValue(record.target) !== '') return fail('IDENTITY_CHANGED');
    let authorized = false;
    const authorizeWrite = input.authorizeWrite;
    let step = await runBoundedStep(async () => {
      authorized = await authorizeWrite() === true;
    }, timeout, input.signal);
    code = stepFailure(step);
    if (code !== null) return fail(code);
    if (!authorized) return fail('CAPABILITY_DISABLED');
    code = fence();
    if (code !== null) return fail(code);
    if (readValue(record.target) !== '') return fail('IDENTITY_CHANGED');
    if (signalIsAborted(input.signal)) return fail('ABORTED');
    attempted = true;
    if (input.writeForward() !== true) return fail('HOST_REJECTED');
    const settle = (signal: AbortSignal) => input.settle ? input.settle(signal) : settleAfterHostWrite(signal);
    step = await runBoundedStep(settle, timeout, input.signal);
    code = stepFailure(step) ?? checkpoint(false);
    if (code !== null) return fail(code);
    step = await runBoundedStep(async (signal) => {
      await Promise.all([
        abortAwareDelay(input.lateRecheckMs, signal),
        input.lateRecheckDelay?.(input.lateRecheckMs, signal),
      ]);
    }, timeout + input.lateRecheckMs, input.signal);
    code = stepFailure(step) ?? checkpoint(true);
    if (code !== null) return fail(code);
    step = await runBoundedStep(settle, timeout, input.signal);
    code = stepFailure(step) ?? checkpoint(true);
    if (code !== null) return fail(code);
    return Object.freeze({ ok: true, observation: Object.freeze({
      check: () => {
        try { return checkpoint(true); }
        catch { return 'HOST_REJECTED' as const; }
      },
      finalize: (retireConsumer?: () => boolean) => {
        let code: ApplyErrorCode | null;
        try {
          code = record.closed ? 'IDENTITY_CHANGED' : checkpoint(true);
          closeTargetRecord(record);
          code ??= checkpoint(true, true);
        } catch {
          closeTargetRecord(record);
          code = 'HOST_REJECTED';
        }
        try {
          if (retireConsumer !== undefined && retireConsumer() !== true) return 'HOST_REJECTED';
          // Cleanup can change the target or value. No caller clock/registry or
          // host-validation callback may run after consumer listeners retire.
          return code ?? targetFence(true) ?? readback(true);
        } catch {
          return 'HOST_REJECTED';
        }
      },
      dispose: () => closeTargetRecord(record),
    }) });
  } catch {
    return fail('HOST_REJECTED');
  }
}

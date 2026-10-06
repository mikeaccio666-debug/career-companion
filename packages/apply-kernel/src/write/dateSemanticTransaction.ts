/**
 * Dormant, vendor-neutral date writer for CAP-AF-002.
 *
 * This leaf accepts only caller-projected values and exact, already-reviewed
 * controls. It does not read Profile collections, discover controls, know an
 * ATS, export from the package, or connect to runner/Extension. A future
 * integrator must deliberately provide the live ScanRoot, signatures, plan
 * fingerprint, write authority, execution fence, and host-validation reader.
 *
 * A split month/year target is logically atomic: the whole bundle is checked
 * and snapshotted before the first mutation, and success is withheld until
 * every part survives immediate and late exact readback. The DOM itself has no
 * transaction primitive, so a mid-write host replacement can leave a proven
 * subset behind. In that case this module may return only an in-memory,
 * exact-subset recovery handle. It never persists Undo, crosses a refresh,
 * clicks, or submits.
 */

import {
  APPLY_ERROR_CODES,
  type ApplyErrorCode,
  type FieldSignature,
  type ScanRoot,
  type WriteTicket,
} from '../contracts';
import { fieldSignature, readValue } from '../fieldIdentity';
import {
  checkActiveCapability,
  consumeAuthority,
  releaseAuthority,
  type HostWriteAuthority,
  type WriteCapability,
} from '../grant';
import { createUndoJournal, type UndoJournal } from '../undo';
import { isTrustedScanRoot } from '../scanRoot';
import {
  resolveSelectOption,
  writeSelectIndex,
  writeTextValue,
} from './setValue';
import {
  classifyHostValidation,
  settleAfterHostWrite,
  WRITE_VERIFICATION_TIMEOUT_MS,
  type HostValidationSignals,
  type HostValidationVerdict,
} from './verify';

export type DateSemanticRole = 'date' | 'month' | 'year';

export interface DateInputPart {
  readonly role: DateSemanticRole;
  readonly control: 'input';
  readonly element: HTMLInputElement;
  readonly signature: FieldSignature;
  /** Exact already-projected DOM value; this leaf never reads a Profile answer. */
  readonly expected: string;
}

export interface DateSelectPart {
  readonly role: Exclude<DateSemanticRole, 'date'>;
  readonly control: 'select';
  readonly element: HTMLSelectElement;
  readonly signature: FieldSignature;
  /** Ordered semantic candidates; option resolution remains unique-or-fail. */
  readonly candidates: readonly [string, ...string[]];
}

export type DateSemanticPart = DateInputPart | DateSelectPart;

export type DateSemanticTarget =
  | {
      readonly kind: 'native-date';
      readonly part: DateInputPart & { readonly role: 'date' };
    }
  | {
      readonly kind: 'native-month';
      readonly part: DateInputPart & { readonly role: 'month' };
    }
  | {
      readonly kind: 'split-month-year';
      readonly month: DateSemanticPart & { readonly role: 'month' };
      readonly year: DateSemanticPart & { readonly role: 'year' };
    };

export interface WriteDateSemanticTransactionInput {
  readonly root: ScanRoot;
  readonly target: DateSemanticTarget;
  /** Must equal the fill authority's exact reviewed-plan fingerprint. */
  readonly fingerprint: string;
  readonly authority: HostWriteAuthority;
  /**
   * Abort/policy/page/submission fence supplied by a future integrator. It
   * must include submission state from roots this leaf cannot observe (for
   * example a non-composed event inside an unreachable shadow root).
   */
  readonly executionFence: () => ApplyErrorCode | null;
  /** Selector-free, read-only host validation collector. */
  readonly readHostValidation: (
    element: HTMLInputElement | HTMLSelectElement,
  ) => HostValidationSignals;
  /** A positive late window is mandatory; zero cannot silently mean success. */
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  /** Bounds the shared, abort-cooperative settle operation. */
  readonly operationTimeoutMs?: number;
}

export type DateTargetedUndoResult =
  | { readonly ok: true; readonly value: { readonly restored: number } }
  | { readonly ok: false; readonly code: ApplyErrorCode };

/**
 * Current-document recovery for exactly the controls this transaction wrote.
 * It is one-shot and monotonic: an intervening edit cannot be hidden by later
 * returning the raw value to the transaction's seal.
 */
export interface DateTargetedUndo {
  readonly requiredCapabilities: () => ReadonlySet<WriteCapability>;
  readonly wasUserEdited: () => boolean;
  readonly isAtWrittenState: () => boolean;
  readonly restore: (authority: HostWriteAuthority) => DateTargetedUndoResult;
  readonly dispose: () => void;
}

export interface DateSemanticWriteSuccess {
  /** `unknown` is reported honestly; it is never promoted to host acceptance. */
  readonly validation: Exclude<HostValidationVerdict, 'rejected'>;
  readonly undo: DateTargetedUndo;
}

export type DateSemanticTransactionResult =
  | { readonly ok: true; readonly value: DateSemanticWriteSuccess }
  | {
      readonly ok: false;
      readonly code: ApplyErrorCode;
      /** Present only while an exact current-document subset remains owned. */
      readonly recovery?: DateTargetedUndo;
    };

type AsyncStepOutcome = 'ok' | 'aborted' | 'failed';

interface OptionSnapshotEntry {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

interface PreparedPart {
  readonly source: DateSemanticPart;
  readonly targetKind: DateSemanticTarget['kind'];
  readonly targetIndex: number;
  readonly element: HTMLInputElement | HTMLSelectElement;
  readonly capability: Extract<WriteCapability, 'set-text' | 'set-select'>;
  readonly signature: FieldSignature;
  readonly scopeKey: string;
  readonly expectedRaw: string;
  readonly expectedSelectedIndex: number | null;
  readonly previousValue: string;
  readonly previousSelectedIndex: number | null;
  readonly ownerDocument: Document;
  readonly rootNode: Node;
  readonly form: HTMLFormElement | null;
  readonly parent: Element | null;
  readonly optionSnapshot: readonly OptionSnapshotEntry[] | null;
  ticket: WriteTicket | null;
  writeAttempted: boolean;
  writtenValue: string | null;
  writtenSelectedIndex: number | null;
}

interface TransactionState {
  readonly input: WriteDateSemanticTransactionInput;
  readonly journal: UndoJournal;
  readonly fence: DateEventFence;
  readonly parts: readonly PreparedPart[];
}

interface DateEventFence {
  readonly beginExpectedWrite: (element: HTMLInputElement | HTMLSelectElement) => boolean;
  readonly finishExpectedWrite: () => boolean;
  readonly cancelExpectedWrite: () => void;
  readonly wasExternallyEdited: () => boolean;
  readonly hostSubmitted: () => boolean;
  readonly dispose: () => void;
}

const APPLY_ERROR_CODE_SET: ReadonlySet<string> = new Set(APPLY_ERROR_CODES);
const DEFAULT_OPERATION_TIMEOUT_MS = WRITE_VERIFICATION_TIMEOUT_MS + 100;
const OBSERVED_EDIT_EVENTS = ['beforeinput', 'input', 'change'] as const;

function failure(code: ApplyErrorCode): DateSemanticTransactionResult {
  return { ok: false, code };
}

function isApplyErrorCode(value: unknown): value is ApplyErrorCode {
  return typeof value === 'string' && APPLY_ERROR_CODE_SET.has(value);
}

function authorityBindingFailure(
  authority: unknown,
  purpose: 'fill' | 'undo',
  fingerprint: string | null,
): 'GESTURE_UNTRUSTED' | 'PLAN_STALE' | null {
  if (typeof authority !== 'object' || authority === null) return 'GESTURE_UNTRUSTED';
  try {
    const candidate = authority as Partial<HostWriteAuthority>;
    return candidate.purpose === purpose && candidate.fingerprint === fingerprint
      ? null
      : 'PLAN_STALE';
  } catch {
    return 'GESTURE_UNTRUSTED';
  }
}

function usableAbortSignal(signal: unknown): signal is AbortSignal | undefined {
  if (signal === undefined) return true;
  if (typeof signal !== 'object' || signal === null) return false;
  try {
    const candidate = signal as Partial<AbortSignal>;
    if (
      typeof candidate.aborted !== 'boolean' ||
      typeof candidate.addEventListener !== 'function' ||
      typeof candidate.removeEventListener !== 'function'
    ) {
      return false;
    }
    const probe = () => undefined;
    candidate.addEventListener.call(signal, 'abort', probe, { once: true });
    candidate.removeEventListener.call(signal, 'abort', probe);
    return true;
  } catch {
    return false;
  }
}

function abortSignalIsAborted(signal?: AbortSignal): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
}

function targetParts(target: DateSemanticTarget): readonly DateSemanticPart[] | null {
  try {
    if (target.kind === 'native-date' || target.kind === 'native-month') {
      return [target.part];
    }
    if (target.kind === 'split-month-year') return [target.month, target.year];
  } catch {
    return null;
  }
  return null;
}

function optionSnapshot(element: HTMLSelectElement): readonly OptionSnapshotEntry[] {
  return Object.freeze(
    [...element.options].map((option) =>
      Object.freeze({
        value: option.value,
        label: visibleOptionLabel(option),
        disabled: effectivelyDisabled(option),
      }),
    ),
  );
}

function visibleOptionLabel(option: HTMLOptionElement): string {
  try {
    return option.getAttribute('label') ?? option.text;
  } catch {
    return '';
  }
}

function attributeIsTrue(element: Element, name: string): boolean {
  try {
    return element.getAttribute(name)?.trim().toLowerCase() === 'true';
  } catch {
    return true;
  }
}

function disabledByAncestor(element: Element): boolean {
  try {
    const visited = new Set<Element>();
    let ancestor: Element | null = element.parentElement;
    if (!ancestor) {
      const root = element.getRootNode();
      ancestor = root instanceof ShadowRoot ? root.host : null;
    }
    while (ancestor && !visited.has(ancestor)) {
      visited.add(ancestor);
      if (attributeIsTrue(ancestor, 'aria-disabled')) return true;
      const parent = ancestor.parentElement;
      if (parent) {
        ancestor = parent;
        continue;
      }
      const root = ancestor.getRootNode();
      ancestor = root instanceof ShadowRoot ? root.host : null;
    }

    if (element instanceof HTMLOptionElement) {
      const group = element.parentElement;
      if (
        group instanceof HTMLOptGroupElement &&
        (group.disabled || attributeIsTrue(group, 'aria-disabled'))
      ) {
        return true;
      }
    }

    let fieldset = element.closest('fieldset[disabled]');
    while (fieldset instanceof HTMLFieldSetElement) {
      const firstLegend = [...fieldset.children].find(
        (child) => child instanceof HTMLLegendElement,
      );
      if (!firstLegend?.contains(element)) return true;
      fieldset = fieldset.parentElement?.closest('fieldset[disabled]') ?? null;
    }
    return false;
  } catch {
    return true;
  }
}

function effectivelyDisabled(
  element: HTMLInputElement | HTMLSelectElement | HTMLOptionElement,
): boolean {
  try {
    return (
      element.disabled ||
      element.matches(':disabled') ||
      disabledByAncestor(element) ||
      attributeIsTrue(element, 'aria-disabled')
    );
  } catch {
    return true;
  }
}

function sameOptionSnapshot(
  current: readonly OptionSnapshotEntry[],
  sealed: readonly OptionSnapshotEntry[],
): boolean {
  return (
    current.length === sealed.length &&
    current.every(
      (option, index) =>
        option.value === sealed[index]?.value &&
        option.label === sealed[index]?.label &&
        option.disabled === sealed[index]?.disabled,
    )
  );
}

function resolveSelectCandidate(
  part: DateSelectPart,
):
  | {
      readonly ok: true;
      readonly value: string;
      readonly selectedIndex: number;
    }
  | { readonly ok: false; readonly code: 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION' | 'NO_VALUE' } {
  if (
    !Array.isArray(part.candidates) ||
    part.candidates.length === 0 ||
    part.candidates.some((candidate) => typeof candidate !== 'string' || candidate.trim() === '')
  ) {
    return { ok: false, code: 'NO_VALUE' };
  }

  const options = [...part.element.options];
  const semanticOptions = options.map((option) => ({
    value: option.value,
    text: visibleOptionLabel(option),
  }));
  let sawAmbiguous = false;
  for (const candidate of part.candidates) {
    const resolved = resolveSelectOption(semanticOptions, candidate);
    if (resolved === 'AMBIGUOUS_OPTION') {
      sawAmbiguous = true;
      continue;
    }
    if (resolved === 'NO_OPTION_MATCH') continue;
    const option = options[resolved.index];
    if (!option || option.value.trim() === '' || effectivelyDisabled(option)) {
      return { ok: false, code: 'NO_OPTION_MATCH' };
    }
    return { ok: true, value: option.value, selectedIndex: resolved.index };
  }
  return {
    ok: false,
    code: sawAmbiguous ? 'AMBIGUOUS_OPTION' : 'NO_OPTION_MATCH',
  };
}

function validNativeValue(kind: DateSemanticTarget['kind'], expected: string): boolean {
  if (kind === 'native-date') return /^\d{4}-\d{2}-\d{2}$/.test(expected);
  if (kind === 'native-month') return /^\d{4}-\d{2}$/.test(expected);
  return expected.trim() !== '';
}

function partShapeIsValid(
  targetKind: DateSemanticTarget['kind'],
  part: DateSemanticPart,
  index: number,
): boolean {
  if (part.control === 'input') {
    if (!(part.element instanceof HTMLInputElement)) return false;
    if (targetKind === 'native-date') {
      return index === 0 && part.role === 'date' && part.element.type === 'date';
    }
    if (targetKind === 'native-month') {
      return index === 0 && part.role === 'month' && part.element.type === 'month';
    }
    return (
      targetKind === 'split-month-year' &&
      (part.role === 'month' || part.role === 'year') &&
      (part.element.type === 'text' || part.element.type === 'number')
    );
  }
  return (
    targetKind === 'split-month-year' &&
    part.element instanceof HTMLSelectElement &&
    !part.element.multiple &&
    (part.role === 'month' || part.role === 'year')
  );
}

function exactSignatureIsCurrent(part: PreparedPart, root: ScanRoot): boolean {
  try {
    if (root.isExcluded(part.element)) return false;
    const scope = root.identityScope(part.element);
    if (scope.scopeKey !== part.scopeKey || !scope.controls.includes(part.element)) return false;
    const current = fieldSignature(part.element, root, scope);
    return (
      current.core === part.signature.core &&
      current.labelHint === part.signature.labelHint
    );
  } catch {
    return false;
  }
}

function identityFailure(part: PreparedPart, root: ScanRoot): ApplyErrorCode | null {
  try {
    if (!part.element.isConnected) return 'DETACHED';
    if (
      part.element.ownerDocument !== part.ownerDocument ||
      part.element.getRootNode() !== part.rootNode ||
      part.element.form !== part.form ||
      part.element.parentElement !== part.parent
    ) {
      return 'IDENTITY_CHANGED';
    }
    if (!partShapeIsValid(part.targetKind, part.source, part.targetIndex)) {
      return 'IDENTITY_CHANGED';
    }
    if (!exactSignatureIsCurrent(part, root)) return 'IDENTITY_CHANGED';
    if (
      part.optionSnapshot !== null &&
      (part.element instanceof HTMLSelectElement
        ? !sameOptionSnapshot(optionSnapshot(part.element), part.optionSnapshot)
        : true)
    ) {
      return 'IDENTITY_CHANGED';
    }
    return null;
  } catch {
    return 'IDENTITY_CHANGED';
  }
}

function writabilityFailure(part: PreparedPart): ApplyErrorCode | null {
  try {
    if (effectivelyDisabled(part.element)) return 'TARGET_NOT_WRITABLE';
    if (attributeIsTrue(part.element, 'aria-readonly')) return 'TARGET_NOT_WRITABLE';
    if (part.element instanceof HTMLInputElement && part.element.readOnly) {
      return 'TARGET_NOT_WRITABLE';
    }
    return null;
  } catch {
    return 'TARGET_NOT_WRITABLE';
  }
}

function isAtRawPosition(
  part: PreparedPart,
  value: string,
  selectedIndex: number | null,
): boolean {
  try {
    if (readValue(part.element) !== value) return false;
    return !(
      part.element instanceof HTMLSelectElement &&
      selectedIndex !== null &&
      part.element.selectedIndex !== selectedIndex
    );
  } catch {
    return false;
  }
}

function isAtWrittenPosition(part: PreparedPart): boolean {
  return (
    part.writtenValue !== null &&
    isAtRawPosition(part, part.writtenValue, part.writtenSelectedIndex)
  );
}

function isAtPreWritePosition(part: PreparedPart): boolean {
  return isAtRawPosition(part, part.previousValue, part.previousSelectedIndex);
}

function sealExpectedResidual(part: PreparedPart, journal: UndoJournal): boolean {
  let current: string;
  try {
    current = readValue(part.element);
  } catch {
    return false;
  }
  if (current !== part.expectedRaw) return false;
  part.writtenValue = current;
  part.writtenSelectedIndex =
    part.element instanceof HTMLSelectElement ? part.element.selectedIndex : null;
  if (!part.ticket) return false;
  journal.commit(part.ticket, current);
  return true;
}

function preparePartsUnchecked(
  input: WriteDateSemanticTransactionInput,
):
  | { readonly ok: true; readonly value: PreparedPart[] }
  | { readonly ok: false; readonly code: ApplyErrorCode } {
  const sources = targetParts(input.target);
  if (sources === null || sources.length < 1 || sources.length > 2) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  if (new Set(sources.map((part) => part.element)).size !== sources.length) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  if (
    input.target.kind === 'split-month-year' &&
    (sources[0]?.role !== 'month' || sources[1]?.role !== 'year')
  ) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  if (
    input.target.kind === 'split-month-year' &&
    (sources[0]?.element.ownerDocument !== sources[1]?.element.ownerDocument ||
      sources[0]?.element.getRootNode() !== sources[1]?.element.getRootNode() ||
      sources[0]?.element.form !== sources[1]?.element.form)
  ) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }

  const prepared: PreparedPart[] = [];
  for (const [index, source] of sources.entries()) {
    if (!partShapeIsValid(input.target.kind, source, index)) {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
    if (!source.element.isConnected) return { ok: false, code: 'DETACHED' };
    if (
      effectivelyDisabled(source.element) ||
      attributeIsTrue(source.element, 'aria-readonly') ||
      (source.control === 'input' && source.element.readOnly)
    ) {
      return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    }
    let expectedRaw: string;
    let expectedSelectedIndex: number | null = null;
    if (source.control === 'input') {
      if (
        typeof source.expected !== 'string' ||
        !validNativeValue(input.target.kind, source.expected)
      ) {
        return { ok: false, code: 'NO_VALUE' };
      }
      expectedRaw = source.expected;
    } else {
      const resolved = resolveSelectCandidate(source);
      if (!resolved.ok) return resolved;
      expectedRaw = resolved.value;
      expectedSelectedIndex = resolved.selectedIndex;
    }

    let previousValue: string;
    try {
      previousValue = readValue(source.element);
    } catch {
      return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
    }
    let scopeKey: string;
    try {
      scopeKey = input.root.identityScope(source.element).scopeKey;
    } catch {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
    if (typeof scopeKey !== 'string') return { ok: false, code: 'IDENTITY_CHANGED' };
    if (previousValue.trim() !== '') return { ok: false, code: 'NOT_EMPTY' };

    const part: PreparedPart = {
      source,
      targetKind: input.target.kind,
      targetIndex: index,
      element: source.element,
      capability: source.control === 'select' ? 'set-select' : 'set-text',
      signature: source.signature,
      scopeKey,
      expectedRaw,
      expectedSelectedIndex,
      previousValue,
      previousSelectedIndex:
        source.element instanceof HTMLSelectElement ? source.element.selectedIndex : null,
      ownerDocument: source.element.ownerDocument,
      rootNode: source.element.getRootNode(),
      form: source.element.form,
      parent: source.element.parentElement,
      optionSnapshot:
        source.element instanceof HTMLSelectElement ? optionSnapshot(source.element) : null,
      ticket: null,
      writeAttempted: false,
      writtenValue: null,
      writtenSelectedIndex: null,
    };
    const identity = identityFailure(part, input.root);
    if (identity !== null) return { ok: false, code: identity };
    prepared.push(part);
  }
  if (
    prepared.length === 2 &&
    (prepared[0]!.scopeKey !== '' || prepared[1]!.scopeKey !== '') &&
    prepared[0]!.scopeKey !== prepared[1]!.scopeKey
  ) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  // Two root-scope controls both use ''. Only a future reviewed collection
  // projection can prove their logical pairing; this dormant writer merely
  // enforces that any available row identity is never crossed.
  return { ok: true, value: prepared };
}

function prepareParts(
  input: WriteDateSemanticTransactionInput,
):
  | { readonly ok: true; readonly value: PreparedPart[] }
  | { readonly ok: false; readonly code: ApplyErrorCode } {
  try {
    return preparePartsUnchecked(input);
  } catch {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
}

function createDateEventFence(parts: readonly PreparedPart[]): DateEventFence | null {
  let disposed = false;
  let externallyEdited = false;
  let submitted = false;
  let expected: {
    readonly element: HTMLInputElement | HTMLSelectElement;
    readonly events: readonly ['input', 'change'];
    index: number;
  } | null = null;
  const removers: Array<() => void> = [];

  const observeEdit = (event: Event) => {
    if (disposed) return;
    if (
      expected !== null &&
      event.target === expected.element &&
      event.type === expected.events[expected.index]
    ) {
      expected.index += 1;
      return;
    }
    externallyEdited = true;
  };
  const observeSubmit = () => {
    if (!disposed) submitted = true;
  };

  try {
    for (const part of parts) {
      for (const type of OBSERVED_EDIT_EVENTS) {
        part.element.addEventListener(type, observeEdit, true);
        removers.push(() => part.element.removeEventListener(type, observeEdit, true));
      }
    }
    for (const form of new Set(parts.map((part) => part.form).filter((form) => form !== null))) {
      form.addEventListener('reset', observeEdit, true);
      form.addEventListener('submit', observeSubmit, true);
      form.addEventListener('formdata', observeSubmit, true);
      removers.push(() => form.removeEventListener('reset', observeEdit, true));
      removers.push(() => form.removeEventListener('submit', observeSubmit, true));
      removers.push(() => form.removeEventListener('formdata', observeSubmit, true));
    }
    for (const ownerDocument of new Set(parts.map((part) => part.ownerDocument))) {
      ownerDocument.addEventListener('submit', observeSubmit, true);
      ownerDocument.addEventListener('formdata', observeSubmit, true);
      removers.push(() => ownerDocument.removeEventListener('submit', observeSubmit, true));
      removers.push(() => ownerDocument.removeEventListener('formdata', observeSubmit, true));
    }
    for (const rootNode of new Set(parts.map((part) => part.rootNode))) {
      if (rootNode instanceof Document) continue;
      rootNode.addEventListener('submit', observeSubmit, true);
      rootNode.addEventListener('formdata', observeSubmit, true);
      removers.push(() => rootNode.removeEventListener('submit', observeSubmit, true));
      removers.push(() => rootNode.removeEventListener('formdata', observeSubmit, true));
    }
    for (const view of new Set(parts.map((part) => part.ownerDocument.defaultView))) {
      view?.addEventListener('beforeunload', observeSubmit, true);
      removers.push(() => view?.removeEventListener('beforeunload', observeSubmit, true));
    }
  } catch {
    for (const remove of removers.reverse()) {
      try {
        remove();
      } catch {
        // No recovery authority is returned from a failed observer setup.
      }
    }
    return null;
  }

  return {
    beginExpectedWrite(element) {
      if (disposed || externallyEdited || submitted || expected !== null) return false;
      expected = { element, events: ['input', 'change'], index: 0 };
      return true;
    },
    finishExpectedWrite() {
      if (expected === null) return false;
      const complete = expected.index === expected.events.length;
      expected = null;
      if (!complete) externallyEdited = true;
      return complete && !externallyEdited && !submitted;
    },
    cancelExpectedWrite() {
      expected = null;
    },
    wasExternallyEdited: () => disposed || externallyEdited,
    hostSubmitted: () => submitted,
    dispose() {
      if (disposed) return;
      disposed = true;
      expected = null;
      for (const remove of removers.reverse()) {
        try {
          remove();
        } catch {
          // Listener cleanup cannot re-arm this one-shot recovery handle.
        }
      }
    },
  };
}

function readExecutionFence(
  input: WriteDateSemanticTransactionInput,
  fence: DateEventFence,
  includeOperationSignal: boolean = true,
): ApplyErrorCode | null {
  if (fence.hostSubmitted()) return 'HOST_SUBMITTED';
  try {
    if (includeOperationSignal && input.signal?.aborted) return 'ABORTED';
  } catch {
    return 'ABORTED';
  }
  try {
    const code: unknown = input.executionFence();
    if (code === null) return null;
    return isApplyErrorCode(code) ? code : 'ABORTED';
  } catch {
    return 'ABORTED';
  }
}

function bundleIdentityFailure(state: TransactionState): ApplyErrorCode | null {
  for (const part of state.parts) {
    const identity = identityFailure(part, state.input.root);
    if (identity !== null) return identity;
    const writable = writabilityFailure(part);
    if (writable !== null) return writable;
  }
  return null;
}

function forwardProgressFailure(state: TransactionState): ApplyErrorCode | null {
  for (const part of state.parts) {
    if (part.writtenValue !== null) {
      if (!isAtWrittenPosition(part)) return 'VALUE_COERCED';
      continue;
    }
    if (!isAtPreWritePosition(part)) {
      try {
        return readValue(part.element).trim() === '' ? 'VALUE_COERCED' : 'NOT_EMPTY';
      } catch {
        return 'IDENTITY_CHANGED';
      }
    }
  }
  return null;
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

function runBoundedStep(
  operation: (signal: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<AsyncStepOutcome> {
  if (abortSignalIsAborted(parentSignal)) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operationAbort = new AbortController();
    const finish = (outcome: AsyncStepOutcome) => {
      if (complete) return;
      complete = true;
      if (timer !== null) clearTimeout(timer);
      try {
        parentSignal?.removeEventListener('abort', onAbort);
      } catch {
        // The outcome is already terminal; listener cleanup cannot change it.
      }
      resolve(outcome);
    };
    const stop = (outcome: Exclude<AsyncStepOutcome, 'ok'>) => {
      operationAbort.abort();
      finish(outcome);
    };
    const onAbort = () => stop('aborted');

    timer = setTimeout(() => stop('failed'), timeoutMs);
    try {
      parentSignal?.addEventListener('abort', onAbort, { once: true });
    } catch {
      stop('aborted');
      return;
    }
    if (abortSignalIsAborted(parentSignal)) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => operation(operationAbort.signal))
      .then(
        () => finish(abortSignalIsAborted(parentSignal) ? 'aborted' : 'ok'),
        () => stop(abortSignalIsAborted(parentSignal) ? 'aborted' : 'failed'),
      );
  });
}

function stepFailure(outcome: AsyncStepOutcome): ApplyErrorCode | null {
  if (outcome === 'ok') return null;
  return outcome === 'aborted' ? 'ABORTED' : 'VERIFY_TIMEOUT';
}

function checkpointFailure(
  state: TransactionState,
  phase: 'initial' | 'late',
): ApplyErrorCode | null {
  const fence = readExecutionFence(state.input, state.fence);
  if (fence !== null) return fence;
  if (state.fence.wasExternallyEdited()) return 'ABORTED';
  const identity = bundleIdentityFailure(state);
  if (identity !== null) return identity;

  let allWritten = true;
  let allPrevious = true;
  for (const part of state.parts) {
    allWritten &&= isAtWrittenPosition(part);
    allPrevious &&= isAtPreWritePosition(part);
  }
  if (allWritten) return null;
  if (phase === 'late') return 'LATE_REVERTED';
  return allPrevious ? 'WRITE_REVERTED' : 'VALUE_COERCED';
}

function readBundleValidation(
  state: TransactionState,
):
  | { readonly ok: true; readonly verdict: Exclude<HostValidationVerdict, 'rejected'> }
  | { readonly ok: false; readonly code: ApplyErrorCode } {
  let unknown = false;
  for (const part of state.parts) {
    let verdict: HostValidationVerdict = 'unknown';
    try {
      verdict = classifyHostValidation(state.input.readHostValidation(part.element));
    } catch {
      verdict = 'unknown';
    }
    const fence = readExecutionFence(state.input, state.fence);
    if (fence !== null) return { ok: false, code: fence };
    if (state.fence.wasExternallyEdited()) return { ok: false, code: 'ABORTED' };
    const identity = bundleIdentityFailure(state);
    if (identity !== null) return { ok: false, code: identity };
    if (verdict === 'rejected') return { ok: false, code: 'HOST_REJECTED' };
    if (verdict === 'unknown') unknown = true;
  }
  return { ok: true, verdict: unknown ? 'unknown' : 'accepted' };
}

function exactWrittenParts(state: TransactionState): boolean {
  if (state.fence.wasExternallyEdited() || state.fence.hostSubmitted()) return false;
  for (const part of state.parts) {
    if (part.writtenValue === null) return false;
    if (identityFailure(part, state.input.root) !== null) return false;
    if (writabilityFailure(part) !== null) return false;
    if (!isAtWrittenPosition(part)) return false;
  }
  return true;
}

function exactPreWriteParts(state: TransactionState): boolean {
  for (const part of state.parts) {
    if (identityFailure(part, state.input.root) !== null) return false;
    if (writabilityFailure(part) !== null) return false;
    if (!isAtPreWritePosition(part)) return false;
  }
  return true;
}

function exactRestoreProgress(
  state: TransactionState,
  restored: ReadonlySet<PreparedPart>,
): boolean {
  if (state.fence.wasExternallyEdited() || state.fence.hostSubmitted()) return false;
  for (const part of state.parts) {
    if (identityFailure(part, state.input.root) !== null) return false;
    if (writabilityFailure(part) !== null) return false;
    if (restored.has(part) ? !isAtPreWritePosition(part) : !isAtWrittenPosition(part)) {
      return false;
    }
  }
  return true;
}

function createTargetedUndo(state: TransactionState): DateTargetedUndo {
  let retired = false;
  let restoreSpent = false;

  const retire = () => {
    if (retired) return;
    retired = true;
    state.fence.dispose();
    state.journal.clear();
  };

  return {
    requiredCapabilities: () =>
      new Set(state.parts.map((part) => part.capability)),
    wasUserEdited: () => retired || state.fence.wasExternallyEdited(),
    isAtWrittenState: () => !retired && !restoreSpent && exactWrittenParts(state),
    restore(authority) {
      if (retired || restoreSpent) return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
      if (state.fence.hostSubmitted()) {
        retire();
        return { ok: false, code: 'HOST_SUBMITTED' };
      }
      if (state.fence.wasExternallyEdited()) {
        retire();
        return { ok: false, code: 'ABORTED' };
      }
      // The forward AbortSignal bounds only this write attempt. Recovery is a
      // separate, fresh user-authorized operation; page/session invalidation
      // must remain represented by the live executionFence and identity proof.
      const initialExecution = readExecutionFence(state.input, state.fence, false);
      if (initialExecution !== null) {
        if (initialExecution === 'HOST_SUBMITTED') retire();
        return { ok: false, code: initialExecution };
      }
      for (const part of state.parts) {
        const identity = identityFailure(part, state.input.root);
        if (identity !== null) {
          retire();
          return { ok: false, code: identity };
        }
        const writable = writabilityFailure(part);
        if (writable !== null) return { ok: false, code: writable };
      }
      if (!exactWrittenParts(state)) {
        retire();
        return { ok: false, code: 'VALUE_COERCED' };
      }
      const bindingFailure = authorityBindingFailure(authority, 'undo', null);
      if (bindingFailure !== null) return { ok: false, code: bindingFailure };

      const consumed = consumeAuthority(authority);
      if (!consumed.ok) return consumed;
      try {
        for (const capability of new Set(state.parts.map((part) => part.capability))) {
          const access = checkActiveCapability(consumed.value, capability);
          if (!access.ok) return access;
        }

        // Spend before the first restore mutation so raw-value ABA can never
        // re-arm this control-specific Undo capability.
        restoreSpent = true;
        let restored = 0;
        const restoredParts = new Set<PreparedPart>();
        for (const part of [...state.parts].reverse()) {
          const execution = readExecutionFence(state.input, state.fence, false);
          if (execution !== null) {
            retire();
            return { ok: false, code: execution };
          }
          if (!exactRestoreProgress(state, restoredParts)) {
            retire();
            return { ok: false, code: 'VALUE_COERCED' };
          }
          if (!part.ticket || !state.fence.beginExpectedWrite(part.element)) {
            retire();
            return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
          }
          // The original opaque ticket proves this exact control was locally
          // snapshotted before the forward mutation. A fresh `purpose: undo`
          // authority supplies the separate runtime permission for restore;
          // the ticket itself never grants a capability.
          const restoredPart =
            (() => {
              try {
                return part.element instanceof HTMLSelectElement
                  ? writeSelectIndex(
                      part.element,
                      part.previousSelectedIndex ?? -1,
                      consumed.value,
                      part.ticket!,
                    )
                  : writeTextValue(
                      part.element,
                      part.previousValue,
                      consumed.value,
                      part.ticket!,
                    );
              } catch {
                return { ok: false as const, code: 'WRITE_REVERTED' as const };
              }
            })();
          if (!restoredPart.ok) {
            state.fence.cancelExpectedWrite();
            const submitted = state.fence.hostSubmitted();
            const externallyEdited = state.fence.wasExternallyEdited();
            const postFailureExecution = readExecutionFence(
              state.input,
              state.fence,
              false,
            );
            retire();
            if (submitted || postFailureExecution === 'HOST_SUBMITTED') {
              return { ok: false, code: 'HOST_SUBMITTED' };
            }
            if (externallyEdited) return { ok: false, code: 'ABORTED' };
            if (postFailureExecution !== null) {
              return { ok: false, code: postFailureExecution };
            }
            return restoredPart;
          }
          const eventsObserved = state.fence.finishExpectedWrite();
          if (state.fence.hostSubmitted()) {
            retire();
            return { ok: false, code: 'HOST_SUBMITTED' };
          }
          if (!eventsObserved || state.fence.wasExternallyEdited()) {
            retire();
            return { ok: false, code: 'ABORTED' };
          }
          const postWriteExecution = readExecutionFence(state.input, state.fence, false);
          if (postWriteExecution !== null) {
            retire();
            return { ok: false, code: postWriteExecution };
          }
          restoredParts.add(part);
          if (!exactRestoreProgress(state, restoredParts)) {
            retire();
            return { ok: false, code: 'WRITE_REVERTED' };
          }
          restored += 1;
        }
        if (!exactPreWriteParts(state)) {
          retire();
          return { ok: false, code: 'WRITE_REVERTED' };
        }
        const finalExecution = readExecutionFence(state.input, state.fence, false);
        if (finalExecution !== null) {
          retire();
          return { ok: false, code: finalExecution };
        }
        retire();
        return { ok: true, value: { restored } };
      } finally {
        releaseAuthority(consumed.value);
      }
    },
    dispose: retire,
  };
}

function failureWithRecovery(
  state: TransactionState,
  code: ApplyErrorCode,
): DateSemanticTransactionResult {
  if (
    code === 'HOST_SUBMITTED' ||
    state.fence.hostSubmitted() ||
    state.fence.wasExternallyEdited()
  ) {
    state.fence.dispose();
    state.journal.clear();
    return failure(code === 'HOST_SUBMITTED' || state.fence.hostSubmitted() ? 'HOST_SUBMITTED' : 'ABORTED');
  }

  const retained: PreparedPart[] = [];
  let thirdState = false;
  for (const part of state.parts) {
    if (!part.ticket) continue;
    if (part.writtenValue === null) {
      if (part.writeAttempted && !isAtPreWritePosition(part)) thirdState = true;
      state.journal.abandon(part.ticket);
      continue;
    }
    const identity = identityFailure(part, state.input.root);
    const writable = writabilityFailure(part);
    if (identity !== null || writable !== null) {
      state.journal.abandon(part.ticket);
      thirdState = true;
      continue;
    }
    if (isAtPreWritePosition(part)) {
      state.journal.abandon(part.ticket);
    } else if (isAtWrittenPosition(part)) {
      retained.push(part);
    } else {
      state.journal.abandon(part.ticket);
      thirdState = true;
    }
  }

  if (thirdState || retained.length === 0) {
    state.fence.dispose();
    state.journal.clear();
    return failure(code);
  }
  const retainedSet = new Set(retained);
  for (const part of state.parts) {
    if (part.ticket && !retainedSet.has(part)) state.journal.abandon(part.ticket);
  }
  const recovery = createTargetedUndo({ ...state, parts: retained });
  return { ok: false, code, recovery };
}

function recordAllParts(state: TransactionState): ApplyErrorCode | null {
  for (const part of state.parts) {
    const recorded = state.journal.record(part.element);
    if (!recorded.ok) return recorded.code;
    part.ticket = recorded.value;
    try {
      // Adjacent re-read prevents a hostile/dynamic getter from making the
      // journal snapshot disagree with the local semantic checkpoint.
      if (readValue(part.element) !== part.previousValue) return 'JOURNAL_UNAVAILABLE';
    } catch {
      return 'JOURNAL_UNAVAILABLE';
    }
  }
  return null;
}

function writeAllParts(
  state: TransactionState,
  authority: HostWriteAuthority,
): ApplyErrorCode | null {
  for (const part of state.parts) {
    const execution = readExecutionFence(state.input, state.fence);
    if (execution !== null) return execution;
    if (state.fence.wasExternallyEdited()) return 'ABORTED';
    const identity = bundleIdentityFailure(state);
    if (identity !== null) return identity;
    const progress = forwardProgressFailure(state);
    if (progress !== null) return progress;
    if (!part.ticket || !state.fence.beginExpectedWrite(part.element)) {
      return 'JOURNAL_UNAVAILABLE';
    }
    let primitiveFailure: ApplyErrorCode | null = null;
    part.writeAttempted = true;
    try {
      if (part.element instanceof HTMLSelectElement) {
        const result = writeSelectIndex(
          part.element,
          part.expectedSelectedIndex ?? -1,
          authority,
          part.ticket,
        );
        if (!result.ok) primitiveFailure = result.code;
      } else {
        const result = writeTextValue(
          part.element,
          part.expectedRaw,
          authority,
          part.ticket,
        );
        if (!result.ok) primitiveFailure = result.code;
      }
    } catch {
      state.fence.cancelExpectedWrite();
      // The native setter runs before host notification. If notification
      // throws, retain recovery only when the exact requested raw state proves
      // this transaction owns the residual mutation.
      sealExpectedResidual(part, state.journal);
      const executionAfterThrow = readExecutionFence(state.input, state.fence);
      if (executionAfterThrow !== null) return executionAfterThrow;
      if (state.fence.wasExternallyEdited()) return 'ABORTED';
      const identityAfterThrow = bundleIdentityFailure(state);
      if (identityAfterThrow !== null) return identityAfterThrow;
      return 'WRITE_REVERTED';
    }
    if (primitiveFailure !== null) {
      if (
        primitiveFailure === 'NO_OPTION_MATCH' &&
        part.element instanceof HTMLSelectElement
      ) {
        if (isAtPreWritePosition(part)) {
          state.fence.cancelExpectedWrite();
          return 'WRITE_REVERTED';
        }
        const eventsObserved = state.fence.finishExpectedWrite();
        if (state.fence.hostSubmitted()) return 'HOST_SUBMITTED';
        if (!eventsObserved || state.fence.wasExternallyEdited()) return 'ABORTED';
        sealExpectedResidual(part, state.journal);
        const executionAfterCoercion = readExecutionFence(state.input, state.fence);
        if (executionAfterCoercion !== null) return executionAfterCoercion;
        const identityAfterCoercion = bundleIdentityFailure(state);
        if (identityAfterCoercion !== null) return identityAfterCoercion;
        return 'VALUE_COERCED';
      }
      state.fence.cancelExpectedWrite();
      return primitiveFailure;
    }
    const eventsObserved = state.fence.finishExpectedWrite();
    if (!eventsObserved || state.fence.wasExternallyEdited()) return 'ABORTED';
    if (state.fence.hostSubmitted()) return 'HOST_SUBMITTED';
    let current: string;
    try {
      current = readValue(part.element);
    } catch {
      return 'IDENTITY_CHANGED';
    }
    if (current === part.expectedRaw) {
      // Seal the exact property state produced by this writer before applying
      // the semantic verdict. A select can expose the requested raw value yet
      // land on a different same-valued option; that is a failure, but it is
      // still our exact state and therefore receives targeted recovery.
      part.writtenValue = current;
      part.writtenSelectedIndex =
        part.element instanceof HTMLSelectElement ? part.element.selectedIndex : null;
      state.journal.commit(part.ticket, current);
    }
    const postWriteExecution = readExecutionFence(state.input, state.fence);
    if (postWriteExecution !== null) return postWriteExecution;
    const postWriteIdentity = bundleIdentityFailure(state);
    if (postWriteIdentity !== null) return postWriteIdentity;
    const selectedIndexMatches =
      !(part.element instanceof HTMLSelectElement) ||
      part.expectedSelectedIndex === null ||
      part.element.selectedIndex === part.expectedSelectedIndex;
    if (current !== part.expectedRaw || !selectedIndexMatches) {
      return isAtPreWritePosition(part) ? 'WRITE_REVERTED' : 'VALUE_COERCED';
    }
    const postWriteProgress = forwardProgressFailure(state);
    if (postWriteProgress !== null) return postWriteProgress;
  }
  return null;
}

/**
 * Write and semantically settle one native date/month or coupled month/year.
 *
 * The function consumes exactly one fill authority for the synchronous host
 * writes and releases it before the first await. The returned Undo requires a
 * fresh, null-fingerprint `purpose: undo` authority and never survives memory.
 */
export async function writeDateSemanticTransaction(
  input: WriteDateSemanticTransactionInput,
): Promise<DateSemanticTransactionResult> {
  if (
    !input ||
    !isTrustedScanRoot(input.root) ||
    typeof input.fingerprint !== 'string' ||
    input.fingerprint === '' ||
    typeof input.executionFence !== 'function' ||
    typeof input.readHostValidation !== 'function' ||
    !Number.isFinite(input.lateRecheckMs) ||
    input.lateRecheckMs <= 0 ||
    !usableAbortSignal(input.signal)
  ) {
    return failure('CAPABILITY_DISABLED');
  }
  const operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    return failure('CAPABILITY_DISABLED');
  }

  const prepared = prepareParts(input);
  if (!prepared.ok) return prepared;
  const journal = createUndoJournal();
  const fence = createDateEventFence(prepared.value);
  if (!fence) return failure('JOURNAL_UNAVAILABLE');
  const state: TransactionState = { input, journal, fence, parts: prepared.value };

  const initialFence = readExecutionFence(input, fence);
  if (initialFence !== null) {
    fence.dispose();
    return failure(initialFence);
  }
  const bindingFailure = authorityBindingFailure(
    input.authority,
    'fill',
    input.fingerprint,
  );
  if (bindingFailure !== null) {
    fence.dispose();
    return failure(bindingFailure);
  }

  const consumed = consumeAuthority(input.authority);
  if (!consumed.ok) {
    fence.dispose();
    return consumed;
  }
  let synchronousFailure: ApplyErrorCode | null = null;
  try {
    for (const capability of new Set(state.parts.map((part) => part.capability))) {
      const access = checkActiveCapability(consumed.value, capability);
      if (!access.ok) {
        synchronousFailure = access.code;
        break;
      }
    }
    if (synchronousFailure === null) {
      synchronousFailure = bundleIdentityFailure(state);
    }
    if (synchronousFailure === null) {
      synchronousFailure = recordAllParts(state);
    }
    if (synchronousFailure === null) {
      synchronousFailure = writeAllParts(state, consumed.value);
    }
  } finally {
    // No write authority crosses a controlled-host settle or late-read window.
    releaseAuthority(consumed.value);
  }
  if (synchronousFailure !== null) return failureWithRecovery(state, synchronousFailure);

  let step = await runBoundedStep(
    (signal) => settleAfterHostWrite(signal),
    operationTimeoutMs,
    input.signal,
  );
  let code = stepFailure(step);
  if (code !== null) return failureWithRecovery(state, code);

  code = checkpointFailure(state, 'initial');
  if (code !== null) return failureWithRecovery(state, code);
  let validation = readBundleValidation(state);
  if (!validation.ok) return failureWithRecovery(state, validation.code);
  code = checkpointFailure(state, 'initial');
  if (code !== null) return failureWithRecovery(state, code);
  let finalValidation: Exclude<HostValidationVerdict, 'rejected'> = validation.verdict;

  step = await runBoundedStep(
    (signal) => abortAwareDelay(input.lateRecheckMs, signal),
    input.lateRecheckMs + operationTimeoutMs,
    input.signal,
  );
  code = stepFailure(step);
  if (code !== null) return failureWithRecovery(state, code);
  code = checkpointFailure(state, 'late');
  if (code !== null) return failureWithRecovery(state, code);

  step = await runBoundedStep(
    (signal) => settleAfterHostWrite(signal),
    operationTimeoutMs,
    input.signal,
  );
  code = stepFailure(step);
  if (code !== null) return failureWithRecovery(state, code);
  code = checkpointFailure(state, 'late');
  if (code !== null) return failureWithRecovery(state, code);
  validation = readBundleValidation(state);
  if (!validation.ok) return failureWithRecovery(state, validation.code);
  if (validation.verdict === 'unknown') finalValidation = 'unknown';

  // Treat even the read-only validation adapter as a hostile synchronous
  // boundary. One final bounded turn prevents a queued host re-render from
  // being laundered into success before the caller's await continuation.
  step = await runBoundedStep(
    (signal) => settleAfterHostWrite(signal),
    operationTimeoutMs,
    input.signal,
  );
  code = stepFailure(step);
  if (code !== null) return failureWithRecovery(state, code);
  code = checkpointFailure(state, 'late');
  if (code !== null) return failureWithRecovery(state, code);
  // This adapter is an internal, trusted read-only boundary. Re-read after the
  // final quiet turn so host validation state that changed asynchronously is
  // not reported from a stale accepted snapshot.
  validation = readBundleValidation(state);
  if (!validation.ok) return failureWithRecovery(state, validation.code);
  if (validation.verdict === 'unknown') finalValidation = 'unknown';
  code = checkpointFailure(state, 'late');
  if (code !== null) return failureWithRecovery(state, code);

  return {
    ok: true,
    value: {
      validation: finalValidation,
      undo: createTargetedUndo(state),
    },
  };
}

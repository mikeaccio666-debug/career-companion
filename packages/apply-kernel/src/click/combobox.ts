/**
 * Combobox transaction: open → await a stable rule-owned option view → choose
 * → semantic readback. The kernel contains no site selector, portal rule, or
 * backing-value knowledge. An apply-rules interpreter must supply those reads;
 * without that source the runner performs zero host clicks and fails closed.
 */

import { collectClickFacts } from './facts';
import { clickHostTarget } from './primitives';
import { evaluateClickTarget, type ClickTargetFacts } from './policy';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import type {
  ApplyErrorCode,
  ComboboxOptionHarvest,
  ComboboxOptionSource,
  ComboboxOptionView,
  ComboboxSemanticAuthority,
  ComboboxSemanticTransaction,
  ComboboxSemanticTransactionSource,
  ComboboxSemanticUndoTransaction,
  Result,
  ScanRoot,
} from '../contracts';
import type { WriteTicket } from '../undo';
import { captureScanRootObservationTargets } from '../scanRoot';
import { isRuleOwnedComboboxSemanticAuthority } from '../rules/comboboxSemanticAuthority.ts';
import { hostDelay } from '../write/hostSchedule.ts';
import {
  INITIAL_OPTION_SET_WATCH,
  isBoundedComboboxCandidates,
  isBoundedComboboxHarvest,
  MAX_COMBOBOX_HARVEST_OPTIONS,
  MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS,
  MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS,
  observeOptionSet,
  optionSetSignature,
  resolveOptionCandidate,
} from './optionSearch';

/** 一次下拉交互的硬预算。超了就放弃这个字段，整轮继续。 */
export const COMBOBOX_INTERACTION_BUDGET_MS = 1_500;
/** Semantic readback is retried once after one additional host task. */
export const MAX_COMBOBOX_READBACK_ATTEMPTS = 2;

export type {
  ComboboxOptionSource,
  ComboboxOptionView,
  ComboboxSemanticTransaction,
  ComboboxSemanticTransactionSource,
  ComboboxSemanticUndoTransaction,
} from '../contracts';

export interface SelectComboboxOptionInput {
  readonly trigger: HTMLInputElement;
  /** Raw snapshot recorded in the same Undo ticket before any host click. */
  readonly previousRawValue: string;
  /** 用户档案里的值，例如 "United States"。候选序列的第一项。 */
  readonly desired: string;
  /**
   * 同一语义的**有序备选**，`desired` 不在宿主选项里时按序回退。
   * 2026-08-21 §F.5-f 实测：竞品对 "How Did You Hear About Us?" 携带 12 个
   * 有序候选，先试自家品牌名（宿主没有）→ 退到 "LinkedIn" 命中。只带单值
   * 的实现在这里直接 NO_OPTION_MATCH。顺序即偏好顺序。
   */
  readonly alternates?: readonly string[];
  /** Immutable preview verdict; any candidate/option drift fails closed. */
  readonly harvest?: ComboboxOptionHarvest;
  readonly root: ScanRoot;
  readonly optionSource: ComboboxOptionSource;
  /** Rule-owned semantic snapshot/restore/readback; absent means zero clicks. */
  readonly semanticTransactionSource?: ComboboxSemanticTransactionSource;
  readonly authority: HostWriteAuthority;
  /**
   * 调用方已经记好的撤销凭据。**不由本模块 record**：一个字段只能有一条撤销
   * 记录，谁记的谁负责 commit/abandon，那个人是 runner。
   */
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  readonly timeoutMs?: number;
  /** pagehide/form replacement cancels every not-yet-dispatched host click. */
  readonly signal?: AbortSignal;
  /** Re-checks remote policy + sealed scan before every post-await host click. */
  readonly executionFence?: () => ApplyErrorCode | null;
  /** 厂商适配器提供的选中态读法；缺失时在任何 host click 前禁用。 */
  readonly readSelection?: (
    trigger: HTMLInputElement,
    expectedOptionText: string,
  ) => string | null;
}

export interface HarvestComboboxOptionsInput {
  readonly trigger: HTMLInputElement;
  readonly candidates: readonly string[];
  readonly root: ScanRoot;
  readonly optionSource: ComboboxOptionSource;
  /** Complete rule-owned authority; optionSource alone never permits a click. */
  readonly semanticAuthority?: ComboboxSemanticAuthority;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  /** Rule-derived bound. The kernel deliberately has no vendor default. */
  readonly maxOptions: number;
  readonly timeoutMs?: number;
  /** One initial open plus at most one timeout-only retry. */
  readonly maxOpenAttempts?: 1 | 2;
  readonly signal?: AbortSignal;
  readonly executionFence?: () => ApplyErrorCode | null;
}

export interface ComboboxCommit {
  /** 我们点中的那条选项的原文。 */
  readonly optionText: string;
  /** 厂商读回的选中态；`null` 表示无法核实，需要用户复核。 */
  readonly verified: string | null;
  /** Exact semantic Undo sealed only after the selected identity was proven. */
  readonly undo: ComboboxSemanticUndoTransaction;
}

interface SemanticComboboxFailure {
  readonly ok: false;
  readonly code: ApplyErrorCode;
  /** Retain only while the exact transaction-owned written seal survives. */
  readonly recovery?: ComboboxSemanticUndoTransaction;
}

export type SelectComboboxOptionResult =
  | { readonly ok: true; readonly value: ComboboxCommit }
  | SemanticComboboxFailure;

export type HarvestComboboxOptionsResult =
  | { readonly ok: true; readonly value: ComboboxOptionHarvest }
  | SemanticComboboxFailure;

function captureSemanticTransaction(
  input: Readonly<{
    trigger: HTMLInputElement;
    root: ScanRoot;
    semanticTransactionSource?: ComboboxSemanticTransactionSource;
  }>,
): ComboboxSemanticTransaction | null {
  try {
    const transaction = input.semanticTransactionSource?.snapshot(input.trigger, input.root);
    if (
      !transaction ||
      typeof transaction.canRestorePreWrite !== 'function' ||
      typeof transaction.restorePreWrite !== 'function' ||
      typeof transaction.isAtPreWriteState !== 'function' ||
      typeof transaction.ownsEventTarget !== 'function' ||
      typeof transaction.captureWrittenState !== 'function' ||
      transaction.isAtPreWriteState() !== true ||
      transaction.ownsEventTarget(input.trigger) !== true
    ) return null;
    return transaction;
  } catch {
    return null;
  }
}

function watchTrustedSemanticEdits(
  transaction: ComboboxSemanticTransaction,
  document: Document,
): { readonly wasUserEdited: () => boolean; readonly stop: () => void } {
  let userEdited = false;
  const onEdit = (event: Event) => {
    if (!event.isTrusted) return;
    try {
      const path = typeof event.composedPath === 'function'
        ? event.composedPath()
        : [event.target];
      if (path.some((target) => transaction.ownsEventTarget(target))) {
        userEdited = true;
      }
    } catch {
      // An untrusted ownership classifier may not turn a real user edit into
      // permission to restore over it. Treat an exception as owned.
      userEdited = true;
    }
  };
  const eventTypes = [
    'beforeinput',
    'input',
    'change',
    'pointerdown',
    'mousedown',
    'click',
    'keydown',
  ] as const;
  for (const type of eventTypes) document.addEventListener(type, onEdit, true);
  return {
    wasUserEdited: () => userEdited,
    stop: () => {
      for (const type of eventTypes) document.removeEventListener(type, onEdit, true);
    },
  };
}

/**
 * Once host dispatch starts, compensation remains independent of expired
 * forward-write authority, but it is never blind: only the exact pre-state or
 * an exact sealed written state may be restored. Trusted edits and unsealed
 * third states are both left untouched.
 */
function failAfterHostDispatch(
  transaction: ComboboxSemanticTransaction,
  userEdits: {
    readonly wasUserEdited: () => boolean;
    readonly stop: () => void;
  },
  code: ApplyErrorCode,
  sealedResidual: ComboboxSemanticUndoTransaction | null = null,
): SemanticComboboxFailure {
  if (userEdits.wasUserEdited()) {
    disposeSemanticUndo(sealedResidual);
    return { ok: false, code: 'ABORTED' };
  }

  // A state that is already the exact pre-write state needs no compensation.
  // Do not call restorePreWrite() merely because a host dispatch happened: the
  // current semantic state may now belong to the user or a third party.
  try {
    if (transaction.isAtPreWriteState() === true) {
      disposeSemanticUndo(sealedResidual);
      return { ok: false, code };
    }
  } catch {
    // Continue only if an exact post-write handle proves transaction ownership.
  }

  // Submission is an irreversible host boundary. Never spend a restoration
  // pointer after it has been observed. An exact sealed written-state handle
  // may remain available to the fail-closed UI as Undo; anything else loses
  // recovery authority without clicking.
  if (code === 'HOST_SUBMITTED') {
    if (semanticUndoOwnsExactWrittenState(sealedResidual, userEdits)) {
      return {
        ok: false,
        code,
        recovery: trackedSemanticUndo(sealedResidual, userEdits),
      };
    }
    disposeSemanticUndo(sealedResidual);
    return { ok: false, code };
  }

  // Opening a popup is not ownership of every semantic state the host may
  // enter while options settle. Even before the chosen option dispatches, a
  // generic "not pre-write" state cannot authorize snapshot restoration.
  // From here on only an exact sealed written-state handle may compensate.
  if (!semanticUndoOwnsExactWrittenState(sealedResidual, userEdits)) {
    disposeSemanticUndo(sealedResidual);
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }

  // Compensation is allowed only through the exact sealed post-write handle.
  // `not pre-write` is never a proof that this transaction owns the state.
  try {
    if (
      sealedResidual.restorePreWrite() === true &&
      sealedResidual.isAtPreWriteState() === true &&
      transaction.isAtPreWriteState() === true
    ) {
      disposeSemanticUndo(sealedResidual);
      return { ok: false, code };
    }
  } catch {
    // Retain only if the same sealed handle still proves its exact written state.
  }

  if (!semanticUndoOwnsExactWrittenState(sealedResidual, userEdits)) {
    disposeSemanticUndo(sealedResidual);
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  return {
    ok: false,
    code: 'IDENTITY_CHANGED',
    recovery: trackedSemanticUndo(sealedResidual, userEdits),
  };
}

function disposeSemanticUndo(undo: ComboboxSemanticUndoTransaction | null): void {
  if (undo === null) return;
  try {
    undo.dispose();
  } catch {
    // Disposal is local cleanup; failure must not grant restore authority.
  }
}

function semanticUndoOwnsExactWrittenState(
  undo: ComboboxSemanticUndoTransaction | null,
  userEdits: {
    readonly wasUserEdited: () => boolean;
  },
): undo is ComboboxSemanticUndoTransaction {
  if (undo === null || userEdits.wasUserEdited()) return false;
  try {
    return (
      typeof undo.wasUserEdited === 'function' &&
      typeof undo.isAtWrittenState === 'function' &&
      typeof undo.restorePreWrite === 'function' &&
      typeof undo.isAtPreWriteState === 'function' &&
      typeof undo.ownsEventTarget === 'function' &&
      typeof undo.dispose === 'function' &&
      undo.wasUserEdited() !== true &&
      undo.isAtWrittenState() === true
    );
  } catch {
    return false;
  }
}

function trackedSemanticUndo(
  undo: ComboboxSemanticUndoTransaction,
  userEdits: {
    readonly wasUserEdited: () => boolean;
    readonly stop: () => void;
  },
): ComboboxSemanticUndoTransaction {
  let disposed = false;
  return {
    wasUserEdited: () => disposed || userEdits.wasUserEdited() || undo.wasUserEdited(),
    isAtWrittenState: () => {
      if (disposed || userEdits.wasUserEdited()) return false;
      try {
        return undo.wasUserEdited() !== true && undo.isAtWrittenState() === true;
      } catch {
        return false;
      }
    },
    restorePreWrite: () => {
      if (disposed || userEdits.wasUserEdited()) return false;
      try {
        if (undo.wasUserEdited() === true || undo.isAtWrittenState() !== true) return false;
        return undo.restorePreWrite() === true;
      } catch {
        return false;
      }
    },
    isAtPreWriteState: () => {
      if (disposed) return false;
      try {
        return undo.isAtPreWriteState() === true;
      } catch {
        return false;
      }
    },
    ownsEventTarget: (target) => !disposed && undo.ownsEventTarget(target),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      userEdits.stop();
      disposeSemanticUndo(undo);
    },
  };
}

/**
 * One host macrotask: `setTimeout(0)` while the page is visible, exactly as
 * before. In a hidden page that timer is throttled to about one second
 * (2026-09-23 measured), which would turn this open → poll → settle loop into
 * one observation per second against a wall-clock budget; there it is one
 * MessageChannel task instead (`hostSchedule.ts`). False once aborted.
 */
function nextMacrotask(signal?: AbortSignal): Promise<boolean> {
  return hostDelay(0, signal);
}

interface SynchronousDomMutationFence {
  /** Extend the same synchronous fence into option/trigger shadow roots. */
  readonly observe: (targets: readonly Node[]) => boolean;
  /** Return and clear whether any observed host DOM mutation occurred. */
  readonly take: () => boolean;
  readonly stop: () => void;
}

/**
 * The last pre-dispatch callbacks are synchronous but untrusted boundaries.
 * MutationObserver.takeRecords() lets the kernel prove that a callback or fact
 * getter did not mutate option membership/attributes while returning a stale
 * answer. The observer exists for one synchronous seal only; it never waits,
 * logs, or retains host DOM.
 */
function watchSynchronousDomMutations(
  document: Document,
  initialTargets: readonly Node[],
): SynchronousDomMutationFence | null {
  const Observer = document.defaultView?.MutationObserver;
  if (!Observer) return null;
  try {
    const observer = new Observer(() => undefined);
    const options: MutationObserverInit = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    };
    const observe = (targets: readonly Node[]): boolean => {
      try {
        for (const target of new Set(targets)) observer.observe(target, options);
        return true;
      } catch {
        return false;
      }
    };
    if (!observe([document, ...initialTargets])) {
      observer.disconnect();
      return null;
    }
    return {
      observe,
      take: () => observer.takeRecords().length > 0,
      stop: () => observer.disconnect(),
    };
  } catch {
    return null;
  }
}

/**
 * 阶梯匹配现在住在 `click/optionSearch.ts`（纯函数、可测、计划期与写入期同源）。
 * 这里只负责把 DOM 元素降成文案数组、把下标还原成元素。
 */
function matchOption(
  candidates: readonly string[],
  options: readonly ComboboxOptionView[],
): Result<ComboboxOptionView, 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION'> {
  const resolution = resolveOptionCandidate(candidates, options.map((option) => option.text));
  if (resolution.kind === 'AMBIGUOUS_OPTION') return { ok: false, code: 'AMBIGUOUS_OPTION' };
  if (resolution.kind === 'NO_OPTION_MATCH') return { ok: false, code: 'NO_OPTION_MATCH' };
  return { ok: true, value: options[resolution.optionIndex] as ComboboxOptionView };
}

function currentOptions(input: {
  readonly trigger: HTMLInputElement;
  readonly root: ScanRoot;
  readonly optionSource: ComboboxOptionSource;
}): readonly ComboboxOptionView[] | null {
  try {
    const views = input.optionSource.read(input.trigger, input.root);
    const seen = new Set<Element>();
    const normalized: ComboboxOptionView[] = [];
    let totalTextCodeUnits = 0;
    let inspectedViews = 0;
    for (const view of views) {
      inspectedViews += 1;
      if (inspectedViews > MAX_COMBOBOX_HARVEST_OPTIONS) return null;
      if (
        !view ||
        typeof view !== 'object' ||
        !view.element ||
        view.element.nodeType !== 1 ||
        typeof view.text !== 'string' ||
        view.text.length > MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS
      ) return null;
      if (seen.has(view.element) || input.root.isExcluded(view.element)) continue;
      seen.add(view.element);
      const text = normalizeOptionText(view.text);
      totalTextCodeUnits += text.length;
      if (totalTextCodeUnits > MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS) return null;
      normalized.push({
        element: view.element,
        text,
      });
    }
    return normalized;
  } catch {
    return null;
  }
}

function normalizeOptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function executionError(input: {
  readonly executionFence?: () => ApplyErrorCode | null;
}): ApplyErrorCode | null {
  if (!input.executionFence) return null;
  try {
    return input.executionFence();
  } catch {
    return 'ABORTED';
  }
}

function semanticTriggerPointerFence(
  input: Readonly<{
    trigger: HTMLInputElement;
    root: ScanRoot;
    signal?: AbortSignal;
    executionFence?: () => ApplyErrorCode | null;
    semanticTransaction: ComboboxSemanticTransaction;
    semanticUserEdits: { readonly wasUserEdited: () => boolean };
  }>,
  sealedTargets: readonly Node[],
  sealedTriggerRoot: Node,
): () => ApplyErrorCode | null {
  const originalTrigger = input.trigger;
  return () => {
    const initialExecutionError = executionError(input);
    if (initialExecutionError) return initialExecutionError;
    if (input.signal?.aborted || input.semanticUserEdits.wasUserEdited()) return 'ABORTED';
    if (
      !originalTrigger.isConnected ||
      originalTrigger.getRootNode() !== sealedTriggerRoot
    ) return 'ABORTED';
    const liveTargets = captureScanRootObservationTargets(input.root);
    if (!liveTargets || !sameNodeSet(sealedTargets, liveTargets)) return 'IDENTITY_CHANGED';
    try {
      if (input.semanticTransaction.ownsEventTarget(originalTrigger) !== true) {
        return 'IDENTITY_CHANGED';
      }
      if (input.semanticTransaction.canRestorePreWrite() !== true) {
        return 'CAPABILITY_DISABLED';
      }
      if (input.semanticTransaction.isAtPreWriteState() !== true) {
        return 'IDENTITY_CHANGED';
      }
    } catch {
      return 'IDENTITY_CHANGED';
    }
    // The semantic proofs above are callback boundaries too. A policy revoke,
    // stale scan, abort or host submit observed by either callback must stop
    // before the next pointer event.
    return executionError(input);
  };
}

async function closeTransactionPopup(input: {
  readonly trigger: HTMLInputElement;
  readonly root: ScanRoot;
  readonly optionSource: ComboboxOptionSource;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  readonly signal?: AbortSignal;
  readonly executionFence?: () => ApplyErrorCode | null;
  readonly semanticTransaction: ComboboxSemanticTransaction;
  readonly semanticUserEdits: {
    readonly wasUserEdited: () => boolean;
    readonly stop: () => void;
  };
}): Promise<Result<void, ApplyErrorCode>> {
  // A failed fence is a revocation, not an invitation to spend one final host
  // click on cleanup. Timers/listeners are already local and settle normally.
  if (input.signal?.aborted) return { ok: false, code: 'ABORTED' };
  const fence = executionError(input);
  if (fence) return { ok: false, code: fence };
  let isOpen = false;
  try {
    const state = input.optionSource.isOpen(input.trigger);
    if (typeof state !== 'boolean') return { ok: false, code: 'CAPABILITY_DISABLED' };
    isOpen = state;
  } catch {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  if (!isOpen) return { ok: true, value: undefined };
  const closed = dispatchSemanticTrigger(input);
  if (!closed.ok) return closed;
  if (!(await nextMacrotask(input.signal))) return { ok: false, code: 'ABORTED' };
  let state: boolean;
  try {
    state = input.optionSource.isOpen(input.trigger);
    if (typeof state !== 'boolean') return { ok: false, code: 'CAPABILITY_DISABLED' };
  } catch {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  const verifyFence = executionError(input);
  if (verifyFence) return { ok: false, code: verifyFence };
  if (input.signal?.aborted || input.semanticUserEdits.wasUserEdited()) {
    return { ok: false, code: 'ABORTED' };
  }
  try {
    if (input.semanticTransaction.canRestorePreWrite() !== true) {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
  } catch {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  return state
    ? { ok: false, code: 'WIDGET_TIMEOUT' }
    : { ok: true, value: undefined };
}

/**
 * One trigger activation under complete rule-owned semantic authority. The
 * last callback before dispatch is the atomic can-restore/pre-state proof;
 * facts, roots, execution state and synchronous DOM mutations are all sealed.
 */
function dispatchSemanticTrigger(input: Readonly<{
  trigger: HTMLInputElement;
  root: ScanRoot;
  optionSource: ComboboxOptionSource;
  authority: HostWriteAuthority;
  ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  policy: ApplyPolicy;
  signal?: AbortSignal;
  executionFence?: () => ApplyErrorCode | null;
  semanticTransaction: ComboboxSemanticTransaction;
  semanticUserEdits: { readonly wasUserEdited: () => boolean };
}>): Result<void, ApplyErrorCode> {
  if (
    input.signal?.aborted ||
    input.semanticUserEdits.wasUserEdited() ||
    !input.trigger.isConnected
  ) return { ok: false, code: 'ABORTED' };
  const initialFence = executionError(input);
  if (initialFence) return { ok: false, code: initialFence };
  if (currentOptions(input) === null) return { ok: false, code: 'CAPABILITY_DISABLED' };

  const targets = captureScanRootObservationTargets(input.root);
  if (!targets) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const mutations = watchSynchronousDomMutations(
    input.trigger.ownerDocument,
    [...targets, input.trigger.getRootNode()],
  );
  if (!mutations) return { ok: false, code: 'CAPABILITY_DISABLED' };
  try {
    let firstFacts: ClickTargetFacts;
    let finalFacts: ClickTargetFacts;
    try {
      firstFacts = triggerFacts(input.trigger, input.root);
      finalFacts = triggerFacts(input.trigger, input.root);
    } catch {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    const finalTargets = captureScanRootObservationTargets(input.root);
    if (!finalTargets || !sameNodeSet(targets, finalTargets)) {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
    if (!sameClickTargetFacts(firstFacts, finalFacts)) {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    if (!evaluateClickTarget(finalFacts).allowed) {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    const finalFence = executionError(input);
    if (finalFence) return { ok: false, code: finalFence };
    if (
      input.signal?.aborted ||
      input.semanticUserEdits.wasUserEdited() ||
      !input.trigger.isConnected
    ) return { ok: false, code: 'ABORTED' };
    try {
      if (input.semanticTransaction.canRestorePreWrite() !== true) {
        return { ok: false, code: 'CAPABILITY_DISABLED' };
      }
    } catch {
      return { ok: false, code: 'CAPABILITY_DISABLED' };
    }
    if (mutations.take()) return { ok: false, code: 'IDENTITY_CHANGED' };
    const pointerSequenceFence = semanticTriggerPointerFence(
      input,
      targets,
      input.trigger.getRootNode(),
    );
    return clickHostTarget({
      element: input.trigger,
      facts: finalFacts,
      root: input.root,
      authority: input.authority,
      ticket: input.ticket,
      policy: input.policy,
      pointerSequenceFence: () => pointerSequenceFence(),
    });
  } finally {
    mutations.stop();
  }
}

/**
 * Opens a reviewed in-root combobox, waits for a bounded stable option set,
 * resolves the ordered candidates, then closes without choosing anything.
 * Portal reachability is intentionally absent: it remains disabled until an
 * apply-rules-owned option source can prove containment without kernel DOM
 * knowledge.
 */
export async function harvestComboboxOptions(
  input: HarvestComboboxOptionsInput,
): Promise<HarvestComboboxOptionsResult> {
  const totalBudget = input.timeoutMs ?? COMBOBOX_INTERACTION_BUDGET_MS;
  if (
    !Number.isInteger(input.maxOptions) ||
    input.maxOptions < 1 ||
    input.maxOptions > MAX_COMBOBOX_HARVEST_OPTIONS ||
    !Number.isFinite(totalBudget) ||
    totalBudget <= 0 ||
    totalBudget > COMBOBOX_INTERACTION_BUDGET_MS ||
    !isBoundedComboboxCandidates(input.candidates) ||
    (input.maxOpenAttempts !== undefined &&
      input.maxOpenAttempts !== 1 &&
      input.maxOpenAttempts !== 2)
  ) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  const semanticAuthority = input.semanticAuthority;
  if (
    !isRuleOwnedComboboxSemanticAuthority(semanticAuthority) ||
    semanticAuthority.optionSource !== input.optionSource
  ) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const semanticTransaction = captureSemanticTransaction({
    trigger: input.trigger,
    root: input.root,
    semanticTransactionSource: semanticAuthority.semanticTransactionSource,
  });
  if (semanticTransaction === null) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  try {
    if (semanticTransaction.canRestorePreWrite() !== true) {
      return { ok: false, code: 'CAPABILITY_DISABLED' };
    }
  } catch {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  const semanticUserEdits = watchTrustedSemanticEdits(
    semanticTransaction,
    input.trigger.ownerDocument,
  );
  let hostDispatchStarted = false;
  let semanticWatchTransferred = false;
  const fail = (code: ApplyErrorCode): SemanticComboboxFailure => {
    const result = hostDispatchStarted
      ? failAfterHostDispatch(semanticTransaction, semanticUserEdits, code)
      : { ok: false as const, code };
    if (!result.ok && result.recovery !== undefined) {
      semanticWatchTransferred = true;
    }
    return result;
  };
  try {
  if (input.signal?.aborted) return fail('ABORTED');
  const initialFence = executionError(input);
  if (initialFence) return fail(initialFence);

  const attempts = input.maxOpenAttempts ?? 1;
  const overallDeadline = Date.now() + totalBudget;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A retry is permission to spend a second open only while the original
    // wall-clock budget is still live. It must never become an extra click
    // after the first attempt has already exhausted that budget.
    if (attempt > 0 && Date.now() >= overallDeadline) {
      return fail('WIDGET_TIMEOUT');
    }
    if (input.signal?.aborted) return fail('ABORTED');
    const attemptFence = executionError(input);
    if (attemptFence) return fail(attemptFence);
    const beforeOpen = currentOptions(input);
    if (beforeOpen === null) return fail('CAPABILITY_DISABLED');
    const preexisting = new Set(beforeOpen.map((option) => option.element));
    hostDispatchStarted = true;
    const opened = dispatchSemanticTrigger({
      ...input,
      semanticTransaction,
      semanticUserEdits,
    });
    if (!opened.ok) return fail(opened.code);

    const attemptsLeft = attempts - attempt;
    const remainingBudget = Math.max(0, overallDeadline - Date.now());
    const attemptDeadline = Date.now() + Math.floor(remainingBudget / attemptsLeft);
    let fresh: readonly ComboboxOptionView[] = [];
    let watch = INITIAL_OPTION_SET_WATCH;
    let settled = false;
    let failure: ApplyErrorCode | null = null;
    let retryable = true;

    do {
      if (!(await nextMacrotask(input.signal))) {
        failure = 'ABORTED';
        break;
      }
      const fence = executionError(input);
      if (fence) {
        failure = fence;
        break;
      }
      const liveOptions = currentOptions(input);
      if (liveOptions === null) {
        failure = 'CAPABILITY_DISABLED';
        retryable = false;
        break;
      }
      fresh = liveOptions.filter((option) => !preexisting.has(option.element));
      if (fresh.length > input.maxOptions) {
        failure = 'WIDGET_TIMEOUT';
        retryable = false;
        break;
      }
      const observation = observeOptionSet(watch, fresh.map((option) => option.text), Date.now());
      watch = observation.watch;
      settled = observation.settled;
    } while (!settled && Date.now() < attemptDeadline);

    if (!failure && (!settled || fresh.length === 0)) failure = 'WIDGET_TIMEOUT';
    if (!failure) {
      const optionTexts = fresh.map((option) => option.text);
      const resolution = resolveOptionCandidate(input.candidates, optionTexts);
      if (resolution.kind === 'NO_OPTION_MATCH') failure = 'NO_OPTION_MATCH';
      else if (resolution.kind === 'AMBIGUOUS_OPTION') failure = 'AMBIGUOUS_OPTION';
      else {
        const value: ComboboxOptionHarvest = Object.freeze({
          candidates: Object.freeze([...input.candidates]),
          optionTexts: Object.freeze(optionTexts),
          optionSetSignature: optionSetSignature(optionTexts),
          resolvedOptionText: optionTexts[resolution.optionIndex] as string,
        });
        const closed = await closeTransactionPopup({
          ...input,
          semanticTransaction,
          semanticUserEdits,
        });
        if (!closed.ok) return fail(closed.code);
        return { ok: true, value };
      }
    }

    const closed = await closeTransactionPopup({
      ...input,
      semanticTransaction,
      semanticUserEdits,
    });
    if (!closed.ok) return fail(closed.code);
    if (!retryable || failure !== 'WIDGET_TIMEOUT' || attempt + 1 >= attempts) {
      return fail(failure ?? 'WIDGET_TIMEOUT');
    }
  }

  return fail('WIDGET_TIMEOUT');
  } finally {
    if (!semanticWatchTransferred) semanticUserEdits.stop();
  }
}

/**
 * ⚠️ 这里曾经手写 10 个事实，漏掉隐藏、离屏、蜜罐、密码容器、验证码、
 * 文件对话框、href 两项、buttonType、labelText 共十项——而缺席的事实是
 * `undefined`，等于那几条 deny **这次不跑**。也就是说一个隐藏的下拉触发器
 * 曾经是点得动的。改走 `collectClickFacts` 之后，齐全由构造保证；
 * `REQUIRED_FACTS_BY_KIND` 那道闸是最后一道兜底。
 */
function triggerFacts(trigger: HTMLInputElement, root: ScanRoot): ClickTargetFacts {
  return collectClickFacts({ element: trigger, root, kind: 'combobox-trigger', planned: true });
}

function optionFacts(option: ComboboxOptionView, root: ScanRoot): ClickTargetFacts {
  return collectClickFacts({
    element: option.element,
    root,
    kind: 'transaction-option',
    planned: true,
    // 只有本次交易开出来的选项才走到这里——调用方已按身份集合筛过。
    openedByTransaction: true,
  });
}

/**
 * Prove that the rule-owned view still describes the same live DOM option set
 * without calling the rule interpreter again. This deliberately reads the
 * host node text instead of replacing click-policy facts with cached rule
 * text: a stale callback result must never hide a new Submit-looking label.
 */
function liveOptionSetMatches(
  options: readonly ComboboxOptionView[],
  expectedSignature: string,
): boolean {
  if (options.length > MAX_COMBOBOX_HARVEST_OPTIONS) return false;
  const texts: string[] = [];
  let totalTextCodeUnits = 0;
  for (const option of options) {
    if (!option.element.isConnected) return false;
    const rawText = option.element.textContent ?? '';
    if (rawText.length > MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS) return false;
    const liveText = normalizeOptionText(rawText);
    totalTextCodeUnits += liveText.length;
    if (totalTextCodeUnits > MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS) return false;
    if (liveText !== option.text) return false;
    texts.push(liveText);
  }
  return optionSetSignature(texts) === expectedSignature;
}

function sameClickTargetFacts(
  left: ClickTargetFacts,
  right: ClickTargetFacts,
): boolean {
  const keys = new Set<keyof ClickTargetFacts>([
    ...(Object.keys(left) as (keyof ClickTargetFacts)[]),
    ...(Object.keys(right) as (keyof ClickTargetFacts)[]),
  ]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
}

function sameNodeSet(left: readonly Node[], right: readonly Node[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((node) => expected.has(node));
}

interface ComboboxOptionMembershipSeal {
  readonly element: Element;
  readonly text: string;
  readonly root: Node;
}

/**
 * Freeze the complete ordered rule-owned option membership before a hostile
 * facts getter runs. Reading getRootNode() only after that getter is too late:
 * the same connected node may already have moved between observed roots.
 */
function sealOptionMembership(
  options: readonly ComboboxOptionView[],
): readonly ComboboxOptionMembershipSeal[] {
  return options.map((option) => ({
    element: option.element,
    text: option.text,
    root: option.element.getRootNode(),
  }));
}

function sameOptionMembership(
  sealed: readonly ComboboxOptionMembershipSeal[],
  current: readonly ComboboxOptionView[],
): boolean {
  return sealed.length === current.length && current.every((option, index) => {
    const expected = sealed[index];
    return expected !== undefined &&
      option.element === expected.element &&
      option.text === expected.text &&
      option.element.getRootNode() === expected.root;
  });
}

export async function selectComboboxOption(
  input: SelectComboboxOptionInput,
): Promise<SelectComboboxOptionResult> {
  const { trigger, desired, root, authority, ticket, policy, signal, readSelection } = input;
  const alternatesAreValid = input.alternates === undefined || Array.isArray(input.alternates);
  const candidates: unknown[] = [
    desired,
    ...(Array.isArray(input.alternates) ? input.alternates : []),
  ];
  const budgetMs = input.timeoutMs ?? COMBOBOX_INTERACTION_BUDGET_MS;
  let semanticUserEdits: ReturnType<typeof watchTrustedSemanticEdits> | null = null;
  let semanticWatchTransferred = false;
  let synchronousDomMutations: SynchronousDomMutationFence | null = null;
  const currentExecutionError = (): ApplyErrorCode | null => {
    if (semanticUserEdits?.wasUserEdited()) return 'ABORTED';
    return executionError(input);
  };

  if (
    typeof input.previousRawValue !== 'string' ||
    !Number.isFinite(budgetMs) ||
    budgetMs <= 0 ||
    budgetMs > COMBOBOX_INTERACTION_BUDGET_MS ||
    !alternatesAreValid ||
    !isBoundedComboboxCandidates(candidates) ||
    typeof readSelection !== 'function'
  ) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  let sealedHarvestSignature: string | null = null;
  let sealedHarvestResolvedText: string | null = null;
  if (input.harvest) {
    if (!isBoundedComboboxHarvest(input.harvest)) {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
    const previewCandidatesMatch =
      input.harvest.candidates.length === candidates.length &&
      input.harvest.candidates.every((candidate, index) => candidate === candidates[index]);
    const previewResolution = resolveOptionCandidate(candidates, input.harvest.optionTexts);
    if (
      !previewCandidatesMatch ||
      optionSetSignature(input.harvest.optionTexts) !== input.harvest.optionSetSignature ||
      previewResolution.kind !== 'MATCH' ||
      input.harvest.optionTexts[previewResolution.optionIndex] !==
        input.harvest.resolvedOptionText
    ) {
      return { ok: false, code: 'IDENTITY_CHANGED' };
    }
    sealedHarvestSignature = input.harvest.optionSetSignature;
    sealedHarvestResolvedText = input.harvest.resolvedOptionText;
  }

  if (signal?.aborted) return { ok: false, code: 'ABORTED' };
  const initialFence = currentExecutionError();
  if (initialFence) return { ok: false, code: initialFence };

  const semanticTransaction = captureSemanticTransaction(input);
  if (!semanticTransaction) return { ok: false, code: 'CAPABILITY_DISABLED' };
  semanticUserEdits = watchTrustedSemanticEdits(
    semanticTransaction,
    trigger.ownerDocument,
  );
  const triggerWasConnected = trigger.isConnected;
  const triggerWasReplaced = () => triggerWasConnected && !trigger.isConnected;
  let hostDispatchStarted = false;
  let sealedResidual: ComboboxSemanticUndoTransaction | null = null;
  const fail = (code: ApplyErrorCode): SelectComboboxOptionResult => {
    const residual = sealedResidual;
    sealedResidual = null;
    const result = hostDispatchStarted
      ? failAfterHostDispatch(
          semanticTransaction,
          semanticUserEdits,
          code,
          residual,
        )
      : { ok: false as const, code };
    if (!hostDispatchStarted) disposeSemanticUndo(residual);
    if (!result.ok && result.recovery !== undefined) {
      semanticWatchTransferred = true;
    }
    return result;
  };
  const closePopup = () => closeTransactionPopup({
    ...input,
    executionFence: currentExecutionError,
    semanticTransaction,
    semanticUserEdits,
  });
  const closeAndFail = async (code: ApplyErrorCode): Promise<SelectComboboxOptionResult> => {
    try {
      const closed = await closePopup();
      return fail(closed.ok ? code : closed.code);
    } catch {
      return fail('CLICK_DENIED');
    }
  };

  try {

  // Opening the host is itself a write-capable click. Every rule/execution/
  // facts callback that precedes it therefore sits inside one synchronous
  // fence, followed by an opaque semantic re-proof with no adapter callback
  // left between that proof and clickHostTarget().
  const openObservationTargets = captureScanRootObservationTargets(root);
  if (!openObservationTargets) return fail('CAPABILITY_DISABLED');
  const openDomMutations = watchSynchronousDomMutations(
    trigger.ownerDocument,
    [...openObservationTargets, trigger.getRootNode()],
  );
  if (!openDomMutations) return fail('CAPABILITY_DISABLED');

  let beforeOpen: readonly ComboboxOptionView[] | null = null;
  let opened: ReturnType<typeof clickHostTarget>;
  try {
    // Options already visible through this exact rule-owned source are not
    // products of the transaction and can never become click candidates.
    beforeOpen = currentOptions(input);
    if (beforeOpen === null) return fail('CAPABILITY_DISABLED');

    if (signal?.aborted || semanticUserEdits.wasUserEdited()) return fail('ABORTED');
    const openFence = currentExecutionError();
    if (openFence) return fail(openFence);
    if (triggerWasReplaced()) return fail('ABORTED');

    let firstOpenFacts: ClickTargetFacts;
    let finalOpenFacts: ClickTargetFacts;
    try {
      firstOpenFacts = triggerFacts(trigger, root);
      finalOpenFacts = triggerFacts(trigger, root);
    } catch {
      return fail('CLICK_DENIED');
    }
    const finalOpenObservationTargets = captureScanRootObservationTargets(root);
    if (
      !finalOpenObservationTargets ||
      !sameNodeSet(openObservationTargets, finalOpenObservationTargets)
    ) return fail('IDENTITY_CHANGED');
    if (!sameClickTargetFacts(firstOpenFacts, finalOpenFacts)) {
      return fail('CLICK_DENIED');
    }
    if (!evaluateClickTarget(finalOpenFacts).allowed) return fail('CLICK_DENIED');
    if (
      signal?.aborted ||
      semanticUserEdits.wasUserEdited() ||
      triggerWasReplaced()
    ) return fail('ABORTED');
    try {
      if (semanticTransaction.ownsEventTarget(trigger) !== true) {
        return fail('IDENTITY_CHANGED');
      }
      if (semanticTransaction.canRestorePreWrite() !== true) {
        return fail('CAPABILITY_DISABLED');
      }
      if (semanticTransaction.isAtPreWriteState() !== true) {
        return fail('IDENTITY_CHANGED');
      }
    } catch {
      return fail('IDENTITY_CHANGED');
    }
    if (trigger.value !== input.previousRawValue) return fail('IDENTITY_CHANGED');
    if (openDomMutations.take()) return fail('IDENTITY_CHANGED');

    hostDispatchStarted = true;
    const pointerSequenceFence = semanticTriggerPointerFence(
      {
        trigger,
        root,
        signal,
        executionFence: currentExecutionError,
        semanticTransaction,
        semanticUserEdits,
      },
      openObservationTargets,
      trigger.getRootNode(),
    );
    try {
      opened = clickHostTarget({
        element: trigger,
        facts: finalOpenFacts,
        root,
        authority,
        ticket,
        policy,
        pointerSequenceFence: () => pointerSequenceFence(),
      });
    } catch {
      return fail('CLICK_DENIED');
    }
  } finally {
    openDomMutations.stop();
  }
  if (!opened.ok) return fail(opened.code);
  const preexisting = new Set(beforeOpen.map((option) => option.element));

  // 轮询宏任务而不是读一次就算：实测同一 tick 内 0 个选项。
  //
  // CAP-AF-004：条件从"出现了至少一个选项"改成"**选项集连续两次观测一致**"。
  // 选项是分批异步填进来的，在半加载的列表上，低阶（前缀）匹配可能唯一命中一项，
  // 而列表完整后本该由高阶（精确）匹配命中**另一项**——那是静默选错，下拉是收起
  // 的，用户看不见。见 `optionSearch.ts` 头部与 `apply-option-search.test.ts`。
  const deadline = Date.now() + budgetMs;
  let fresh: readonly ComboboxOptionView[] = [];
  let watch = INITIAL_OPTION_SET_WATCH;
  let settled = false;
  do {
    if (!(await nextMacrotask(signal))) return fail('ABORTED');
    if (signal?.aborted) return fail('ABORTED');
    const settleFence = currentExecutionError();
    if (settleFence) return fail(settleFence);
    const liveOptions = currentOptions(input);
    if (liveOptions === null) {
      return closeAndFail('CAPABILITY_DISABLED');
    }
    fresh = liveOptions.filter((option) => !preexisting.has(option.element));
    const observation = observeOptionSet(
      watch,
      fresh.map((option) => option.text),
      Date.now(),
    );
    watch = observation.watch;
    settled = observation.settled;
  } while (!settled && Date.now() < deadline);

  if (fresh.length === 0) {
    return closeAndFail('WIDGET_TIMEOUT');
  }
  // 选项出来了但在预算内始终没稳定：宁可交还用户，也不在移动的列表上下判决。
  if (!settled) {
    return closeAndFail('WIDGET_TIMEOUT');
  }

  const settledTexts = fresh.map((option) => option.text);
  const settledSignature = optionSetSignature(settledTexts);
  if (
    sealedHarvestSignature !== null &&
    settledSignature !== sealedHarvestSignature
  ) {
    return closeAndFail('IDENTITY_CHANGED');
  }

  const matched = matchOption(candidates, fresh);
  if (!matched.ok) {
    return closeAndFail(matched.code);
  }

  const chosen = matched.value;
  const text = chosen.text;
  if (
    sealedHarvestResolvedText !== null &&
    text !== sealedHarvestResolvedText
  ) {
    return closeAndFail('IDENTITY_CHANGED');
  }
  const observationTargets = captureScanRootObservationTargets(root);
  if (!observationTargets) return fail('CAPABILITY_DISABLED');
  synchronousDomMutations = watchSynchronousDomMutations(
    trigger.ownerDocument,
    [
      ...observationTargets,
      trigger.getRootNode(),
      ...fresh.map((option) => option.element.getRootNode()),
    ],
  );
  if (!synchronousDomMutations) return fail('CAPABILITY_DISABLED');
  try {
    if (semanticTransaction.isAtPreWriteState() !== true) {
      return closeAndFail('IDENTITY_CHANGED');
    }
  } catch {
    return closeAndFail('IDENTITY_CHANGED');
  }
  if (signal?.aborted) return fail('ABORTED');
  const revalidateChosen = (): Result<{
    readonly chosen: ComboboxOptionView;
    readonly options: readonly ComboboxOptionView[];
  }, ApplyErrorCode> => {
    const liveOptions = currentOptions(input);
    if (liveOptions === null) return { ok: false, code: 'CAPABILITY_DISABLED' };
    const liveFresh = liveOptions.filter((option) => !preexisting.has(option.element));
    const liveTexts = liveFresh.map((option) => option.text);
    const liveSignature = optionSetSignature(liveTexts);
    if (
      liveSignature !== settledSignature ||
      (sealedHarvestSignature !== null && liveSignature !== sealedHarvestSignature)
    ) return { ok: false, code: 'IDENTITY_CHANGED' };
    const liveMatch = matchOption(candidates, liveFresh);
    if (
      !liveMatch.ok ||
      liveMatch.value.element !== chosen.element ||
      liveMatch.value.text !== text ||
      (sealedHarvestResolvedText !== null &&
        liveMatch.value.text !== sealedHarvestResolvedText)
    ) return { ok: false, code: 'IDENTITY_CHANGED' };
    return {
      ok: true,
      value: { chosen: liveMatch.value, options: liveFresh },
    };
  };

  const replaceSealedResidual = (next: ComboboxSemanticUndoTransaction | null) => {
    if (sealedResidual !== next) disposeSemanticUndo(sealedResidual);
    sealedResidual = next;
  };
  const sealExactWrittenResidual = (): ApplyErrorCode | null => {
    let candidate: ComboboxSemanticUndoTransaction | null = null;
    try {
      candidate = semanticTransaction.captureWrittenState(text);
    } catch {
      candidate = null;
    }
    if (!semanticUndoOwnsExactWrittenState(candidate, semanticUserEdits)) {
      disposeSemanticUndo(candidate);
      return 'IDENTITY_CHANGED';
    }
    replaceSealedResidual(candidate);
    // captureWrittenState()/wasUserEdited()/isAtWrittenState() are adapter
    // callbacks. A success-shaped answer cannot suppress a concurrent abort,
    // revoke, stale scan, or host-submit verdict.
    const captureFence = currentExecutionError();
    if (captureFence) {
      return captureFence;
    }
    return null;
  };
  const provePreWriteOrExactWritten = (): ApplyErrorCode | null => {
    let atPreWrite = false;
    try {
      atPreWrite = semanticTransaction.isAtPreWriteState() === true;
    } catch {
      atPreWrite = false;
    }
    const semanticFence = currentExecutionError();
    if (semanticFence) return semanticFence;
    if (atPreWrite) {
      // The execution callback above is an untrusted boundary. Re-prove the
      // opaque state after it; this final proof has no forward callback before
      // the next pointer dispatch.
      try {
        if (semanticTransaction.isAtPreWriteState() === true) {
          replaceSealedResidual(null);
          return null;
        }
      } catch {
        // Fall through to the exact post-write seal.
      }
    }
    return sealExactWrittenResidual();
  };

  // First fence every semantic/execution callback that can invalidate the
  // settled list, then re-read rule-owned membership and signature. A second
  // execution + semantic seal follows that read so a hostile source cannot
  // expire policy or backing authority while returning a stale view.
  const chooseFence = currentExecutionError();
  if (chooseFence) return fail(chooseFence);
  // The only generic close primitive is the original trigger. Once the host
  // replaces it, clicking that stale node cannot safely close the live popup.
  // Spend zero further host clicks and run exact semantic compensation.
  if (triggerWasReplaced()) return fail('ABORTED');
  // Mutations before the final source read are intentionally consumed here:
  // that read must either account for them or fail identity/signature checks.
  synchronousDomMutations.take();
  const liveChosen = revalidateChosen();
  if (!liveChosen.ok) return fail(liveChosen.code);
  const sourceMutatedDom = synchronousDomMutations.take();
  if (!synchronousDomMutations.observe(
    liveChosen.value.options.map((option) => option.element.getRootNode()),
  )) return fail('CAPABILITY_DISABLED');
  const finalChooseFence = currentExecutionError();
  if (finalChooseFence) return fail(finalChooseFence);
  const finalExecutionMutatedDom = synchronousDomMutations.take();
  try {
    if (semanticTransaction.isAtPreWriteState() !== true) {
      return fail('IDENTITY_CHANGED');
    }
  } catch {
    return fail('IDENTITY_CHANGED');
  }
  if (trigger.value !== input.previousRawValue) return fail('IDENTITY_CHANGED');
  const finalSemanticCheckMutatedDom = synchronousDomMutations.take();
  if (triggerWasReplaced()) return fail('ABORTED');
  // The final execution/semantic callbacks may change membership in a rule
  // search root that was empty when the settled option roots were observed.
  // Re-read the complete rule-owned set after every such callback; checking
  // only the cached nodes cannot detect a newly added duplicate in that root.
  const dispatchChosen = revalidateChosen();
  if (!dispatchChosen.ok) return fail(dispatchChosen.code);
  const finalSourceMutatedDom = synchronousDomMutations.take();
  if (!synchronousDomMutations.observe(
    dispatchChosen.value.options.map((option) => option.element.getRootNode()),
  )) return fail('CAPABILITY_DISABLED');
  if (!liveOptionSetMatches(dispatchChosen.value.options, settledSignature)) {
    return fail('IDENTITY_CHANGED');
  }
  const sealedDispatchMembership = sealOptionMembership(
    dispatchChosen.value.options,
  );

  let liveFacts: ClickTargetFacts;
  try {
    liveFacts = optionFacts(dispatchChosen.value.chosen, root);
  } catch {
    return fail('CLICK_DENIED');
  }

  // Collect twice from the same sealed node. A fact getter that changes the
  // host during the first pass is visible to the second pass; after both
  // passes, one final rule-owned read proves that neither getter removed the
  // exact option from membership or moved it between already observed roots.
  let dispatchFacts: ClickTargetFacts;
  try {
    dispatchFacts = optionFacts(dispatchChosen.value.chosen, root);
  } catch {
    return fail('CLICK_DENIED');
  }
  const factsMutatedDom = synchronousDomMutations.take();

  // FINAL_FACTS_MEMBERSHIP_FENCE: facts do not encode rule-owned membership.
  // Re-read the complete ordered source after the last facts getter and
  // compare the node/text/root seal captured before it. The explicit root seal
  // catches a connected node moved between two already observed ShadowRoots,
  // which keeps both the signature and node identity deceptively unchanged.
  const finalDispatchChosen = revalidateChosen();
  const postFactsSourceMutatedDom = synchronousDomMutations.take();
  if (signal?.aborted || semanticUserEdits.wasUserEdited()) return fail('ABORTED');
  if (triggerWasReplaced()) return fail('ABORTED');
  if (!finalDispatchChosen.ok) return fail(finalDispatchChosen.code);
  if (!synchronousDomMutations.observe(
    finalDispatchChosen.value.options.map((option) => option.element.getRootNode()),
  )) return fail('CAPABILITY_DISABLED');
  const postFactsChooseFence = currentExecutionError();
  if (postFactsChooseFence) return fail(postFactsChooseFence);
  const postFactsExecutionMutatedDom = synchronousDomMutations.take();
  if (signal?.aborted || semanticUserEdits.wasUserEdited()) return fail('ABORTED');
  if (triggerWasReplaced()) return fail('ABORTED');
  // POST_FACTS_SEMANTIC_FENCE: currentExecutionError() is an adapter callback.
  // It may invalidate semantic state that is intentionally opaque to raw DOM
  // facts while still returning success. Re-prove the rule-owned transaction
  // only after that final execution callback and before any option dispatch.
  let postFactsSemanticAtPreWrite = false;
  let postFactsSemanticCheckThrew = false;
  try {
    postFactsSemanticAtPreWrite =
      semanticTransaction.isAtPreWriteState() === true;
  } catch {
    postFactsSemanticCheckThrew = true;
  }
  if (signal?.aborted || semanticUserEdits.wasUserEdited()) return fail('ABORTED');
  if (triggerWasReplaced()) return fail('ABORTED');
  if (postFactsSemanticCheckThrew || !postFactsSemanticAtPreWrite) {
    return fail('IDENTITY_CHANGED');
  }
  if (trigger.value !== input.previousRawValue) return fail('IDENTITY_CHANGED');
  const postFactsSemanticCheckMutatedDom = synchronousDomMutations.take();
  const dispatchObservationTargets = captureScanRootObservationTargets(root);
  if (!dispatchObservationTargets) return fail('CAPABILITY_DISABLED');
  if (!sameNodeSet(observationTargets, dispatchObservationTargets)) {
    return fail('IDENTITY_CHANGED');
  }
  if (
    !sameOptionMembership(
      sealedDispatchMembership,
      finalDispatchChosen.value.options,
    ) ||
    !liveOptionSetMatches(finalDispatchChosen.value.options, settledSignature)
  ) {
    return fail('IDENTITY_CHANGED');
  }
  if (!sameClickTargetFacts(liveFacts, dispatchFacts)) {
    return fail('CLICK_DENIED');
  }
  if (
    !finalDispatchChosen.value.chosen.element.isConnected ||
    finalDispatchChosen.value.chosen.element !== chosen.element ||
    finalDispatchChosen.value.chosen.text !== text
  ) return fail('IDENTITY_CHANGED');
  if (trigger.value !== input.previousRawValue) return fail('IDENTITY_CHANGED');
  // Preserve the stable CLICK_DENIED contract for a callback that makes the
  // exact option hidden/Submit-looking. If the fresh facts are otherwise safe,
  // any mutation made while a callback/fact reader returned its answer is
  // stale authority and must stop before clickHostTarget.
  if (!evaluateClickTarget(dispatchFacts).allowed) return fail('CLICK_DENIED');
  if (factsMutatedDom) return fail('CLICK_DENIED');
  if (
    sourceMutatedDom ||
    finalExecutionMutatedDom ||
    finalSemanticCheckMutatedDom ||
    finalSourceMutatedDom ||
    postFactsSourceMutatedDom ||
    postFactsExecutionMutatedDom ||
    postFactsSemanticCheckMutatedDom
  ) {
    return fail('IDENTITY_CHANGED');
  }
  if (synchronousDomMutations.take()) return fail('IDENTITY_CHANGED');
  let restoreIsReady = false;
  try {
    restoreIsReady = semanticTransaction.canRestorePreWrite() === true;
  } catch {
    restoreIsReady = false;
  }
  if (!restoreIsReady) return fail('CAPABILITY_DISABLED');
  const postRestoreAuthorityFence = currentExecutionError();
  if (postRestoreAuthorityFence) return fail(postRestoreAuthorityFence);
  try {
    if (semanticTransaction.isAtPreWriteState() !== true) {
      return fail('IDENTITY_CHANGED');
    }
  } catch {
    return fail('IDENTITY_CHANGED');
  }
  if (synchronousDomMutations.take()) return fail('IDENTITY_CHANGED');

  const preserveExactResidualForFailure = (code: ApplyErrorCode): ApplyErrorCode => {
    try {
      if (semanticTransaction.isAtPreWriteState() === true) return code;
    } catch {
      // Only an exact written-state seal may authorize later compensation.
    }
    const sealed = sealExactWrittenResidual();
    return sealed ?? code;
  };
  const pointerSequenceFence = (
    phase: 'before-mousedown' | 'after-mousedown' | 'after-mouseup',
  ): ApplyErrorCode | null => {
    // Host pointer handlers may mutate the DOM before this fence runs. Consume
    // those records, then account for their result through a complete fresh
    // rule-owned read instead of treating every host mutation as drift.
    synchronousDomMutations?.take();
    if (signal?.aborted || semanticUserEdits.wasUserEdited()) return 'ABORTED';
    if (triggerWasReplaced()) return preserveExactResidualForFailure('ABORTED');

    const phaseSelection = revalidateChosen();
    if (!phaseSelection.ok) return preserveExactResidualForFailure(phaseSelection.code);
    const phaseTargets = captureScanRootObservationTargets(root);
    if (
      !phaseTargets ||
      !sameNodeSet(observationTargets, phaseTargets) ||
      !sameOptionMembership(sealedDispatchMembership, phaseSelection.value.options) ||
      !liveOptionSetMatches(phaseSelection.value.options, settledSignature) ||
      phaseSelection.value.chosen.element !== chosen.element ||
      phaseSelection.value.chosen.text !== text ||
      !phaseSelection.value.chosen.element.isConnected
    ) return preserveExactResidualForFailure('IDENTITY_CHANGED');
    if (!synchronousDomMutations?.observe(
      phaseSelection.value.options.map((option) => option.element.getRootNode()),
    )) return preserveExactResidualForFailure('CAPABILITY_DISABLED');

    let phaseRestoreReady = false;
    try {
      phaseRestoreReady = semanticTransaction.canRestorePreWrite() === true;
    } catch {
      phaseRestoreReady = false;
    }
    if (!phaseRestoreReady) return preserveExactResidualForFailure('CAPABILITY_DISABLED');
    const phaseExecutionFence = currentExecutionError();
    if (phaseExecutionFence) return preserveExactResidualForFailure(phaseExecutionFence);

    // canRestorePreWrite()/executionFence are callbacks. Re-read the full
    // node/text/root/membership seal after them, then prove the opaque state.
    const finalPhase = revalidateChosen();
    if (!finalPhase.ok) return preserveExactResidualForFailure(finalPhase.code);
    const finalPhaseTargets = captureScanRootObservationTargets(root);
    if (
      !finalPhaseTargets ||
      !sameNodeSet(observationTargets, finalPhaseTargets) ||
      !sameOptionMembership(sealedDispatchMembership, finalPhase.value.options) ||
      !liveOptionSetMatches(finalPhase.value.options, settledSignature) ||
      finalPhase.value.chosen.element !== chosen.element ||
      finalPhase.value.chosen.text !== text ||
      !finalPhase.value.chosen.element.isConnected
    ) return preserveExactResidualForFailure('IDENTITY_CHANGED');
    const semanticOwnership = provePreWriteOrExactWritten();
    if (semanticOwnership) return semanticOwnership;

    // A rule callback that mutated otherwise safe DOM while returning the same
    // stale membership is not authority. Hidden/Submit-looking drift is still
    // classified by clickHostTarget's fresh generic facts as CLICK_DENIED.
    if (synchronousDomMutations?.take()) {
      let freshFacts: ClickTargetFacts;
      try {
        freshFacts = optionFacts(finalPhase.value.chosen, root);
      } catch {
        return preserveExactResidualForFailure('CLICK_DENIED');
      }
      return preserveExactResidualForFailure(
        evaluateClickTarget(freshFacts).allowed ? 'IDENTITY_CHANGED' : 'CLICK_DENIED',
      );
    }
    return null;
  };
  let clicked: ReturnType<typeof clickHostTarget>;
  try {
    clicked = clickHostTarget({
      element: finalDispatchChosen.value.chosen.element,
      facts: dispatchFacts,
      root,
      authority,
      ticket,
      policy,
      pointerSequenceFence,
    });
  } catch {
    return fail('CLICK_DENIED');
  }
  if (!clicked.ok) {
    return fail(clicked.code);
  }

  // Some widgets commit semantic backing on mousedown/click synchronously.
  // Seal that exact transaction-owned residual before any readback callback
  // can replace it with an unrelated third state. A host that settles later
  // may legitimately have no seal yet; success still requires the final seal.
  const immediateResidualSeal = sealExactWrittenResidual();
  if (immediateResidualSeal !== null && immediateResidualSeal !== 'IDENTITY_CHANGED') {
    return fail(immediateResidualSeal);
  }

  // Let the host render its backing state before bounded semantic readback.
  if (!(await nextMacrotask(signal))) {
    return fail('ABORTED');
  }
  if (signal?.aborted) {
    return fail('ABORTED');
  }
  const finalFence = currentExecutionError();
  if (finalFence) {
    return fail(finalFence);
  }
  if (triggerWasReplaced()) {
    return fail('ABORTED');
  }
  const settledResidualSeal = sealExactWrittenResidual();
  if (settledResidualSeal !== null && settledResidualSeal !== 'IDENTITY_CHANGED') {
    return fail(settledResidualSeal);
  }
  let verified: string | null = null;
  for (let attempt = 0; attempt < MAX_COMBOBOX_READBACK_ATTEMPTS; attempt += 1) {
    if (triggerWasReplaced()) return fail('ABORTED');
    try {
      verified = readSelection?.(trigger, text) ?? null;
    } catch {
      // The rule-owned readback is an untrusted boundary. Collapse arbitrary
      // exceptions into the existing null verdict so semantic compensation
      // runs before reporting the stable VERIFY_TIMEOUT contract.
      verified = null;
    }
    const readbackExecutionFence = currentExecutionError();
    if (readbackExecutionFence) return fail(readbackExecutionFence);
    let popupRemainsOpen = false;
    try {
      popupRemainsOpen = input.optionSource.isOpen(trigger);
    } catch {
      return fail('CAPABILITY_DISABLED');
    }
    // A normal selection may close and detach the option list. If the exact
    // rule-owned popup remains open, its full membership must still match; if
    // it closed, selected-state readback plus the sealed semantic transaction
    // are the only valid post-click authority (cached option DOM is not).
    if (popupRemainsOpen) {
      const postReadbackMembership = revalidateChosen();
      if (!postReadbackMembership.ok) return fail(postReadbackMembership.code);
    }
    const postReadbackMembershipFence = currentExecutionError();
    if (postReadbackMembershipFence) return fail(postReadbackMembershipFence);
    if (triggerWasReplaced()) return fail('ABORTED');
    if (verified !== null || attempt + 1 >= MAX_COMBOBOX_READBACK_ATTEMPTS) break;
    if (!(await nextMacrotask(signal))) {
      return fail('ABORTED');
    }
    const retryFence = currentExecutionError();
    if (retryFence) {
      return fail(retryFence);
    }
  }
  if (verified === null || verified !== text) {
    return fail('VERIFY_TIMEOUT');
  }
  if (triggerWasReplaced()) return fail('ABORTED');
  let undo: ComboboxSemanticUndoTransaction | null = null;
  try {
    undo = semanticTransaction.captureWrittenState(text);
    if (!semanticUndoOwnsExactWrittenState(undo, semanticUserEdits)) {
      disposeSemanticUndo(undo);
      return fail('IDENTITY_CHANGED');
    }
  } catch {
    disposeSemanticUndo(undo);
    return fail('IDENTITY_CHANGED');
  }
  // The final capture and written-state callbacks are untrusted boundaries.
  // Re-run the execution fence after they return; no success may leak through
  // a callback that simultaneously revoked policy or staled the scan.
  const postWrittenStateFence = currentExecutionError();
  if (postWrittenStateFence) {
    disposeSemanticUndo(undo);
    return fail(postWrittenStateFence);
  }
  const trackedUndo = trackedSemanticUndo(undo, semanticUserEdits);
  replaceSealedResidual(null);
  semanticWatchTransferred = true;
  return { ok: true, value: { optionText: text, verified, undo: trackedUndo } };
  } catch {
    return fail('CLICK_DENIED');
  } finally {
    synchronousDomMutations?.stop();
    if (!semanticWatchTransferred) disposeSemanticUndo(sealedResidual);
    if (!semanticWatchTransferred) semanticUserEdits.stop();
  }
}

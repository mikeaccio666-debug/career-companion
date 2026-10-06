/**
 * Fill-first write for one ARIA-proxied question (2026-09-23; `dict/ariaChoice.ts` has the why).
 *
 * The host publishes each option's state as `aria-pressed` / `aria-checked` on the proxy; the native
 * controls, if any, are hidden carriers or mirrors whose `checked` is not evidence (Workable's lags
 * and disagrees, Ashby's mirrors only "Yes"). So this leaf:
 *
 *  · reads state **only** from the proxies' published ARIA state, through the realm's own
 *    `Element.prototype.getAttribute` (a host-owned accessor cannot answer for it);
 *  · writes **only** by clicking — one click per option the answer presses, through
 *    `activateProxiedChoiceOptions` (the click boundary: static deny table, submit/reset veto,
 *    DOM-derived carrier). It never sets an attribute or a property: ARIA state is the host's to
 *    change, and there is no property fallback — a click the host does not take is a failure;
 *  · proves success from the host's own published state after settling, then again after the late
 *    window, exactly like every other fill-first control (`executeFillOnlySemanticWrite`).
 *
 * Fill-first, like native choice groups: nothing is journaled and there is no Undo (`undo.ts` states
 * it). Reversing would take another host click — Ashby un-presses a toggle clicked twice, a checked
 * Workable radio cannot be unchecked at all — and this lane takes no unreviewed host action. The
 * answers stay as the host shows them; the user changes them on the page.
 */

import type { ApplyErrorCode, ProxyChoiceGroupShape, Result, ScanRoot } from '../contracts.ts';
import { activateProxiedChoiceOptions } from '../click/primitives.ts';
import type { SignOnBehalfChoiceKind } from '../dict/signOnBehalf.ts';
import {
  ARIA_PROXY_OPTION_SELECTOR,
  ariaProxyCarrier,
  ariaProxyKind,
  ariaProxyStateAttribute,
  canSubmitOrResetAForm,
} from '../dict/ariaChoice.ts';
import { executeFillOnlySemanticWrite, type FillOnlyHostWriteAuthority } from './fillOnlySemantic.ts';
import { classifyHostValidation, type HostValidationSignals } from './verify.ts';
import { runWithSubmitVeto } from './submitVeto.ts';

export interface FillProxyChoiceGroupInput {
  readonly choice: ProxyChoiceGroupShape;
  /** The option labels the reviewed answer names (`chosenOptions`), in option order. */
  readonly chosen: readonly string[];
  /** The click boundary re-proves this root itself; it is not trusted from here. */
  readonly root: ScanRoot;
  /** Re-read inside the click boundary; false = this deployment may not click. */
  readonly clickCapabilityCurrent: () => boolean;
  readonly authorizeWrite: () => Promise<boolean>;
  readonly readHostValidation?: (element: Element) => HostValidationSignals;
  readonly executionFence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  /** Focused-test seams; production uses the bounded shared settle. */
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (milliseconds: number, signal?: AbortSignal) => Promise<void> | void;
  /**
   * 以用户名义代填的这一题（2026-09-24，只有六类同意）：类别与题干元素交给点击边界，每一下之前在那里
   * 把此刻的题干与选项各认一遍。这条写入路本来就没有属性回落，点击被拒就如实失败。
   */
  readonly signing?: Readonly<{ kind: SignOnBehalfChoiceKind; question: Element }>;
}

/**
 * An ARIA proxy has no constraint-validation API, so "the host accepted this answer" can only be the
 * host's own published state — which `isAtWrittenState` has already proven before validation is read.
 * An explicit rejection signal (`aria-invalid="true"`, a referenced error message) still wins.
 */
const PUBLISHED_STATE_ACCEPTED: HostValidationSignals = Object.freeze({ ariaInvalid: 'false' });

interface PreparedOption {
  readonly element: HTMLElement;
  readonly carrier: HTMLInputElement | null;
  readonly label: string;
  /** Realm-owned `getAttribute`, bound to this option. */
  readonly read: (name: string) => string | null;
}

interface PreparedGroup {
  readonly options: readonly PreparedOption[];
  readonly kind: ProxyChoiceGroupShape['proxy'];
  readonly state: 'aria-pressed' | 'aria-checked';
  readonly container: Element | null;
  readonly rootNode: Node;
}

type PrepareFailure = 'DETACHED' | 'IDENTITY_CHANGED' | 'TARGET_NOT_WRITABLE' | 'CLICK_DENIED';

function realmReader(element: Element): ((name: string) => string | null) | null {
  try {
    const getAttribute = element.ownerDocument.defaultView?.Element?.prototype.getAttribute;
    if (typeof getAttribute !== 'function') return null;
    return (name: string) => getAttribute.call(element, name) as string | null;
  } catch {
    return null;
  }
}

function token(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

function isNativeControl(element: Element): boolean {
  return ['input', 'select', 'textarea'].includes(element.localName);
}

function prepare(choice: ProxyChoiceGroupShape): { ok: true; value: PreparedGroup } | { ok: false; code: PrepareFailure } {
  const first = choice.options[0];
  if (first === undefined) return { ok: false, code: 'IDENTITY_CHANGED' };
  const rootNode = first.element.getRootNode();
  const options: PreparedOption[] = [];
  for (const option of choice.options) {
    if (!option.element.isConnected || option.carrier?.isConnected === false) return { ok: false, code: 'DETACHED' };
    const read = realmReader(option.element);
    if (read === null) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    options.push(Object.freeze({ element: option.element, carrier: option.carrier, label: option.label, read }));
  }
  const group: PreparedGroup = Object.freeze({
    options: Object.freeze(options),
    kind: choice.proxy,
    state: ariaProxyStateAttribute(choice.proxy),
    container: choice.container,
    rootNode,
  });
  const identity = identityFailure(group);
  if (identity !== null) return { ok: false, code: identity };
  return { ok: true, value: group };
}

/**
 * The exact reviewed option set is still here: every option connected in the same tree, still the
 * same kind of proxy with a readable state, still wrapping the same carrier; the container still
 * holds exactly these options and no other proxy; no option has grown a form owner a click could
 * submit or reset.
 */
function identityFailure(group: PreparedGroup): PrepareFailure | null {
  try {
    for (const option of group.options) {
      if (!option.element.isConnected || option.element.getRootNode() !== group.rootNode) return 'DETACHED';
      if (option.carrier !== null && (!option.carrier.isConnected || option.carrier.getRootNode() !== group.rootNode)) {
        return 'DETACHED';
      }
      if (ariaProxyKind(option.element) !== group.kind) return 'IDENTITY_CHANGED';
      if (ariaProxyCarrier(option.element, group.kind) !== option.carrier) return 'IDENTITY_CHANGED';
      if (canSubmitOrResetAForm(option.element)) return 'CLICK_DENIED';
    }
    if (group.container !== null) {
      if (!group.container.isConnected) return 'IDENTITY_CHANGED';
      const live = [...group.container.querySelectorAll(ARIA_PROXY_OPTION_SELECTOR)].filter((element) => !isNativeControl(element));
      if (
        live.length !== group.options.length ||
        live.some((element, index) => element !== group.options[index]!.element)
      ) return 'IDENTITY_CHANGED';
    }
    return null;
  } catch {
    return 'IDENTITY_CHANGED';
  }
}

/** A disabled or attribute-hidden option cannot take a click now; that is not a different page. */
function notWritable(group: PreparedGroup): boolean {
  return group.options.some((option) =>
    option.read('aria-disabled') === 'true' ||
    option.read('aria-hidden') === 'true' ||
    option.read('hidden') !== null ||
    (option.element as Partial<HTMLButtonElement>).disabled === true ||
    option.carrier?.disabled === true);
}

/** Published state per option; null when any option's state is unreadable. */
function publishedVector(group: PreparedGroup): readonly boolean[] | null {
  const vector: boolean[] = [];
  for (const option of group.options) {
    const pressed = token(option.read(group.state));
    if (pressed === null) return null;
    vector.push(pressed);
  }
  return vector;
}

function vectorIs(group: PreparedGroup, wanted: readonly boolean[]): boolean {
  if (identityFailure(group) !== null) return false;
  const live = publishedVector(group);
  return live !== null && live.length === wanted.length && live.every((value, index) => value === wanted[index]);
}

/**
 * Cancel any `submit` / `reset` delivered while one synchronous dispatch runs; report whether one was
 * seen. The registration rules live in `write/submitVeto.ts` (shared with the row-save click). Forms in
 * a shadow tree dispatch non-composed events, so the option's own root is watched too. If the veto
 * cannot be installed, nothing is dispatched.
 */
function submitVeto(group: PreparedGroup): (activate: () => void) => boolean {
  return (activate) => runWithSubmitVeto(group.options[0]!.element.ownerDocument, group.rootNode, activate);
}

export async function fillProxyChoiceGroup(input: FillProxyChoiceGroupInput): Promise<Result<void>> {
  const prepared = prepare(input.choice);
  if (!prepared.ok) return { ok: false, code: prepared.code };
  const group = prepared.value;

  const indexes = input.chosen.map((label) => group.options.findIndex((option) => option.label === label));
  if (indexes.length === 0 || indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) {
    return { ok: false, code: 'NO_VALUE' };
  }
  if (!input.choice.multiple && indexes.length !== 1) return { ok: false, code: 'NO_VALUE' };
  const desired = group.options.map((_option, index) => indexes.includes(index));
  const empty = group.options.map(() => false);

  // 这一组已经**正是**要写的那个答案（宿主自己也这么公布）：那是成功——重填循环会在同一页上
  // 把同一栏再走一遍，我们自己刚点上去的那一下不该被读成「身份变了」。
  if (vectorIs(group, desired)) return { ok: true, value: undefined };
  const before = publishedVector(group);
  if (before === null) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  // 已经有别的答案：fill-first 不覆盖用户（或宿主默认）作过的选择。
  if (before.some(Boolean)) return { ok: false, code: 'NOT_EMPTY' };

  const targetFence = (): ApplyErrorCode | null => {
    const identity = identityFailure(group);
    if (identity !== null) return identity;
    return notWritable(group) ? 'TARGET_NOT_WRITABLE' : null;
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

  let activationCode: ApplyErrorCode | null = null;
  const writeForward = (authority: FillOnlyHostWriteAuthority): boolean => {
    const outcome = activateProxiedChoiceOptions({
      activations: indexes.map((index) => ({
        element: group.options[index]!.element,
        carrier: group.options[index]!.carrier,
      })),
      root: input.root,
      authority,
      capabilityCurrent: input.clickCapabilityCurrent,
      // Hosts publish asynchronously, so an earlier press may not show yet. What must hold before
      // each dispatch: the fences, this option still unpressed, and nothing outside the answer pressed.
      beforeEach: (step) => {
        if (!forwardFenceCurrent()) return false;
        const live = publishedVector(group);
        const target = indexes[step]!;
        return live !== null && live[target] === false && live.every((pressed, index) => !pressed || desired[index] === true);
      },
      withSubmitVeto: submitVeto(group),
      ...(input.signing === undefined ? {} : { signing: input.signing }),
    });
    activationCode = outcome.ok ? null : outcome.code;
    return outcome.ok;
  };

  const validationTargets = [
    ...(group.container === null ? [] : [group.container]),
    ...indexes.map((index) => group.options[index]!.element),
  ];
  const result = await executeFillOnlySemanticWrite({
    authorizeWrite: input.authorizeWrite,
    executionFence: input.executionFence,
    targetFence,
    isAtPreWriteState: () => vectorIs(group, empty),
    isAtWrittenState: () => vectorIs(group, desired),
    writeForward,
    readHostValidation: () => {
      for (const target of validationTargets) {
        let signals: HostValidationSignals = {};
        try {
          signals = input.readHostValidation?.(target) ?? {};
        } catch {
          signals = {};
        }
        if (classifyHostValidation(signals) === 'rejected') return signals;
      }
      return PUBLISHED_STATE_ACCEPTED;
    },
    lateRecheckMs: input.lateRecheckMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.settle === undefined ? {} : { settle: input.settle }),
    ...(input.lateRecheckDelay === undefined ? {} : { lateRecheckDelay: input.lateRecheckDelay }),
  });
  if (!result.ok) {
    // 执行器把 writeForward 的 false 一律折成 HOST_REJECTED；「这一下根本没打起来」（点击被拒、
    // 能力关了、目标脱离）与「宿主不认这个答案」下一步不同，把确切的码还回去。
    if (activationCode !== null && result.code === 'HOST_REJECTED') return { ok: false, code: activationCode };
    return { ok: false, code: result.code };
  }
  const code = result.observation.finalize();
  result.observation.dispose();
  return code === null ? { ok: true, value: undefined } : { ok: false, code };
}

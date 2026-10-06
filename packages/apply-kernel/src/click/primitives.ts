/**
 * The single exit through which autofill may click a host control.
 *
 * 铁律 2 forbade host clicks outright; 决策 16（负责人 2026-07-31）opened a
 * narrow break for searchable dropdowns, choices, dates and resume upload.
 * "Narrow" only means anything if there is exactly one place a click can
 * happen, so this module exists to be that place:
 *
 *   - every call re-runs `evaluateClickTarget`, and a denial dispatches
 *     nothing at all — not even a `pointerdown`;
 *   - the caller must hold a `HostWriteAuthority` carrying `set-combobox`,
 *     a `WriteTicket` (so an undo entry already exists), and the runtime
 *     policy that authorised this run;
 *   - the deny list inside `policy.ts` is not configurable: final Submit,
 *     Next/Continue, consent, legal declarations, passwords, OTP, CAPTCHA,
 *     login/payment, file dialogs, links, honeypots and hidden controls can
 *     never become eligible, whatever facts a caller supplies.
 *
 * Locked by `tests/s0/apply-click-within-policy.redgreen.test.ts`, which was
 * written before this file existed (决策 15 requires the red/green test change
 * to land before the code).
 *
 * 2026-09-15：`activateReviewedChoiceGroup` 是这个出口上唯一一处**不预先取消
 * 默认动作**的点击——已审阅的单选/复选成员，默认动作就是要写进去的那件事。
 * 它不走 Undo 日志那条路（fill-first 冻结撤销），拿的是一次性的
 * `FillOnlyHostWriteAuthority`，另外自带能力位复核与整组先验后点。
 * 理由与三道抵消保证写在该函数头部。
 */

import {
  evaluateClickTarget,
  evaluateUnsignedClickTarget,
  type ClickPolicyDecision,
  type ClickTargetFacts,
} from './policy.ts';
import type { SignOnBehalfChoiceKind } from '../dict/signOnBehalf.ts';
import { collectClickFacts, type ClickFactsContext } from './facts.ts';
import { checkActiveCapability, rowActionOfAuthority, type HostWriteAuthority, type WriteCapability } from '../grant.ts';
import type { ApplyErrorCode, Result, ScanRoot, WriteTicket } from '../contracts.ts';
import { captureScanRootObservationTargets, isTrustedScanRoot } from '../scanRoot.ts';
import {
  consumeFillOnlyHostWriteAuthority,
  type FillOnlyHostWriteAuthority,
} from '../write/fillOnlySemantic.ts';

/**
 * 这一下点击用哪张表判。前向写入（下拉、选择题、代理题、行动作）用 `evaluateClickTarget`——它认得
 * 代填标记；还原点击从来不代填，用 `evaluateUnsignedClickTarget`（带着标记一律拒）。两者只差这一处，
 * 其余拒绝逐字相同。分开传而不给默认值，是为了让只用还原点击的 worker 包不必带上代填判据（2026-09-24）。
 */
type ClickEvaluator = (facts: ClickTargetFacts) => ClickPolicyDecision;

/** The click boundary consumes only the already-validated capability projection. */
interface ClickCapabilityPolicy {
  readonly enabled: boolean;
  readonly capabilities: Readonly<Record<WriteCapability, boolean>>;
}

/**
 * 一张授权最多能派出几次宿主点击。
 *
 * 本文件头一句自陈：「『Narrow』only means anything if there is exactly one place
 * a click can happen」——那个地方就该有计数器。今天一次 run 的点击次数被
 * `plan.entries` 定长绑死；行循环接进来之后，一次用户批准最坏是 12 次加行 +
 * 12 次保存 + 每个 combobox 两下。`MAX_ROW_ADDS` 是**编排层**的墙，
 * 编排层自己走岔（重复走同一步、状态机出错、宿主不响应导致重试）时它一次都不拦。
 *
 * 64 的取法：12 行 × (1 加行 + 1 保存 + 2 下拉) = 48，留一倍余量给根域的下拉。
 * 它不是性能预算，是**失控刹车**——正常运行永远够不到它。
 */
export const MAX_HOST_CLICKS_PER_AUTHORITY = 64;

/** 计数挂在 authority 上：一次用户批准 = 一份预算。 */
const clicksByAuthority = new WeakMap<object, number>();

/** Clicking a widget is its own capability, revocable without killing text fills. */
const CLICK_CAPABILITY: WriteCapability = 'set-combobox';

/**
 * 行动作走自己的能力位。同一个出口、同一套 deny list，但能力可以单独关掉：
 * 关掉之后下拉照常工作，只是不再替用户增删/保存行（见 grant.ts 的说明）。
 */
function capabilityFor(kind: ClickTargetFacts['kind']): WriteCapability {
  return kind === 'row-add' || kind === 'row-save' || kind === 'row-remove'
    ? 'manage-rows'
    : CLICK_CAPABILITY;
}

export interface ClickHostTargetInput {
  readonly element: Element;
  readonly facts: ClickTargetFacts;
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  /** Proof that the field's original value is already recorded for Undo. */
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ClickCapabilityPolicy;
  /**
   * Selector-free transaction proof carried across the synthetic pointer
   * sequence. Combobox callers use it to re-read rule-owned membership,
   * identity, root and text after each dispatched event; generic callers may
   * omit it. A failure stops every remaining pointer event.
   */
  readonly pointerSequenceFence?: (
    phase: 'before-mousedown' | 'after-mousedown' | 'after-mouseup',
  ) => ApplyErrorCode | null;
  /**
   * The in-form combobox trigger whose ARIA popup a `transaction-option` must
   * sit in (portaled menus). Re-derived from the DOM at every pointer phase by
   * `collectClickFacts`; see `withinOwnedPopup` in click/policy.ts.
   */
  readonly popupOwner?: Element;
  /** The rule's typeahead suggestion shape, re-derived the same way; see `ruleDeclaredOption`. */
  readonly declaredSuggestion?: ClickFactsContext['declaredSuggestion'];
  /**
   * The rule's portaled-popup shape for a hierarchical prompt, re-derived the
   * same way at every pointer phase — including the document-uniqueness of the
   * popup root; see `withinRuleDeclaredPopup` in click/policy.ts.
   */
  readonly declaredPopup?: ClickFactsContext['declaredPopup'];
}

export type ClickHostTargetError = ApplyErrorCode;

/**
 * Dispatch the pointer sequence a widget library actually listens for.
 *
 * `mousedown` comes first and matters: select2 and react-select open their
 * listbox on mousedown, not click, so a click-only sequence silently does
 * nothing on the most common libraries (V2 方案 §4.4).
 */
function sameFacts(left: ClickTargetFacts, right: ClickTargetFacts): boolean {
  const leftRecord = left as unknown as Readonly<Record<string, unknown>>;
  const rightRecord = right as unknown as Readonly<Record<string, unknown>>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => Object.is(leftRecord[key], rightRecord[key]));
}

function sameNodeSet(left: readonly Node[], right: readonly Node[]): boolean {
  return left.length === right.length && left.every((node) => right.includes(node));
}

function recollectClickFacts(
  element: Element,
  root: ScanRoot,
  baseline: ClickTargetFacts,
  context: ClickFactsContext,
): ClickTargetFacts {
  return collectClickFacts({
    element,
    root,
    kind: baseline.kind,
    planned: baseline.planned,
    openedByTransaction: baseline.openedByTransaction,
    ...(context.popupOwner === undefined ? {} : { popupOwner: context.popupOwner }),
    ...(context.declaredSuggestion === undefined ? {} : { declaredSuggestion: context.declaredSuggestion }),
    ...(context.declaredPopup === undefined ? {} : { declaredPopup: context.declaredPopup }),
    ...(context.intendedCarrier === undefined ? {} : { intendedCarrier: context.intendedCarrier }),
    ...(context.signingQuestion === undefined ? {} : { signingQuestion: context.signingQuestion }),
    ...(baseline.declaredRowAction === undefined
      ? {}
      : { declaredRowAction: baseline.declaredRowAction }),
    ...(baseline.choiceControl === undefined
      ? {}
      : { choiceControl: baseline.choiceControl }),
    // 代填的类别是计划给的，原样带过去；文字是重新读的，点击策略拿新文字再判一次是不是这一类。
    ...(baseline.signOnBehalf === undefined
      ? {}
      : { signOnBehalf: baseline.signOnBehalf }),
    ...(baseline.isLikelyOffscreen === undefined
      ? {}
      : { isLikelyOffscreen: baseline.isLikelyOffscreen }),
    ...(baseline.isLikelyHoneyPot === undefined
      ? {}
      : { isLikelyHoneyPot: baseline.isLikelyHoneyPot }),
  });
}

function pointerTargetStillAllowed(
  element: Element,
  root: ScanRoot,
  baseline: ClickTargetFacts,
  context: ClickFactsContext,
  evaluate: ClickEvaluator,
): boolean {
  if (!element.isConnected) return false;
  try {
    const fresh = recollectClickFacts(element, root, baseline, context);
    return sameFacts(baseline, fresh) && evaluate(fresh).allowed;
  } catch {
    return false;
  }
}

function dispatchPointerSequence(
  element: Element,
  root: ScanRoot,
  baseline: ClickTargetFacts,
  pointerSequenceFence: ClickHostTargetInput['pointerSequenceFence'] | undefined,
  context: ClickFactsContext,
  evaluate: ClickEvaluator,
): Result<void, ApplyErrorCode> {
  const revalidate = (
    phase: 'before-mousedown' | 'after-mousedown' | 'after-mouseup',
  ): ApplyErrorCode | null => {
    const ruleOwnedFence = (): ApplyErrorCode | null => {
      if (!pointerSequenceFence) return null;
      try {
        const failure = pointerSequenceFence(phase);
        if (failure !== null) return failure;
      } catch {
        return 'ABORTED';
      }
      return null;
    };
    const firstRuleFence = ruleOwnedFence();
    if (firstRuleFence) return firstRuleFence;
    // Generic fact getters are also an untrusted boundary. Re-run the complete
    // rule-owned node/text/root/membership fence after them so a getter cannot
    // remove membership while returning the cached policy-safe facts used for
    // the next pointer event.
    if (!pointerTargetStillAllowed(element, root, baseline, context, evaluate)) return 'CLICK_DENIED';
    return ruleOwnedFence();
  };
  const options = { bubbles: true, cancelable: true, composed: true } as const;
  const beforeMouseDown = revalidate('before-mousedown');
  if (beforeMouseDown) return { ok: false, code: beforeMouseDown };
  element.dispatchEvent(new MouseEvent('mousedown', options));
  // A widget that consumes the pointer-down itself (Lever's location list replaces
  // its suggestion rows inside the mousedown handler, 2026-09-15) leaves a detached
  // target that no further event can reach: mouseup and click are not sent at all,
  // and the caller's readback decides whether the pick took. Only the generic lane
  // takes this exit; a rule-owned fence keeps its own verdict on the semantic lane.
  if (!element.isConnected && !pointerSequenceFence) return { ok: true, value: undefined };
  const afterMouseDown = revalidate('after-mousedown');
  if (afterMouseDown) return { ok: false, code: afterMouseDown };
  element.dispatchEvent(new MouseEvent('mouseup', options));
  const afterMouseUp = revalidate('after-mouseup');
  if (afterMouseUp) return { ok: false, code: afterMouseUp };
  // Host widget listeners still observe the synthetic click, but native default
  // actions are never needed by the currently released combobox/option lane.
  // Pre-cancelling closes the browser default-action race if a host click
  // listener mutates the element into a submit control during propagation.
  const click = new MouseEvent('click', options);
  click.preventDefault();
  element.dispatchEvent(click);
  // Option widgets commonly remove the chosen node during their click handler;
  // post-dispatch detachment is therefore success, not drift. Native default
  // action was already irrevocably cancelled before propagation began.
  return { ok: true, value: undefined };
}

export function clickHostTarget(input: ClickHostTargetInput): Result<void, ClickHostTargetError> {
  const { element, facts, root, authority, ticket, policy } = input;

  // Order matters: cheap, non-consuming checks first so a rejected click never
  // burns the authority the caller still needs for the rest of the run.
  if (!ticket.ok) return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  const capability = capabilityFor(facts.kind);
  if (!policy.capabilities[capability]) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  // The same predicate the text/select writers use. Reusing it (rather than
  // reading `authority.capabilities` directly) keeps "who may write right now"
  // answered in exactly one place: it also enforces that the authority is
  // *active*, i.e. inside the synchronous run that consumed it, so a captured
  // authority object cannot be replayed later.
  const access = checkActiveCapability(authority, capability);
  if (!access.ok) return access;
  // 行专用票（grant.ts mintRowActionAuthorityFromGesture）只许点票上写的那一种：加行票只点「加一行」，
  // 保存票只点「保存本段」（2026-09-24）。删行不从那条路铸出来，就算规则声明过、policy 放行了也不放行。
  const rowAction = rowActionOfAuthority(authority);
  if (rowAction !== null && facts.kind !== (rowAction === 'add' ? 'row-add' : 'row-save')) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }

  // 预算排在 isConnected **之前**：耗尽就是耗尽，不该因为元素恰好还在页面上
  // 而多放过一次。自增在派发之前——一次被 policy 拒掉的点击也算尝试过，
  // 否则一个卡在 deny 上的重试循环可以无限次地敲同一个按钮。
  //
  // 报 `ABORTED` 而不是新造一个码：`Result` 的错误类型绑在稳定码集
  // `APPLY_ERROR_CODES` 上，往已上线的码集里加成员是 contract-class 变更
  // （RULE-GLOBAL-ERROR-CONTRACT）。而这件事语义上已经有归宿——`ABORTED` 的
  // 定义是「an earlier safety failure stopped this not-yet-written field」，
  // 逐字成立：失控刹车就是一次 safety failure。
  const spent = (clicksByAuthority.get(authority) ?? 0) + 1;
  if (spent > MAX_HOST_CLICKS_PER_AUTHORITY) return { ok: false, code: 'ABORTED' };
  clicksByAuthority.set(authority, spent);

  if (!element.isConnected) return { ok: false, code: 'DETACHED' };

  const decision = evaluateClickTarget(facts);
  if (!decision.allowed) return { ok: false, code: 'CLICK_DENIED' };

  const context: ClickFactsContext = {
    ...(input.popupOwner === undefined ? {} : { popupOwner: input.popupOwner }),
    ...(input.declaredSuggestion === undefined ? {} : { declaredSuggestion: input.declaredSuggestion }),
    ...(input.declaredPopup === undefined ? {} : { declaredPopup: input.declaredPopup }),
  };
  if (!pointerTargetStillAllowed(element, root, facts, context, evaluateClickTarget)) {
    return { ok: false, code: 'CLICK_DENIED' };
  }
  return dispatchPointerSequence(element, root, facts, input.pointerSequenceFence, context, evaluateClickTarget);
}

/** 一张账号票最多按几下：切一次视图、勾一次条款、按一次提交，再留一下余量。失控刹车，不是预算。 */
export const MAX_ACCOUNT_CLICKS_PER_AUTHORITY = 4;
const accountClicksByAuthority = new WeakMap<object, number>();

export interface ActivateAccountControlInput {
  readonly element: Element;
  /** 规则声明的这一颗是哪一个角色（解释器交出的账号墙这一步里，这个角色的那一个）。 */
  readonly role: NonNullable<ClickTargetFacts['declaredAccountControl']>;
  /** 账号墙容器做成的扫描根（`AccountWallStep.root`）：「在不在墙里」按它判。 */
  readonly root: ScanRoot;
  /** `mintAccountAccessAuthority` 铸、已 consume 的票。 */
  readonly authority: HostWriteAuthority;
  readonly policy: ClickCapabilityPolicy;
  /** 调用方量的「看不看得见」取反。内核不碰布局。 */
  readonly isLikelyOffscreen: boolean;
}

/**
 * 替用户按账号墙上规则声明的那一颗（2026-09-28）：「用邮箱登录」、切到登录／注册、注册条款勾选框、注册或登录那一下提交。
 *
 * 与本文件别的点击不同，这一下是**原生激活**（`element.click()`），不预先取消默认动作：要的就是网站自己的处理——
 * Workday 的提交外面罩着一层 `role=button` 的 click_filter，它的 onClick 走网站自己的表单提交；iCIMS 的「Next」是原生
 * submit，它的 submit 监听先跑隐形的人机验证、再由网站自己提交。所以放行前的判据比别的点击更严，而且每一下都现采：
 *
 *  · 策略整体开着、`account-access` 位开着（每一下都重读调用方交来的策略，远程关掉立刻不按）；
 *  · 票是 `account-access` 专用票、此刻活着（在同步的那一段里 consume 过）；
 *  · 这张票按的次数没超过 `MAX_ACCOUNT_CLICKS_PER_AUTHORITY`；
 *  · 点击策略的账号墙那张表（click/policy.ts 的 `evaluateAccountControl`）按此刻采的事实放行。
 *
 * 随包字节里没有 `.submit(` / `.requestSubmit(`：提交只经网站自己的按钮（RULE-EXT-NEVER-SUBMIT 的字节闸照旧）。
 */
export type ActivateAccountControlError = Extract<ClickHostTargetError,
  'POLICY_DISABLED' | 'CAPABILITY_DISABLED' | 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'ABORTED' | 'DETACHED' | 'CLICK_DENIED'>;

export function activateAccountControl(input: ActivateAccountControlInput): Result<void, ActivateAccountControlError> {
  const { element, role, root, authority, policy } = input;
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  if (!policy.capabilities['account-access']) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const access = checkActiveCapability(authority, 'account-access');
  if (!access.ok) return access;
  const spent = (accountClicksByAuthority.get(authority) ?? 0) + 1;
  if (spent > MAX_ACCOUNT_CLICKS_PER_AUTHORITY) return { ok: false, code: 'ABORTED' };
  accountClicksByAuthority.set(authority, spent);
  if (!element.isConnected) return { ok: false, code: 'DETACHED' };
  let facts: ClickTargetFacts;
  try {
    facts = collectClickFacts({
      element,
      root,
      kind: 'account-control',
      planned: true,
      declaredAccountControl: role,
      isLikelyOffscreen: input.isLikelyOffscreen,
    });
  } catch {
    return { ok: false, code: 'CLICK_DENIED' };
  }
  if (!evaluateClickTarget(facts).allowed) return { ok: false, code: 'CLICK_DENIED' };
  const click = (element as Partial<HTMLElement>).click;
  if (typeof click !== 'function') return { ok: false, code: 'CLICK_DENIED' };
  click.call(element);
  return { ok: true, value: undefined };
}

/**
 * One exact option click for the fill-first lane.
 *
 * This path deliberately cannot open a popup: the option must already be
 * visible in a complete reviewed UA-1 set, and the authority is synchronous,
 * one-shot, and minted only after the leaf's fresh authorization. It shares
 * the static deny table and pointer dispatcher with the legacy Undo lane but
 * accepts neither a WriteTicket nor a restoration callback.
 */
export function clickReviewedFillOnlyOption(input: Readonly<{
  element: Element;
  root: ScanRoot;
  authority: FillOnlyHostWriteAuthority;
  pointerSequenceFence?: ClickHostTargetInput['pointerSequenceFence'];
}>): Result<void, ClickHostTargetError> {
  const { element, root, authority } = input;
  if (!isTrustedScanRoot(root)) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (!element.isConnected) return { ok: false, code: 'DETACHED' };

  let facts: ClickTargetFacts;
  try {
    facts = collectClickFacts({
      element,
      root,
      kind: 'reviewed-option',
      planned: true,
    });
  } catch {
    return { ok: false, code: 'CLICK_DENIED' };
  }
  if (!evaluateClickTarget(facts).allowed || !pointerTargetStillAllowed(element, root, facts, {}, evaluateClickTarget)) {
    return { ok: false, code: 'CLICK_DENIED' };
  }
  if (!consumeFillOnlyHostWriteAuthority(authority)) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  return dispatchPointerSequence(element, root, facts, input.pointerSequenceFence, {}, evaluateClickTarget);
}

/** One reviewed member of a choice group that this activation must switch. */
export interface ReviewedChoiceActivation {
  readonly element: HTMLInputElement;
  /** The reviewed control kind; the element's own `type` must match it verbatim. */
  readonly control: 'radio' | 'checkbox';
  /** 代填的那一格（2026-09-23）：带进点击事实，点击策略在每一下之前重判文字仍是这一类。 */
  readonly signOnBehalf?: SignOnBehalfChoiceKind;
}

export interface ActivateReviewedChoiceGroupInput {
  /** Exactly the members whose live state differs from the reviewed answer, in DOM order. */
  readonly activations: readonly ReviewedChoiceActivation[];
  readonly root: ScanRoot;
  readonly authority: FillOnlyHostWriteAuthority;
  /**
   * The click capability, re-read here rather than trusted from the caller: the
   * fill-only lane carries no `ApplyPolicy`, but "who may click right now" still
   * has to be answered inside the click boundary. Re-run before the authority is
   * consumed and before every single activation, so a mid-run revocation stops
   * the remaining members of a multi-answer group.
   */
  readonly capabilityCurrent: () => boolean;
  /** Re-proves group identity and that this member still needs activating. */
  readonly beforeEach: (index: number) => boolean;
  /** Proves the activation produced exactly the reviewed state for this member. */
  readonly afterEach: (index: number) => boolean;
  /**
   * Opens the caller's event-ownership window around the one native activation
   * and runs it. The caller owns what "ours" means for the click and for the
   * `input`/`change` the user agent emits as the activation behaviour, and it
   * is the caller that keeps a form from submitting inside that window.
   */
  readonly withOwnership: (element: HTMLInputElement, activate: () => void) => boolean;
}

/**
 * Natively activate the reviewed members of one choice group.
 *
 * ## 为什么必须是原生激活
 *
 * 受控宿主（Ashby 的 React 组，2026-09-15 实测）只在 `click` 上挂 `onChange`：
 * 原生 setter 写 `checked` + 派 `input`/`change` 它一概不认，下一次重渲染把
 * 我们写进去的状态原样刷回去——lab 里就是那一栏稳定的 `LATE_REVERTED`。
 * 用户做的那一下是 click，所以要让宿主认账，我们也只能做那一下。
 *
 * ## 为什么这里不 `preventDefault`（全仓唯一一处）
 *
 * `dispatchPointerSequence` 预先取消 click 的默认动作，防的是「宿主监听器在
 * 传播途中把目标变成提交控件」那场竞态——它对下拉选项那种**默认动作未知**
 * 的目标是对的。而这里默认动作**就是我们要的那件事**：取消它，写入必然失败
 * （实测：取消后 checkbox 的选中态会被 canceled-activation 还原）。
 *
 * 代价用三道各自独立的保证抵掉：
 *   1. `choice-member` 这一种类要求目标是 `<input>` 且 `type` 与已审阅控件
 *      逐字相同。radio/checkbox 的 click 默认动作只有「改自己的选中态」；
 *      它不导航、不提交、不开文件对话框。
 *   2. 整张静态 deny 表照跑，且在**每一次**派发前用新采集的事实重跑一遍
 *      （`pointerTargetStillAllowed`）。
 *   3. 调用方的 `withOwnership` 窗口在这一下期间按住表单提交
 *      （见 write/choiceGroup.ts 的 `activateExpected`）——它比预先取消 click
 *      更强：连宿主监听器直接调 `form.submit()` 也拦得住。
 *
 * 全组先验、后点：任何一个成员被 policy 拒掉，一下都不发。
 */
export function activateReviewedChoiceGroup(
  input: ActivateReviewedChoiceGroupInput,
): Result<void, ClickHostTargetError> {
  const { activations, root, authority } = input;
  const capable = (): boolean => {
    try {
      return input.capabilityCurrent() === true;
    } catch {
      return false;
    }
  };
  if (!isTrustedScanRoot(root)) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (activations.length === 0) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (!capable()) return { ok: false, code: 'CAPABILITY_DISABLED' };
  // 一次答案里同一个控件最多被激活一次：checkbox 的 click 是**切换**，
  // 点两下等于没点。失控刹车沿用同一个上限常量。
  if (activations.length > MAX_HOST_CLICKS_PER_AUTHORITY) return { ok: false, code: 'ABORTED' };
  if (new Set(activations.map((activation) => activation.element)).size !== activations.length) {
    return { ok: false, code: 'CLICK_DENIED' };
  }

  const factsFor = (activation: ReviewedChoiceActivation): ClickTargetFacts | null => {
    try {
      return collectClickFacts({
        element: activation.element,
        root,
        kind: 'choice-member',
        planned: true,
        choiceControl: activation.control,
        ...(activation.signOnBehalf === undefined ? {} : { signOnBehalf: activation.signOnBehalf }),
      });
    } catch {
      return null;
    }
  };
  // Fail closed for the whole answer before the first click: a group whose
  // second member is denied must not be left half-activated.
  const baselines: ClickTargetFacts[] = [];
  for (const activation of activations) {
    if (!activation.element.isConnected) return { ok: false, code: 'DETACHED' };
    const facts = factsFor(activation);
    if (facts === null || !evaluateClickTarget(facts).allowed) {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    if (!pointerTargetStillAllowed(activation.element, root, facts, {}, evaluateClickTarget)) {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    baselines.push(facts);
  }

  if (!capable() || !consumeFillOnlyHostWriteAuthority(authority)) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }

  for (const [index, activation] of activations.entries()) {
    if (!capable()) return { ok: false, code: 'CAPABILITY_DISABLED' };
    let proceed = false;
    try {
      proceed = input.beforeEach(index) === true;
    } catch {
      return { ok: false, code: 'ABORTED' };
    }
    if (!proceed) return { ok: false, code: 'ABORTED' };
    // 每一下都重新采集事实再判一次：上一下可能让宿主重渲染，把这一个成员
    // 换成了别的东西。
    const fresh = factsFor(activation);
    if (
      fresh === null ||
      !sameFacts(baselines[index]!, fresh) ||
      !evaluateClickTarget(fresh).allowed ||
      !pointerTargetStillAllowed(activation.element, root, fresh, {}, evaluateClickTarget)
    ) return { ok: false, code: 'CLICK_DENIED' };

    let owned = false;
    try {
      owned = input.withOwnership(activation.element, () => {
        // 全仓唯一一处不取消默认动作的宿主点击。理由见本函数头部。
        activation.element.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
        );
      }) === true;
    } catch {
      return { ok: false, code: 'ABORTED' };
    }
    // 所有权窗口没兜住（观测不到自己的 click、期间有人试图提交、或窗口里混进了
    // 别的组事件）。报 `ABORTED` 而不是新造码：`APPLY_ERROR_CODES` 是已上线的
    // 稳定码集，而「一次 safety failure 中止了这一栏」正是它的定义。
    if (!owned) return { ok: false, code: 'ABORTED' };

    let settled = false;
    try {
      settled = input.afterEach(index) === true;
    } catch {
      return { ok: false, code: 'WRITE_REVERTED' };
    }
    if (!settled) return { ok: false, code: 'WRITE_REVERTED' };
  }
  return { ok: true, value: undefined };
}

/** One reviewed option of an ARIA-proxied question that this activation must press. */
export interface ProxiedChoiceActivation {
  /** The user-facing proxy: `button[aria-pressed]` or `[role=radio|checkbox][aria-checked]`. */
  readonly element: HTMLElement;
  /** The native radio/checkbox this proxy wraps and the host listens on, or null (pure ARIA widget). */
  readonly carrier: HTMLInputElement | null;
}

export interface ActivateProxiedChoiceOptionsInput {
  /** Exactly the options the reviewed answer presses, in DOM order. */
  readonly activations: readonly ProxiedChoiceActivation[];
  readonly root: ScanRoot;
  readonly authority: FillOnlyHostWriteAuthority;
  /** Re-read before the authority is consumed and before every single activation. */
  readonly capabilityCurrent: () => boolean;
  /** Re-proves group identity and that this option is still unpressed, right before its dispatch. */
  readonly beforeEach: (index: number) => boolean;
  /**
   * Runs one synchronous dispatch inside the caller's submission veto: a `submit` / `reset` observed
   * while it is open is cancelled on the spot and fails the attempt. Returns false in that case.
   */
  readonly withSubmitVeto: (activate: () => void) => boolean;
  /**
   * 代填的那一题（2026-09-24，只有六类同意）：类别与题干元素一起带进每一下的点击事实，点击策略在
   * 点下去之前把此刻的题干与选项各认一遍（click/policy.ts 的 `proxySigningTexts`）。两者同进同出。
   */
  readonly signing?: Readonly<{ kind: SignOnBehalfChoiceKind; question: Element }>;
}

/**
 * Press the reviewed options of one ARIA-proxied question (2026-09-23; see `dict/ariaChoice.ts`).
 *
 * Facts are collected on the **proxy** — the element the user sees, reads and clicks — and the whole
 * static deny table runs on them before anything is dispatched, for every option, and again right
 * before each dispatch (`proxy-option` also demands the state attribute, the absence of a form owner
 * that a click could submit or reset, and a DOM-derived carrier that matches the caller's).
 *
 * Two dispatch shapes, chosen by the carrier fact rather than by the caller:
 *  · **no carrier** (Ashby's `button[aria-pressed]`): the shared pointer sequence on the proxy, with
 *    the click's default action pre-cancelled like every other widget click in this file. Measured
 *    live 2026-09-23: Ashby's handler takes that click and publishes `aria-pressed` a microtask later.
 *  · **a carrier** (Workable's hidden radio inside `div[role=radio]`): one native activation click on
 *    the carrier, default action not cancelled — the same thing the browser does when a user clicks
 *    the proxy's `<label>`, and the only thing the host listens to (a click on the proxy itself, even
 *    uncancelled, changes nothing — measured live the same day). A radio/checkbox's default action
 *    only toggles its own checkedness; the caller's submit veto covers a host listener that submits.
 *
 * Nothing here reads the published state after a dispatch: hosts publish it asynchronously, so the
 * caller verifies it after settling, never from a synchronous read that would call a success a failure.
 * Every option is proven before the first dispatch, so a denied second option leaves nothing half-pressed.
 */
export function activateProxiedChoiceOptions(
  input: ActivateProxiedChoiceOptionsInput,
): Result<void, ClickHostTargetError> {
  const { activations, root, authority } = input;
  const capable = (): boolean => {
    try {
      return input.capabilityCurrent() === true;
    } catch {
      return false;
    }
  };
  if (!isTrustedScanRoot(root)) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (activations.length === 0) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (!capable()) return { ok: false, code: 'CAPABILITY_DISABLED' };
  if (activations.length > MAX_HOST_CLICKS_PER_AUTHORITY) return { ok: false, code: 'ABORTED' };
  if (new Set(activations.map((activation) => activation.element)).size !== activations.length) {
    return { ok: false, code: 'CLICK_DENIED' };
  }

  const signing = input.signing;
  const contextFor = (activation: ProxiedChoiceActivation): ClickFactsContext => ({
    intendedCarrier: activation.carrier,
    ...(signing === undefined ? {} : { signingQuestion: signing.question }),
  });
  const factsFor = (activation: ProxiedChoiceActivation): ClickTargetFacts | null => {
    try {
      return collectClickFacts({
        element: activation.element,
        root,
        kind: 'proxy-option',
        planned: true,
        intendedCarrier: activation.carrier,
        ...(signing === undefined ? {} : { signOnBehalf: signing.kind, signingQuestion: signing.question }),
      });
    } catch {
      return null;
    }
  };
  const baselines: ClickTargetFacts[] = [];
  for (const activation of activations) {
    if (!activation.element.isConnected || activation.carrier?.isConnected === false) {
      return { ok: false, code: 'DETACHED' };
    }
    const facts = factsFor(activation);
    if (facts === null || !evaluateClickTarget(facts).allowed) return { ok: false, code: 'CLICK_DENIED' };
    if (!pointerTargetStillAllowed(activation.element, root, facts, contextFor(activation), evaluateClickTarget)) {
      return { ok: false, code: 'CLICK_DENIED' };
    }
    baselines.push(facts);
  }

  if (!capable() || !consumeFillOnlyHostWriteAuthority(authority)) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }

  for (const [index, activation] of activations.entries()) {
    if (!capable()) return { ok: false, code: 'CAPABILITY_DISABLED' };
    let proceed = false;
    try {
      proceed = input.beforeEach(index) === true;
    } catch {
      return { ok: false, code: 'ABORTED' };
    }
    if (!proceed) return { ok: false, code: 'ABORTED' };
    const fresh = factsFor(activation);
    if (
      fresh === null ||
      !sameFacts(baselines[index]!, fresh) ||
      !evaluateClickTarget(fresh).allowed ||
      !pointerTargetStillAllowed(activation.element, root, fresh, contextFor(activation), evaluateClickTarget)
    ) return { ok: false, code: 'CLICK_DENIED' };

    const outcome: { result: Result<void, ApplyErrorCode> | null } = { result: null };
    let unvetoed = false;
    try {
      unvetoed = input.withSubmitVeto(() => {
        const carrier = activation.carrier;
        if (carrier !== null) {
          // 承载的原生激活：默认动作就是这次作答，不取消（理由见本函数头注与 activateReviewedChoiceGroup）。
          carrier.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          outcome.result = { ok: true, value: undefined };
          return;
        }
        outcome.result = dispatchPointerSequence(activation.element, root, fresh, undefined, contextFor(activation), evaluateClickTarget);
      }) === true;
    } catch {
      return { ok: false, code: 'ABORTED' };
    }
    // 这一下期间有人试图提交或重置：拦下了，但这次写入就此作废（与原生激活同一个码）。
    if (!unvetoed) return { ok: false, code: 'ABORTED' };
    if (outcome.result === null) return { ok: false, code: 'ABORTED' };
    if (!outcome.result.ok) return outcome.result;
  }
  return { ok: true, value: undefined };
}

/**
 * Synchronous compensation/Undo activation for one exact semantic option.
 *
 * Forward-write policy or the original authority may already be revoked when
 * compensation runs, so this path cannot depend on either. It remains inside
 * the same click boundary: complete facts are collected twice under a DOM
 * mutation fence, every observed scan root is re-proven, the static deny list
 * is re-run, and the shared pointer dispatcher pre-cancels native click
 * defaults. Callers still have to prove rule-owned membership and semantic
 * readback before and after invoking it.
 */
function validateHostRestorationTarget(input: Readonly<{
  element: Element;
  root: ScanRoot;
  pointerSequenceFence?: ClickHostTargetInput['pointerSequenceFence'];
}>, dispatch: boolean): boolean {
  const { element, root } = input;
  if (!element.isConnected) return false;
  const initialTargets = captureScanRootObservationTargets(root);
  const Observer = element.ownerDocument.defaultView?.MutationObserver;
  if (!initialTargets || !Observer) return false;

  const observer = new Observer(() => undefined);
  const observed = new Set<Node>();
  try {
    for (const target of [...initialTargets, element.getRootNode()]) {
      if (observed.has(target)) continue;
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      observed.add(target);
    }

    const collect = () => collectClickFacts({
      element,
      root,
      kind: 'transaction-option',
      planned: true,
      openedByTransaction: true,
    });
    const firstFacts = collect();
    const finalFacts = collect();
    const finalTargets = captureScanRootObservationTargets(root);
    if (
      !finalTargets ||
      !sameNodeSet(initialTargets, finalTargets) ||
      !sameFacts(firstFacts, finalFacts) ||
      observer.takeRecords().length > 0 ||
      !element.isConnected ||
      !evaluateUnsignedClickTarget(finalFacts).allowed
    ) return false;

    if (!dispatch) return true;
    return dispatchPointerSequence(
      element,
      root,
      finalFacts,
      input.pointerSequenceFence,
      {},
      evaluateUnsignedClickTarget,
    ).ok;
  } catch {
    return false;
  } finally {
    observer.disconnect();
  }
}

/** Non-mutating counterpart used before any forward combobox dispatch. */
export function canClickHostRestorationTarget(input: Readonly<{
  element: Element;
  root: ScanRoot;
  pointerSequenceFence?: ClickHostTargetInput['pointerSequenceFence'];
}>): boolean {
  return validateHostRestorationTarget(input, false);
}

export function clickHostRestorationTarget(input: Readonly<{
  element: Element;
  root: ScanRoot;
  pointerSequenceFence?: ClickHostTargetInput['pointerSequenceFence'];
}>): boolean {
  return validateHostRestorationTarget(input, true);
}

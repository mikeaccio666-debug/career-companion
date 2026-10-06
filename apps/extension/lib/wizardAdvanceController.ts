import type { ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { isAdvanceRunStepCurrent, isTrustedShadowGesture, type AdvanceRunStep } from '@edaix/apply-kernel/grant';
import { isApplyPolicyEnabled, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { findWizardNextControl, scannedStepGone, type ScannedStep } from '@edaix/apply-kernel/wizardAdvance';

import type { DockAdvanceOutcome } from './autofillDock';

/**
 * 内容脚本这一侧的「继续到下一页」（2026-09-22）。
 *
 * 一轮手势填写跑完之后 `arm`：记住这一页扫出来的字段与那一刻的写策略。之后三件事都在这里：
 *
 *  · 浮层问「此刻能按哪一颗」——内核 `findWizardNextControl` 找全页唯一的那颗，拿它的字；
 *  · 用户按了「继续到下一页」——**当场**验这是我们浮层里的真点击，再重新读一次远程开关
 *    （不用 arm 那一刻的快照：用户可能几分钟后才按，开关可能已经关了），再找一次那颗按钮，
 *    按下去，等宿主翻页；
 *  · 用户没用我们的按钮、自己在网站上按了下一步——盯着 DOM，这一步整个不在了就告诉浮层，
 *    让它收掉上一页的审计、回到可以点 Autofill 的样子。
 *
 * 这里没有任何一家厂商的选择器（RULE-GLOBAL-DOM-RULE-BOUNDARY）：认按钮、判换页都是内核的
 * 通用判据。按的只是那一颗翻页按钮，从来不是最终提交（RULE-EXT-NEVER-SUBMIT）——名字闭集里
 * 没有 submit，结构上提交得了表单的也不是候选。
 */

export interface ArmedPage {
  /** 这一页的扫描结果（含活元素，绝不出内容脚本）。 */
  readonly descriptor: ApplyFormDescriptor;
  /** 这一轮用的写策略。只用来决定**要不要摆出**按钮；真按之前会重新读一次。 */
  readonly policy: ApplyPolicy;
  /** 用户自己在网站上翻到了下一步。只调用一次。 */
  readonly onLeft: () => void;
}

export interface WizardAdvanceController {
  /** 一轮手势填写跑完：记住这一页，开始盯着它还在不在。 */
  arm(page: ArmedPage): void;
  /** 这一页不再归我们管了（新一轮开始、浮层换脸）。 */
  disarm(): void;
  /** 此刻能替用户按的那一颗上写着什么；没有、不唯一、或开关没开就是 null。 */
  label(): string | null;
  /** 用户按了「继续到下一页」。必须在点击的派发过程中同步调用。 */
  advance(event: MouseEvent, shadowRoot: ShadowRoot): Promise<DockAdvanceOutcome>;
  /**
   * 连填（2026-09-28）里的一次翻页：没有点击，凭的是那一下点击开出的一轮连填的这一步（内核 `beginAdvanceRunStep`
   * 发的）。按之前重读开关（翻页与连填两位都要开着）、再问一次这一步还算不算数（用户可能刚按了「停止」）、再找一次
   * 那一颗；这一页上有规则声明的最终提交就从不替他往下翻。
   */
  advanceInRun(step: AdvanceRunStep): Promise<DockAdvanceOutcome>;
  /** 此刻页面上那颗翻页按钮的情况；没 arm 就是 UNARMED。连填据此判断是不是最后一页。 */
  nextState(): NextControlState | 'UNARMED';
}

/**
 * 页面上那颗翻页按钮的情况：唯一一颗（ONE）、没有（NONE，最后一步是 Submit 时就是这样）、说不清（AMBIGUOUS：不止一颗，
 * 或读页面时出了错——两种都不能说「这是最后一页」）。
 */
export type NextControlState = 'ONE' | 'NONE' | 'AMBIGUOUS';

export interface WizardAdvanceControllerInput {
  readonly document: Document;
  /** 按钮看不看得见。生产传 `isRenderedControl`；kernel 不碰布局，所以由这一层量。 */
  readonly isVisible: (element: Element) => boolean;
  /**
   * 按之前重新读一次写策略（与手势填写同一条路：worker 给 DISCOVERY 授权、本机解出运行时）。
   * 读不到就是 null——不按（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。
   */
  readonly resolvePolicy: () => Promise<ApplyPolicy | null>;
  readonly now?: () => number;
  /** 按下去之后多久问一次「翻过去了没有」。 */
  readonly pollMs?: number;
  /** 最多等多久。Workday 的 Save and Continue 要先存一次，实测一到三秒。 */
  readonly settleMs?: number;
  /** DOM 变了之后等多久再判「这一步还在不在」：宿主换页是一串变更，不必每一条都判。 */
  readonly debounceMs?: number;
}

const DEFAULT_POLL_MS = 200;
const DEFAULT_SETTLE_MS = 10_000;
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * 能不能替用户按翻页按钮：远程策略整体开着、这一家开着、翻页这一位开着、没过期。
 * 三位缺一位都不按。
 */
export function advanceAllowed(policy: ApplyPolicy | null, vendor: ApplyFormDescriptor['vendor'], now = Date.now()): boolean {
  return policy !== null && policy.capabilities['advance-step'] === true && isApplyPolicyEnabled(policy, vendor, now);
}

/**
 * 能不能连着往下填（2026-09-28）：翻页那几条之外，连填这一位也开着。缺席读作关——回到每一页一颗「继续到下一页」。
 *
 * 不绑厂商的那条路（`generic`，公司自己做的表）不连填：连填是不等他看一眼就替他按下一步，只在规则量过的厂商表上做；
 * 公司自己做的表照旧每一页一颗「继续到下一页」，由他按。
 */
export function chainAllowed(policy: ApplyPolicy | null, vendor: ApplyFormDescriptor['vendor'], now = Date.now()): boolean {
  return vendor !== 'generic' && advanceAllowed(policy, vendor, now) && policy?.capabilities['advance-steps'] === true;
}

/** 这一页上有没有规则声明的最终提交（解释器在这一页认出来了、身份仍对、还连在页面上）。 */
export function finalSubmitOnPage(descriptor: ApplyFormDescriptor): boolean {
  const control = descriptor.finalSubmitControl;
  if (control === null || control === undefined) return false;
  try {
    return control.isCurrent() && control.element.isConnected;
  } catch {
    // 身份核不了：按「在」算——连填因此不往下翻，停下来交给用户，是保守的那一边。
    return true;
  }
}

/** 找一次这一页的翻页按钮（与控制器按之前找的是同一颗：同样避开规则声明的最终提交）。 */
function findNext(document: Document, descriptor: ApplyFormDescriptor, isVisible: (element: Element) => boolean) {
  return findWizardNextControl({
    document,
    formElements: descriptor.fields.map((field) => field.element),
    isVisible,
    // 规则声明过的最终提交控件：它此刻写什么都不按。
    refuse: descriptor.finalSubmitControl ? [descriptor.finalSubmitControl.element] : [],
  });
}

/** 这一页上那颗翻页按钮的情况（不 arm、不按，只看）。 */
export function nextControlState(input: Readonly<{
  document: Document;
  descriptor: ApplyFormDescriptor;
  isVisible: (element: Element) => boolean;
}>): NextControlState {
  const found = findNext(input.document, input.descriptor, input.isVisible);
  if (found.ok) return 'ONE';
  return found.code === 'NEXT_STEP_NONE' ? 'NONE' : 'AMBIGUOUS';
}

/** 生产用的可见性：有盒子、没被样式藏起来。 */
export function isRenderedControl(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null || element.getClientRects().length === 0) return false;
  const style = view.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number.parseFloat(style.opacity || '1') === 0) return false;
  const rect = element.getBoundingClientRect();
  return Number.isFinite(rect.width) && rect.width > 0 && Number.isFinite(rect.height) && rect.height > 0;
}

export function createWizardAdvanceController(input: WizardAdvanceControllerInput): WizardAdvanceController {
  const now = input.now ?? (() => Date.now());
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const view = input.document.defaultView;
  let armed: ArmedPage | null = null;
  let advancing = false;
  let stopWatching: () => void = () => {};

  const stepOf = (page: ArmedPage): ScannedStep => ({
    root: page.descriptor.root,
    fields: page.descriptor.fields.map((field) => ({ element: field.element, label: field.label })),
  });

  const find = (page: ArmedPage) => findNext(input.document, page.descriptor, input.isVisible);

  const wait = (ms: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, ms); });

  /** 盯着这一页：DOM 一变就（防抖后）问一次「这一步还在不在」。 */
  const watch = (page: ArmedPage): void => {
    stopWatching();
    if (view === null) return;
    const Observer = view.MutationObserver;
    let pending: number | null = null;
    const check = (): void => {
      pending = null;
      if (armed !== page || advancing) return;
      if (!scannedStepGone(stepOf(page))) return;
      disarm();
      page.onLeft();
    };
    const observer = new Observer(() => {
      if (pending === null) pending = view.setTimeout(check, debounceMs);
    });
    observer.observe(input.document.documentElement, { childList: true, subtree: true });
    stopWatching = () => {
      observer.disconnect();
      if (pending !== null) view.clearTimeout(pending);
      pending = null;
    };
  };

  const disarm = (): void => {
    stopWatching();
    stopWatching = () => {};
    armed = null;
  };

  return Object.freeze({
    arm(page: ArmedPage): void {
      disarm();
      armed = page;
      watch(page);
    },

    disarm,

    label(): string | null {
      const page = armed;
      if (page === null || advancing || !advanceAllowed(page.policy, page.descriptor.vendor, now())) return null;
      const found = find(page);
      return found.ok ? found.value.label : null;
    },

    advance(event: MouseEvent, shadowRoot: ShadowRoot): Promise<DockAdvanceOutcome> {
      // 当场判：`composedPath()` 派发一结束就空了，await 之后再问必然判否。
      if (!isTrustedShadowGesture(event, shadowRoot)) return Promise.resolve('UNTRUSTED');
      const page = armed;
      if (page === null || advancing) return Promise.resolve('UNAVAILABLE');
      return press(page, (policy) => advanceAllowed(policy, page.descriptor.vendor, now()));
    },

    advanceInRun(step: AdvanceRunStep): Promise<DockAdvanceOutcome> {
      // 连填里没有点击：这一步（内核发的，只能从一次真实点击开出的那一轮来）就是按的凭据。
      if (!isAdvanceRunStepCurrent(step, now())) return Promise.resolve('UNAVAILABLE');
      const page = armed;
      if (page === null || advancing) return Promise.resolve('UNAVAILABLE');
      return press(page, (policy) =>
        chainAllowed(policy, page.descriptor.vendor, now()) &&
        // 读开关的那一会儿用户可能按了「停止」：读回来再问一次这一步。
        isAdvanceRunStepCurrent(step, now()) &&
        // 规则声明的最终提交在这一页上：这是最后一页，从不替他往下翻。
        !finalSubmitOnPage(page.descriptor));
    },

    nextState(): NextControlState | 'UNARMED' {
      const page = armed;
      if (page === null) return 'UNARMED';
      return nextControlState({ document: input.document, descriptor: page.descriptor, isVisible: input.isVisible });
    },
  });

  /**
   * 按下这一页的翻页按钮并等宿主翻页。两条路（用户的真实点击、连填的这一步）都走这里：`allowed` 在重读开关之后判，
   * 判完再找一次那一颗才按。
   */
  function press(page: ArmedPage, allowed: (policy: ApplyPolicy | null) => boolean): Promise<DockAdvanceOutcome> {
    advancing = true;
    stopWatching();
    return (async (): Promise<DockAdvanceOutcome> => {
      try {
        const policy = await input.resolvePolicy();
        if (armed !== page || !allowed(policy)) return 'UNAVAILABLE';
        // 再找一次：浮层画出按钮到用户按下，中间隔了多久不知道，宿主的底栏可能已经变了。
        const found = find(page);
        if (!found.ok) return 'UNAVAILABLE';
        (found.value.element as HTMLElement).click();
        const deadline = now() + settleMs;
        while (now() < deadline) {
          await wait(pollMs);
          if (armed !== page) return 'UNAVAILABLE';
          if (scannedStepGone(stepOf(page))) {
            disarm();
            return 'ADVANCED';
          }
        }
        return 'NOT_ADVANCED';
      } catch {
        return 'UNAVAILABLE';
      } finally {
        advancing = false;
        // 没翻过去就接着盯：用户照着红色提示改完，可能直接在网站上按下一步。
        if (armed === page) watch(page);
      }
    })();
  }
}

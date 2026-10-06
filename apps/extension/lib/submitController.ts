import type { ApplyFormDescriptor, FinalSubmitControlDescriptor } from '@edaix/apply-kernel/contracts';
import { isTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { isApplyPolicyEnabled, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { scannedStepGone, type ScannedStep } from '@edaix/apply-kernel/wizardAdvance';

import type { DockSubmitOutcome } from './autofillDock';

/**
 * 在插件里提交（2026-09-23 负责人决定：「插件替用户点提交」）。
 *
 * 用户在我方浮层里按「提交」，就是他本人确认提交；插件随后替他按网站上的最终提交。按什么、
 * 什么时候按、按完怎么判，都在这里，四道闸缺一不可：
 *
 *  1. **那一下是用户在我们浮层里的真点击**——派发当下同步验（`composedPath()` 一结束就空了）；
 *  2. **远程开关开着**——按之前重新读一次写策略的 `submit-application` 位与这一家的总开关，
 *     读不到当关（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）；
 *  3. **只按规则声明的那一颗**——`finalSubmitControl`：规则解释器给的活节点，只认同一张表里唯一
 *     的 native submit；按之前 `isCurrent()` 再核一遍身份与唯一性，看不见、按不了都不按。没有声明
 *     的厂商（规则里是 null）永远不按，浮层只提示去网站上点。扫描那一刻网站把它禁用着（必填没填好，
 *     2026-10-04 Rippling：aria-disabled，填好才放开）时，扫描交来的是 null——那就按同一套判据再认一次
 *     （描述符的 `resolveFinalSubmitControl`），认出来的同样要过上面每一道闸；
 *  4. **信封合上的那一刻才按**——调用方交来 `pressAt`，动画把卡片装进信封、合上翻盖时才兑现。
 *
 * 按的方式是点那颗按钮（`element.click()`），走宿主自己的提交处理；随包字节里没有 `.submit(` /
 * `.requestSubmit(`（RULE-EXT-NEVER-SUBMIT 的字节闸照旧）。验证码、人机验证仍由用户本人完成：
 * 网站弹出来，我们就等不到确认，照实说。
 *
 * 按完怎么判：这张表整个不在了、或页面上出现了确认的话（通用措辞，不认任何一家的 DOM），算提交
 * 成功；表还在、而且出现了标红的栏，算网站没收；等满了还说不清，照实说还没看到确认。页面整页
 * 跳走时这里等不到结论——那一刻之前先告诉 worker「这个标签页刚按了提交」，下一页的浮层把「提交成功」
 * 播完。
 *
 * 网站要邮件里的验证码（2026-10-04，Greenhouse 的 Security code）：按了之后规则声明的验证码提示冒了出来、或网站说他填的
 * 验证码不对，就是 `CODE_REQUIRED`——不再干等「提交成功」，浮层换成验证码那张卡。提示在、验证码还没填满时根本不按（网站
 * 自己也不会收）。验证码由他本人在卡上输，填进去之后照旧由他再按一次「提交」。
 */

export interface SubmitArmedPage {
  readonly descriptor: ApplyFormDescriptor;
  /** 这一轮用的写策略。只用来决定要不要摆出「提交」；真按之前会重新读一次。 */
  readonly policy: ApplyPolicy;
}

export interface SubmitController {
  arm(page: SubmitArmedPage): void;
  disarm(): void;
  /** 此刻有没有一颗能替用户按的最终提交（开关开着、规则声明了、身份仍对、看得见、按得了）。 */
  available(): boolean;
  /** 用户按了浮层里的「提交」。必须在点击的派发过程中同步调用。 */
  send(event: MouseEvent, shadowRoot: ShadowRoot, pressAt: Promise<void>): Promise<DockSubmitOutcome>;
}

/** 网站此刻在要邮件里的验证码（规则声明的提示看得见）：那几格填满没有、网站那一句错话是哪一个节点、什么字。 */
export interface SubmitCodeMark {
  readonly filled: boolean;
  readonly error: Readonly<{ node: Element; text: string }> | null;
}

export interface SubmitControllerInput {
  readonly document: Document;
  readonly isVisible: (element: Element) => boolean;
  /** 按之前重新读一次写策略；读不到就是 null——不按。 */
  readonly resolvePolicy: () => Promise<ApplyPolicy | null>;
  /** 就要按了：让 worker 记住这个标签页（整页跳转时，下一页的浮层据此播完「提交成功」）。 */
  readonly onPressing?: () => void;
  /** 按过之后这一页自己等到了结论（不论是哪一种）：让 worker 忘掉这个标签页，免得切回来时再播一遍。 */
  readonly onSettled?: () => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** 最多等多久网站给结论。 */
  readonly settleMs?: number;
  /** 表还在、出现标红的栏之后，再等多久就判「网站没收」（有的网站先标红、随后才换页）。 */
  readonly rejectAfterMs?: number;
  /** 网站此刻在不在要邮件里的验证码（2026-10-04）；没接就是从不问。读不了就当没有。 */
  readonly codePrompt?: () => SubmitCodeMark | null;
}

const DEFAULT_POLL_MS = 200;
const DEFAULT_SETTLE_MS = 15_000;
const DEFAULT_REJECT_AFTER_MS = 2_500;
/** 信封一直没合上（浮层被拆、页面离开）就不按了。 */
const PRESS_WINDOW_MS = 20_000;

/** 确认页上的通用说法（中英）。只读页面上看得见的字，不认任何一家的 DOM。 */
const CONFIRMATION = /thank(?:s| you)\s+for\s+(?:applying|your\s+(?:application|submission)|submitting)|application\s+(?:has\s+been\s+|was\s+)?(?:submitted|received|sent)|we(?:'|’)ve\s+received\s+your\s+application|we\s+have\s+received\s+your\s+application|successfully\s+(?:submitted|applied)|you(?:'|’)ve\s+applied|申请已(?:提交|收到|发送)|感谢(?:你|您)的申请|已收到(?:你|您)的申请/iu;

/** 能不能替用户按最终提交：远程策略整体开着、这一家开着、提交这一位开着、没过期。 */
export function submitAllowed(policy: ApplyPolicy | null, vendor: ApplyFormDescriptor['vendor'], now = Date.now()): boolean {
  return policy !== null && policy.capabilities['submit-application'] === true && isApplyPolicyEnabled(policy, vendor, now);
}

function pressable(control: FinalSubmitControlDescriptor | null | undefined, isVisible: (element: Element) => boolean): control is FinalSubmitControlDescriptor {
  if (control === null || control === undefined) return false;
  let current = false;
  try {
    current = control.isCurrent();
  } catch {
    current = false;
  }
  if (!current || !control.element.isConnected || !isVisible(control.element)) return false;
  if (control.element.disabled || control.element.getAttribute('aria-disabled') === 'true') return false;
  return control.element.closest('fieldset[disabled], [inert]') === null;
}

/** 页面上看得见的字里有没有确认的话。只取正文前一段，免得一页长文拖慢轮询。 */
export function pageSaysSubmitted(doc: Document): boolean {
  const text = (doc.body?.innerText ?? doc.body?.textContent ?? '').slice(0, 20_000);
  return CONFIRMATION.test(text);
}

/** 这张表里有没有标红的栏（宿主自己的校验说「这一栏不行」）。 */
function formFlagsErrors(form: HTMLFormElement): boolean {
  return form.querySelector('[aria-invalid="true"], [role="alert"]:not(:empty)') !== null;
}

export function createSubmitController(input: SubmitControllerInput): SubmitController {
  const now = input.now ?? (() => Date.now());
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;
  const rejectAfterMs = input.rejectAfterMs ?? DEFAULT_REJECT_AFTER_MS;
  let armed: SubmitArmedPage | null = null;
  /** 扫描时禁用着、之后再认出来的那一颗（只属于 arm 进来的这一页；换页、disarm 就作废）。 */
  let late: FinalSubmitControlDescriptor | null = null;
  let sending = false;
  const wait = (ms: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, ms); });
  const readCode = (): SubmitCodeMark | null => {
    try {
      return input.codePrompt?.() ?? null;
    } catch {
      return null;
    }
  };
  /** 网站这一次是不是新说了一句（换了节点或换了字）：说明它看过这一次交上去的验证码了。 */
  const freshError = (now: SubmitCodeMark, before: SubmitCodeMark | null): boolean =>
    now.error !== null && (before?.error === null || before?.error === undefined || now.error.node !== before.error.node || now.error.text !== before.error.text);
  const stepOf = (page: SubmitArmedPage): ScannedStep => ({
    root: page.descriptor.root,
    fields: page.descriptor.fields.map((field) => ({ element: field.element, label: field.label })),
  });

  /**
   * 这一页规则声明的那一颗：扫描时认出来的那一颗；扫描时没认出来（网站禁用着），就按同一套判据再认一次。
   * 再认出来的那一颗留着用，它自己的 `isCurrent()` 管之后的变化；它不再算数了（被换掉、又被禁用）就再认一次。
   */
  const controlOf = (page: SubmitArmedPage): FinalSubmitControlDescriptor | null => {
    const scanned = page.descriptor.finalSubmitControl;
    if (scanned !== null && scanned !== undefined) return scanned;
    if (late !== null) {
      let current = false;
      try {
        current = late.isCurrent();
      } catch {
        current = false;
      }
      if (current) return late;
    }
    try {
      late = page.descriptor.resolveFinalSubmitControl?.() ?? null;
    } catch {
      late = null;
    }
    return late;
  };

  return Object.freeze({
    arm(page: SubmitArmedPage): void { armed = page; late = null; },
    disarm(): void { armed = null; late = null; },

    available(): boolean {
      const page = armed;
      if (page === null || sending || !submitAllowed(page.policy, page.descriptor.vendor, now())) return false;
      return pressable(controlOf(page), input.isVisible);
    },

    send(event: MouseEvent, shadowRoot: ShadowRoot, pressAt: Promise<void>): Promise<DockSubmitOutcome> {
      // 当场判：`composedPath()` 派发一结束就空了，await 之后再问必然判否。
      if (!isTrustedShadowGesture(event, shadowRoot)) return Promise.resolve('UNTRUSTED');
      const page = armed;
      if (page === null || sending) return Promise.resolve('UNAVAILABLE');
      sending = true;
      let pressed = false;
      return (async (): Promise<DockSubmitOutcome> => {
        try {
          const [policy, closed] = await Promise.all([
            input.resolvePolicy(),
            Promise.race([pressAt.then(() => true), wait(PRESS_WINDOW_MS).then(() => false)]),
          ]);
          if (!closed || armed !== page || !submitAllowed(policy, page.descriptor.vendor, now())) return 'UNAVAILABLE';
          // 再核一次：浮层画出按钮到信封合上，中间隔了几秒，宿主的底栏可能已经变了。
          const control = controlOf(page);
          if (!pressable(control, input.isVisible)) return 'UNAVAILABLE';
          // 网站正在要验证码、那几格还没填满：按了它也不收（Greenhouse 的提交处理直接返回）。不按，交给那张卡。
          const codeBefore = readCode();
          if (codeBefore !== null && !codeBefore.filled) return 'CODE_REQUIRED';
          try {
            input.onPressing?.();
          } catch {
            // 记不上只影响整页跳转后的那一段动画，不影响提交本身。
          }
          // 按之前先看一眼：职位描述里本来就可能有「thank you for applying」一类的话，那不算网站的回答。
          const saidBefore = pageSaysSubmitted(input.document);
          const saysNow = (): boolean => !saidBefore && pageSaysSubmitted(input.document);
          pressed = true;
          control.element.click();
          const deadline = now() + settleMs;
          let flaggedAt: number | null = null;
          while (now() < deadline) {
            await wait(pollMs);
            if (saysNow()) return 'SUBMITTED';
            // 网站要验证码了（这一下之前没有），或者说他填的验证码不对、过期了：换成那张卡，不再等。
            const code = readCode();
            if (code !== null && (codeBefore === null || freshError(code, codeBefore))) return 'CODE_REQUIRED';
            const gone = !control.form.isConnected || scannedStepGone(stepOf(page));
            if (gone) {
              // 表不在了：多给一会儿让确认的话出来；还没有就照实说没看到确认。
              await wait(Math.min(1_200, Math.max(0, deadline - now())));
              return pageSaysSubmitted(input.document) ? 'SUBMITTED' : 'UNCONFIRMED';
            }
            if (formFlagsErrors(control.form)) {
              flaggedAt ??= now();
              if (now() - flaggedAt >= rejectAfterMs) return 'NOT_SUBMITTED';
            } else flaggedAt = null;
          }
          // 等满了：标红过就是网站没收；没标红（比如弹出了人机验证等他本人完成）只说还没看到确认。
          return flaggedAt !== null ? 'NOT_SUBMITTED' : 'UNCONFIRMED';
        } catch {
          // 已经按了网站的提交（2026-10-03 体检 3a-3）：网站多半已经收到那一下，只是我们没等到结论。说「按不了、请在网站上
          // 自己点」会让他再投一份；只能照实说还没看到确认（浮层那一句请他先看一眼再决定要不要重新提交）。没按就是按不了。
          return pressed ? 'UNCONFIRMED' : 'UNAVAILABLE';
        } finally {
          sending = false;
          // 页面整页跳走时走不到这里（这一页的脚本已经没了）——那正是 worker 该留着记号的时候。
          if (pressed) {
            try {
              input.onSettled?.();
            } catch {
              // 清不掉只会让切回来时多播一次动画。
            }
          }
        }
      })();
    },
  });
}

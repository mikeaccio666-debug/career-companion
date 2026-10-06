/**
 * 从一个 DOM 元素采集代点击所需的**全部** deny 事实。
 *
 * ## 为什么必须有这么一个地方
 *
 * `ClickTargetFacts` 的 deny 相关字段全是 optional，而 `undefined` 是 falsy——
 * 一个没被填上的事实等于那条 deny 这次不跑，且完全静默。实测
 * `click/combobox.ts` 的 `triggerFacts` 就漏了十项，也就是说今天一个**隐藏的**
 * 下拉触发器是点得动的。
 *
 * `REQUIRED_FACTS_BY_KIND` 这道闸把「齐全」变成放行前置，本模块则让齐全
 * **由构造保证**：所有事实构造器都从这里出发，谁也不用记住那张清单。
 * 两者缺一不可——闸门是最后一道，构造器是第一道。
 *
 * ## 边界
 *
 * 本模块读 DOM，但只读**结构与可见性**，不读任何作答值（Data-L1）。
 * 几何测量（离屏判定）与 kernel 的确定性边界一致：不给测量手段就退回
 * 保守值，不自己去碰 `getBoundingClientRect`。
 */

import { CONSENT_GRANT } from '../dict/guards.ts';
import { ariaProxyCarrier, ariaProxyKind, ariaProxyStateAttribute, canSubmitOrResetAForm } from '../dict/ariaChoice.ts';
import type { ClickTargetFacts, ClickTargetKind } from './policy.ts';
import type { SignOnBehalfChoiceKind } from '../dict/signOnBehalf.ts';
import type { ScanRoot } from '../contracts.ts';

/** 只有这些 scheme 点下去会离开当前页面。 */
const NAVIGATING_HREF = /^(?!javascript:|#|$)/i;

/**
 * `<a>` 点下去会不会导航。
 *
 * `javascript:` 与纯锚点 `#` 不导航——iCIMS 的加行/删行按钮就是
 * `<a role="button" href="javascript:void(0)">`（50-证据库 §F.6-k / §F.6-o）。
 * 拿**属性原值**判而不是 `element.href` 属性：后者会把相对 URL 解析成绝对，
 * `href="#"` 变成整个当前 URL，判据就废了。
 */
function hrefNavigates(element: Element): boolean {
  const raw = element.getAttribute('href');
  if (raw === null) return false;
  return NAVIGATING_HREF.test(raw.trim());
}

function inClosest(element: Element, selector: string): boolean {
  try {
    return element.closest(selector) !== null;
  } catch {
    // 选择器写错不该让整次点击判决崩掉——保守当作"在里面"。
    return true;
  }
}

const CAPTCHA_CONTAINERS =
  '[class*="captcha" i],[id*="captcha" i],[data-sitekey],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i]';
const PASSWORD_CONTAINERS = '[class*="password" i],[id*="password" i]';

export interface CollectClickFactsInput {
  readonly element: Element;
  readonly root: ScanRoot;
  readonly kind: ClickTargetKind;
  /** 这次动作在用户已审阅的计划里。由调用方证明，本模块不猜。 */
  readonly planned: boolean;
  readonly openedByTransaction?: boolean;
  readonly declaredRowAction?: 'add' | 'save' | 'remove';
  readonly choiceControl?: 'radio' | 'checkbox';
  /** 代填的那一格（2026-09-23）：由计划证明，原样带进事实；点击策略自己再判一次文字。 */
  readonly signOnBehalf?: SignOnBehalfChoiceKind;
  /**
   * 离屏判定的测量手段。**不给就按"没离屏"处理**——kernel 不碰浏览器 API
   * （RULE-KERNEL-DETERMINISTIC-BOUNDARY），而无布局环境下每个元素都是 0×0，
   * 自己去测会把整表判成离屏、一个都点不了。
   */
  readonly isLikelyOffscreen?: boolean;
  readonly isLikelyHoneyPot?: boolean;
  /**
   * The combobox trigger whose ARIA popup this option is expected to sit in.
   * Given only by the listbox writer for a `transaction-option`; the fact
   * `withinOwnedPopup` is then **derived from the DOM here**, never asserted by
   * the caller: the owner must itself be inside the form root and the target
   * must be inside the `[role=listbox]` its `aria-controls`/`aria-owns` names.
   */
  readonly popupOwner?: Element;
  /**
   * The vendor rule's typeahead suggestion shape: the widget container and the
   * suggestion selector under it. Given only by the typeahead writer for a
   * `transaction-option`; `ruleDeclaredOption` is then **derived here** from
   * containment and `matches`, never asserted by the caller.
   */
  readonly declaredSuggestion?: DeclaredSuggestion;
  /**
   * The vendor rule's **portaled popup** shape, given only by the hierarchical
   * prompt writer for a `transaction-option`. Both `withinRuleDeclaredPopup`
   * and `ruleDeclaredOption` are derived from it **here**, from the live DOM,
   * never asserted by the caller. At most one of `declaredSuggestion` and
   * `declaredPopup` may be given; both at once is a caller bug and both facts
   * then come back `false` (fail closed).
   */
  readonly declaredPopup?: DeclaredPopup;
  /**
   * `proxy-option` 专用：调用方打算把那一下原生激活落在哪个承载上（null = 点代理本身）。
   * 它只是一个**说法**：`proxyCarrier` 这项事实从 DOM 推出，说法对不上就是 `'invalid'`。
   */
  readonly intendedCarrier?: HTMLInputElement | null;
  /**
   * 代填的代理题（2026-09-24）：题干所在的那个元素（扫描时记下的 `ProxyChoiceGroupShape.question`）。
   * 事实 `signingQuestion` 是它**此刻**的文字，从 DOM 读；元素不在表单根里、或已脱离文档，就是空串。
   */
  readonly signingQuestion?: Element | null;
  /** 账号墙（2026-09-28）：规则声明的这一颗是哪一个角色。由调用方从解释器交出的账号墙这一步带进来，原样进事实。 */
  readonly declaredAccountControl?: ClickTargetFacts['declaredAccountControl'];
}

/** 代填的代理题此刻的题干文字（空白折叠）；元素不在表单根里就是空串——空串认不出任何一类。 */
function signingQuestionText(element: Element | null, root: ScanRoot): string {
  if (element === null || !element.isConnected || root.isExcluded(element)) return '';
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** `proxy-option` 的三项形状事实，全部从当下的 DOM 读，不接受调用方断言。 */
function proxyOptionFacts(
  element: Element,
  intendedCarrier: HTMLInputElement | null,
): Pick<ClickTargetFacts, 'proxyState' | 'formSubmitCapable' | 'proxyCarrier'> {
  const kind = ariaProxyKind(element);
  const actual = kind === null ? 'AMBIGUOUS' : ariaProxyCarrier(element, kind);
  const proxyCarrier = actual === 'AMBIGUOUS' || actual !== intendedCarrier
    ? 'invalid' as const
    : actual === null
      ? 'none' as const
      : actual.type === 'radio' ? 'radio' as const : actual.type === 'checkbox' ? 'checkbox' as const : 'invalid' as const;
  return {
    proxyState: kind === null ? null : ariaProxyStateAttribute(kind),
    formSubmitCapable: canSubmitOrResetAForm(element),
    proxyCarrier,
  };
}

export interface DeclaredSuggestion {
  readonly container: Element;
  readonly selector: string;
}

/**
 * A rule-declared popup that the widget portals out of the form root.
 *
 * Workday's "How Did You Hear About Us?" prompt (nvidia.wd5, 2026-09-15) is the
 * reference case: the menu renders as `div[data-automation-id="activeListContainer"]
 * [role="listbox"]` directly under `<body>`, it has **no `id`**, and the trigger
 * never gains `aria-controls`/`aria-owns` — so `withinOwnedPopup` can prove
 * nothing and the option click dies on `OUTSIDE_FORM` before any event is sent.
 *
 * The three parts are each load-bearing:
 *   · `trigger` must itself be inside the form root — the widget we are driving
 *     is the user's, not something a portaled node claims about itself;
 *   · `rootSelector` must resolve to **exactly one** element in the trigger's
 *     document — a selector that matches two nodes proves nothing about which
 *     popup we opened, so it proves nothing at all;
 *   · `optionSelector` must match the candidate under that root — the rows in
 *     this widget are role-less `div`s, so option shape can only come from rule
 *     data (exactly as it does for a typeahead suggestion).
 *
 * The caller must separately prove `openedByTransaction`: policy never lets a
 * popup we did not open be clicked in.
 */
export interface DeclaredPopup {
  readonly trigger: Element;
  readonly rootSelector: string;
  readonly optionSelector: string;
}

/** The DOM-derived inputs a re-collection must repeat to compare like with like. */
export type ClickFactsContext = Pick<
  CollectClickFactsInput,
  'popupOwner' | 'declaredSuggestion' | 'declaredPopup' | 'intendedCarrier' | 'signingQuestion'
>;

function matchesSelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function matchesDeclaredSuggestion(element: Element, declared: DeclaredSuggestion): boolean {
  try {
    return declared.container.contains(element) && element !== declared.container && element.matches(declared.selector);
  } catch {
    return false;
  }
}

/**
 * The one element the rule's popup-root selector currently names, when it names
 * exactly one and that one strictly contains the candidate. Anything else —
 * a trigger outside the form root, a selector matching zero or several nodes,
 * a candidate outside the root or the root itself — is `null`, i.e. not proven.
 */
function ruleDeclaredPopupOf(
  element: Element,
  root: ScanRoot,
  declared: DeclaredPopup,
): Element | null {
  try {
    if (root.isExcluded(declared.trigger)) return null;
    const matches = declared.trigger.ownerDocument.querySelectorAll(declared.rootSelector);
    if (matches.length !== 1) return null;
    const popup = matches[0]!;
    return popup !== element && popup.contains(element) ? popup : null;
  } catch {
    return null;
  }
}

/** The `[role=listbox]` a combobox trigger currently names, if any. */
function ownedPopupOf(owner: Element): Element | null {
  const id = owner.getAttribute('aria-controls') ?? owner.getAttribute('aria-owns');
  if (!id) return null;
  const popup = owner.ownerDocument.getElementById(id);
  return popup !== null && popup.getAttribute('role') === 'listbox' ? popup : null;
}

/** 采集齐全的事实。返回值必然通过 `REQUIRED_FACTS_BY_KIND` 那道闸。 */
export function collectClickFacts(input: CollectClickFactsInput): ClickTargetFacts {
  const { element, root, kind } = input;
  const html = element as Partial<HTMLElement> & Element;
  const accessibleName = root.labelTextFor(element);
  // Two rule-declared option shapes exist; a caller gives at most one. Both at
  // once cannot be resolved into one honest answer, so neither is proven.
  const conflicting = input.declaredSuggestion !== undefined && input.declaredPopup !== undefined;
  const declaredPopup = conflicting ? null : input.declaredPopup ?? null;
  const popup = declaredPopup === null
    ? null
    : ruleDeclaredPopupOf(element, root, declaredPopup);

  return {
    withinFormRoot: !root.isExcluded(element),
    ...(input.popupOwner === undefined
      ? {}
      : {
          withinOwnedPopup:
            !root.isExcluded(input.popupOwner) &&
            ownedPopupOf(input.popupOwner)?.contains(element) === true,
        }),
    ...(input.declaredPopup === undefined ? {} : { withinRuleDeclaredPopup: popup !== null }),
    ...(input.declaredSuggestion === undefined && input.declaredPopup === undefined
      ? {}
      : {
          ruleDeclaredOption: conflicting
            ? false
            : declaredPopup === null
              ? matchesDeclaredSuggestion(element, input.declaredSuggestion!)
              : popup !== null && matchesSelector(element, declaredPopup.optionSelector),
        }),
    insideHtmlForm: element.closest('form') !== null,
    kind,
    planned: input.planned,
    openedByTransaction: input.openedByTransaction ?? false,
    tagName: element.tagName,
    role: element.getAttribute('role') ?? undefined,
    inputType: element.getAttribute('type') ?? undefined,
    buttonType: element.localName === 'button' ? (element.getAttribute('type') ?? '') : null,
    accessibleName,
    // 文案两路都给：`labelTextFor` 会回落 aria-label，而有些按钮的可读文本
    // 只在 textContent 里（iCIMS 的删行按钮是纯图标 + aria-label，反过来
    // Greenhouse 的加行按钮没有 aria-label 只有文本）。
    labelText: (element.textContent ?? '').trim(),
    isHidden: html.hidden === true || element.getAttribute('aria-hidden') === 'true',
    isDisabled:
      (element as Partial<HTMLButtonElement>).disabled === true ||
      element.getAttribute('aria-disabled') === 'true',
    isLikelyOffscreen: input.isLikelyOffscreen ?? false,
    isLikelyHoneyPot: input.isLikelyHoneyPot ?? false,
    inPasswordContainer: inClosest(element, PASSWORD_CONTAINERS),
    inCaptcha: inClosest(element, CAPTCHA_CONTAINERS),
    opensFileDialog:
      element.localName === 'input' && element.getAttribute('type') === 'file',
    hasHref: element.hasAttribute('href'),
    hrefNavigates: hrefNavigates(element),
    ...(input.declaredRowAction === undefined ? {} : { declaredRowAction: input.declaredRowAction }),
    ...(input.choiceControl === undefined ? {} : { choiceControl: input.choiceControl }),
    ...(input.signOnBehalf === undefined ? {} : { signOnBehalf: input.signOnBehalf }),
    ...(input.declaredAccountControl === undefined ? {} : { declaredAccountControl: input.declaredAccountControl }),
    ...(kind === 'proxy-option' ? proxyOptionFacts(element, input.intendedCarrier ?? null) : {}),
    ...(input.signingQuestion === undefined ? {} : { signingQuestion: signingQuestionText(input.signingQuestion, root) }),
  };
}

/** 同意类文案的判据由 `dict/guards` 持有，这里只是让引用不被误删。 */
void CONSENT_GRANT;

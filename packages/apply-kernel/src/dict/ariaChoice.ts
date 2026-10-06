/**
 * ARIA 代理选项（2026-09-23）：用户点的是一个**把选中态公布在 ARIA 状态上**的元素，
 * 原生控件要么藏在它里面，要么只是它旁边的一面镜子，要么根本没有。
 *
 * 两家真实页面（同日只读实测）是同一件事的两种长法：
 *  · Ashby 的是非题：两颗 `button[aria-pressed]`（没有 type 属性、没有表单归属），旁边一个
 *    `display:none`、`tabindex=-1` 的 checkbox，只镜像「Yes」——答了 No 它照样不勾。
 *    扫描器过去只看见那个 checkbox，题干读对了，却因为它 0×0 被几何蜜罐层判成陷阱，
 *    整道题从面板上消失；选项是「YesNo」一项。
 *  · Workable 的单选题：`fieldset[role=radiogroup][aria-labelledby]` 里每个选项是
 *    `div[role=radio][aria-checked]`（漫游 tabindex），里面包着 `aria-hidden` + `tabindex=-1`
 *    的原生 radio——恰好是 react-select 占位框的那个形状，于是被当成占位框整个丢掉。
 *    宿主只认那个隐藏 radio 上的 click（React 的 onChange 从 click 起），点代理本身不起作用；
 *    点完之后代理的 `aria-checked` 当场翻，隐藏 radio 的 `checked` 要晚一拍、而且会与之不一致。
 *
 * 所以这一类题的**真相在代理的 ARIA 状态上**：读它、按它验，写入是一次点击（有承载的原生
 * radio/checkbox 就点它，没有就点代理本身），绝不写属性——ARIA 属性由宿主改，我们只读。
 *
 * 本文件只认 WAI-ARIA 标准语义，不认任何厂商 class 或 data 属性（RULE-GLOBAL-DOM-RULE-BOUNDARY）：
 *  · `button[aria-pressed]`：切换按钮，成组时是单选；
 *  · `[role="radio"][aria-checked]`：单选；
 *  · `[role="checkbox"][aria-checked]`：复选，各自独立。
 * 状态值只认字面 `"true"` / `"false"`：`mixed` 是三态复选，缺省说明它不是一个切换控件，
 * 两者都不是一个可以作答的选项。原生 input / select / textarea 自己带 ARIA 状态的
 * （Workday 的 radio 自己写 aria-checked）不是代理，那一类仍走原生选择题。
 */

/** 代理选项的语义：切换按钮与 radio 成组时单选，checkbox 各自独立。 */
export type AriaProxyKind = 'toggle' | 'radio' | 'checkbox';

/** 代理公布选中态用的那个 ARIA 属性。 */
export type AriaProxyState = 'aria-pressed' | 'aria-checked';

/**
 * 扫描面上的代理选项。与 `CONTROL_SELECTOR` 并列，只给扫描循环与身份计数用；
 * 属性值不在选择器里判——值合不合法由 `ariaProxyKind` 读当下的 DOM 决定。
 */
export const ARIA_PROXY_OPTION_SELECTOR =
  'button[aria-pressed], [role="radio"][aria-checked], [role="checkbox"][aria-checked]';

/**
 * 一个问题的**分组容器**（ARIA / HTML 标准的那三种）。代理选项靠它归成一道题；
 * 规则声明的 question scope 容器是另一个来源，由解释器取两者中离选项最近的那个。
 */
export const ARIA_CHOICE_GROUP_SELECTOR = '[role="radiogroup"], [role="group"], fieldset';

const NATIVE_CONTROLS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);

function stateToken(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

/** 这个元素是不是一个可作答的代理选项，是哪一种；不是就返回 null。 */
export function ariaProxyKind(element: Element): AriaProxyKind | null {
  if (NATIVE_CONTROLS.has(element.localName)) return null;
  const role = element.getAttribute('role')?.trim().toLowerCase() ?? '';
  if (role === 'radio' || role === 'checkbox') {
    return stateToken(element.getAttribute('aria-checked')) === null ? null : role;
  }
  // 按钮只有在**没有另声明别的角色**时才是切换按钮：`role="switch"` 是开关，语义另算。
  if (element.localName === 'button' && (role === '' || role === 'button')) {
    return stateToken(element.getAttribute('aria-pressed')) === null ? null : 'toggle';
  }
  return null;
}

export function ariaProxyStateAttribute(kind: AriaProxyKind): AriaProxyState {
  return kind === 'toggle' ? 'aria-pressed' : 'aria-checked';
}

/** 切换按钮与 radio 成组时一次只能选一项；checkbox 各自独立。 */
export function isSingleChoiceProxy(kind: AriaProxyKind): boolean {
  return kind !== 'checkbox';
}

/** 代理此刻公布的选中态；不是合法的 `"true"`/`"false"` 就是 null（读不出 ≠ 没选）。 */
export function ariaProxyPressed(element: Element, kind: AriaProxyKind): boolean | null {
  return stateToken(element.getAttribute(ariaProxyStateAttribute(kind)));
}

/**
 * 代理选项里**承载**答案的那个原生控件（Workable：`div[role=radio]` 里的隐藏 radio）。
 *
 *  · 切换按钮不可能有承载：`<button>` 的内容模型不许放交互控件——里面真有一个就是畸形，按歧义拒；
 *  · radio / checkbox 代理里恰好一个 `input`、type 与代理的角色逐字相同、离它最近的代理就是
 *    这一个，才算承载；
 *  · 一个都没有 = 纯 ARIA 部件（`null`），写入就点代理本身；
 *  · 多于一个、type 不符、或者它其实属于一个嵌套得更深的代理 = `'AMBIGUOUS'`，整道题不认。
 */
export function ariaProxyCarrier(
  option: Element,
  kind: AriaProxyKind,
): HTMLInputElement | null | 'AMBIGUOUS' {
  const inputs = [...option.querySelectorAll('input')];
  if (inputs.length === 0) return null;
  if (kind === 'toggle' || inputs.length !== 1) return 'AMBIGUOUS';
  const carrier = inputs[0]!;
  if (carrier.type !== kind) return 'AMBIGUOUS';
  if (nearestAriaProxyOption(carrier) !== option) return 'AMBIGUOUS';
  return carrier;
}

/** 从一个元素往上找，离它最近的那个代理选项（它自己不算）。 */
export function nearestAriaProxyOption(element: Element): Element | null {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    if (ariaProxyKind(current) !== null) return current;
  }
  return null;
}

/**
 * 点它会不会提交或重置一张表单。
 *
 * `<button>` 缺省 type 是 submit（Ashby 的是非题按钮就没写 type，IDL 读出来是 `submit`），
 * 但只有**有表单归属**时提交才会发生——Ashby 整页没有 `<form>`，`button.form === null`。
 * 归属按 IDL `form` 读，它把 `form="id"` 那种远端关联也算进去（`closest('form')` 看不见它）。
 * reset 同样算：一次 reset 会把用户已经填好的整张表清空。
 */
export function canSubmitOrResetAForm(element: Element): boolean {
  if (element.localName !== 'button') return false;
  const button = element as HTMLButtonElement;
  return button.form !== null && button.type !== 'button';
}

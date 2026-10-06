import type { ApplyControlKind } from '../contracts.ts';

/**
 * 控件分类。四家适配器共用一份，而不是各抄一遍——"同一条规则散在多处"正是
 * Lever 那次漏改 policy 的形状（三处登记只改了两处，10 条适配器测试全绿）。
 *
 * 这里只认 **ARIA 标准**属性，不认任何厂商 class，所以放在 dict/ 而不是
 * parsers/<vendor>/（铁律 1 约束的是厂商专有知识，`role="combobox"` 不是）。
 */

function isTextarea(element: Element): element is HTMLTextAreaElement {
  return element.localName === 'textarea';
}

function isSelect(element: Element): element is HTMLSelectElement {
  return element.localName === 'select';
}

function isInput(element: Element): element is HTMLInputElement {
  return element.localName === 'input';
}

function hasNonInteractiveBoundary(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute('disabled') ||
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true' ||
      current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true'
    ) return true;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    current = (current.getRootNode() as Partial<ShadowRoot>).host ?? null;
  }
  return false;
}

/** Direct, currently usable declaration only; inherited/hidden/disabled is never authority. */
export function isContentEditable(element: Element): element is HTMLElement {
  const value = element.getAttribute('contenteditable')?.trim().toLowerCase();
  return (
    (value === '' || value === 'true' || value === 'plaintext-only') &&
    !hasNonInteractiveBoundary(element) &&
    element.getAttribute('aria-readonly')?.trim().toLowerCase() !== 'true'
  );
}

/** v1 只写这些 `type` 的文本类输入。 */
const TEXTUAL_INPUT_TYPES = ['text', 'email', 'tel', 'url', 'search'];

/**
 * 原生日期与数字输入（CAP-AF-002，2026-08-22 接入）。
 *
 * 它们与文本框走**同一套写入原语**（`value` 是允许写的属性之一，见
 * `write/allowlist.ts`），差别只在「该写什么格式的字符串」——而那件事由
 * `dateFormat.ts` 按 HTML 规范决定，不在本文件。
 *
 * 为什么此前一律 `unsupported`：`TEXTUAL_INPUT_TYPES` 是 v1 的保守起点。
 * 代价是实测三家的日期栏一栏都填不了——Workable 的 `start_date`/`end_date`
 * 是纯文本框（本来就在白名单里），但 Greenhouse 的「年」是 `type=number`、
 * 另有厂商用 `type=date`/`month`。
 *
 * `number` 单独说一句：它当然不只出现在年份栏（期望薪资也是 `number`）。
 * 挡住那些的不是控件类型白名单，而是**取值那一侧**——一个控件要拿到值必须
 * 先被规则映射到某个键或角色，而期望薪资另有 `isJobDependentField` 一道守卫
 * （答案是 f(候选人 × 岗位)，只能本人答）。控件类型从来不是安全边界。
 */
const NATIVE_VALUE_INPUT_TYPES = ['date', 'month', 'number'];

/**
 * 一个由 JS 部件托管的下拉，其可见输入框**也是** `<input type="text">`。
 *
 * 这条判断不是洁癖，是修一个实测过的错填。2026-08-01 在真实 Greenhouse 页面
 * （`#country`，react-select）上按我们 `setValue` 的完整做法写入 "United States"：
 *   · 写完同步读：`value === "United States"`，控件**没有任何选中值**
 *   · blur 结算后：`value === ""`，依然没有选中值
 * C6 读回正好落在这两个时刻之间。落晚了报 `WRITE_REVERTED`（用户看到一个
 * 语义错误的原因），落早了**把一次什么都没填的写入报成成功**。
 *
 * 判成 combobox 之后，这类控件改走 `click/combobox.ts` 的开→匹配→点，
 * 而不是 setValue。
 */
function isHostedCombobox(element: HTMLInputElement): boolean {
  return (
    element.getAttribute('role') === 'combobox' ||
    element.getAttribute('aria-haspopup') === 'listbox'
  );
}

/**
 * `'choice'` = 单选 / 复选。它们的授权范围见 16 号裁决授权卡 A 栏；
 * 挡住它们的不是那份范围，而是**没有数据**：
 * 11 个档案键全是身份与联系方式的文本，一个都答不了"是否需要签证赞助"这类问题，
 * 而那 11 个键是已交付后端的契约，不能顺手加。
 *
 * 所以这里刻意**不**让它们进 `ApplyControlKind`——进去就要配写入原语、能力位、
 * 撤销路径，而没有任何调用方会产出值。这个仓已经四次栽在"写好了没有调用方"上
 * （蜜罐守卫、推荐人守卫、JOB_DEPENDENT、combobox 能力位），每次都是单测全绿、
 * 真实页面零效果。**先有数据源，再有写入路径。**
 *
 * 分出这个取值本身是有用的：用户看到的原因从"这类控件不支持"（现在是**假话**）
 * 变成"这题得你自己选"，两者的下一步动作不同。
 */
export function classifyControl(element: Element): ApplyControlKind | 'choice' | 'unsupported' {
  if (isContentEditable(element)) return 'richtext';
  if (isTextarea(element)) return 'textarea';
  if (isSelect(element)) return 'select';
  if (isInput(element)) {
    // 文件控件有自己的写入原语（write/setFile.ts）与能力位。引擎会再用
    // `isResumeFileField` 把它收窄到**简历**那一栏——一张表上常常还有求职信、
    // 成绩单、作品集，挂错比不挂糟得多。
    if (element.type === 'file') return 'file';
    // 同名成员由解释器合成一道 'choice' 题（一组一个描述符）；答案来自审阅面板。
    if (element.type === 'radio' || element.type === 'checkbox') return 'choice';
    // 原生日期/数字框不可能是 JS 托管下拉——那类部件的可见输入框一律是
    // `type="text"`（见 isHostedCombobox 的实测注释）。
    if (NATIVE_VALUE_INPUT_TYPES.includes(element.type)) return 'text';
    if (!TEXTUAL_INPUT_TYPES.includes(element.type)) return 'unsupported';
    return isHostedCombobox(element) ? 'combobox' : 'text';
  }
  return 'unsupported';
}

/**
 * 站点**自己声明**"这个控件不是给人填的"。
 *
 * 判据是合取，且两条都来自站点自己的声明：
 *   · `aria-hidden="true"` —— 明确从无障碍树里摘掉；
 *   · `tabindex="-1"` —— 明确移出 Tab 序。
 * 两条同时成立时，它不可能是一个等着用户填的字段。
 *
 * 真实来源（2026-08-09 负责人首次真实页面试用 + 我在 Greenhouse Anthropic
 * 招聘页复现）：react-select 给每个下拉都配一个
 * `input.remix-css-*-requiredInput` 校验垫片——无 id、无 name、`opacity:0`、
 * `pointer-events:none`。它会在面板里渲染成**一个没有名字的空白行**，
 * 用户看到的是"我们打算往一个看不见的框里写东西"。
 *
 * ⚠️ **绝不能放宽成"看不见就跳过"。** 简历的原生 file 控件恰恰是视觉隐藏的，
 * A3 整条取件路径都建立在它上面。同一页实测：`#resume` 是 `tabIndex 0`、
 * 没有 `aria-hidden`、`pointer-events:auto` —— 这条判据碰不到它。
 * `tests/s0/apply-hidden-file-input.redgreen.test.ts` 锁死这个边界。
 */
export function isSiteDeclaredNonInput(element: Element): boolean {
  return (
    element.getAttribute('aria-hidden') === 'true' && element.getAttribute('tabindex') === '-1'
  );
}

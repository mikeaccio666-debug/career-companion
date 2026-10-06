/**
 * Structural field identity for the narrow interval between preview and Fill.
 *
 * This stays at L2: it can only read through ScanRoot, so neither the runner
 * nor a vendor adapter needs a page-wide selector escape hatch. It is not the
 * future answer-memory signature from V2; that has a different purpose and
 * intentionally different inputs.
 */

import type {
  ApplyWritableElement,
  FieldIdentityScope,
  FieldSignature,
  ScanRoot,
} from './contracts.ts';
import { ariaProxyKind } from './dict/ariaChoice.ts';
import { rowIndexOfScopeKey } from './scanRoot.ts';

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Framework-generated ids are intentionally absent. Dynamic numeric segments
 * in a `name` become a stable shape marker, while semantic text remains part
 * of the identity.
 */
function normalizeNameShape(value: string): string {
  const normalized = normalizeText(value)
    .replace(/[a-f\d]{8,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || '∅';
}

function controlType(element: Element): string {
  // ARIA 代理选项（2026-09-23）：种类进签名。状态属性被删、换了角色，签名随之变——那已经不是
  // 预览时看到的那一道题了。
  const proxy = ariaProxyKind(element);
  if (proxy !== null) return `aria-${proxy}`;
  if (element.localName === 'select') {
    return element.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
  }
  if (element.localName !== 'input') return element.localName.toLowerCase();
  return normalizeText(element.getAttribute('type') || 'text') || 'text';
}

/**
 * `core` contains only structural facts: tag, type, normalised name shape,
 * the identity scope key and the control's ordinal **within that scope**.
 * Labels never participate in the blocker, but their normalised value remains
 * available as a non-sensitive drift hint.
 *
 * "行标识 + 行内序号"（40-工程计划 P1）：计数域由 ScanRoot.identityScope
 * 给出——行内控件在行内数、根域控件只数行外控件，"加一行"插入的整批控件
 * 因此不再冲掉其他字段的序号。行知识是 apply-rules 数据（rowScopes），
 * 本文件保持厂商中立。
 */
export function fieldSignature(
  element: Element,
  root: ScanRoot,
  /**
   * 已经算好的作用域，**纯性能参数**：省掉一次 `identityScope`。
   *
   * ⚠️ `identityScope` 是每字段一次全树查询，形态是二次方且**刻意不缓存**
   * （签名必须反映当下的页面）。接了行模型（CAP-AF-003）之后，同一个字段上
   * 有三处会各查一次——本函数、解释器的 `rowRuleFor`、engine 的 `fieldRowIndex`。
   * 实测（2026-08-23，40 字段合成表）：main 是 1.00 次/字段，本分支 2.00，
   * 行内字段 3.00。800 字段的注入预算因此从 <400ms 抬到 420–439ms。
   *
   * 省略它**行为完全相同**，只是慢一倍——所以它是可选参数而不是必填。
   * 这一点与 `ClickTargetFacts` 那次不同：那里的可选字段决定一条 deny 跑不跑，
   * 缺席等于静默放行；这里缺席只影响速度，而**速度有门禁盯着**
   * （`apply-injection-budget.test.ts` 数每字段查询次数，忘了传会红）。
   */
  precomputedScope?: FieldIdentityScope,
): FieldSignature {
  const tag = element.localName.toLowerCase();
  const name = normalizeNameShape(element.getAttribute('name') || '');
  const scope = precomputedScope ?? root.identityScope(element);
  // A field that moved under the adapter's exclusion list is no longer within
  // the reviewed scope. Its old control ordinal may coincidentally survive,
  // so use an impossible scanned ordinal to force the runner to fail closed.
  //
  // ARIA 代理题的主人是一个代理选项，它不在 `controls`（原生控件）里：在同一计数域的代理选项里数
  // （`proxyOptions` 惰性，只有这里会付那一次全树查询）。数不出来 = -1，与「被排除」同一种失败关闭。
  const ordinal = root.isExcluded(element)
    ? -1
    : ariaProxyKind(element) !== null
      ? scope.proxyOptions?.().indexOf(element) ?? -1
      : scope.controls.findIndex((candidate) => candidate === element);
  return {
    core: `${tag}|${controlType(element)}|${name}|${scope.scopeKey}|${ordinal}`,
    labelHint: normalizeText(root.labelTextFor(element)),
  };
}

/** The sole L2 read probe for a writable host control; it has no side effect. */
export function readValue(element: ApplyWritableElement): string {
  return element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ? element.value
    : element.textContent ?? '';
}

/**
 * 这个字段属于页面上的第几行（0 起）；不在任何行里就是 `null`。
 *
 * 投影层要拿它去对档案的第几段（CAP-AF-020）。走签名同一条路（`identityScope`），
 * 所以「计划里说的第 2 行」和「身份复核认的第 2 行」不可能是两个东西。
 */
export function fieldRowIndex(element: Element, root: ScanRoot): number | null {
  return rowIndexOfScopeKey(root.identityScope(element).scopeKey);
}

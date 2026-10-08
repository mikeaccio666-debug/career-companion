/**
 * Container-scoped host-form reader.
 *
 * Adapters receive this narrow object instead of a page-wide root. That makes
 * it impossible for label resolution to accidentally escape from the explicit
 * application form into a newsletter/footer with the same id.
 */

import type {
  ApplyFieldDescriptor,
  FieldIdentityScope,
  HostVisibilityStyle,
  RowScopeRule,
  ScanRoot,
  ScanRootOptions,
} from './contracts.ts';
import { isContentEditable, isSiteDeclaredNonInput } from './dict/controls.ts';
import { isRequiredMarkerText } from './dict/requiredMarker.ts';
import { ARIA_PROXY_OPTION_SELECTOR, ariaProxyKind, ariaProxyStateAttribute } from './dict/ariaChoice.ts';
import { RULE_ATTR_MAP_ATTRS } from './rules/schema.ts';

/**
 * 行标识的字面格式：`row·<规则序>:<容器序>:<行序>`。
 *
 * 它同时是**签名的一部分**（fieldIdentity）和**投影层的输入**（哪一行 ↔ 哪一段），
 * 所以格式只能有一个主人：产出它的 identityScope 与解析它的 rowIndexOfScopeKey
 * 都在本文件，改格式必须一处改两处一起动。
 */
export const ROW_SCOPE_PREFIX = 'row·';

/**
 * 从行标识里取出行序。根域（空串）与任何不认得的形状都返回 null——
 * 「不知道是第几行」和「第 0 行」必须区分得开，否则每一个根域字段都会被
 * 当成第 1 段经历。
 */
export function rowIndexOfScopeKey(scopeKey: string): number | null {
  if (!scopeKey.startsWith(ROW_SCOPE_PREFIX)) return null;
  const parts = scopeKey.slice(ROW_SCOPE_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const rowIndex = Number(parts[2]);
  return Number.isInteger(rowIndex) && rowIndex >= 0 ? rowIndex : null;
}

/**
 * 扫描面。
 *
 * `[contenteditable]` 是 2026-08-21 补进来的（CAP-AF-004 的扫描那一半）：此前
 * 只有原生三件套，于是富文本编辑器 —— Ashby 与部分 Workable 自定义题用的那种
 * ——**整个不在视野里**。后果不是"填不上"，是**在分母上撒谎**：三个 input 都填好
 * 之后我们报「必填 3/3 已就绪」，而旁边那个必填的「Why do you want to join us?」
 * 我们从头到尾没提过它存在，用户看着满绿的面板去点提交，被宿主打回。
 *
 * 扫到它**不等于**能写它。写入原语（写入点、事件序列、原值快照与还原）是另一件事，
 * 而且富文本最有价值的那一栏——求职信正文——不是 Profile 档案键（11 键上限）；
 * 它由 T9 的 CAP-AF-025 提供独立材料。在正式 source caller 接线前，扫到之后的正确终点是如实报
 * `UNSUPPORTED_CONTROL`、进必填分母、在面板上占一行并可 [定位]：
 * 「我们填不了这一栏，但它在这儿，你得自己填」。
 *
 * ⚠️ 只收**真正可编辑**的：`contenteditable="false"` 与不带该属性的普通 div 必须
 * 排除，否则整页的文字块都会变成"字段"。属性的空串等同于 true（HTML 规范），
 * 所以判据是"属性在且不是 false"，不是"属性值等于 true"。
 */
export const CONTROL_SELECTOR = 'input, select, textarea, [contenteditable]';

/**
 * 按 id 解析 ARIA 引用（`aria-controls` / `aria-owns` / `aria-describedby`），
 * **从引用者自己的 root 开始找**。
 *
 * 为什么不能用 `element.ownerDocument.getElementById`：id 的作用域是**节点树**，
 * 不是文档。控件在 shadow root 里时，它 `aria-controls` 指的菜单通常也在同一个
 * shadow root 里，而 `document.getElementById` 不穿透——返回 null，于是
 * "菜单没打开" 与 "菜单在影子树里" 这两件完全不同的事在上层长得一模一样
 *（2026-09-15 实测形态：SmartRecruiters 的 one-click 表单整张在 shadow root 里，
 * 每个 role=combobox 的 `aria-controls` 都指向同一影子树内的 `[role=listbox]`）。
 *
 * `getRootNode()` 给出引用者所在的树：Document 或 ShadowRoot，两者都实现
 * `getElementById`。老环境（happy-dom 的 ShadowRoot）可能没有该方法，退回
 * 同树 `querySelector`；id 含特殊字符时 `CSS.escape` 不可用就放弃，保守返回 null，
 * 绝不扩大到别的树里去猜。
 */
export function resolveAriaReference(reference: Element, id: string): Element | null {
  if (id === '') return null;
  const root = reference.getRootNode() as Document | ShadowRoot;
  const byId = (root as Partial<Document>).getElementById;
  if (typeof byId === 'function') return byId.call(root, id);
  const escape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  if (typeof escape !== 'function') return null;
  return (root as ParentNode).querySelector(`#${escape(id)}`);
}

/**
 * `[contenteditable]` 选择器会连 `contenteditable="false"` 一起收进来，
 * 这里把它们滤掉。`inherit` 同样不算——它把可编辑性交给祖先，自己不声明。
 */
export function isScannableControl(element: Element): boolean {
  if (['input', 'select', 'textarea'].includes(element.localName)) return true;
  return isContentEditable(element);
}

/**
 * A control hidden from assistive technology is not a user-facing field.
 *
 * 真实 Greenhouse 实测（2026-09-10，33 个公开 job-boards 页面）：react-select 在
 * `required` 且尚无值时渲染 `<input aria-hidden="true" tabindex="-1" required>`
 * 占位框，选中值后立即删掉它。电话控件写入让国家下拉得到值，占位框消失，
 * 之后每个字段的行内序号前移一格——identity recheck 报 IDENTITY_CHANGED、
 * 突变快照判定页面已变，整轮中止。这类占位框既不参与身份序号，其出现与
 * 消失也不是语义变化；真实控件的增删照旧 fail closed。
 *
 * 占位框的边界与 scanner 的 `isSiteDeclaredNonInput` 完全一致：`aria-hidden="true"` 且
 * `tabindex="-1"`。只带 `aria-hidden` 的控件仍是表单里的字段（见 apply-aria-hidden-shim），
 * 它照常参与身份序号，属性变化也照常算语义变化。
 */
export function isAssistiveHiddenControl(element: Element): boolean {
  return isScannableControl(element) && isSiteDeclaredNonInput(element);
}

function isIdentityCountedControl(element: Element): boolean {
  return isScannableControl(element) && !isSiteDeclaredNonInput(element);
}

/**
 * ARIA 代理题的签名序号在这些元素里数（`FieldIdentityScope.proxyOptions`）。
 *
 * 按**属性在不在**数，不按值合不合法：选中态在 `"true"` / `"false"` 之间翻不该挪动任何一道题的
 * 序号。原生控件自己带 ARIA 状态的不算（它们在 `controls` 里数）。
 */
function isProxyOptionNode(element: Element): boolean {
  return !['input', 'select', 'textarea'].includes(element.localName);
}

function isAssistiveHiddenControlNode(node: Node): boolean {
  return node.nodeType === 1 && isAssistiveHiddenControl(node as Element);
}
const trustedScanRoots = new WeakSet<object>();
interface TrustedScanRootMutationMetadata {
  readonly container: Element;
  readonly mutationTargets: Set<Node>;
  readonly openShadowRoot: (element: Element) => ShadowRoot | null;
  readonly root: ScanRoot;
  readonly ruleBinding: ScanRootRuleBinding | null;
  readonly semanticSelectors: readonly string[];
  semanticRescan: (() => readonly ApplyFieldDescriptor[]) | null;
  sealedPolicy: ScanRootMutationPolicy | null;
}

const trustedScanRootMutationMetadata = new WeakMap<object, TrustedScanRootMutationMetadata>();

/**
 * Everything the Extension needs to observe a verified scan without learning
 * selectors or field semantics. The policy is minted only for a branded root.
 */
export interface ScanRootMutationPolicy {
  readonly targets: readonly Node[];
  /** Kernel-owned opaque observer configuration; selectors never cross out. */
  readonly observerOptions: Readonly<MutationObserverInit>;
  /** Exact descriptor-era parity check; it never creates a new baseline. */
  readonly isCurrent: () => boolean;
  /** Cheap between-write fence for attachShadow, which emits no mutation. */
  readonly isExecutionCurrent: () => boolean;
  readonly isRelevant: (records: readonly MutationRecord[]) => boolean;
}

export interface ScanRootRuleBinding {
  readonly page: ParentNode;
  readonly anchors: readonly string[];
}

export interface SealScanRootMutationInput {
  readonly fields: readonly ApplyFieldDescriptor[];
  readonly rescan: () => readonly ApplyFieldDescriptor[];
}

/**
 * Attribute changes that can alter field membership, identity, writability, or
 * label fallback. Remote attrMap names come from the rules schema rather than
 * being copied into the Extension.
 */
const CONTROL_MUTATION_ATTRIBUTES = Object.freeze([...new Set<string>([
  ...RULE_ATTR_MAP_ATTRS,
  'type',
  'form',
  'role',
  'aria-haspopup',
  'required',
  'aria-required',
  'disabled',
  'aria-disabled',
  'aria-readonly',
  'hidden',
  'aria-hidden',
  'inert',
  'multiple',
  'readonly',
  'contenteditable',
  'aria-label',
  'aria-labelledby',
  'placeholder',
  'title',
  'for',
  'tabindex',
])]);

const ANCESTOR_SAFETY_ATTRIBUTES = Object.freeze([
  'disabled',
  'aria-disabled',
  'hidden',
  'aria-hidden',
  'inert',
] as const);


/**
 * 穿透遍历的节点预算。
 *
 * Shadow 穿透要对每个元素问一次"你有没有影子根"，普通页面这点开销可以忽略，
 * 但恶意或病态页面能用几十万节点把扫描拖死。命中预算就停在已经收集到的结果上
 * ——**宁可少扫，不可卡住宿主页面**。参照 Dashlane 公开基准：普通页面可忽略、
 * Shadow-DOM 密集页面 <5% 开销。
 */
const SHADOW_TRAVERSAL_NODE_BUDGET = 20_000;

interface ShadowTraversalBudget {
  remaining: number;
  exhausted?: boolean;
}

/** 缺省只看 open root；闭合根要靠调用方注入打开器。 */
function openShadowRootDefault(element: Element): ShadowRoot | null {
  return element.shadowRoot;
}

/**
 * 一次同步扫描之内的影子根索引（2026-09-28，通用路探测耗时）。
 *
 * `queryAllDeep` 每查一次都把查询范围里的**每一个元素**问一遍「你有没有影子根」。生产里那个问法是
 * `chrome.dom.openOrClosedShadowRoot`，一次调用要过一趟扩展 API 绑定；而扫描每个字段要查好几次（标签的
 * 祖先级联、身份作用域……），于是一次探测里这个调用发生「字段数 × 元素数」次。2026-09-28 在 lab 里对
 * Jane Street、D. E. Shaw 的申请页录 CPU：七成时间花在它身上，通用探测 135–150ms，生产的预算是 50ms。
 *
 * 一次**同步**扫描之内页面不会变（扫描只读；宿主的脚本、MutationObserver 回调都排在这一拍之后），所以
 * 「哪些元素挂着影子根」在这一拍里是同一个答案：每个元素只问一次，记下来，这一拍里的每一次穿透查询都
 * 只在这些影子根之间跳。拍子一结束索引就扔掉——写入期的身份复核、封存比对一律照旧活查
 * （见 apply-injection-budget.test.ts 头注「不要用缓存去修它」：那里说的是跨拍的缓存，这里没有）。
 *
 * 节点预算照旧：整棵容器树走一遍最多 SHADOW_TRAVERSAL_NODE_BUDGET 个元素；走不完就不用索引，退回原来的
 * 逐次查询（逐次查询的预算按各自的范围算，病态大页上与从前逐字相同）。
 */
interface ShadowIndex {
  /** 影子宿主 → 它的影子根。 */
  readonly shadowOf: ReadonlyMap<Element, ShadowRoot>;
  /** 每棵树（Document、ShadowRoot 或脱离文档的片段）里的影子宿主，按文档序。 */
  readonly hostsByTree: ReadonlyMap<Node, readonly Element[]>;
}

function buildShadowIndex(
  container: Element,
  openShadowRoot: (element: Element) => ShadowRoot | null,
  mutationTargets: Set<Node>,
): ShadowIndex | null {
  const budget: ShadowTraversalBudget = { remaining: SHADOW_TRAVERSAL_NODE_BUDGET };
  const shadowOf = new Map<Element, ShadowRoot>();
  const hostsByTree = new Map<Node, Element[]>();
  const found: ShadowRoot[] = [];
  const note = (host: Element, shadow: ShadowRoot): void => {
    shadowOf.set(host, shadow);
    const tree = host.getRootNode();
    const hosts = hostsByTree.get(tree);
    if (hosts === undefined) hostsByTree.set(tree, [host]);
    else hosts.push(host);
    found.push(shadow);
  };
  const walk = (scope: ParentNode): boolean => {
    for (const element of scope.querySelectorAll('*')) {
      if (budget.remaining <= 0) return false;
      budget.remaining -= 1;
      const shadow = openShadowRoot(element);
      if (shadow === null) continue;
      note(element, shadow);
      if (!walk(shadow)) return false;
    }
    return true;
  };
  budget.remaining -= 1;
  const own = openShadowRoot(container);
  if (own !== null) {
    note(container, own);
    if (!walk(own)) return null;
  }
  if (!walk(container)) return null;
  for (const shadow of found) mutationTargets.add(shadow);
  return { shadowOf, hostsByTree };
}

/** 与 `queryAllDeep` 同一个结果、同一个顺序，只是影子根取自这一拍的索引。 */
function queryAllIndexed(scope: ParentNode, selector: string, index: ShadowIndex): Element[] {
  const found: Element[] = [...scope.querySelectorAll(selector)];
  if ((scope as Node).nodeType === 1) {
    const own = index.shadowOf.get(scope as Element);
    if (own !== undefined) found.push(...queryAllIndexed(own, selector, index));
  }
  const tree = (scope as Node).nodeType === 11 ? scope as Node : (scope as Node).getRootNode();
  for (const host of index.hostsByTree.get(tree) ?? []) {
    if (host === scope || !(scope as Node).contains(host)) continue;
    found.push(...queryAllIndexed(index.shadowOf.get(host)!, selector, index));
  }
  return found;
}

/** 扫描拍子的开关，只在本模块与 `withScanPass` 之间。 */
interface ScanPassControl {
  readonly begin: () => void;
  readonly end: () => void;
}

const scanPassControls = new WeakMap<object, ScanPassControl>();

/**
 * 在一次同步扫描之内跑 `run`：这一拍里的穿透查询共用一份影子根索引（见 `ShadowIndex`）。可以嵌套；
 * 最外层结束时扔掉索引。`run` 必须是同步的——拍子跨过 await，页面就可能已经变了。
 */
export function withScanPass<T>(root: ScanRoot, run: () => T): T {
  const control = scanPassControls.get(root);
  if (control === undefined) return run();
  control.begin();
  try {
    return run();
  } finally {
    control.end();
  }
}

/**
 * 穿透 shadow root 的 querySelectorAll。
 *
 * 为什么必须有：`container.querySelectorAll` 不跨影子边界。四家 ATS 今天不用
 * web component 所以不痛，但任何一家改版、或接入用 shadow 封装表单的新站点，
 * 我们就是零字段、零报错、静默失效——最难被发现的那种。
 */
function queryAllDeep(
  scope: ParentNode,
  selector: string,
  openShadowRoot: (element: Element) => ShadowRoot | null,
  budget: ShadowTraversalBudget,
  mutationTargets?: Set<Node>,
): Element[] {
  const found: Element[] = [...scope.querySelectorAll(selector)];
  // A custom element may itself be the verified anchor (SmartRecruiters).
  // querySelectorAll('*') never returns the scope node, so inspect its own
  // shadow root explicitly before walking descendants.
  if ((scope as Node).nodeType === 1) {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
    } else {
      budget.remaining -= 1;
      let ownShadow: ShadowRoot | null = null;
      try {
        ownShadow = openShadowRoot(scope as Element);
      } catch {
        ownShadow = null;
      }
      if (ownShadow) {
        mutationTargets?.add(ownShadow);
        found.push(...queryAllDeep(
          ownShadow,
          selector,
          openShadowRoot,
          budget,
          mutationTargets,
        ));
      }
    }
  }
  for (const element of scope.querySelectorAll('*')) {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      break;
    }
    budget.remaining -= 1;
    let shadow: ShadowRoot | null = null;
    try {
      shadow = openShadowRoot(element);
    } catch {
      // 打开器由调用方注入，失败不能让整轮扫描崩掉——保守当作没有影子根。
      shadow = null;
    }
    if (shadow) {
      mutationTargets?.add(shadow);
      found.push(...queryAllDeep(
        shadow,
        selector,
        openShadowRoot,
        budget,
        mutationTargets,
      ));
    }
  }
  return found;
}

/**
 * Only roots created by this module may mint a host-write candidate.
 *
 * `ScanRoot` is intentionally a structural interface for adapters, so a type
 * assertion alone cannot be an authority boundary. This runtime brand keeps a
 * caller-provided label reader from becoming the source of truth for a write.
 */
export function isTrustedScanRoot(value: unknown): value is ScanRoot {
  return typeof value === 'object' && value !== null && trustedScanRoots.has(value);
}

/**
 * Capture the complete, currently reachable observation domain for one
 * trusted root. Combobox dispatch uses this to observe even empty ShadowRoots:
 * watching only roots that already contain returned options cannot detect a
 * stale rule view that omits a newly inserted duplicate. Traversal shares the
 * normal hard node budget; exhaustion or an untrusted root fails closed.
 */
export function captureScanRootObservationTargets(
  root: ScanRoot,
): readonly Node[] | null {
  const metadata = trustedScanRootMutationMetadata.get(root);
  if (!metadata) return null;
  const targets = new Set<Node>([metadata.container]);
  const budget: ShadowTraversalBudget = {
    remaining: SHADOW_TRAVERSAL_NODE_BUDGET,
  };
  try {
    queryAllDeep(
      metadata.container,
      '*',
      metadata.openShadowRoot,
      budget,
      targets,
    );
  } catch {
    return null;
  }
  if (budget.exhausted) return null;
  return Object.freeze([...targets]);
}

interface ElementAttributeSnapshot {
  readonly element: Element;
  readonly values: readonly (string | null)[];
}

interface ControlMutationSnapshot {
  readonly element: Element;
  readonly attributes: readonly (string | null)[];
  readonly ancestors: readonly ElementAttributeSnapshot[];
  readonly excluded: boolean;
  readonly labelText: string;
  readonly scopeKey: string;
}

interface ScanRootMutationSnapshot {
  readonly anchorMatches: boolean;
  readonly containerConnected: boolean;
  readonly controls: readonly ControlMutationSnapshot[];
  readonly hostShadowRoots: readonly (ShadowRoot | null)[];
  readonly hosts: readonly Element[];
  readonly semanticFields: readonly SemanticFieldSnapshot[] | null;
  /**
   * 扫描那一代里属于某道 ARIA 代理题的选项，以及当时各自的种类（2026-09-23）。
   * 它们自己公布的选中态与漫游焦点是这道题的**值**，翻转不是结构变化——见
   * `attributeIsSemanticallyRelevant` 里的那一条。
   */
  readonly proxyOptions: ReadonlyMap<Element, ReturnType<typeof ariaProxyKind>>;
  readonly structuralElements: ReadonlySet<Element>;
  readonly targets: readonly Node[];
}

interface SemanticFieldSnapshot {
  readonly confidence: number;
  readonly element: Element;
  readonly key: string | null;
  readonly kind: ApplyFieldDescriptor['kind'];
  readonly label: string;
  readonly required: boolean;
  readonly signatureCore: string;
  readonly signatureLabelHint: string;
  readonly unsupportedReason: string | null;
  readonly writeMode: 'setValue' | 'typed' | null;
}

function semanticFieldSnapshot(field: ApplyFieldDescriptor): SemanticFieldSnapshot {
  return {
    confidence: field.confidence,
    element: field.element,
    key: field.key,
    kind: field.kind,
    label: field.label,
    required: field.required,
    signatureCore: field.signature.core,
    signatureLabelHint: field.signature.labelHint,
    unsupportedReason: field.kind === 'unsupported' ? field.unsupportedReason : null,
    writeMode: 'writeMode' in field ? field.writeMode ?? null : null,
  };
}

function firstBoundContainer(binding: ScanRootRuleBinding | null): Element | null {
  if (binding === null) return null;
  for (const selector of binding.anchors) {
    const container = binding.page.querySelectorAll(selector)[0];
    if (container) return container;
  }
  return null;
}

function composedElementAncestors(element: Element, container: Element): readonly Element[] {
  const ancestors: Element[] = [];
  let current: Node | null = element.parentNode;
  while (current) {
    if (current.nodeType === 1) ancestors.push(current as Element);
    if (current === container) break;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    current = (current as Partial<ShadowRoot>).host ?? null;
  }
  return ancestors;
}

function sameIdentityList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNullableStringList(
  left: readonly (string | null)[],
  right: readonly (string | null)[],
): boolean {
  return sameIdentityList(left, right);
}

function matchesAnySelector(element: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => element.matches(selector));
}

/**
 * 快照没拍成的两种，各自有名字。
 *
 * 这一层原先只回一个 null，上面两层也各只回一个 null，于是「这一页没有表单」
 * 底下压着七八种完全不同的原因。2026-09-18 追一次真实的零写入，
 * 光是把它们一层层分开就花了好几轮（RULE-GLOBAL-ERROR-CONTRACT）。
 */
export type ScanRootSnapshotStop =
  /** 穿透遍历撞到节点预算——病态或超大页面。 */
  | 'BUDGET_EXHAUSTED'
  /** 遍历途中抛了（多半是 openShadowRoot 够不到某个根）。 */
  | 'TRAVERSAL_THREW';

function captureScanRootMutationSnapshot(
  metadata: TrustedScanRootMutationMetadata,
  semanticFields: readonly ApplyFieldDescriptor[] | undefined,
  onStop: (stop: ScanRootSnapshotStop) => void,
): ScanRootMutationSnapshot | null {
  try {
    const targets = new Set<Node>([metadata.container]);
    const hasSemanticRescan = semanticFields !== undefined || metadata.semanticRescan !== null;
    const hostBudget: ShadowTraversalBudget = { remaining: SHADOW_TRAVERSAL_NODE_BUDGET };
    const hosts = [
      metadata.container,
      ...queryAllDeep(
        metadata.container,
        '*',
        metadata.openShadowRoot,
        hostBudget,
        targets,
      ),
    ].filter((host) => !isAssistiveHiddenControl(host));
    if (hostBudget.exhausted) { onStop('BUDGET_EXHAUSTED'); return null; }
    const hostShadowRoots = hosts.map((host) => metadata.openShadowRoot(host));
    // Reuse the bounded host walk. A second CONTROL_SELECTOR traversal here
    // doubled seal cost and had a separate completeness budget.
    const controls = hasSemanticRescan ? [] : hosts.filter(isScannableControl);
    const structuralElements = new Set(
      metadata.semanticSelectors.length === 0
        ? []
        : hosts.filter((element) => matchesAnySelector(element, metadata.semanticSelectors)),
    );
    // 每个控件的标签与身份作用域都要穿透查询：同一拍里共用一份影子根索引（见 `withScanPass`）。
    const snapshots = withScanPass(metadata.root, () => controls.map<ControlMutationSnapshot>((element) => ({
      element,
      attributes: CONTROL_MUTATION_ATTRIBUTES.map((name) => element.getAttribute(name)),
      ancestors: composedElementAncestors(element, metadata.container).map((ancestor) => ({
        element: ancestor,
        values: ANCESTOR_SAFETY_ATTRIBUTES.map((name) => ancestor.getAttribute(name)),
      })),
      excluded: metadata.root.isExcluded(element),
      labelText: metadata.root.labelTextFor(element),
      scopeKey: metadata.root.identityScope(element).scopeKey,
    })));
    const rawSemanticFields = metadata.semanticRescan === null && semanticFields === undefined
      ? null
      : [...(semanticFields ?? metadata.semanticRescan?.() ?? [])];
    const proxyOptions = new Map<Element, ReturnType<typeof ariaProxyKind>>();
    for (const field of rawSemanticFields ?? []) {
      if (field.kind !== 'choice' || field.choice.control !== 'proxy') continue;
      for (const option of field.choice.options) proxyOptions.set(option.element, field.choice.proxy);
    }
    return {
      anchorMatches: metadata.ruleBinding === null ||
        firstBoundContainer(metadata.ruleBinding) === metadata.container,
      containerConnected: metadata.container.isConnected,
      controls: Object.freeze(snapshots),
      hosts: Object.freeze(hosts),
      hostShadowRoots: Object.freeze(hostShadowRoots),
      semanticFields: rawSemanticFields === null
        ? null
        : Object.freeze(rawSemanticFields.map(semanticFieldSnapshot)),
      proxyOptions,
      structuralElements,
      targets: Object.freeze([...targets]),
    };
  } catch {
    // Selector drift, a hostile shadow opener, or an unreadable DOM state is
    // not a new baseline. The caller must rescan under fresh authority.
    onStop('TRAVERSAL_THREW');
    return null;
  }
}

function sameScanRootMutationSnapshot(
  baseline: ScanRootMutationSnapshot,
  current: ScanRootMutationSnapshot,
): boolean {
  if (
    baseline.anchorMatches !== current.anchorMatches ||
    baseline.containerConnected !== current.containerConnected ||
    !sameIdentityList(baseline.hosts, current.hosts) ||
    !sameIdentityList(baseline.hostShadowRoots, current.hostShadowRoots) ||
    !sameIdentityList(baseline.targets, current.targets) ||
    !sameSemanticFields(baseline.semanticFields, current.semanticFields) ||
    baseline.controls.length !== current.controls.length
  ) return false;

  return baseline.controls.every((expected, index) => {
    const actual = current.controls[index];
    if (
      actual === undefined ||
      expected.element !== actual.element ||
      expected.excluded !== actual.excluded ||
      expected.labelText !== actual.labelText ||
      expected.scopeKey !== actual.scopeKey ||
      !sameNullableStringList(expected.attributes, actual.attributes) ||
      expected.ancestors.length !== actual.ancestors.length
    ) return false;
    return expected.ancestors.every((ancestor, ancestorIndex) => {
      const actualAncestor = actual.ancestors[ancestorIndex];
      return actualAncestor !== undefined &&
        ancestor.element === actualAncestor.element &&
        sameNullableStringList(ancestor.values, actualAncestor.values);
    });
  });
}

function isComboboxOptionChurnNode(node: Node): boolean {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  if (!element) return false;
  return element.matches('[role="option"], [role="listbox"]') ||
    element.closest('[role="option"], [role="listbox"]') !== null;
}

function childListIsSemanticallyRelevant(record: MutationRecord): boolean {
  const changed = [...record.addedNodes, ...record.removedNodes];
  if (changed.length === 0) return true;
  // Opening a combobox commonly replaces hundreds of option nodes. Options
  // are write candidates, never scan descriptors, so this churn must not turn
  // into a full application-table rescan.
  return !changed.every(
    (node) => isComboboxOptionChurnNode(node) || isAssistiveHiddenControlNode(node),
  );
}

const SENTINEL_MEMBERSHIP_ATTRIBUTES = new Set(['aria-hidden', 'tabindex']);

const TRANSIENT_COMBOBOX_ATTRIBUTES = new Set([
  'aria-activedescendant',
  'aria-controls',
  'aria-expanded',
  'aria-selected',
]);

function attributeIsSemanticallyRelevant(
  record: MutationRecord,
  baseline: ScanRootMutationSnapshot,
  metadata: TrustedScanRootMutationMetadata,
): boolean {
  const target = record.target;
  const attributeName = record.attributeName?.toLowerCase() ?? null;
  if (target.nodeType !== 1 || attributeName === null) return true;
  const element = target as Element;

  // ARIA 代理选项自己公布的选中态（aria-pressed / aria-checked）与漫游焦点（tabindex）是这道题的
  // **值**和键盘焦点在组内的位置，宿主每答一次都会翻：Ashby 翻两颗按钮的 aria-pressed，Workable
  // 翻 aria-checked 并把 tabindex 在 0 / -1 之间挪（2026-09-23 实测）。当成结构变化的话，填完一道
  // 是非题整轮就被判成页面变了。只放过「翻完之后仍是扫描那一代认得的同一种代理选项」：状态属性被删、
  // 值变成不合法的东西、换了种类，照旧相关。
  const baselineProxy = baseline.proxyOptions.get(element);
  if (
    baselineProxy !== undefined && baselineProxy !== null &&
    (attributeName === ariaProxyStateAttribute(baselineProxy) || attributeName === 'tabindex') &&
    ariaProxyKind(element) === baselineProxy
  ) return false;

  const wasScannableControl = baseline.controls.some((control) => control.element === element) ||
    baseline.semanticFields?.some((field) => field.element === element) === true;

  // `aria-hidden` and `tabindex` decide whether a control is a sentinel. Flipping either
  // side of that boundary adds or removes a field, so it is relevant whatever the rules
  // below say; a sentinel that stays a sentinel may churn (value, required, …) freely.
  if (isScannableControl(element) && SENTINEL_MEMBERSHIP_ATTRIBUTES.has(attributeName)) {
    if (isAssistiveHiddenControl(element) === wasScannableControl) return true;
  }
  if (isAssistiveHiddenControl(element)) return false;

  if (
    TRANSIENT_COMBOBOX_ATTRIBUTES.has(attributeName) &&
    (element.matches('[role="option"], [role="listbox"], [role="combobox"]') ||
      element.closest('[role="option"], [role="listbox"]') !== null)
  ) return false;

  // A remote selector can stop or start matching because of class/id/data-*.
  // Remembering the baseline matches catches the "stopped matching" half;
  // testing the live target catches the "started matching" half.
  if (
    baseline.structuralElements.has(element) ||
    (metadata.semanticSelectors.length > 0 &&
      matchesAnySelector(element, metadata.semanticSelectors))
  ) return true;

  if (wasScannableControl || isScannableControl(element)) {
    return CONTROL_MUTATION_ATTRIBUTES.includes(attributeName) ||
      attributeName.startsWith('aria-');
  }
  if (ANCESTOR_SAFETY_ATTRIBUTES.includes(
    attributeName as (typeof ANCESTOR_SAFETY_ATTRIBUTES)[number],
  )) return true;
  if (attributeName === 'for' && element.localName === 'label') return true;
  return false;
}

function mutationIsSemanticallyRelevant(
  record: MutationRecord,
  baseline: ScanRootMutationSnapshot,
  metadata: TrustedScanRootMutationMetadata,
): boolean {
  switch (record.type) {
    case 'attributes':
      return attributeIsSemanticallyRelevant(record, baseline, metadata);
    case 'characterData':
      return !isComboboxOptionChurnNode(record.target);
    case 'childList':
      return childListIsSemanticallyRelevant(record);
    default:
      return true;
  }
}

function sameSemanticFields(
  baseline: readonly SemanticFieldSnapshot[] | null,
  current: readonly SemanticFieldSnapshot[] | null,
): boolean {
  if (baseline === null || current === null) return baseline === current;
  if (baseline.length !== current.length) return false;
  return baseline.every((expected, index) => {
    const actual = current[index];
    return actual !== undefined &&
      expected.confidence === actual.confidence &&
      expected.element === actual.element &&
      expected.key === actual.key &&
      expected.kind === actual.kind &&
      expected.label === actual.label &&
      expected.required === actual.required &&
      expected.signatureCore === actual.signatureCore &&
      expected.signatureLabelHint === actual.signatureLabelHint &&
      expected.unsupportedReason === actual.unsupportedReason &&
      expected.writeMode === actual.writeMode;
  });
}

/** 封不住的那几种，各自有名字。 */
export type ScanRootSealStop =
  /** 这个 root 不是我们造的（或者已经被回收）。 */
  | 'ROOT_UNTRUSTED'
  /** 这个 root 上一代封过，而那一代已经过期——要一次新的扫描、新的 root。 */
  | 'PRIOR_GENERATION_STALE'
  /** 拍不到基线。 */
  | ScanRootSnapshotStop
  /** 拍到了，但锚点此刻指向的已经不是这个容器——页面把表单换掉了。 */
  | 'ANCHOR_MOVED';

export type ScanRootSealResult =
  | Readonly<{ ok: true; policy: ScanRootMutationPolicy }>
  | Readonly<{ ok: false; stop: ScanRootSealStop }>;

/**
 * Freezes the exact synchronous DOM generation from which the descriptor was
 * read. Calling this twice never rebaselines: once dirty, the root can only be
 * replaced by a newly authorized scan and a new ScanRoot object.
 */
export function sealScanRootMutationPolicyResult(
  root: ScanRoot,
  input?: SealScanRootMutationInput,
): ScanRootSealResult {
  const metadata = trustedScanRootMutationMetadata.get(root);
  if (!metadata) return { ok: false, stop: 'ROOT_UNTRUSTED' };
  if (metadata.sealedPolicy !== null) {
    return metadata.sealedPolicy.isExecutionCurrent()
      ? { ok: true, policy: metadata.sealedPolicy }
      : { ok: false, stop: 'PRIOR_GENERATION_STALE' };
  }

  if (input !== undefined) metadata.semanticRescan = input.rescan;
  let snapshotStop: ScanRootSnapshotStop | null = null;
  const baseline = captureScanRootMutationSnapshot(metadata, input?.fields, (stop) => {
    snapshotStop = stop;
  });
  if (!baseline) return { ok: false, stop: snapshotStop ?? 'TRAVERSAL_THREW' };
  if (!baseline.anchorMatches) return { ok: false, stop: 'ANCHOR_MOVED' };
  const observerOptions = Object.freeze({
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });

  let dirty = false;
  let exactSemanticCheckPending = metadata.semanticRescan !== null;
  const topologyIsCurrent = (): boolean => {
    try {
      if (metadata.container.isConnected !== baseline.containerConnected) return false;
      if (
        metadata.ruleBinding !== null &&
        firstBoundContainer(metadata.ruleBinding) !== metadata.container
      ) return false;
      return baseline.hosts.every(
        (host, index) => metadata.openShadowRoot(host) === baseline.hostShadowRoots[index],
      );
    } catch {
      return false;
    }
  };
  const isExecutionCurrent = (): boolean => {
    if (dirty) return false;
    if (topologyIsCurrent()) return true;
    dirty = true;
    return false;
  };
  const isCurrent = (): boolean => {
    if (!isExecutionCurrent()) return false;

    // Production gives us descriptor fields plus a semantic rescan. Perform
    // that expensive exact comparison once, after the digest await. From then
    // on the synchronously installed observer owns semantic dirtiness and this
    // method is only the cheap attachShadow/anchor execution fence.
    if (exactSemanticCheckPending) {
      exactSemanticCheckPending = false;
      const current = captureScanRootMutationSnapshot(metadata, undefined, () => {});
      if (current !== null && sameScanRootMutationSnapshot(baseline, current)) return true;
      dirty = true;
      return false;
    }

    // Compatibility for read-only/kernel tests that seal without a semantic
    // adapter binding: no observer contract was supplied, so retain exact
    // snapshot checking on every call.
    if (metadata.semanticRescan === null) {
      const current = captureScanRootMutationSnapshot(metadata, undefined, () => {});
      if (current !== null && sameScanRootMutationSnapshot(baseline, current)) return true;
      dirty = true;
      return false;
    }
    return true;
  };

  const isRelevant = (records: readonly MutationRecord[]): boolean => {
    if (dirty) return true;
    try {
      if (!records.some((record) => mutationIsSemanticallyRelevant(record, baseline, metadata))) {
        return false;
      }
    } catch {
      // Unreadable selector/DOM state cannot preserve write authority.
    }
    dirty = true;
    return true;
  };

  const policy: ScanRootMutationPolicy = Object.freeze({
    targets: baseline.targets,
    observerOptions,
    isCurrent,
    // Existing-host attachShadow has no MutationRecord. This narrow O(nodes)
    // fence is cheap enough to run between writes while full parity remains a
    // scan/observer-boundary check.
    isExecutionCurrent,
    isRelevant,
  });
  metadata.sealedPolicy = policy;
  return { ok: true, policy };
}

/** 老签名原样保留：调用方只想要「封住了没有」时用它。 */
export function sealScanRootMutationPolicy(
  root: ScanRoot,
  input?: SealScanRootMutationInput,
): ScanRootMutationPolicy | null {
  const result = sealScanRootMutationPolicyResult(root, input);
  return result.ok ? result.policy : null;
}

/**
 * Returns the already-sealed policy only while its descriptor-era baseline is
 * still exact. It never queries the current DOM to create a replacement
 * baseline, closing the scan→digest→observer window.
 */
export function resolveScanRootMutationPolicy(root: ScanRoot): ScanRootMutationPolicy | null {
  const policy = trustedScanRootMutationMetadata.get(root)?.sealedPolicy ?? null;
  return policy?.isExecutionCurrent() ? policy : null;
}

/**
 * 不渲染成文字的元素——它们的 `textContent` 不是用户读到的东西，整棵子树跳过。
 *
 *  · `svg` —— `<desc>` / `<title>` 是可访问性描述，不上屏。Workable 的每个图标
 *    都是 `<svg aria-hidden><desc><p>SVGs not supported by this browser.</p></desc>…`，
 *    于是「Address」读成「Address SVGs not supported by this browser.」
 *    （2026-09-15 在 blueground / tp-link-usa-corp / usa-vein-clinics / epignosis
 *    四个 board 上只读实测，逐字相同）。
 *  · `option` / `optgroup` / `datalist` —— 下拉的**选项**不是题干。一个 `<select>`
 *    落在 `<label>` 或"恰好一个控件"的兜底作用域里，会把整张选项表当成标签。
 *  · `script` / `style` / `noscript` —— 源码不是文案。组件内联 `<style>` 很常见。
 */
const NON_RENDERED_TEXT_ELEMENTS = new Set([
  'svg', 'option', 'optgroup', 'datalist', 'script', 'style', 'noscript',
]);

/**
 * 嵌套控件的文字不是标签文字。
 *
 * 边界**刻意与 `CONTROL_SELECTOR` 一致**：kernel 自己会当成可填控件的东西，
 * 就不是这个字段的题干。`<textarea>` 的 textContent 是它的默认值、`<select>`
 * 的是整张选项表、contenteditable 里的是用户已经敲进去的内容。
 *
 * **刻意不收 `<button>` 与 `<a>`**：它们的文字常常就是用户读到的那一句
 * （Lever 的简历入口是 `<a class="postings-btn">ATTACH RESUME/CV</a>`），
 * 裁掉它等于把真标签裁没。两边的代价不对称——宁可多留一句可见的，
 * 不可少留一句必填题的题干。
 */
const NESTED_CONTROL_ELEMENTS = new Set(['input', 'select', 'textarea']);

/**
 * 宿主**用属性明说**这段不给人看。三条都不需要 `getComputedStyle`：
 * inline `style` 里的 `display:none` / `visibility:hidden`、HTML 的 `hidden`
 * 属性、以及 `aria-hidden="true"`（"不进可访问性树" = 不是这个字段的名字）。
 *
 * `aria-hidden` 只认字面 `"true"`：`"false"` 与缺省都是可见。
 */
function attributeHidesText(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') return true;
  return inlineStyleHidesText(element);
}

/**
 * 只看 inline `style` 里的 `display` 与 `visibility`。
 *
 * 分号切分对这两条属性是安全的：CSS 值里带分号的只有 `url()` 与 content 字符串，
 * 而它们不可能是 display/visibility 的值。读不懂的声明一律当成"没藏"。
 */
function inlineStyleHidesText(element: Element): boolean {
  const declarations = element.getAttribute('style');
  if (!declarations) return false;
  for (const declaration of declarations.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property !== 'display' && property !== 'visibility') continue;
    const value = declaration.slice(colon + 1).replace(/!\s*important/i, '').trim().toLowerCase();
    if (property === 'display' ? value === 'none' : value === 'hidden' || value === 'collapse') {
      return true;
    }
  }
  return false;
}

/**
 * 一次 `textOf` 里最多向宿主问多少次计算样式。
 *
 * 剪枝（父节点已判定藏起来就整棵跳过）已经把常见形态压到十几次——Workable 的
 * 电话标签里那 240 个国家条目只花一次（`div.iti__dropdown-content` 一刀切掉）。
 * 这道预算是给病态 DOM 的兜底：超了就退回属性层判据，绝不把扫描拖成卡顿
 * （CAP-AF-065 注入性能预算：这条能力的第一主题就是竞品因卡顿被打 1 星）。
 */
const LABEL_VISIBILITY_PROBE_BUDGET = 128;

/**
 * 用户读得到的那段文字。
 *
 * `textContent` 包含一切文本节点——**包括页面上根本不渲染的那些**。三种线上形态
 * （2026-09-15 只读 DOM 实测）都是同一类缺陷：
 *   · Workable 图标的 `<svg><desc>` → 「Address SVGs not supported by this browser.」
 *   · Workable 电话 `<label>` 里整张国家区号表 → 「Phone +1United States+1United Kingdom+44…」
 *   · Lever typeahead 的 `display:none` 状态文案 →
 *     「Current location No location found. Try entering a different locationLoading」
 *
 * 自顶向下走并**剪枝**：判定为不可见的元素整棵跳过，既省掉 240 次样式查询，
 * 也保证被藏容器里的文字一个都不会漏出来。不跨 shadow 边界——`textContent`
 * 本来就不跨，这里只做减法，不新开可见面。
 *
 * ⚠️ 标签文本**参与身份平价判定**（`ControlMutationSnapshot.labelText`，扫描期与
 * 写入期逐字比较，不一致就整轮 fail closed），所以"读数随页面状态变化"这件事要
 * 想清楚。净效果是更稳，不是更不稳：被藏起来的状态文案往往正是**内容会变**的那
 * 一段——Lever 简历上传那三段在「Analyzing resume...」/「Success!」之间来回改
 * 写，改之前它们逐字进标签，widget 一动整轮就被判成页面变了。现在它们压根不参
 * 与。新增的唯一变数是"藏↔显翻转"，而那只发生在正在写的那一栏自己的部件上。
 *
 * 同一次遍历另交一份 `marked`：再加上**只因 aria-hidden** 而被裁掉、整段恰好是一个必填记号的元素
 * （2026-09-28 adobe.wd5：Workday 的题干是 `<span>Degree<abbr aria-hidden="true">*</abbr></span>`——星号
 * 看得见，只是不念给读屏，读屏从按钮的 aria-label 听到「Required」）。它只喂必填判定用的原文
 * （`LabelTexts.raw`）；显示用的标签与身份平价用的文字照旧不含它。`hidden`、行内样式或宿主计算样式
 * 藏起来的星号仍然不算——那是眼睛也看不见的。
 */
function visibleTextOf(
  element: Element,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): Readonly<{ shown: string; marked: string }> {
  const parts: string[] = [];
  const marked: string[] = [];
  let probesLeft = readVisibility ? LABEL_VISIBILITY_PROBE_BUDGET : 0;

  /** 宿主说它不渲染吗？读数失败一律按"可见"处理——异常不该让整个标签变空。 */
  const hostHides = (target: Element): boolean => {
    if (probesLeft <= 0) return false;
    probesLeft -= 1;
    try {
      const style = readVisibility!(target);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    } catch {
      return false;
    }
  };

  const collect = (node: Element): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* Text */) {
        parts.push(child.nodeValue ?? '');
        marked.push(child.nodeValue ?? '');
        continue;
      }
      if (child.nodeType !== 1 /* Element */) continue;
      const element_ = child as Element;
      const name = element_.localName;
      // 便宜的判据在前：元素名 → 属性 → 才轮到向宿主问计算样式。
      if (NON_RENDERED_TEXT_ELEMENTS.has(name) || NESTED_CONTROL_ELEMENTS.has(name)) continue;
      if (isContentEditable(element_)) continue;
      if (attributeHidesText(element_)) {
        if (isAriaHiddenRequiredMarker(element_) && !hostHides(element_)) marked.push(` ${element_.textContent ?? ''} `);
        continue;
      }
      if (hostHides(element_)) continue;
      collect(element_);
    }
  };

  // 传进来的元素本身不过滤：调用方已经判定"这就是标签"，这里只裁它**里面**
  // 用户读不到的部分。根节点也过滤的话，一个 aria-hidden 的 label 会整条消失。
  collect(element);
  return { shown: parts.join(''), marked: marked.join('') };
}

/** 只因 aria-hidden 不念给读屏、整段恰好是一个必填记号的元素（见 `visibleTextOf` 头注）。 */
function isAriaHiddenRequiredMarker(element: Element): boolean {
  return element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' &&
    !element.hasAttribute('hidden') &&
    !inlineStyleHidesText(element) &&
    isRequiredMarkerText(element.textContent ?? '');
}

/**
 * 可见文字的第一步：去零宽字符、折叠空白。显示用标签与保留记号的原文共用它。
 *
 * 零宽字符不是文字：MUI 的 notched-outline legend 只放一个 U+200B 撑位，
 * 2026-08-23 起 Dover 的每个 label 都因此读成「U+200B」——非空、但用户看不见，
 * 既挡住了后面的级联步骤，又让审阅面板显示一个空白题干。`\s` 不含它们，
 * 所以要先剥掉再折叠空白。
 */
function collapseVisibleText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 标签文本归一化（**显示用**）。
 *
 * 去掉必填标记（`*` / `✱`）、`(required)` / `(optional)` 这类冗余后缀、
 * 尾冒号，折叠空白。**刻意不小写化**：这段文字要原样显示在面板上给用户看，
 * 匹配侧的小写化由解释器自己做。
 */
function displayLabelText(collapsed: string): string {
  return collapsed
    .replace(/[（(]\s*(required|optional|必填|选填)\s*[)）]/gi, ' ')
    .replace(/[*✱＊]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:：]$/, '')
    .trim();
}

/** 一次可见文字遍历，同时交出显示用的标签与保留必填记号的原文。 */
export interface LabelTexts {
  readonly text: string;
  readonly raw: string;
}

function labelTextsOfElement(
  element: Element | null,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): LabelTexts {
  if (element === null) return { text: '', raw: '' };
  const { shown, marked } = visibleTextOf(element, readVisibility);
  return { text: displayLabelText(collapseVisibleText(shown)), raw: collapseVisibleText(marked) };
}

function textOf(
  element: Element | null,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): string {
  return labelTextsOfElement(element, readVisibility).text;
}

/**
 * 同一套显示用归一化，给规则解释器读厂商声明的题干元素用（question scope）：
 * 题干和标签走同一条归一化，审阅面板上两种来源的文字才长得一样。
 *
 * `readVisibility` 与 `ScanRootOptions` 上的那一个是同一个：解释器把 scan 期
 * 拿到的注入原样传下来，厂商声明的题干与兜底推断的标签才共用一套可见性判据。
 */
export function labelTextOf(
  element: Element | null,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): string {
  return textOf(element, readVisibility);
}

/**
 * `labelTextOf` 的同一次遍历，外加**不剥**必填记号与括号尾注的原文（只折叠空白、去零宽字符）。
 *
 * `labelTextOf` 为了显示把 `*` / `(required)` 剥掉了，于是「这一题标没标必填」从它那里再也读不出来。
 * 必填判定（`rules/interpreter.ts`）要的正是那个记号，所以另给一个口子；裁剪规则（不渲染的元素、
 * 属性层与样式层藏起来的文字）与 `labelTextOf` 完全相同，而且只走一遍（样式探针有预算）。
 */
export function labelTextsOf(
  element: Element | null,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): LabelTexts {
  return labelTextsOfElement(element, readVisibility);
}

/** 只要原文（保留必填记号）时用它。 */
export function rawVisibleTextOf(
  element: Element,
  readVisibility?: (target: Element) => HostVisibilityStyle,
): string {
  return labelTextsOfElement(element, readVisibility).raw;
}

/** 祖先向上找标签时的深度与长度上限：越走越远的文字不再是这个字段的标签。 */
const LABEL_SCOPE_MAX_DEPTH = 6;
const LABEL_SCOPE_MAX_LENGTH = 120;

function hasControlLabels(element: Element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return ['input', 'select', 'textarea'].includes(element.localName);
}

function semanticSelectorsForRoot(
  excludeWithin: readonly string[],
  rowScopes: readonly RowScopeRule[],
): readonly string[] {
  const selectors = [...excludeWithin];
  for (const rule of rowScopes) {
    selectors.push(rule.container);
    if (rule.kind === 'contains') selectors.push(rule.row);
    if (rule.actions?.add) selectors.push(rule.actions.add);
    if (rule.actions?.save) selectors.push(rule.actions.save);
    if (rule.actions?.remove) selectors.push(rule.actions.remove);
  }
  return Object.freeze([...new Set(selectors)]);
}

/**
 * Build a read-only view constrained to one verified application container.
 *
 * `rowScopes` 是厂商声明的重复行作用域（来自 apply-rules 数据）：有它，
 * 字段身份才能按"行标识 + 行内序号"计数；没有它（缺省 []），一切控件都在
 * 根域，行为与历史一致——插入控件仍会改变后续字段身份，保守失败。
 */
export function createScanRoot(
  container: Element,
  excludeWithin: readonly string[],
  rowScopes: readonly RowScopeRule[] = [],
  options: ScanRootOptions = {},
  ruleBinding: ScanRootRuleBinding | null = null,
): ScanRoot {
  /**
   * 问不得的那一个元素，只当它没有影子根——不要因此废掉整页。
   *
   * 封存基线要对容器里**每一个元素**问一次「你有没有影子根」
   * （`captureScanRootMutationSnapshot` 里的 `hosts.map(openShadowRoot)`），
   * 而注入进来的打开器可能对某一个元素抛（宿主环境的 API 对某些节点就是会抛）。
   * 原先一抛就整段 catch 掉、快照作废、封存失败，于是**这一页扫不出表单**。
   *
   * 2026-09-18 在 Discord 那张 Greenhouse 申请页上实测：表里 1497 个元素，
   * 其中一个问不得，44 个控件因此一个都填不了，浮层只说「这一页没有表单」。
   *
   * 当成 `null` 是**保守**的那一边：我们于是不往它里面走，也就不会扫到、
   * 更不会写到那一段看不见的 DOM。而且答案是稳定的——基线与后来的比对用的是
   * 同一个包装，同一个元素两次都答 null，拓扑检查照样成立。
   *
   * 打开器整个不可用（注入方直接抛在第一次调用上）仍然 fail closed：
   * 那时字段扫描本身就走不出来，根本到不了封存这一步。
   */
  const injectedOpenShadowRoot = options.openShadowRoot ?? openShadowRootDefault;
  const openShadowRoot = (element: Element): ShadowRoot | null => {
    try {
      return injectedOpenShadowRoot(element);
    } catch {
      return null;
    }
  };
  const readVisibility = options.readVisibility;
  const mutationTargets = new Set<Node>([container]);
  const semanticSelectors = semanticSelectorsForRoot(excludeWithin, rowScopes);
  // 一次同步扫描之内的影子根索引（见 `ShadowIndex`）：拍子外为 0，索引只在拍子里建、拍子结束就扔。
  let passDepth = 0;
  let passIndex: ShadowIndex | null | undefined;
  /** 每次查询独立预算：一次扫描里的多次查询不该互相饿死。 */
  const deep = (scope: ParentNode, selector: string): Element[] => {
    if (passDepth > 0) {
      if (passIndex === undefined) passIndex = buildShadowIndex(container, openShadowRoot, mutationTargets);
      if (passIndex !== null) return queryAllIndexed(scope, selector, passIndex);
    }
    return queryAllDeep(
      scope,
      selector,
      openShadowRoot,
      { remaining: SHADOW_TRAVERSAL_NODE_BUDGET },
      mutationTargets,
    );
  };
    /**
   * 元素是否在受验证容器之内，**跨 shadow 边界**。
   *
   * 从元素向上走：`contains` 不跨影子边界，所以碰到 ShadowRoot 就跳到它的
   * host 继续。复杂度是 O(树深度)，与字段数无关。
   *
   * ⚠️ 曾经写成 `deep(container, '*').includes(element)`——每次调用遍历整棵
   * 子树，而 labelTextFor 每个字段调一次，于是扫描是 **O(字段数 × 节点数)**。
   * 实测 400 字段扫描 38ms、200 字段 10ms（翻倍→四倍，二次方）。这条能力
   * （CAP-AF-065 注入性能预算）的第一主题就是竞品因卡顿被打 1 星。
   *
   * happy-dom 对 detached 容器的 `contains` 会返回 false，所以保留
   * `element === container` 与逐级 parentNode 兜底，不依赖单次 contains。
   */
  function isWithinContainer(element: Element): boolean {
    // 便宜判据在前，兜底在后——顺序本身就是这条能力要的东西。
    if (element === container) return true;
    if (container.contains(element)) return true;

    // 跨 shadow 边界向上走：contains 不跨影子边界。O(树深度)。
    let node: Node | null = element;
    while (node) {
      if (node === container) return true;
      const parent: Node | null = node.parentNode;
      if (parent) { node = parent; continue; }
      const shadow = node as Partial<ShadowRoot>;
      node = shadow.host ?? null;
    }

    // 最后的兜底，**只有前两条都没命中才会走到**：
    // happy-dom 对 detached 容器的 contains 返回 false，其 detached 父级包装
    // 也不保持引用相等，所以向上走同样到不了 container。从受验证容器反查是
    // realm-neutral 的，但它遍历整棵子树——留着是为了正确性，靠上面两条把它
    // 挡在热路径之外。真实页面（表单已挂载）永远走不到这里。
    return deep(container, '*').includes(element);
  }

  function isExcluded(element: Element): boolean {
    if (!isWithinContainer(element)) return true;
    return excludeWithin.some((selector) => {
      const excludedAncestor = element.closest(selector);
      return excludedAncestor !== null && isWithinContainer(excludedAncestor);
    });
  }

  /**
   * 行作用域的容器。`deep()` 只找后代，而容器选择器**可以就是锚点本身**
   * （iCIMS 的 `form#profileForm` 既是锚点也是所有行的容器）——那种写法
   * 一条行规则都不会生效，且失败是完全静默的：所有行内控件回落进根域，
   * 加一行照样把后面所有字段的序号冲掉，正是这套行模型要根治的病。
   *
   * 自身在前、后代在后：与 `deep()` 的文档序一致。
   */
  function sections(selector: string): Element[] {
    const found = deep(container, selector);
    return container.matches(selector) ? [container, ...found] : found;
  }

  /**
   * `idPrefix` 行模型：行序编在控件 id 里，DOM 上没有行元素可依
   * （iCIMS：`-1_PersonProfileFields.PhoneNumber` 与 `-1_PersonProfileFields.AddressCity`
   * 同属一行）。见 contracts.ts 的 `RowScopeRule` 与 50-证据库 §F.6-f。
   *
   * 行标识是**不透明字符串**，不是序号——iCIMS 用 `-1` 表示「尚未保存的新行」。
   * 行的先后由控件在 DOM 里的**首次出现顺序**决定，与标识字面值无关：
   * 按标识排序会让 `-1`（新行）排到已有行前面，把「页面第 2 组」错认成第 1 组。
   */
  function idPrefixGroups(
    rule: Extract<RowScopeRule, { kind: 'idPrefix' }>,
    ruleIndex: number,
  ): Array<{ key: string; controls: readonly Element[] }> {
    const order: string[] = [];
    const byToken = new Map<string, Element[]>();
    sections(rule.container).forEach((section) => {
      deep(section, CONTROL_SELECTOR)
        .filter(isScannableControl)
        .forEach((control) => {
          const token = rule.idPattern.exec(control.getAttribute('id') ?? '')?.[1];
          if (token === undefined) return;
          const bucket = byToken.get(token);
          if (bucket) bucket.push(control);
          else {
            order.push(token);
            byToken.set(token, [control]);
          }
        });
    });
    return order.map((token, groupIndex) => ({
      // 与 `contains` 同一形状，下游不必知道自己面对的是哪种行模型。
      // 中段固定 0：id 前缀模型下「第几个容器」没有意义——同一容器里的所有行
      // 都靠 token 区分，容器再多也不改变行的归属。
      key: `${ROW_SCOPE_PREFIX}${ruleIndex}:0:${groupIndex}`,
      controls: byToken.get(token) ?? [],
    }));
  }

  function identityScope(element: Element): FieldIdentityScope {
    // 每次调用都活查 DOM：签名与序号一样必须反映当下的页面，不能缓存。
    const rows: Array<{ key: string; rowElement: Element }> = [];
    const idGroups: Array<{ key: string; controls: readonly Element[] }> = [];
    rowScopes.forEach((rule, ruleIndex) => {
      if (rule.kind === 'idPrefix') {
        idGroups.push(...idPrefixGroups(rule, ruleIndex));
        return;
      }
      sections(rule.container).forEach((section, sectionIndex) => {
        deep(section, rule.row).forEach((rowElement, rowIndex) => {
          // 行序是"本容器内第几行"：尾部加行不改既有行的键；在已审行之前
          // 插行会改——预览与页面已对不上，让 identity recheck 保守失败。
          rows.push({ key: `${ROW_SCOPE_PREFIX}${ruleIndex}:${sectionIndex}:${rowIndex}`, rowElement });
        });
      });
    });

    // id 前缀先判：它的归属是**精确成员**（这个控件的 id 就带着行标识），
    // 强于包含关系的推断。两种模型同时命中同一控件只可能是规则写错了，
    // 此时取更确定的那一个。
    const idOwner = idGroups.find((group) => group.controls.includes(element));
    if (idOwner) return { scopeKey: idOwner.key, controls: idOwner.controls, proxyOptions: () => [] };

    // 最内层的行拥有控件（防御行选择器意外嵌套；实测四家都没有嵌套行）。
    let owner: { key: string; rowElement: Element } | null = null;
    for (const row of rows) {
      if (!row.rowElement.contains(element)) continue;
      if (!owner || owner.rowElement.contains(row.rowElement)) owner = row;
    }
    if (owner) {
      const rowElement = owner.rowElement;
      return {
        scopeKey: owner.key,
        controls: deep(rowElement, CONTROL_SELECTOR).filter(isIdentityCountedControl),
        proxyOptions: () => deep(rowElement, ARIA_PROXY_OPTION_SELECTOR).filter(isProxyOptionNode),
      };
    }

    // 根域：既不在任何行元素内，也不带任何行标识。
    const rowElements = rows.map((row) => row.rowElement);
    const grouped = new Set(idGroups.flatMap((group) => group.controls));
    return {
      scopeKey: '',
      // Read the current controls every time; avoid intermediate arrays while
      // applying the same membership checks to that live query result.
      controls: deep(container, CONTROL_SELECTOR).filter((control) =>
        isIdentityCountedControl(control) &&
        !grouped.has(control) &&
        !rowElements.some((rowElement) => rowElement.contains(control))),
      proxyOptions: () => deep(container, ARIA_PROXY_OPTION_SELECTOR)
        .filter(isProxyOptionNode)
        .filter((proxy) => !rowElements.some((rowElement) => rowElement.contains(proxy))),
    };
  }

  const root: ScanRoot = {
    querySelectorAll(selector) {
      return deep(container, selector);
    },
    identityScope,
    labelTextFor(element, labelOptions) {
      if (!isWithinContainer(element)) return '';
      // 找到了就把同一来源保留必填记号的原文交给调用方（`LabelTextOptions.onRawText`），
      // 同一次遍历里算好，不多一次 DOM 查询。
      const found = (texts: LabelTexts): string => {
        labelOptions?.onRawText?.(texts.raw);
        return texts.text;
      };

      const id = element.getAttribute('id');
      if (id) {
        // 显式 label 的搜索面按元素所在的树**收窄**，不是放宽：
        //  · 控件在 shadow root 里 → 只搜那个 shadow root（label 必然同根）；
        //  · 其余一律仍搜 container，与接 shadow 之前逐字相同。
        // 曾经是 deep(container,'label')，每个字段遍历一次整棵子树 —— 那正是
        // 扫描退化成 O(字段数 × 节点数) 的一半原因（CAP-AF-065）。
        // 绝不放宽到 getRootNode()：脱离 document 的表单会读到页面上的同名
        // 诱饵 label（tests/apply-greenhouse-adapter「不向全局逃逸」锁死）。
        const ownRoot = element.getRootNode() as Partial<ShadowRoot> & ParentNode;
        const labelScope: ParentNode = ownRoot.host ? ownRoot : container;
        // Preserve the first matching label in current tree order, without
        // copying the complete label list for each field and identity recheck.
        let explicit: Element | null = null;
        for (const label of labelScope.querySelectorAll('label')) {
          if (label.getAttribute('for') !== id) continue;
          explicit = label;
          break;
        }
        const explicitTexts = labelTextsOfElement(explicit ?? null, readVisibility);
        if (explicitTexts.text) return found(explicitTexts);
      }

      if (hasControlLabels(element)) {
        for (const label of element.labels ?? []) {
          if (!isWithinContainer(label)) continue;
          const labelTexts = labelTextsOfElement(label, readVisibility);
          if (labelTexts.text) return found(labelTexts);
        }
      }

      const wrappingLabel = element.closest('label');
      const wrappingTexts = wrappingLabel && isWithinContainer(wrappingLabel)
        ? labelTextsOfElement(wrappingLabel, readVisibility)
        : null;
      if (wrappingTexts?.text) return found(wrappingTexts);

      // 步骤 6：aria-labelledby。排在 aria-label 之前——它指向页面上真实存在的
      // 文字节点，比一句写死的 aria-label 更具体，也更可能是用户看到的那句。
      const labelledBy = element.getAttribute('aria-labelledby')?.trim();
      if (labelledBy) {
        const parts: LabelTexts[] = [];
        for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
          // id 里带引号是病态输入，跳过而不是拼出一个坏选择器。
          if (!/^[\w.:-]+$/.test(id)) continue;
          const referenced = container.querySelector(`[id="${id}"]`);
          if (referenced && isWithinContainer(referenced)) {
            const texts = labelTextsOfElement(referenced, readVisibility);
            if (texts.text) parts.push(texts);
          }
        }
        if (parts.length > 0) {
          return found({
            text: parts.map((part) => part.text).join(' '),
            raw: parts.map((part) => part.raw).join(' '),
          });
        }
      }

      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return found({ text: aria, raw: aria });

      // 到这里为止都是宿主**声明**给这个控件的名字；往下全是推断（占位符、title、
      // 附近文字）。规则解释器用这条界线决定厂商声明的 question scope 何时发言：
      // 有声明标签的控件永远保留它，只有没声明的才让容器里的题干接手。
      if (labelOptions?.declaredOnly) return '';

      const placeholder = (element.getAttribute('placeholder') ?? '').trim();
      if (placeholder) return placeholder;

      // 步骤 7：title。
      const title = element.getAttribute('title')?.trim();
      if (title) return title;

      // 步骤 8–11 合成一条：**恰好含一个控件**的最近祖先的自身文字。
      //
      // 表格几何（左侧 td / 上方 th）、fieldset>legend、前兄弟文本、上方元素文本
      // ——这四种形态本质都是它，写成一条比写四条安全：「恰好一个控件」这个约束
      // 天然挡住了"两个控件共用一段文字、却算成其中一个的标签"那条路径，
      // 而那正是把值写进**另一栏**的失败形态。
      //
      // 两道上界：往上最多 6 层、文字最长 120 字符。走得越远越不像这个字段的
      // 标签；不设界的话一张只有一个控件的表单会把整段表单文案当成标签。
      let scope: Element | null = element.parentElement;
      for (let depth = 0; scope !== null && depth < LABEL_SCOPE_MAX_DEPTH; depth += 1) {
        if (!isWithinContainer(scope)) break;
        if (deep(scope, CONTROL_SELECTOR).filter(isScannableControl).length !== 1) break;
        const scopeTexts = labelTextsOfElement(scope, readVisibility);
        if (scopeTexts.text && scopeTexts.text.length <= LABEL_SCOPE_MAX_LENGTH) return found(scopeTexts);
        scope = scope.parentElement;
      }

      return '';
    },
    isExcluded,
  };
  Object.freeze(root);
  scanPassControls.set(root, {
    begin: () => { passDepth += 1; },
    end: () => {
      passDepth -= 1;
      if (passDepth <= 0) {
        passDepth = 0;
        passIndex = undefined;
      }
    },
  });
  trustedScanRoots.add(root);
  trustedScanRootMutationMetadata.set(root, {
    container,
    mutationTargets,
    openShadowRoot,
    root,
    ruleBinding,
    semanticSelectors,
    semanticRescan: null,
    sealedPolicy: null,
  });
  return root;
}

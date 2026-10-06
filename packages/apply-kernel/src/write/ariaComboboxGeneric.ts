import type { ApplyErrorCode, Result, ScanRoot, WriteTicket } from '../contracts';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import { collectClickFacts } from '../click/facts';
import { clickHostTarget } from '../click/primitives';
import { CONTROL_SELECTOR, isScannableControl, resolveAriaReference } from '../scanRoot';
import { dispatchComboboxDismissBlur, dispatchComboboxDismissKey } from './allowlist';
import {
  DEFAULT_WAIT_MS,
  normalize,
  settledOptions,
  sleep,
  typeIntoTrigger,
  waitFor,
  type DeferLateRecheck,
} from './listboxCombobox';

/**
 * 没有规则绑定的 ARIA 下拉（2026-09-28，通用路）。
 *
 * 公司自建的申请表上，下拉常常是一个自己画的部件：MUI 的 Autocomplete（`input[role=combobox]`，D. E. Shaw 的学校、
 * 学位）、jQuery UI 的 selectmenu（原生 `<select>` 藏起来，旁边一个 `span[role=combobox]`，Hetzner 的「Land」
 * 「Geschlecht」）。厂商路上这类部件由规则量过、声明绑定（listboxComboboxes）；通用路一条站点知识都没有，只能
 * 读 WAI-ARIA 标准本身说的那几件事。这一个写入器只做人会做的那几步，每一步都照标准认、认不出就交还本人：
 *
 *  1. 点这一栏**自己的**触发器（点击策略照旧：提交类、验证码、链接、隐藏的一律不点）；
 *  2. 找它**自己的**面板：`aria-controls` / `aria-owns` 指着的 `role=listbox`；没有引用时，只认点开之后
 *     **新出现**的、落在这一栏自己的容器里的那一个 listbox；
 *  3. 等选项稳定（同一组文字、同一个顺序静下来，`settledOptions`）；
 *  4. 只选**整条相等**的那一项（归一化：不分大小写、去掉重音、标点当空格）；两项以上相等就是有歧义，交还本人；
 *     搜索式的（`aria-autocomplete=list|both`）先打候选再看；
 *  5. 点那一项——点击策略再核一遍它在这个触发器自己的面板里（`popupOwner`），面板外的东西一下都不点；
 *  6. 等面板关上，没关就按 Escape、再不行就失焦，并且核实它关了；
 *  7. 读回两次：点完读一次（值等于点的那一项），隔一个复检窗口再读一次（值还在）。
 *
 * 一模一样的部件（同一种标签、角色、ARIA 声明、类名形状）只探一次：第一个点开找不到面板，同一轮里后面那些
 * 就不再去点、直接交还同一个原因（`GenericComboboxShapeMemo`）——一页十个同样的下拉，不该各等一遍超时。
 */

export interface GenericComboboxInput {
  /** 人点的那一个：`input[role=combobox]` 本身，或藏起来的原生下拉旁边那个触发器。 */
  readonly trigger: HTMLElement;
  /** 搜索式输入框（打候选进去问）；藏起来的原生下拉那一种没有，是 null。 */
  readonly query: HTMLInputElement | null;
  /** 被这个部件托管的值载体（藏起来的原生下拉）；找这一栏自己的容器时不把它算成另一个控件。 */
  readonly carrier?: Element;
  /** 要选的那一项的写法，按阶梯先后。 */
  readonly candidates: readonly string[];
  /** 这一栏此刻的值：输入框的 value，或原生下拉选中那一项的文字（没选是空串）。 */
  readonly readValue: () => string;
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  readonly fillEmptyOnly: boolean;
  readonly fence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  readonly deferLateRecheck?: DeferLateRecheck;
  /** 同一轮里一模一样的部件只探一次（见文件头）。 */
  readonly shapes: GenericComboboxShapeMemo;
  readonly waitMs?: number;
}

/** 部件形状 → 这一种部件在这一轮里的结构性失败（点不开、找不到面板）。 */
export type GenericComboboxShapeMemo = Map<string, ApplyErrorCode>;

export type GenericComboboxResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ApplyErrorCode };

/** 比较选项文字的口径：去掉重音、不分大小写、标点与空白都当成一个空格。 */
export function comparableOptionText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

type ExactMatch =
  | { readonly kind: 'MATCH'; readonly option: Element }
  | { readonly kind: 'AMBIGUOUS_OPTION' }
  | { readonly kind: 'NO_OPTION_MATCH' };

/** 按候选先后，只认整条相等（归一化后）的那一项；一个候选命中两项以上就是有歧义。 */
export function matchExactOption(candidates: readonly string[], options: readonly Element[]): ExactMatch {
  const texts = options.map((option) => comparableOptionText(option.textContent ?? ''));
  for (const candidate of candidates) {
    const wanted = comparableOptionText(candidate);
    if (wanted === '') continue;
    const hits = texts.flatMap((text, index) => (text === wanted ? [index] : []));
    if (hits.length === 1) return { kind: 'MATCH', option: options[hits[0]!]! };
    if (hits.length > 1) return { kind: 'AMBIGUOUS_OPTION' };
  }
  return { kind: 'NO_OPTION_MATCH' };
}

/** 这个部件的形状：同一种标签、角色、ARIA 声明、类名（数字抹掉）算一样的部件。 */
export function genericComboboxShape(trigger: Element): string {
  const classes = [...trigger.classList].map((name) => name.replace(/\d+/gu, '#')).sort().join('.');
  return [
    trigger.localName,
    trigger.getAttribute('role') ?? '',
    trigger.getAttribute('aria-autocomplete') ?? '',
    trigger.getAttribute('aria-haspopup') ?? '',
    classes,
  ].join('|');
}

/** 属性层看得出藏起来的（`hidden`、`aria-hidden="true"`、行内 display:none），自己或祖先。 */
function hiddenByAttribute(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
    if ((node as Partial<HTMLElement>).style?.display === 'none') return true;
  }
  return false;
}

function shownListboxes(doc: Document): Element[] {
  return [...doc.querySelectorAll('[role="listbox"]')].filter((listbox) => !hiddenByAttribute(listbox));
}

/** 触发器用 `aria-controls` / `aria-owns` 指着的那个 listbox（或恰好包着一个 listbox 的元素）。 */
export function ownedListboxOf(trigger: Element): Element | null {
  const ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')]
    .flatMap((value) => value?.trim().split(/\s+/u) ?? [])
    .filter(Boolean);
  for (const id of ids) {
    const referenced = resolveAriaReference(trigger, id) ?? trigger.ownerDocument.getElementById(id);
    if (referenced === null) continue;
    if (referenced.getAttribute('role') === 'listbox') return referenced;
    const inner = referenced.querySelectorAll('[role="listbox"]');
    if (inner.length === 1) return inner[0]!;
  }
  return null;
}

/**
 * 这一栏自己的容器：从触发器往上，最远到一个仍然只装着这一个作答控件的祖先（隐藏的 input、被这个部件托管的
 * 原生下拉不算）。没有 ARIA 引用的面板，只有落在这个容器里才算这一栏的。
 */
function fieldContainerOf(trigger: Element, root: ScanRoot, carrier: Element | null): Element | null {
  let container: Element | null = null;
  for (let node = trigger.parentElement; node !== null; node = node.parentElement) {
    if (root.isExcluded(node)) break;
    const controls = [...node.querySelectorAll(CONTROL_SELECTOR)].filter((control) =>
      isScannableControl(control) &&
      control !== trigger &&
      control !== carrier &&
      !(control.localName === 'input' && (control as HTMLInputElement).type === 'hidden'));
    const triggers = node.querySelectorAll('[role="combobox"]').length;
    if (controls.length > 0 || triggers > 1) break;
    container = node;
  }
  return container;
}

/**
 * 藏起来的原生下拉旁边、替它说话的那个触发器（2026-09-28 Hetzner：jQuery UI selectmenu 把 `<select>` 设成
 * display:none，紧跟着放一个 `span[role=combobox][aria-owns=…-menu]`；bootstrap-select 是紧跟着的
 * `button[role=combobox][aria-haspopup=listbox]`）。结构上的证据两条都要：
 *
 *  · 它就是这个下拉的**下一个兄弟**，或者在下一个兄弟里面；
 *  · 它声明自己是下拉：`role=combobox`，或者 `aria-haspopup=listbox`；它自己不是表单控件（输入框另有扫描），
 *    也不是会提交的按钮；
 *  · 下拉的父元素里只有这一个这样的触发器。
 *
 * 认不出就是 null：这个藏起来的下拉照旧当陷阱处理（engine 的蜜罐几何那一道）。
 */
export function selectProxyOf(select: HTMLSelectElement, root: ScanRoot): HTMLElement | null {
  const parent = select.parentElement;
  const next = select.nextElementSibling;
  if (parent === null || next === null || root.isExcluded(next)) return null;
  const isTrigger = (element: Element): element is HTMLElement => {
    const tag = element.localName;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return false;
    if (tag === 'button' && (element.getAttribute('type') ?? 'submit').toLowerCase() !== 'button') return false;
    return element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox';
  };
  const candidates = [next, ...next.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')].filter(isTrigger);
  if (candidates.length !== 1) return null;
  const inParent = [...parent.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')].filter(isTrigger);
  return inParent.length === 1 && inParent[0] === candidates[0] ? candidates[0]! : null;
}

/** 搜索式部件最多打几种写法去问（国名有英文名、别名、各国语言的写法，一种一种打会等很久）。 */
const TYPEAHEAD_MAX_QUERIES = 3;

export async function fillGenericCombobox(input: GenericComboboxInput): Promise<GenericComboboxResult> {
  const { trigger, query, root, authority, ticket, policy } = input;
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
  const shape = genericComboboxShape(trigger);
  const known = input.shapes.get(shape);
  if (known !== undefined) return { ok: false, code: known };

  const wanted = [...new Set(input.candidates.map(normalize).filter((candidate) => candidate !== ''))];
  if (wanted.length === 0) return { ok: false, code: 'NO_VALUE' };
  const current = normalize(input.readValue());
  if (current !== '') {
    if (wanted.some((candidate) => comparableOptionText(candidate) === comparableOptionText(current))) {
      return { ok: true, value: current };
    }
    if (input.fillEmptyOnly) return { ok: false, code: 'NOT_EMPTY' };
  }

  const doc = trigger.ownerDocument;
  const shownBefore = new Set(shownListboxes(doc));
  const container = fieldContainerOf(trigger, root, input.carrier ?? null);
  /** 这一栏自己的面板：ARIA 引用的那个；没有引用时，点开之后新出现、落在这一栏容器里的恰好一个。 */
  const panelNow = (): Element | null => {
    const owned = ownedListboxOf(trigger);
    if (owned !== null) return owned;
    if (container === null) return null;
    const fresh = shownListboxes(doc).filter((listbox) => !shownBefore.has(listbox) && container.contains(listbox));
    return fresh.length === 1 ? fresh[0]! : null;
  };
  const isOpen = (): boolean => {
    const panel = panelNow();
    return panel !== null && !hiddenByAttribute(panel) && trigger.getAttribute('aria-expanded') !== 'false';
  };
  const optionsNow = (): readonly Element[] => {
    const panel = panelNow();
    if (panel === null || hiddenByAttribute(panel)) return [];
    return [...panel.querySelectorAll('[role="option"]')].filter((option) => option.getAttribute('aria-disabled') !== 'true');
  };
  /** 面板里有两行以上带文字的行，却一行都没声明 role=option（一句「Type to search」不算）。 */
  const undeclaredRows = (): boolean => {
    const panel = panelNow();
    if (panel === null || hiddenByAttribute(panel) || panel.querySelector('[role="option"]') !== null) return false;
    const rows = panel.children.length === 1 ? panel.children[0]!.children : panel.children;
    return [...rows].filter((row) => normalize(row.textContent ?? '') !== '').length >= 2;
  };
  const click = (element: Element, kind: 'combobox-trigger' | 'transaction-option') => {
    const owner = kind === 'transaction-option' && ownedListboxOf(trigger) !== null ? { popupOwner: trigger } : {};
    return clickHostTarget({
      element,
      facts: collectClickFacts({ element, root, kind, planned: true, openedByTransaction: true, ...owner }),
      root,
      authority,
      ticket,
      policy,
      ...owner,
    });
  };

  const previous = query?.value ?? '';
  let typed = false;
  /** 面板是我们开的，就得由我们关上，并且核实关了。 */
  const close = async (): Promise<boolean> => {
    if (!isOpen()) return true;
    dispatchComboboxDismissKey(trigger);
    if (await waitFor(() => !isOpen(), 200)) return true;
    dispatchComboboxDismissBlur(trigger);
    return waitFor(() => !isOpen(), waitMs);
  };
  const leave = async (result: GenericComboboxResult): Promise<GenericComboboxResult> => {
    if (typed && !result.ok && query !== null) typeIntoTrigger(query, previous);
    await close();
    return result;
  };
  const structural = async (code: ApplyErrorCode): Promise<GenericComboboxResult> => {
    input.shapes.set(shape, code);
    return leave({ ok: false, code });
  };

  const opened = click(trigger, 'combobox-trigger');
  if (!opened.ok) return structural(opened.code);
  // 输入框式的下拉（`input[role=combobox]`）都能打字问；声明了 aria-autocomplete=list|both 的，点开不出面板
  // 也是正常的（要打字才出）。点开出了面板、却一项都没有（react-select v1 的「Type to search」）同样要打字问。
  const typeahead = query !== null && ['list', 'both'].includes(query.getAttribute('aria-autocomplete')?.toLowerCase() ?? '');
  const appeared = await waitFor(isOpen, typeahead ? 300 : waitMs);
  if (!appeared && !typeahead) return structural('WIDGET_TIMEOUT');

  type Judged = ExactMatch | { readonly kind: 'EMPTY' | 'TIMEOUT' };
  let match: Judged = { kind: 'EMPTY' };
  if (appeared) {
    const settled = await settledOptions(optionsNow, waitMs, { emptyIsFinal: query !== null });
    match = settled.kind === 'SETTLED' ? matchExactOption(wanted, settled.options) : settled;
  }
  // 面板里一行行都是选项、却没有一行声明 role=option（2026-09-28 D. E. Shaw 的学校、学位：react-select v1 的
  // 自定义行）：读不出哪几行是选项，这一种部件交还本人，同一轮里一模一样的不再去点。
  if (match.kind === 'EMPTY' && undeclaredRows()) return structural('OPTIONS_INCOMPLETE');
  // 搜索式：点开时没有、或没有整条相等的一项，就把候选打进去再问（从前的字在失败时放回去）。最多问前
  // TYPEAHEAD_MAX_QUERIES 种写法；打进第一种面板都没出来，就是这个部件不这样用——结构性失败，不再往下打。
  if (query !== null && (match.kind === 'EMPTY' || match.kind === 'NO_OPTION_MATCH')) {
    for (const [attempt, candidate] of wanted.slice(0, TYPEAHEAD_MAX_QUERIES).entries()) {
      const stop = input.fence();
      if (stop !== null) return leave({ ok: false, code: stop });
      typeIntoTrigger(query, candidate);
      typed = true;
      if (!(await waitFor(isOpen, waitMs))) {
        if (attempt === 0 && !appeared) return structural('WIDGET_TIMEOUT');
        continue;
      }
      const settled = await settledOptions(optionsNow, waitMs * 2, { emptyIsFinal: false });
      match = settled.kind === 'SETTLED' ? matchExactOption(wanted, settled.options) : settled;
      if (match.kind === 'EMPTY' && undeclaredRows()) return structural('OPTIONS_INCOMPLETE');
      if (match.kind === 'MATCH' || match.kind === 'AMBIGUOUS_OPTION' || match.kind === 'TIMEOUT') break;
    }
  }
  if (match.kind === 'TIMEOUT') return leave({ ok: false, code: 'WIDGET_TIMEOUT' });
  if (match.kind === 'AMBIGUOUS_OPTION') return leave({ ok: false, code: 'AMBIGUOUS_OPTION' });
  if (match.kind !== 'MATCH') return leave({ ok: false, code: 'CHOICE_NO_DATA' });

  const stop = input.fence();
  if (stop !== null) return leave({ ok: false, code: stop });
  const expected = normalize(match.option.textContent ?? '');
  const picked = click(match.option, 'transaction-option');
  if (!picked.ok) return leave(picked);
  // 点完面板该自己关上；没关就由我们关，并且核实关了。关不上就不算完成——菜单开着的页面不能接着往下填。
  if (!(await waitFor(() => !isOpen(), waitMs)) && !(await close())) return { ok: false, code: 'WIDGET_TIMEOUT' };

  // 读回两次：点完一次，隔一个复检窗口再一次。输入框式的部件选完常把输入框清空、把选中项显示在旁边
  // （react-select v1，D. E. Shaw 的学校）：输入框空着时，这一栏自己的容器里（面板之外）有一个元素整条显示
  // 这一项，也算读回——只在点选之后看，而且只看这一栏自己的容器。
  const wantedText = comparableOptionText(expected);
  const shownBeside = (): boolean => {
    if (query === null || container === null || normalize(query.value) !== '') return false;
    const panel = panelNow();
    return [...container.querySelectorAll('*')].some((element) =>
      element !== query &&
      !element.contains(query) &&
      (panel === null || !panel.contains(element)) &&
      comparableOptionText(element.textContent ?? '') === wantedText);
  };
  const holds = (): boolean => comparableOptionText(input.readValue()) === wantedText || shownBeside();
  if (!(await waitFor(holds, waitMs))) return leave({ ok: false, code: 'WRITE_REVERTED' });
  if (input.deferLateRecheck !== undefined) {
    input.deferLateRecheck(holds);
    return { ok: true, value: expected };
  }
  await sleep(input.lateRecheckMs);
  if (!holds()) return leave({ ok: false, code: 'LATE_REVERTED' });
  return { ok: true, value: expected };
}

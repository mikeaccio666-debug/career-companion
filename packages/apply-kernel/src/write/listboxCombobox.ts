import type {
  ApplyErrorCode,
  ListboxComboboxBinding,
  Result,
  ScanRoot,
  WriteTicket,
} from '../contracts';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import { collectClickFacts, type DeclaredPopup } from '../click/facts';
import { clickHostTarget } from '../click/primitives';
import { CALLING_CODE_SUFFIX, INITIAL_OPTION_SET_WATCH, observeOptionSet, resolveOptionCandidate } from '../click/optionSearch';
import { regionNames } from '../dict/regions';
import { isWholeQuestionKind, signOnBehalfAnswerFor, signOnBehalfAnswers, signOnBehalfStates, type SignOnBehalfChoiceKind } from '../dict/signOnBehalf';
import { resolveAriaReference } from '../scanRoot';
import { dispatchComboboxDismissBlur, dispatchComboboxDismissKey } from './allowlist';
import { hostDelay } from './hostSchedule';

/**
 * Fill a WAI-ARIA listbox combobox (react-select and friends) on the
 * fill-first path: open the menu with the pointer sequence the widget listens
 * for, type the candidate when the list is a typeahead, click the matching
 * option, then read the widget's own display back. Nothing here knows a vendor;
 * the two readback selectors arrive from the vendor rule as data.
 *
 * Verified live on Greenhouse job boards (2026-09-10): the menu opens on
 * mousedown, `aria-controls` names the listbox, typeahead options settle after
 * an `input` event, and the chosen text appears in the value container.
 *
 * Three more shapes measured on 2026-09-15 widened the same contract without a
 * second writer:
 *   · Rippling (ats.rippling.com): the search box **is** the display — after a
 *     pick the trigger's own `value` holds the option text, so the rule points
 *     `selectedValueSelector` at the trigger and the readback is its value; the
 *     location field never sets `role`/`aria-expanded` and only gains
 *     `aria-controls` once its list exists, so "open" is "the controlled
 *     listbox exists and `aria-expanded` is not `false`".
 *   · Ashby (jobs.ashbyhq.com): the list only opens after typing, the value is
 *     again the trigger's own, and the listbox is portaled to `<body>` — the
 *     option click therefore carries the trigger as `popupOwner` so the click
 *     policy can prove it sits in the widget's own list (`withinOwnedPopup`).
 * Whenever typing happened and no option was picked, the trigger's previous
 * value is restored: search text must never be left dangling in a box that
 * doubles as the display.
 */
export interface FillListboxComboboxInput {
  readonly trigger: HTMLInputElement;
  readonly binding: ListboxComboboxBinding;
  readonly candidates: readonly string[];
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  readonly fillEmptyOnly: boolean;
  /** Multi-value widget (rule-declared chips): every candidate is a value to select — unless `singlePick`. */
  readonly multiple?: boolean;
  /**
   * 多选部件上的**一个**答案（2026-09-24）：候选是同一个答案的几种写法，按阶梯只选一项（与单值部件同一把尺），
   * 不是逐个选上。见 contracts.ts 的 `ApplyPlanEntry.singlePick`。
   */
  readonly singlePick?: boolean;
  /** Runner-owned stop signal checked between host interactions. */
  readonly fence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  /**
   * 延时复查交给调用方统一做（2026-09-23）。给了它，值显示出来之后就返回成功，把「值还在不在」
   * 这一问交出去，由 runner 在整轮收尾时统一等一次再问；没给就照旧自己等 `lateRecheckMs` 再问。
   * 每个下拉各等 250ms，Greenhouse 一页十几个就是三四秒——实测恒定占每个下拉的一半时间。
   */
  readonly deferLateRecheck?: DeferLateRecheck;
  readonly waitMs?: number;
  /**
   * 代填的条款同意／属实声明（第二刀，2026-09-23）与六类同意（第三刀，2026-09-24）：触发器与选项的
   * 点击事实都带上它，点击策略在点下去那一刻把题面与选项各认一遍，认不回来就拒。六类同意不撞候选闭集，
   * 菜单打开后按整道题重判（见 `pickSigned`）。
   */
  readonly signOnBehalf?: SignOnBehalfChoiceKind;
}

/** 交出去的那一问：此刻页面上是否仍是我们选的那一项。只读，不写。 */
export type DeferLateRecheck = (stillHolds: () => boolean) => void;

export type FillListboxComboboxResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ApplyErrorCode };

/** How long a widget may take to open, settle or show a value (shared by the combobox writers). */
export const DEFAULT_WAIT_MS = 1_500;
/**
 * 等菜单开、等选项稳定、等菜单关、等显示值，都按这个间隔看一眼。
 *
 * 从前是 100ms：每一处等待至少耗掉一个间隔，一个下拉走下来四处等待就是三四百毫秒，
 * 与宿主多快无关（2026-09-23 实测 Greenhouse 每个下拉恒定 ~560ms，其中 250ms 是复查）。
 * 选项「稳定」的判据是墙钟静默期（OPTION_SET_QUIET_MS），不是看了几眼，所以看得勤不会
 * 放松闸门，只会更早看到结论。
 */
const SETTLE_POLL_MS = 20;
/**
 * 搜索框（aria-autocomplete=list）点下去等菜单开的宽限。很多搜索框点开不出菜单，要打字才出
 * （Ashby、Rippling 的地点框）；从前照样等满 1.5 秒才去打字——2026-09-23 实测两家地点框各白等
 * 1.5 秒。点开就出菜单的（Greenhouse react-select）20ms 内就开了，不受影响。
 */
const TYPEAHEAD_OPEN_GRACE_MS = 300;
/** Escape 之后等菜单关上的宽限；过了还开着就改用失焦去关（见 `dispatchComboboxDismissBlur`）。 */
const DISMISS_KEY_GRACE_MS = 200;
/**
 * 打字之后「搜索已经答了：没有结果」要静多久（判据见 `settledOptions` 的 `answer`）。
 *
 * 从前只能等满整个预算（3 秒）才认定没结果——2026-09-23 实测 Greenhouse 学校／专业搜不到时
 * 每一次都白等 3 秒，一页三段教育就是十几秒。判不准的情形一律退回等满预算。
 */
const EMPTY_ANSWER_QUIET_MS = 600;
/**
 * 选项在页面里、打字只在本地筛的下拉（2026-10-04 测试台，Greenhouse Point72 的工作地点题）：打字那一下就变成「No options」，
 * 之后再也不变。文字与打字前不同、不像「还在找」、一项选项都没有，并且静了这么久，也算答了「没有结果」。比
 * `EMPTY_ANSWER_QUIET_MS` 长：异步搜索在去抖的那一小段里也可能先挂一句「No options」，再换成 Loading...。
 */
const STATIC_EMPTY_QUIET_MS = 1_000;
/** 「还在找」的说法：这种字静多久都不算答了。 */
const STILL_SEARCHING = /\b(?:loading|searching|fetching)\b|加载|搜索中|请稍候/iu;

export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
/**
 * 延时复检窗口（`lateRecheckMs`）：等的是宿主自己排下的计时器，所以跟宿主走同一只钟——后台里
 * 同样被节流，见 hostSchedule.ts 文件头「刻意不换的」。
 */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 轮询间隔。页面看不见时 setTimeout(20) 会被拖成一秒一格（2026-09-23 实测），一个下拉的四五处等待
 * 就是四五秒、甚至等不满预算就判超时；`hostDelay` 在那时按墙钟一格一格地过宿主任务。看得见时仍是
 * setTimeout(20)。
 */
const pollInterval = (): Promise<boolean> => hostDelay(SETTLE_POLL_MS);

/**
 * The one element in the **verified application container** carrying this id.
 *
 * Bounded on purpose. The search surface is the scan root's own shadow-piercing
 * query — the same one that found the fields — so nothing outside the container
 * the vendor rule anchored can ever answer, and a second element with that id is
 * treated as no answer at all: two candidates prove nothing about which one a
 * trigger owns, so they prove nothing. `CSS.escape` missing = give up rather
 * than build a selector out of unescaped page text.
 */
function uniqueIdWithinRoot(root: ScanRoot, id: string): Element | null {
  const escape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  if (typeof escape !== 'function') return null;
  let matches: readonly Element[];
  try {
    matches = root.querySelectorAll(`#${escape(id)}`);
  } catch {
    return null;
  }
  const only = matches.length === 1 ? matches[0]! : null;
  return only !== null && !root.isExcluded(only) ? only : null;
}

/** Resolve the listbox an owner currently names. One instance per fill; see `createListboxLookup`. */
type ListboxLookup = (owner: Element) => Element | null;

/**
 * 首选仍是引用者自己的节点树：ARIA 的 id 引用按规范就在那棵树里解析，
 * 至今量过的每个部件也都把菜单放在同一棵树里。见 scanRoot.ts
 * `resolveAriaReference` 的头注。
 *
 * 2026-09-15 实测的 SmartRecruiters one-click City 是**第一个反例**：触发器在
 * `spl-input` 的影子根里，它 `aria-controls` 指的 `#menu-spl-form-element_10`
 * 却在外面一层 —— 包着这个宿主的 `spl-autocomplete` 的影子根里（两者都在
 * `oc-location-autocomplete` 之内）。引用在它自己那棵树里是悬空的，于是
 * 这条路径原本静默返回 null，写入器判定「菜单从没打开」，这一栏永远填不上
 * —— 而它恰好是那张表上最后一个没填上的必填项。
 *
 * 兜底**不是**「往外找到有东西为止」：它只搜受验证的申请容器，且只认唯一命中。
 * 那是一次穿透查询，而开菜单要轮询，所以每次填写自带一个 memo：同一个 id 只
 * 深查一次，之后只做 `isConnected` / id / 容器归属这三项廉价复核，元素被换掉
 * （Rippling 那种「只在显示时才存在」的列表）就重查。memo 活在一次填写之内，
 * 不是模块级状态。
 */
function createListboxLookup(root: ScanRoot): ListboxLookup {
  const resolved = new Map<string, Element>();
  return (owner) => {
    const id = owner.getAttribute('aria-controls') ?? owner.getAttribute('aria-owns');
    if (!id) return null;
    const ownTree = resolveAriaReference(owner, id);
    if (ownTree !== null) return ownTree;
    const cached = resolved.get(id);
    if (cached !== undefined) {
      if (cached.isConnected && cached.getAttribute('id') === id && !root.isExcluded(cached)) return cached;
      resolved.delete(id);
    }
    const found = uniqueIdWithinRoot(root, id);
    if (found !== null) resolved.set(id, found);
    return found;
  };
}

/**
 * The options currently offered, always read **inside the listbox this owner's
 * own `aria-controls` names** — never wider.
 *
 * `[role="option"]` is the default and covers every widget measured before
 * 2026-09-15. SmartRecruiters' one-click location list is the first that has a
 * real `[role=listbox]` and yet puts no role on the eleven rows inside it
 * (`<spl-select-option>`), so the sweep came back empty while the list was
 * plainly on screen. A rule that measured that shape may name the rows; the
 * selector still only ever runs inside the owned listbox.
 */
function optionsOf(
  owner: Element,
  listboxOf: ListboxLookup,
  optionSelector: string | undefined,
): readonly Element[] {
  const listbox = listboxOf(owner);
  if (listbox === null) return [];
  let rows: readonly Element[];
  try {
    rows = [...listbox.querySelectorAll(optionSelector ?? '[role="option"]')];
  } catch {
    // An unparseable rule selector is a broken rule, not permission to guess.
    return [];
  }
  return rows.filter((option) => option.getAttribute('aria-disabled') !== 'true');
}

/**
 * The controlled listbox exists and the owner does not say "closed". react-select
 * flips `aria-expanded` and adds `aria-controls` together; Rippling's location field
 * never carries `aria-expanded` at all and only names its list while it is shown.
 */
function isOpen(owner: Element, listboxOf: ListboxLookup): boolean {
  return listboxOf(owner) !== null && owner.getAttribute('aria-expanded') !== 'false';
}

/**
 * The control this widget is actually operated through.
 *
 * Normally the scanned input itself. When the rule declares an
 * `activationSelector`, the scanned input is only the widget's value mirror and
 * the visible control inside the same value container is what opens the menu,
 * declares the ARIA popup and owns it (Workday, 2026-09-15). Resolved from the
 * DOM at write time, never carried across from the scan.
 */
function activationTargetOf(
  trigger: HTMLInputElement,
  binding: ListboxComboboxBinding,
): Element | null {
  if (binding.activationSelector === undefined) return trigger;
  const container = trigger.closest(binding.valueContainerSelector);
  return container?.querySelector(binding.activationSelector) ?? null;
}

/** A display element reads back through its value when it is a form control, else its text. */
export function displayedText(element: Element | null): string {
  if (element === null) return '';
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return normalize(element.value);
  return normalize(element.textContent ?? '');
}

function displayElementOf(trigger: HTMLInputElement, binding: ListboxComboboxBinding): Element | null {
  return trigger.closest(binding.valueContainerSelector)?.querySelector(binding.selectedValueSelector) ?? null;
}

export function readListboxSelection(
  trigger: HTMLInputElement,
  binding: ListboxComboboxBinding,
): string {
  return displayedText(displayElementOf(trigger, binding));
}

/**
 * 显示位显示的是不是我们刚选的那一项。
 *
 * 通常是原样相等。例外是**带旗标的国家选择器**：选项写「United States +1」，选中后
 * 控件里只剩一面旗和「+1」，文字层读到的就是那一截（2026-09-21 Greenhouse job-boards
 * 实测：写入其实成功了，却因为显示对不上整条报 WRITE_REVERTED、浮层说「本项未完成」）。
 * 所以再认两种形状：选项去掉尾部区号后相等，或显示恰好是那一项的区号本身。
 * 两种都要求**来自同一项**，不做任何前缀或包含匹配。
 */
export function showsPick(displayed: string, picked: string): boolean {
  if (displayed === picked) return true;
  const withoutCode = normalize(picked.replace(CALLING_CODE_SUFFIX, ''));
  if (withoutCode !== '' && displayed === withoutCode) return true;
  const code = CALLING_CODE_SUFFIX.exec(picked)?.[0]?.trim();
  return code !== undefined && code !== '' && displayed === code;
}

/**
 * A rule-declared popup portaled out of the form (no ARIA link back to its input; Workday's prompts):
 * the popup only while its selector names exactly one element in the document, its enabled rows, and
 * the `declared` context an option click must carry so the click policy can re-prove the row.
 * Shared by the two portaled prompt writers (write/hierarchicalPrompt.ts, write/searchPrompt.ts).
 */
export function declaredPopupOf(
  trigger: Element,
  shape: { readonly popupRootSelector: string; readonly optionSelector: string },
): {
  readonly popupRoot: () => Element | null;
  readonly options: () => readonly Element[];
  readonly declared: DeclaredPopup;
} {
  const popupRoot = (): Element | null => {
    try {
      const matches = trigger.ownerDocument.querySelectorAll(shape.popupRootSelector);
      return matches.length === 1 ? matches[0]! : null;
    } catch {
      return null;
    }
  };
  const options = (): readonly Element[] => {
    const popup = popupRoot();
    if (popup === null) return [];
    try {
      return [...popup.querySelectorAll(shape.optionSelector)]
        .filter((option) => option.getAttribute('aria-disabled') !== 'true');
    } catch {
      return [];
    }
  };
  return { popupRoot, options, declared: { trigger, rootSelector: shape.popupRootSelector, optionSelector: shape.optionSelector } };
}

/** The run's write context a portaled prompt writer clicks with. */
export interface PromptClickContext {
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
}

/**
 * One click in a portaled prompt: the in-form trigger, or a row of the rule-declared popup. A row
 * carries the `declaredPopup` context into both fact collections, so the click boundary re-proves
 * it from the live DOM before the pointer sequence and again at it (click/facts.ts).
 */
export function clickPromptTarget(
  element: Element,
  kind: 'combobox-trigger' | 'transaction-option',
  write: PromptClickContext,
  declaredPopup: DeclaredPopup,
): ReturnType<typeof clickHostTarget> {
  const context = kind === 'transaction-option' ? { declaredPopup } : {};
  return clickHostTarget({
    element,
    facts: collectClickFacts({ element, root: write.root, kind, planned: true, openedByTransaction: true, ...context }),
    root: write.root,
    authority: write.authority,
    ticket: write.ticket,
    policy: write.policy,
    ...context,
  });
}

/** Type into the trigger the way a user would, without the text-field envelope that blurs it. */
export function typeIntoTrigger(trigger: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(trigger) as object,
    'value',
  )?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(trigger, text);
  trigger.dispatchEvent(
    text === ''
      ? new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null })
      : new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
  );
}

export async function waitFor(condition: () => boolean, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await pollInterval();
  }
  return true;
}

export type SettledOptions =
  | { readonly kind: 'SETTLED'; readonly options: readonly Element[] }
  /**
   * The menu showed nothing within the budget; a typeahead simply has not been asked yet.
   * `answer` is set when the widget visibly answered "no results" (the text it showed then).
   */
  | { readonly kind: 'EMPTY'; readonly answer?: string }
  /** Options kept changing until the budget ran out; nothing seen can be trusted. */
  | { readonly kind: 'TIMEOUT' };

/**
 * Options only count once the list has stopped changing: the same text/order signature
 * observed twice across the kernel's quiet window (observeOptionSet). Counting entries is
 * not enough: an equal-length replacement or a second batch of a streamed geocoder response
 * would otherwise be judged on a list that is still loading.
 */
export async function settledOptions(
  currentOptions: () => readonly Element[],
  waitMs: number,
  { emptyIsFinal, answer }: {
    readonly emptyIsFinal: boolean;
    /**
     * 打字之后问的那一句用：认出宿主已经答了「没有结果」，不必等满预算。
     *
     * 判据（2026-09-23 Greenhouse 实测后收紧）：一项选项都没有；弹层文字先变成一段与打字前不同的
     * 文字（基线——多半是「Loading...」），之后又变了一次，并且静了 `EMPTY_ANSWER_QUIET_MS`；
     * 静下来的那段文字要么与打字前不同，要么正是这个框刚答过「没结果」时的那段。
     * 为什么要「打字前」：上一句刚答完「No options」，新一句打进去的头一眼常常还是它，下一眼才换成
     * 「Loading...」——把这一下当成「答了」，慢一点的搜索就被错判成没结果（第一版就栽在这里）。
     */
    readonly answer?: {
      readonly text: () => string | null;
      /** 打字前那一刻弹层的文字（已归一化）。 */
      readonly before: string;
      /** 这个框在这一轮里答「没结果」时显示过的文字；还没有就是 null。 */
      readonly knownEmpty: string | null;
    };
  },
): Promise<SettledOptions> {
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let watch = INITIAL_OPTION_SET_WATCH;
  let sawOptions = false;
  let baseline: string | undefined;
  let baselineAt: number | null = null;
  let lastAnswer: string | undefined;
  let answerChangedAt: number | null = null;
  for (;;) {
    const options = currentOptions();
    const now = Date.now();
    const observation = observeOptionSet(watch, options.map((option) => normalize(option.textContent ?? '')), now);
    watch = observation.watch;
    if (observation.settled) return { kind: 'SETTLED', options };
    sawOptions ||= options.length > 0;
    if (options.length === 0 && emptyIsFinal) return { kind: 'EMPTY' };
    if (answer !== undefined && !sawOptions) {
      const text = normalize(answer.text() ?? '');
      if (baseline === undefined) {
        if (text !== answer.before) {
          baseline = text;
          baselineAt = now;
          lastAnswer = text;
        } else if (
          answer.knownEmpty !== null &&
          text === answer.knownEmpty &&
          !STILL_SEARCHING.test(text) &&
          now - startedAt >= STATIC_EMPTY_QUIET_MS
        ) {
          // 本地筛的下拉、上一句刚答过「没有结果」：这一句打进去，那一句话原样挂着、一秒都没换成 Loading...——它就是这一句的
          // 答案（异步搜索在去抖之后会换一次，见 STATIC_EMPTY_QUIET_MS）。
          return { kind: 'EMPTY', answer: text };
        }
      } else if (
        answerChangedAt === null &&
        baselineAt !== null &&
        text === lastAnswer &&
        text !== '' &&
        !STILL_SEARCHING.test(text) &&
        now - baselineAt >= STATIC_EMPTY_QUIET_MS
      ) {
        // 本地筛的下拉：打字那一下就答了「没有结果」，之后不再变（见 STATIC_EMPTY_QUIET_MS）。
        return { kind: 'EMPTY', answer: text };
      } else if (text !== lastAnswer) {
        lastAnswer = text;
        answerChangedAt = now;
      } else if (
        answerChangedAt !== null &&
        now - answerChangedAt >= EMPTY_ANSWER_QUIET_MS &&
        text !== '' &&
        (text !== answer.before || text === answer.knownEmpty)
      ) {
        return { kind: 'EMPTY', answer: text };
      }
    }
    if (now >= deadline) return { kind: sawOptions ? 'TIMEOUT' : 'EMPTY' };
    await pollInterval();
  }
}

export type OptionMatch =
  | { readonly kind: 'MATCH'; readonly option: Element }
  | { readonly kind: 'AMBIGUOUS_OPTION' }
  | { readonly kind: 'NO_OPTION_MATCH' };

/**
 * The shared candidate ladder first (exact, normalized, word-boundary prefix); its
 * ambiguity verdict is final. Otherwise a place-style candidate ("Seattle, WA") matches an
 * option whose leading comma segments agree in order: the city exactly, and a later
 * segment either exactly or as a known region code standing for the other side's full
 * name ("WA" → "Washington"; Rippling's geocoder answers "San Francisco, CA, USA" for
 * "San Francisco, CA, United States", so the code may sit on either side). "Seattle Hill"
 * never matches "Seattle", "AU" never matches "Austell", and several agreeing options (a
 * city under more than one state) are ambiguous: the widget's ranking is not the user's
 * authority.
 */
export function matchOption(candidates: readonly string[], options: readonly Element[]): OptionMatch {
  const texts = options.map((option) => normalize(option.textContent ?? ''));
  const resolution = resolveOptionCandidate(candidates, texts);
  if (resolution.kind === 'MATCH') return { kind: 'MATCH', option: options[resolution.optionIndex]! };
  if (resolution.kind === 'AMBIGUOUS_OPTION') return { kind: 'AMBIGUOUS_OPTION' };
  for (const candidate of candidates) {
    const wanted = segments(candidate);
    if (wanted.length === 0) continue;
    const hits = texts.flatMap((text, index) => (samePlace(wanted, segments(text)) ? [index] : []));
    if (hits.length === 1) return { kind: 'MATCH', option: options[hits[0]!]! };
    if (hits.length > 1) return { kind: 'AMBIGUOUS_OPTION' };
  }
  // 机构名最后一道：分隔符不算数。2026-09-22 在 Greenhouse 实测，档案里存的是
  // `University of Illinois at Urbana-Champaign`，而它那份名单写的是
  // `University of Illinois - Urbana-Champaign`——同一所学校、同样的词、只差一个
  // 分隔符，上面每一道都判不中，用户读到的却是「这个选项需要你来选」。
  //
  // 两步，都要求**恰好一条**：
  //  · 词序列完全相等 → 就是同一条，只是标点不同；
  //  · 名单里那条是候选的**严格前缀** → 名单只到母校、不分校区（实测
  //    `University of Washington, Bothell` 打短后只回 `University of Washington`）。
  //    母校是这份名单能表达的、唯一诚实的那一项。
  // 反方向（名单比候选更具体）不在这里开：那等于替他挑一个他没说过的校区。
  for (const candidate of candidates) {
    const wanted = institutionTokens(candidate);
    if (wanted.length === 0) continue;
    const tokenized = texts.map(institutionTokens);
    for (const accepts of [sameTokens, isTokenPrefix] as const) {
      const hits = tokenized.flatMap((tokens, index) => (accepts(tokens, wanted) ? [index] : []));
      if (hits.length === 1) return { kind: 'MATCH', option: options[hits[0]!]! };
      if (hits.length > 1) return { kind: 'AMBIGUOUS_OPTION' };
    }
  }
  return { kind: 'NO_OPTION_MATCH' };
}

/**
 * 机构名的可比词序列：把逗号、各种连字号、斜杠都当成分隔，并丢掉 `at` 与 `the`
 * 这两个只起连接作用的词。名单与档案在这三件事上分歧最多，而它们都不改变
 * 「是哪一所学校」。
 */
const institutionTokens = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .replace(/[,/‐-―-]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token !== '' && token !== 'at' && token !== 'the');

const sameTokens = (have: readonly string[], wanted: readonly string[]): boolean =>
  have.length === wanted.length && have.every((token, index) => token === wanted[index]);

/** `have` 是 `wanted` 的严格前缀：更短，且逐词相同。 */
const isTokenPrefix = (have: readonly string[], wanted: readonly string[]): boolean =>
  have.length > 0 &&
  have.length < wanted.length &&
  have.every((token, index) => token === wanted[index]);

const samePlace = (wanted: readonly string[], have: readonly string[]): boolean =>
  wanted.length <= have.length &&
  wanted.every((part, index) =>
    part === have[index] ||
    (index > 0 && (regionNames(part).has(have[index]!) || regionNames(have[index]!).has(part))));

const segments = (text: string): readonly string[] =>
  text.toLowerCase().split(',').map((part) => part.trim()).filter((part) => part !== '');

/**
 * Type the full candidate first, then just its leading segment ("Seattle" for "Seattle, WA").
 *
 * 第三段是 ` at ` 之前的部分：学校名把校区写成 `… at Urbana-Champaign`，而名单里
 * 写的是 `… - Urbana-Champaign`，整串打进去 2026-09-22 实测回的是 `No options`，
 * 打短成 `University of Illinois` 才回出那三个校区。判定那边由 `matchOption` 的
 * 词序列比较收口，所以打短只是为了让名单肯出结果，不会因此写错一条。
 */
export function typeaheadQueries(candidates: readonly string[]): readonly string[] {
  const queries = candidates.flatMap((candidate) => [
    candidate.trim(),
    candidate.split(',')[0]!.trim(),
    candidate.split(/\s+at\s+/iu)[0]!.trim(),
  ]);
  return [...new Set(queries.filter((query) => query !== ''))];
}

/** A judgement the caller may act on: a pick, a refusal, or a list that never settled. */
export const decidedMatch = (match: { readonly kind: string }): boolean =>
  match.kind === 'MATCH' || match.kind === 'AMBIGUOUS_OPTION' || match.kind === 'TIMEOUT';

export async function fillListboxCombobox(
  input: FillListboxComboboxInput,
): Promise<FillListboxComboboxResult> {
  const { trigger, binding, candidates, root, authority, ticket, policy } = input;
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
  const listboxOf = createListboxLookup(root);
  const fenced = (): FillListboxComboboxResult | null => {
    const code = input.fence();
    return code === null ? null : { ok: false, code };
  };

  // The control the pointer sequence and the ARIA popup proof both run against.
  // A rule that declares an activation target and cannot resolve it has drifted;
  // nothing measured can be trusted, so nothing is clicked.
  const owner = activationTargetOf(trigger, binding);
  if (owner === null) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const delegated = owner !== trigger;

  // WAI-ARIA editable combobox: `aria-autocomplete` marks a list-backed input, and the
  // widget must declare its popup — `aria-expanded` (react-select carries it while
  // closed) or `aria-haspopup="listbox"` (Rippling's location field has no expanded
  // state at all). A lookalike without that never earns a click; `aria-controls` only
  // appears once the menu is open, so it cannot be a precondition.
  //
  // A delegated activation target is a button, not an editable combobox, so
  // `aria-autocomplete` is meaningless on it and `aria-expanded` only appears once
  // it is open. It must declare the popup outright: `aria-haspopup="listbox"` is
  // exactly what separates a picker from a button that happens to sit next to a
  // hidden input, and the rule alone is never enough to earn a click.
  const opensAListbox = delegated
    ? owner.getAttribute('aria-haspopup') === 'listbox'
    : trigger.hasAttribute('aria-autocomplete') &&
      (trigger.hasAttribute('aria-expanded') || trigger.getAttribute('aria-haspopup') === 'listbox');
  if (!opensAListbox) return { ok: false, code: 'CAPABILITY_DISABLED' };

  // When the trigger doubles as the display (Rippling, Ashby), text in it is the current
  // selection and is judged below; otherwise text sitting in the search input means the
  // user is mid-interaction. A value mirror is never typed into, so it is neither.
  const displayIsTrigger = displayElementOf(trigger, binding) === trigger;
  if (!delegated && !displayIsTrigger && trigger.value.trim() !== '') return { ok: false, code: 'NOT_EMPTY' };

  // A rule-declared row carries no `role=option`, so the click boundary's
  // option-shape test cannot recognise it. `declaredSuggestion` is the existing
  // way to say "this shape came from a measured rule": the boundary re-derives
  // `ruleDeclaredOption` from the live DOM — the target must sit inside this
  // owner's own listbox **and** match the declared selector — instead of taking
  // our word for it. Nothing else about the boundary is relaxed.
  const declaredRow = (element: Element) => {
    if (binding.optionSelector === undefined) return {};
    const listbox = listboxOf(owner);
    return listbox === null || !listbox.contains(element)
      ? {}
      : { declaredSuggestion: { container: listbox, selector: binding.optionSelector } };
  };

  const click = (element: Element, kind: 'combobox-trigger' | 'transaction-option') =>
    clickHostTarget({
      element,
      facts: collectClickFacts({
        element,
        root,
        kind,
        planned: true,
        openedByTransaction: true,
        ...(kind === 'transaction-option' ? { popupOwner: owner, ...declaredRow(element) } : {}),
        ...(input.signOnBehalf === undefined ? {} : { signOnBehalf: input.signOnBehalf }),
      }),
      root,
      authority,
      ticket,
      policy,
      // The same two context values must reach `clickHostTarget` itself: it
      // re-collects the facts before the pointer sequence, and a context it was
      // not given re-derives as `undefined` — the row would pass the first
      // check and be denied by the recheck.
      ...(kind === 'transaction-option' ? { popupOwner: owner, ...declaredRow(element) } : {}),
    });
  const typeahead = !delegated && trigger.getAttribute('aria-autocomplete') === 'list';

  // Search text must never be left dangling in a box that may double as the display:
  // every failed exit after typing puts the trigger's previous text back.
  //
  // 同理，**菜单也是我们开的，得由我们关上**。成功路径下面那句
  // `waitFor(() => !isOpen(...))` 早就把这条纪律写明了，只是失败路径漏了：
  // 2026-09-17 批测里 14 条 resumeFile 报 TARGET_NOT_WRITABLE，全部来自这里——
  // Ashby 的列表 portal 到 body，开着的时候宿主给弹层外每个 field entry 挂
  // aria-hidden，隔壁那个完全可写的简历框就被判成没有可见触发器。
  // 顺序要紧：先把字恢复回去，再关菜单。实测恢复空字符串**不会**关掉列表
  // （aria-expanded / listbox / aria-hidden 三个数一个没变），反过来先关再写字
  // 又会把它重新问开。
  const previous = trigger.value;
  let typed = false;
  const dismiss = async (): Promise<void> => {
    if (!isOpen(owner, listboxOf)) return;
    dispatchComboboxDismissKey(owner);
    if (await waitFor(() => !isOpen(owner, listboxOf), DISMISS_KEY_GRACE_MS)) return;
    dispatchComboboxDismissBlur(owner);
    // 关不掉也不改判：这一栏本来就要如实报它自己的失败码。等一下只是为了让
    // 下一个字段在已经关上的页面上被判定，而不是抢在重渲染之前。
    await waitFor(() => !isOpen(owner, listboxOf), waitMs);
  };
  const leave = async (result: FillListboxComboboxResult): Promise<FillListboxComboboxResult> => {
    if (typed && !result.ok) typeIntoTrigger(trigger, previous);
    if (!result.ok) await dismiss();
    return result;
  };

  /**
   * Open the menu, resolve one candidate set against the settled list, click the option;
   * the menu closes on pick.
   */
  const pick = async (wanted: readonly string[]): Promise<FillListboxComboboxResult> => {
    const opened = click(owner, 'combobox-trigger');
    if (!opened.ok) return await leave(opened);

    // Every judgement is made on a settled list; a list that never settles is a failure,
    // never a guess. A typeahead's initial empty menu just means it has not been asked yet.
    // 这个框在这一轮里答「没结果」时显示过的文字（见 settledOptions 的 answer.knownEmpty）。
    let knownEmpty: string | null = null;
    const popupText = (): string => normalize(listboxOf(owner)?.textContent ?? '');
    const judge = async (budgetMs: number, emptyIsFinal: boolean, before?: string): Promise<OptionMatch | { readonly kind: 'EMPTY' | 'TIMEOUT' }> => {
      const settled = await settledOptions(() => optionsOf(owner, listboxOf, binding.optionSelector), budgetMs, {
        emptyIsFinal,
        ...(before === undefined ? {} : { answer: { text: () => listboxOf(owner)?.textContent ?? null, before, knownEmpty } }),
      });
      if (settled.kind === 'EMPTY' && settled.answer !== undefined) knownEmpty = settled.answer;
      return settled.kind === 'SETTLED' ? matchOption(wanted, settled.options) : settled;
    };
    let match: OptionMatch | { readonly kind: 'EMPTY' | 'TIMEOUT' } = { kind: 'EMPTY' };
    if (await waitFor(() => isOpen(owner, listboxOf), typeahead ? TYPEAHEAD_OPEN_GRACE_MS : waitMs)) match = await judge(waitMs, typeahead);
    else if (!typeahead) return await leave({ ok: false, code: 'WIDGET_TIMEOUT' });
    if (!decidedMatch(match) && typeahead) {
      // A typeahead may only open once asked (Ashby): type, wait for its list, judge.
      for (const query of typeaheadQueries(wanted)) {
        const stop = fenced();
        if (stop) return await leave(stop);
        const before = popupText();
        typeIntoTrigger(trigger, query);
        typed = true;
        if (!(await waitFor(() => isOpen(owner, listboxOf), waitMs))) continue;
        match = await judge(waitMs * 2, false, before);
        if (decidedMatch(match)) break;
      }
    }
    if (match.kind === 'TIMEOUT') return await leave({ ok: false, code: 'WIDGET_TIMEOUT' });
    if (match.kind === 'AMBIGUOUS_OPTION') return await leave({ ok: false, code: 'AMBIGUOUS_OPTION' });
    if (match.kind !== 'MATCH') return await leave({ ok: false, code: 'CHOICE_NO_DATA' });
    const expected = normalize(match.option.textContent ?? '');

    const stop = fenced();
    if (stop) return await leave(stop);
    const picked = click(match.option, 'transaction-option');
    if (!picked.ok) return await leave(picked);
    await waitFor(() => !isOpen(owner, listboxOf), waitMs);
    return { ok: true, value: expected };
  };

  /**
   * 以用户名义代填的六类同意（2026-09-24）：菜单打开、选项稳定之后，按**整道题**重判——此刻的题面
   * （触发器的可读名）加上此刻的全部选项，交给 `signOnBehalfChoiceAnswer`，恰好挑出这一类的一项才点。
   * 题面是同意句时点那一项肯定回答；题面只是同一类的标题（仲裁的「Agreement to Arbitrate」）时，只点
   * 本身就是这一类整句同意的那一项，其余必须是否定回答。候选闭集不用、不打字：选项的原文就是依据。
   * 点下去那一刻点击策略还要把题面与选项各认一遍（click/policy.ts）。
   */
  const pickSigned = async (kind: SignOnBehalfChoiceKind): Promise<FillListboxComboboxResult> => {
    const opened = click(owner, 'combobox-trigger');
    if (!opened.ok) return await leave(opened);
    if (!(await waitFor(() => isOpen(owner, listboxOf), waitMs))) return await leave({ ok: false, code: 'WIDGET_TIMEOUT' });
    const settled = await settledOptions(() => optionsOf(owner, listboxOf, binding.optionSelector), waitMs, { emptyIsFinal: false });
    if (settled.kind === 'TIMEOUT') return await leave({ ok: false, code: 'WIDGET_TIMEOUT' });
    if (settled.kind !== 'SETTLED') return await leave({ ok: false, code: 'MANUAL_ONLY' });
    const texts = settled.options.map((option) => normalize(option.textContent ?? ''));
    // 按类别挑（2026-09-28）：同意类按整道题重判、挑出来的必须正是这一类；能不能联系雇主按类别里写的方向挑。
    const index = signOnBehalfAnswerFor(kind, root.labelTextFor(trigger), texts);
    if (index === null) return await leave({ ok: false, code: 'MANUAL_ONLY' });
    const stop = fenced();
    if (stop) return await leave(stop);
    const picked = click(settled.options[index]!, 'transaction-option');
    if (!picked.ok) return await leave(picked);
    await waitFor(() => !isOpen(owner, listboxOf), waitMs);
    return { ok: true, value: texts[index]! };
  };
  const signedConsent = isWholeQuestionKind(input.signOnBehalf) ? input.signOnBehalf : null;

  // Multi-value widget, one answer spelled several ways (2026-09-24, Twilio's demographic multi-select):
  // the candidates are a ladder, not a list of values. A chip already showing one of the spellings is the
  // answer; any other chip means the user (or the host) answered differently, and fill-empty-only leaves it.
  // Otherwise one pick through the same ladder a single-value widget uses; the chips are the readback.
  if (input.multiple && input.singlePick === true) {
    if (!binding.multiValueContainerSelector || !binding.multiValueLabelSelector) return { ok: false, code: 'CAPABILITY_DISABLED' };
    const spellings = new Set(candidates.map(normalize).filter((value) => value !== ''));
    const chosen = () => readMultiSelection(trigger, binding);
    const before = chosen();
    const present = before.find((chip) => spellings.has(chip));
    if (present !== undefined) return { ok: true, value: present };
    if (before.length > 0 && input.fillEmptyOnly) return { ok: false, code: 'NOT_EMPTY' };
    const picked = await pick(candidates);
    if (!picked.ok) return picked;
    if (!(await waitFor(() => chosen().includes(picked.value), waitMs))) return await leave({ ok: false, code: 'WRITE_REVERTED' });
    await sleep(input.lateRecheckMs);
    return chosen().includes(picked.value)
      ? { ok: true, value: picked.value }
      : await leave({ ok: false, code: 'LATE_REVERTED' });
  }

  // Multi-value widget: every candidate is a value to select, one pick each; the chips are the readback.
  if (input.multiple) {
    if (!binding.multiValueContainerSelector || !binding.multiValueLabelSelector) return { ok: false, code: 'CAPABILITY_DISABLED' };
    const wanted = [...new Set(candidates.map(normalize).filter((value) => value !== ''))];
    const chosen = () => readMultiSelection(trigger, binding);
    const before = chosen();
    if (before.length > 0 && input.fillEmptyOnly && !wanted.every((value) => before.includes(value))) return { ok: false, code: 'NOT_EMPTY' };
    for (const value of wanted) {
      if (chosen().includes(value)) continue;
      const picked = await pick([value]);
      if (!picked.ok) return picked;
      if (!(await waitFor(() => chosen().includes(picked.value), waitMs))) return await leave({ ok: false, code: 'WRITE_REVERTED' });
    }
    await sleep(input.lateRecheckMs);
    const after = chosen();
    return wanted.every((value) => after.includes(value))
      ? { ok: true, value: after.join('\n') }
      : await leave({ ok: false, code: 'LATE_REVERTED' });
  }

  // A value mirror is the widget's own value carrier, so an empty mirror means
  // "nothing chosen" even while the display reads `Select One`. Judging the
  // placeholder as a value would report every untouched Workday picker as
  // NOT_EMPTY and never fill one (2026-09-15 live).
  const current = delegated && trigger.value.trim() === '' ? '' : readListboxSelection(trigger, binding);
  if (current !== '') {
    if (candidates.some((candidate) => normalize(candidate) === current)) return { ok: true, value: current };
    // 同意类：上一遍已经替他选上的那一句（重填循环会把同一栏再走一遍），不是「已经有别的答案」。
    if (signedConsent !== null && (signOnBehalfAnswers(signedConsent, current) || signOnBehalfStates(current, signedConsent))) {
      return { ok: true, value: current };
    }
    if (input.fillEmptyOnly) return { ok: false, code: 'NOT_EMPTY' };
  }
  const picked = signedConsent === null ? await pick(candidates) : await pickSigned(signedConsent);
  if (!picked.ok) return picked;
  // A display that lags the pick by a frame (the widget re-renders its own input) is
  // still the pick; a display that never shows it is a revert. For a mirrored widget
  // the mirror must also have taken a value: a repainted button alone is not a pick.
  const settled = () =>
    showsPick(readListboxSelection(trigger, binding), picked.value) &&
    (!delegated || trigger.value.trim() !== '');
  if (!(await waitFor(settled, waitMs))) {
    return await leave({ ok: false, code: 'WRITE_REVERTED' });
  }

  if (input.deferLateRecheck !== undefined) {
    input.deferLateRecheck(settled);
    return { ok: true, value: picked.value };
  }
  await sleep(input.lateRecheckMs);
  if (!settled()) return await leave({ ok: false, code: 'LATE_REVERTED' });
  return { ok: true, value: picked.value };
}

/** The chip labels a multi-value widget currently shows, normalized. */
export function readMultiSelection(trigger: HTMLInputElement, binding: ListboxComboboxBinding): readonly string[] {
  const container = binding.multiValueContainerSelector ? trigger.closest(binding.multiValueContainerSelector) : null;
  return [...(container?.querySelectorAll(binding.multiValueLabelSelector ?? '') ?? [])]
    .map((chip) => normalize(chip.textContent ?? ''))
    .filter((value) => value !== '');
}

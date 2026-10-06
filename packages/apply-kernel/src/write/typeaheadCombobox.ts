import type {
  ApplyErrorCode,
  ListboxComboboxBinding,
  Result,
  ScanRoot,
  WriteTicket,
} from '../contracts';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import { collectClickFacts } from '../click/facts';
import { clickHostTarget } from '../click/primitives';
import { dispatchTypeaheadSearchKey } from './allowlist';
import {
  DEFAULT_WAIT_MS,
  sleep,
  decidedMatch,
  displayedText,
  matchOption,
  normalize,
  settledOptions,
  typeaheadQueries,
  typeIntoTrigger,
  waitFor,
  type DeferLateRecheck,
  type OptionMatch,
} from './listboxCombobox';

/**
 * Fill a plain-text typeahead that has no ARIA listbox: a text input whose
 * suggestions render into a rule-declared element under the widget container,
 * and whose value only counts once a suggestion was picked. The reference case
 * is Lever's "Current location" (jobs.lever.co, measured 2026-09-15): text
 * typed without picking is discarded on blur, the pick fills a hidden
 * `selectedLocation`, and the suggestions are `.dropdown-results > .dropdown-location`.
 *
 * Everything vendor-shaped is data (`typeaheadComboboxes` in the rules JSON);
 * this writer only types, waits for a settled suggestion list, matches with the
 * same ladder the listbox writer uses, clicks inside the widget's own list, and
 * reads the display (and the optional selection witness) back. Fail closed:
 * no match → no click; any exit without a confirmed pick restores the trigger's
 * previous text so search text is never left dangling as if it were a value.
 *
 * Typing is the allow-listed `input` event plus the minimal keyboard envelope
 * (`dispatchTypeaheadSearchKey`): one bubbling, non-trusted `keydown`/`keyup`
 * pair for the last character of the query. Lever searches **only** from its
 * `keydown` handler (measured 2026-09-15: native setter + `input` gives zero
 * suggestions and zero `/searchLocations` in 3.5s; one keydown gives five in
 * 0.8s), and this is the only writer in the kernel that may send those two
 * events — a generic text field never reaches here, because the path exists
 * only for a trigger a vendor rule's `typeaheadComboboxes` names.
 */
export interface FillTypeaheadComboboxInput {
  readonly trigger: HTMLInputElement;
  readonly binding: ListboxComboboxBinding;
  readonly candidates: readonly string[];
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  readonly fillEmptyOnly: boolean;
  /** Runner-owned stop signal checked between host interactions. */
  readonly fence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  /**
   * 延时复查交给调用方统一做（2026-09-23，同 listboxCombobox）。给了它，值显示出来之后就返回成功，把「值还在不在」
   * 这一问交出去，由 runner 在整轮收尾时统一等一次再问；没给就照旧自己等 `lateRecheckMs` 再问。
   * 每个下拉各等 250ms，Greenhouse 一页十几个就是三四秒——实测恒定占每个下拉的一半时间。
   */
  readonly deferLateRecheck?: DeferLateRecheck;
  readonly waitMs?: number;
}

export type FillTypeaheadComboboxResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ApplyErrorCode };

export async function fillTypeaheadCombobox(
  input: FillTypeaheadComboboxInput,
): Promise<FillTypeaheadComboboxResult> {
  const { trigger, binding, candidates, root, authority, ticket, policy } = input;
  const shape = binding.typeahead;
  if (shape === undefined) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;

  // The rule's container, display and witness must all resolve, or the measured
  // shape has drifted and nothing here can be trusted.
  const container = trigger.closest(binding.valueContainerSelector);
  if (container === null) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const display = container.querySelector(binding.selectedValueSelector);
  if (display === null) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const witness = shape.selectionWitnessSelector === undefined ? null : container.querySelector(shape.selectionWitnessSelector);
  if (shape.selectionWitnessSelector !== undefined && witness === null) return { ok: false, code: 'CAPABILITY_DISABLED' };

  const shown = () => displayedText(display);
  const witnessed = () => witness === null || displayedText(witness) !== '';
  const suggestions = (): readonly Element[] => [...container.querySelectorAll(shape.suggestionSelector)]
    .filter((option) => option.getAttribute('aria-disabled') !== 'true');
  const fenced = (): FillTypeaheadComboboxResult | null => {
    const code = input.fence();
    return code === null ? null : { ok: false, code };
  };

  // Text already shown is either the selection we want (only when the witness agrees),
  // a prior selection we must not overwrite, or search text the user left mid-edit.
  const current = shown();
  if (current !== '') {
    if (witnessed() && candidates.some((candidate) => normalize(candidate) === current)) return { ok: true, value: current };
    if (input.fillEmptyOnly) return { ok: false, code: 'NOT_EMPTY' };
  }

  // A suggestion row has no ARIA role (Lever: plain divs); the rule's suggestion shape,
  // re-derived from the DOM at every pointer phase, is what makes it option-shaped.
  const declaredSuggestion = { container, selector: shape.suggestionSelector };
  const click = (element: Element, kind: 'combobox-trigger' | 'transaction-option') =>
    clickHostTarget({
      element,
      facts: collectClickFacts({
        element,
        root,
        kind,
        planned: true,
        openedByTransaction: true,
        ...(kind === 'transaction-option' ? { declaredSuggestion } : {}),
      }),
      root,
      authority,
      ticket,
      policy,
      ...(kind === 'transaction-option' ? { declaredSuggestion } : {}),
    });

  const previous = trigger.value;
  let typed = false;
  /**
   * 这里只把输入框里的字恢复回去，**不关**它自己开的那张建议列表。兄弟写入器
   * `listboxCombobox.ts` 的 `leave()` 曾是同一个形状，在 Ashby 上是真伤：列表
   * portal 到 body，宿主按 react-aria 的 ariaHideOutside 给弹层外每个 field entry
   * 挂 aria-hidden，**隔壁**那个完全可写的简历框于是被判成没有可见触发器
   * （2026-09-17 批测 121 个 posting 栽了 14 条）。那条路因此在 598be53 补上了
   * 「先恢复文字 → 再发 dismiss 键 → 等列表消失」。
   *
   * **这条路（Lever）量过了：没有那个连累，所以照旧不关。**
   *
   * 2026-09-17 只读实测，jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply
   * 与 jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1/apply（1440×900）：
   * 把 `hasHiddenPresentation` / `hasRenderedTriggerBox` 逐字移植进页面，对全页每个
   * input/textarea/select/button/label/li 求值，开菜单前后**逐元素** diff——
   *
   *   列表确实是开着的：`.dropdown-container` display 从 none 变 flex，/searchLocations 真发了
   *   全页 aria-hidden 0 → 0，inert 0 → 0，hidden 0 → 0
   *   palantir 189 个元素 166 可写 → 166 可写，翻转 0（空列表与 5 条列表两态各量一次）
   *   spotify 220 个元素的可写签名**逐位相同**，翻转 0
   *   简历那栏的可见触发器（包住 input 的 `<label>`）hrtb 始终 true，几何 714×20 两态不变
   *
   * 结构原因：Ashby 那份伤要「列表 portal 到 body」＋「宿主跑 ariaHideOutside」两件事
   * 叠加，而 Lever 一件都不满足——它的建议列表根本没离开自己那一栏
   * （`li.application-question > label > div.application-field` 之内，position:absolute），
   * 没有「外面」可供 hide，宿主脚本也确实没做这件事。
   *
   * 同一次实测还顺手把 c26fefd 留的那个问号结掉了：**Escape 在 Lever 上是空操作。**
   * 列表开着、输入框真实聚焦时，内核那副 dismiss 信封关不掉它（补 keyCode/which=27
   * 不行，改派到 document 也不行），**真实可信的 Escape 按键同样关不掉**（display 仍是
   * flex）；而当初担心的「有的宿主把 Escape 绑成取消整张表」在这里没有发生——表单里
   * 74 个 input/textarea/select 的值一个没变（含触发器自己），form 与 20 道题都还在。
   * 所以照抄那套修法在这里是双重无用：既没有伤要修，发出去的键也关不掉这张列表，
   * 只会在每条失败退出上白烧满 waitFor 预算，再原样报同一个码。
   *
   * 要翻案就把上面那张 diff 重跑一遍：Lever 哪天换成 portal 列表、或开始给弹层外挂
   * aria-hidden，它会当场变红。
   */
  const leave = (result: FillTypeaheadComboboxResult): FillTypeaheadComboboxResult => {
    if (typed && !result.ok) typeIntoTrigger(trigger, previous);
    return result;
  };

  // Focus the widget the way a user would (the pointer sequence it listens for), then
  // ask it with each query in turn: the full candidate first, then its leading segment.
  const opened = click(trigger, 'combobox-trigger');
  if (!opened.ok) return opened;
  let match: OptionMatch | { readonly kind: 'EMPTY' | 'TIMEOUT' } = { kind: 'EMPTY' };
  for (const query of typeaheadQueries(candidates)) {
    if (query.length < shape.minTypedChars) continue;
    const stop = fenced();
    if (stop) return leave(stop);
    typeIntoTrigger(trigger, query);
    typed = true;
    // The query is in the box; the keystroke is what makes the widget go and
    // ask for it. `at(-1)` is non-empty here — `minTypedChars >= 1` already
    // skipped every shorter query above.
    dispatchTypeaheadSearchKey(trigger, query.at(-1) ?? '');
    const settled = await settledOptions(suggestions, waitMs * 2, { emptyIsFinal: false });
    match = settled.kind === 'SETTLED' ? matchOption(candidates, settled.options) : settled;
    if (decidedMatch(match)) break;
  }
  if (match.kind === 'TIMEOUT') return leave({ ok: false, code: 'WIDGET_TIMEOUT' });
  if (match.kind === 'AMBIGUOUS_OPTION') return leave({ ok: false, code: 'AMBIGUOUS_OPTION' });
  if (match.kind !== 'MATCH') return leave({ ok: false, code: 'CHOICE_NO_DATA' });
  const expected = normalize(match.option.textContent ?? '');

  const stop = fenced();
  if (stop) return leave(stop);
  const picked = click(match.option, 'transaction-option');
  if (!picked.ok) return leave(picked);

  // The pick must show up in the display and, when the rule names one, in the witness:
  // the typed query still sitting in the box is not a selection.
  const confirmed = () => shown() === expected && witnessed();
  if (!(await waitFor(confirmed, waitMs))) return leave({ ok: false, code: 'WRITE_REVERTED' });
  if (input.deferLateRecheck !== undefined) {
    input.deferLateRecheck(confirmed);
    return { ok: true, value: expected };
  }
  await sleep(input.lateRecheckMs);
  if (!confirmed()) return leave({ ok: false, code: 'LATE_REVERTED' });
  return { ok: true, value: expected };
}

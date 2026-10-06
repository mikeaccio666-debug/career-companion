import type {
  ApplyErrorCode,
  ListboxComboboxBinding,
  Result,
  ScanRoot,
  WriteTicket,
} from '../contracts';
import type { HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import {
  DEFAULT_WAIT_MS,
  sleep,
  clickPromptTarget,
  declaredPopupOf,
  displayedText,
  matchOption,
  normalize,
  settledOptions,
  waitFor,
  type DeferLateRecheck,
  type OptionMatch,
} from './listboxCombobox';

/**
 * Fill a **portaled, tiered prompt**: a menu that is not in the form root, whose
 * rows carry no ARIA option role, and whose values sit one level down under a
 * category. The reference case is Workday's "How Did You Hear About Us?"
 * (nvidia.wd5.myworkdayjobs.com, measured live 2026-09-15).
 *
 * ## What the live widget actually does, and what each measurement forces here
 *
 * · It is **not** a typeahead. Typing "Link" — with a bare `input` event and
 *   with trusted keystrokes — leaves all six rows in place. So this writer never
 *   types: there is no query to send and no search text to have to restore.
 *
 * · The menu is portaled to `<body>` as `div[data-automation-id=
 *   "activeListContainer"][role="listbox"]`, it has **no `id`**, and the input
 *   never gains `aria-controls`/`aria-owns`. `withinOwnedPopup` can therefore
 *   prove nothing, and every option click died on `OUTSIDE_FORM` before a single
 *   event was dispatched. The rule's document-unique `popupRootSelector` is what
 *   replaces the missing ARIA link — see `withinRuleDeclaredPopup`.
 *
 * · The element that answers a pointer is the role-less
 *   `div[data-automation-id="promptOption"]` **inside** the `[role="option"]`
 *   wrapper. Measured: mousedown/mouseup/click on the wrapper — with and without
 *   `view`/`detail`/`buttons`, with and without pointer events — changes nothing;
 *   the same three events on the inner row drill in every time. So option shape
 *   comes from the rule (`ruleDeclaredOption`), exactly as it does for a Lever
 *   typeahead suggestion.
 *
 * · The first menu holds **categories**, not values: Associations /
 *   Event-Conference / Job Board / Social Media / University / Website. Clicking
 *   one replaces the list with its leaves, and "Linkedin Jobs" is under "Job
 *   Board". Hence the walk.
 *
 * · Clicking the trigger again puts the open menu back at the top level. That is
 *   the whole navigation vocabulary this writer needs: it never has to click the
 *   widget's own back chevron, so a portaled popup only ever yields two kinds of
 *   click target — the in-form trigger, and a rule-declared option.
 *
 * ## Fail closed
 *
 * No match anywhere in the walk → nothing is clicked and the field is handed
 * back (`CHOICE_NO_DATA`). An ambiguous candidate stops the whole walk, exactly
 * as it does in the listbox writer: a menu's ranking is not the user's
 * authority. Success requires the widget's own display to show the option text
 * **and** the menu to be gone — a row we clicked in a menu that is still open is
 * not a selection.
 */
export interface FillHierarchicalPromptInput {
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

export type FillHierarchicalPromptResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ApplyErrorCode };

export async function fillHierarchicalPrompt(
  input: FillHierarchicalPromptInput,
): Promise<FillHierarchicalPromptResult> {
  const { trigger, binding, candidates } = input;
  const shape = binding.hierarchicalPrompt;
  if (shape === undefined) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;

  // The rule's container must resolve, or the measured shape has drifted and
  // nothing read through it can be trusted. The display element itself is
  // resolved lazily: an empty prompt has no chosen-value node at all.
  const container = trigger.closest(binding.valueContainerSelector);
  if (container === null) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const shown = (): string => displayedText(container.querySelector(binding.selectedValueSelector));

  /** The popup this rule declares, only while it names exactly one element. */
  const { popupRoot, options, declared: declaredPopup } = declaredPopupOf(trigger, shape);
  const optionTexts = (): readonly string[] =>
    options().map((option) => normalize(option.textContent ?? ''));
  const fenced = (): FillHierarchicalPromptResult | null => {
    const code = input.fence();
    return code === null ? null : { ok: false, code };
  };

  // Text already shown is either the selection we want or a prior selection we
  // must not overwrite. Nothing can be typed into this widget, so it is never
  // half-finished search text.
  const current = shown();
  if (current !== '') {
    if (candidates.some((candidate) => normalize(candidate) === current)) {
      return { ok: true, value: current };
    }
    if (input.fillEmptyOnly) return { ok: false, code: 'NOT_EMPTY' };
  }

  const click = (element: Element, kind: 'combobox-trigger' | 'transaction-option') =>
    clickPromptTarget(element, kind, input, declaredPopup);

  /** A list is "the same list" when its rows read the same, in the same order. */
  const signature = (texts: readonly string[]): string => JSON.stringify(texts);

  /**
   * Open the menu, or return an already-open one to the top level.
   *
   * `expected` is the top-level signature the caller has already seen. The click
   * is repeated once when the menu did not come back to it: a widget that closes
   * on this click instead of resetting would otherwise leave the walk reading one
   * category's leaves as if they were the categories.
   */
  const openAtTopLevel = async (
    expected?: readonly string[],
  ): Promise<FillHierarchicalPromptResult | null> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const opened = click(trigger, 'combobox-trigger');
      if (!opened.ok) return opened;
      const settled = await settledOptions(options, waitMs * 2, { emptyIsFinal: false });
      if (settled.kind === 'TIMEOUT') return { ok: false, code: 'WIDGET_TIMEOUT' };
      if (
        settled.kind === 'SETTLED' &&
        (expected === undefined || signature(optionTexts()) === signature(expected))
      ) return null;
    }
    return { ok: false, code: 'WIDGET_TIMEOUT' };
  };

  /**
   * Click one row and say what the widget did with it: it either committed the
   * value (menu gone, display shows the row's text) or it drilled into that
   * row's children (menu still open, a different list inside it).
   */
  const clickRow = async (
    option: Element,
  ): Promise<
    | { readonly kind: 'COMMITTED'; readonly value: string }
    | { readonly kind: 'DRILLED' }
    | { readonly kind: 'FAILED'; readonly code: ApplyErrorCode }
  > => {
    const expected = normalize(option.textContent ?? '');
    const before = signature(optionTexts());
    const picked = click(option, 'transaction-option');
    if (!picked.ok) return { kind: 'FAILED', code: picked.code };
    const committed = (): boolean => popupRoot() === null && shown() === expected;
    const drilled = (): boolean => popupRoot() !== null && signature(optionTexts()) !== before;
    if (!(await waitFor(() => committed() || drilled(), waitMs))) {
      return { kind: 'FAILED', code: 'WRITE_REVERTED' };
    }
    return committed() ? { kind: 'COMMITTED', value: expected } : { kind: 'DRILLED' };
  };

  /** A committed value has to survive the late window, like every other write. */
  const confirm = async (expected: string): Promise<FillHierarchicalPromptResult> => {
    const settledValue = (): boolean => shown() === expected;
    if (!(await waitFor(settledValue, waitMs))) return { ok: false, code: 'WRITE_REVERTED' };
    if (input.deferLateRecheck !== undefined) {
      input.deferLateRecheck(settledValue);
      return { ok: true, value: expected };
    }
    await sleep(input.lateRecheckMs);
    return settledValue() ? { ok: true, value: expected } : { ok: false, code: 'LATE_REVERTED' };
  };

  /**
   * Match the rows currently shown, once they have stopped changing. `TIMEOUT`
   * means the list never settled and nothing seen can be trusted.
   */
  const matchHere = async (): Promise<OptionMatch | { readonly kind: 'EMPTY' | 'TIMEOUT' }> => {
    const settled = await settledOptions(options, waitMs * 2, { emptyIsFinal: false });
    return settled.kind === 'SETTLED' ? matchOption(candidates, settled.options) : settled;
  };

  const opened = await openAtTopLevel();
  if (opened !== null) return opened;

  // The top-level rows, captured by text: the walk re-finds each one in the live
  // menu, because every trip back to the top level rebuilds the whole list.
  const categories = optionTexts();
  if (categories.length === 0) return { ok: false, code: 'WIDGET_TIMEOUT' };

  // A candidate may name a row at this level (a flat prompt, or a category that
  // is itself an answer). Try that first; the widget tells us which it was.
  const top = matchOption(candidates, options());
  if (top.kind === 'AMBIGUOUS_OPTION') return { ok: false, code: 'AMBIGUOUS_OPTION' };
  const visited = new Set<string>();
  if (top.kind === 'MATCH') {
    const stop = fenced();
    if (stop) return stop;
    const outcome = await clickRow(top.option);
    if (outcome.kind === 'FAILED') return { ok: false, code: outcome.code };
    if (outcome.kind === 'COMMITTED') return confirm(outcome.value);
    // It was a category. Its leaves are in front of us; look there before
    // walking anywhere else, and never walk into it twice.
    visited.add(normalize(top.option.textContent ?? ''));
    const inside = await matchHere();
    if (inside.kind === 'AMBIGUOUS_OPTION') return { ok: false, code: 'AMBIGUOUS_OPTION' };
    if (inside.kind === 'MATCH') {
      const picked = await clickRow(inside.option);
      if (picked.kind === 'FAILED') return { ok: false, code: picked.code };
      if (picked.kind === 'COMMITTED') return confirm(picked.value);
      return { ok: false, code: 'CHOICE_NO_DATA' };
    }
    if (inside.kind === 'TIMEOUT') return { ok: false, code: 'WIDGET_TIMEOUT' };
  }

  // Walk the categories in order. Each trip is: back to the top level, into one
  // category, match its leaves. Bounded by the rule so one field can never spend
  // the whole run's click budget.
  let walked = 0;
  for (const category of categories) {
    if (visited.has(category) || category === '') continue;
    if (walked >= shape.maxCategories) break;
    walked += 1;
    visited.add(category);
    const stop = fenced();
    if (stop) return stop;
    const reopened = await openAtTopLevel(categories);
    if (reopened !== null) return reopened;
    const row = options().find((option) => normalize(option.textContent ?? '') === category);
    if (row === undefined) continue;
    const outcome = await clickRow(row);
    if (outcome.kind === 'FAILED') return { ok: false, code: outcome.code };
    // A top-level row that commits on its own is a value, not a category: if it
    // were the answer the level-1 match would already have taken it, so the
    // widget has just kept a value nobody asked for. `VALUE_COERCED` is the code
    // for exactly that — "the host kept a different value after settling" — and
    // the walk stops: there is no undo on the fill-first lane, and clicking on
    // would only pile a second wrong value on the first.
    if (outcome.kind === 'COMMITTED') return { ok: false, code: 'VALUE_COERCED' };
    const inside = await matchHere();
    if (inside.kind === 'AMBIGUOUS_OPTION') return { ok: false, code: 'AMBIGUOUS_OPTION' };
    if (inside.kind === 'TIMEOUT') return { ok: false, code: 'WIDGET_TIMEOUT' };
    if (inside.kind !== 'MATCH') continue;
    const picked = await clickRow(inside.option);
    if (picked.kind === 'FAILED') return { ok: false, code: picked.code };
    if (picked.kind === 'COMMITTED') return confirm(picked.value);
    return { ok: false, code: 'CHOICE_NO_DATA' };
  }
  return { ok: false, code: 'CHOICE_NO_DATA' };
}

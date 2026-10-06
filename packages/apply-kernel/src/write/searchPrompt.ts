import type {
  ApplyErrorCode,
  ListboxComboboxBinding,
  NotAddedValue,
  Result,
  ScanRoot,
  WriteTicket,
} from '../contracts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import type { ApplyPolicy } from '../policy';
import { resolveOptionCandidate } from '../click/optionSearch';
import { callingCodeOfOption } from '../dict/fieldContext';
import { dispatchComboboxDismissBlur, dispatchSearchPromptSubmitKey } from './allowlist';
import {
  clickPromptTarget,
  declaredPopupOf,
  matchOption,
  normalize,
  settledOptions,
  typeIntoTrigger,
  waitFor,
  type DeferLateRecheck,
} from './listboxCombobox';

/**
 * Fill a **search prompt**: a multiselect whose values only arrive by searching. The reference
 * case is Workday My Experience — Field of Study and "Type to Add Skills" (adobe.wd5, measured
 * 2026-09-24 on the bench with the lead's approval, own test queries only, the one value the
 * widget picked was removed on the spot).
 *
 * ## What the live widget does, and what each measurement forces here
 *
 * · Typing — native setter plus `input`, and a keydown/keyup of the last character — shows
 *   nothing: no `aria-controls`, no list. **Enter** is what searches, so this writer types the
 *   value and sends the rule-declared prompt one Enter (`dispatchSearchPromptSubmitKey`).
 * · A query with a **single** result is picked by the widget itself: the chip appears and the box
 *   empties ("Computer Science" became "Computer and Information Science"). That pick is the
 *   host's own answer to the user's value; the writer reads the new chip back and reports it.
 * · Several results appear in a list portaled to `<body>` with no `id` (`popupRootSelector`,
 *   document-unique while open); the row that answers a pointer is the rule's `optionSelector`.
 *   A row is picked only through the **same candidate ladder every other combobox uses**
 *   (`matchOption`: exact, then formatting-insensitive, then a unique word-boundary prefix) and
 *   only when exactly one row qualifies. "Python" returned fourteen rows, three of them starting
 *   with the word Python: ambiguous, so nothing is clicked and the value is the user's call.
 * · Chips are `selectedValueSelector` elements under the widget; a value already there is not
 *   searched again, and a one-value widget that already holds something is left alone.
 *
 * ## Time (2026-09-24, owner: every answer on a page within 15 s, aim for 10)
 *
 * · One widget gets `SEARCH_BUDGET_MS` for all its searches (Skills: up to 15 values). Once it is
 *   spent no new search starts, and a search still waiting is cut off at the same moment; every
 *   value not reached goes back as `ABORTED` ("this round did not get to it") in `notAdded`, and the
 *   typed query is cleared and the list closed exactly as after any other search.
 * · A list that answers with **no rows at all** (Workday writes "No Items."; that exact shape was not
 *   in the measured probe) is recognised without waiting out the whole search budget: no row, and
 *   the list's own text unchanged and non-empty for `EMPTY_QUIET_MS`. Rows always win, so a list
 *   still loading is never judged on; a loading text that sits still longer than the quiet window
 *   can only make us skip a value (reported as not added), never pick a wrong one.
 * · A widget that takes several values reports each value it did not add, with its stable reason,
 *   in `notAdded`; the dock lists them.
 *
 * ## Fail closed
 *
 * Enter is only ever sent to a search box that belongs to no `<form>`: a synthetic key cannot
 * trigger the browser's implicit submission, but a host keydown handler may treat Enter as
 * submit, and a box outside any form has nothing to submit. No match → nothing is clicked and
 * the typed query is cleared. The list is closed with the generic blur envelope at the end.
 */
export interface FillSearchPromptInput {
  readonly trigger: HTMLInputElement;
  readonly binding: ListboxComboboxBinding;
  /**
   * A widget that takes more than one value (`maxValues` > 1, Skills): values to add, one search each.
   * A one-value widget (Field of Study): spellings of one answer, and only the first is searched.
   */
  readonly candidates: readonly string[];
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  /** Runner-owned stop signal checked between host interactions. */
  readonly fence: () => ApplyErrorCode | null;
  /** The runner asks once at the end of the run whether every chip we added is still there. */
  readonly deferLateRecheck: DeferLateRecheck;
  /** Overrides `SEARCH_BUDGET_MS` (tests only; the runner never passes it). */
  readonly budgetMs?: number;
  /**
   * A phone **country calling code** picker (2026-09-28, Workday's required "Country Phone Code"): only an entry
   * carrying this code is the answer, and `candidates` are spellings of one "Country (+code)" row. See
   * `fillCallingCodePrompt`.
   */
  readonly callingCode?: string;
}

/** How long one search may take to answer, and a list to settle (measured answers came well inside it). */
const WAIT_MS = 2_500;
/** All the searches one widget may spend (the owner's 15-second page target leaves the rest of the page 7). */
export const SEARCH_BUDGET_MS = 8_000;
/** A list with no row whose text sat still this long has answered "nothing found" (as listboxCombobox's quiet window). */
const EMPTY_QUIET_MS = 600;

export type FillSearchPromptResult =
  | { readonly ok: true; readonly value: string; readonly notAdded?: readonly NotAddedValue[] }
  | { readonly ok: false; readonly code: ApplyErrorCode; readonly notAdded?: readonly NotAddedValue[] };

export async function fillSearchPrompt(input: FillSearchPromptInput): Promise<FillSearchPromptResult> {
  const { trigger, binding, candidates, authority } = input;
  const shape = binding.searchPrompt;
  const container = trigger.closest(binding.valueContainerSelector);
  if (shape === undefined || container === null || trigger.form !== null) return { ok: false, code: 'CAPABILITY_DISABLED' };
  // Typing and Enter reach the host before any click does, so the click capability is proven here first.
  const access = checkActiveCapability(authority, 'set-combobox');
  if (!access.ok) return access;
  // Text already in the box is a search the user is in the middle of, not ours to replace.
  if (normalize(trigger.value) !== '') return { ok: false, code: 'NOT_EMPTY' };
  const chips = (): string[] =>
    [...container.querySelectorAll(binding.selectedValueSelector)].map((chip) => normalize(chip.textContent ?? ''));
  if (input.callingCode !== undefined) {
    return shape.maxValues === 1 ? fillCallingCodePrompt(input, shape, chips, input.callingCode) : { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  const { popupRoot, options, declared: declaredPopup } = declaredPopupOf(trigger, shape);
  const rows = (): string => JSON.stringify(options().map((option) => option.textContent));

  // Several values: each is searched once (the planner hands over trimmed, non-empty profile values; a
  // repeated one is found already chosen). One answer: its first spelling only, so an ambiguous list
  // stays the user's call instead of being retried under another spelling (the shared ladder's rule).
  const values = shape.maxValues > 1 ? candidates : candidates.slice(0, 1);

  const deadline = Date.now() + (input.budgetMs ?? SEARCH_BUDGET_MS);
  /** A wait inside one search, never past the widget's whole budget. */
  const cap = (): number => Math.max(0, Math.min(WAIT_MS, deadline - Date.now()));
  const added: string[] = [];
  const notAdded: NotAddedValue[] = [];
  let present = 0;
  let failure: ApplyErrorCode | null = null;
  const miss = (value: string, reason: ApplyErrorCode): void => {
    notAdded.push({ value, reason });
    if (reason !== 'ABORTED') failure = reason;
  };
  for (const [index, value] of values.entries()) {
    const stop = input.fence();
    if (stop !== null) return { ok: false, code: stop };
    const before = chips();
    if (resolveOptionCandidate([value], before).kind === 'MATCH') {
      present += 1;
      continue;
    }
    // A full widget (one answer already chosen, or as many values as the rule allows) takes no more:
    // what is there is somebody's answer, never ours to add to. A spent budget starts no new search.
    const full = before.length >= shape.maxValues;
    if (full || cap() === 0) {
      for (const rest of values.slice(index)) miss(rest, full ? 'NOT_EMPTY' : 'ABORTED');
      break;
    }
    const stalePopup = popupRoot();
    const staleRows = rows();
    typeIntoTrigger(trigger, value);
    dispatchSearchPromptSubmitKey(trigger);
    // Either the widget picked its only result (a chip appears) or a list with new rows opened.
    const grew = () => chips().length > before.length;
    const answered = await waitFor(() => grew() || (popupRoot() !== null && (popupRoot() !== stalePopup || rows() !== staleRows)), cap());
    if (grew()) {
      added.push(...chips().filter((chip) => !before.includes(chip)));
      continue;
    }
    // Rows, or the list's own answer that there are none: no row, its text unchanged for a quiet moment.
    let quiet: string | null = null;
    let since = 0;
    const replied = answered && await waitFor(() => {
      if (options().length > 0) return true;
      const text = normalize(popupRoot()?.textContent ?? '');
      if (text !== quiet) {
        quiet = text;
        since = Date.now();
      }
      return text !== '' && Date.now() - since >= EMPTY_QUIET_MS;
    }, cap());
    const settled = !replied ? { kind: 'TIMEOUT' as const }
      : options().length > 0 ? await settledOptions(options, cap(), { emptyIsFinal: false }) : { kind: 'EMPTY' as const };
    const match = settled.kind === 'SETTLED' ? matchOption([value], settled.options) : settled;
    if (match.kind === 'MATCH') {
      const expected = normalize(match.option.textContent ?? '');
      const fenced = input.fence();
      if (fenced !== null) return { ok: false, code: fenced };
      const picked = clickPromptTarget(match.option, 'transaction-option', input, declaredPopup);
      if (!picked.ok) return picked;
      if (!(await waitFor(() => chips().includes(expected), WAIT_MS))) return { ok: false, code: 'WRITE_REVERTED' };
      added.push(expected);
    } else {
      miss(value, match.kind === 'AMBIGUOUS_OPTION' ? match.kind
        : match.kind !== 'TIMEOUT' ? 'NO_OPTION_MATCH'
        : cap() === 0 ? 'ABORTED' : 'WIDGET_TIMEOUT');
    }
    // Whatever is left in the box is our query, never a value.
    if (normalize(trigger.value) === normalize(value)) typeIntoTrigger(trigger, '');
  }
  if (popupRoot() !== null) dispatchComboboxDismissBlur(trigger);

  // Only a several-value widget lists its misses; one answer is the field's own result.
  const report = shape.maxValues > 1 && notAdded.length > 0 ? { notAdded } : {};
  if (added.length + present === 0) {
    // Nothing reached the widget before the budget ran out: the widget did not answer in time.
    return { ok: false, code: failure ?? (notAdded.length > 0 ? 'WIDGET_TIMEOUT' : 'NO_OPTION_MATCH'), ...report };
  }
  input.deferLateRecheck(() => added.every((chip) => chips().includes(chip)));
  return { ok: true, value: chips().join(', '), ...report };
}

/** How many spellings of one "Country (+code)" answer a calling-code picker may search, one after another. */
const CALLING_CODE_SPELLINGS = 3;

/** "United States of America (+1)" → "united states of america": the country part, compared NFKC, case- and space-insensitive. */
const countryPart = (text: string): string =>
  text.normalize('NFKC').replace(/[(（]?\s*\+\s?\d{1,4}\s*[)）]?/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * A phone **country calling code** picker (2026-09-28, adobe.wd5 — Workday's required "Country Phone Code", the same
 * selectinput widget as Field of Study; rows read "United States of America (+1)"). The engine hands over the code the
 * profile's own number declares and spellings of "<residence country> (+code)". The widget holds one answer, so:
 *
 * · A chip already carrying the code is the answer (no search); a chip with another code is somebody's answer and
 *   is left alone (`NOT_EMPTY`) — never replaced.
 * · Each spelling is searched in turn **only while the search finds nothing** (a portal that says "No Items."): the
 *   host's own spelling of a country is not ours to know ("United States" vs "United States of America"). Rows that
 *   came back end the search either way.
 * · A single result the host picks itself counts only if it carries the code; otherwise it is reported as
 *   `VALUE_COERCED` (the page now shows a code the number does not have — never reported as filled).
 * · Several rows: exactly one carrying the code is picked; several (+1 is the US, Canada and the Caribbean) are
 *   narrowed by the country spellings to exactly one, or nothing is clicked (`AMBIGUOUS_OPTION`).
 */
async function fillCallingCodePrompt(
  input: FillSearchPromptInput,
  shape: NonNullable<ListboxComboboxBinding['searchPrompt']>,
  chips: () => string[],
  code: string,
): Promise<FillSearchPromptResult> {
  const { trigger } = input;
  const coded = (text: string): boolean => callingCodeOfOption(text) === code;
  const before = chips();
  if (before.some(coded)) return { ok: true, value: before.join(', ') };
  if (before.length > 0) return { ok: false, code: 'NOT_EMPTY' };
  const { popupRoot, options, declared: declaredPopup } = declaredPopupOf(trigger, shape);
  const rows = (): string => JSON.stringify(options().map((option) => option.textContent));
  const names = new Set(input.candidates.map(countryPart).filter((name) => name !== ''));
  const deadline = Date.now() + (input.budgetMs ?? SEARCH_BUDGET_MS);
  const cap = (): number => Math.max(0, Math.min(WAIT_MS, deadline - Date.now()));
  let failure: ApplyErrorCode = 'NO_OPTION_MATCH';
  const finish = (result: FillSearchPromptResult): FillSearchPromptResult => {
    if (popupRoot() !== null) dispatchComboboxDismissBlur(trigger);
    return result;
  };
  for (const query of input.candidates.slice(0, CALLING_CODE_SPELLINGS)) {
    const stop = input.fence();
    if (stop !== null) return finish({ ok: false, code: stop });
    if (cap() === 0) {
      failure = 'WIDGET_TIMEOUT';
      break;
    }
    const stalePopup = popupRoot();
    const staleRows = rows();
    typeIntoTrigger(trigger, query);
    dispatchSearchPromptSubmitKey(trigger);
    const grew = () => chips().length > before.length;
    const answered = await waitFor(() => grew() || (popupRoot() !== null && (popupRoot() !== stalePopup || rows() !== staleRows)), cap());
    if (grew()) {
      const added = chips().filter((chip) => !before.includes(chip));
      if (!added.every(coded)) return finish({ ok: false, code: 'VALUE_COERCED' });
      input.deferLateRecheck(() => added.every((chip) => chips().includes(chip)));
      return finish({ ok: true, value: chips().join(', ') });
    }
    let quiet: string | null = null;
    let since = 0;
    const replied = answered && await waitFor(() => {
      if (options().length > 0) return true;
      const text = normalize(popupRoot()?.textContent ?? '');
      if (text !== quiet) {
        quiet = text;
        since = Date.now();
      }
      return text !== '' && Date.now() - since >= EMPTY_QUIET_MS;
    }, cap());
    const settled = !replied ? { kind: 'TIMEOUT' as const }
      : options().length > 0 ? await settledOptions(options, cap(), { emptyIsFinal: false }) : { kind: 'EMPTY' as const };
    // Whatever is left in the box is our query, never a value — cleared once the rows have been judged (never before a
    // click: the host may rebuild its list on the input event).
    const clearQuery = (): void => {
      if (normalize(trigger.value) === normalize(query)) typeIntoTrigger(trigger, '');
    };
    if (settled.kind === 'EMPTY') {
      clearQuery();
      continue;
    }
    if (settled.kind !== 'SETTLED') {
      clearQuery();
      failure = 'WIDGET_TIMEOUT';
      break;
    }
    const texts = settled.options.map((option) => normalize(option.textContent ?? ''));
    const withCode = texts.flatMap((text, index) => (coded(text) ? [index] : []));
    const named = withCode.length > 1 ? withCode.filter((index) => names.has(countryPart(texts[index]!))) : withCode;
    if (named.length !== 1) {
      clearQuery();
      failure = withCode.length > 1 ? 'AMBIGUOUS_OPTION' : 'NO_OPTION_MATCH';
      break;
    }
    const option = settled.options[named[0]!]!;
    const expected = texts[named[0]!]!;
    const fenced = input.fence();
    if (fenced !== null) {
      clearQuery();
      return finish({ ok: false, code: fenced });
    }
    const picked = clickPromptTarget(option, 'transaction-option', input, declaredPopup);
    if (!picked.ok) {
      clearQuery();
      return finish(picked);
    }
    const shown = await waitFor(() => chips().includes(expected), WAIT_MS);
    clearQuery();
    if (!shown) return finish({ ok: false, code: 'WRITE_REVERTED' });
    input.deferLateRecheck(() => chips().includes(expected));
    return finish({ ok: true, value: chips().join(', ') });
  }
  return finish({ ok: false, code: failure });
}

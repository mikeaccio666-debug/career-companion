/**
 * ATS lab combobox readers (VIBE_DIST=ats-lab only).
 *
 * Nothing vendor-specific lives here: every selector comes from the binding the
 * vendor rule produced, exactly as the writer resolves it.
 */

import type { ListboxComboboxBinding } from '@edaix/apply-kernel/contracts';

/**
 * Does this combobox already hold an answer?
 *
 * For a **tiered prompt** the scanned input is a search box, not a value
 * mirror: it reads `value=""` whether or not the widget is answered, and the
 * chosen value renders as a pill at the rule's `selectedValueSelector`. Asking
 * the input is therefore not a conservative read, it is the wrong read — and
 * the harvest's cost of being wrong is not zero, because a **flat** prompt's
 * rows are answers rather than categories, so the walk's exploratory click
 * commits one.
 *
 * 2026-09-15 live (nvidia.wd5, a posting the candidate had not started):
 * Workday prefills `formField-countryPhoneCode` with "United States of America
 * (+1)" a few seconds after load. The harvest read the search input, called the
 * widget empty, opened it and poked the first row — and the page went to
 * "Afghanistan (+93)", then "Anguilla (+1)" over later passes. The host then
 * refused My Information with `phoneNumber--phoneNumber: The number length does
 * not match valid numbers for this region`, because a US number is not an
 * Anguillan one. Nothing was wrong with the phone; the harvest had rewritten
 * the region out from under it.
 *
 * Only the prompt case moves. A listbox combobox's mirror input does carry the
 * chosen option's opaque id, so `value` is the right question there, and its
 * `selectedValueSelector` is the trigger button whose text reads "Select One"
 * when unanswered — reading that as "answered" would stop the harvest from ever
 * reaching State or Phone Device Type.
 */
export function comboboxAnswered(
  trigger: HTMLInputElement,
  binding: ListboxComboboxBinding | undefined,
): boolean {
  if (trigger.value.trim() !== '') return true;
  if (binding?.hierarchicalPrompt === undefined) return false;
  let container: Element | null = null;
  let selected: Element | null = null;
  try {
    container = trigger.closest(binding.valueContainerSelector);
    selected = container?.querySelector(binding.selectedValueSelector) ?? null;
  } catch {
    // A selector the host cannot parse proves nothing; fall back to "unanswered".
    return false;
  }
  return selected !== null && (selected.textContent ?? '').trim() !== '';
}

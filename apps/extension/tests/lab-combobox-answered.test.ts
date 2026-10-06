// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ListboxComboboxBinding } from '@edaix/apply-kernel/contracts';
import { comboboxAnswered } from '../lab/labCombobox';

/**
 * The lab's option harvest opens every **unanswered** combobox and pokes its
 * rows. On a tiered prompt whose first level turns out to be flat, that poke is
 * a selection — so "is this widget answered?" has to be asked of the place the
 * rule says the value lives, not of the scanned input.
 *
 * Measured 2026-09-15 on nvidia.wd5, a posting the candidate had not started:
 * Workday fills `formField-countryPhoneCode` with "United States of America
 * (+1)" a few seconds after load, while its search input stays `value=""`. The
 * old raw-value read called that empty, the harvest poked the first row, and
 * the page ended up on "Anguilla (+1)" — after which the host refused My
 * Information with "The number length does not match valid numbers for this
 * region" against a perfectly good US phone number.
 */
const PROMPT_BINDING: ListboxComboboxBinding = {
  valueContainerSelector: '[data-automation-id="multiSelectContainer"]',
  selectedValueSelector: '[data-automation-id="selectedItem"]',
  hierarchicalPrompt: {
    popupRootSelector: 'div[data-automation-id="activeListContainer"][role="listbox"]',
    optionSelector: '[data-automation-id="promptOption"]',
    maxCategories: 8,
  },
};

/** A listbox combobox: the mirror input really does carry the chosen option's id. */
const LISTBOX_BINDING: ListboxComboboxBinding = {
  valueContainerSelector: '[data-automation-id^="formField-"]',
  selectedValueSelector: 'button[aria-haspopup="listbox"]',
};

function promptWidget(pill: string | null): HTMLInputElement {
  document.body.innerHTML = `
    <div data-automation-id="formField-countryPhoneCode">
      <div data-automation-id="multiSelectContainer">
        <input id="phoneNumber--countryPhoneCode" data-uxi-widget-type="selectinput" value="" />
        ${pill === null ? '' : `<div role="option" data-automation-id="selectedItem">${pill}</div>`}
      </div>
    </div>`;
  return document.getElementById('phoneNumber--countryPhoneCode') as HTMLInputElement;
}

function listboxWidget(buttonText: string, mirrorValue: string): HTMLInputElement {
  document.body.innerHTML = `
    <div data-automation-id="formField-phoneType">
      <button aria-haspopup="listbox">${buttonText}</button>
      <input id="mirror" type="text" value="${mirrorValue}" />
    </div>`;
  return document.getElementById('mirror') as HTMLInputElement;
}

describe('lab combobox harvest · "is this widget already answered?"', () => {
  it('reads a tiered prompt at the rule’s selectedValueSelector, not the search input', () => {
    const trigger = promptWidget('United States of America (+1)');
    expect(trigger.value).toBe('');
    expect(comboboxAnswered(trigger, PROMPT_BINDING)).toBe(true);
  });

  it('still calls an unanswered prompt empty, so it stays harvestable', () => {
    expect(comboboxAnswered(promptWidget(null), PROMPT_BINDING)).toBe(false);
  });

  it('treats a pill of whitespace as no answer', () => {
    expect(comboboxAnswered(promptWidget('   '), PROMPT_BINDING)).toBe(false);
  });

  it('leaves listbox comboboxes on the mirror-input read: "Select One" is not an answer', () => {
    // The trigger button's text is the selectedValueSelector here; reading it as
    // a value would call every unanswered State / Phone Device Type answered and
    // the harvest would never learn their option wording.
    expect(comboboxAnswered(listboxWidget('Select One', ''), LISTBOX_BINDING)).toBe(false);
    expect(comboboxAnswered(listboxWidget('Mobile', 'c11096f4abe4104ac8c9599dfab9133e'), LISTBOX_BINDING)).toBe(true);
  });

  it('falls back to "unanswered" with no binding at all', () => {
    expect(comboboxAnswered(promptWidget('United States of America (+1)'), undefined)).toBe(false);
  });
});

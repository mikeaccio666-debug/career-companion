import { describe, expect, it } from 'vitest';
import workdayRules from '@edaix/apply-rules/workday.json';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * `promptComboboxes` is the measured shape of a portaled, tiered prompt. Like
 * every other vendor-DOM key it is pure data and the parser is the only gate:
 * nothing in the kernel may walk a menu the rule has not described, because the
 * click boundary's popup carve-out is derived from `popupRootSelector` alone.
 */
function base(): Record<string, unknown> {
  const rules = structuredClone(workdayRules) as Record<string, unknown>;
  delete rules['promptComboboxes'];
  return rules;
}

const RULE = {
  triggerSelector: 'input[data-uxi-widget-type="selectinput"]',
  containerSelector: '[data-automation-id="multiSelectContainer"]',
  selectedValueSelector: '[data-automation-id="selectedItem"]',
  popupRootSelector: 'div[data-automation-id="activeListContainer"][role="listbox"]',
  optionSelector: '[data-automation-id="promptOption"]',
};

describe('parseVendorRuleset · promptComboboxes', () => {
  it('normalizes a missing key to [] (no menu is ever walked without a measured binding)', () => {
    const parsed = parseVendorRuleset(base());
    expect(parsed.ok && parsed.value.promptComboboxes).toEqual([]);
  });

  it('accepts a complete entry and defaults maxCategories to 8', () => {
    const rules = base();
    rules['promptComboboxes'] = [RULE, { ...RULE, maxCategories: 3 }];
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok && parsed.value.promptComboboxes).toEqual([
      { ...RULE, maxCategories: 8 },
      { ...RULE, maxCategories: 3 },
    ]);
  });

  it.each([
    ['not an array', { triggerSelector: 'input' }],
    ['unknown key', [{ ...RULE, backSelector: 'span' }]],
    ['missing popup root', [{ triggerSelector: 'input', containerSelector: 'div', selectedValueSelector: 'div', optionSelector: 'div' }]],
    ['missing option selector', [{ triggerSelector: 'input', containerSelector: 'div', selectedValueSelector: 'div', popupRootSelector: 'div' }]],
    ['empty popup root', [{ ...RULE, popupRootSelector: '  ' }]],
    ['maxCategories 0', [{ ...RULE, maxCategories: 0 }]],
    ['maxCategories too large', [{ ...RULE, maxCategories: 25 }]],
    ['maxCategories fractional', [{ ...RULE, maxCategories: 2.5 }]],
    ['maxCategories as string', [{ ...RULE, maxCategories: '4' }]],
    ['non-object entry', ['input']],
  ])('rejects %s as RULES_MALFORMED', (_name, value) => {
    const rules = base();
    rules['promptComboboxes'] = value;
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  /**
   * The binding is scoped to the widget that was actually measured as tiered,
   * not to every widget that shares its shape.
   *
   * 2026-09-15, nvidia.wd5 My Information: `formField-source` ("How Did You
   * Hear About Us?") opens onto six categories and hides its answers one level
   * below them, while `formField-countryPhoneCode` — same
   * `data-uxi-widget-type="selectinput"`, same container, same portaled popup —
   * opens straight onto ~200 countries, 13 rendered at a time, filtering
   * nothing when you type. The tiered walk descends by clicking a row, and on
   * the flat one that click *is* the answer: it turned a host-prefilled
   * "United States of America (+1)" into "Afghanistan (+93)" and then
   * "Anguilla (+1)", after which the host rejected the page with
   * "The number length does not match valid numbers for this region" against a
   * perfectly good US phone number.
   *
   * A widget outside this selector keeps the ordinary combobox path, which
   * opens a menu and reads it but never clicks a row.
   */
  it('workday.json scopes the tiered walk to the one prompt measured as tiered', () => {
    const parsed = parseVendorRuleset(workdayRules);
    expect(parsed.ok && parsed.value.promptComboboxes).toEqual([{
      ...RULE,
      triggerSelector: '[data-automation-id="formField-source"] input[data-uxi-widget-type="selectinput"]',
      maxCategories: 8,
    }]);
  });
});

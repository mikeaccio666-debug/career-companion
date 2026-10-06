import { describe, expect, it } from 'vitest';
import leverRules from '@edaix/apply-rules/lever.json';
import ashbyRules from '@edaix/apply-rules/ashby.json';
import ripplingRules from '@edaix/apply-rules/rippling.json';
import { parseVendorRuleset } from '../src/rules/schema';

/** `typeaheadComboboxes` and the `data-field-path` wrapper hook are data; the parser is the only gate. */
function base(): Record<string, unknown> {
  const rules = structuredClone(leverRules) as Record<string, unknown>;
  // lever.json now ships a measured binding (see the "bundled bindings" block
  // below). The parser cases here are about the *shape*, so they start from the
  // key being absent again.
  delete rules['typeaheadComboboxes'];
  return rules;
}

const RULE = {
  triggerSelector: 'input.location-input',
  containerSelector: 'li.application-question',
  suggestionSelector: '.dropdown-results > .dropdown-location',
  selectedValueSelector: 'input.location-input',
};

describe('parseVendorRuleset · typeaheadComboboxes', () => {
  it('normalizes a missing key to [] (no typeahead is driven without a measured binding)', () => {
    const parsed = parseVendorRuleset(base());
    expect(parsed.ok && parsed.value.typeaheadComboboxes).toEqual([]);
  });

  it('accepts a complete entry, defaults minTypedChars to 1 and keeps the optional witness', () => {
    const rules = base();
    rules['typeaheadComboboxes'] = [RULE, { ...RULE, minTypedChars: 3, selectionWitnessSelector: 'input[name="selectedLocation"]' }];
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok && parsed.value.typeaheadComboboxes).toEqual([
      { ...RULE, minTypedChars: 1 },
      { ...RULE, minTypedChars: 3, selectionWitnessSelector: 'input[name="selectedLocation"]' },
    ]);
  });

  it.each([
    ['not an array', { triggerSelector: 'input' }],
    ['unknown key', [{ ...RULE, optionTextSelector: 'span' }]],
    ['missing container', [{ triggerSelector: 'input', suggestionSelector: 'li', selectedValueSelector: 'input' }]],
    ['empty selector', [{ ...RULE, suggestionSelector: ' ' }]],
    ['minTypedChars 0', [{ ...RULE, minTypedChars: 0 }]],
    ['minTypedChars too large', [{ ...RULE, minTypedChars: 17 }]],
    ['minTypedChars fractional', [{ ...RULE, minTypedChars: 1.5 }]],
    ['minTypedChars as string', [{ ...RULE, minTypedChars: '2' }]],
    ['empty witness', [{ ...RULE, selectionWitnessSelector: '' }]],
    ['non-object entry', ['input.location-input']],
  ])('rejects %s as RULES_MALFORMED', (_name, value) => {
    const rules = base();
    rules['typeaheadComboboxes'] = value;
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });
});

describe('bundled bindings measured on 2026-09-15', () => {
  // 2026-09-24：自我认同题（eeoc.*）的搜索输入也绑上——2026-09-21 起 EEO 按门户里存的答案直接写，
  // 从前刻意不绑的理由（「自我认同题保持手动」）已不成立。电话区号照旧不绑。
  it('rippling.json binds the pronouns, location and EEO search selects, never the phone-code select', () => {
    const parsed = parseVendorRuleset(ripplingRules);
    const selectors = parsed.ok ? parsed.value.listboxComboboxes.map((rule) => rule.triggerSelector) : [];
    expect(selectors).toEqual([
      '[data-testid="pronouns_strategy"] input[data-testid="input-select-search-input"]',
      '[data-testid="location"] input[aria-haspopup="listbox"]',
      '[data-testid^="eeoc."] input[data-testid="input-select-search-input"]',
    ]);
    expect(selectors.some((selector) => selector.includes('phone'))).toBe(false);
    expect(parsed.ok && parsed.value.typeaheadComboboxes).toEqual([]);
  });

  it('ashby.json binds the location autocomplete and keys it through the wrapper data-field-path as the last step', () => {
    const parsed = parseVendorRuleset(ashbyRules);
    expect(parsed.ok && parsed.value.listboxComboboxes).toEqual([
      {
        triggerSelector: 'input.ashby-application-form-input-autocomplete',
        valueContainerSelector: '.ashby-application-form-field-entry',
        selectedValueSelector: 'input.ashby-application-form-input-autocomplete',
      },
    ]);
    const steps = parsed.ok ? parsed.value.keySteps : [];
    expect(steps.at(-1)).toEqual({
      type: 'ancestorAttrMap',
      attr: 'data-field-path',
      confidence: 1,
      map: { _systemfield_location: 'location' },
    });
  });

  /**
   * 2026-09-15：location 从 `widgetNames` 移到 `typeaheadComboboxes`。
   *
   * 这条测试原先锁的是「keyboard-only 的部件不许声明 binding」——当时成立，
   * 因为 kernel 的宿主事件闭集不含键盘事件，声明只会把诚实的 WIDGET 变成必然的
   * WIDGET_TIMEOUT。闭集已在同日显式扩权（HOST_EVENTS 增加 keydown/keyup，
   * 只对本表声明过的触发器派发），前提消失，锁的对象随之变成「声明的形状要与
   * 实测的 DOM 逐字对上」。
   */
  it('lever.json declares the location typeahead measured on 2026-09-15 and no longer calls it a widget', () => {
    const parsed = parseVendorRuleset(leverRules);
    expect(parsed.ok && parsed.value.widgetNames).toEqual([]);
    expect(parsed.ok && parsed.value.typeaheadComboboxes).toEqual([
      {
        triggerSelector: 'input#location-input',
        containerSelector: 'li.application-question[data-qa="structured-contact-location-question"]',
        suggestionSelector: '.dropdown-results > div.dropdown-location',
        selectedValueSelector: 'input#location-input',
        minTypedChars: 2,
        selectionWitnessSelector: 'input#selected-location',
      },
    ]);
  });

  it('data-field-path is accepted only as a precise attribute name, not as a data-* wildcard', () => {
    const rules = base();
    (rules['keySteps'] as unknown[]).push({ type: 'ancestorAttrMap', attr: 'data-field-path', confidence: 1, map: { _systemfield_location: 'location' } });
    expect(parseVendorRuleset(rules).ok).toBe(true);
    const wildcard = base();
    (wildcard['keySteps'] as unknown[]).push({ type: 'ancestorAttrMap', attr: 'data-field-entry-id', confidence: 1, map: { x: 'location' } });
    expect(parseVendorRuleset(wildcard)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });
});

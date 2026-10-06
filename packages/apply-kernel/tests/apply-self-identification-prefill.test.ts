/**
 * EEO 自我认同：能力位打开且档案里有值时，**直接写**（2026-09-21 起），而不是
 * 「只能你自己做」，也不再是「已预填、等你放行」。
 *
 * 用户在门户里填下并保存的那一下就是同意——四道闸一道没松，过了就是一条普通的
 * 写入条目（键是档案键、值是页面上那一项的原文）；缺一道仍是 MANUAL_ONLY。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import type { ApplyFormDescriptor } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';
import { createScanRoot } from '../src/scanRoot';

function mountRadioGroup(options: readonly string[]): HTMLInputElement[] {
  document.body.innerHTML = `<form>${options.map((label, index) => `
    <label for="o${index}">${label}</label>
    <input type="radio" id="o${index}" name="eeo" value="${index}">`).join('')}</form>`;
  return [...document.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
}

function form(label: string, options: readonly string[]): ApplyFormDescriptor {
  const inputs = mountRadioGroup(options);
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice',
      element: inputs[0]!,
      key: null,
      label,
      required: true,
      confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: {
        control: 'radio',
        options: inputs.map((element, index) => ({ element, label: options[index]! })),
      },
    }],
  } as never;
}

const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Decline to self identify'];

function plan(profile: ApplyProfileDraft, capability: boolean, label = 'Gender') {
  return buildApplyPlan(form(label, GENDER_OPTIONS), profile, {
    fillEmptyOnly: false,
    ...(capability ? { capabilities: { 'set-self-identification': true } } : {}),
  } as never);
}

afterEach(() => { document.body.innerHTML = ''; });

describe('四道闸全过才写', () => {
  it('全过：进 entries，键是档案键、值是页面上那一项的原文', () => {
    const result = plan({ eeoGender: 'FEMALE' } as never, true);
    expect(result.entries[0]).toMatchObject({
      kind: 'choice',
      key: 'eeoGender',
      // 带页面上那一项的**原文**，不是档案里的枚举值：写入期 chosenOptions 用精确
      // 文本匹配，两边就不会各自再翻译一次。
      value: 'Female',
    });
    expect(result.skipped).toHaveLength(0);
  });

  it('退回 MANUAL_ONLY 时不带建议', () => {
    expect(plan({ eeoGender: 'FEMALE' } as never, false).skipped[0]?.prefill).toBeUndefined();
  });

  it('写入就是写入：不再产出 PREFILLED_NEEDS_CONFIRMATION 等第二次确认', () => {
    const result = plan({ eeoGender: 'FEMALE' } as never, true);
    expect(result.entries).toHaveLength(1);
    expect(result.skipped.some((item) => item.reason === 'PREFILLED_NEEDS_CONFIRMATION')).toBe(false);
  });

  it('页面上已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Gender', GENDER_OPTIONS);
    (document.querySelector('#o0') as HTMLInputElement).checked = true;
    const result = buildApplyPlan(descriptor, { eeoGender: 'FEMALE' } as never, {
      capabilities: { 'set-self-identification': true },
    } as never);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'eeoGender' });
  });

  it('能力位没开 → 退回 MANUAL_ONLY', () => {
    expect(plan({ eeoGender: 'FEMALE' } as never, false).skipped[0])
      .toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('档案里没有值 → 退回 MANUAL_ONLY，绝不替用户选「不愿回答」', () => {
    expect(plan({} as never, true).skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('页面上没有对得上的选项 → 退回，不许空头承诺', () => {
    const result = buildApplyPlan(
      form('Gender', ['Male', 'Female']), { eeoGender: 'NON_BINARY' } as never,
      { fillEmptyOnly: false, capabilities: { 'set-self-identification': true } } as never,
    );
    expect(result.skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('DECLINE 是一个值，照样写', () => {
    expect(plan({ eeoGender: 'DECLINE' } as never, true).entries[0])
      .toMatchObject({ key: 'eeoGender', value: 'Decline to self identify' });
  });
});

describe('把族裔单拎出来问的是否题', () => {
  it('档案确实是拉美裔时才预填', () => {
    const yes = buildApplyPlan(
      form('Are you Hispanic/Latino?', ['Yes', 'No', 'Decline to self identify']),
      { eeoRace: 'HISPANIC_OR_LATINO' } as never,
      { fillEmptyOnly: false, capabilities: { 'set-self-identification': true } } as never,
    );
    // 是否题的选项是 Yes/No，不是族裔名——写的就是页面上那个 "Yes"。
    expect(yes.entries[0]).toMatchObject({ key: 'eeoRace', value: 'Yes' });
  });

  it('档案是别的族裔时不答：单值档案推不出「不是拉美裔」', () => {
    const other = buildApplyPlan(
      form('Are you Hispanic/Latino?', ['Yes', 'No', 'Decline to self identify']),
      { eeoRace: 'ASIAN' } as never,
      { fillEmptyOnly: false, capabilities: { 'set-self-identification': true } } as never,
    );
    expect(other.skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });
});

/**
 * 2026-09-23：用户在门户里单独答过「是否拉美裔」就照他的话答（负责人实测：他答过「否」，
 * Greenhouse 的这道必填题却一直是「只能由你本人填写」）。
 */
describe('用户亲口答过「是否拉美裔」', () => {
  const HISPANIC = ['Yes', 'No', 'Decline to self identify'];
  const planWith = (hispanicLatino: 'YES' | 'NO' | 'DECLINE', profile: ApplyProfileDraft, capability = true, label = 'Are you Hispanic/Latino?') =>
    buildApplyPlan(form(label, HISPANIC), profile, {
      fillEmptyOnly: false,
      hispanicLatino,
      ...(capability ? { capabilities: { 'set-self-identification': true } } : {}),
    } as never);

  it.each([
    ['NO', 'No'],
    ['DECLINE', 'Decline to self identify'],
    ['YES', 'Yes'],
  ] as const)('答过 %s → 选「%s」，即使种族存的是亚裔', (answer, option) => {
    expect(planWith(answer, { eeoRace: 'ASIAN' } as never).entries[0]).toMatchObject({ key: 'eeoRace', value: option });
  });

  it('能力位关着 → 照旧 MANUAL_ONLY', () => {
    expect(planWith('NO', {} as never, false).skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('种族那道题不受它影响：仍按种族码作答', () => {
    const race = buildApplyPlan(
      form('What is your race?', ['Asian', 'White', 'Decline to self identify']),
      { eeoRace: 'ASIAN' } as never,
      { fillEmptyOnly: false, hispanicLatino: 'NO', capabilities: { 'set-self-identification': true } } as never,
    );
    expect(race.entries[0]).toMatchObject({ key: 'eeoRace', value: 'Asian' });
  });
});

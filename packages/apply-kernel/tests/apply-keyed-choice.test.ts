/**
 * 有档案值的单选／复选题按档案写（2026-09-21）。
 *
 * P1-5 之前 `choice` 一律 CHOICE_NO_DATA——「是否年满 18」「是否愿意搬迁」「办公模式」
 * 这些题用户在档案里已经答过，到了申请表上还要在面板里再答一遍。现在规则认到了键、
 * 档案里有值，就把码展开成人读写法逐个去撞选项文字，每个码恰好命中一项才写。
 *
 * 「不写」的用例照旧多于「写」：单选题多勾一项是错答，少勾一项是漏答，都不该由我们替他定。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFieldKey, ApplyFormDescriptor } from '../src/contracts';

function form(
  label: string,
  options: readonly string[],
  key: ApplyFieldKey | null,
  control: 'radio' | 'checkbox' = 'radio',
  confidence = 1,
): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label>
    <input type="${control}" id="o${index}" name="q" value="${index}">`).join('')}</form>`;
  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice', element: inputs[0]!, key, label, required: true, confidence,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control, options: inputs.map((e, i) => ({ element: e, label: options[i]! })) },
    }],
  } as never;
}

const plan = (descriptor: ApplyFormDescriptor, profile: Record<string, string>, fillEmptyOnly = false) =>
  buildApplyPlan(descriptor, profile as never, { fillEmptyOnly } as never);

afterEach(() => { document.body.innerHTML = ''; });

describe('码展开成人读写法去撞选项', () => {
  it('over18 = true，选项 Yes/No → 写 Yes', () => {
    const result = plan(form('Are you 18 years of age or older?', ['Yes', 'No'], 'over18'), { over18: 'true' });
    expect(result.entries[0]).toMatchObject({ kind: 'choice', key: 'over18', value: 'Yes' });
    expect(result.skipped).toHaveLength(0);
  });

  it('openToRelocation = false → 写 No；选项文字不分大小写与首尾空白', () => {
    const result = plan(form('Are you willing to relocate?', [' YES ', 'no'], 'openToRelocation'), { openToRelocation: 'false' });
    expect(result.entries[0]).toMatchObject({ key: 'openToRelocation', value: 'no' });
  });

  it('薪资周期 YEAR，选项写的是 Annual → 按人读写法命中', () => {
    const result = plan(form('Salary basis', ['Annual', 'Monthly', 'Hourly'], 'expectedSalaryPeriod'), { expectedSalaryPeriod: 'YEAR' });
    expect(result.entries[0]).toMatchObject({ key: 'expectedSalaryPeriod', value: 'Annual' });
  });

  it('复选：办公模式 REMOTE,HYBRID → 两项都勾，按选项顺序', () => {
    const result = plan(
      form('Which work arrangements are you open to?', ['On-site', 'Hybrid', 'Remote'], 'preferredWorkModes', 'checkbox'),
      { preferredWorkModes: 'REMOTE,HYBRID' },
    );
    expect(result.entries[0]).toMatchObject({ key: 'preferredWorkModes', value: 'Hybrid\nRemote' });
  });
});

describe('这些一律不写', () => {
  it('档案里没有值 → CHOICE_NO_DATA，留给面板', () => {
    const result = plan(form('Are you 18 years of age or older?', ['Yes', 'No'], 'over18'), {});
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'CHOICE_NO_DATA', key: 'over18' });
  });

  it('规则没认到键 → CHOICE_NO_DATA，与从前逐字相同', () => {
    const result = plan(form('Are you 18 years of age or older?', ['Yes', 'No'], null), { over18: 'true' });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('键的置信度不够 → 不猜', () => {
    const result = plan(form('Are you 18 years of age or older?', ['Yes', 'No'], 'over18', 'radio', 0.5), { over18: 'true' });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('页面上没有对得上的选项（Yes 出现两次、或根本没有）→ 不猜', () => {
    expect(plan(form('Over 18?', ['Yes', 'Yes', 'No'], 'over18'), { over18: 'true' }).entries).toHaveLength(0);
    expect(plan(form('Over 18?', ['Absolutely', 'Nope'], 'over18'), { over18: 'true' }).entries).toHaveLength(0);
  });

  it('复选里有一个码在页面上没有对应项 → 整题不写，不做半截选择', () => {
    const result = plan(
      form('Work arrangements', ['On-site', 'Remote'], 'preferredWorkModes', 'checkbox'),
      { preferredWorkModes: 'REMOTE,HYBRID' },
    );
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('单选题拿到两个码 → 不写', () => {
    const result = plan(form('Preferred arrangement', ['On-site', 'Hybrid', 'Remote'], 'preferredWorkModes'), { preferredWorkModes: 'REMOTE,HYBRID' });
    expect(result.entries).toHaveLength(0);
  });

  it('页面上已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Are you 18 years of age or older?', ['Yes', 'No'], 'over18');
    (document.querySelector('#o1') as HTMLInputElement).checked = true;
    const result = plan(descriptor, { over18: 'true' }, true);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'over18' });
  });
});

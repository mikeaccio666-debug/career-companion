/**
 * 跨性别、性取向、「是否 LGBTQ+」三道题按用户在门户里的回答作答（2026-09-23；负责人：EEO 用户填了什么
 * 就回答什么，一定要做到填了就能回答）。
 *
 * 线上实例：Greenhouse Discord 的「I consider myself a member of the LGBTQ+ community. (optional)」
 * 从前一直是「只能由你本人填写」。三道题各在单选、原生下拉、组合框（react-select 一类）上钉一遍；
 * 闸与另外四档相同：能力位、有依据、页面上恰好一项对得上。标签与选项都是合成文字。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyFormDescriptor } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';
import { createScanRoot } from '../src/scanRoot';

afterEach(() => { document.body.innerHTML = ''; });

type Control = 'radio' | 'select' | 'combobox';

function radioForm(label: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label><input type="radio" id="o${index}" name="q" value="${index}">`).join('')}</form>`;
  const inputs = [...document.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice', element: inputs[0]!, key: null, label, required: false, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control: 'radio', options: inputs.map((element, index) => ({ element, label: options[index]! })) },
    }],
  } as never;
}

function selectForm(label: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="s">${label}</label><select id="s"><option value="">Select…</option>${options
    .map((text, index) => `<option value="${index}">${text}</option>`).join('')}</select></form>`;
  const element = document.getElementById('s') as HTMLSelectElement;
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{ kind: 'select', element, key: null, label, required: false, confidence: 0, signature: { core: 'form/select:0', labelHint: 'q' } }],
  } as never;
}

function comboboxForm(label: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="c">${label}</label><input id="c" role="combobox" aria-autocomplete="list" aria-expanded="false" /></form>`;
  const element = document.getElementById('c') as HTMLInputElement;
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'combobox', element, key: null, label, required: false, confidence: 0, signature: { core: 'form/input:0', labelHint: 'q' },
      listbox: { triggerSelector: 'input[role="combobox"]', valueContainerSelector: '.v', selectedValueSelector: '.s' },
    }],
  } as never;
}

function formOf(control: Control, label: string, options: readonly string[]): ApplyFormDescriptor {
  if (control === 'radio') return radioForm(label, options);
  if (control === 'select') return selectForm(label, options);
  return comboboxForm(label);
}

const RELEASED = { 'set-self-identification': true } as const;

function plan(
  control: Control,
  label: string,
  options: readonly string[],
  answers: Pick<BuildPlanOptions, 'transgenderStatus' | 'sexualOrientation'>,
  profile: ApplyProfileDraft = {},
  capabilities: BuildPlanOptions['capabilities'] = RELEASED,
) {
  return buildApplyPlan(formOf(control, label, options), profile, { fillEmptyOnly: true, capabilities, ...answers });
}

const YES_NO = ['Yes', 'No', "I don't wish to answer"];
const TRANSGENDER = 'Do you identify as transgender?';
const LGBTQ = 'I consider myself a member of the LGBTQ+ community. (optional)';
const ORIENTATION_LABEL = 'What is your sexual orientation?';
const ORIENTATION = [
  'Asexual', 'Bisexual and/or pansexual', 'Gay', 'Heterosexual', 'Lesbian', 'Queer',
  'I prefer to self-describe', "I don't wish to answer",
];

describe('三道题在三种控件上都答得上', () => {
  it.each(['radio', 'select'] as const)('%s：跨性别 YES / NO / DECLINE 各选对应那一项，键 eeoTransgender', (control) => {
    for (const [stated, option] of [['YES', 'Yes'], ['NO', 'No'], ['DECLINE', "I don't wish to answer"]] as const) {
      expect(plan(control, TRANSGENDER, YES_NO, { transgenderStatus: stated }).entries[0], stated)
        .toMatchObject({ key: 'eeoTransgender', value: option });
    }
  });

  it.each(['radio', 'select'] as const)('%s：性取向照门户那一档选，键 eeoSexualOrientation', (control) => {
    expect(plan(control, ORIENTATION_LABEL, ORIENTATION, { sexualOrientation: 'LESBIAN' }).entries[0])
      .toMatchObject({ key: 'eeoSexualOrientation', value: 'Lesbian' });
    expect(plan(control, ORIENTATION_LABEL, ORIENTATION, { sexualOrientation: 'DECLINE' }).entries[0])
      .toMatchObject({ key: 'eeoSexualOrientation', value: "I don't wish to answer" });
  });

  it.each(['radio', 'select'] as const)('%s：「是否 LGBTQ+」由两问推出，键 eeoLgbtqCommunity', (control) => {
    expect(plan(control, LGBTQ, YES_NO, { sexualOrientation: 'GAY' }).entries[0])
      .toMatchObject({ key: 'eeoLgbtqCommunity', value: 'Yes' });
    expect(plan(control, LGBTQ, YES_NO, { sexualOrientation: 'HETEROSEXUAL', transgenderStatus: 'NO' }).entries[0])
      .toMatchObject({ key: 'eeoLgbtqCommunity', value: 'No' });
    expect(plan(control, LGBTQ, YES_NO, { sexualOrientation: 'DECLINE', transgenderStatus: 'DECLINE' }).entries[0])
      .toMatchObject({ key: 'eeoLgbtqCommunity', value: "I don't wish to answer" });
  });

  it('原生下拉的条目带 resolvedOptionText（写入期按原文选）', () => {
    expect(plan('select', TRANSGENDER, YES_NO, { transgenderStatus: 'NO' }).entries[0])
      .toMatchObject({ kind: 'select', resolvedOptionText: 'No' });
  });

  it('组合框：把闭集候选交给写入期去撞真实菜单', () => {
    expect(plan('combobox', TRANSGENDER, [], { transgenderStatus: 'YES' }).entries[0])
      .toMatchObject({ kind: 'combobox', key: 'eeoTransgender', comboboxCandidates: ['Yes'] });
    expect(plan('combobox', ORIENTATION_LABEL, [], { sexualOrientation: 'HETEROSEXUAL' }).entries[0])
      .toMatchObject({ kind: 'combobox', key: 'eeoSexualOrientation', comboboxCandidates: ['Heterosexual', 'Straight'] });
    expect(plan('combobox', LGBTQ, [], { sexualOrientation: 'QUEER' }).entries[0])
      .toMatchObject({ kind: 'combobox', key: 'eeoLgbtqCommunity', comboboxCandidates: ['Yes'] });
    const declined = plan('combobox', LGBTQ, [], { sexualOrientation: 'DECLINE', transgenderStatus: 'DECLINE' }).entries[0];
    expect((declined as { comboboxCandidates: readonly string[] }).comboboxCandidates).toContain("I don't wish to answer");
  });
});

describe('闸一道没松', () => {
  it.each(['radio', 'select', 'combobox'] as const)('%s：能力位关着 → 三道题都退回 MANUAL_ONLY', (control) => {
    const answers = { transgenderStatus: 'YES', sexualOrientation: 'GAY' } as const;
    for (const [label, options] of [[TRANSGENDER, YES_NO], [ORIENTATION_LABEL, ORIENTATION], [LGBTQ, YES_NO]] as const) {
      const result = plan(control, label, options, answers, {}, {});
      expect(result.entries, label).toEqual([]);
      expect(result.skipped[0], label).toMatchObject({ reason: 'MANUAL_ONLY' });
    }
  });

  it('没带这两句（没答、自行描述、没同意复用）→ 三道题都 MANUAL_ONLY，不拿性别或别的档案值去猜', () => {
    const profile = { eeoGender: 'FEMALE', eeoRace: 'ASIAN' } as never;
    for (const [label, options] of [[TRANSGENDER, YES_NO], [ORIENTATION_LABEL, ORIENTATION], [LGBTQ, YES_NO]] as const) {
      expect(plan('radio', label, options, {}, profile).skipped[0], label).toMatchObject({ reason: 'MANUAL_ONLY' });
    }
  });

  it('双性恋／泛性恋：宿主把 Bisexual 与 Pansexual 分成两项 → 不替他挑，MANUAL_ONLY', () => {
    const split = ['Asexual', 'Bisexual', 'Pansexual', 'Gay', 'Heterosexual', "I don't wish to answer"];
    expect(plan('radio', ORIENTATION_LABEL, split, { sexualOrientation: 'BISEXUAL_PANSEXUAL' }).skipped[0])
      .toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(plan('select', ORIENTATION_LABEL, split, { sexualOrientation: 'BISEXUAL_PANSEXUAL' }).skipped[0])
      .toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(plan('select', ORIENTATION_LABEL, ['Gay', 'Bisexual', 'Heterosexual'], { sexualOrientation: 'BISEXUAL_PANSEXUAL' }).entries[0])
      .toMatchObject({ key: 'eeoSexualOrientation', value: 'Bisexual' });
  });

  it('双性恋／泛性恋在组合框上交还用户：计划期看不到菜单，分列与否无从判断', () => {
    expect(plan('combobox', ORIENTATION_LABEL, [], { sexualOrientation: 'BISEXUAL_PANSEXUAL' }).skipped[0])
      .toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('「是否 LGBTQ+」推不出来的一律不答：缺一问、一问不想回答另一问是否', () => {
    for (const answers of [
      { sexualOrientation: 'HETEROSEXUAL' },
      { transgenderStatus: 'NO' },
      { sexualOrientation: 'HETEROSEXUAL', transgenderStatus: 'DECLINE' },
      { sexualOrientation: 'DECLINE', transgenderStatus: 'NO' },
    ] as const) {
      expect(plan('radio', LGBTQ, YES_NO, answers).skipped[0], JSON.stringify(answers)).toMatchObject({ reason: 'MANUAL_ONLY' });
    }
  });

  it('已知是非二元：「是否 LGBTQ+」不答「否」', () => {
    const result = plan('radio', LGBTQ, YES_NO, { sexualOrientation: 'HETEROSEXUAL', transgenderStatus: 'NO' }, { eeoGender: 'NON_BINARY' } as never);
    expect(result.skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('跨性别与 LGBTQ+ 题的选项不是是／否 → 不答（判读错了题也不替他选「不愿回答」）', () => {
    const notYesNo = ['Man', 'Woman', 'Non-binary', "I don't wish to answer"];
    expect(plan('radio', TRANSGENDER, notYesNo, { transgenderStatus: 'DECLINE' }).skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(plan('select', LGBTQ, notYesNo, { sexualOrientation: 'DECLINE', transgenderStatus: 'DECLINE' }).skipped[0])
      .toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('拿性别认同与出生时的性别比：说过「不是跨性别」推不出答案，说过「是」按问法正反答', () => {
    const differs = 'Does your gender identity differ from the sex you were assigned at birth?';
    const same = 'Is your gender identity the same as the sex you were assigned at birth?';
    expect(plan('radio', differs, YES_NO, { transgenderStatus: 'NO' }).skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(plan('radio', differs, YES_NO, { transgenderStatus: 'YES' }).entries[0]).toMatchObject({ key: 'eeoTransgender', value: 'Yes' });
    expect(plan('radio', same, YES_NO, { transgenderStatus: 'YES' }).entries[0]).toMatchObject({ key: 'eeoTransgender', value: 'No' });
  });

  it('页面上已经选了：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = radioForm(TRANSGENDER, YES_NO);
    (document.querySelector('#o0') as HTMLInputElement).checked = true;
    const result = buildApplyPlan(descriptor, {}, { capabilities: RELEASED, transgenderStatus: 'NO' });
    expect(result.entries).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'eeoTransgender' });
  });
});

describe('同一节里与原来四档并存', () => {
  it('性别、跨性别、性取向、LGBTQ+ 四道题同一节：键各不相同，谁也不把谁当重复字段仲裁掉', () => {
    const labels = ['Gender', TRANSGENDER, ORIENTATION_LABEL, LGBTQ];
    const optionsFor = [['Male', 'Female', 'Decline to self identify'], YES_NO, ORIENTATION, YES_NO];
    document.body.innerHTML = `<form><h3>Voluntary Self-Identification</h3>
      ${labels.map((label, index) => `<label for="s${index}">${label}</label><select id="s${index}"><option value="">Select…</option>${
        optionsFor[index]!.map((text) => `<option>${text}</option>`).join('')}</select>`).join('')}
    </form>`;
    const fields = labels.map((label, index) => ({
      kind: 'select', element: document.getElementById(`s${index}`), key: null, label, required: false, confidence: 0,
      signature: { core: `form/select:${index}`, labelHint: 'q' },
    }));
    const result = buildApplyPlan(
      { vendor: 'greenhouse', root: createScanRoot(document.querySelector('form')!, [], []), fields } as never,
      { eeoGender: 'FEMALE' } as never,
      { capabilities: RELEASED, transgenderStatus: 'NO', sexualOrientation: 'BISEXUAL_PANSEXUAL' },
    );
    expect(result.entries.map((entry) => [entry.key, entry.value])).toEqual([
      ['eeoGender', 'Female'],
      ['eeoTransgender', 'No'],
      ['eeoSexualOrientation', 'Bisexual and/or pansexual'],
      ['eeoLgbtqCommunity', 'Yes'],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('同一件事问两遍（公司自订题与标准段各一道 LGBTQ+）：题面不同就是两道题，两道都答', () => {
    const labels = [LGBTQ, 'Do you identify as LGBTQ+?'];
    document.body.innerHTML = `<form><h3>Demographics</h3>
      ${labels.map((label, index) => `<label for="s${index}">${label}</label><select id="s${index}"><option value="">Select…</option>${
        YES_NO.map((text) => `<option>${text}</option>`).join('')}</select>`).join('')}
    </form>`;
    const fields = labels.map((label, index) => ({
      kind: 'select', element: document.getElementById(`s${index}`), key: null, label, required: false, confidence: 0,
      signature: { core: `form/select:${index}`, labelHint: 'q' },
    }));
    const result = buildApplyPlan(
      { vendor: 'greenhouse', root: createScanRoot(document.querySelector('form')!, [], []), fields } as never,
      {},
      { capabilities: RELEASED, sexualOrientation: 'QUEER' },
    );
    expect(result.entries.map((entry) => [entry.key, entry.value])).toEqual([
      ['eeoLgbtqCommunity', 'Yes'],
      ['eeoLgbtqCommunity', 'Yes'],
    ]);
  });

  it('原来四档照旧：性别题不因带了这两句而改答', () => {
    const result = plan('radio', 'Gender', ['Male', 'Female', 'Decline to self identify'], { transgenderStatus: 'YES', sexualOrientation: 'GAY' }, { eeoGender: 'MALE' } as never);
    expect(result.entries[0]).toMatchObject({ key: 'eeoGender', value: 'Male' });
  });
});

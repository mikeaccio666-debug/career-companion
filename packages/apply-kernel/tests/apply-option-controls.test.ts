/**
 * 「选一项」的题在三种控件上都要能落笔（2026-09-21）。
 *
 * Greenhouse job-boards 上**所有**下拉都是 react-select 组合框：工作授权、「你现在人在 X 吗」、
 * EEO 四题全是。此前三条预填只认单选钮，于是在最常见的一家 ATS 上一次都没填过，浮层一律
 * 「没把握，没敢填」／「只能由你本人填写」。现在：单选／原生下拉在计划期按选项文字恰好命中一项；
 * 组合框把闭集候选交给写入期去撞真实菜单。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFormDescriptor } from '../src/contracts';

function selectForm(label: string, options: readonly string[], key: string | null = null, confidence = 0): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="s">${label}</label><select id="s"><option value="">Select…</option>${options
    .map((text, index) => `<option value="${index}">${text}</option>`).join('')}</select></form>`;
  const element = document.getElementById('s') as HTMLSelectElement;
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{ kind: 'select', element, key, label, required: true, confidence, signature: { core: 'form/select:0', labelHint: 'q' } }],
  } as never;
}

function comboboxForm(label: string, key: string | null = null, confidence = 0): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="c">${label}</label><input id="c" role="combobox" aria-autocomplete="list" aria-expanded="false" /></form>`;
  const element = document.getElementById('c') as HTMLInputElement;
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'combobox', element, key, label, required: true, confidence, signature: { core: 'form/input:0', labelHint: 'q' },
      listbox: { triggerSelector: 'input[role="combobox"]', valueContainerSelector: '.v', selectedValueSelector: '.s' },
    }],
  } as never;
}

const AUTHORIZATIONS = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }] as const;

afterEach(() => { document.body.innerHTML = ''; });

describe('原生下拉：计划期按选项文字恰好命中一项', () => {
  it('EEO 性别：档案 FEMALE，下拉里的 Female 被选中，条目带 resolvedOptionText', () => {
    const plan = buildApplyPlan(selectForm('Gender', ['Male', 'Female', 'Decline To Self Identify']), { eeoGender: 'FEMALE' } as never, {
      capabilities: { 'set-self-identification': true },
    } as never);
    expect(plan.entries[0]).toMatchObject({ kind: 'select', key: 'eeoGender', value: 'Female', resolvedOptionText: 'Female' });
    expect(plan.skipped).toHaveLength(0);
  });

  it('工作授权：点名美国、用户有记录 → 下拉里的 Yes', () => {
    const plan = buildApplyPlan(selectForm('Are you legally authorized to work in the United States?', ['Yes', 'No']), {} as never, {
      capabilities: { 'set-work-authorization': true }, workAuthorizations: AUTHORIZATIONS,
    } as never);
    expect(plan.entries[0]).toMatchObject({ kind: 'select', key: 'workAuthorization', value: 'Yes' });
  });

  it('下拉里没有对得上的项 → 不写，退回原来的停因', () => {
    const plan = buildApplyPlan(selectForm('Gender', ['Prefer to describe', 'Something else']), { eeoGender: 'FEMALE' } as never, {
      capabilities: { 'set-self-identification': true },
    } as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });

  it('下拉已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = selectForm('Gender', ['Male', 'Female']);
    (document.getElementById('s') as HTMLSelectElement).value = '0';
    const plan = buildApplyPlan(descriptor, { eeoGender: 'FEMALE' } as never, { capabilities: { 'set-self-identification': true } } as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'eeoGender' });
  });
});

describe('组合框：把闭集候选交给写入期去撞真实菜单', () => {
  it('「你现在人在美国吗」→ 候选 Yes，键 residence', () => {
    const plan = buildApplyPlan(comboboxForm('Are you currently located in the US?'), { addressCountry: 'US' } as never, {} as never);
    expect(plan.entries[0]).toMatchObject({ kind: 'combobox', key: 'residence', value: 'Yes', comboboxCandidates: ['Yes'] });
  });

  it('同一节里 Country 下拉与「你现在人在美国吗」各写各的：键不同，不再互相仲裁掉', () => {
    document.body.innerHTML = `<form>
      <label for="country">Country</label><input id="country" role="combobox" aria-autocomplete="list" aria-expanded="false" />
      <label for="q">Are you currently located in the US?</label><input id="q" role="combobox" aria-autocomplete="list" aria-expanded="false" />
    </form>`;
    const listbox = { triggerSelector: 'input[role="combobox"]', valueContainerSelector: '.v', selectedValueSelector: '.s' };
    const root = createScanRoot(document.querySelector('form')!, [], []);
    const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields: [
      { kind: 'combobox', element: document.getElementById('country'), key: 'addressCountry', label: 'Country', required: true, confidence: 0.75, signature: { core: 'form/input:0', labelHint: 'country' }, listbox },
      { kind: 'combobox', element: document.getElementById('q'), key: null, label: 'Are you currently located in the US?', required: true, confidence: 0, signature: { core: 'form/input:1', labelHint: 'q' }, listbox },
    ] } as never, { addressCountry: 'US' } as never, {} as never);
    expect(plan.entries.map((entry) => [entry.key, entry.value])).toEqual([['addressCountry', 'United States'], ['residence', 'Yes']]);
    expect(plan.skipped).toHaveLength(0);
  });

  it('EEO 种族：档案 ASIAN → 两种法定写法按序候选，键 eeoRace', () => {
    const plan = buildApplyPlan(comboboxForm('Race'), { eeoRace: 'ASIAN' } as never, { capabilities: { 'set-self-identification': true } } as never);
    expect(plan.entries[0]).toMatchObject({
      kind: 'combobox', key: 'eeoRace', comboboxCandidates: ['Asian (Not Hispanic or Latino)', 'Asian'],
    });
  });

  it('EEO 不愿回答：DECLINE 也是一个值，候选是各家的法定说法', () => {
    const plan = buildApplyPlan(comboboxForm('Veteran Status'), { eeoVeteran: 'DECLINE' } as never, { capabilities: { 'set-self-identification': true } } as never);
    expect(plan.entries[0]?.kind).toBe('combobox');
    expect((plan.entries[0] as { comboboxCandidates: readonly string[] }).comboboxCandidates).toContain("I don't wish to answer");
  });

  it('担保：点名美国、不需担保 → 候选 No，键 workSponsorship', () => {
    const plan = buildApplyPlan(comboboxForm('Will you now or in the future require sponsorship to work in the United States?'), {} as never, {
      capabilities: { 'set-work-authorization': true }, workAuthorizations: AUTHORIZATIONS,
    } as never);
    expect(plan.entries[0]).toMatchObject({ kind: 'combobox', key: 'workSponsorship', value: 'No', comboboxCandidates: ['No'] });
  });

  it('担保：题面括号里举例「spouse visa」（2026-09-24 adobe.wd5 第 3 页）→ 照样按岗位所在国答，不当成「涉及他人」', () => {
    const label = 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status, spouse visa, etc)?';
    const plan = buildApplyPlan(comboboxForm(label), {} as never, {
      capabilities: { 'set-work-authorization': true }, workAuthorizations: AUTHORIZATIONS, jobRegionCode: 'US',
    } as never);
    expect(plan.skipped).toEqual([]);
    expect(plan.entries[0]).toMatchObject({ kind: 'combobox', key: 'workSponsorship', value: 'No' });
  });

  it('能力位没开：组合框上也一个字不写', () => {
    const plan = buildApplyPlan(comboboxForm('Gender'), { eeoGender: 'FEMALE' } as never, {} as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'MANUAL_ONLY' });
  });
});

describe('国家与地点的候选', () => {
  it('国家下拉：ISO 码 US 展开成 United States，码本身垫底', () => {
    const plan = buildApplyPlan(selectForm('Country', ['Canada', 'United States', 'United Kingdom'], 'addressCountry', 1), { addressCountry: 'US' } as never, {} as never);
    expect(plan.entries[0]).toMatchObject({ kind: 'select', key: 'addressCountry', value: 'United States' });
  });

  it('国家组合框：候选按国名、别名、码的顺序', () => {
    const plan = buildApplyPlan(comboboxForm('Country', 'addressCountry', 1), { addressCountry: 'US' } as never, {} as never);
    const candidates = (plan.entries[0] as { comboboxCandidates: readonly string[] }).comboboxCandidates;
    expect(candidates[0]).toBe('United States');
    expect(candidates).toContain('United States of America');
    expect(candidates[candidates.length - 1]).toBe('US');
  });

  it('地点 typeahead：档案里有州就先按「城市, 州名」问，再「城市, 州码」，最后城市名', () => {
    const plan = buildApplyPlan(comboboxForm('Location (City)', 'city', 1), { city: 'Birmingham', addressRegion: 'AL' } as never, {} as never);
    expect((plan.entries[0] as { comboboxCandidates: readonly string[] }).comboboxCandidates)
      .toEqual(['Birmingham, Alabama', 'Birmingham, AL', 'Birmingham']);
  });

  it('地点 typeahead：没有州就只有城市名，与从前逐字相同', () => {
    const plan = buildApplyPlan(comboboxForm('Location (City)', 'city', 1), { city: 'Birmingham' } as never, {} as never);
    expect((plan.entries[0] as { comboboxCandidates: readonly string[] }).comboboxCandidates).toEqual(['Birmingham']);
  });
});

/**
 * 带旗标的国家选择器：选项是「United States +1」，选中后控件里只剩旗与「+1」。
 * 2026-09-21 Greenhouse job-boards 实测——写入其实成功了，却因为显示位对不上被判
 * WRITE_REVERTED，浮层报「本项未完成，请检查页面」。
 */
describe('选中后的显示位与选项文字不一致', () => {
  it('去掉尾部区号后相等、或只显示区号，都算选上了', async () => {
    const { showsPick } = await import('../src/write/listboxCombobox');
    expect(showsPick('United States +1', 'United States +1')).toBe(true);
    expect(showsPick('United States', 'United States +1')).toBe(true);
    expect(showsPick('+1', 'United States +1')).toBe(true);
  });

  it('别的文字仍然算没选上：不做前缀或包含匹配', async () => {
    const { showsPick } = await import('../src/write/listboxCombobox');
    expect(showsPick('United', 'United States +1')).toBe(false);
    expect(showsPick('Canada +1', 'United States +1')).toBe(false);
    expect(showsPick('', 'United States +1')).toBe(false);
    expect(showsPick('+1', 'United States')).toBe(false);
  });
});

describe('州／省下拉', () => {
  it('档案里的 AL 展开成 Alabama，码垫底', () => {
    const plan = buildApplyPlan(selectForm('State', ['Alaska', 'Alabama', 'Arizona'], 'addressRegion', 1), { addressRegion: 'AL' } as never, {} as never);
    expect(plan.entries[0]).toMatchObject({ key: 'addressRegion', value: 'Alabama' });
  });

  it('不是州码的原样一个候选，与从前逐字相同', () => {
    const plan = buildApplyPlan(selectForm('State', ['Bavaria', 'Hesse'], 'addressRegion', 1), { addressRegion: 'Bavaria' } as never, {} as never);
    expect(plan.entries[0]).toMatchObject({ key: 'addressRegion', value: 'Bavaria' });
  });
});

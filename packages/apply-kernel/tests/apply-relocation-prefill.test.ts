/**
 * 「现在人在 X，或者愿意搬去 X 吗」按档案直接写。
 *
 * 2026-09-22 真实批测：这道题在 Discord 的每一页上都出现，整轮八页全落
 * `JOB_DEPENDENT`（面板说「取决于这个岗位，由你回答」）：
 *
 *   Are you currently based in or willing to relocate to the Bay Area for this position?
 *
 * 而档案里两半都有：城市 San Francisco… 不，是居住地 Birmingham, Alabama，以及
 * 「愿意搬去 San Francisco, New York, Seattle」。后半句就是这道题的答案。
 *
 * `dict/residence.ts` 当年刻意把掺了搬迁的题挡在门外，注释写的是「愿不愿意搬是偏好，
 * 档案里没有，也推不出来」——那句话在 P1-5 加进 `openToRelocation` /
 * `openToRelocationCities` 之后就不再成立。这份用例钉的是补上的那一半。
 *
 * 「不答」的用例比「答对」的多，与工作授权、居住地同一个理由：答错不是少填一栏，
 * 是在一份正式申请里向雇主做了不实的陈述。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFormDescriptor } from '../src/contracts';

const YES_NO = ['Yes', 'No'];

function form(label: string, options: readonly string[] = YES_NO): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label>
    <input type="radio" id="o${index}" name="q" value="${index}">`).join('')}</form>`;
  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice', element: inputs[0]!, key: null, label, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control: 'radio', options: inputs.map((e, i) => ({ element: e, label: options[i]! })) },
    }],
  } as never;
}

/** Mike 的账号 2026-09-22 的真实形态：住 Birmingham, Alabama；愿意搬去三座城市。 */
const PROFILE = {
  city: 'Birmingham',
  addressRegion: 'AL',
  openToRelocation: 'true',
  openToRelocationCities: 'San Francisco, New York, Seattle',
} as const;

function planFor(label: string, draft: Record<string, string> = PROFILE, options = YES_NO) {
  return buildApplyPlan(form(label, options), draft as never, { fillEmptyOnly: false } as never);
}

/** 「不答」的判据：一个字不写，且那一行按原路停在别的停因上。 */
function unanswered(label: string, draft: Record<string, string> = PROFILE, options = YES_NO) {
  const plan = planFor(label, draft, options);
  expect(plan.entries).toHaveLength(0);
  return plan.skipped[0];
}

afterEach(() => { document.body.innerHTML = ''; });

describe('点名的地方在他自己列的搬迁城市里', () => {
  it('题目写都市圈名、档案写圈里的城市：Bay Area ↔ San Francisco', () => {
    expect(planFor('Are you currently based in or willing to relocate to the Bay Area for this position?')
      .entries[0]).toMatchObject({ kind: 'choice', key: 'relocation', value: 'Yes' });
  });

  it('题目直接写城市名', () => {
    expect(planFor('Are you willing to relocate to Seattle?').entries[0])
      .toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('NYC 与 New York 是同一处', () => {
    expect(planFor('Would you be willing to relocate to NYC?').entries[0])
      .toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('写入就是写入：不进 skipped、不等确认', () => {
    const plan = planFor('Are you willing to relocate to Seattle?');
    expect(plan.entries).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it('他已经住在那儿：也答是', () => {
    expect(planFor('Are you currently based in or willing to relocate to Birmingham?').entries[0])
      .toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('说了愿意搬又没列城市：那句话本身就是答案', () => {
    expect(planFor('Are you willing to relocate to Austin?', {
      ...PROFILE, openToRelocationCities: '',
    }).entries[0]).toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('页面上已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Are you willing to relocate to Seattle?');
    (document.querySelector('#o1') as HTMLInputElement).checked = true;
    const plan = buildApplyPlan(descriptor, PROFILE as never, {} as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'relocation' });
  });
});

describe('答不上来的，一个字不改地走原路', () => {
  // 只答得出「是」。他没列 Austin，不代表他不肯去——也可能是这个地名我们没认出来。
  it('点名的城市不在清单里：不替他说「否」', () => {
    expect(unanswered('Are you willing to relocate to Austin?')).not.toMatchObject({ key: 'relocation' });
  });

  it('他说了不愿意搬、又不住在那儿：仍然不答', () => {
    expect(unanswered('Are you willing to relocate to Seattle?', {
      ...PROFILE, openToRelocation: 'false',
    })).not.toMatchObject({ key: 'relocation' });
  });

  it('档案里没有搬迁意愿这一项', () => {
    expect(unanswered('Are you willing to relocate to Seattle?', { city: 'Birmingham' }))
      .not.toMatchObject({ key: 'relocation' });
  });

  it('题目没点名地方', () => {
    expect(unanswered('Are you willing to relocate for this role?')).not.toMatchObject({ key: 'relocation' });
  });

  // 一道法律问题落进地址判读，等于把它当地址题答掉。
  it('掺了工作许可：不归这里管', () => {
    expect(unanswered('Are you authorized to work in the Bay Area, or willing to relocate there?'))
      .not.toMatchObject({ key: 'relocation' });
  });

  // 「搬家费用」「什么时候能搬」问的是别的事，档案答不上来。
  it('问的是搬家补助或时间：不答', () => {
    expect(unanswered('Do you require a relocation package to relocate to Seattle?'))
      .not.toMatchObject({ key: 'relocation' });
    expect(unanswered('When would you be able to relocate to Seattle?'))
      .not.toMatchObject({ key: 'relocation' });
  });

  // 说了「能答」却没有可勾的选项，用户看到的是一个点不动的条目。
  it('页面上没有对得上「是」的选项：不承诺', () => {
    expect(unanswered('Are you willing to relocate to Seattle?', PROFILE, ['Maybe', 'Prefer not to say']))
      .not.toMatchObject({ key: 'relocation' });
  });
});

/**
 * 题目没写搬去哪儿，指的就是这个岗位的地点（2026-09-24 测试台 jobs.lever.co/shieldai/30df7ce0-…）：
 * 「Are you local to or willing to relocate?」，岗位写明 Seattle, Washington，他列的搬迁城市里有 Seattle。
 * 从前落「答案取决于这个岗位」。岗位地点由调用方从页面的 JobPosting 读出（`jobLocation`）。
 */
describe('题目没写搬去哪儿：按岗位地点答', () => {
  const withJob = (label: string, jobLocation: string | undefined, draft: Record<string, string> = PROFILE, options = YES_NO) =>
    buildApplyPlan(form(label, options), draft as never, {
      fillEmptyOnly: false,
      ...(jobLocation === undefined ? {} : { jobLocation }),
    } as never);

  it('岗位在他列的搬迁城市：答是', () => {
    for (const label of [
      'Are you local to or willing to relocate?',
      'Are you willing to relocate?',
      'Are you willing to relocate for this role?',
      'Would you be open to relocating for this position?',
    ]) {
      expect(withJob(label, 'Seattle, Washington').entries[0], label).toMatchObject({ key: 'relocation', value: 'Yes' });
    }
  });

  it('岗位就在他住的城市：答是', () => {
    expect(withJob('Are you local to or willing to relocate?', 'Birmingham, Alabama', { city: 'Birmingham' }).entries[0])
      .toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('原生下拉「Please select an option / Yes / No」上照样答', () => {
    document.body.innerHTML = `<form><select id="q"><option value="">Please select an option</option><option value="Yes">Yes</option><option value="No">No</option></select></form>`;
    const select = document.querySelector('select')!;
    const plan = buildApplyPlan({
      vendor: 'lever',
      root: createScanRoot(document.querySelector('form')!, [], []),
      fields: [{
        kind: 'select', element: select, key: null, label: 'Are you local to or willing to relocate?', required: true, confidence: 0,
        signature: { core: 'form/select:0', labelHint: 'q' },
      }],
    } as never, PROFILE as never, { fillEmptyOnly: false, jobLocation: 'Seattle, Washington' } as never);
    expect(plan.entries[0]).toMatchObject({ key: 'relocation', value: 'Yes' });
  });

  it('岗位不在他列的城市、不知道岗位在哪、或题目自己写了别的地方：照旧不答', () => {
    expect(withJob('Are you local to or willing to relocate?', 'Austin, Texas').entries).toHaveLength(0);
    expect(withJob('Are you local to or willing to relocate?', undefined).entries).toHaveLength(0);
    expect(withJob('Are you willing to relocate to Austin?', 'Seattle, Washington').entries).toHaveLength(0);
    expect(withJob('Are you willing to relocate?', 'Seattle, Washington', { ...PROFILE, openToRelocation: 'false' }).entries)
      .toHaveLength(0);
  });
});

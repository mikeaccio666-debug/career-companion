/**
 * 「你现在人在 X 吗」按档案直接写——接线本身的红绿闸。2026-09-21 起不再等确认：
 * 答案就是他自己填进档案的国家。
 *
 * 2026-09-18 的 100 页真实批测里，这一类题落在 LOW_CONFIDENCE，面板对用户说的是
 * 「没把握，没敢填」。那句话是冤枉的：答案就在档案的 `addressCountry` 里，而
 * Country 那一栏我们本来就照抄进表单了——不是没把握，是从来没人去看档案。
 *
 * 把 engine 里那个 `residencePrefill` 分支删掉，下面第一条就红。
 *
 * 「不答」的用例比「答对」的多，和工作授权那条同一个理由：答错不是少填一栏，
 * 是在一份正式申请里向雇主做了不实的事实陈述。
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

/** 档案草稿走的是第二个参数（`deriveProfile` 的入参），不是 options。 */
function planFor(label: string, addressCountry: string | null = 'US', options = YES_NO) {
  // 哨兵用 null 不用 undefined：显式传 undefined 会触发默认参数，那条用例就悄悄
  // 变成在测「有国家」——写这份测试时就先踩了一次。
  const draft = addressCountry === null ? {} : { addressCountry };
  return buildApplyPlan(form(label, options), draft as never, {
    fillEmptyOnly: false,
  } as never);
}

/** 「不答」的判据：一个字不写（entries 空），且那一行按原路停在别的停因上。 */
function unanswered(label: string, addressCountry: string | null = 'US', options = YES_NO) {
  const plan = planFor(label, addressCountry, options);
  expect(plan.entries).toHaveLength(0);
  return plan.skipped[0];
}

afterEach(() => { document.body.innerHTML = ''; });

describe('点名了档案里那个国家', () => {
  it('写「是」，键是 residence（不借用 addressCountry：同节的 Country 下拉会把它当重复字段仲裁掉）', () => {
    expect(planFor('Are you currently located in the US?').entries[0]).toMatchObject({
      kind: 'choice', key: 'residence', value: 'Yes',
    });
  });

  it('写全称也认', () => {
    expect(planFor('Do you currently reside in the United States?').entries[0]).toMatchObject({
      key: 'residence', value: 'Yes',
    });
  });

  it('写入就是写入：不进 skipped、不等确认', () => {
    const plan = planFor('Are you currently located in the US?');
    expect(plan.entries).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it('页面上已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Are you currently located in the US?');
    (document.querySelector('#o1') as HTMLInputElement).checked = true;
    const plan = buildApplyPlan(descriptor, { addressCountry: 'US' } as never, {} as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'residence' });
  });
});

describe('答不上来的，一个字不改地走原路', () => {
  it('档案里没有国家：不预填', () => {
    expect(unanswered('Are you currently located in the US?', null))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });

  // 只答得出「是」。点名别的国家时我们分不清「他确实不在那儿」和「这个国名我们
  // 没认出来」——不替他否认一件我们并不知道的事。
  it('点名的是别的国家：不替他说「否」', () => {
    expect(unanswered('Are you currently located in Canada?'))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });

  it('没点名国家：不答', () => {
    expect(unanswered('Are you currently located in the country where this role is based?'))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });

  // 「愿不愿意搬」是偏好，档案里没有也推不出来。答一半等于替他表了态。
  it('掺了搬迁意愿：整道题都不答', () => {
    expect(unanswered('Are you currently based in or willing to relocate to the US?'))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });

  // 一道法律问题落进地址判读，等于把它当地址题答掉。
  it('问的是工作许可：不归这里管', () => {
    expect(unanswered('Are you legally authorized to work in the US?'))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });

  // 说了「已预填」却没有可勾的选项，用户看到的是一个点不动的条目，
  // 比直接说「这题你自己答」还糟。
  it('页面上没有对得上「是」的选项：不承诺', () => {
    expect(unanswered('Are you currently located in the US?', 'US', ['Maybe', 'Prefer not to say']))
      .not.toMatchObject({ reason: 'PREFILLED_NEEDS_CONFIRMATION' });
  });
});

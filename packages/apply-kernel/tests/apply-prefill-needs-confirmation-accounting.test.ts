/**
 * 「已预填、等你放行」在两处统计里各自算成什么。
 *
 * 2026-09-21 起只有**按岗位地点推断**的工作授权还走这一档（EEO 等档案里亲手填的值直接写）；
 * 2026-09-23 起连那一档也直接写了，引擎眼下不再产出这个码。但两处统计对它的口径仍要守住——
 * 下一次有东西走回这一档时，不能又被记成我们搞砸了。所以夹具不再借工作授权去造，而是把一条
 * 跳过记录直接摆成这个码。
 *
 * 这个码是 2026-09-17 随 EEO 与工作授权一起加的。加的时候只改了产出侧
 * （engine 的两道闸）与面板的可审阅名单，**两处统计谁都没告诉**：
 *
 *  - `audit.ts` 的 `skipStatus` 没有它的分支，落到末尾的 `return 'FAILED'`，
 *    于是进 `OUR_PROBLEM_STATUSES`——那一档的注释写着「这一类是应该归零的」。
 *    我们明明认出了题、手上有值、还挑好了页面上的那一项，却把它记成自己搞砸了。
 *    后果是审计面板把它画成红条，批测的 `blockedByUs` 每预填一题涨一。
 *  - `summarizePlan` 同理落到 `else needsReview += 1`，而 needsReview 的定义是
 *    「我们的能力不足（认不出／不敢填）」。
 *
 * 正确的档是**「轮到你了」**：下一步在用户手上，不在我们这儿。
 *
 * 但它仍然**进必填分母、不进分子**，与 JOB_DEPENDENT／MANUAL_ONLY 同口径。
 * 理由在 audit.ts `AWAITING_USER_STATUSES` 的头注里：报「必填 4/4 已就绪」
 * 而用户其实还没放行工签，等于告诉他可以提交了。预填让那一步变成一次点击，
 * 没让那一步消失。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildAuditView } from '../src/audit';
import { buildApplyPlan, summarizePlan } from '../src/engine';
import type { ApplyFormDescriptor } from '../src/contracts';
import { createScanRoot } from '../src/scanRoot';

const YES_NO = ['Yes', 'No'];

function form(label: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label>
    <input type="radio" id="o${index}" name="eeo" value="${index}">`).join('')}</form>`;
  const inputs = [...document.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
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

function prefilledPlan() {
  // 能力位关着：这道题照常被判成「取决于这个岗位」而跳过；再把那条跳过记录摆成「已预填、等你放行」。
  const plan = buildApplyPlan(
    form('Are you authorized to work in the country in which this job is based?', YES_NO),
    {} as never,
    { fillEmptyOnly: false } as never,
  );
  expect(plan.skipped[0]?.reason, '前置条件：这一题先被判成取决于岗位').toBe('JOB_DEPENDENT');
  return {
    ...plan,
    skipped: plan.skipped.map((skip) => ({ ...skip, reason: 'PREFILLED_NEEDS_CONFIRMATION' as const, prefill: 'Yes' })),
  };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('审计视图', () => {
  it('不记成我们搞砸了，记成轮到用户', () => {
    const view = buildAuditView(prefilledPlan(), []);
    expect(view.blockedByUs, '预填好的题不是我们的问题').toBe(0);
    expect(view.awaitingUser).toBe(1);
  });

  it('那一行仍然出现在列表里，且不是 FAILED', () => {
    const [row] = buildAuditView(prefilledPlan(), []).rows;
    expect(row?.label).toBe('Are you authorized to work in the country in which this job is based?');
    expect(row?.status).not.toBe('FAILED');
    expect(row?.reason).toBe('PREFILLED_NEEDS_CONFIRMATION');
  });

  it('进必填分母、不进分子——放行仍是用户的一次动作', () => {
    const view = buildAuditView(prefilledPlan(), []);
    expect(view.requiredTotal).toBe(1);
    expect(view.requiredHandled).toBe(0);
  });
});

describe('计划摘要', () => {
  it('算「等你操作」，不算「我们认不出」', () => {
    const summary = summarizePlan(prefilledPlan());
    expect(summary.needsReview, 'needsReview 的定义是我们的能力不足').toBe(0);
    expect(summary.manual).toBe(1);
  });

  it('同样进分母不进分子', () => {
    const summary = summarizePlan(prefilledPlan());
    expect(summary.requiredTotal).toBe(1);
    expect(summary.requiredHandled).toBe(0);
  });
});

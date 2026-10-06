// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildApplyPlan } from '@edaix/apply-kernel/engine';
import type { ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';
import { labMockAnswers } from '../lab/labAnswers';

/**
 * 批测要替 mock 申请人**放行**乙档预填，而且必须放行我们自己挑的那一项。
 *
 * 2026-09-17 上午打开 `set-self-identification` / `set-work-authorization`
 * 之后，EEO 与工作授权题不再产出 MANUAL_ONLY／JOB_DEPENDENT，而是
 * PREFILLED_NEEDS_CONFIRMATION。而 lab 的 `ANSWERABLE_SKIP_REASONS` 不含这个码——
 * 于是这些题从「mock 答 Decline、写进去、算命中」变成**一题都不答**，
 * 批测的必填分子会凭空掉一截，看起来像是那天的四条工作流把事情做坏了。
 *
 * 更要紧的是该放行**什么**。用 mock 的猜测（DECLINE 那一套）等于绕开新代码：
 * 真正要量的恰恰是「engine 在这一页的选项里挑出来的那一项，是不是页面上真有、
 * 而且写得进去」。所以这里必须原样用 `skip.prefill`，
 * 生产里用户在授权弹框上点确认时放行的也正是同一个字符串。
 */

const YES_NO = ['Yes', 'No'];

function form(label: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label>
    <input type="radio" id="o${index}" name="g" value="${index}">`).join('')}</form>`;
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
      signature: { path: 'p', index: 0 } as never,
      choice: { control: 'radio', options: inputs.map((element, index) => ({ element, label: options[index]! })) },
    }],
  } as never;
}

/**
 * 2026-09-21 起 EEO 等档案里亲手填的值直接写，只有按岗位地点推断的工作授权还走
 * PREFILLED_NEEDS_CONFIRMATION；2026-09-23 起连那一档也直接写了，引擎眼下不再产出这个码。
 * lab 的放行逻辑不变、仍要守住：夹具先让这一题照常判成「取决于岗位」，再把那条跳过记录摆成
 * 「已预填、等你放行」（预填值是页面上真有的那一项原文）。
 */
function prefilled() {
  const descriptor = form('Are you authorized to work in the country in which this job is based?', YES_NO);
  const built = buildApplyPlan(descriptor, {} as never, { fillEmptyOnly: false } as never);
  expect(built.skipped[0]?.reason, '前置条件：这一题先被判成取决于岗位').toBe('JOB_DEPENDENT');
  const plan = {
    ...built,
    skipped: built.skipped.map((skip) => ({ ...skip, reason: 'PREFILLED_NEEDS_CONFIRMATION' as const, prefill: 'Yes' })),
  };
  return { descriptor, plan };
}

describe('lab 放行乙档预填', () => {
  it('不再整题跳过', () => {
    const { descriptor, plan } = prefilled();
    expect(labMockAnswers(descriptor, plan).answers).toHaveLength(1);
  });

  it('放行的是 engine 挑的那一项原文，不是 mock 的 Decline', () => {
    const { descriptor, plan } = prefilled();
    const [answer] = labMockAnswers(descriptor, plan).answers;
    expect(answer?.value).toBe('Yes');
  });

  it('报告里单独成一档，好在批测里与猜出来的答案分开数', () => {
    const { descriptor, plan } = prefilled();
    expect(labMockAnswers(descriptor, plan).report[0]).toMatchObject({
      category: 'tier-b-prefill',
      skipReason: 'PREFILLED_NEEDS_CONFIRMATION',
    });
  });

  it('关掉 selfIdentification 开关时连预填也不放行', () => {
    const { descriptor, plan } = prefilled();
    expect(labMockAnswers(descriptor, plan, { selfIdentification: false }).answers).toHaveLength(0);
  });
});

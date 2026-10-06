import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { createBundledApplyPolicy } from '../src/policy';
import type { ApplyFormDescriptor } from '../src/contracts';
import { createScanRoot } from '../src/scanRoot';

/**
 * 推荐人 / 紧急联系人栏由 `set-other-person` 管辖。
 *
 * 为什么做成能力位而不是直接放开：这一栏问的不是用户自己，填它需要一份
 * 「这些人是谁」的数据。没有数据源就放开，等于让无锚点的标签正则把申请人
 * **本人**的资料写进推荐人栏，面板还显示绿色"已填"（见 engine.ts 该守卫头注）。
 * 所以出厂默认 false、行为与从前逐字相同；有他人数据源的部署（lab 有 mock 的）
 * 打开这一位，其余守卫一条都不放松。
 *
 * 两条路都要管：档案计划与**经审阅的答案**。答案那条路此前完全没有这道守卫——
 * 能力位关着的时候它照样能写进推荐人栏，这里把两边钉成一致。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function referencesForm(): ApplyFormDescriptor {
  document.body.innerHTML = `
    <form id="f">
      <label for="refs">References (Name, Company, and Contact Info)</label>
      <textarea id="refs" name="references"></textarea>
    </form>`;
  const container = document.getElementById('f') as HTMLFormElement;
  const element = document.getElementById('refs') as HTMLTextAreaElement;
  return {
    vendor: 'bamboohr',
    root: createScanRoot(container, []),
    fields: [
      {
        kind: 'textarea',
        element,
        key: null,
        label: 'References (Name, Company, and Contact Info)',
        required: false,
        confidence: 0.75,
        signature: { core: 'refs', labelHint: 'references' },
      },
    ],
  } as ApplyFormDescriptor;
}

const ANSWER = 'Jordan Sample, Example Corp, jordan.sample@example.com';

describe('set-other-person', () => {
  it('ships false, so the bundled policy behaves exactly as before', () => {
    expect(createBundledApplyPolicy().capabilities['set-other-person']).toBe(false);
  });

  it('refuses a referee field in the profile plan when the capability is absent', () => {
    const plan = buildApplyPlan(referencesForm(), { fullName: 'Taylor Example' });
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped.map((skip) => skip.reason)).toContain('OTHER_PERSON');
  });

  it('refuses a reviewed answer for a referee field too, unless the capability is on', () => {
    const form = referencesForm();
    const answers = [{ questionId: 'q0', element: form.fields[0]!.element, value: ANSWER }];

    const refused = buildAnswerPlan(form, answers);
    expect(refused.entries).toHaveLength(0);
    expect(refused.skipped.map((skip) => skip.reason)).toContain('OTHER_PERSON');

    const allowed = buildAnswerPlan(form, answers, {
      capabilities: { 'set-other-person': true },
    });
    expect(allowed.entries.map((entry) => entry.value)).toEqual([ANSWER]);
  });

  it('plans the referee field once a deployment declares it has other-person data', () => {
    const plan = buildApplyPlan(
      referencesForm(),
      { fullName: 'Taylor Example' },
      { capabilities: { 'set-other-person': true } },
    );
    // 本人档案里没有推荐人这一项，所以它落到"认不出键"那一档而不是被类别拦掉：
    // 闸开了之后这一栏由答案层作答，而不是被静默丢掉。
    expect(plan.skipped.map((skip) => skip.reason)).not.toContain('OTHER_PERSON');
  });
});

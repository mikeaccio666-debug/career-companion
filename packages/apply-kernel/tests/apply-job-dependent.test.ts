import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { isJobDependentField } from '../src/dict/guards';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * `JOB_DEPENDENT` 的**接线**测试。
 *
 * 这条守卫此前是死代码：枚举（`contracts.ts`）、错误文案键（`errorText.ts`）、
 * 中英两套 i18n 三处登记齐全，**引擎里一次都没被调用过**。发现它的是 Codex 的
 * 立项决策单 §59，我方实测证实：`grep JOB_DEPENDENT src/` 在 `engine.ts` 零命中，
 * 而 `summarizePlan` 的 else 分支会把它算进 `needsReview` —— 正是它要区分开的那个。
 *
 * 这是本项目**第三次**同一形状的问题（蜜罐守卫、推荐人守卫、这条）：写好了、
 * 单测全绿、但没有任何调用方。所以这个文件断言的不是正则本身好不好，而是
 * **"引擎真的会走到这条守卫"**，并且有反向探针保证它不会退化成空转。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function planFor(labelsAndIds: ReadonlyArray<[label: string, id: string]>, profile: ApplyProfileDraft) {
  document.body.innerHTML = `<form id="application-form">${labelsAndIds
    .map(([label, id]) => `<label for="${id}">${label}</label><input id="${id}" type="text" required />`)
    .join('')}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    profile,
  );
}

describe('JOB_DEPENDENT 接线', () => {
  /** 真实申请表上的问法，逐条来自 Greenhouse / Lever / Workable 的常见自定义题。 */
  it.each([
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require sponsorship for employment visa status?',
    'Do you require visa sponsorship?',
    'Are you willing to relocate?',
    'What are your salary expectations?',
    'Expected salary',
    'What is your notice period?',
    'When can you start?',
    '你是否需要签证担保？',
    '期望薪资',
    '最早可入职时间',
  ])('把「%s」判成 JOB_DEPENDENT，而不是 LOW_CONFIDENCE', (label) => {
    const plan = planFor([[label, 'q1']], { email: 'a@b.co' });
    const item = plan.skipped.find((entry) => entry.label.startsWith(label.slice(0, 12)));
    expect(item, '这个字段根本没进 skipped').toBeDefined();
    expect(
      item?.reason,
      '被 LOW_CONFIDENCE 吃掉了 —— 用户会以为是我们没认出来，等下个版本就好了',
    ).toBe('JOB_DEPENDENT');
  });

  /**
   * 反向探针。没有这几条，把正则写成 `/./` 也会让上面全绿——而那会把整张表
   * 都标成"这题取决于具体岗位"，比不判还糟。
   */
  it.each([
    ['First Name', 'first_name'],
    ['Email', 'email'],
    ['LinkedIn URL', 'q_linkedin'],
    // 教育/经历每一段都有起止日期。收窄正则的全部意义就在这里：
    // 光秃秃的 "Start date" 绝不能被判成岗位相关题。
    ['Start date', 'q_start'],
    ['City', 'q_city'],
    ['Current location', 'q_loc'],
  ])('不把普通字段「%s」误判成 JOB_DEPENDENT', (label, id) => {
    expect(isJobDependentField(label)).toBe(false);
    const plan = planFor([[label, id]], { email: 'a@b.co' });
    expect(plan.skipped.find((entry) => entry.label === label)?.reason).not.toBe('JOB_DEPENDENT');
  });

  it('汇总把它单独计数，不并进 needsReview', () => {
    const plan = planFor(
      [
        ['Are you legally authorized to work in the US?', 'q_auth'],
        ['Do you require visa sponsorship?', 'q_visa'],
        ['Tell us about a project you are proud of', 'q_free'],
        ['Email', 'email'],
      ],
      { email: 'a@b.co' },
    );
    const summary = summarizePlan(plan);

    expect(summary.jobDependent, '两道岗位相关题没有被单独计数').toBe(2);
    expect(
      summary.needsReview,
      '岗位相关题被并进了 needsReview —— 这正是它要区分开的那个语义',
    ).toBe(1);
    expect(summary.willFill).toBe(1);
  });

  /**
   * 这些题多半是必填的 knockout 题，所以必须进必填分母、但**不能**进分子：
   * 说"必填 4/4 已就绪"而其实用户还没答工签，等于告诉他可以提交了。
   */
  it('岗位相关的必填题进分母不进分子', () => {
    const plan = planFor(
      [
        ['Email', 'email'],
        ['Are you legally authorized to work in the US?', 'q_auth'],
      ],
      { email: 'a@b.co' },
    );
    const summary = summarizePlan(plan);
    expect(summary.requiredTotal).toBe(2);
    expect(summary.requiredHandled, '把用户还没答的 knockout 题算成已就绪').toBe(1);
  });
});

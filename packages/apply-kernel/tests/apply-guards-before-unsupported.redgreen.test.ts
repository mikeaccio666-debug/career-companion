import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 守卫顺序的**红绿证**：三道防线必须先于 `unsupported` 分支。
 *
 * 背景（2026-08-15 能力盘点 41-能力地图「choice 字段绕过三道守卫」）：
 * `engine.ts` 的字段循环里，`kind === 'unsupported'` 的 `continue` 排在蜜罐 /
 * 推荐人 / JOB_DEPENDENT 三道守卫**之前**。单选与复选今天被分类成 unsupported
 * （`dict/controls.ts` 归 'choice' → 解释器降级），于是这类字段**从不经过任何
 * 一道防线**。
 *
 * 今天无害——反正一个都不写。但接上 choice 写入的那一刻，它就是现成的漏洞：
 * 蜜罐 checkbox、推荐人 radio、岗位相关单选会被直接写进宿主表单。
 *
 * 这是本项目同一形状问题的第四次：前三次（蜜罐守卫、推荐人守卫、
 * JOB_DEPENDENT）都是"写好了、单测全绿、没有调用方"，其中蜜罐那次实测后果是
 * Workday 的 beecatcher 以 0.75 置信度命中 portfolioUrl 被真写入、UI 还显示
 * "已填"（2026-08-01）。所以本文件锁的不是正则好不好，而是**顺序本身**：
 * 守卫的判决必须盖过"这类控件我们填不了"。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const EMPTY_PROFILE: ApplyProfileDraft = {};

/** 造一张含 choice 控件（radio/checkbox）的表；这类控件今天一律落 unsupported。 */
function planForChoice(fields: ReadonlyArray<{ label: string; id: string; type: 'radio' | 'checkbox' }>) {
  document.body.innerHTML = `<form id="application-form">${fields
    .map((f) => `<label for="${f.id}">${f.label}</label><input id="${f.id}" name="${f.id}" type="${f.type}" />`)
    .join('')}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    EMPTY_PROFILE,
  );
}

function reasonFor(plan: ReturnType<typeof buildApplyPlan>, label: string): string | undefined {
  return plan.skipped.find((item) => item.label === label)?.reason;
}

/**
 * 守卫的判决只有配上"这个字段确实没进写入计划"才算数。
 *
 * 按 label 逐字段查，不查 `entries` 总长度：将来一次扫多个字段时，
 * 总长度为 0 会因为别的字段没进计划而偶然成立，锁不住这一条
 * （审查意见 PR #6 [中]，2026-08-16）。
 */
function expectGuardedOut(
  plan: ReturnType<typeof buildApplyPlan>,
  label: string,
  reason: string,
): void {
  expect(
    plan.entries.map((entry) => entry.label),
    `「${label}」进了写入计划——守卫判了 ${reason} 却仍要写，等于没守`,
  ).not.toContain(label);
  expect(
    reasonFor(plan, label),
    `「${label}」的原因码不是 ${reason}——守卫没盖过 unsupported 分支`,
  ).toBe(reason);
}

describe('守卫先于 unsupported（choice 不许绕过防线）', () => {
  it('蜜罐 checkbox：判 HONEYPOT，不是 UNSUPPORTED_CONTROL', () => {
    // beecatcher 是 Workday 实测命中的那个蜜罐名（2026-08-01 端到端复现）。
    const label = 'Leave this field blank';
    const plan = planForChoice([{ label, id: 'beecatcher', type: 'checkbox' }]);
    expectGuardedOut(plan, label, 'HONEYPOT');
  });

  it('推荐人 radio：判 OTHER_PERSON，不是 UNSUPPORTED_CONTROL', () => {
    const label = 'Reference LinkedIn Profile';
    const plan = planForChoice([{ label, id: 'reference_linkedin', type: 'radio' }]);
    expectGuardedOut(plan, label, 'OTHER_PERSON');
  });

  it('岗位相关单选：判 JOB_DEPENDENT，不是 UNSUPPORTED_CONTROL', () => {
    // 真实申请表上最常见的 radio 形态：签证赞助、工作授权。
    // JOB_DEPENDENT 与 UNSUPPORTED_CONTROL 对用户含义相反：
    // 一个是"只能你自己答"，一个是"再等等我们会支持"。
    const label = 'Will you now or in the future require sponsorship for employment visa status?';
    const plan = planForChoice([{ label, id: 'sponsorship', type: 'radio' }]);
    expectGuardedOut(plan, label, 'JOB_DEPENDENT');
  });

  it('三类守卫同表并存：各判各的，且一个都不进写入计划', () => {
    // 单字段用例里 `entries` 恰好为空，证明力弱；这里三类同扫一张表，
    // 逐字段确认——任何一类被误放进计划都会红。
    const honeypot = 'Leave this field blank';
    const referral = 'Reference LinkedIn Profile';
    const jobDependent = 'Will you now or in the future require sponsorship for employment visa status?';
    const plan = planForChoice([
      { label: honeypot, id: 'beecatcher', type: 'checkbox' },
      { label: referral, id: 'reference_linkedin', type: 'radio' },
      { label: jobDependent, id: 'sponsorship', type: 'radio' },
    ]);
    expectGuardedOut(plan, honeypot, 'HONEYPOT');
    expectGuardedOut(plan, referral, 'OTHER_PERSON');
    expectGuardedOut(plan, jobDependent, 'JOB_DEPENDENT');
  });

  it('干净的 choice 控件仍按 choice 语义收口（守卫不许误伤）', () => {
    const label = 'Which team are you most interested in?';
    const plan = planForChoice([{ label, id: 'team_choice', type: 'radio' }]);
    // 无档案数据可选 → CHOICE_NO_DATA（"你自己选一下"），而不是三道守卫里的任何一条。
    expect(reasonFor(plan, label)).toBe('CHOICE_NO_DATA');
    expect(plan.entries).toHaveLength(0);
  });

  it('反向探针：文本控件的守卫判决不受本次改动影响', () => {
    // 顺序调整不许改变已有行为——文本字段的三道守卫是既有测试锁死的面。
    document.body.innerHTML = `<form id="application-form">
      <label for="ref_name">Reference Name</label><input id="ref_name" type="text" />
      <label for="salary">What are your salary expectations?</label><input id="salary" type="text" />
    </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      EMPTY_PROFILE,
    );
    expectGuardedOut(plan, 'Reference Name', 'OTHER_PERSON');
    expectGuardedOut(plan, 'What are your salary expectations?', 'JOB_DEPENDENT');
  });
});

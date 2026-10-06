import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { isManualOnlyControl, isUserOnlyQuestion } from '../src/dict/guards';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * `USER_ONLY` 的**接线**测试（P4-15，2026-09-21）。
 *
 * 认不出档案键的控件从前一律报 LOW_CONFIDENCE，浮层写成「没把握，没敢填」。对作文 / 开放题
 * （Why us / Tell us about / Describe / Additional information）和「与这家公司的历史」
 * （是否在这里工作过、申请过、有没有亲友在职）这不是实话：答案不在任何档案键里，不是我们
 * 没认出来，是只有用户能答。说成没把握，用户会等下个版本；说成「这题只有你能答」，他才会去答，
 * 或者在复核面板里让 AI 起草（P3-13 只对这类 textarea 出按钮，所以它还必须登记为可审阅）。
 *
 * 与 JOB_DEPENDENT 那份一样，这里断言的是**引擎真的会走到这条守卫**，并有反向探针保证它
 * 不会退化成「整张表都只有你能答」。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

type Control = 'textarea' | 'text' | 'select';

function controlHtml(label: string, id: string, control: Control): string {
  const tag =
    control === 'textarea'
      ? `<textarea id="${id}" required></textarea>`
      : control === 'select'
        ? `<select id="${id}" required><option value="">Select…</option><option value="yes">Yes</option><option value="no">No</option></select>`
        : `<input id="${id}" type="text" required />`;
  return `<label for="${id}">${label}</label>${tag}`;
}

function planFor(controls: ReadonlyArray<[label: string, id: string, control: Control]>, profile: ApplyProfileDraft) {
  document.body.innerHTML = `<form id="application-form">${controls
    .map(([label, id, control]) => controlHtml(label, id, control))
    .join('')}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    profile,
  );
}

const PROFILE: ApplyProfileDraft = { email: 'a@b.co' };

describe('USER_ONLY 接线：作文 / 开放题（textarea）', () => {
  it.each([
    'Why do you want to work at Acme?',
    'Why are you interested in this role?',
    'Tell us more about your experience with distributed systems',
    'Describe a project you are proud of',
    'Additional information',
    'Is there anything else you would like us to know?',
    'What interests you about Acme?',
    'In your own words, what makes you a good fit?',
    '为什么想加入我们？',
    '请介绍一下你自己',
    '补充说明',
  ])('把「%s」判成 USER_ONLY，而不是 LOW_CONFIDENCE', (label) => {
    const plan = planFor([[label, 'q1', 'textarea']], PROFILE);
    const item = plan.skipped.find((entry) => entry.label.startsWith(label.slice(0, 12)));
    expect(item, '这个字段根本没进 skipped').toBeDefined();
    expect(
      item?.reason,
      '被 LOW_CONFIDENCE 吃掉了 —— 用户会以为是我们没认出来，等下个版本就好了',
    ).toBe('USER_ONLY');
  });

  it('同一句问在单行文本框上不算作文：仍是 LOW_CONFIDENCE', () => {
    // 单行框上的 "why" 多半是别的东西；作文只认 textarea。
    const plan = planFor([['Why did you leave your last job?', 'q1', 'text']], PROFILE);
    expect(plan.skipped.find((entry) => entry.label.startsWith('Why did you'))?.reason).toBe('LOW_CONFIDENCE');
  });
});

describe('USER_ONLY 接线：与这家公司的历史（不限控件）', () => {
  it.each<[label: string, control: Control]>([
    ['Have you previously worked for Acme?', 'select'],
    ['Have you ever applied to Acme before?', 'text'],
    ['Are you a current or former employee of Acme?', 'select'],
    ['Have you interviewed with us in the past?', 'select'],
    ['你是否曾在本公司工作过？', 'select'],
    ['是否申请过本公司的其他职位', 'text'],
  ])('把「%s」判成 USER_ONLY', (label, control) => {
    const plan = planFor([[label, 'q1', control]], PROFILE);
    const item = plan.skipped.find((entry) => entry.label.startsWith(label.slice(0, 12)));
    expect(item, '这个字段根本没进 skipped').toBeDefined();
    expect(item?.reason).toBe('USER_ONLY');
  });
});

describe('反向探针：不把普通字段判成「只有你能答」', () => {
  /**
   * 没有这几条，把正则写成 `/./` 也会让上面全绿——而那会把整张表都标成
   * "这题只有你能答"，比不判还糟：用户会跳过本来我们能填的栏。
   */
  it.each<[label: string, control: Control]>([
    ['First Name', 'text'],
    ['Email', 'text'],
    ['LinkedIn URL', 'text'],
    ['Start date', 'text'],
    ['Years of experience with Kubernetes', 'text'],
    ['T-shirt size', 'text'],
    ['Dietary requirements', 'textarea'],
    ['Mailing address', 'textarea'],
    ['Work authorization', 'select'],
  ])('「%s」不是 USER_ONLY', (label, control) => {
    expect(isUserOnlyQuestion({ text: label, kind: control === 'text' ? 'input' : control })).toBe(false);
    const plan = planFor([[label, 'q1', control]], PROFILE);
    expect(plan.skipped.find((entry) => entry.label === label)?.reason).not.toBe('USER_ONLY');
  });

  it('空标签不算', () => {
    expect(isUserOnlyQuestion({ text: '', kind: 'textarea' })).toBe(false);
    expect(isUserOnlyQuestion({ text: '   ', kind: 'textarea' })).toBe(false);
  });
});

describe('汇总', () => {
  it('USER_ONLY 计入 manual（下一步在用户手上），不并进 needsReview（我们的能力不足）', () => {
    const plan = planFor(
      [
        ['Why do you want to work at Acme?', 'q1', 'textarea'],
        ['T-shirt size', 'q2', 'text'],
      ],
      PROFILE,
    );
    const summary = summarizePlan(plan);
    expect(plan.skipped.map((entry) => entry.reason).sort()).toEqual(['LOW_CONFIDENCE', 'USER_ONLY']);
    expect(summary.manual).toBe(1);
    expect(summary.needsReview).toBe(1);
  });
});

/** 用户名／账号名与 LGBTQ+ 两类的归位（2026-09-21 Discord 页实测两者都报成「没把握，没敢填」）。 */
describe('用户名与 LGBTQ+', () => {
  it("What's your Discord username? → 只有你能答（单行文本也算）", () => {
    expect(isUserOnlyQuestion({ text: "What's your Discord username?", kind: 'text' })).toBe(true);
    expect(isUserOnlyQuestion({ text: 'Slack handle', kind: 'text' })).toBe(true);
    expect(isUserOnlyQuestion({ text: 'Preferred name', kind: 'text' })).toBe(false);
  });

  it('LGBTQ+ / 性取向 / 跨性别 归入自我认同（只能由你本人填写），不再是「没把握」', () => {
    expect(isManualOnlyControl({ text: 'I consider myself a member of the LGBTQ+ community.', inputType: 'checkbox', autocomplete: null })).toBe(true);
    expect(isManualOnlyControl({ text: 'Sexual orientation', inputType: null, autocomplete: null })).toBe(true);
  });
});

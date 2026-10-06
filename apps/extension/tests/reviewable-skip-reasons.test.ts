/**
 * 引擎产出的、「答案该由用户给」的原因码必须全部登记成可审阅，否则那道题会从
 * 面板上整个消失。
 *
 * 这是本仓第四次同一形状的问题（蜜罐守卫、推荐人守卫、JOB_DEPENDENT 三次都是
 * 「枚举与文案齐全、调用方一次都没接」），所以这里用「漏登记必须变红」的方式把
 * 接线本身锁死，而不是只测某一条码。
 */

import { describe, expect, it } from 'vitest';

import { REVIEWABLE_SKIP_REASONS } from '../lib/kernelFiller';

/**
 * 引擎在「这题得用户答」这一类里会产出的全部原因码。
 * 新增一个而不登记，下面那条就红。
 */
const USER_ANSWERABLE_REASONS = [
  'JOB_DEPENDENT',
  'NO_VALUE',
  'LOW_CONFIDENCE',
  'MANUAL_ONLY',
  'CHOICE_NO_DATA',
  // 乙档：已按档案值预填、等用户放行。它是 MANUAL_ONLY 的更窄分支，同样要问用户，
  // 只是面板可以先把值预选上——漏登记等于让整道题从面板消失。
  'PREFILLED_NEEDS_CONFIRMATION',
  // 「这题只有你能答」（作文 / 公司历史）：不登记，用户既看不到题，也拿不到 AI 起草按钮。
  'USER_ONLY',
] as const;

describe('可审阅的跳过原因', () => {
  for (const reason of USER_ANSWERABLE_REASONS) {
    it(`${reason} 登记为可审阅`, () => {
      expect(REVIEWABLE_SKIP_REASONS.has(reason)).toBe(true);
    });
  }

  it('不该问用户的那几类不在其中', () => {
    // 蜜罐填了作废整份申请，推荐人栏写进本人资料会显示成绿色「已填」——
    // 这两类**不提示**，提示本身就是引导用户去做一件有害的事。
    for (const reason of ['HONEYPOT', 'OTHER_PERSON'] as const) {
      expect(REVIEWABLE_SKIP_REASONS.has(reason)).toBe(false);
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 必填分母。
 *
 * 竞品调研 2026-08-01：Jobright 面板显示 `19/21`，量的是**当前表单的必填字段
 * 完成度**；我们此前只有 `3 可填 / 1 缺资料 / 4 待复核 / 16 需手动` 这种平铺
 * 计数——每个数字都对，合起来仍然回答不了用户唯一关心的问题："还差多少才能
 * 提交"。
 *
 * 这个文件锁死分母的**口径**，因为口径错了比没有更糟：一个虚高的"已就绪"会
 * 让人以为可以交了。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function plan(html: string, profile: ApplyProfileDraft) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出这个表单，后面全是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    profile,
  );
}

describe('必填分母', () => {
  it('分母只数必填项，选填项不进分母', () => {
    const summary = summarizePlan(
      plan(
        `<label for="first_name">First Name</label><input id="first_name" type="text" required />
         <label for="email">Email</label><input id="email" type="email" required />
         <label for="phone">Phone</label><input id="phone" type="tel" />`,
        { firstName: 'Ada', email: 'ada@example.test', phone: '+1 555 0100' },
      ),
    );

    expect(summary.requiredTotal, '选填的 phone 被算进了分母').toBe(2);
    expect(summary.requiredHandled).toBe(2);
    // 分子分母之外，平铺计数照旧——两套数字互不干扰。
    expect(summary.willFill).toBe(3);
  });

  it('页面上本来就填好的必填项算已就绪，尽管我们没碰它', () => {
    const summary = summarizePlan(
      plan(
        `<label for="first_name">First Name</label><input id="first_name" type="text" value="Ada" required />
         <label for="email">Email</label><input id="email" type="email" required />`,
        { firstName: 'Ada', email: 'ada@example.test' },
      ),
    );

    // first_name 会以 NOT_EMPTY 进 skipped，但对"能不能提交"而言它已经完成。
    expect(summary.willFill).toBe(1);
    expect(summary.requiredTotal).toBe(2);
    expect(
      summary.requiredHandled,
      '把已经填好的必填项算成未完成，会让一张填了一半的表看起来比实际更糟',
    ).toBe(2);
  });

  it('我们填不了的必填项进分母但不进分子', () => {
    const summary = summarizePlan(
      plan(
        `<label for="email">Email</label><input id="email" type="email" required />
         <label for="resume">Resume</label><input id="resume" type="file" required />
         <label for="why">Why us?</label><textarea id="why" required></textarea>`,
        { email: 'ada@example.test' },
      ),
    );

    expect(summary.requiredTotal, '文件与自由问答都是必填，必须进分母').toBe(3);
    expect(
      summary.requiredHandled,
      '把填不了的必填项算成已就绪，等于告诉用户可以交了',
    ).toBe(1);
  });

  /**
   * 标了 required 的蜜罐**不能**进分母。
   *
   * 它永远不该被填，所以永远进不了分子；算进分母就等于把面板永久卡在 3/4，
   * 而用户会跑去页面上找那个不存在的第 4 项 —— 唯一符合描述的就是那个隐藏陷阱
   * 字段。分母是我们刚上线的主指标，不能把用户往坑里引。"他人字段"（推荐人/
   * 紧急联系人）同理。
   */
  it('标了 required 的蜜罐不进分母', () => {
    const summary = summarizePlan(
      plan(
        `<label for="email">Email</label><input id="email" type="email" required />
         <label for="website">Please leave this field blank</label>
         <input id="website" name="beecatcher" type="text" required />`,
        { email: 'ada@example.test' },
      ),
    );
    expect(summary.requiredTotal, '蜜罐把分母顶高了，用户永远到不了 100%').toBe(1);
    expect(summary.requiredHandled).toBe(1);
  });

  it('标了 required 的"他人"字段不进分母', () => {
    const summary = summarizePlan(
      plan(
        `<label for="email">Email</label><input id="email" type="email" required />
         <label for="ref">Reference email</label><input id="ref" type="email" required />`,
        { email: 'ada@example.test' },
      ),
    );
    expect(summary.requiredTotal).toBe(1);
    expect(summary.requiredHandled).toBe(1);
  });

  it('一张全是选填的表不显示分母（分母为 0）', () => {
    const summary = summarizePlan(
      plan(`<label for="email">Email</label><input id="email" type="email" />`, {
        email: 'ada@example.test',
      }),
    );
    expect(summary.requiredTotal).toBe(0);
    expect(summary.requiredHandled).toBe(0);
  });

  it('aria-required 与原生 required 同等对待', () => {
    const summary = summarizePlan(
      plan(
        `<label for="email">Email</label><input id="email" type="email" aria-required="true" />`,
        { email: 'ada@example.test' },
      ),
    );
    expect(summary.requiredTotal, 'aria-required 被忽略了 —— 大量 React 表单只写这个').toBe(1);
    expect(summary.requiredHandled).toBe(1);
  });
});

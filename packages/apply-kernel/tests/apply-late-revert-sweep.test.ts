import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 写入后的延时复检（CAP-AF-055 第三件）。
 *
 * C6 只在写入后**同步**回读一次。受控框架（React/Vue 的受控输入、以及
 * "传完简历宿主自己解析回填"这条最常见的联动）会在一两百毫秒后把我们写的值
 * 改回去或覆盖掉——那一刻我们已经报了成功，面板显示「已填 12/12」，用户点提交
 * 才发现表单是空的或是别人的值。
 *
 * 这是「回读判决 + 可审计」最难堪的失败形态：**不是没填上，是我们说了谎**。
 *
 * ## 为什么做成"全轮写完后扫一次"，而不是每字段各等一次
 *
 * 真实的重渲染/回填发生在我们那一串写入**之后**，是一次性的；每字段各等 N 毫秒
 * 会把总耗时乘以字段数，直接撞上刚立的注入预算（CAP-AF-065：50 字段 <60ms）。
 * 批量扫只增加 O(1) 延迟。
 *
 * ## 与 WRITE_REVERTED 的区别
 *
 * `WRITE_REVERTED` = 写完当场就没了（同步回读即发现）。
 * `LATE_REVERTED` = 当时对、稍后被改回去。两者的下一步动作不同：前者要换值形态
 * 重试（CAP-AF-038 的阶梯），后者说明宿主有异步权威，重试同一个值只会再被覆盖。
 * 混成一个码，重试阶梯就会在第二种情况下空转。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = { firstName: 'Ada', email: 'ada@example.test' };

function mount(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="email">Email</label><input id="email" type="email" />
    </form>`;
}

async function run(options: {
  lateRecheckMs?: number;
  onSweepDelay?: () => void;
} = {}) {
  mount();
  const root = greenhouseAdapter.resolveRoot(document)!;
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
    PROFILE,
  );
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    ...(options.lateRecheckMs === undefined ? {} : { lateRecheckMs: options.lateRecheckMs }),
    // 注入的等待器：测试不真等，等待期间执行"宿主的异步动作"。
    lateRecheckDelay: async () => {
      options.onSweepDelay?.();
    },
  });
  return {
    summary,
    byKey: Object.fromEntries(
      summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]),
    ) as Record<string, string>,
  };
}

describe('延时复检扫描', () => {
  it('值在写入后被宿主改回去 → LATE_REVERTED，不再谎报成功', async () => {
    const { summary, byKey } = await run({
      lateRecheckMs: 200,
      onSweepDelay: () => {
        // 受控框架把它渲染回空——同步回读时还是我们的值，之后才被改。
        document.querySelector<HTMLInputElement>('#first_name')!.value = '';
      },
    });
    expect(
      byKey['firstName'],
      '写完当时对、之后被改回去，却仍报成功——面板会说「已填」而表单是空的',
    ).toBe('LATE_REVERTED');
    expect(byKey['email'], '没被动过的字段被误伤').toBe('ok');
    expect(summary.filled, 'filled 没把晚退回的那条扣掉').toBe(1);
  });

  it('值被宿主覆盖成别的内容，同样判 LATE_REVERTED', async () => {
    const { byKey } = await run({
      lateRecheckMs: 200,
      onSweepDelay: () => {
        // "传完简历宿主自己解析回填"的形状：值还在，但不是我们写的那个。
        document.querySelector<HTMLInputElement>('#first_name')!.value = 'Augusta';
      },
    });
    expect(byKey['firstName']).toBe('LATE_REVERTED');
  });

  it('反向探针：没人动过时全部保持成功', async () => {
    const { summary, byKey } = await run({ lateRecheckMs: 200 });
    expect(byKey['firstName']).toBe('ok');
    expect(byKey['email']).toBe('ok');
    expect(summary.filled).toBe(2);
  });

  it('反向探针：不配延时复检时行为与今天逐字一致（默认关）', async () => {
    mount();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      PROFILE,
    );
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });
    // 写完之后把值改掉：没开复检就不该发现，行为与接这条能力之前完全相同。
    document.querySelector<HTMLInputElement>('#first_name')!.value = '';
    expect(summary.filled).toBe(2);
    expect(summary.results.every((result) => result.ok)).toBe(true);
  });

  /**
   * 扫描只针对**本轮判定成功**的条目。已经失败的条目不该被复检改写成另一个码
   * ——那会把 WRITE_REVERTED / HOST_REJECTED 这些更具体的诊断洗成 LATE_REVERTED。
   */
  it('反向探针：已经失败的条目不被复检覆盖', async () => {
    mount();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      PROFILE,
    );
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      lateRecheckMs: 200,
      // 宿主判 email 无效：那条本轮就是 HOST_REJECTED，不该被复检改码。
      readHostValidation: (element) =>
        (element as HTMLInputElement).id === 'email' ? { ariaInvalid: 'true' } : {},
      lateRecheckDelay: async () => {
        document.querySelector<HTMLInputElement>('#email')!.value = '';
      },
    });
    const email = summary.results.find((result) => result.key === 'email');
    expect(email?.ok).toBe(false);
    expect(
      email && !email.ok ? email.reason : undefined,
      'HOST_REJECTED 被复检洗成了 LATE_REVERTED',
    ).toBe('HOST_REJECTED');
  });
});

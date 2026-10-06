import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyWriteResult } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 逐字段结算的本地流（CAP-AF-063 的中段屏）。
 *
 * 面板此前只有两种状态：一轮开始前什么都没有，一轮跑完之后一次性摊开 38 行。
 * 中间那几秒——我们正在一栏一栏地改用户的表单——界面上是空的。用户看不见我们
 * 在做什么，也看不出卡在哪一栏；而这几秒恰恰是他最想知道"它到底动了没有"的时候。
 *
 * 这条流只走**本地**：它带着宿主标签，和 `AuditView` 同源、同边界，永远不过桥、
 * 不进回执、不进遥测（ReceiptFieldOutcome 的 `label?: never` 就是这条边界的类型化）。
 *
 * ## 为什么是"差分广播"而不是在每个赋值点插一行
 *
 * runner 里 `results[index] = …` 有四十来处，还有 C6 回读与延时复检这两段
 * **事后改写**同一条结果的阶段。逐点插钩子既漏得到处都是，又会把通知塞进
 * 写入事务的中途。所以这里只在几个静默检查点广播"自上次以来有哪些格子变了"，
 * 通知之后 runner 原有的那串栅栏照常重跑一遍。
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

type Settled = { index: number; state: string };

const state = (result: ApplyWriteResult): string => (result.ok ? 'ok' : result.reason);

async function run(options: {
  lateRecheckMs?: number;
  onSweepDelay?: () => void;
  onFieldSettled?: (index: number, result: ApplyWriteResult) => void;
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
    ...(options.onFieldSettled === undefined ? {} : { onFieldSettled: options.onFieldSettled }),
    lateRecheckDelay: async () => {
      options.onSweepDelay?.();
    },
  });
  return { plan, summary };
}

describe('逐字段结算流', () => {
  it('每一条结果在整轮返回之前就交出去', async () => {
    const settled: Settled[] = [];
    // 复检的等待窗口是一轮之内的一个真实时刻：跑到这里时 C6 回读已经结束，
    // 而 `runApplyPlan` 还没返回。这两条此刻已经广播过，才叫"逐字段"。
    let atLateRecheck: Settled[] = [];
    const { summary } = await run({
      lateRecheckMs: 200,
      onFieldSettled: (index, result) => settled.push({ index, state: state(result) }),
      onSweepDelay: () => { atLateRecheck = [...settled]; },
    });

    expect(
      atLateRecheck,
      '一轮跑完才一次性交出全部结果——中段屏还是空的，用户看不见我们在填哪一栏',
    ).toEqual([{ index: 0, state: 'ok' }, { index: 1, state: 'ok' }]);
    expect(summary.filled).toBe(2);
  });

  it('延时复检把成功改判时，同一格再广播一次', async () => {
    // 当时对、稍后被宿主改回去。只广播第一次结算，中段屏会一直挂着那个绿勾，
    // 而事实已经变了——这正是「不是没填上，是我们说了谎」的那一档。
    const settled: Settled[] = [];
    await run({
      lateRecheckMs: 200,
      onFieldSettled: (index, result) => settled.push({ index, state: state(result) }),
      onSweepDelay: () => {
        document.querySelector<HTMLInputElement>('#first_name')!.value = '';
      },
    });

    expect(settled.filter((item) => item.index === 0).map((item) => item.state))
      .toEqual(['ok', 'LATE_REVERTED']);
    expect(settled.filter((item) => item.index === 1).map((item) => item.state)).toEqual(['ok']);
  });

  it('每一格都广播过，且最后一次广播与整轮结论逐条一致', async () => {
    const last = new Map<number, string>();
    const { summary } = await run({
      lateRecheckMs: 200,
      onFieldSettled: (index, result) => last.set(index, state(result)),
      onSweepDelay: () => {
        document.querySelector<HTMLInputElement>('#first_name')!.value = '';
      },
    });

    expect([...last.keys()].sort()).toEqual(summary.results.map((_, index) => index));
    expect(summary.results.map((result, index) => last.get(index))).toEqual(
      summary.results.map((result) => state(result)),
    );
  });

  it('反向探针：不接这条流时行为与今天逐字一致', async () => {
    const { summary } = await run({ lateRecheckMs: 200 });
    expect(summary.results.map(state)).toEqual(['ok', 'ok']);
    expect(summary.filled).toBe(2);
  });

  /**
   * 通知是我方浮层的一个纯粹的显示出口。它抛出来不得改变任何一次宿主写入的结局
   * ——否则"给用户看进度"这件锦上添花的事，就有能力毁掉一份真实的申请。
   */
  it('通知抛错不改变整轮结论', async () => {
    let calls = 0;
    const { summary } = await run({
      lateRecheckMs: 200,
      onFieldSettled: () => {
        calls += 1;
        throw new Error('panel blew up');
      },
    });
    expect(summary.results.map(state)).toEqual(['ok', 'ok']);
    expect(summary.filled).toBe(2);
    // 抛过一次就不再叫它：坏掉的出口不该在剩下的每个检查点上反复抛。
    expect(calls).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkActiveCapability } from '../../src/grant';
import type { ApplyPlan } from '../../src/contracts';
import { fieldSignature } from '../../src/fieldIdentity';
import { runApplyPlan } from '../../src/runner';
import { createScanRoot } from '../../src/scanRoot';
import { createUndoJournal } from '../../src/undo';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

/**
 * S0 · 写入授权绝不活过 `runApplyPlan` 返回。
 *
 * 决策 17（负责人 2026-08-01）把授权的活动窗口从"仅同步段"放宽到"覆盖有界的
 * 控件交互"，因为实测证明下拉物理上做不到同步完成：在真实 Greenhouse 页面上
 * 派发 mousedown→mouseup→click 后，**同一个 tick 内 0 个选项，一个宏任务后
 * 244 个**。原来那句"绝不跨越任何一帧"恰好禁掉了这件事。
 *
 * 放宽之后，**"授权不能活过这次运行"就成了唯一还在兜底的那条线**，所以它必须
 * 被机械锁死，而不是靠 `finally` 的代码审查。这个文件只断言这一条，且穷举
 * runApplyPlan 的每一条出口：正常完成、策略拒绝、计划过期、以及中途抛异常。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function planFor(input: HTMLInputElement, fingerprint = 's0-lifetime'): ApplyPlan {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    fingerprint,
    fillEmptyOnly: true,
    entries: [
      {
        kind: 'text',
        required: false,
        key: 'email',
        label: 'Email',
        value: 'alex@example.com',
        element: input,
        order: 0, confidence: 1,
        signature: fieldSignature(input, root),
      },
    ],
    skipped: [],
  };
}

/** The only question this file asks: can anything still write with it? */
function stillActive(authority: Parameters<typeof checkActiveCapability>[0]): boolean {
  return checkActiveCapability(authority, 'set-text').ok;
}

function freshInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  return input;
}

describe('S0 · 授权生命周期', () => {
  it('正常完成后授权立即失效', async () => {
    const plan = planFor(freshInput());
    const auth = testAuthority(plan.fingerprint);

    const result = await runApplyPlan({
      plan,
      auth,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(result.filled, '前置条件：这一轮根本没写入，断言等于空转').toBe(1);
    expect(stillActive(auth), '运行返回后授权仍然可用').toBe(false);
  });

  it('策略关闭导致早退时也失效', async () => {
    const plan = planFor(freshInput());
    const auth = testAuthority(plan.fingerprint);

    await runApplyPlan({
      plan,
      auth,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: { ...testApplyPolicy(), enabled: false },
    });

    expect(stillActive(auth), '早退路径漏掉了 releaseAuthority').toBe(false);
  });

  it('计划指纹不符导致拒绝时也失效', async () => {
    const plan = planFor(freshInput());
    // 用户复核的是另一份计划——授权绑定的指纹对不上。
    const auth = testAuthority('a-different-plan');

    await runApplyPlan({
      plan,
      auth,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(stillActive(auth)).toBe(false);
  });

  it('中途抛异常时也失效（finally 而不是顺序执行到底）', async () => {
    const input = freshInput();
    const plan = planFor(input);
    const auth = testAuthority(plan.fingerprint);
    const journal = createUndoJournal();
    // 让写入路径在半途炸掉：日志签发 ticket 时抛。
    vi.spyOn(journal, 'record').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(
      runApplyPlan({
        plan,
        auth,
        journal,
        root: createScanRoot(document.body, []),
        policy: testApplyPolicy(),
      }),
    ).rejects.toThrow();

    expect(stillActive(auth), '异常路径把授权漏在了活动态').toBe(false);
  });

  /**
   * 反向探针。没有这一条，把 `stillActive` 写成恒 false 也会让上面全绿——
   * 而那正是最危险的假绿：一条声称"授权已失效"却根本不会失败的闸门。
   */
  it('运行期间授权确实是活动的（否则以上断言全是空转）', async () => {
    const input = freshInput();
    const plan = planFor(input);
    const auth = testAuthority(plan.fingerprint);
    let activeDuringRun: boolean | null = null;

    // 宿主在收到我们写入派发的 input 事件时窥探一次——那一刻正在运行段内。
    input.addEventListener('input', () => {
      activeDuringRun ??= stillActive(auth);
    });

    await runApplyPlan({
      plan,
      auth,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(activeDuringRun, '运行期间授权就不是活动的，说明探针测错了东西').toBe(true);
    expect(stillActive(auth)).toBe(false);
  });

  it('host mutation checkpoint 尚未结束时，调用方 authority 已转入 runner-private 对象', async () => {
    const input = freshInput();
    const plan = planFor(input);
    const auth = testAuthority(plan.fingerprint);
    let checkpointStarted = false;
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });

    const run = runApplyPlan({
      plan,
      auth,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
      mutationDeliveryCheckpoint: () => {
        checkpointStarted = true;
        return checkpoint;
      },
    });

    expect(checkpointStarted).toBe(true);
    expect(stillActive(auth), 'checkpoint await 期间原 authority 仍可写').toBe(false);
    releaseCheckpoint();
    await run;
  });
});

import { describe, expect, it } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';

import { LATE_RECHECK_SCHEDULE_MS, startLateRecheck } from '../lib/lateRecheck';

/**
 * 整轮之后的复核排程（见 `lateRecheck.ts` 头注）。
 *
 * 这里量的是排程本身：问几次、什么时候停、结论没变时闭不闭嘴。至于「我们填的值
 * 还在不在」怎么判，那在内核（`apply-recheck-after-run.test.ts`）。
 */

function view(filled: number, statuses: readonly string[]): AuditView {
  return {
    rows: statuses.map((status, order) => ({
      key: null,
      label: '',
      required: true,
      status,
      reason: null,
      attemptedValue: null,
      resolvedOptionText: null,
      element: null,
      confidence: null,
      order,
    })),
    filled,
    requiredTotal: statuses.length,
    requiredHandled: filled,
    needsAttention: statuses.length - filled,
    blockedByUs: statuses.length - filled,
    awaitingUser: 0,
  } as unknown as AuditView;
}

const FILLED_BOTH = view(2, ['FILLED', 'FILLED']);
const ONE_REVERTED = view(1, ['LATE_REVERTED', 'FILLED']);

/** 不真等：记下每次等了多久，立刻放行。 */
function fakeClock() {
  const waited: number[] = [];
  return {
    waited,
    wait: async (ms: number) => { waited.push(ms); },
  };
}

describe('整轮之后的复核排程', () => {
  it('宿主稍后清空 → 排程问到时把修订过的视图交给面板', async () => {
    const clock = fakeClock();
    const applied: AuditView[] = [];
    let asked = 0;
    startLateRecheck({
      // 第一次问的时候解析还没回来；第二次回来了，把一行清空。
      current: FILLED_BOTH,
      recheck: () => (++asked >= 2 ? ONE_REVERTED : FILLED_BOTH),
      apply: (next) => { applied.push(next); },
      stopped: () => false,
      schedule: [10, 20],
      wait: clock.wait,
    });
    await flush();

    expect(clock.waited, '没按注入的排程等').toEqual([10, 20]);
    expect(applied, '复核改判之后面板没收到修订视图——那句「已填」会一直挂着').toEqual([ONE_REVERTED]);
  });

  it('反向探针：结论没变就不去打扰面板', async () => {
    const clock = fakeClock();
    let applies = 0;
    startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => FILLED_BOTH,
      apply: () => { applies += 1; },
      stopped: () => false,
      schedule: [10, 20, 30],
      wait: clock.wait,
    });
    await flush();

    expect(clock.waited).toEqual([10, 20, 30]);
    expect(applies, '结论一个字没变却重绘了面板').toBe(0);
  });

  it('反向探针：同一个改判只交一次，不每轮重绘', async () => {
    const clock = fakeClock();
    const applied: AuditView[] = [];
    startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => ONE_REVERTED,
      apply: (next) => { applied.push(next); },
      stopped: () => false,
      schedule: [10, 20, 30],
      wait: clock.wait,
    });
    await flush();

    expect(applied).toHaveLength(1);
  });

  it('叫停之后不再问，也不再交', async () => {
    const clock = fakeClock();
    let asked = 0;
    let applies = 0;
    const cancel = startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => { asked += 1; return ONE_REVERTED; },
      apply: () => { applies += 1; },
      stopped: () => false,
      schedule: [10, 20, 30],
      wait: clock.wait,
    });
    cancel();
    await flush();

    expect(asked, '叫停之后还在读页面').toBe(0);
    expect(applies).toBe(0);
  });

  it('面板拆了（stopped）就停在那一轮，不把节点画回去', async () => {
    const clock = fakeClock();
    let asked = 0;
    let dismissed = false;
    startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => { asked += 1; return ONE_REVERTED; },
      apply: () => { dismissed = true; },
      stopped: () => dismissed,
      schedule: [10, 20, 30],
      wait: clock.wait,
    });
    await flush();

    expect(asked, '面板拆掉之后还在继续问').toBe(1);
  });

  it('排程走完就停——不常驻轮询', async () => {
    const clock = fakeClock();
    let asked = 0;
    startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => { asked += 1; return FILLED_BOTH; },
      apply: () => {},
      stopped: () => false,
      schedule: [10, 20],
      wait: clock.wait,
    });
    await flush();

    expect(asked).toBe(2);
    expect(clock.waited).toEqual([10, 20]);
  });

  it('复核抛异常时停下，绝不改判——它是只读的显示路', async () => {
    const clock = fakeClock();
    let applies = 0;
    startLateRecheck({
      current: FILLED_BOTH,
      recheck: () => { throw new Error('页面没了'); },
      apply: () => { applies += 1; },
      stopped: () => false,
      schedule: [10, 20],
      wait: clock.wait,
    });
    await flush();

    expect(applies).toBe(0);
    expect(clock.waited, '复核抛了之后还在接着等下一轮').toEqual([10]);
  });

  it('默认排程有尽头，且集中在结算后的头二十秒', () => {
    expect(LATE_RECHECK_SCHEDULE_MS.length).toBeGreaterThan(0);
    expect([...LATE_RECHECK_SCHEDULE_MS].sort((a, b) => a - b)).toEqual([...LATE_RECHECK_SCHEDULE_MS]);
    // 间隔是累进的：Lever 实测约十二秒，最后一次要晚于它，否则这条能力对那一家
    // 正好不起作用。同时也不能没完没了——常驻轮询就成了读用户的页面一整天。
    const total = LATE_RECHECK_SCHEDULE_MS.reduce((sum, gap) => sum + gap, 0);
    expect(total).toBeGreaterThan(12_000);
    expect(total).toBeLessThanOrEqual(30_000);
  });
});

/** 把注入的等待器造出的那一串 microtask 放干净。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 手势路也要接迟到复查（源码形状闸）。
 *
 * CAP-AF-055 的整轮后复查（lateRecheck.ts，插件 #55）只接在了 mission 那条路上，而真实用户
 * 不用 mission、走的是 `runGestureFill`。于是 Lever 那种结算后约十二秒才把地点清空的宿主回写，
 * 在用户真正用的那条路上照样让一行永远停在「已填」——#55 要修的那个谎，在这条路上还在。
 *
 * 复查模块本身在 late-recheck.test.ts 里有行为测试；这一条只钉「手势路调用了它，并且在这一页
 * 翻走、或开了新的一轮时停下」。
 */
const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');

describe('手势路的迟到复查', () => {
  const from = content.indexOf('const runGestureFill = async');
  const to = content.indexOf('const showFace = ', from);
  const gestureFill = content.slice(from, to);

  it('跑完一轮就开始复查，两张显示面一起更新', () => {
    expect(from).toBeGreaterThan(0);
    const start = gestureFill.indexOf('startLateRecheck({');
    expect(start, '手势路没有接迟到复查').toBeGreaterThan(0);
    const call = gestureFill.slice(start, start + 600);
    expect(call).toContain('recheck: audit.recheck,');
    // 终局单子一律经 settledProgress：加上页面上还空着、浮层没认出的必填（2026-10-04）。
    expect(call).toContain('dockHandle?.update(settledProgress(view));');
    expect(call).toContain('panel.update(view);');
  });

  it('这一页翻走、或用户开了新的一轮，就停下', () => {
    const start = gestureFill.indexOf('startLateRecheck({');
    expect(gestureFill.slice(start, start + 600)).toContain('stopped: () => gestureRunSerial !== serial,');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「继续到下一页」在内容脚本里接对了没有（源码形状闸）。
 *
 * 浮层、控制器、内核判据各自有行为测试；这一条只钉三处接线——它们错了，各自的测试照样全绿，
 * 而产品上的症状是「按钮永远不出现」或「翻页后还挂着上一页的审计」。
 */
const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');

function between(start: string, end: string): string {
  const from = content.indexOf(start);
  expect(from, start).toBeGreaterThan(0);
  const to = content.indexOf(end, from);
  expect(to, end).toBeGreaterThan(from);
  return content.slice(from, to);
}

describe('继续到下一页的接线', () => {
  const gestureFill = between('const runGestureFill = async', 'const showFace = ');

  it('新的一轮一开始就放下上一页：在第一个 await 之前 disarm', () => {
    const disarm = gestureFill.indexOf('wizardAdvance.disarm();');
    expect(disarm).toBeGreaterThan(0);
    expect(disarm).toBeLessThan(gestureFill.indexOf('await '));
  });

  it('填完就 arm，而且在浮层画收尾那一幕之前——那一幕画的时候就要问能按哪一颗', () => {
    const arm = gestureFill.indexOf('wizardAdvance.arm({');
    expect(arm).toBeGreaterThan(0);
    expect(arm).toBeLessThan(gestureFill.indexOf('dockHandle?.beginRun(progress);'));
    // 收尾经 closeGestureRun（2026-09-24：AI 代答还在起草时等它的结局）。
    expect(arm).toBeLessThan(gestureFill.indexOf('closeGestureRun({'));
    // 用户自己在网站上翻了页：浮层收掉上一页。
    expect(gestureFill.slice(arm, arm + 400)).toContain("dockHandle?.retireRun('PAGE_CHANGED');");
  });

  it('浮层拿到的处理器就是这一个控制器：字样交给它，按键交给「翻过去并接着填」', () => {
    const mount = between('dockHandle = mountAutofillDock(dock, {', 'onAutofill: (event, shadowRoot) => {');
    expect(mount).toContain('label: () => wizardAdvance.label(),');
    // 事件在点击派发的当下原样交过去——凭证与翻页那一侧的判定都要同步验它来自我们的 shadow。
    expect(mount).toContain('const pending = advanceThenFill(event, shadowRoot);');
    const compose = between('const advanceThenFill = createAdvanceThenFill({', 'dockHandle = mountAutofillDock(dock, {');
    expect(compose).toContain('advance: (event, shadowRoot) => wizardAdvance.advance(event, shadowRoot),');
    // 2026-09-28 起连填由调用方交进 runGestureFill（fillToReview()，见 fill-to-review-wiring.test.ts）。
    expect(compose).toContain("fillNextPage: (proof) => { void runGestureFill(proof, fillToReview(), 'AFTER_ADVANCE'); },");
  });

  it('翻过去之后那一轮：等新一页出来再扫；等不到就照实说，不报成错误', () => {
    const scan = gestureFill.indexOf("mode === 'AFTER_ADVANCE'");
    expect(scan).toBeGreaterThan(0);
    expect(gestureFill.slice(scan, scan + 200)).toContain('scanWhenReady({ scanOnce, budgetMs: NEXT_PAGE_SCAN_BUDGET_MS })');
    const empty = gestureFill.indexOf("if (mode === 'AFTER_ADVANCE') {");
    expect(empty).toBeGreaterThan(0);
    expect(gestureFill.slice(empty, empty + 200)).toContain("'ADVANCED_EMPTY'");
  });

  it('换脸、让给助手、让给顶层帧、顶层让给嵌着申请表的 iframe（2026-10-04），四处撤浮层都先 disarm（翻页与提交两样一起）', () => {
    expect(content.match(/wizardAdvance\.disarm\(\);\s*submitter\.disarm\(\);\s*dockHandle\?\.dismiss\(\);/gu)?.length).toBe(4);
  });
});

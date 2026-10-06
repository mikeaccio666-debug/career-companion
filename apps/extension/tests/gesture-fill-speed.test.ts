// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';

import { mountAutofillDock } from '../lib/autofillDock';
import { dockProgressWhileFilling } from '../lib/autofillDockProgress';

/**
 * 手势路的速度（2026-09-23 在测试台上量的：Greenhouse 一页 10.9 秒，其中浮层有 10.9 秒只写着
 * 「正在准备…」；档案 2.3 秒、简历问询 1 秒，都排在开填之前）。
 *
 * 这里钉三件事：填写途中单子逐栏亮起来、途中重画不闪也不跳回顶上、开填之前那几样东西
 * 提前取并且一起等。
 */

const row = (label: string, status: string, reason: string | null = null) =>
  ({ key: null, label, required: true, status, reason, attemptedValue: 'v', resolvedOptionText: null }) as AuditView['rows'][number];
const view = (rows: AuditView['rows']): AuditView =>
  ({ rows, filled: 0, requiredTotal: rows.length, requiredHandled: rows.filter((item) => item.status === 'FILLED').length, needsAttention: 0 }) as AuditView;

describe('填写途中的那一份单子', () => {
  it('还没轮到的画成「待填写」，已确认的亮成「已填好」，计划期交还用户的照实画', () => {
    const progress = dockProgressWhileFilling('gesture-1', view([
      row('First Name', 'FILLED'),
      row('Country', 'FAILED', 'ABORTED'),
      row('Why us?', 'NEEDS_MANUAL', 'USER_ONLY'),
      row('Phone', 'REJECTED', 'HOST_REJECTED'),
    ]));
    expect(progress.rows.map((item) => [item.label, item.state])).toEqual([
      ['First Name', 'CONFIRMED'], ['Country', 'PENDING'], ['Why us?', 'MANUAL'], ['Phone', 'FAILED'],
    ]);
    // 待填写的那一行不带原因、不带定位：它还没有结论。
    expect(progress.rows[1]).toEqual({ label: 'Country', required: true, done: false, state: 'PENDING' });
  });

  it('没有 phase：浮层把它当还在跑，不画收尾那一幕', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    handle.beginPreparing();
    const progress = dockProgressWhileFilling('gesture-1', view([row('First Name', 'FILLED'), row('Country', 'FAILED', 'ABORTED')]));
    expect('phase' in progress).toBe(false);
    handle.beginRun(progress);
    expect(handle.runState()).toBe('RUNNING');
    // 2026-09-23 新浮层：途中是深色进度卡（正在填写 N / M），不是总结卡。
    expect(handle.sceneRoot()?.querySelector('.sum'), '途中没有总结').toBeNull();
    expect(handle.sceneRoot()?.textContent).toContain('正在填写');
    expect(handle.sceneRoot()?.querySelector('.act-count')?.textContent).toBe('1 / 2');
  });
});

describe('途中重画', () => {
  it('同一轮途中每刷新一次，节点原地更新：进度条的每一段不重新挂载，也不把看到的位置滚回顶上', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    handle.beginPreparing();
    const rows = Array.from({ length: 12 }, (_, index) => row(`Question ${index}`, 'FAILED', 'ABORTED'));
    handle.beginRun(dockProgressWhileFilling('gesture-1', view(rows)));
    const scroller = handle.sceneRoot()?.querySelector<HTMLElement>('.route-main');
    const segments = Array.from(handle.sceneRoot()?.querySelectorAll('.seg') ?? []);
    expect(segments).toHaveLength(12);
    scroller!.scrollTop = 120;
    rows[0] = row('Question 0', 'FILLED');
    handle.update(dockProgressWhileFilling('gesture-1', view(rows)));
    expect(handle.sceneRoot()?.querySelector<HTMLElement>('.route-main')).toBe(scroller);
    expect(Array.from(handle.sceneRoot()?.querySelectorAll('.seg') ?? [])).toEqual(segments);
    expect(scroller?.scrollTop).toBe(120);
  });
});

describe('面板打开的回调', () => {
  it('点开与挂上时自动打开都叫一次，关上再打开再叫一次', () => {
    const doc = document.implementation.createHTMLDocument();
    let opened = 0;
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, onPanelOpen: () => { opened += 1; } }, doc);
    expect(opened).toBe(0);
    handle.openPanel();
    handle.openPanel();
    expect(opened, '已经开着就不再叫').toBe(1);
    handle.closePanel();
    handle.openPanel();
    expect(opened).toBe(2);
    const autoDoc = document.implementation.createHTMLDocument();
    let autoOpened = 0;
    mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, autoOpen: true, onPanelOpen: () => { autoOpened += 1; } }, autoDoc);
    expect(autoOpened).toBe(1);
  });
});

/** 内容脚本里的接线（源码形状闸，与 dock-next-step-wiring 同一写法）。 */
const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
function between(start: string, end: string): string {
  const from = content.indexOf(start);
  expect(from, start).toBeGreaterThan(0);
  const to = content.indexOf(end, from);
  expect(to, end).toBeGreaterThan(from);
  return content.slice(from, to);
}

describe('开填之前那几样东西', () => {
  const gestureFill = between('const runGestureFill = async', 'const showFace = ');

  it('档案在要授权之前就出发，不排在授权和扫描后面', () => {
    const profile = gestureFill.indexOf('const profilePending = takeProfile(mode);');
    expect(profile).toBeGreaterThan(0);
    expect(profile).toBeLessThan(gestureFill.indexOf("await askWorker('DISCOVERY_AUTHORITY')"));
    expect(gestureFill, '不再单独排队等档案').not.toContain("await askWorker('PROFILE')");
  });

  it('档案、简历问询、答案记忆设置一起等', () => {
    const together = gestureFill.slice(gestureFill.indexOf('await Promise.all(['));
    expect(together.slice(0, 400)).toContain('profilePending,');
    expect(together.slice(0, 400)).toContain('takeResume(mode)');
    expect(together.slice(0, 400)).toContain('answerMemorySettings(),');
  });

  it('填写途中逐栏交给浮层，收尾用同一个 runId', () => {
    expect(gestureFill).toContain('onProgress: showWhileFilling,');
    const runIds = gestureFill.match(/const runId = `gesture-\$\{Date\.now\(\)\}`;/g) ?? [];
    expect(runIds, '只起一个 runId：途中与收尾是同一轮').toHaveLength(1);
    expect(gestureFill.indexOf('const runId')).toBeLessThan(gestureFill.indexOf('onProgress: showWhileFilling,'));
  });

  // 2026-09-24：绑着任务的页（READY）也走手势路，所以「手势路那几张脸」= NO_MISSION 或 READY（gestureFace）。
  it('手势路那张脸一挂上就预取档案，打开面板时再补一次档案与简历问询', () => {
    expect(content).toContain("const gestureFace = dock.kind === 'READY' || (dock.kind === 'UNAVAILABLE' && dock.reason === 'NO_MISSION');");
    const mount = between('dockHandle = mountAutofillDock(dock, {', 'if (gestureFace) warmProfile();');
    expect(mount).toContain('if (gestureFace) { warmProfile(); warmResume(); }');
    // 在面板里改了资料，预取的那一份作废。
    expect(mount).toContain('saveProfileV2: (patch) => directory.saveProfileV2(patch).finally(() => { profileWarm = null; }),');
  });
});

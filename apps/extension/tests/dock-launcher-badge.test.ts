// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';
import { DOCK_CSS } from '../lib/dock/css';

/**
 * 收起按钮上的橙色数字（2026-09-24 负责人截图：数字被切掉一角、压在帆船上）。
 *
 * 根因：角标挂在圆按钮里面，而按钮是 `overflow:hidden` 的圆（悬停时是胶囊），角标在方框的右上角——正好落在圆外，
 * 被切掉；它又往里挪了 2px，压在帆船上。钉住：角标不在按钮里（按钮的圆、胶囊的边、进度环都切不到它），
 * 16px 的圆、11px 的标签字号，落在帆船右上方的圆边上，不压帆船、不出视口；收起、悬停展开成胶囊、闲着三种样子里
 * 都是同一个位置（它挂在收起按钮那一整条上，按钮往左长，它不动）。
 */
const ROWS: readonly AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' },
  { label: 'Why us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY' },
  { label: 'Salary?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY' },
];

function collapsedWithNeeds() {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
  handle.openPanel();
  handle.beginPreparing();
  handle.beginRun({ runId: 'r1', requiredQuestions: 3, requiredCompleted: 1, rows: ROWS, phase: 'SETTLED' } as never);
  handle.closePanel();
  const launcher = handle.launcherButton()!.closest<HTMLElement>('.launcher')!;
  return { handle, launcher };
}

const rule = (selector: string): string => new RegExp(`(?:^|\\n|\\})${selector.replace(/[.[\]']/g, (c) => `\\${c}`)}\\{([^}]*)\\}`).exec(DOCK_CSS)?.[1] ?? '';
const px = (declarations: string, property: string): number => Number(new RegExp(`(?:^|;)\\s*${property}:(-?[\\d.]+)px`).exec(declarations)?.[1]);

describe('收起按钮上的数字', () => {
  it('挂在收起按钮那一整条上，不在圆按钮里面：按钮的圆、胶囊的边与进度环都切不到它', () => {
    const { launcher, handle } = collapsedWithNeeds();
    const badge = launcher.querySelector<HTMLElement>('[data-badge]');
    expect(badge?.textContent).toBe('2');
    expect(badge?.parentElement).toBe(launcher);
    expect(handle.launcherButton()!.contains(badge!)).toBe(false);
    expect(badge?.getAttribute('aria-hidden'), '数字已经写在按钮的读屏名字里').toBe('true');
  });

  it('16px 的圆，11px 的标签字号，盖在按钮与它的焦点框上面，不挡点击', () => {
    const badge = rule('.l-badge');
    expect(px(badge, 'height')).toBe(16);
    expect(px(badge, 'min-width')).toBe(16);
    expect(px(badge, 'border-radius')).toBe(8);
    expect(badge).toContain('font-size:var(--fs-caption)');
    expect(Number(/z-index:(\d+)/.exec(badge)?.[1])).toBeGreaterThan(0);
    expect(badge).toContain('pointer-events:none');
  });

  it('落在帆船右上方的圆边上：不压帆船（24px 的帆船在 44px 圆的正中），不出视口', () => {
    const badge = rule('.l-badge');
    const size = px(badge, 'height');
    const top = px(badge, 'top');
    const right = px(badge, 'right');
    // 以圆按钮的左上角为原点：按钮 44px，角标贴着按钮那一条的右边与上边。
    const box = { left: 44 - right - size, top, right: 44 - right, bottom: top + size };
    const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    const fromMiddle = Math.hypot(center.x - 22, center.y - 22);
    expect(fromMiddle, '圆心落在圆边附近（半径 22）').toBeGreaterThanOrEqual(20);
    expect(fromMiddle).toBeLessThanOrEqual(26);
    // 帆船占 10..34 的方框，上半截只有中间那根桅杆（右上角是空的）：角标只许碰到那个方框右上角 4×4 以内的一小块。
    const overlapX = Math.max(0, Math.min(box.right, 34) - Math.max(box.left, 10));
    const overlapY = Math.max(0, Math.min(box.bottom, 34) - Math.max(box.top, 10));
    expect(overlapX).toBeLessThanOrEqual(4);
    expect(overlapY).toBeLessThanOrEqual(4);
    // 收起按钮离视口右边 12px：角标连白边（2px）也不出去。
    const launcherRight = px(rule('.launcher'), 'right');
    expect(launcherRight + right - 2).toBeGreaterThanOrEqual(4);
  });

  it('悬停展开成胶囊：数字还在同一个位置（胶囊往左长，角标挂在右边不动）；没有要你做的就没有数字', () => {
    const { launcher } = collapsedWithNeeds();
    launcher.dispatchEvent(new Event('pointerenter'));
    expect(launcher.dataset.expanded).toBe('true');
    expect(launcher.querySelector('[data-badge]')?.parentElement).toBe(launcher);
    const doc = document.implementation.createHTMLDocument();
    const idle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    expect(idle.launcherButton()!.closest('.launcher')!.querySelector('[data-badge]')).toBeNull();
  });
});

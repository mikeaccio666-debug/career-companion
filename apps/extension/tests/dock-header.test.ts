// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';

/**
 * 面板右上角的「收起」（2026-09-24 负责人：原来的图标读起来像「侧栏」，不像收起）。
 *
 * 钉住：图标是「往右收」的 »|——两道右尖括号撞上一道竖线，16px、画出来 1.5px 的线（与页头别的图标同一种线），
 * 没有「侧栏」那个方框；读屏与悬停提示都说「收起」；按了就收成右边那颗圆按钮。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const mount = () => {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
  handle.openPanel();
  const button = handle.sceneRoot()!.querySelector<HTMLButtonElement>('.collapse')!;
  return { handle, button };
};

describe('页头的「收起」', () => {
  it('读屏与悬停提示都说「收起」', () => {
    const { button } = mount();
    expect(button.getAttribute('aria-label')).toBe('收起');
    expect(button.title).toBe('收起');
  });

  it('图标是 »|：两道右尖括号加一道竖线，16px、线宽画出来 1.5px；不再是带竖线的方框', () => {
    const svg = mount().button.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('16');
    const drawn = (Number(svg.getAttribute('stroke-width')) * 16) / Number(svg.getAttribute('viewBox')?.split(' ')[2]);
    expect(drawn).toBeCloseTo(1.5, 5);
    expect(svg.querySelectorAll('rect'), '侧栏图标的那个方框').toHaveLength(0);
    const paths = Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d') ?? '');
    const chevrons = paths.filter((d) => /^m[\d.]+ [\d.]+ [\d.]+ [\d.]+-[\d.]+ [\d.]+$/.test(d));
    const bars = paths.filter((d) => /^M[\d.]+ [\d.]+v[\d.]+$/.test(d));
    expect(chevrons, '两道朝右的尖括号').toHaveLength(2);
    expect(bars, '右边一道竖线').toHaveLength(1);
    const barX = Number(/^M([\d.]+)/.exec(bars[0] ?? '')?.[1]);
    const chevronTips = chevrons.map((d) => { const [, x, , dx] = /^m([\d.]+) ([\d.]+) ([\d.]+)/.exec(d) ?? []; return Number(x) + Number(dx); });
    expect(Math.max(...chevronTips), '尖括号朝着竖线').toBeLessThan(barX);
  });

  it('按了就收起面板', () => {
    const { handle, button } = mount();
    button.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(handle.isOpen()).toBe(false);
  });
});

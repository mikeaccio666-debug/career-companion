// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';

/**
 * 「去第一项 / 下一处」（2026-09-28 负责人：填完之后那一幕只说一件事——还剩几项，一颗主按钮带他去第一项）。
 *
 * 按「需要你」列表的先后走：去那一栏（滚过去、把光标放进去，滚动停下之后在那一栏上亮一下——dock-field-flash.test.ts）；
 * 主按钮随之换成「下一处」。
 * 用户在网站上把那一题填了，那一行离开列表、总结的数跟着少——只看有没有值，不判断填得对不对。都办好了，主按钮是「提交」
 * （替不了用户按时写「去网站上提交」）。从前的「逐项处理」小卡不再有：面板不缩、不换一套界面。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (button: Element | null | undefined) => button?.dispatchEvent(new TrustedClick('click', { bubbles: true }));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function setup() {
  const why = document.createElement('textarea');
  const portfolio = document.createElement('input');
  document.body.append(why, portfolio);
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
  handle.openPanel();
  const rows: AutofillDockFieldRow[] = [
    { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Ada' },
    { label: 'Why do you want to work here?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY', target: why },
    { label: 'Portfolio', required: true, done: false, state: 'FAILED', reason: 'HOST_REJECTED', target: portfolio },
  ];
  handle.beginRun({ runId: 'fill-1', requiredCompleted: 1, requiredQuestions: 3, rows, phase: 'SETTLED' } as never);
  const root = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, why, portfolio, root };
}

describe('去第一项 / 下一处', () => {
  it('主按钮带他去第一项：滚过去、把光标放进那一栏；之后主按钮是「下一处」，面板不缩成小卡', () => {
    const { handle, why, root } = setup();
    expect(handle.primaryButton()?.textContent).toBe('去第一项');
    const focus = vi.spyOn(why, 'focus');
    click(handle.primaryButton());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(handle.primaryButton()?.textContent).toBe('下一处');
    expect(root.querySelector('.guide'), '「逐项处理」小卡已经不在了').toBeNull();
    expect(handle.isOpen()).toBe(true);
  });

  it('「下一处」按列表往下走，到了最后回到第一个还没办好的', () => {
    const { handle, why, portfolio } = setup();
    const toWhy = vi.spyOn(why, 'focus');
    const toPortfolio = vi.spyOn(portfolio, 'focus');
    click(handle.primaryButton());
    click(handle.primaryButton());
    expect(toPortfolio).toHaveBeenCalledTimes(1);
    click(handle.primaryButton());
    expect(toWhy).toHaveBeenCalledTimes(2);
  });

  it('用户在网站上填了那一题：那一行离开列表、总结的数跟着少；都填好了，主按钮是「去网站上提交」', () => {
    const { handle, why, portfolio, root } = setup();
    expect(root.querySelector('.sum-title')?.textContent).toBe('还有 2 项需要你');
    why.dispatchEvent(new TrustedClick('pointerdown', { bubbles: true, composed: true }));
    why.value = 'Because I like the mission';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.sum-title')?.textContent).toBe('还有 1 项需要你');
    const labels = [...root.querySelectorAll('[data-need-row] .need-q')].map((node) => node.textContent);
    expect(labels).toEqual(['Portfolio']);
    portfolio.value = 'https://example.test';
    portfolio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
    expect(handle.primaryButton()?.textContent, '这里没接提交：照实写「去网站上提交」').toBe('去网站上提交');
    // 他补上的那两项记在「其余已填好」里，写「你已填好」。
    expect([...root.querySelectorAll('.rrow .rv')].map((node) => node.textContent)).toContain('你已填好');
  });

  it('页面派发的点击什么都不做', () => {
    const { handle, why } = setup();
    const focus = vi.spyOn(why, 'focus');
    handle.primaryButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    expect(handle.primaryButton()?.textContent).toBe('去第一项');
  });
});

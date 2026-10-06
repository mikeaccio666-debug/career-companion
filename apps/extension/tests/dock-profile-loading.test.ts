// @vitest-environment happy-dom
import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mountAutofillDock } from '../lib/autofillDock';
import { DOCK_CSS } from '../lib/dock/css';

/**
 * 「我的资料」读取的那一段（2026-09-24 负责人截图：左边导航先画出来，右边的资料一到，左边整列又闪一次）。
 *
 * 根因：每次读到资料都 `buildRail()`——把左边十二个导航按钮全部拆掉重建，再给它们重放一遍入场动画（透明度从 0
 * 起、延迟 200ms 起）。左边本来就在屏幕上，于是一闪。改成：导航只建一次，之后只在值真的变了的地方改
 * （「6 段」「已开启」「✓」这种统计、选中哪一项）。
 *
 * 钉住：导航在资料到之前就在；资料到了，导航还是同一批节点、一个都不换，值没变的地方一个字都不动；
 * 「正在读取你的资料…」在右边那一栏上下左右都居中；右边的卡片从上到下一张接一张淡入上移（220ms、间隔 50ms、
 * 浮层的 EASE），减少动态时不错开。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const originalMatchMedia = window.matchMedia;
const originalAnimate = HTMLElement.prototype.animate;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  HTMLElement.prototype.animate = originalAnimate;
  document.body.innerHTML = '';
});

function mount(options: { reduced?: boolean } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: options.reduced === true && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  const animated: Array<{ node: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  HTMLElement.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, animationOptions?: number | KeyframeAnimationOptions) {
    animated.push({ node: this, frames: frames as Keyframe[], options: animationOptions as KeyframeAnimationOptions });
    return { cancel() {}, finish() {}, finished: Promise.resolve() } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
  const snapshot = fictionalProfileSnapshot('Example Person')!;
  let release: (() => void) | null = null;
  const directory = {
    profileV2: vi.fn(() => new Promise<{ ok: true; value: CandidateProfileSnapshotV2 }>((resolve) => {
      release = () => resolve({ ok: true, value: snapshot });
    })),
    saveProfileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
  };
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, directory }, document);
  const open = () => click(handle.entryButtons()[0]);
  const arrive = async () => { release?.(); await settle(); await settle(); };
  return { handle, open, arrive, animated, back: () => handle.backHome() };
}

describe('我的资料：读取的那一段', () => {
  it('左边导航在资料到之前就在；资料到了，还是同一批节点，没有重建、也不重放入场动画', async () => {
    const { handle, open, arrive, animated } = mount();
    open();
    const root = handle.profileRoot()!;
    const before = Array.from(root.querySelectorAll('.pf-nav'));
    expect(before.length, '十二个导航项先画出来').toBe(12);
    expect(root.querySelector('.pf-message')?.textContent).toContain('正在读取你的资料');
    animated.length = 0;
    await arrive();
    const after = Array.from(root.querySelectorAll('.pf-nav'));
    expect(after.length).toBe(12);
    expect(after.every((node, index) => node === before[index]), '同一批节点').toBe(true);
    expect(animated.filter((call) => call.node.closest('.pf-rail') !== null), '导航不重放入场动画').toEqual([]);
    expect(root.querySelector('[data-pf-sec="basic"]')).not.toBeNull();
  });

  it('再打开一次：资料到的时候，左边只在值真的变了的地方改——同样的资料一个字都不动', async () => {
    const { handle, open, arrive, back } = mount();
    open();
    await arrive();
    back();
    open();
    const rail = handle.profileRoot()!.querySelector('.pf-rail')!;
    const stats = Array.from(rail.querySelectorAll('.pf-nav-stat')).map((node) => node.textContent);
    expect(stats.some((stat) => stat !== ''), '上一次的统计还在（6 段、✓ 这种）').toBe(true);
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => { changes.push(...records); });
    observer.observe(rail, { subtree: true, childList: true, characterData: true, attributes: true });
    await arrive();
    await settle();
    observer.disconnect();
    expect(changes.filter((record) => record.type === 'childList'), '没有换掉任何节点').toEqual([]);
    expect(changes.map((record) => `${record.type}:${record.attributeName ?? ''}`), '值都没变，一处都不改').toEqual([]);
  });

  it('「正在读取你的资料…」在右边那一栏上下左右都居中', () => {
    const { handle, open } = mount();
    open();
    const message = handle.profileRoot()!.querySelector<HTMLElement>('.pf-message')!;
    expect(message.parentElement?.classList.contains('pf-scroll'), '摆在右边那一栏本身里，不在卡片列表里').toBe(true);
    const rule = /\.pf-message\{([^}]*)\}/.exec(DOCK_CSS)?.[1] ?? '';
    for (const declaration of ['position:absolute', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center']) {
      expect(rule, declaration).toContain(declaration);
    }
    expect(/\.pf-scroll\{[^}]*position:relative/.test(DOCK_CSS)).toBe(true);
  });

  it('资料到了：右边的卡片从上到下一张接一张淡入上移（220ms、间隔 50ms、浮层的 EASE）', async () => {
    const { handle, open, arrive, animated } = mount();
    open();
    animated.length = 0;
    await arrive();
    const cards = Array.from(handle.profileRoot()!.querySelectorAll('.pf-sec'));
    const reveals = animated.filter((call) => call.node.classList.contains('pf-sec'));
    expect(reveals.map((call) => call.node)).toEqual(cards);
    expect(reveals.map((call) => call.options.delay)).toEqual(cards.map((_, index) => index * 50));
    for (const call of reveals) {
      expect(call.options.duration).toBe(220);
      expect(call.options.easing).toBe('cubic-bezier(.32,.72,0,1)');
      expect(call.frames).toEqual([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }]);
    }
  });

  it('减少动态：卡片不错开，直接出来', async () => {
    const { handle, open, arrive, animated } = mount({ reduced: true });
    open();
    animated.length = 0;
    await arrive();
    expect(handle.profileRoot()!.querySelectorAll('.pf-sec').length).toBeGreaterThan(0);
    expect(animated.filter((call) => call.node.classList.contains('pf-sec'))).toEqual([]);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';

/**
 * 自动打开时别盖住网站右侧的主要按钮（2026-10-04，bench-1003「体验」：1440 宽的视口上，自动打开的浮层盖住了 BambooHR 的
 * 「Apply for This Job」——浮层失败时让他去点的正是它——、Greenhouse 的「Submit application」的右半截、Workday 第 2 页底部的
 * 「Save and Continue」）。
 *
 * 面板是钉在右边的一整条：页面上下一滚，这一条里的按钮迟早被它盖住，所以只量横向。这一条里有网站的主要按钮：收窄到它们
 * 右边（至少 320 像素宽）；收不下：这一次先不自动打开（收起按钮还在）。他自己点开的是原来的宽。没有 DOM 的文档里视口是
 * 1200 宽：面板 380 宽、右边留 10，左边沿在 810。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const action = (left: number, right: number): Element => ({
  getBoundingClientRect: () => ({ left, right, width: right - left, height: 40, top: 600, bottom: 640, x: left, y: 600 }),
}) as unknown as Element;

function mount(actions: readonly Element[] | (() => readonly Element[])) {
  vi.useFakeTimers();
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'READY' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    autoOpen: true,
    siteActions: typeof actions === 'function' ? actions : () => actions,
  }, doc);
  const panel = (handle.sceneRoot()!.getRootNode() as ShadowRoot).querySelector<HTMLElement>('.panel')!;
  return { handle, panel };
}

/** 页面安静下来（没有窗口的文档里没有 MutationObserver，只等那一小段）。 */
const settle = (): void => { vi.advanceTimersByTime(800); };

describe('自动打开：避开网站右侧的主要按钮', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('等页面安静下来再量，只量这一次；面板那一条里没有网站的按钮：照常打开，原来的宽', () => {
    const { handle, panel } = mount([action(600, 800)]);
    expect(handle.isOpen(), '挂上那一刻不量、不开').toBe(false);
    settle();
    expect(handle.isOpen()).toBe(true);
    expect(panel.style.width).toBe('380px');
  });

  it('按钮伸进面板那一条、右边还放得下 320 像素：收窄到按钮右边打开（Greenhouse 的「Submit application」）', () => {
    const { handle, panel } = mount([action(500, 850)]);
    settle();
    expect(handle.isOpen()).toBe(true);
    expect(panel.style.width).toBe(`${1200 - 10 - 850 - 12}px`);
  });

  it('放不下：这一次不自动打开（BambooHR 右栏的「Apply for This Job」）；他自己点开的是原来的宽', () => {
    const { handle, panel } = mount([action(900, 1100)]);
    settle();
    expect(handle.isOpen()).toBe(false);
    handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(handle.isOpen()).toBe(true);
    expect(panel.style.width).toBe('380px');
  });

  it('收窄打开过的：收起再点开，回到原来的宽', () => {
    const { handle, panel } = mount([action(500, 850)]);
    settle();
    handle.closePanel();
    handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(panel.style.width).toBe('380px');
  });

  it('看不出大小的、在面板右边外面的不算', () => {
    const { handle, panel } = mount([action(900, 900), action(1195, 1200)]);
    settle();
    expect(handle.isOpen()).toBe(true);
    expect(panel.style.width).toBe('380px');
  });

  it('网站的按钮晚出来（Workday、Point72）：挂上时还没有、安静下来时有了——按安静下来时的量，不先开再抽走', () => {
    let actions: readonly Element[] = [];
    const { handle } = mount(() => actions);
    vi.advanceTimersByTime(300);
    expect(handle.isOpen()).toBe(false);
    actions = [action(900, 1100)];
    settle();
    expect(handle.isOpen()).toBe(false);
  });

  it('等的这一会儿他自己点开又收起了：照他的来，不再自动打开', () => {
    const { handle } = mount([]);
    handle.sceneRoot()!.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    settle();
    expect(handle.isOpen()).toBe(false);
  });

  it('浮层被拆了：不再等', () => {
    const { handle } = mount([]);
    handle.dismiss();
    expect(() => settle()).not.toThrow();
  });
});

describe('接线：只在这一次自动打开时量；按钮由内核按通用说法找', () => {
  it('apply.content.ts', () => {
    const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
    expect(content).toContain('...(autoOpenNow && !wasOpen ? { siteActions: () => sitePrimaryActions({ document, isVisible: isRenderedControl }) } : {}),');
  });
});

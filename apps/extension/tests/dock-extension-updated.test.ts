// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountAutofillDock,
  type AutofillDockFieldRow,
  type AutofillDockHandle,
  type AutofillDockHandlers,
  type DockAdvanceOutcome,
  type DockSubmitOutcome,
} from '../lib/autofillDock';
import type { DockLocale } from '../lib/dock/copy';

/**
 * 插件更新（或重载、停用）之后的孤儿页（2026-10-03 前端体检 3e）。
 *
 * 商店会静默更新插件；开着的申请页上，旧的内容脚本还在、浮层还画着，却和插件断了线——每一颗要找插件的按钮都没有回音，
 * 从前一律说「暂时连不上 ArgoLand，稍后再试」，登录、退出登录、打开 ArgoLand 干脆一声不吭。内容脚本一发现（报到、按下去
 * 之前探一下）就叫 `extensionUpdated()`：浮层换成一张卡、一颗「刷新页面」，只认他本人的点击。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined): void => { node?.dispatchEvent(new TrustedClick('click', { bubbles: true })); };
const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

const ROWS: AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Ada' },
  { label: 'Email', required: true, done: true, state: 'CONFIRMED', value: 'ada@example.test' },
];

let mounted: AutofillDockHandle | null = null;
function mount(extra: Partial<AutofillDockHandlers> = {}, locale: DockLocale = 'zh'): AutofillDockHandle {
  mounted = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    locale,
    ...extra,
  }, document);
  mounted.openPanel();
  return mounted;
}
const card = (handle: AutofillDockHandle): HTMLElement | null =>
  handle.sceneRoot()?.querySelector<HTMLElement>('[data-face="updated"]') ?? null;
const reload = (handle: AutofillDockHandle): HTMLButtonElement | null =>
  handle.sceneRoot()?.querySelector<HTMLButtonElement>('[data-action="reload"]') ?? null;

afterEach(() => {
  mounted?.dismiss();
  mounted = null;
  vi.restoreAllMocks();
});

describe('插件已更新：浮层换成一张卡、一颗「刷新页面」', () => {
  it('中文：说清楚是怎么回事、该做什么', () => {
    const handle = mount();
    expect(card(handle)).toBeNull();
    handle.extensionUpdated();
    expect(text(card(handle))).toContain('ArgoLand.AI 已更新');
    expect(text(card(handle))).toContain('刷新这一页即可继续');
    expect(text(reload(handle))).toBe('刷新页面');
    expect(handle.autofillButton(), '「自动填写」不再摆着——按了也找不到插件').toBeNull();
  });

  it('英文界面说英文', () => {
    const handle = mount({}, 'en');
    handle.extensionUpdated();
    expect(text(card(handle))).toContain('ArgoLand.AI was updated');
    expect(text(card(handle))).toContain('Reload this page to continue');
    expect(text(reload(handle))).toBe('Reload page');
  });

  it('「刷新页面」只认他本人的点击：真点击刷新这一页，页面派发的点击什么都不做', () => {
    const handle = mount();
    handle.extensionUpdated();
    const reloadPage = vi.fn();
    vi.spyOn(window.location, 'reload').mockImplementation(reloadPage);
    reload(handle)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(reloadPage).not.toHaveBeenCalled();
    click(reload(handle));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('按了「自动填写」还在准备（问不到插件，开不了头）：这一轮放下，换成那张卡', () => {
    const handle = mount();
    click(handle.autofillButton());
    expect(handle.runState()).toBe('PREPARING');
    handle.extensionUpdated();
    expect(handle.runState()).toBe('IDLE');
    expect(card(handle)).not.toBeNull();
  });

  it('正在写的一轮不打断（进度卡和「停止」留着）；收了尾才换成那张卡', () => {
    const handle = mount({ onStop: () => {} });
    handle.beginRun({ runId: 'gesture-1', requiredCompleted: 1, requiredQuestions: 2, rows: ROWS });
    expect(handle.runState()).toBe('RUNNING');
    handle.extensionUpdated();
    expect(card(handle), '还在写').toBeNull();
    expect(handle.sceneRoot()?.querySelector('[data-action="stop"]') ?? null, '停止还在').not.toBeNull();
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(card(handle)).not.toBeNull();
  });

  it('按「提交」那一刻才发现：不播信封、不说「按不了」，换成那张卡', () => {
    let handle: AutofillDockHandle | null = null;
    const send = vi.fn((): Promise<DockSubmitOutcome> => {
      // 内容脚本在这一下里探到和插件断了线。
      handle?.extensionUpdated();
      return Promise.resolve('UNAVAILABLE');
    });
    handle = mount({ submission: { available: () => true, send } });
    handle.beginRun({ runId: 'gesture-1', requiredCompleted: 2, requiredQuestions: 2, rows: ROWS, phase: 'SETTLED' } as never);
    expect(text(handle.primaryButton())).toBe('提交');
    click(handle.primaryButton());
    expect(send).toHaveBeenCalledTimes(1);
    expect(card(handle)).not.toBeNull();
    expect(handle.sceneRoot()?.querySelector('[data-subfx]') ?? null, '信封没开始').toBeNull();
    const toast = (handle.sceneRoot()?.getRootNode() as ShadowRoot).querySelector('[data-toast]');
    expect(text(toast)).not.toContain('按不了');
  });

  it('按「继续到下一页」那一刻才发现：不转圈等翻页，换成那张卡', () => {
    let handle: AutofillDockHandle | null = null;
    const advance = vi.fn((): Promise<DockAdvanceOutcome> => {
      handle?.extensionUpdated();
      return Promise.resolve('UNAVAILABLE');
    });
    handle = mount({ nextStep: { label: () => 'Save and Continue', advance } });
    handle.beginRun({ runId: 'gesture-1', requiredCompleted: 2, requiredQuestions: 2, rows: ROWS, phase: 'SETTLED' } as never);
    click(handle.nextStepButton());
    expect(advance).toHaveBeenCalledTimes(1);
    expect(handle.runState()).not.toBe('RUNNING');
    expect(card(handle)).not.toBeNull();
  });
});

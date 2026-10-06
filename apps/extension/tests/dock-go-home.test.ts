// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandle } from '../lib/autofillDock';

/**
 * ⋯ 菜单里的「回到主页」（2026-09-24 负责人）。
 *
 * 钉住：它在「修改我的资料」之后、撤销上面那道分隔线之前；按了就回到首页，**不撤销**网页上写好的任何一栏
 * （undoAll 一次都不调），这一轮在浮层上到此为止（之后送来的一概不收，调用方借 onDismiss 停掉还没回来的 AI 答案）；
 * 再按「自动填写」就正常开新的一轮。动画：没有提交所以没有信封，底栏那颗深蓝的按钮飞到首页「自动填写」的位置，
 * 首页再一块一块淡进来。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));

const ROWS: readonly AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' },
  { label: 'Why us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY' },
];

const originalMatchMedia = window.matchMedia;
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function settled(extra: Record<string, unknown> = {}) {
  const autofills: MouseEvent[] = [];
  const handle: AutofillDockHandle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: (event: MouseEvent) => { autofills.push(event); },
    onOpenEntry: () => {},
    vendorLabel: 'Ashby',
    jobCard: () => ({ title: 'Mobile Engineer, Android', company: 'Ramp' }),
    ...extra,
  }, document);
  handle.openPanel();
  handle.beginPreparing();
  handle.beginRun({ runId: 'fill-1', requiredQuestions: 2, requiredCompleted: 1, rows: ROWS, phase: 'SETTLED' } as never);
  const undoAll = vi.fn();
  const onDismiss = vi.fn();
  handle.showAudit!({ rows: [{}] } as never, { canUndo: () => true, undoAll, onDismiss } as never);
  const root = handle.sceneRoot()!;
  const menu = () => root.querySelector<HTMLElement>('[data-pop="more"]')!;
  const openMenu = () => click(root.querySelector('[data-act="menu-more"]'));
  return { handle, root, menu, openMenu, undoAll, onDismiss, autofills };
}

describe('⋯ 菜单：回到主页', () => {
  it('在「修改我的资料」之后、撤销上面那道分隔线之前', () => {
    reduceMotion(true);
    const { menu, openMenu } = settled();
    openMenu();
    const order = Array.from(menu().children).map((node) => (node as HTMLElement).dataset.action ?? (node.classList.contains('pop-sep') ? '—' : '?'));
    expect(order).toEqual(['rerun', 'edit-profile', 'home', '—', 'undo']);
    expect(menu().querySelector('[data-action="home"]')?.textContent).toBe('回到主页');
  });

  it('按了回到首页：不撤销网页上写好的任何一栏；这一轮到此为止，之后送来的不收', () => {
    reduceMotion(true);
    const { handle, root, menu, openMenu, undoAll, onDismiss } = settled();
    openMenu();
    click(menu().querySelector('[data-action="home"]'));
    expect(undoAll, '回到主页不是撤销').not.toHaveBeenCalled();
    expect(onDismiss, '调用方据此停掉还没回来的 AI 答案').toHaveBeenCalledTimes(1);
    expect(handle.scene()).toBe('HOME');
    expect(handle.runState()).toBe('IDLE');
    expect(handle.autofillEnabled()).toBe(true);
    expect(root.querySelector('[data-action="autofill"]')?.textContent).toBe('自动填写');
    expect(menu().dataset.open).toBe('false');
    // 迟到的复查、AI 答案送来同一轮的单子：不再把那一轮摆回来。
    handle.update({ runId: 'fill-1', requiredQuestions: 2, requiredCompleted: 2, rows: ROWS, phase: 'SETTLED' } as never);
    expect(handle.scene()).toBe('HOME');
  });

  /**
   * 2026-10-03 体检 3a-1：按了「继续到下一页」、网站还在翻的那几秒里，⋯ 菜单照旧能按「重新填写这一页」「回到主页」——
   * 新开的一轮和翻页那一轮叠在一起（翻过去之后接着填下一页的那一轮，会把他刚开的那一轮作废），或者回到首页之后翻页那一轮
   * 又把浮层拉回去。翻页有结论之前这两项按不了。
   */
  it('网站正在翻页（按了「继续到下一页」还没结论）：「重新填写这一页」「回到主页」按不了，有了结论再放开', async () => {
    reduceMotion(true);
    let settle: (outcome: 'NOT_ADVANCED') => void = () => {};
    const advance = vi.fn(() => new Promise<'NOT_ADVANCED'>((resolve) => { settle = resolve; }));
    const { handle, root, menu, openMenu, undoAll, onDismiss, autofills } = settled({ nextStep: { label: () => 'Save and Continue', advance } });
    click(root.querySelector('[data-action="next-step"]'));
    expect(advance).toHaveBeenCalledTimes(1);
    openMenu();
    const rerun = menu().querySelector<HTMLButtonElement>('[data-action="rerun"]')!;
    const home = menu().querySelector<HTMLButtonElement>('[data-action="home"]')!;
    expect([rerun.disabled, home.disabled]).toEqual([true, true]);
    click(rerun);
    click(home);
    expect(autofills, '没有开新的一轮').toHaveLength(0);
    expect([undoAll.mock.calls.length, onDismiss.mock.calls.length], '这一轮还在').toEqual([0, 0]);
    expect(handle.scene()).toBe('AUTOFILL');
    settle('NOT_ADVANCED');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    openMenu();
    openMenu();
    expect([rerun.disabled, home.disabled]).toEqual([false, false]);
  });

  it('再按「自动填写」：正常开新的一轮', () => {
    reduceMotion(true);
    const { handle, root, menu, openMenu, autofills } = settled();
    openMenu();
    click(menu().querySelector('[data-action="home"]'));
    click(root.querySelector('[data-action="autofill"]'));
    expect(autofills).toHaveLength(1);
    expect(handle.runState()).toBe('PREPARING');
    handle.beginRun({ runId: 'fill-2', requiredQuestions: 1, requiredCompleted: 1, phase: 'SETTLED',
      rows: [{ label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' }] } as never);
    expect(handle.runState()).toBe('SETTLED');
    expect(root.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
  });

  it('动画：没有信封——底栏那颗深蓝的按钮飞到「自动填写」的位置（860ms、浮层的 EASE），首页再依次淡进来', () => {
    reduceMotion(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: Array<{ node: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    const animateBefore = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      calls.push({ node: this, frames: frames as Keyframe[], options: options as KeyframeAnimationOptions });
      return { cancel() {}, finish() {}, finished: Promise.resolve() } as unknown as Animation;
    } as typeof HTMLElement.prototype.animate;
    // 测试环境不排版：给底栏按钮与主卡各一个像样的矩形（底栏在下、主卡在上），好量出从哪飞到哪。
    const rectBefore = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
      if (this.matches('[data-bar-primary]')) return box(20, 820, 280, 46);
      if (this.matches('[data-hero]')) return box(20, 260, 340, 50);
      return box(0, 0, 380, 900);
    };
    try {
      const { handle, root, menu, openMenu, undoAll } = settled();
      openMenu();
      calls.length = 0;
      click(menu().querySelector('[data-action="home"]'));
      expect(undoAll).not.toHaveBeenCalled();
      expect(handle.scene(), '真的节点当场就是首页').toBe('HOME');
      const flight = root.querySelector('[data-home-flight]');
      expect(flight?.getAttribute('aria-hidden')).toBe('true');
      expect(root.querySelector('[data-envelope], [data-subfx]'), '没有信封').toBeNull();
      const fly = calls.find((call) => Object.keys(call.frames[0] ?? {}).includes('top') && call.node.parentElement === flight);
      expect(fly?.options.duration).toBe(860);
      expect(fly?.options.easing).toBe('cubic-bezier(.32,.72,0,1)');
      expect(fly?.node.textContent).toContain('自动填写');
      const hero = root.querySelector<HTMLElement>('[data-hero]');
      expect(hero?.style.visibility, '落地前主卡藏着').toBe('hidden');
      const fadeIns = calls.filter((call) => call.options.delay !== undefined && call.options.delay >= 520 && call.frames[0]?.opacity === 0);
      expect(fadeIns.map((call) => call.options.delay)).toEqual([520, 600, 680]);
      expect(fadeIns[0]?.node.classList.contains('job')).toBe(true);
      vi.advanceTimersByTime(900);
      expect(root.querySelector('[data-home-flight]'), '落地后收拾干净').toBeNull();
      expect(hero?.style.visibility).toBe('');
      expect(fly?.frames.map((frame) => [frame.left, frame.top, frame.width, frame.height])).toEqual([
        ['20px', '820px', '280px', '46px'],
        ['20px', '260px', '340px', '50px'],
      ]);
    } finally {
      HTMLElement.prototype.animate = animateBefore;
      HTMLElement.prototype.getBoundingClientRect = rectBefore;
    }
  });
});

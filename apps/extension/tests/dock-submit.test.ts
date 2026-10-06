// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type DockSubmitOutcome } from '../lib/autofillDock';

/**
 * 浮层里的「提交」（2026-09-23 负责人决定：插件替用户点提交）。
 *
 * 浮层只管三件事：那一下点击当场交给调用方（它同步验真点击）；能替用户按时写「提交」、按不了就照实写
 * 「去网站上提交」；按完照结论说话——提交成功写「已提交」，网站没收就亮红条。真按网站、判结论都在
 * `lib/submitController.ts`（那边另有测试）。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));

const ROWS: AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Ada' },
  { label: 'Email', required: true, done: true, state: 'CONFIRMED', value: 'ada@example.test' },
];

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  // 减弱动态效果：信封只摆结果、不播几秒的动画，测试不用等。
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.body.innerHTML = '';
});

async function until(check: () => boolean, ms = 1_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

function mount(submission?: { available: () => boolean; send: (event: MouseEvent, shadow: ShadowRoot, pressAt: Promise<void>) => Promise<DockSubmitOutcome> }) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    vendorLabel: 'Greenhouse',
    jobCard: () => ({ title: 'Product Engineer', company: 'Example Co' }),
    ...(submission === undefined ? {} : { submission }),
  }, document);
  handle.openPanel();
  handle.beginRun({ runId: 'fill-1', requiredCompleted: 2, requiredQuestions: 2, rows: ROWS, phase: 'SETTLED' } as never);
  const root = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, root };
}

describe('浮层里的「提交」', () => {
  it('能替用户按：写「提交」；点下去当场把那一次点击、我方 shadow 与「信封合上」交给调用方；成功后岗位卡写「已提交」', async () => {
    const send = vi.fn((_event: MouseEvent, _shadow: ShadowRoot, pressAt: Promise<void>) => pressAt.then((): DockSubmitOutcome => 'SUBMITTED'));
    const { handle, root } = mount({ available: () => true, send });
    expect(handle.primaryButton()?.textContent).toBe('提交');
    click(handle.primaryButton());
    expect(send, '在点击的派发过程中同步交出去（composedPath 过后就取不到了）').toHaveBeenCalledTimes(1);
    const [event, shadow, pressAt] = send.mock.calls[0]!;
    expect(event.isTrusted).toBe(true);
    expect(shadow).toBe(root);
    expect(pressAt).toBeInstanceOf(Promise);
    await until(() => root.textContent?.includes('已提交') === true);
    expect(root.querySelector('.banner-title')?.textContent ?? '').not.toBe('网站没有提交');
  });

  it('网站没收（标红）：不写「已提交」，亮红条说去看网站上的红色提示', async () => {
    const send = vi.fn((_event: MouseEvent, _shadow: ShadowRoot, pressAt: Promise<void>) => pressAt.then((): DockSubmitOutcome => 'NOT_SUBMITTED'));
    const { handle, root } = mount({ available: () => true, send });
    click(handle.primaryButton());
    await until(() => root.querySelector('.banner-title')?.textContent === '网站没有提交');
    expect(root.textContent).not.toContain('已提交');
    expect(handle.primaryButton()?.textContent, '改好了可以再点一次').toBe('提交');
  });

  it('按不了（开关没开、这一家没声明、按钮此刻按不了）：照实写「去网站上提交」，点了只提示，不交出去', () => {
    const send = vi.fn(async (): Promise<DockSubmitOutcome> => 'SUBMITTED');
    const { handle, root } = mount({ available: () => false, send });
    expect(handle.primaryButton()?.textContent).toBe('去网站上提交');
    click(handle.primaryButton());
    expect(send).not.toHaveBeenCalled();
    expect(root.querySelector('[data-toast]')?.textContent).toBe('网站上的「提交」此刻按不了，请在网站上自己点。');
  });

  it('画的时候按不了（写着「去网站上提交」），点下去那一刻却能按了：照他按的那颗按钮上的字办，不替他按网站的提交', () => {
    // 2026-10-04：有的网站必填没填好时把提交钮禁用着（Rippling），填好才放开——「能不能按」会在两次重画之间变。
    // 他按的是「去网站上提交」，就不是「提交」：只请他去网站上点；重画之后才换成「提交」，再按一次才算他确认提交。
    let ready = false;
    const send = vi.fn(async (): Promise<DockSubmitOutcome> => 'SUBMITTED');
    const { handle, root } = mount({ available: () => ready, send });
    expect(handle.primaryButton()?.textContent).toBe('去网站上提交');
    ready = true;
    click(handle.primaryButton());
    expect(send).not.toHaveBeenCalled();
    expect(root.querySelector('[data-toast]')?.textContent).toBe('检查一遍，然后在网站上点提交。');
    expect(handle.primaryButton()?.textContent).toBe('提交');
    click(handle.primaryButton());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('没接提交（老调用方）：同样写「去网站上提交」', () => {
    const { handle, root } = mount();
    expect(handle.primaryButton()?.textContent).toBe('去网站上提交');
    click(handle.primaryButton());
    expect(root.querySelector('[data-toast]')?.textContent).toBe('检查一遍，然后在网站上点提交。');
  });

  it('页面派发的点击：什么都不交出去', () => {
    const send = vi.fn(async (): Promise<DockSubmitOutcome> => 'SUBMITTED');
    const { handle } = mount({ available: () => true, send });
    handle.primaryButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });
});

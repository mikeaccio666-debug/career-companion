// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';

/**
 * 看不见的部分不能被读屏念出来、也不能被 Tab 进去。
 *
 * 浮层的收起面板、另一条路由与关着的菜单都只是透明着（为了淡入淡出），不加 inert 的话它们仍在
 * 无障碍树里：2026-09-23 在测试台上读到，面板收成「逐项处理」小卡时（那张小卡 2026-09-28 已经不在了），读屏仍能读出
 * 整张面板和关着的「更多」菜单里的每一项。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { document.body.innerHTML = ''; });

function mount() {
  const snapshot = fictionalProfileSnapshot('Example Person')!;
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    directory: {
      profileV2: async () => ({ ok: true as const, value: snapshot }),
      saveProfileV2: async () => ({ ok: true as const, value: snapshot }),
    },
  }, document);
  const root = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  const inert = (selector: string) => root.querySelector(selector)?.hasAttribute('inert');
  return { handle, root, inert };
}

describe('看不见的部分移出读屏与 Tab 顺序', () => {
  it('面板收着：面板 inert，收起按钮不 inert；打开后反过来', () => {
    const { handle, inert } = mount();
    expect(inert('.panel')).toBe(true);
    expect(inert('.launcher')).toBe(false);
    handle.openPanel();
    expect(inert('.panel')).toBe(false);
    expect(inert('.launcher')).toBe(true);
  });

  it('菜单关着就 inert；打开「更多」只放出这一个', () => {
    const { handle, root, inert } = mount();
    handle.openPanel();
    expect(inert('.pop-more')).toBe(true);
    expect(inert('.pop-account')).toBe(true);
    click(root.querySelector('.more-btn'));
    expect(inert('.pop-more')).toBe(false);
    expect(inert('.pop-account')).toBe(true);
  });

  it('在「我的资料」里：主界面 inert，资料页不 inert；回来反过来', async () => {
    const { handle, inert } = mount();
    handle.openPanel();
    expect(inert('.route-profile')).toBe(true);
    expect(inert('.route-main')).toBe(false);
    click(handle.entryButtons()[0]);
    await settle();
    expect(inert('.route-profile')).toBe(false);
    expect(inert('.route-main')).toBe(true);
    handle.backHome();
    expect(inert('.route-profile')).toBe(true);
    expect(inert('.route-main')).toBe(false);
  });

  it('「需要你」里空着的那几组 inert；办好了、正在收起的那一行也 inert（2026-09-28）', () => {
    const why = document.createElement('input');
    document.body.append(why);
    const { handle, root, inert } = mount();
    handle.openPanel();
    const rows: AutofillDockFieldRow[] = [
      { label: 'Why do you want to work here?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY', target: why },
    ];
    handle.beginRun({ runId: 'fill-1', requiredCompleted: 0, requiredQuestions: 1, rows, phase: 'SETTLED' } as never);
    expect(inert('[data-need-group="write"]')).toBe(false);
    expect(inert('[data-need-group="choose"]'), '空着的一组').toBe(true);
    why.dispatchEvent(new TrustedClick('pointerdown', { bubbles: true, composed: true }));
    why.value = 'Because';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    const leaving = root.querySelector('[data-need-left]')?.closest('.need-fold');
    if (leaving) expect(leaving.hasAttribute('inert')).toBe(true);
    expect(inert('[data-need-group="write"]')).toBe(true);
  });
});

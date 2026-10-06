// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockHandlers } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';

/**
 * 答案记忆（2026-09-28 负责人：默认打开）：账户菜单里一个「记住我的回答」开关；第一次记住他在浮层里答的，说一句
 * 「已记住，下次自动填 · 可在菜单里关」。开关存在插件本地（后端没有这个开关），没设过就是开，他关过的照旧关着
 * （answer-memory-provider.test.ts）；这里钉住浮层这一侧。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const settleMicrotasks = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, ...extra }, document);
  handle.openPanel();
  const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, shadow };
}

describe('「记住我的回答」', () => {
  it('在账户菜单里，没读到之前按开着画；打开菜单时读一次', async () => {
    const load = vi.fn(async () => true);
    const { shadow } = mount({ answerMemory: { load, save: vi.fn(async (on: boolean) => on) } });
    const item = shadow.querySelector<HTMLButtonElement>('[data-action="answer-memory"]')!;
    expect(item.getAttribute('role')).toBe('switch');
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(item.textContent).toContain('记住我的回答');
    click(shadow.querySelector('[data-act="menu-account"]'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('读到他关过：画成关着；点一下打开并存下来，说一句', async () => {
    const save = vi.fn(async (on: boolean) => on);
    const { shadow } = mount({ answerMemory: { load: async () => false, save } });
    click(shadow.querySelector('[data-act="menu-account"]'));
    await settleMicrotasks();
    const item = shadow.querySelector<HTMLButtonElement>('[data-action="answer-memory"]')!;
    expect(item.getAttribute('aria-checked')).toBe('false');
    click(item);
    expect(save).toHaveBeenCalledWith(true);
    await settleMicrotasks();
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('已打开：你在这里答的，下次自动填');
  });

  it('存不下：拨回去，照实说', async () => {
    const { shadow } = mount({ answerMemory: { load: async () => true, save: async () => null } });
    const item = shadow.querySelector<HTMLButtonElement>('[data-action="answer-memory"]')!;
    click(item);
    await settleMicrotasks();
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('没能保存这个开关，请稍后再试。');
  });

  it('没接就没有这一项', () => {
    const { shadow } = mount();
    expect(shadow.querySelector('[data-action="answer-memory"]')).toBeNull();
  });
});

describe('第一次记住', () => {
  it('说一句轻的：「已记住，下次自动填 · 可在菜单里关」（英文界面同一件事）', () => {
    const { handle, shadow } = mount();
    handle.noteRemembered();
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('已记住，下次自动填 · 可在菜单里关');
    expect(dockCopy('en').memory.noted).toBe('Remembered for next time · Turn it off in the menu');
  });
});

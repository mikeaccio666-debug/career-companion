// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockHandlers } from '../lib/autofillDock';
import type { DockLocale } from '../lib/dock/copy';
import { DOCK_LOCALE_KEY, storedDockLocale } from '../lib/dockLanguage';

/**
 * 账户菜单里的「语言」（2026-09-27 负责人：右上角加一个设置，用户可以自己改语言）。
 *
 * 没选过就照旧跟随浏览器的界面语言（#120）；选过就照他选的来，存在插件自己的 storage.local 里。
 * 菜单里一行两个选项「中文」「English」（各用自己的语言写，谁都认得出），当前那一个标着按下；
 * 点另一个就交给调用方换；正在填写时不能换——换语言要重挂浮层，会把这一轮打断。只认真实点击。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));

function mount(locale: DockLocale, extra: Partial<AutofillDockHandlers> = {}) {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, locale, ...extra }, doc);
  handle.openPanel();
  const root = handle.sceneRoot()!;
  const openMenu = () => click(root.querySelector('[data-act="menu-account"]'));
  const row = () => root.querySelector<HTMLElement>('[data-action="language"]');
  const option = (value: DockLocale) => root.querySelector<HTMLButtonElement>(`[data-language="${value}"]`);
  return { handle, openMenu, row, option };
}

describe('账户菜单里的语言', () => {
  it('中文界面：一行「语言」，两个选项，中文标着按下；点 English 交给调用方', () => {
    const chosen: DockLocale[] = [];
    const { openMenu, row, option } = mount('zh', { onChangeLocale: (value) => { chosen.push(value); } });
    openMenu();
    expect(row(), '账户菜单里没有语言').not.toBeNull();
    expect(row()?.textContent).toContain('语言');
    expect(option('zh')?.textContent).toBe('中文');
    expect(option('en')?.textContent).toBe('English');
    expect(option('zh')?.getAttribute('aria-pressed')).toBe('true');
    expect(option('en')?.getAttribute('aria-pressed')).toBe('false');
    click(option('en'));
    expect(chosen).toEqual(['en']);
  });

  it('英文界面：写着 Language，English 标着按下；点当前那一个什么都不做', () => {
    const chosen: DockLocale[] = [];
    const { openMenu, row, option } = mount('en', { onChangeLocale: (value) => { chosen.push(value); } });
    openMenu();
    expect(row()?.textContent).toContain('Language');
    expect(option('en')?.getAttribute('aria-pressed')).toBe('true');
    click(option('en'));
    expect(chosen).toEqual([]);
    click(option('zh'));
    expect(chosen).toEqual(['zh']);
  });

  it('页面派发的点击不算', () => {
    const chosen: DockLocale[] = [];
    const { openMenu, option } = mount('zh', { onChangeLocale: (value) => { chosen.push(value); } });
    openMenu();
    option('en')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(chosen).toEqual([]);
  });

  it('正在填写时不能换（会打断这一轮）', () => {
    const chosen: DockLocale[] = [];
    const { handle, openMenu, option } = mount('zh', { onChangeLocale: (value) => { chosen.push(value); } });
    handle.beginPreparing();
    openMenu();
    expect(option('en')?.disabled).toBe(true);
    click(option('en'));
    expect(chosen).toEqual([]);
  });

  it('没接处理器就没有这一行', () => {
    const { openMenu, row } = mount('zh');
    openMenu();
    expect(row()).toBeNull();
  });
});

describe('存下来的语言', () => {
  it('只认 zh 与 en，别的一律当没选过', () => {
    expect(DOCK_LOCALE_KEY).toBe('argolandDockLocale');
    expect(storedDockLocale('zh')).toBe('zh');
    expect(storedDockLocale('en')).toBe('en');
    for (const bad of [undefined, null, '', 'EN', 'fr', 1, {}, ['en']]) {
      expect(storedDockLocale(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

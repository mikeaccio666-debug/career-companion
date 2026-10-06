// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockHandlers } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';
import type { DockSigningReconsent } from '../lib/dock/types';

/**
 * 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人，浮层里一张卡请他同意。
 *
 * 钉住：调用方说要请才摆；卡上照登那一句（与资料页那一格逐字相同），「隐私政策」点开写明范围的那一节（中文页、英文页各
 * 一个）；「同意」只认真实点击、把这一下交给调用方，存成了卡片收起，没存上卡片留着；「暂不」什么都不发，卡片收起；
 * 填写途中、连填翻页时不摆。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(reconsent: DockSigningReconsent, extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Greenhouse', signingReconsent: reconsent, ...extra,
  }, document);
  handle.openPanel();
  const card = () => handle.sceneRoot()!.querySelector<HTMLElement>('[data-consent="offer"]');
  return { handle, card };
}

function reconsent(over: Partial<DockSigningReconsent> = {}): DockSigningReconsent & { offeredNow: { value: boolean } } {
  const offeredNow = { value: true };
  return {
    offeredNow,
    offered: over.offered ?? (() => offeredNow.value),
    accept: over.accept ?? vi.fn(async () => true),
    decline: over.decline ?? vi.fn(),
  };
}

describe('代填授权的一键更新卡', () => {
  it('调用方说要请 → 摆出来，照登那一句（负责人定稿，与资料页那一格逐字相同）', () => {
    const { card } = mount(reconsent());
    expect(card()?.style.display).toBe('grid');
    const COPY = dockCopy('zh');
    expect(COPY.profile.consentLabel).toBe('允许 ArgoLand 以我的名义处理申请表上的条款、声明和授权，并替我注册、登录招聘网站。详见隐私政策。');
    expect(card()?.textContent).toContain(COPY.reconsent.title);
    expect(card()?.querySelector('.consent-offer-text')?.textContent).toBe(COPY.profile.consentLabel);
  });

  it('「隐私政策」点开写明范围的那一节：中文界面开中文页，英文界面开英文页', () => {
    for (const [locale, page] of [['zh', 'SIGNING_SCOPE_ZH'], ['en', 'SIGNING_SCOPE']] as const) {
      const opened: string[] = [];
      const { handle, card } = mount(reconsent(), { locale, onOpenPortal: (target) => { opened.push(target); } });
      const link = card()?.querySelector<HTMLButtonElement>('.consent-offer-link');
      expect(link?.textContent).toBe(dockCopy(locale).profile.consentLinkText);
      click(link);
      expect(opened).toEqual([page]);
      handle.dismiss();
    }
  });

  it('调用方说不请 → 不摆', () => {
    const offered = reconsent();
    offered.offeredNow.value = false;
    expect(mount(offered).card()?.style.display).toBe('none');
  });

  it('「同意新版本」：真实点击交给调用方；存成了卡片收起', async () => {
    const accept = vi.fn(async () => true);
    const { handle, card } = mount(reconsent({ accept }));
    click(handle.sceneRoot()!.querySelector('[data-action="consent-agree"]'));
    expect(accept).toHaveBeenCalledTimes(1);
    const [event, shadowRoot] = accept.mock.calls[0] as unknown as [MouseEvent, ShadowRoot];
    expect(event.isTrusted).toBe(true);
    expect(shadowRoot).toBeTruthy();
    await settle();
    expect(card()?.style.display).toBe('none');
  });

  it('不是真实点击 → 不交出去', () => {
    const accept = vi.fn(async () => true);
    const { handle } = mount(reconsent({ accept }));
    handle.sceneRoot()!.querySelector('[data-action="consent-agree"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(accept).not.toHaveBeenCalled();
  });

  it('没存上 → 卡片留着，可以再按', async () => {
    const accept = vi.fn(async () => false);
    const { handle, card } = mount(reconsent({ accept }));
    click(handle.sceneRoot()!.querySelector('[data-action="consent-agree"]'));
    await settle();
    expect(card()?.style.display).toBe('grid');
    expect(handle.sceneRoot()!.querySelector<HTMLButtonElement>('[data-action="consent-agree"]')?.disabled).toBe(false);
  });

  it('「暂不」：什么都不发，卡片收起', () => {
    const accept = vi.fn(async () => true);
    const decline = vi.fn();
    const { handle, card } = mount(reconsent({ accept, decline }));
    click(handle.sceneRoot()!.querySelector('[data-action="consent-later"]'));
    expect(decline).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    expect(card()?.style.display).toBe('none');
  });

  it('填写途中不摆', () => {
    const { handle, card } = mount(reconsent());
    handle.beginPreparing();
    expect(card()?.style.display).toBe('none');
  });

  it('连填（一页一页填到检查页）替他翻页的那几秒不摆（那时不是「填写中」）；到头停下了才摆', async () => {
    const { handle, card } = mount(reconsent());
    const rows = [{ label: 'First Name', required: true, done: true, state: 'CONFIRMED' as const, value: 'Sample' }];
    const settled = (runId: string) => ({ runId, requiredQuestions: 1, requiredCompleted: 1, rows, phase: 'SETTLED' }) as never;
    const chain = { page: 1, maxPages: 10, site: null, donePages: 0, doneFields: 0, stop: null };
    handle.beginPreparing();
    handle.setChain(chain);
    handle.beginRun(settled('gesture-1'));
    handle.update(settled('gesture-1'));
    expect(card()?.style.display).toBe('none');
    let advanced: (outcome: 'ADVANCED') => void = () => {};
    handle.autoAdvance(new Promise((resolve) => { advanced = resolve; }), 'Save and Continue');
    expect(card()?.style.display).toBe('none');
    advanced('ADVANCED');
    await settle();
    handle.beginPreparing();
    handle.setChain({ ...chain, page: 2, donePages: 1, doneFields: 1, stop: 'REVIEW' } as never);
    handle.beginRun(settled('gesture-2'));
    handle.update(settled('gesture-2'));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(card()?.style.display).toBe('grid');
  });

  it('英文界面照登英文那一句', () => {
    const { card } = mount(reconsent(), { locale: 'en' });
    const COPY = dockCopy('en');
    expect(COPY.profile.consentLabel).toBe(
      'Let ArgoLand handle the terms, declarations and authorizations on application forms in my name, and sign up or sign in to job sites for me. See the Privacy Policy.',
    );
    expect(card()?.textContent).toContain(COPY.reconsent.title);
    expect(card()?.querySelector('.consent-offer-text')?.textContent).toBe(COPY.profile.consentLabel);
  });
});

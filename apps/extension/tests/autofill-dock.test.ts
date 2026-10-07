// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';

const handlers = () => ({ onAutofill: () => {}, onOpenEntry: () => {} });
const mounted = (doc: Document) => doc.querySelectorAll('#edaix-autofill-dock').length;

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

describe('autofill dock', () => {
  it('arrives as a launcher, and opens the panel only on a real click', () => {
    // The panel covers a corner of a form the user is reading. It earns that
    // space by being asked for, so the resting state is the edge tab alone.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    expect(handle.isOpen()).toBe(false);
    const launcher = handle.launcherButton();
    expect(launcher).not.toBeNull();
    launcher?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle.isOpen(), 'a click the page dispatched must not open us').toBe(false);
    launcher?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(handle.isOpen()).toBe(true);
  });
  it('offers the three ways into saved material, and opens the one clicked', () => {
    const opened: string[] = [];
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'READY' },
      { onAutofill: () => {}, onOpenEntry: (target) => opened.push(target) },
      doc,
    );
    expect(handle.entryButtons().map((b) => b.dataset.entry))
      .toEqual(['AUTOFILL_INFORMATION', 'RESUME', 'COVER_LETTER']);
    const resume = handle.entryButtons()[1];
    resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened, 'a page-dispatched click opens nothing').toEqual([]);
    resume?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(opened).toEqual(['RESUME']);
  });
  it('opens itself when the caller says the user came here to fill', () => {
    // From ArgoLand to the application page is the ordinary route, and a panel
    // that waited to be asked on that route would look like nothing happened.
    // The decision stays with the caller: nothing in the dock opens by default.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { ...handlers(), autoOpen: true }, doc);
    expect(handle.isOpen()).toBe(true);
    expect(handle.scene()).toBe('HOME');
  });
  it('steps into the profile scene from the panel, and back out again', () => {
    // The row is the only way into the profile from here; if it stops opening
    // it, the saved details become unreachable without the web app.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    expect(handle.scene()).toBe('HOME');
    expect(handle.profileRoot()).toBeNull();
    handle.entryButtons()[0]?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(handle.scene()).toBe('PROFILE');
    expect(handle.isOpen(), 'opening the profile opens the panel').toBe(true);
    expect(handle.profileRoot()).not.toBeNull();
    handle.backHome();
    expect(handle.scene()).toBe('HOME');
    expect(handle.profileRoot()).toBeNull();
  });
  it('says the profile door is missing when the caller supplies none', () => {
    // No directory means no store behind the scene: it must say so rather than
    // show an empty form that claims the user has nothing saved.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    handle.openProfile();
    expect(handle.profileRoot()?.textContent).toContain('暂时读不到你的资料');
  });
  it('shows the completion face once a run settles, not the working list', () => {
    // Figure 4 is a different screen, not a green tint on the same rows: once
    // the fill is over the user is deciding what to do next, and the row list
    // they watched fill is no longer the thing they need.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    handle.update({ runId: 'r', requiredCompleted: 1, requiredQuestions: 2,
      rows: [{ label: '姓名', required: true, done: true, value: 'Ke Chen' },
             { label: '你怎么知道这个职位的？', required: true, done: false, needsUser: true }] });
    expect(handle.sheetFace()).toBe('WORKING');
    handle.update({ runId: 'r', phase: 'SETTLED', requiredCompleted: 1, requiredQuestions: 2,
      rows: [{ label: '姓名', required: true, done: true, value: 'Ke Chen' },
             { label: '你怎么知道这个职位的？', required: true, done: false, needsUser: true }] } as never);
    expect(handle.sheetFace()).toBe('COMPLETE');
  });
  it('closes back to the launcher without taking itself down', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    handle.closePanel();
    expect(handle.isOpen()).toBe(false);
    expect(mounted(doc), 'closing is not dismissing; the tab stays').toBe(1);
  });

  it('addresses the user as this product, never as the one it is modelled on', () => {
    // The panel is modelled on Jobright's on purpose; being mistaken for it is
    // not the goal. Career Companion is this product's own name — the same one the
    // Fable design uses. Pinned on the source because every sentence the dock
    // says, in either language, lives in this one file.
    // 2026-09-23 新浮层：文案都在 lib/dock/copy.ts；旧表 product-panel/dockCopy.ts 2026-09-26 删掉了。
    const copy = readFileSync(resolve(__dirname, '../lib/dock/copy.ts'), 'utf8');
    expect(copy).not.toMatch(/jobright/iu);
    expect(copy).toContain('Career Companion');
  });
  it('puts nothing on a page it must stay off', () => {
    const doc = document.implementation.createHTMLDocument();
    mountAutofillDock({ kind: 'HIDDEN' }, handlers(), doc);
    expect(mounted(doc)).toBe(0);
  });
  it('explains without offering a button when the form cannot be reached', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, handlers(), doc);
    expect(mounted(doc)).toBe(1);
    expect(handle.face()).toBe('GUIDANCE');
    expect(handle.autofillEnabled()).toBe(false);
  });
  it('没连账号时出现，但不提供 Autofill——下一步是去登录', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }, handlers(), doc);
    expect(mounted(doc)).toBe(1);
    expect(handle.autofillEnabled()).toBe(false);
  });
  it('没有 mission 时**照样**提供 Autofill', () => {
    // 2026-09-17 的产品决定：任何一家我们认得的申请页都能填，不要求先把岗位
    // 加进清单。那条路填的是用户自己的档案，信任根是他此刻按下的这一次点击
    // （isTrusted + 来自我方 shadow），不需要 mission。
    //
    // 这条用例此前断言的是相反的行为（「refuses to offer Autofill: NO_MISSION」）。
    // 那是「必须有 mission」那一版的产物——它当时是对的：没有 mission 就没有可签的
    // intent，按下去必然失败。现在有了第二条铸票路径，前提不再成立。
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, handlers(), doc);
    expect(handle.autofillEnabled()).toBe(true);
  });
  it('认不出申请表、或取不到规则时不提供——按下去也没有意义', () => {
    for (const affordance of [
      { kind: 'DORMANT' } as const,
      { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' } as const,
    ]) {
      const doc = document.implementation.createHTMLDocument();
      const handle = mountAutofillDock(affordance, handlers(), doc);
      expect(handle.autofillEnabled(), affordance.kind).toBe(false);
    }
  });
  it('offers Autofill only when the page is ready', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    expect(handle.face()).toBe('READY');
    expect(handle.autofillEnabled()).toBe(true);
  });
  it('never leaves two docks on one page', () => {
    const doc = document.implementation.createHTMLDocument();
    mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    expect(mounted(doc)).toBe(1);
  });
  it('takes itself down and leaves the host page as it found it', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers(), doc);
    handle.dismiss();
    expect(mounted(doc)).toBe(0);
    expect(doc.body.childNodes.length).toBe(0);
  });
  it('only calls back on a real user click, never on a synthetic one', () => {
    const doc = document.implementation.createHTMLDocument();
    let clicks = 0;
    const handle = mountAutofillDock({ kind: 'READY' }, { ...handlers(), onAutofill: () => { clicks += 1; } }, doc);
    handle.autofillButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(0);
  });
});

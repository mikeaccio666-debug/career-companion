// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { affordanceFaceKey, mountAutofillDock } from '../lib/autofillDock';

/**
 * 「退出登录」（2026-09-21 Mike：「我发现没做登出」）。
 *
 * 只在已连接的脸上出现，和「登录 ArgoLand」永不同框；只认真实点击——页面派发的点击
 * 不能替用户退出（退出是安全方向，但也是他的动作）；没接处理器就没有这颗按钮。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const open = (handle: ReturnType<typeof mountAutofillDock>) => {
  handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
};
const signOutButton = (handle: ReturnType<typeof mountAutofillDock>) =>
  handle.sceneRoot()?.querySelector<HTMLButtonElement>('[data-action="sign-out"]') ?? null;
const loginButton = (handle: ReturnType<typeof mountAutofillDock>) =>
  handle.sceneRoot()?.querySelector<HTMLButtonElement>('[data-action="login"]') ?? null;

describe('浮层脚部的「退出登录」', () => {
  it('已连接的脸上有，只认真实点击', () => {
    const doc = document.implementation.createHTMLDocument();
    let signedOut = 0;
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, onSignOut: () => { signedOut += 1; } }, doc);
    open(handle);
    const button = signOutButton(handle);
    expect(button, '已连接却没有退出登录').not.toBeNull();
    expect(button?.textContent).toBe('退出登录');
    expect(loginButton(handle), '登录与退出不同框').toBeNull();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(signedOut, '页面派发的点击不能替用户退出').toBe(0);
    button?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(signedOut).toBe(1);
  });

  it('没连接的脸上只有「登录 ArgoLand」', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' } as never,
      { onAutofill: () => {}, onOpenEntry: () => {}, onOpenPortal: () => {}, onSignOut: () => {} },
      doc,
    );
    open(handle);
    expect(loginButton(handle)).not.toBeNull();
    expect(signOutButton(handle)).toBeNull();
  });

  it('没接处理器就没有这颗按钮', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    open(handle);
    expect(signOutButton(handle)).toBeNull();
  });
});

describe('退出登录之后脸要换：比的是 kind:reason，不只是 kind', () => {
  it('faceKey 把 UNAVAILABLE 的 reason 也算进身份', () => {
    const doc = document.implementation.createHTMLDocument();
    const noMission = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' } as never, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    const unlinked = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' } as never, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    expect(noMission.face()).toBe(unlinked.face());
    expect(noMission.faceKey()).toBe('UNAVAILABLE:NO_MISSION');
    expect(unlinked.faceKey()).toBe('UNAVAILABLE:PORTAL_UNLINKED');
    expect(noMission.faceKey()).not.toBe(unlinked.faceKey());
    expect(affordanceFaceKey({ kind: 'READY' })).toBe('READY');
    expect(affordanceFaceKey({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' } as never)).toBe('UNAVAILABLE:RULES_UNAVAILABLE');
  });

  it('内容脚本换脸按完整身份比对（源码形状闸）', () => {
    // 2026-09-21 测试台实测：点了退出登录，worker 已清会话、报到也答 PORTAL_UNLINKED，
    // 浮层却停在「已连接」——showFace 只比 kind，NO_MISSION → PORTAL_UNLINKED 同为 UNAVAILABLE。
    const source = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
    expect(source).toContain('dockHandle.faceKey() === affordanceFaceKey(dock)');
    expect(source).not.toContain('dockHandle.face() === dock.kind');
  });
});

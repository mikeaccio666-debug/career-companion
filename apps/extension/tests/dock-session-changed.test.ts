import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DOCK_SESSION_CHANGED, isDockSessionChanged } from '../lib/dockSessionChanged';
import { DOCK_PROFILE_CHANGED, isDockProfileChanged } from '../lib/dockProfileChanged';
const read = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8');
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0); expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('dock/session-changed', () => {
  it('只认那一个不带值的形状', () => {
    expect(isDockSessionChanged(DOCK_SESSION_CHANGED)).toBe(true);
    expect(isDockSessionChanged({ kind: 'dock/session-changed' })).toBe(true);
    for (const bad of [{ kind: 'dock/session-changed', token: 'x' }, { kind: 'dock/run-progress' }, {}, null, 'dock/session-changed', ['dock/session-changed']]) {
      expect(isDockSessionChanged(bad)).toBe(false);
    }
  });

  it('worker 真实身份失效先停止写入并广播到内容脚本和设置页；握手完成后重新报到（接线闸）', () => {
    // 2026-09-21 测试台实测：连接完成后门户标签页自己关了，申请页上的浮层却要等用户切回来
    // 那一下 focus 才换脸；退出登录时别的标签页也停在「已连接」。
    const background = read('entrypoints/background.ts');
    const content = read('entrypoints/apply.content.ts');
    const handoff = background.indexOf("if (kind === 'auth/handoff-complete' && response?.ok) {");
    expect(handoff).toBeGreaterThan(0);
    expect(background.slice(handoff, handoff + 400)).toContain('broadcastSessionChanged();');
    const broadcast = section(background, 'const broadcastSessionChanged = (): void => {', 'browser.runtime.onMessageExternal.addListener(');
    expect(broadcast).toContain('broadcastToTabs(DOCK_SESSION_CHANGED);');
    expect(broadcast).toContain('browser.runtime.sendMessage(DOCK_SESSION_CHANGED)');
    expect(background).toContain('void browser.tabs.sendMessage(tab.id, message).catch(() => {});');
    const auth = read('lib/authClient.ts');
    const invalidation = section(auth, 'function notifySessionInvalidated(): void {', 'async function clearSession():');
    expect(invalidation).toContain('vaultEpoch += 1;');
    expect(invalidation).toContain('deps.onSessionInvalidated?.();');
    const logout = auth.slice(auth.indexOf('async logout(expectedContext)'));
    expect(logout.indexOf('notifySessionInvalidated();')).toBeGreaterThan(0);
    expect(logout.indexOf('notifySessionInvalidated();')).toBeLessThan(logout.indexOf('withSessionTransition(async () => {'));
    const authWiring = section(background, 'const authClient = createAuthClient({', '// 浮层「诊断」');
    expect(authWiring).toContain('onSessionInvalidated: () => {');
    expect(authWiring).toContain('vaultAuthInvalidated();');
    expect(background).toContain('vaultAuthInvalidated = vaultLifecycle.onAuthInvalidated;');
    expect(background).toContain('broadcastInvalidated: broadcastSessionChanged,');
    const lifecycle = read('lib/accountVaultLifecycle.ts');
    const retired = lifecycle.slice(lifecycle.indexOf('onAuthInvalidated: (): void => {'));
    expect(retired.indexOf('deps.invalidateOperations();')).toBeGreaterThan(0);
    expect(retired.indexOf('deps.invalidateOperations();')).toBeLessThan(retired.indexOf('deps.broadcastInvalidated();'));
    const listener = content.indexOf('if (!isDockSessionChanged(raw) || sender.id !== browser.runtime.id || sender.tab) return;');
    expect(listener).toBeGreaterThan(0);
    const contentInvalidation = section(content, 'if (!isDockSessionChanged(raw) || sender.id !== browser.runtime.id || sender.tab) return;', '// 资料或代填授权在插件里');
    for (const retire of ['gestureRunSerial += 1;', 'gestureStop?.abort();', 'wizardAdvance.disarm();', 'submitter.disarm();', 'forgetUser();', 'dockHandle?.dismiss();']) {
      expect(contentInvalidation.indexOf(retire), retire).toBeGreaterThan(0);
      expect(contentInvalidation.indexOf(retire), retire).toBeLessThan(contentInvalidation.indexOf('void hello();'));
    }
    const forget = section(content, 'const forgetUser = (): void => {', 'const afterSessionChange = (): void => {');
    for (const clear of ['helloGeneration += 1;', 'profileWarm = null;', 'resumeWarm = null;', 'accountNow = null;', 'dockHandle?.forgetUser();']) expect(forget).toContain(clear);
    // Dismiss is synchronous and ends the gesture-only drivers inside showFace;
    // importing those drivers into the outer listener would break Assistant isolation.
    const dismissed = section(content, 'onDismissed: () => {', '...(account === null ? {} :');
    for (const stop of ['fillToReviewNow?.end();', 'account?.dispose();', 'codePage?.dispose();']) expect(dismissed).toContain(stop);
    expect(contentInvalidation).not.toContain('fillToReviewNow');
  });
});

/**
 * 2026-10-03 前端体检 P0-1：资料、代填授权在插件里（别的标签页的编辑器）改过了，worker 广播一声，每一页把预取的档案作废。
 * 内容脚本收到之后做什么，apply-content-dock-hygiene.test.ts 用真内容脚本跑过；这里钉 worker 那一侧的接线。
 */
describe('dock/profile-changed', () => {
  it('只认那一个不带值的形状', () => {
    expect(isDockProfileChanged(DOCK_PROFILE_CHANGED)).toBe(true);
    for (const bad of [{ kind: 'dock/profile-changed', revision: '3' }, DOCK_SESSION_CHANGED, {}, null, 'dock/profile-changed', ['dock/profile-changed']]) {
      expect(isDockProfileChanged(bad)).toBe(false);
    }
  });

  it('worker 经手的每一次资料目录写入（存档案、自我认同、同意或撤回代填授权、换默认简历）写成了就广播；读不广播（源码形状闸）', () => {
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    const handler = background.slice(background.indexOf('const request = parseDirectoryRequest(message);'));
    const run = handler.indexOf('directory.run(request.operation, request.body).then((result) => {');
    expect(run).toBeGreaterThan(0);
    expect(handler.slice(run, run + 400)).toContain("if (result.ok && !request.operation.endsWith('_READ')) broadcastToTabs(DOCK_PROFILE_CHANGED);");
  });

  it('此刻代不代签：worker 每次现读同意记录（SIGN_ON_BEHALF），档案答复不再带它（源码形状闸）', () => {
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    const branch = background.indexOf("if (intent.want === 'SIGN_ON_BEHALF') {");
    expect(branch).toBeGreaterThan(0);
    expect(background.slice(branch, branch + 700)).toContain('return signingConsentProvider.read().then(');
    expect(background).not.toMatch(/signOnBehalf: true as const/u);
  });
});

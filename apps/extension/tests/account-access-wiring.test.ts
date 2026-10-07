import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 招聘网站账号（2026-09-28）接对了没有（源码形状闸）。各块的行为另有测试；这一条钉接线——它们错了，各自的测试照样全绿，
 * 而产品上的症状是「保险箱跑进了内容脚本」「未确认就删密码」「Assistant 构建里多出几十 KB」或「账号墙上按了没反应」。
 * 确认、清理失败、换人屏障和发信人拒绝的行为由 account-vault-lifecycle / message-router 测试验证；这里防止 worker 漏接它们。
 */
const ROOT = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const content = read('entrypoints/apply.content.ts');
const background = read('entrypoints/background.ts');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0); expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
}

function sources(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : sources(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('保险箱只在 worker 里', () => {
  it('只有 worker 及其 provider／生命周期／确认模块 import 保险箱；内容脚本与设置 UI 不碰密钥', () => {
    const importers = [...sources('entrypoints'), ...sources('lib'), ...sources('product-panel'), ...sources('assistant')]
      .filter((path) => /from '(?:\.\.?\/)+(?:lib\/)?(?:accountVault|accountAccessProvider)'/u.test(read(path)))
      .sort();
    expect(importers).toEqual(['entrypoints/background.ts', 'lib/accountAccessProvider.ts', 'lib/accountVaultLifecycle.ts', 'lib/accountVaultTransitions.ts']);
  });

  it('真实 auth 交给确认生命周期：不绕过导出确认，换人落盘等待清理屏障', () => {
    const wiring = section(background, 'const vaultLifecycle = createAccountVaultLifecycle({', 'const vaultMessages = createAccountVaultMessageRouter({');
    expect(wiring).toContain('auth: () => authClient, vault: accountVault, area: vaultArea,');
    expect(wiring).toContain('invalidateOperations: () => invalidateAccountOperations(),');
    expect(wiring).toContain('invalidateAccountOperations = () => accountOperations.invalidate();');
    expect(wiring).toContain('beforeVaultSessionReplace = vaultLifecycle.beforeReplaceSession;');
    expect(wiring).toContain('vaultAuthInvalidated = vaultLifecycle.onAuthInvalidated;');
    expect(background).toContain('beforeReplaceSession: (change) => beforeVaultSessionReplace(change),');
    expect(background).not.toContain('authClient.logout().then(');
    const lifecycle = read('lib/accountVaultLifecycle.ts');
    const logout = section(lifecycle, 'executeLogout: async (context, revision)', 'clearVault: async (assertCurrent)');
    expect(logout).toContain('serializeClear(async () => {');
    expect(logout).toContain('await deps.auth().logout(context);');
    expect(logout).toContain('await deps.vault.clear();');
    expect(logout.indexOf('await deps.auth().logout(context);')).toBeLessThan(logout.indexOf('await deps.vault.clear();'));
    const replace = section(lifecycle, 'beforeReplaceSession: async (change:', 'onAuthInvalidated: (): void => {');
    expect(replace).toContain('if (pendingClear !== null) await pendingClear;');
    expect(replace).toContain('return transitions.requestSwitch(');
  });

  it('发信人核对在前；交出密码要这一页正是声明了账号墙的那一家；第二把钥匙用 #130 的判定，不自己比版本号', () => {
    const at = background.indexOf('const intent = parseDockAccountAccessIntent(message);');
    expect(at).toBeGreaterThan(0);
    const listener = section(background, 'const intent = parseDockAccountAccessIntent(message);', 'const missionApplicationTargetClient = ');
    expect(listener.indexOf('senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null')).toBeGreaterThan(0);
    // LIST is redacted metadata. Every other closed page-protocol operation,
    // including CHECK and PASSWORD_PROMPT, must keep the actual account-wall gate.
    expect(listener).toContain("const pageBound = step !== 'LIST';");
    expect(listener).toContain('!declaresAccountSteps(vendor)');
    expect(listener).toContain('!(isApplyFormPath(vendor, intent.pathname) || isAccountFormPath(vendor, intent.pathname))');
    expect(listener).toContain('consent: async () => signingConsentCoversAccountRegistration(await signingConsentProvider.read()),');
    expect(listener.indexOf('senderTabForPageOrFrame(')).toBeLessThan(listener.indexOf('createAccountAccessProvider({'));
    expect(listener).toContain('getAuthContext: () => vaultLifecycle.readContext(),');
    expect(listener).toContain('ops: accountOperations,');
    expect(code(listener)).not.toMatch(/application-signing-\d/u);
  });

  it('全保险箱管理仅接扩展设置路由；页面侧只可打开设置，不得到全站密码', () => {
    const wiring = section(background, 'const vaultMessages = createAccountVaultMessageRouter({', '/** 第一把钥匙：');
    expect(wiring).toContain('extensionId: browser.runtime.id, managementUrl: vaultManagementUrl,');
    expect(wiring).toContain('transitions: vaultLifecycle.transitions,');
    expect(wiring).toContain('getManagementContext: () => vaultLifecycle.readContext(true),');
    expect(wiring).toContain('profileEmail: async () => null,');
    for (const route of ['management', 'transition', 'open']) expect(wiring).toContain(`vaultMessages.${route}(message, sender)`);
    const router = read('lib/accountVaultMessageRouter.ts');
    const management = section(router, 'management(message: unknown, sender:', 'transition(message: unknown, sender:');
    expect(management.indexOf('isVaultManagementSender(')).toBeLessThan(management.indexOf('return deps.manage('));
    expect(management).toContain('if (intent === null || !isVaultManagementSender(');
    const open = router.slice(router.indexOf('open(message: unknown, sender:'));
    expect(open).toContain('deps.pageAllowed(sender, intent)');
    expect(open).toContain("url.searchParams.set('action', 'logout');");
    expect(open).toContain('await deps.openTab(url.toString());');
    expect(open).not.toMatch(/deps\.(?:manage|transitions)\b/u);
  });
});

describe('内容脚本', () => {
  const showFaceStart = content.indexOf('const showFace = ');
  const showFaceEnd = content.indexOf('if (justSubmitted) missionSession.confirmArrival(document);');

  it('那一套只在 showFace 里建（Assistant 构建里 showFace 是死代码，整套随之删掉）', () => {
    const calls = [...code(content).matchAll(/createAccountAccessPage\(/gu)].length;
    expect(calls).toBe(1);
    const at = content.indexOf('createAccountAccessPage({');
    expect(at).toBeGreaterThan(showFaceStart);
    expect(at).toBeLessThan(showFaceEnd);
    expect(content).toContain('const account = !gestureFace ? null : createAccountAccessPage({');
  });

  it('主按钮那一下：这一页有规则声明的账号墙才交给账号墙那一路，取证在第一个 await 之前', () => {
    const autofill = content.slice(content.indexOf('onAutofill: (event, shadowRoot) => {'));
    const proof = autofill.indexOf('const proof = captureTrustedShadowGesture(event, shadowRoot);');
    const route = autofill.indexOf('if (account !== null && account.wallOnPage()) { void account.run(proof); return; }');
    const fill = autofill.indexOf('void runGestureFill(proof, fillToReview());');
    expect(proof).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(proof);
    expect(fill).toBeGreaterThan(route);
    expect(code(autofill.slice(0, fill))).not.toContain('await ');
  });

  it('浮层上的账号处理器只给手势路那几张脸；挂上之后才开始看，拆了一并收掉', () => {
    expect(content).toContain('...(account === null ? {} : { accountAccess: account.handlers, vaultManagement: account.vaultManagement }),');
    const dismiss = section(content, 'onDismissed: () => {', '...(account === null ? {} :');
    for (const stop of ['fillToReviewNow?.end();', 'gestureStop?.abort();', 'account?.dispose();', 'codePage?.dispose();', 'submitCodeHook.read = () => null;']) expect(dismiss).toContain(stop);
    expect(content.indexOf('account?.start();')).toBeGreaterThan(content.indexOf('dockHandle = mountAutofillDock(dock, {'));
  });

  it('账号墙过去之后接着填，走的是手势填写同一条路（AFTER_ADVANCE），「停止」是同一颗', () => {
    const at = content.indexOf('createAccountAccessPage({');
    const deps = content.slice(at, at + 3200);
    expect(deps).toContain('fillPage: (root, mode) => runGestureFill(root, fillToReview(), mode),');
    expect(deps).toContain('gestureStop = stopper;');
  });
});

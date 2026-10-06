import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 招聘网站账号（2026-09-28）接对了没有（源码形状闸）。各块的行为另有测试；这一条钉接线——它们错了，各自的测试照样全绿，
 * 而产品上的症状是「保险箱跑进了内容脚本」「退出登录后密码还在」「Assistant 构建里多出几十 KB」或「账号墙上按了没反应」。
 */
const ROOT = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const content = read('entrypoints/apply.content.ts');
const background = read('entrypoints/background.ts');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');

function sources(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : sources(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('保险箱只在 worker 里', () => {
  it('只有 background.ts 碰保险箱与发密码的那一侧；内容脚本那一侧（accountAccessPage／Controller）一个都不 import', () => {
    const importers = [...sources('entrypoints'), ...sources('lib'), ...sources('product-panel'), ...sources('assistant')]
      .filter((path) => /from '(?:\.\.?\/)+(?:lib\/)?(?:accountVault|accountAccessProvider)'/u.test(read(path)))
      .sort();
    expect(importers).toEqual(['entrypoints/background.ts', 'lib/accountAccessProvider.ts']);
  });

  it('退出 ArgoLand：先把保险箱（密文与密钥）删掉，再广播', () => {
    const logout = background.indexOf('authClient.logout().then(');
    const handler = background.slice(logout, logout + 300);
    expect(handler.indexOf('await accountVault.clear();')).toBeGreaterThan(0);
    expect(handler.indexOf('await accountVault.clear();')).toBeLessThan(handler.indexOf('broadcastSessionChanged();'));
  });

  it('发信人核对在前；交出密码要这一页正是声明了账号墙的那一家；第二把钥匙用 #130 的判定，不自己比版本号', () => {
    const at = background.indexOf('const intent = parseDockAccountAccessIntent(message);');
    expect(at).toBeGreaterThan(0);
    const listener = background.slice(at, at + 2400);
    expect(listener.indexOf('senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null')).toBeGreaterThan(0);
    expect(listener).toContain("const pageBound = step === 'STATUS' || step === 'CREDENTIAL' || step === 'RECORD' || step === 'SITE_PASSWORD';");
    expect(listener).toContain('!declaresAccountSteps(vendor)');
    expect(listener).toContain('consent: async () => signingConsentCoversAccountRegistration(await signingConsentProvider.read()),');
    expect(code(listener)).not.toMatch(/application-signing-\d/u);
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
    expect(content).toContain('...(account === null ? {} : { accountAccess: account.handlers }),');
    expect(content).toContain('onDismissed: () => { fillToReviewNow?.end(); account?.dispose(); codePage?.dispose(); submitCodeHook.read = () => null; },');
    expect(content.indexOf('account?.start();')).toBeGreaterThan(content.indexOf('dockHandle = mountAutofillDock(dock, {'));
  });

  it('账号墙过去之后接着填，走的是手势填写同一条路（AFTER_ADVANCE），「停止」是同一颗', () => {
    const at = content.indexOf('createAccountAccessPage({');
    const deps = content.slice(at, at + 3200);
    expect(deps).toContain('fillPage: (root, mode) => runGestureFill(root, fillToReview(), mode),');
    expect(deps).toContain('gestureStop = stopper;');
  });
});

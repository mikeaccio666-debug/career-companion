import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 验证码第 1 步（2026-10-04）接对了没有（源码形状闸）。各块的行为另有测试（dock-code-card、verification-code-page、
 * 内核 apply-email-code-prompt）；这一条钉接线与边界——错了，那几块照样全绿，而产品上的症状会是「验证码进了 worker 或后端」
 * 「填了验证码就替他提交了」「Assistant 构建里多出几 KB」或「卡上按了没反应」。
 */
const ROOT = resolve(__dirname, '..');
const KERNEL = resolve(__dirname, '../../../packages/apply-kernel/src');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
const content = read('entrypoints/apply.content.ts');
const page = code(read('lib/verificationCodePage.ts'));
const writer = code(readFileSync(resolve(KERNEL, 'write/emailCode.ts'), 'utf8'));
const interpreter = code(readFileSync(resolve(KERNEL, 'rules/emailVerification.ts'), 'utf8'));

describe('验证码只在这一页里走：不读邮件、不出这一页', () => {
  it('内容脚本那一侧一个网络、worker、存储的口子都没有', () => {
    for (const forbidden of ['browser.', 'chrome.', 'fetch(', 'sendMessage', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB', 'console.']) {
      expect(page, forbidden).not.toContain(forbidden);
    }
  });

  it('写验证码的那一层、认提示的那一层：不点、不提交、不发键盘事件', () => {
    for (const text of [page, writer, interpreter]) {
      expect(text).not.toMatch(/\.click\(|requestSubmit|\.submit\(|new (?:Mouse|Keyboard|Pointer)Event/u);
    }
  });

  it('写进去的值只来自他在浮层里输的那一串：写入原语只在「填进网站」那一下里叫', () => {
    const calls = [...page.matchAll(/writeEmailCode\(/gu)].length;
    expect(calls).toBe(1);
    const enter = page.slice(page.indexOf('const enter = (code: string, event: MouseEvent, shadowRoot: ShadowRoot)'));
    expect(enter.indexOf('captureTrustedShadowGesture(event, shadowRoot)')).toBeGreaterThan(0);
    expect(enter.indexOf('captureTrustedShadowGesture(event, shadowRoot)')).toBeLessThan(enter.indexOf('await '));
    expect(enter.indexOf('writeEmailCode({ prompt, code, authority: consumed.value, policy })')).toBeGreaterThan(0);
  });
});

describe('内容脚本的接线', () => {
  const showFaceStart = content.indexOf('const showFace = ');
  const showFaceEnd = content.indexOf('if (justSubmitted) missionSession.confirmArrival(document);');

  it('那一套只在 showFace 里建，只给手势路那几张脸', () => {
    expect([...code(content).matchAll(/createVerificationCodePage\(/gu)].length).toBe(1);
    const at = content.indexOf('createVerificationCodePage({');
    expect(at).toBeGreaterThan(showFaceStart);
    expect(at).toBeLessThan(showFaceEnd);
    expect(content).toContain('const codePage = !gestureFace ? null : createVerificationCodePage({');
  });

  it('浮层拿到「填进网站」；挂上之后才开始看，拆了一并收掉、提交控制器的挂钩一并摘掉', () => {
    expect(content).toContain('...(codePage === null ? {} : { verificationCode: codePage.handlers }),');
    expect(content).toContain('onDismissed: () => { fillToReviewNow?.end(); account?.dispose(); codePage?.dispose(); submitCodeHook.read = () => null; },');
    expect(content.indexOf('codePage?.start();')).toBeGreaterThan(content.indexOf('dockHandle = mountAutofillDock(dock, {'));
  });

  it('提交控制器只经挂钩问「网站在不在要验证码」（外层活代码不直接引用那一套），网站要验证码时卡马上换上', () => {
    expect(content).toContain('codePrompt: () => submitCodeHook.read(),');
    expect(content).toContain('submitCodeHook.read = () => codePage?.mark() ?? null;');
    expect(content).toContain("void sent.then((outcome) => { if (outcome === 'CODE_REQUIRED') codePage?.refresh(); }, () => {});");
    // 挂钩的赋值只在 showFace 里。
    for (const match of content.matchAll(/submitCodeHook\.read = /gu)) {
      expect(match.index!).toBeGreaterThan(showFaceStart);
      expect(match.index!).toBeLessThan(showFaceEnd);
    }
  });
});

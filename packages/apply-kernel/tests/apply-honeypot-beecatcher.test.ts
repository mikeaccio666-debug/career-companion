import { describe, expect, it } from 'vitest';

import {
  isHoneypot,
  isHoneypotGeometry,
  isHoneypotIdentity,
  isHoneyPotField,
} from '../src/dict/guards';

/**
 * Workday 官方蜜罐 `beecatcher` 的回归护栏（2026-07-31，负责人提供的竞品测评
 * 报告 §5 情报，本仓实测确认旧正则漏过）。
 *
 * 为什么单独一个文件、为什么现在就写：
 *
 * 填进蜜罐是**比"填不上"严重一个数量级**的失效模式——整份申请被静默标记为
 * bot 流量丢弃，用户端零报错，永远不知道自己为什么没有回音。而 Workday 正是
 * 我们路线图上的目标平台。
 *
 * 更要命的是它和我们自己的同义词表正面冲突：beecatcher 的 label 是
 * "Enter website…"，而 `parsers/greenhouse/applyForm.ts` 里有
 * `/(portfolio|personal (web)?site|website)/i → portfolioUrl`。也就是说通用
 * 引擎不是"没识别出来"，而是会**高置信度地主动把用户真实网址填进陷阱**。
 *
 * 旧正则 `do ?n['o]?t fill` 只认 "do not fill"，Workday 写的是 "do not enter"。
 * 一个词之差，实测漏过。
 */

/** 取自 nvidia.wd5.myworkdayjobs.com 登录表单的真实蜜罐。 */
const BEECATCHER = {
  label: "Enter website. This input is for robots only, do not enter if you're human.",
  automationId: 'beecatcher',
  // display:block / visibility:visible / opacity:1 —— 常规可见性检查全部通过。
  // 藏身只靠 position:absolute + clip:rect(1px,1px,1px,1px)，而
  // getBoundingClientRect 返回的是布局尺寸、不是裁剪后的尺寸。
  geometry: { width: 220, height: 32, clip: 'rect(1px, 1px, 1px, 1px)' },
} as const;

describe('Workday beecatcher 蜜罐', () => {
  it('文案层拦下（"do not enter" 与 "for robots only" 各自都够）', () => {
    expect(isHoneyPotField(BEECATCHER.label)).toBe(true);
    expect(isHoneyPotField("This input is for robots only")).toBe(true);
    expect(isHoneyPotField('do not enter if you are human')).toBe(true);
  });

  it('属性身份层拦下', () => {
    expect(isHoneypotIdentity([BEECATCHER.automationId])).toBe(true);
    expect(isHoneypotIdentity([null, undefined, 'beecatcher'])).toBe(true);
    for (const id of ['honeypot', 'honey-pot', 'bot_trap', 'bot-trap', 'spamTrap', 'gotcha']) {
      expect(isHoneypotIdentity([id]), id).toBe(true);
    }
  });

  it('几何层拦下 —— 1px clip 而不是零尺寸，这是它躲过 isVisible() 的手法', () => {
    expect(isHoneypotGeometry(BEECATCHER.geometry)).toBe(true);
    expect(isHoneypotGeometry({ width: 220, height: 32, clip: 'rect(1px,1px,1px,1px)' })).toBe(true);
    expect(isHoneypotGeometry({ width: 0, height: 0 })).toBe(true);
    expect(isHoneypotGeometry({ width: 220, height: 32, fontSize: 0 })).toBe(true);
  });

  it('三层任意一层命中即拒 —— 且每一层单独都能拦下这个真实样本', () => {
    expect(isHoneypot({ text: BEECATCHER.label })).toBe(true);
    expect(isHoneypot({ identities: [BEECATCHER.automationId] })).toBe(true);
    expect(isHoneypot({ geometry: BEECATCHER.geometry })).toBe(true);
    expect(
      isHoneypot({
        text: BEECATCHER.label,
        identities: [BEECATCHER.automationId],
        geometry: BEECATCHER.geometry,
      }),
    ).toBe(true);
  });

  /**
   * 反向探针：证明这几条断言不是恒真。没有这一组，把 isHoneypot 写成
   * `return true` 上面全部会绿。
   */
  it('正常字段不会被误判', () => {
    const normal = [
      'Portfolio',
      'Personal website',
      'Website',
      'LinkedIn Profile',
      'First Name',
      'Please enter your website URL',
    ];
    for (const label of normal) {
      expect(isHoneyPotField(label), label).toBe(false);
      expect(isHoneypot({ text: label }), label).toBe(false);
    }
    expect(isHoneypotIdentity(['portfolio_url', 'website', 'first_name'])).toBe(false);
    expect(isHoneypotGeometry({ width: 220, height: 32, clip: 'auto' })).toBe(false);
    expect(isHoneypotGeometry({ width: 220, height: 32 })).toBe(false);
    expect(isHoneypot({})).toBe(false);
  });

  it('原有的蜜罐文案没有回归', () => {
    for (const label of ['Please leave this field blank', '请将此栏留空', 'Do not fill this in']) {
      expect(isHoneyPotField(label), label).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { dockCopy } from '../lib/dock/copy';

/**
 * 浮层的话过了一遍（2026-09-28 负责人：说人话、安静、清楚）：面上不出现我们内部的码，也不出现我们内部的说法
 * （校验、授权范围、控件、日志……）。一句话说他能照着做的。
 */
const ZH = dockCopy('zh');
const EN = dockCopy('en');

/** 文案表里不是给人看的几项（开哪一页门户的键）：不算「说出来的话」。 */
const NOT_SHOWN: ReadonlySet<string> = new Set(['consentScopePage']);

/** 把一套文案里所有能说出来的话都走一遍：字符串原样；函数按几组常见参数各说一次。 */
function everything(copy: unknown): string[] {
  const tries: ReadonlyArray<readonly unknown[]> = [[], [3], [2, 5], [1, 4, 'Example'], ['Example'], ['Example', 'Other'], [null], ['Example', true], ['experience', 2, 3]];
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return; }
    if (typeof value === 'function') {
      for (const args of tries) {
        try {
          const result = (value as (...args: readonly unknown[]) => unknown)(...args);
          if (typeof result === 'string') out.push(result);
        } catch {
          // 这一组参数不是它要的形状：换下一组。
        }
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) if (!NOT_SHOWN.has(key)) walk(child);
    }
  };
  walk(copy);
  return out;
}

/** 我们内部的码长这样：大写加下划线。 */
const CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

describe('浮层的话：说人话', () => {
  it('uses the current display brand while preserving the version-bound legacy authorization text', () => {
    for (const copy of [ZH, EN]) {
      expect(copy.product).toBe('Career Companion');
      expect(everything(copy).filter(line => /argoland/i.test(line))).toEqual([copy.profile.consentLabel]);
    }
    expect(ZH.profile.consentLabel).toBe('允许 ArgoLand 以我的名义处理申请表上的条款、声明和授权，并替我注册、登录招聘网站。详见隐私政策。');
    expect(EN.profile.consentLabel).toBe('Let ArgoLand handle the terms, declarations and authorizations on application forms in my name, and sign up or sign in to job sites for me. See the Privacy Policy.');
  });

  it('中英两套里没有一句露出内部的码', () => {
    for (const copy of [ZH, EN]) {
      const lines = everything(copy);
      expect(lines.length).toBeGreaterThan(400);
      expect(lines.filter((line) => CODE.test(line))).toEqual([]);
    }
  });

  it('不说我们内部的说法（校验、授权范围、控件、撤销日志……）', () => {
    const zh = everything(ZH).join('\n');
    for (const phrase of ['校验', '授权到期', '授权已经用过', '允许填写的范围', '控件', '原因代号', '没能记下这一栏原来的内容', '授权已过期']) {
      expect(zh, phrase).not.toContain(phrase);
    }
    const en = everything(EN).join('\n');
    for (const phrase of ['couldn’t be verified', 'Permission for this', 'controls seen', 'this fill may change', 'Couldn’t record what']) {
      expect(en, phrase).not.toContain(phrase);
    }
  });

  it('每一句原因都说得出他接下来能做什么（没填进去的几类：去网页上填、看一眼、再点一次）', () => {
    const actionable = ['WRITE_REVERTED', 'HOST_REJECTED', 'UNSUPPORTED_CONTROL', 'GESTURE_EXPIRED', 'GRANT_CONSUMED', 'LEASE_INVALID', 'VERIFY_TIMEOUT', 'HOST_UNCONFIRMED'];
    for (const code of actionable) {
      expect(ZH.reasons[code], code).toMatch(/请|看一眼|再点一次|改一下/);
      expect(EN.reasons[code], code).toMatch(/Please|Take a look|Press Autofill again|Follow/);
    }
  });

  it('「需要你」那几组的名字与动作', () => {
    expect(ZH.needs.groups).toEqual({ choose: '选一个', write: '写一段', missing: '资料里没有', decide: '你来决定', check: '去网页上看一眼', review: '提交前核对' });
    expect(EN.needs.groups).toEqual({ choose: 'Pick one', write: 'Write a few lines', missing: 'Not in your profile', decide: 'Your call', check: 'Check on the page', review: 'Check before you submit' });
    expect([ZH.needs.more, ZH.needs.go, ZH.needs.fill, ZH.needs.aiWrite, ZH.bar.first, ZH.bar.nextItem]).toEqual(['更多选项', '去这一栏', '填入', 'AI 帮我写', '去第一项', '下一处']);
    expect([EN.needs.more, EN.needs.go, EN.needs.fill, EN.needs.aiWrite, EN.bar.first, EN.bar.nextItem]).toEqual(['More options', 'Go to field', 'Fill in', 'Write it with AI', 'Go to first item', 'Next item']);
  });
});

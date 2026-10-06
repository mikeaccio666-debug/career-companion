/**
 * 「问句形态」的标签：同一个问题，写成一句完整的话就认不出来了。
 *
 * 标签逐字取自 2026-09-22 用生产包 + 真账号跑的 42 页真实申请页。那一轮里
 * 「没把握，没敢填」与「这个选项需要你来选」合计 130 项，下面这三种写法占了 18 项，
 * 而**每一项的答案都已经在档案里**：
 *
 *  · Ashby「What pronouns would you like our team to use?」×6 —— 档案有 preferredPronouns，
 *    但规则那条要求整条标签就是 `pronouns`，一句完整的问话一个都不中。
 *  · Ashby「How did you hear about this opportunity? (Please be specific)」×6 ——
 *    规则允许句尾带括号补充，却把括号写在问号**之前**；真实页面是先问号后括号。
 *  · Lever「Which university are you currently attending or did you last attend?」×6 ——
 *    答案是教育段第一行的学校名，规则里没有任何一条指向 `education.school`。
 *
 * 这三条都不是「我们没有这份资料」，是「我们没认出这是在问那份资料」。用户读到的
 * 却是「没把握，没敢填」——他会以为是我们不敢填，而不是我们没看懂题。
 */

import { afterEach, describe, expect, it } from 'vitest';

import ashby from '../../apply-rules/rules/ashby.json';
import greenhouse from '../../apply-rules/rules/greenhouse.json';
import lever from '../../apply-rules/rules/lever.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

/** 每家的申请表根锚点不同（ashby 是容器 div，其余两家是 form#application-form）。 */
const ANCHOR: Readonly<Record<string, (inner: string) => string>> = {
  ashby: (inner) => `<div class="ashby-application-form-container"><form>${inner}</form></div>`,
  greenhouse: (inner) => `<form id="application-form">${inner}</form>`,
  lever: (inner) => `<form id="application-form">${inner}</form>`,
};

/** 一条标签 + 一个文本框，问适配器这一栏认到了哪个键。 */
function keyOf(ruleset: unknown, labelText: string): string | null {
  const vendor = (ruleset as { vendor: string }).vendor;
  document.body.innerHTML = (ANCHOR[vendor] ?? ANCHOR.greenhouse!)(`
    <label for="q1">${labelText}</label>
    <input id="q1" type="text">
  `);
  const adapter = compileBundledAdapter(ruleset as Ruleset);
  const root = adapter.resolveRoot(document);
  if (root === null) throw new Error('root missing');
  // 表里只有这一个控件；按元素找而不是按标签文本找——适配器会把「(optional)」
  // 一类的修饰从标签里剥掉，按文本找会在剥掉之后认不出自己刚放进去的那一栏。
  const input = document.querySelector('#q1');
  return [...adapter.scan(root)].find((field) => field.element === input)?.key ?? null;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('代词：问成一句话也要认出来', () => {
  const ASKED = [
    'What pronouns would you like our team to use?',
    'What pronouns do you use?',
    'Which pronouns do you use?',
    'What are your pronouns?',
    'What pronouns would you like us to use?',
  ] as const;

  for (const label of ASKED) {
    it(`Ashby「${label}」→ preferredPronouns`, () => {
      expect(keyOf(ashby, label)).toBe('preferredPronouns');
    });
  }

  it('原来那几种短写法不能被顶掉', () => {
    expect(keyOf(ashby, 'Pronouns')).toBe('preferredPronouns');
    expect(keyOf(ashby, 'Preferred pronouns')).toBe('preferredPronouns');
    expect(keyOf(ashby, 'Pronouns (optional)')).toBe('preferredPronouns');
  });

  // 「你希望我们怎么称呼你」问的是称呼，不是代词；名字那一栏已经有 preferredName。
  it('问称呼的不算代词题', () => {
    expect(keyOf(ashby, 'What name would you like us to use?')).not.toBe('preferredPronouns');
  });
});

describe('来源：括号补充跟在问号后面', () => {
  const ASKED = [
    'How did you hear about this opportunity? (Please be specific)',
    'How did you hear about us? (optional)',
    'How did you hear about this role? (e.g. LinkedIn, referral)',
  ] as const;

  for (const label of ASKED) {
    it(`Ashby「${label.slice(0, 44)}」→ heardAboutSource`, () => {
      expect(keyOf(ashby, label)).toBe('heardAboutSource');
    });
  }

  it('Greenhouse 同一条也认', () => {
    expect(keyOf(greenhouse, 'How did you hear about this job? (Please be specific)'))
      .toBe('heardAboutSource');
  });

  it('括号在问号之前的老写法仍然认', () => {
    expect(keyOf(ashby, 'How did you hear about this opportunity (optional)?'))
      .toBe('heardAboutSource');
  });

  // 问的是「你听说了我们的什么」，不是「你从哪里听说的」。
  it('不认「听说了什么」', () => {
    expect(keyOf(ashby, 'What did you hear about our culture?')).not.toBe('heardAboutSource');
  });
});

describe('学校：不在教育段里单独问的那一道', () => {
  const ASKED = [
    'Which university are you currently attending or did you last attend?',
    'Which university did you attend?',
    'What university are you currently attending?',
    'Which college did you last attend?',
  ] as const;

  for (const label of ASKED) {
    it(`Lever「${label.slice(0, 44)}」→ education.school`, () => {
      expect(keyOf(lever, label)).toBe('education.school');
    });
  }

  // 学位与专业是另外两道题，别一起吞掉。
  it('不认学位与专业', () => {
    expect(keyOf(lever, 'What degree did you earn?')).not.toBe('education.school');
    expect(keyOf(lever, 'What was your major?')).not.toBe('education.school');
  });
});

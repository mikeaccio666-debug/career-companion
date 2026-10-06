/**
 * 同一道题多写几个修饰词就认不出来了。
 *
 * 标签逐字取自 2026-09-22 的真实批测语料（97 页跑通的申请页）：
 *
 *  · Workable ×6「What is your gross annual salary expectations for this role?」
 *    ——档案里 expectedSalaryAmount 有值，规则也有这一条，但正则要求
 *    「your」后面直接跟 salary，中间夹了 `gross annual` 就整条落空，
 *    再落进 `isJobDependentField` 报「取决于这个岗位，由你回答」。
 *  · BambooHR ×3「How did you learn about Nomad? (Acquaintance, Nomad employee, …)」
 *    ——句尾括号里把选项列了出来，长度轻松超过原来钉的 80 字符上限。
 *
 * 两条都不是「我们没有这份资料」，是写法比我们钉的窄一点点。
 */

import { afterEach, describe, expect, it } from 'vitest';

import bamboohr from '../../apply-rules/rules/bamboohr.json';
import workable from '../../apply-rules/rules/workable.json';
import greenhouse from '../../apply-rules/rules/greenhouse.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

const ANCHOR: Readonly<Record<string, (inner: string) => string>> = {
  workable: (inner) => `<form data-ui="application-form">${inner}</form>`,
  bamboohr: (inner) => `<form id="job-application-form">${inner}</form>`,
  greenhouse: (inner) => `<form id="application-form">${inner}</form>`,
};

function keyOf(ruleset: unknown, labelText: string): string | null {
  const vendor = (ruleset as { vendor: string }).vendor;
  document.body.innerHTML = (ANCHOR[vendor] ?? ANCHOR.greenhouse!)(`
    <label for="q1">${labelText}</label>
    <input id="q1" type="text">
  `);
  const adapter = compileBundledAdapter(ruleset as Ruleset);
  const root = adapter.resolveRoot(document);
  if (root === null) throw new Error(`root missing for ${vendor}`);
  const input = document.querySelector('#q1');
  return [...adapter.scan(root)].find((field) => field.element === input)?.key ?? null;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('期望薪资：中间夹修饰词、句尾带「for this role」也要认', () => {
  const ASKED = [
    'What is your gross annual salary expectations for this role?',
    'What are your base salary expectations for this position?',
    'What is your expected annual compensation?',
    'What is your salary expectation for this role?',
  ] as const;

  for (const label of ASKED) {
    it(`Workable「${label.slice(0, 46)}」→ expectedSalaryAmount`, () => {
      expect(keyOf(workable, label)).toBe('expectedSalaryAmount');
    });
  }

  it('原来那几种短写法不能被顶掉', () => {
    expect(keyOf(workable, 'Salary expectations')).toBe('expectedSalaryAmount');
    expect(keyOf(workable, 'Expected salary')).toBe('expectedSalaryAmount');
    expect(keyOf(workable, 'Desired pay (annual)')).toBe('expectedSalaryAmount');
  });

  // 问的是这个岗位给多少、或者上一份拿多少，都不是他要的数。
  it('不认「当前薪资」与「本岗位薪酬区间」', () => {
    expect(keyOf(workable, 'What is your current salary?')).not.toBe('expectedSalaryAmount');
    expect(keyOf(workable, 'What is the salary range for this role?')).not.toBe('expectedSalaryAmount');
  });
});

describe('来源：句尾括号里把选项列出来也要认', () => {
  it('BambooHR 那条长括号', () => {
    expect(keyOf(
      bamboohr,
      'How did you learn about Nomad? (Acquaintance, Nomad employee, Indeed, LinkedIn, job fair, college career center, other)',
    )).toBe('heardAboutSource');
  });

  it('短括号照旧认', () => {
    expect(keyOf(bamboohr, 'How did you hear about us? (optional)')).toBe('heardAboutSource');
  });

  // 括号无限长等于「这一行随便写什么都算」。超出上限就不认。
  it('括号长到离谱就不认了', () => {
    expect(keyOf(bamboohr, `How did you hear about us? (${'x'.repeat(400)})`))
      .not.toBe('heardAboutSource');
  });
});

/**
 * 三个最普遍的字段，一条标签规则都没有。
 *
 * 2026-09-22 清点：`email` / `addressLine1` / `addressPostalCode` 在十一份规则里
 * **没有任何 labelPatterns**，全靠各家自己的 `attrMap`（`name="email"` 这类）。
 * 在 ATS 自己的域名上这没问题——钩子就在那儿。但一旦页面认不出厂商（公司自建域），
 * attrMap 整条路都不成立，而这三个恰恰是每张申请表都有、标签写法又最统一的字段。
 *
 * 量出来的代价：97 页真实语料里已填的 1545 个字段实例，只靠标签文案能认出 62%；
 * 认不出的那一批里最大的三块就是 Email（170 次）、Address（54 次）、ZIP（32 次）。
 * 补上这三条，通用路的上界从六成抬到八成左右。
 *
 * 标签逐字取自那份语料。
 */

import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '../../apply-rules/rules/greenhouse.json';
import lever from '../../apply-rules/rules/lever.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

/** 不给控件任何站点钩子：没有 name、没有 id 语义，只剩标签。 */
function keyOf(ruleset: unknown, labelText: string): string | null {
  document.body.innerHTML = `<form id="application-form">
    <label for="q1">${labelText}</label>
    <input id="q1" type="text">
  </form>`;
  const adapter = compileBundledAdapter(ruleset as Ruleset);
  const root = adapter.resolveRoot(document);
  if (root === null) throw new Error('root missing');
  const input = document.querySelector('#q1');
  return [...adapter.scan(root)].find((field) => field.element === input)?.key ?? null;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('邮箱', () => {
  for (const label of ['Email', 'Email address', 'E-mail', 'Email Address *'] as const) {
    it(`「${label}」→ email`, () => expect(keyOf(greenhouse, label)).toBe('email'));
  }

  it('Lever 同一条也认', () => expect(keyOf(lever, 'Email')).toBe('email'));

  // 他人信息栏另有守卫，但认键这一层就不该把它当申请人自己的邮箱。
  it('推荐人／紧急联系人的邮箱不算', () => {
    expect(keyOf(greenhouse, "Referrer's email")).not.toBe('email');
    expect(keyOf(greenhouse, 'Emergency contact email')).not.toBe('email');
  });
});

describe('街道地址', () => {
  for (const label of ['Address', 'Street address', 'Address Line 1'] as const) {
    it(`「${label}」→ addressLine1`, () => expect(keyOf(greenhouse, label)).toBe('addressLine1'));
  }

  // 「第二行」是另一栏（公寓号之类），我们没有那个键，别把它当第一行填了。
  it('Address Line 2 不算', () => {
    expect(keyOf(greenhouse, 'Address Line 2')).not.toBe('addressLine1');
  });

  // 邮箱地址里也有 address 这个词。
  it('Email address 仍然是邮箱', () => {
    expect(keyOf(greenhouse, 'Email address')).toBe('email');
  });
});

describe('邮编', () => {
  for (const label of ['ZIP', 'Zip code', 'Postal code', 'ZIP / Postal code'] as const) {
    it(`「${label}」→ addressPostalCode`, () => {
      expect(keyOf(greenhouse, label)).toBe('addressPostalCode');
    });
  }
});

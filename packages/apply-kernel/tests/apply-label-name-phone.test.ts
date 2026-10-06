/**
 * 姓名与电话：一张申请表的地板，纯标签下一个都认不出。
 *
 * 2026-09-22 做 genericRoot 时撞到的：拿一张「客户自己写的前端」去试，
 * First name / Last name / Phone 三栏全落 null——它们**完全**依赖各家
 * `attrMap` 的 `name` 钩子（`name="first_name"` 这类），一条 labelPatterns 都没有。
 * 认不出厂商的页面上那条路不成立，于是连申请人叫什么、电话多少都填不了。
 *
 * #52 补的是邮箱、街道、邮编；这一刀补剩下的地板。标签逐字取自 97 页真实语料：
 *
 *   Phone 137 · First Name 76 · Last Name 76 · Full Name 67 · Phone Number 11
 *   Phone+1 12 · Phone +1 10（带旗标的号码框把区号缀在标签上）
 *
 * 「不认」的用例比「认」的多，因为这几个词在申请表上到处都是：推荐人姓名、
 * 紧急联系人姓名、公司名、分机号——认错一个，写进去的就是别人的资料。
 */

import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '../../apply-rules/rules/greenhouse.json';
import lever from '../../apply-rules/rules/lever.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

/** 不给控件任何站点钩子：没有 name、没有语义 id，只剩标签。 */
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

describe('名', () => {
  for (const label of ['First Name', 'First name', 'Given name'] as const) {
    it(`「${label}」→ firstName`, () => expect(keyOf(greenhouse, label)).toBe('firstName'));
  }
  it('Lever 同一条也认', () => expect(keyOf(lever, 'First Name')).toBe('firstName'));
  // 既有那条「Legal / Preferred 前缀」不能被顶掉。
  it('Legal First Name 仍然是 firstName，Preferred First Name 仍然是 preferredName', () => {
    expect(keyOf(greenhouse, 'Legal First Name')).toBe('firstName');
    expect(keyOf(greenhouse, 'Preferred First Name')).toBe('preferredName');
  });
});

describe('姓', () => {
  for (const label of ['Last Name', 'Last name', 'Surname', 'Family name'] as const) {
    it(`「${label}」→ lastName`, () => expect(keyOf(greenhouse, label)).toBe('lastName'));
  }
});

describe('全名', () => {
  for (const label of ['Full Name', 'Full name', 'Legal full name'] as const) {
    it(`「${label}」→ fullName`, () => expect(keyOf(greenhouse, label)).toBe('fullName'));
  }
});

describe('电话', () => {
  for (const label of ['Phone', 'Phone Number', 'Phone number', 'Mobile phone', 'Cell phone'] as const) {
    it(`「${label}」→ phone`, () => expect(keyOf(greenhouse, label)).toBe('phone'));
  }

  // 带旗标的号码框把区号缀在标签后面（语料里 22 次）。
  it('标签缀了区号也认：Phone+1 / Phone +1', () => {
    expect(keyOf(greenhouse, 'Phone+1')).toBe('phone');
    expect(keyOf(greenhouse, 'Phone +1')).toBe('phone');
  });
});

describe('这些一律不认', () => {
  // 语料里 33 次。它问的是怎么念，不是叫什么。
  it('名字读音不是名字', () => {
    const label = 'Name Pronunciation | How do you pronounce your name?';
    expect(['firstName', 'lastName', 'fullName']).not.toContain(keyOf(greenhouse, label));
  });

  it('他人姓名不是申请人姓名', () => {
    for (const label of ['Emergency contact name', "Referrer's first name", 'Reference full name']) {
      expect(['firstName', 'lastName', 'fullName'], label).not.toContain(keyOf(greenhouse, label));
    }
  });

  it('公司名不是全名', () => {
    expect(keyOf(greenhouse, 'Company name')).not.toBe('fullName');
    expect(keyOf(greenhouse, 'School name')).not.toBe('fullName');
  });

  // 分机与区号另有守卫，但认键这一层也不该把它们当号码本身。
  it('分机与区号不是电话', () => {
    for (const label of ['Phone extension', 'Area code', 'Phone type']) {
      expect(keyOf(greenhouse, label), label).not.toBe('phone');
    }
  });
});

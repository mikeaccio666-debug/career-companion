/**
 * LinkedIn 个人页写成 LinkedIn 自己的规范形式：`https://www.linkedin.com/in/…`。
 *
 * 2026-09-22 nvidia.wd5 第 2 步 My Experience：档案里的地址是 https、带 /in/、没有查询串也没有
 * 尾斜杠，只是**不带 www**。Workday 判「Invalid LinkedIn URL」，这一页翻不过去，只能清空这一栏。
 *
 * 不带 www、国家子域、http 都会被 LinkedIn 自己跳转到 `https://www.linkedin.com/in/…`，是同一个
 * 地址，写规范形式不是改写用户的资料。认不出是个人页的（公司页、短链、别的主机）原样写。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFormDescriptor } from '../src/contracts';

/** 一个普通文本框，键已经由规则认到 linkedinUrl（Workday 第 2 步就是这样一栏）。 */
function form(): ApplyFormDescriptor {
  document.body.innerHTML = `<form>
    <label for="li">Please provide a link to your LinkedIn profile:</label>
    <input id="li" type="text" name="linkedInAccount">
  </form>`;
  const element = document.querySelector('#li') as HTMLInputElement;
  return {
    vendor: 'workday',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'text',
      element, key: 'linkedinUrl', label: 'Please provide a link to your LinkedIn profile:', required: false, confidence: 1,
      signature: { core: 'form/input:0', labelHint: 'li' },
    }],
  } as never;
}

const written = (linkedinUrl: string): string | undefined =>
  buildApplyPlan(form(), { linkedinUrl } as never, { fillEmptyOnly: false } as never).entries[0]?.value;

afterEach(() => { document.body.innerHTML = ''; });

describe('写进申请表的 LinkedIn 地址', () => {
  it('不带 www → 补上（nvidia.wd5 第 2 步就是这一种）', () => {
    expect(written('https://linkedin.com/in/ada-lovelace')).toBe('https://www.linkedin.com/in/ada-lovelace');
  });

  it('http、国家子域、手机子域 → 规范形式；路径与查询逐字保留', () => {
    expect(written('http://uk.linkedin.com/in/ada-lovelace?trk=profile')).toBe('https://www.linkedin.com/in/ada-lovelace?trk=profile');
    expect(written('https://m.linkedin.com/in/Ada-Lovelace/')).toBe('https://www.linkedin.com/in/Ada-Lovelace/');
  });

  it('已经是规范形式 → 一个字不动', () => {
    expect(written('https://www.linkedin.com/in/ada-lovelace/')).toBe('https://www.linkedin.com/in/ada-lovelace/');
  });

  it('认不出是个人页 → 原样写', () => {
    for (const value of [
      'https://linkedin.com/company/acme',
      'https://www.linkedin.com/pub/ada-lovelace/1/2/3',
      'https://lnkd.in/abc123',
      'https://linkedin.com.example.test/in/ada',
      'https://user@linkedin.com/in/ada',
      'https://linkedin.com:8443/in/ada',
      'https://ada.example.test',
    ]) {
      expect(written(value), value).toBe(value);
    }
  });
});

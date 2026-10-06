import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 电话设备类型：有 cell / mobile 就选（产品决定，2026-09-22）。
 *
 * Workday「My Information」的 Phone Device Type 是**必填**，而档案里没有「电话类型」这一项。
 * 它空着，「Save and Continue」就过不去——整个向导卡在第一步，后面的工作经历、教育、
 * 问答、EEO 一页都进不去。2026-09-22 在 nvidia.wd5 真实页面上它是唯一挡路的一栏。
 *
 * 档案里留的电话几乎都是手机，所以：选项里有 cell / mobile 那一类就选它；没有就留给用户。
 * NVIDIA 的真实选项是「Home」与「Home Cellular」——连「Mobile」这个词都没有，各家写法
 * 不一样，所以候选是一份常见写法的清单（Mobile、Cell、Cellular、Home Cellular…），按
 * 共用的候选阶梯（精确 → 规范化 → 词边界前缀）去撞；「Mobile - Personal」与
 * 「Mobile - Work」同时在时判歧义、留给用户，不替他挑工作机。
 *
 * ## 为什么沿用 `phone` 键
 *
 * 新增一个档案键要先改 argoland 的线上契约（本仓有一道闸强制两边键集相等），而这个值
 * 后端根本不会发。所以规定：`phone` 落在**选项控件**上、题目问的是设备类型时，候选是
 * 设备类型——与「州码落在下拉上 = 选州全名」同一个套路。
 *
 * 这要动两处现成的纪律，各自钉了反向探针：
 *  · 「电话元数据栏（分机 / 区号 / 设备类型）绝不接整串号码」的守卫：设备类型**选择器**
 *    成为例外——它收的是设备类型，不是号码。分机、区号、以及设备类型的**文本框**照旧拦。
 *  · 同一段里同键只留一个的仲裁：「号码框 + 类型选择器」这一对豁免，像「邮箱 + 确认邮箱」。
 */

const listbox = (field: string, fkit: string, label: string, name: string) => `
  <div data-automation-id="${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label}*</label>
    <div><div><div><button id="${fkit}" name="${name}" type="button" aria-haspopup="listbox">Select One</button><input type="text" /><span></span></div></div><div></div></div>
  </div>`;
const text = (field: string, fkit: string, label: string, name: string) => `
  <div data-automation-id="${field}" data-fkit-id="${fkit}">
    <label for="${fkit}">${label}</label>
    <div><div><input id="${fkit}" name="${name}" type="text" /></div><div></div></div>
  </div>`;

const MY_INFO = `
  <div data-automation-id="applyFlowMyInfoPage">
    ${listbox('formField-phoneType', 'phoneNumber--phoneType', 'Phone Device Type', 'phoneType')}
    ${text('formField-phoneNumber', 'phoneNumber--phoneNumber', 'Phone Number*', 'phoneNumber')}
    ${text('formField-extension', 'phoneNumber--extension', 'Phone Extension', 'extension')}
  </div>`;

const adapter = () => compileBundledAdapter(workday as never);

const planFor = (html: string, profile: Record<string, string>) => {
  document.body.innerHTML = html;
  const root = adapter().resolveRoot(document)!;
  return buildApplyPlan(
    { vendor: 'workday', root, fields: [...adapter().scan(root)] } as never,
    profile as never,
  );
};

const entryIn = (plan: ReturnType<typeof planFor>, formField: string) =>
  plan.entries.find((entry) => entry.element.closest(`[data-automation-id="${formField}"]`) !== null);

afterEach(() => { document.body.innerHTML = ''; });

describe('Phone Device Type：有 cell / mobile 就选', () => {
  it('设备类型选择器进计划，候选是 cell / mobile 那一类', () => {
    const plan = planFor(MY_INFO, { phone: '+15551234567' });
    const entry = entryIn(plan, 'formField-phoneType');
    expect(entry, '必填的设备类型空着，整个 Workday 向导就过不了第一步').toBeDefined();
    expect(entry!.kind).toBe('combobox');
    const candidates = entry!.kind === 'combobox' ? entry!.comboboxCandidates : [];
    expect(candidates).toContain('Home Cellular');
    expect(candidates).toContain('Mobile');
    // 候选里一个号码都不许有：这一栏收的是设备类型。
    expect(candidates.some((candidate) => /\d{4,}/.test(candidate))).toBe(false);
  });

  it('号码框与设备类型选择器同段并存，两个都照填（同键仲裁豁免这一对）', () => {
    const plan = planFor(MY_INFO, { phone: '+15551234567' });
    expect(entryIn(plan, 'formField-phoneNumber')?.value).toBe('+15551234567');
    expect(entryIn(plan, 'formField-phoneType')).toBeDefined();
  });

  it('反向探针：档案里没有电话 → 设备类型也不选', () => {
    const plan = planFor(MY_INFO, {});
    expect(entryIn(plan, 'formField-phoneType')).toBeUndefined();
  });

  it('反向探针：分机栏照旧拦——元数据守卫只对设备类型**选择器**开口', () => {
    const plan = planFor(MY_INFO, { phone: '+15551234567' });
    expect(entryIn(plan, 'formField-extension'), '整串号码写进了分机栏').toBeUndefined();
  });

  it('反向探针：设备类型如果是**文本框**，照旧拦——号码不许写进去', () => {
    const html = `
      <div data-automation-id="applyFlowMyInfoPage">
        ${text('formField-phoneType', 'phoneNumber--phoneType', 'Phone Device Type', 'phoneType')}
        ${text('formField-phoneNumber', 'phoneNumber--phoneNumber', 'Phone Number*', 'phoneNumber')}
      </div>`;
    const plan = planFor(html, { phone: '+15551234567' });
    expect(entryIn(plan, 'formField-phoneType')).toBeUndefined();
  });
});

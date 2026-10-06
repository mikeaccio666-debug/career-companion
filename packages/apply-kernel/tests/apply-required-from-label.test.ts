import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import type { ApplyFieldDescriptor } from '../src/contracts';
import { hasRequiredMarkerAtEdge } from '../src/dict/requiredMarker';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { bamboohrAdapter } from '../src/sites/bamboohr/applyForm';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { workableAdapter } from '../src/sites/workable/applyForm';

/**
 * 必填也可以只写在标签上（2026-09-23）。
 *
 * 很多宿主不给控件 required / aria-required，只在用户读的那段标签文字里标一个星号：
 * BambooHR 渲染「Are you at least 18 years of age? *」（尾部 ` *`），Workable 把红色的 `*`
 * 放在题干**前面**。过去这些字段一律 required=false，浮层的「需要你」只列必填——
 * youngliving.bamboohr.com/careers/187 上它说「还有 1 项」，实际 7 道必填没答。
 *
 * 规则：标签原文（显示用的标签把记号剥掉了，这里读的是同一来源、同一次遍历的原文）的
 * 头或尾挂着 `*` `✱` `✳` `＊`，或者结尾是「(required)」「(必填)」，就是必填；带「(optional)」
 * 「(选填)」的不算；句中一个光秃秃的 required 不算。选择题看题干（组名 / 单成员自己的标签 /
 * question scope 题干）。题目文字是合成的。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function field(fields: readonly ApplyFieldDescriptor[], id: string): ApplyFieldDescriptor | undefined {
  const element = document.getElementById(id);
  return fields.find((candidate) => candidate.element === element);
}

describe('BambooHR：星号在标签尾部', () => {
  it('「… *」是必填；「(optional)」照旧选填；句中的 required 不是记号', () => {
    document.body.innerHTML = `
      <form id="job-application-form">
        <label for="firstName">First Name *</label><input id="firstName" name="firstName" type="text">
        <label for="q18">Are you at least 18 years of age? *</label>
        <select id="q18" name="customQuestions[0]"><option value=""></option><option>Yes</option><option>No</option></select>
        <label for="nick">Preferred nickname (optional)</label><input id="nick" name="customQuestions[1]" type="text">
        <label for="salary">Salary required</label><input id="salary" name="customQuestions[2]" type="text">
        <label for="plain">Anything else we should know?</label><input id="plain" name="customQuestions[3]" type="text">
      </form>`;
    const root = bamboohrAdapter.resolveRoot(document)!;
    const fields = [...bamboohrAdapter.scan(root)];
    expect(field(fields, 'firstName')?.required).toBe(true);
    expect(field(fields, 'q18')).toMatchObject({ required: true, label: 'Are you at least 18 years of age?' });
    expect(field(fields, 'nick')?.required).toBe(false);
    expect(field(fields, 'salary')?.required).toBe(false);
    expect(field(fields, 'plain')?.required).toBe(false);
  });
});

describe('Workable：星号在题干前面（与题干同在包裹的 label 里）', () => {
  it('前置的 `*` 是必填，没有星号的照旧选填；显示用的标签不带星号', () => {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <label><span><span><strong>*</strong></span><span><span id="why_label"><strong>Why do you want this role?</strong></span></span></span>
          <textarea id="why" name="QA_101" aria-labelledby="why_label"></textarea></label>
        <label><span><span><span id="extra_label"><strong>Anything else?</strong></span></span></span>
          <textarea id="extra" name="QA_102" aria-labelledby="extra_label"></textarea></label>
      </form>`;
    const root = workableAdapter.resolveRoot(document)!;
    const fields = [...workableAdapter.scan(root)];
    expect(field(fields, 'why')).toMatchObject({ required: true, label: 'Why do you want this role?' });
    expect(field(fields, 'extra')?.required).toBe(false);
  });
});

describe('选择题看题干', () => {
  it('fieldset 的 legend 带星号 → 整组必填；单个复选框自己的标签带星号 → 必填', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <fieldset><legend>Are you willing to relocate? *</legend>
          <label><input type="radio" id="r1" name="reloc" value="y"> Yes</label>
          <label><input type="radio" id="r2" name="reloc" value="n"> No</label>
        </fieldset>
        <fieldset><legend>Preferred shift</legend>
          <label><input type="radio" id="s1" name="shift" value="d"> Day</label>
          <label><input type="radio" id="s2" name="shift" value="n"> Night</label>
        </fieldset>
        <label><input type="checkbox" id="ack" name="ack"> I have read the job description ✱</label>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    expect(field(fields, 'r1')?.required).toBe(true);
    expect(field(fields, 's1')?.required).toBe(false);
    expect(field(fields, 'ack')?.required).toBe(true);
  });
});

/**
 * 星号是 `aria-hidden` 的一个元素（2026-09-28 adobe.wd5 实测）：Workday 把题干写成
 * `<label><span>Degree<abbr aria-hidden="true">*</abbr></span></label>`——星号看得见，只是不念给读屏
 * （读屏从按钮的 aria-label「Degree Select One Required」听到必填）。按钮下拉扫到的是旁边那个 0×0 的镜像
 * 输入框，它自己一个 required 都没有；标签原文又把 aria-hidden 的文字裁掉了，于是 Degree、Country、
 * Phone Device Type 一律 required=false。第 2 页三段教育的学位档案里没有：浮层说「这一页填好了」，连填照样
 * 按下一步，Workday 整页报「The field Degree is required」。
 */
describe('Workday：星号是 aria-hidden 的 <abbr>', () => {
  const listbox = (field: string, fkit: string, label: string, star: string) => `
    <div data-automation-id="formField-${field}" data-fkit-id="${fkit}">
      <label for="${fkit}"><span>${label}${star}</span></label>
      <div><div><div><button id="${fkit}" name="${field}" type="button" aria-haspopup="listbox">Select One</button><input type="text" id="mirror-${field}" /><span></span></div></div><div></div></div>
    </div>`;
  const scanWorkday = (body: string) => {
    document.body.innerHTML = `<div data-automation-id="applyFlowMyInfoPage">${body}</div>`;
    const adapter = compileBundledAdapter(workday as never);
    const root = adapter.resolveRoot(document)!;
    return [...adapter.scan(root)];
  };

  it('按钮下拉的镜像输入框：题干旁 aria-hidden 的星号就是必填；显示用的题干不带星号', () => {
    const fields = scanWorkday([
      listbox('country', 'country--country', 'Country', '<abbr aria-hidden="true">*</abbr>'),
      listbox('countryRegion', 'address--countryRegion', 'State', ''),
    ].join(''));
    expect(field(fields, 'mirror-country')).toMatchObject({ required: true, label: 'Country', kind: 'combobox' });
    expect(field(fields, 'mirror-countryRegion')?.required).toBe(false);
  });

  it('反向探针：aria-hidden 的图标、藏起来（hidden）的星号都不算必填', () => {
    const fields = scanWorkday([
      listbox('country', 'country--country', 'Country', '<span aria-hidden="true">info</span>'),
      listbox('countryRegion', 'address--countryRegion', 'State', '<abbr aria-hidden="true" hidden>*</abbr>'),
    ].join(''));
    expect(field(fields, 'mirror-country')).toMatchObject({ required: false, label: 'Country' });
    expect(field(fields, 'mirror-countryRegion')?.required).toBe(false);
  });
});

describe('记号判据（dict/requiredMarker.ts）', () => {
  it.each([
    ['Are you at least 18 years of age? *', true],
    ['*Why do you want this role?', true],
    ['* Email', true],
    ['Phone ✱', true],
    ['✳ City', true],
    ['Country＊', true],
    ['Portfolio (required)', true],
    ['Portfolio (Required)', true],
    ['所在城市（必填）', true],
    ['Nickname (optional)', false],
    ['Nickname (optional) *', false],
    ['昵称（选填）', false],
    ['Salary required', false],
    ['Required documents list', false],
    ['What does 5 * 3 equal?', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(hasRequiredMarkerAtEdge(text)).toBe(expected);
  });
});

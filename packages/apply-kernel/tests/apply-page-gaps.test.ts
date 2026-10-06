import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFieldDescriptor } from '../src/contracts';
import { readPageGaps } from '../src/pageGaps';
import { createScanRoot } from '../src/scanRoot';
import { ripplingAdapter } from '../src/sites/rippling/applyForm';

/**
 * 页面上还空着、还报着错的必填（2026-10-04，bench-1003）：浮层没认出的必填也要说出来，连填看到就不翻页。
 *
 * 夹具的结构照 2026-10-04 在 jobs.jobvite.com/ashcompanies/job/<id>/apply 只读抓到的样子（题目原文是公开的岗位
 * 页面内容，不含任何人的资料）：每道是非题是 `fieldset > legend + label > (i[role=radio] + input[type=radio])`，
 * 原生单选被样式藏起来（看得见的是标签），简历是一颗 `aria-required="true"` 的「Select」按钮。那一天浮层一道都没认出来，
 * 说「这一页填好了」，连填替他按了「Next」，网站当场把四道题和简历标红。
 */

afterEach(() => { document.body.innerHTML = ''; });

const JOBVITE = `
  <div class="jv-form jv-apply-form">
    <h3 id="jv-resume-header">Add Resume<span>*</span></h3>
    <div class="jv-apply-section" id="attachResume">
      <div><button type="button" class="jv-button" aria-haspopup="true" aria-labelledby="jv-resume-header" aria-required="true">Select <svg aria-hidden="true"></svg></button></div>
      <div class="jv-add-attachment" aria-hidden="true"><label for="paste" class="jv-visually-hidden">Type or paste your Resume here</label><textarea id="paste"></textarea>
        <button type="button">Cancel</button><button type="button" disabled>Save</button></div>
      <ul class="jv-file-list"></ul>
    </div>
    <form name="applyForm">
      <label for="first">First Name*</label>
      <input id="first" name="input-first" type="text" autocomplete="given-name" required aria-required="true">
      <label for="ref">If you were referred by a current employee, please list employee name</label>
      <input id="ref" name="input-ref" type="text" aria-required="false">
      <fieldset class="jv-input-group">
        <legend>Are you legally authorized to work in the United States?<span>*</span></legend>
        <label for="q1-0"><i class="icon" role="radio" aria-selected="false"></i>
          <input id="q1-0" name="q1" type="radio" value="Yes" required aria-required="true"> Yes</label>
        <label for="q1-1"><i class="icon" role="radio" aria-selected="false"></i>
          <input id="q1-1" name="q1" type="radio" value="No" required aria-required="true"> No</label>
      </fieldset>
      <fieldset class="jv-input-group">
        <legend>Will you now or in the future require sponsorship for an immigration-related employment benefit?<span>*</span></legend>
        <label for="q2-0"><i class="icon" role="radio"></i><input id="q2-0" name="q2" type="radio" value="Yes" required> Yes</label>
        <label for="q2-1"><i class="icon" role="radio"></i><input id="q2-1" name="q2" type="radio" value="No" required> No</label>
      </fieldset>
      <fieldset class="jv-input-group">
        <legend>Acknowledgement<span>*</span></legend>
        <label for="q3-0"><i class="icon" role="radio"></i><input id="q3-0" name="q3" type="radio" value="I Agree" required> I Agree</label>
        <label for="q3-1"><i class="icon" role="radio"></i><input id="q3-1" name="q3" type="radio" value="I Do Not Agree" required> I Do Not Agree</label>
      </fieldset>
      <fieldset class="jv-input-group">
        <legend>Do you have a preferred shift?</legend>
        <label for="q4-0"><i class="icon" role="radio"></i><input id="q4-0" name="q4" type="radio" value="Day"> Day</label>
        <label for="q4-1"><i class="icon" role="radio"></i><input id="q4-1" name="q4" type="radio" value="Night"> Night</label>
      </fieldset>
      <button type="button" aria-label="Next">Next →</button>
    </form>
  </div>
  <form class="newsletter"><label for="news">Email*</label><input id="news" type="email" required></form>`;

/** 样式把原生单选藏起来了：看得见的是外面那个标签。 */
const jobviteVisible = (element: Element): boolean => !(element instanceof HTMLInputElement && element.type === 'radio');

function mount(html: string, rootSelector = 'div.jv-apply-form', exclude: readonly string[] = ['footer']) {
  document.body.innerHTML = html;
  const container = document.querySelector(rootSelector)!;
  return createScanRoot(container, exclude);
}

/** 这一次扫描认出的那几栏（只要元素；别的字段不参与这里的判断）。 */
const planned = (...ids: string[]): ApplyFieldDescriptor[] => ids.map((id) => ({
  kind: 'text', element: document.getElementById(id)!, key: null, label: id, required: true, confidence: 1, signature: {} as never,
}) as unknown as ApplyFieldDescriptor);

describe('页面上还空着、浮层没认出的必填', () => {
  it('Jobvite：四道题里三道必填的是非题与必填的简历按钮都列出来，题目是网站上的原文；认出的那几栏与选填的不算', () => {
    const root = mount(JOBVITE);
    const gaps = readPageGaps({ form: { root, fields: planned('first', 'ref') }, isVisible: jobviteVisible });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual([
      'Add Resume',
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for an immigration-related employment benefit?',
      'Acknowledgement',
    ]);
    // 「去这一栏」滚到的是看得见的那一项：一组单选指向第一个选项。
    expect(gaps.unplanned[1]!.element).toBe(document.getElementById('q1-0'));
    expect(gaps.invalid).toBe(0);
    expect(gaps.alerts).toBe(0);
  });

  it('答过的题不算：组里有一项选中了', () => {
    const root = mount(JOBVITE);
    (document.getElementById('q2-1') as HTMLInputElement).checked = true;
    const gaps = readPageGaps({ form: { root, fields: planned('first', 'ref') }, isVisible: jobviteVisible });
    expect(gaps.unplanned.map((gap) => gap.label)).not.toContain(
      'Will you now or in the future require sponsorship for an immigration-related employment benefit?');
    expect(gaps.unplanned).toHaveLength(3);
  });

  it('简历按钮旁边已经列着一个文件名：当作附上了', () => {
    const root = mount(JOBVITE.replace('<ul class="jv-file-list"></ul>', '<ul class="jv-file-list"><li>Taylor-Resume.pdf <button type="button">remove</button></li></ul>'));
    const gaps = readPageGaps({ form: { root, fields: planned('first', 'ref') }, isVisible: jobviteVisible });
    expect(gaps.unplanned.map((gap) => gap.label)).not.toContain('Add Resume');
  });

  it('扫描认出的那一栏即使空着也不算（它已经在浮层的单子里）；表外的必填（订阅表）不算', () => {
    const root = mount(JOBVITE);
    const gaps = readPageGaps({ form: { root, fields: planned('first', 'ref') }, isVisible: jobviteVisible });
    expect(gaps.unplanned.some((gap) => gap.element === document.getElementById('first'))).toBe(false);
    expect(gaps.unplanned.some((gap) => gap.element === document.getElementById('news'))).toBe(false);
  });

  it('认出的是那一组里的选项：整组都算认出来了', () => {
    const root = mount(JOBVITE);
    const gaps = readPageGaps({ form: { root, fields: planned('first', 'ref', 'q1-0') }, isVisible: jobviteVisible });
    expect(gaps.unplanned.map((gap) => gap.label)).not.toContain('Are you legally authorized to work in the United States?');
  });

  it('看不见的（样式藏起来、标签也看不见）、markup 藏起来的、排除区里的、停用的都不算', () => {
    const root = mount(`
      <div class="form">
        <label for="a">Hidden field*</label><input id="a" required>
        <div hidden><label for="b">Hidden by markup*</label><input id="b" required></div>
        <footer><label for="c">Footer email*</label><input id="c" required></footer>
        <label for="d">Disabled*</label><input id="d" required disabled>
        <label for="e">Shown*</label><input id="e" required>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: (element) => element.id !== 'a' });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual(['Shown']);
  });

  it('网站只用星号标必填（控件上没有 required）也认；写了 (optional) 的不认；读不出题目的照样列（题目是空串）', () => {
    const root = mount(`
      <div class="form">
        <label for="a">Preferred First &amp; Last Name *</label><input id="a">
        <label for="b">Portfolio (optional)</label><input id="b">
        <input id="c" required>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual(['Preferred First & Last Name', '']);
    expect(gaps.unplanned[1]!.element).toBe(document.getElementById('c'));
  });

  /**
   * 2026-10-04 测试台（ats.rippling.com/opendoor）：自定义题的下拉是 `div[role=combobox][aria-label=Select][aria-required=true]`，
   * 题干在 aria 关系够不着的地方（规则的 questionScopes 才找得到）。扫描没认出它；清点读不出题目，照样列（空串）。
   */
  it('Rippling 自定义题的「Select」下拉：必填、空着、读不出题目 → 照样列', () => {
    const root = mount(`
      <div class="form"><div class="marginY--36"><div class="paddingX--16"><div class="marginBottom--4"><p>Are you open to working on-site?</p></div></div>
        <div data-testid="field"><div><div data-testid="customQuestions.a.b"><div><div data-testid="select-controller"><div>
          <div id="field-67" role="combobox" aria-haspopup="listbox" aria-label="Select" aria-required="true" tabindex="0">Select</div>
        </div></div></div></div></div></div>
      </div></div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => [gap.element.id, gap.label])).toEqual([['field-67', '']]);
  });

  it('Rippling 自定义题的「Select」下拉：规则声明了题干（questionScopes）就用它当题目', () => {
    const root = mount(`
      <div class="form"><div class="marginY--36"><div class="paddingX--16"><div class="marginBottom--4"><p>Are you open to working on-site?</p></div></div>
        <div data-testid="field"><div><div data-testid="customQuestions.a.b"><div><div data-testid="select-controller"><div>
          <div id="field-67" role="combobox" aria-haspopup="listbox" aria-label="Select" aria-required="true" tabindex="0">Select</div>
        </div></div></div></div></div></div>
      </div></div>`, 'div.form');
    // 规则编译出来的那一份（packages/apply-rules/rules/rippling.json 的 questionScopes），绑上这张表的根。
    const questionText = (element: Element): string => ripplingAdapter.questionTextFor?.(root, element) ?? '';
    const gaps = readPageGaps({ form: { root, fields: [], questionText }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => [gap.element.id, gap.label])).toEqual([['field-67', 'Are you open to working on-site?']]);
  });

  it('下拉停在占位上算空；选了一项不算；第一项本身就是答案的不算', () => {
    const root = mount(`
      <div class="form">
        <label for="a">State*</label><select id="a" required><option value="">Select an option...</option><option value="CA">California</option></select>
        <label for="b">Country*</label><select id="b" required><option value="">Select</option><option value="US" selected>United States</option></select>
        <label for="c">Shift*</label><select id="c" required><option value="day">Day</option><option value="night">Night</option></select>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual(['State']);
  });

  it('按钮样子的下拉（Rippling 的「Select」）：题目在旁边，按钮上还写着占位就是空的；选过了就不算', () => {
    const root = mount(`
      <div class="form">
        <div class="field"><label>Are you willing to relocate?*</label>
          <button type="button" aria-haspopup="listbox">Select</button></div>
        <div class="field"><label>Pronouns *</label>
          <button type="button" aria-haspopup="listbox">She/her</button></div>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual(['Are you willing to relocate?']);
  });

  it('自定义下拉的输入框空着、旁边显示着选中的字：算选过了', () => {
    const root = mount(`
      <div class="form">
        <div class="field"><label for="a">How did you hear about us?*</label>
          <div><input id="a" role="combobox" aria-required="true"><span class="pill">LinkedIn</span></div></div>
        <div class="field"><label for="b">Location*</label>
          <div><input id="b" role="combobox" aria-required="true"></div></div>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => gap.label)).toEqual(['Location']);
  });

  it('网站标着「不对」的栏与表里显示着的报错提示，分别计数（看不见的、空的提示不算）', () => {
    const root = mount(`
      <div class="form">
        <label for="a">Phone*</label><input id="a" value="x" aria-invalid="true" required>
        <label for="b">Email*</label><input id="b" value="y" aria-invalid="false" required>
        <div role="alert">Please provide this information.</div>
        <div role="alert"></div>
        <div role="alert" hidden>Old error</div>
      </div>`, 'div.form');
    const gaps = readPageGaps({ form: { root, fields: planned('a', 'b') }, isVisible: () => true });
    expect(gaps.unplanned).toEqual([]);
    expect(gaps.invalid).toBe(1);
    expect(gaps.alerts).toBe(1);
  });

  it('读页面时出错：什么都没读到（调用方不多说一句）', () => {
    const root = mount(JOBVITE);
    const gaps = readPageGaps({ form: { root, fields: [] }, isVisible: () => { throw new Error('boom'); } });
    expect(gaps.invalid).toBe(0);
    expect(gaps.alerts).toBe(0);
  });
});

describe('同一道题、不同的元素：不重复列', () => {
  /**
   * 2026-10-04 测试台（adobe.wd5 第 2 页）：Degree 是按钮式下拉加一个 0×0 的镜像输入框，扫描认的是镜像（单子里已经有一行
   * 「Degree · 你的资料里还没有这一项」），清点看见的是那颗写着「Select One」的按钮——从前同一道题列了两遍。
   */
  it('Workday 的 Degree：扫描认的是镜像输入框，看得见的是按钮（规则声明的同一个部件）→ 算认出来了', () => {
    const root = mount(`
      <div class="form"><div data-fkit-id="education-1--null">
        <div data-automation-id="formField-degree">
          <label for="education-1--degree"><span>Degree<abbr aria-hidden="true">*</abbr></span></label>
          <div><div><div><button type="button" class="extra" aria-label="clear"></button><button type="button" class="extra2" aria-label="help"></button>
            <button id="education-1--degree" name="degree" type="button" aria-haspopup="listbox" aria-required="true">Select One</button><input type="text" id="mirror"><span></span>
          </div></div><div></div></div>
        </div>
      </div></div>`, 'div.form');
    const mirror = document.getElementById('mirror')!;
    // 与 workday.json 的 listboxComboboxes 同形：触发器是镜像，值容器是 formField 包裹，激活控件是按钮。
    const listbox = { triggerSelector: 'button[aria-haspopup="listbox"] + input[type="text"]', valueContainerSelector: '[data-automation-id^="formField-"]', activationSelector: 'button[aria-haspopup="listbox"]' };
    const fields = [{ kind: 'combobox', element: mirror, key: 'education.degree', label: 'Degree', required: true, confidence: 1, signature: {}, listbox } as unknown as ApplyFieldDescriptor];
    const gaps = readPageGaps({ form: { root, fields }, isVisible: () => true });
    expect(gaps.unplanned).toEqual([]);
  });

  it('题目一样、却是另一个部件（第二段教育没认出来；Greenhouse 重复的那一道题）→ 照列', () => {
    const block = (n: number, extra: string) => `
      <div data-fkit-id="education-${n}--null"><div data-automation-id="formField-degree">
        <label for="d${n}"><span>Degree*</span></label>
        <div><div><div><button id="d${n}" type="button" aria-haspopup="listbox" aria-required="true">Select One</button>${extra}</div></div></div>
      </div></div>`;
    const root = mount(`<div class="form"><section>${block(1, '<input type="text" id="m1">')}</section><section>${block(2, '')}</section></div>`, 'div.form');
    const fields = [{ kind: 'combobox', element: document.getElementById('m1')!, key: 'education.degree', label: 'Degree', required: true, confidence: 1, signature: {} } as unknown as ApplyFieldDescriptor];
    const gaps = readPageGaps({ form: { root, fields }, isVisible: () => true });
    expect(gaps.unplanned.map((gap) => gap.element.id)).toEqual(['d2']);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { findWizardNextControl, scannedStepGone, type FindWizardNextInput } from '../src/wizardAdvance';

/**
 * 浮层里的「继续到下一页」替用户按宿主的哪一颗按钮（wizardAdvance.ts）。
 *
 * 放行面只有一种形状：名字整句是「下一步」、结构上提交不了表单、看得见、全页唯一。
 * 拒绝面是这份文件的重点——每一条都是一颗真实存在、长得像「下一步」、按下去却会
 * 提交 / 登录 / 同意 / 离开这一页的按钮。
 */

afterEach(() => { document.body.innerHTML = ''; });

const visible = () => true;

/** 在 body 里摆一段 HTML，再找一次；formElements 默认取页面上所有文本框。 */
function find(html: string, overrides: Partial<FindWizardNextInput> = {}) {
  document.body.innerHTML = html;
  return findWizardNextControl({
    document,
    formElements: Array.from(document.querySelectorAll('input[type="text"], select, textarea')),
    isVisible: visible,
    ...overrides,
  });
}

const field = '<label for="first">First Name</label><input id="first" type="text" />';

/**
 * 2026-09-22 nvidia.wd5 申请页的结构骨架：底栏的两颗按钮都**没有 type**，页面上**没有
 * `<form>`**；顶上另有一颗 `type=button role=link` 的「Back to Job Posting」。
 */
const workdayStep = (next: string) => `
  <button type="button" role="link" data-automation-id="backToJobPosting">Back to Job Posting</button>
  <div data-automation-id="applyFlowPage">
    <div data-automation-id="applyFlowMyInfoPage">${field}</div>
    <div data-automation-id="pageFooter">
      <button data-automation-id="pageFooterBackButton">Back</button>
      <button data-automation-id="pageFooterNextButton">${next}</button>
    </div>
  </div>`;

describe('放行：Workday 的底栏', () => {
  it('没写 type、也不属于任何表单的「Save and Continue」→ 就是它', () => {
    const result = find(workdayStep('Save and Continue'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe('Save and Continue');
    expect(result.value.element.getAttribute('data-automation-id')).toBe('pageFooterNextButton');
  });

  it('最后一步那颗变成 Submit → 没有可按的，交给用户自己点', () => {
    expect(find(workdayStep('Submit'))).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('「Back」「Back to Job Posting」都不是下一步', () => {
    expect(find(workdayStep('Review'))).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });
});

describe('放行：其余几种不会提交表单的按钮', () => {
  it.each([
    ['表单里的 type=button', `<form>${field}<button type="button">Next</button></form>`],
    ['role=button 的 div', `${field}<div role="button">Continue</div>`],
    ['input type=button', `${field}<input type="button" value="Next" />`],
    ['尾巴带箭头', `${field}<button type="button">Next ›</button>`],
    ['中文', `${field}<button type="button">下一步</button>`],
    ['aria-label 与字一致', `${field}<button type="button" aria-label="Next">Next</button>`],
  ])('%s', (_name, html) => {
    const result = find(html);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('给用户看的是宿主自己的写法，去掉尾部箭头', () => {
    const result = find(`${field}<button type="button">  Save   and Continue  → </button>`);
    expect(result.ok && result.value.label).toBe('Save and Continue');
  });
});

describe('拒绝：按下去会提交表单或离开这一页', () => {
  it.each([
    ['表单里没写 type（隐式提交）', `<form>${field}<button>Next</button></form>`],
    ['表单里 type=submit', `<form>${field}<button type="submit">Next</button></form>`],
    ['表单外但 type=submit', `${field}<button type="submit">Next</button>`],
    ['用 form 属性挂到一张表上', `<form id="f">${field}</form><button form="f">Next</button>`],
    ['input type=submit', `<form>${field}<input type="submit" value="Next" /></form>`],
    ['链接', `${field}<a href="/apply/step-2">Next</a>`],
    ['伪装成按钮的链接', `${field}<a role="button" href="javascript:void(0)">Next</a>`],
    ['role=link', `${field}<button type="button" role="link">Next</button>`],
    ['label 会把点击转给它的控件', `${field}<label role="button" for="first">Next</label>`],
    ['role=button 里包着一颗提交按钮', `<form>${field}<div role="button">Next<button type="submit"></button></div></form>`],
  ])('%s', (_name, html) => {
    expect(find(html)).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });
});

describe('拒绝：名字不是「下一步」', () => {
  it.each([
    'Submit', 'Submit Application', 'Apply', 'Apply Now', 'Finish', 'Send application',
    // 这三个都以 continue 开头——「以 next/continue 开头」那种判法会把它们放进来。
    'Continue with LinkedIn', 'Continue to Submit', 'Continue as Guest',
    'Accept and Continue', 'I agree', 'Review', 'Continue to review', 'Save', 'Save draft',
    'Next arrow_forward',
  ])('%s', (name) => {
    expect(find(`${field}<button type="button">${name}</button>`)).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('字说 Next、aria-label 说 Submit application → 不按', () => {
    expect(find(`${field}<button type="button" aria-label="Submit application">Next</button>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('按钮里藏着别的字（例如一段隐藏的 Submit）→ 整句对不上，不按', () => {
    expect(find(`${field}<button type="button">Next<span hidden>Submit</span></button>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('aria-labelledby 指向的字才是它的名字', () => {
    expect(find(`${field}<span id="n">Submit application</span><button type="button" aria-labelledby="n">Next</button>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
    expect(find(`${field}<button type="button" aria-labelledby="missing">Next</button>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });
});

describe('拒绝：看不见、按不动', () => {
  it.each([
    ['disabled', `${field}<button type="button" disabled>Next</button>`],
    ['aria-disabled', `${field}<button type="button" aria-disabled="true">Next</button>`],
    ['禁用的 fieldset 里', `${field}<fieldset disabled><button type="button">Next</button></fieldset>`],
    ['hidden 祖先', `${field}<div hidden><button type="button">Next</button></div>`],
    ['inert 祖先', `${field}<div inert><button type="button">Next</button></div>`],
    ['aria-hidden 祖先', `${field}<div aria-hidden="true"><button type="button">Next</button></div>`],
  ])('%s', (_name, html) => {
    expect(find(html)).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('调用方量出来看不见 → 不按', () => {
    expect(find(`${field}<button type="button">Next</button>`, { isVisible: () => false }))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });
});

describe('全页恰好一颗', () => {
  it('两颗都看得见 → 不知道按哪颗，一颗都不按', () => {
    expect(find(`${field}<button type="button">Next</button><button type="button">Continue</button>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_AMBIGUOUS' });
  });

  it('响应式布局里藏着的那一颗不算', () => {
    document.body.innerHTML = `${field}<button type="button" id="mobile">Next</button><button type="button" id="desktop">Next</button>`;
    const result = findWizardNextControl({
      document,
      formElements: [document.getElementById('first')!],
      isVisible: (element) => element.id !== 'mobile',
    });
    expect(result.ok && result.value.element.id).toBe('desktop');
  });
});

describe('对话框：只认装着这张表的那一个', () => {
  it('cookie 横幅里的 Continue 与申请表无关 → 不按', () => {
    expect(find(`${field}<div role="dialog" aria-label="Cookies"><button type="button">Continue</button></div>`))
      .toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });

  it('申请表本身开在对话框里 → 同一个对话框里的 Next 可以按', () => {
    const result = find(`<div role="dialog" aria-modal="true">${field}<button type="button">Next</button></div>`);
    expect(result.ok).toBe(true);
  });
});

describe('规则声明的最终提交控件永远不是候选', () => {
  it('哪怕它此刻写着 Continue', () => {
    document.body.innerHTML = `${field}<button type="button" id="final">Continue</button>`;
    const result = findWizardNextControl({
      document,
      formElements: [document.getElementById('first')!],
      isVisible: visible,
      refuse: [document.getElementById('final')!],
    });
    expect(result).toEqual({ ok: false, code: 'NEXT_STEP_NONE' });
  });
});

describe('不读用户填的值', () => {
  it('文本框的 value 是用户资料：找按钮时连读都不读', () => {
    document.body.innerHTML = `${field}<button type="button">Next</button>`;
    const input = document.getElementById('first')!;
    Object.defineProperty(input, 'value', { get() { throw new Error('读了用户的值'); } });
    const result = findWizardNextControl({ document, formElements: [input], isVisible: visible });
    expect(result.ok).toBe(true);
  });
});

/** Workday My Information 与 My Experience 的骨架：用真规则解出 ScanRoot 与字段。 */
const myInfo = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-legalName--firstName"><label for="fn">First Name*</label><input id="fn" type="text" /></div>
    <div data-automation-id="formField-legalName--lastName"><label for="ln">Last Name*</label><input id="ln" type="text" /></div>
    <div data-automation-id="formField-city"><label for="city">City</label><input id="city" type="text" /></div>
  </div>`;
const myExperience = `
  <div data-automation-id="applyFlowMyExpPage">
    <div data-automation-id="formField-jobTitle"><label for="jt">Job Title*</label><input id="jt" type="text" /></div>
    <div data-automation-id="formField-companyName"><label for="co">Company*</label><input id="co" type="text" /></div>
  </div>`;

function scanMyInfo() {
  document.body.innerHTML = `<div id="app">${myInfo}</div>`;
  const adapter = compileBundledAdapter(workday as never);
  const root = adapter.resolveRoot(document);
  expect(root, '夹具上找不到 My Information 的锚点').not.toBeNull();
  const fields = adapter.scan(root!).map((item) => ({ element: item.element, label: item.label }));
  expect(fields.length).toBeGreaterThan(0);
  return { root: root!, fields };
}

describe('scannedStepGone：这一步还在不在', () => {
  it('什么都没变 → 还在', () => {
    expect(scannedStepGone(scanMyInfo())).toBe(false);
  });

  it('宿主把每个文本框都重挂载了一遍（Workday 失焦重挂载）→ 同名标签还在，不算换页', () => {
    const step = scanMyInfo();
    for (const input of Array.from(document.querySelectorAll('input'))) input.replaceWith(input.cloneNode(true));
    expect(step.fields.every((item) => !item.element.isConnected), '原元素确实全断开了').toBe(true);
    expect(scannedStepGone(step)).toBe(false);
  });

  it('宿主校验没过、把报错塞进了标签里 → 元素都还连着，不算换页', () => {
    // 「翻页没成功」最常见的样子：按了下一步，宿主不翻，在每个必填栏的标签后面加一句 Error。
    // 这时标签全变了，只看标签会误判成换页、把审计面板收掉——而用户正需要它。
    const step = scanMyInfo();
    for (const label of Array.from(document.querySelectorAll('label'))) label.append(' Error: This field is required');
    expect(scannedStepGone(step)).toBe(false);
  });

  it('还剩一个原字段连着 → 还在', () => {
    const step = scanMyInfo();
    document.getElementById('fn')!.remove();
    document.getElementById('ln')!.remove();
    expect(scannedStepGone(step)).toBe(false);
  });

  it('整步换成 My Experience → 换页了', () => {
    const step = scanMyInfo();
    document.getElementById('app')!.innerHTML = myExperience;
    expect(scannedStepGone(step)).toBe(true);
  });

  it('根还在、里面的控件整批换成别的题 → 换页了', () => {
    const step = scanMyInfo();
    const container = document.querySelector('[data-automation-id="applyFlowMyInfoPage"]')!;
    container.innerHTML = '<label for="q">Are you legally authorized to work?</label><input id="q" type="text" />';
    expect(scannedStepGone(step)).toBe(true);
  });

  it('没有字段就没有依据，永远不说换页', () => {
    const step = scanMyInfo();
    document.body.innerHTML = '';
    expect(scannedStepGone({ root: step.root, fields: [] })).toBe(false);
  });
});

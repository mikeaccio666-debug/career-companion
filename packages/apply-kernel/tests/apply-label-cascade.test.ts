import { afterEach, describe, expect, it } from 'vitest';

import { createScanRoot } from '../src/scanRoot';

/**
 * 标签推断级联（CAP-AF-046）。
 *
 * 设计原话：`label[for]` **一项只覆盖约一半的真实 ATS 字段**，「填充率就是从这条
 * 级联来的」。今天只走到 placeholder 为止（label[for] → element.labels →
 * closest('label') → aria-label → placeholder），后面六步全缺。
 *
 * 缺的代价在 Ashby 这种站点上最直接：除三个 systemfield 外全是每公司随机 UUID，
 * **只有 label 接线是干净的**——级联少一步，本该吃下的字段就掉到手填。
 * 2026-08-21 的填充率基线量到 lever 4 个、workable 5 个 LOW_CONFIDENCE，
 * 就是这条缺口的实测值。
 *
 * ## 本次实现前六步，不做 name/id 分词
 *
 * 这六步都是**人写给人看的标签**（aria-labelledby / title / fieldset>legend /
 * 表格几何 / 前兄弟与上方文本 / 字段作用域），与 label、aria-label 同一信任级别。
 *
 * `name`/`id` 分词**刻意不做**：它不是标签，是机器标识符。把它喂进 0.75 置信度
 * 的 labelPatterns，等于让"从变量名猜出来的词"拿到和"人写的标签"一样的置信度，
 * 而这条链的失败形态是**把值写进错误字段**（推荐人正则命中本人字段那一类）。
 * 它需要独立的低置信通道，属另一刀。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function labelFor(html: string, selector = '#target'): string {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const container = document.querySelector('#application-form')!;
  const root = createScanRoot(container, []);
  return root.labelTextFor(document.querySelector(selector)!);
}

describe('标签推断级联', () => {
  it('既有五步不受影响（回归基线）', () => {
    expect(labelFor('<label for="target">Email</label><input id="target" />')).toBe('Email');
    expect(labelFor('<label>Phone<input id="target" /></label>')).toBe('Phone');
    expect(labelFor('<input id="target" aria-label="LinkedIn URL" />')).toBe('LinkedIn URL');
    expect(labelFor('<input id="target" placeholder="City" />')).toBe('City');
  });

  it('步骤 6：aria-labelledby 解析 id 列表并按序拼接', () => {
    expect(
      labelFor(
        '<span id="l1">Current</span><span id="l2">location</span>' +
          '<input id="target" aria-labelledby="l1 l2" />',
      ),
      'aria-labelledby 没解析——这是 ARIA 里最常见的标签接法之一',
    ).toBe('Current location');
  });

  it('步骤 6：aria-labelledby 优先于 aria-label（更具体的接线赢）', () => {
    expect(
      labelFor('<span id="l1">Preferred name</span><input id="target" aria-labelledby="l1" aria-label="Name" />'),
    ).toBe('Preferred name');
  });

  it('步骤 7：title 兜底', () => {
    expect(labelFor('<input id="target" title="GitHub profile" />')).toBe('GitHub profile');
  });

  it('步骤 8：表格几何——左侧单元格', () => {
    expect(
      labelFor(
        '<table><tr><td>Phone number</td><td><input id="target" /></td></tr></table>',
      ),
      '表格布局的申请表读不出标签——老一代 ATS 大量用表格排版',
    ).toBe('Phone number');
  });

  it('步骤 8：表格几何——上方表头', () => {
    expect(
      labelFor(
        '<table><tr><th>Portfolio</th></tr><tr><td><input id="target" /></td></tr></table>',
      ),
    ).toBe('Portfolio');
  });

  it('步骤 9：前兄弟文本节点', () => {
    expect(labelFor('<div>Full name<input id="target" /></div>')).toBe('Full name');
  });

  it('步骤 9：上方元素的文本', () => {
    expect(labelFor('<div><div>Email address</div><input id="target" /></div>')).toBe(
      'Email address',
    );
  });

  it('步骤 10：字段作用域——子树里恰好一个控件的最近祖先', () => {
    expect(
      labelFor(
        '<div class="field"><span class="hint">Where do you live?</span>' +
          '<div class="wrap"><input id="target" /></div></div>',
      ),
    ).toBe('Where do you live?');
  });

  it('步骤 11：fieldset>legend', () => {
    expect(
      labelFor('<fieldset><legend>Work authorization</legend><input id="target" /></fieldset>'),
    ).toBe('Work authorization');
  });

  /**
   * 作用域必须是"**恰好一个**控件"的最近祖先。祖先里有两个控件时，那段文字
   * 是哪个字段的标签就说不清了——猜错的代价是把值写进另一栏。
   */
  it('反向探针：祖先里不止一个控件时，不拿它的文字当标签', () => {
    expect(
      labelFor(
        '<div class="field"><span>Name</span><input id="target" /><input id="other" /></div>',
        '#target',
      ),
      '两个控件共用一段文字，却当成了其中一个的标签——这正是写错字段的路径',
    ).toBe('');
  });

  it('反向探针：级联绝不逃出受验证容器', () => {
    document.body.innerHTML =
      '<div>Global decoy</div><form id="application-form"><input id="target" /></form>';
    const container = document.querySelector('#application-form')!;
    const root = createScanRoot(container, []);
    expect(
      root.labelTextFor(document.querySelector('#target')!),
      '级联跑到容器外面读到了页面上的其他文字',
    ).toBe('');
  });

  /**
   * 归一化：显示用的标签要干净（去掉必填星号、(required)/(optional)、尾冒号），
   * 但**不小写化**——面板要把它原样显示给用户看。
   */
  it('归一化：去掉必填标记与尾冒号，保留原始大小写', () => {
    expect(labelFor('<label for="target">Email *</label><input id="target" />')).toBe('Email');
    expect(labelFor('<label for="target">Email✱</label><input id="target" />')).toBe('Email');
    expect(labelFor('<label for="target">Phone (required)</label><input id="target" />')).toBe('Phone');
    expect(labelFor('<label for="target">Website (optional)</label><input id="target" />')).toBe('Website');
    expect(labelFor('<label for="target">First Name:</label><input id="target" />')).toBe('First Name');
  });

  /**
   * 零宽字符不是文字。2026-09-15 对 app.dover.com 真实 posting 实测：MUI notched-outline
   * 的 `fieldset > legend > span` 只放一个 U+200B 撑位，它落在"恰好一个控件的最近祖先"
   * 那一步里被读成标签——非空、用户看不见，还挡住了再往上一层真正的题干。
   */
  it('零宽字符当作空：MUI 撑位 legend 不算标签，级联继续向上读到真正的题干', () => {
    const ZWSP = '\u200B';
    expect(labelFor(`<label for="target">${ZWSP}</label><input id="target" />`)).toBe('');
    expect(
      labelFor(
        `<div class="MuiBox-root"><div class="styles__FormLabel-x">First Name *</div>` +
          `<div class="MuiFormControl-root"><div class="MuiInputBase-root"><input id="target" />` +
          `<fieldset aria-hidden="true"><legend><span>${ZWSP}</span></legend></fieldset></div></div></div>`,
      ),
    ).toBe('First Name');
  });

  /**
   * `declaredOnly`：只认宿主声明给控件的名字（显式/包裹 label、aria-*），推断步骤
   * （placeholder、title、附近文字）一律返回空。规则解释器靠这条界线决定厂商声明的
   * question scope 何时可以发言。
   */
  it('declaredOnly：声明的名字照常返回，推断出来的名字一律为空', () => {
    document.body.innerHTML = `<form id="application-form">
      <label for="a">Declared</label><input id="a" placeholder="Type your response" />
      <input id="b" placeholder="Type your response" />
      <input id="c" aria-label="Search" placeholder="Search" />
      <div><span>Nearby prose</span><input id="d" /></div>
    </form>`;
    const root = createScanRoot(document.querySelector('#application-form')!, []);
    const declared = (id: string) => root.labelTextFor(document.getElementById(id)!, { declaredOnly: true });
    expect(declared('a')).toBe('Declared');
    expect(declared('b')).toBe('');
    expect(declared('c')).toBe('Search');
    expect(declared('d')).toBe('');
    // 不带选项时与从前逐字相同。
    expect(root.labelTextFor(document.getElementById('b')!)).toBe('Type your response');
    expect(root.labelTextFor(document.getElementById('d')!)).toBe('Nearby prose');
  });
});

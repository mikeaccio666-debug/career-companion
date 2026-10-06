import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createScanRoot, labelTextOf } from '../src/scanRoot';
import type { HostVisibilityStyle } from '../src/contracts';

/**
 * 标签文本只能是**用户读得到的那一段**。
 *
 * 缺陷形态（2026-09-15，352 个真实申请页的批量跑排出来的第一大原因，456 条）：
 * `textOf` 拿 `element.textContent` 当标签，而 textContent 收的是所有文本节点
 * ——包括页面上根本不渲染的那些。三种线上形状，各自在本文件有一对红/绿：
 *
 * | 形状 | 线上读成 | 靠什么剔掉 |
 * |---|---|---|
 * | Workable 图标的 `<svg><desc>` | `Address SVGs not supported by this browser.` | 元素名（svg 子树不上屏） |
 * | Workable 电话里的国家区号表 | `Phone +1United States+1United Kingdom+44…` | **注入的计算可见性**（类名 `.iti__hide`） |
 * | Lever typeahead 的状态文案 | `Current location No location found. Try entering a different locationLoading` | **注入的计算可见性**（类名 `.dropdown-no-results`） |
 * | `<label>` 里的 `<select>` 选项 | `Years of experience3` | 元素名（option/optgroup 是选项不是题干） |
 *
 * 每组的**红**是"夹具里确实有这段读不到的文字"（断言 textContent 仍含噪声）：
 * 有它，把夹具洗干净来糊弄断言这条路就走不通——那样红会直接变红。
 * **绿**是"我们产出的标签里没有它"。
 *
 * 另一半同样重要：`describe('刻意不剔的')` 锁住**没有**被剔掉的东西。
 * 剔多了丢真标签，而好几家厂商靠附近文字推断题干；两边的代价都要有测试压着。
 */

const FIXTURES = resolve(process.cwd(), 'tests/fixtures');

/** 生产里由 extension 注入的那一个（kernelScanner.ts / lab.content.ts 同形）。 */
const readVisibility = (element: Element): HostVisibilityStyle => {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style ? { display: style.display, visibility: style.visibility } : {};
};

function mount(file: string): void {
  document.documentElement.innerHTML = readFileSync(resolve(FIXTURES, file), 'utf8');
}

function rootFor(anchor: string, injected = true) {
  return createScanRoot(
    document.querySelector(anchor)!,
    [],
    [],
    injected ? { readVisibility } : {},
  );
}

const control = (selector: string): Element => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`夹具里没有 ${selector}——夹具被改坏了`);
  return element;
};

afterEach(() => {
  document.documentElement.innerHTML = '';
});

describe('Workable：图标的 <svg><desc> 不是标签文字', () => {
  const WORKABLE = 'form[data-ui="application-form"]';

  it('红：夹具的 Address 标签里确实躺着那句 SVG 兜底文案', () => {
    mount('workable/application-form.html');
    const label = control('#address').closest('label')!;
    expect(label.textContent).toContain('SVGs not supported by this browser.');
  });

  it('绿：标签读成 Address，不带那句兜底文案', () => {
    mount('workable/application-form.html');
    expect(rootFor(WORKABLE).labelTextFor(control('#address'))).toBe('Address');
  });

  it('绿：svg 判据不依赖注入——属性层与元素名就够了', () => {
    mount('workable/application-form.html');
    expect(rootFor(WORKABLE, false).labelTextFor(control('#address'))).toBe('Address');
  });

  it('绿：只有一个图标的简历 <label> 读成空，而不是一句英文兜底文案', () => {
    mount('workable/application-form.html');
    // 线上这一栏此前显示的是「SVGs not supported by this browser.」——一句凭空
    // 出现在审阅面板上的话。空标签让级联继续往下走，是诚实的答案。
    expect(rootFor(WORKABLE).labelTextFor(control('#input_files_resume'))).toBe('');
  });
});

describe('Workable：电话标签里的国家区号表不是标签文字', () => {
  const WORKABLE = 'form[data-ui="application-form"]';
  const phone = () => control('input[name="phone"]');

  it('红：夹具的 Phone 标签里确实躺着整张国家表', () => {
    mount('workable/application-form.html');
    const label = phone().closest('label')!;
    expect(label.textContent).toContain('United Kingdom');
    // 属性层一个都读不到：既没有 inline style，也没有 hidden / aria-hidden。
    const dropdown = control('.iti__dropdown-content');
    expect(dropdown.getAttribute('style')).toBeNull();
    expect(dropdown.hasAttribute('hidden')).toBe(false);
    expect(dropdown.getAttribute('aria-hidden')).toBeNull();
  });

  it('红：没有注入计算可见性时，类名藏起来的国家表仍然漏进标签', () => {
    mount('workable/application-form.html');
    // 这一条不是缺陷，是**注入是承重墙**的证据：属性层判据到此为止。
    expect(rootFor(WORKABLE, false).labelTextFor(phone())).toContain('United Kingdom');
  });

  it('绿：注入之后只剩用户读到的「Phone +1」', () => {
    mount('workable/application-form.html');
    expect(rootFor(WORKABLE).labelTextFor(phone())).toBe('Phone +1');
  });
});

describe('Lever：typeahead 与上传部件的状态文案不是标签文字', () => {
  const LEVER = '#application-form';

  it('红：夹具的地点标签里确实躺着 typeahead 的两段状态文案', () => {
    mount('lever/application-form.html');
    const label = control('#location-input').closest('label')!;
    expect(label.textContent).toContain('No location found. Try entering a different location');
    expect(label.textContent).toContain('Loading');
  });

  it('红：没有注入计算可见性时，状态文案仍然漏进标签', () => {
    mount('lever/application-form.html');
    expect(rootFor(LEVER, false).labelTextFor(control('#location-input')))
      .toContain('No location found');
  });

  it('绿：注入之后标签就是 Current location', () => {
    mount('lever/application-form.html');
    expect(rootFor(LEVER).labelTextFor(control('#location-input'))).toBe('Current location');
  });

  it('绿：简历栏只留用户读到的两段，三段状态文案全部剔掉', () => {
    mount('lever/application-form.html');
    const label = rootFor(LEVER).labelTextFor(control('#resume-upload-input'));
    expect(label).toBe('Resume/CV ATTACH RESUME/CV');
    expect(label).not.toContain('Analyzing resume');
    expect(label).not.toContain('Success!');
  });
});

describe('<option> / <optgroup> 是选项，不是题干', () => {
  it('红：夹具里那个 <select> 的选项文字确实在 label 的 textContent 里', () => {
    mount('lever/application-form.html');
    const label = control('select[name="cards[e27c9c9a][field0]"]').closest('label')!;
    expect(label.textContent).toContain('3');
  });

  it('绿：标签读成 Years of experience，不拖着选项', () => {
    mount('lever/application-form.html');
    expect(rootFor('#application-form').labelTextFor(control('select[name="cards[e27c9c9a][field0]"]')))
      .toBe('Years of experience');
  });

  it('绿：附近文字推断同样不吃选项——3302 项的下拉不会变成题干', () => {
    document.body.innerHTML = `
      <form id="f">
        <div id="row">How did you hear about us?
          <select name="source">
            <optgroup label="Job boards"><option value="a">America's Job Exchange</option></optgroup>
            <option value="b">Agency or Non-Palantir Recruiter</option>
          </select>
        </div>
      </form>`;
    expect(rootFor('#f').labelTextFor(control('select[name="source"]')))
      .toBe('How did you hear about us?');
  });

  it('绿：<datalist> 的建议项也不是标签', () => {
    document.body.innerHTML = `
      <form id="f">
        <label>City<input name="city" list="cities" />
          <datalist id="cities"><option value="Athens">Athens</option><option value="Berlin">Berlin</option></datalist>
        </label>
      </form>`;
    expect(rootFor('#f').labelTextFor(control('input[name="city"]'))).toBe('City');
  });
});

describe('属性层的三条判据（不需要 getComputedStyle）', () => {
  const mountOne = (inner: string) => {
    document.body.innerHTML = `<form id="f"><label>${inner}<input name="x" /></label></form>`;
  };

  it('inline style 的 display:none', () => {
    mountOne('Email<span style="display:none">internal-only</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('inline style 的 visibility:hidden，含 !important 与大小写', () => {
    mountOne('Email<span style="VISIBILITY : HIDDEN !important">internal-only</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('hidden 属性', () => {
    mountOne('Email<span hidden>internal-only</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('aria-hidden="true"', () => {
    mountOne('Email<span aria-hidden="true">internal-only</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('aria-hidden="false" 与不带该属性都算可见', () => {
    mountOne('Email<span aria-hidden="false"> address</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email address');
  });

  it('读不懂的 inline style 一律当成"没藏"', () => {
    mountOne('Email<span style="display">address</span>');
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Emailaddress');
  });
});

describe('嵌套控件的文字不是标签文字', () => {
  it('<textarea> 的 textContent 是它的默认值，不是题干', () => {
    document.body.innerHTML = `
      <form id="f"><div id="row">Cover letter<textarea name="cl">Dear hiring manager,</textarea></div></form>`;
    expect(rootFor('#f').labelTextFor(control('textarea[name="cl"]'))).toBe('Cover letter');
  });

  it('contenteditable 里已经敲进去的内容不是题干', () => {
    document.body.innerHTML = `
      <form id="f"><div id="row">Why us?<div contenteditable="true">Because I love it here</div></div></form>`;
    expect(rootFor('#f').labelTextFor(control('[contenteditable]'))).toBe('Why us?');
  });

  it('script / style 的源码不是文案', () => {
    document.body.innerHTML = `
      <form id="f"><label><style>.x{content:"boom"}</style>Email<script>var a=1;</script><input name="x" /></label></form>`;
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('Email');
  });
});

describe('刻意不剔的（剔多了丢真标签）', () => {
  it('<button> 与 <a> 的文字留着——好几家厂商的可见文案就在里面', () => {
    document.body.innerHTML = `
      <form id="f"><label>Resume
        <a href="#" class="btn">ATTACH RESUME/CV</a>
        <button type="button">Upload</button>
        <input type="file" name="r" /></label></form>`;
    expect(rootFor('#f').labelTextFor(control('input[name="r"]')))
      .toBe('Resume ATTACH RESUME/CV Upload');
  });

  it('被剔元素的可见兄弟一个字都不少', () => {
    // 拼接方式与 textContent 逐字相同（不插分隔符）：这条改动**只做减法**，
    // 剔掉一段藏起来的文字不会顺手改变两侧可见文字的粘法。
    document.body.innerHTML = `
      <form id="f"><label><span>Start</span><span hidden>GONE</span><span>End</span><input name="x" /></label></form>`;
    expect(rootFor('#f', false).labelTextFor(control('input[name="x"]'))).toBe('StartEnd');
  });

  it('传进来的元素本身不过滤：aria-hidden 的 label 仍然读得出题干', () => {
    // 调用方已经判定"这就是标签"。根节点也过滤的话，宿主给 label 加一个
    // 装饰性 aria-hidden 就能让整条题干消失——那是另一种静默失败。
    document.body.innerHTML = '<div id="q" aria-hidden="true">Preferred name</div>';
    expect(labelTextOf(control('#q'), readVisibility)).toBe('Preferred name');
  });

  it('附近文字推断照旧：长题干、styled div 这些形态不受影响', () => {
    document.body.innerHTML = `
      <form id="f"><div id="row"><div class="text">Are you legally authorized to work?</div>
        <input name="auth" /></div></form>`;
    expect(rootFor('#f').labelTextFor(control('input[name="auth"]')))
      .toBe('Are you legally authorized to work?');
  });

  it('零宽字符那条老判据还在（Dover 的 MUI legend）', () => {
    document.body.innerHTML = `
      <form id="f"><label><legend>​</legend>Preferred name<input name="x" /></label></form>`;
    expect(rootFor('#f').labelTextFor(control('input[name="x"]'))).toBe('Preferred name');
  });
});

describe('注入的读数是可选的、且不可信', () => {
  it('readVisibility 抛异常时按"可见"处理——异常不该让整个标签变空', () => {
    document.body.innerHTML = '<form id="f"><label>Email<input name="x" /></label></form>';
    const root = createScanRoot(document.querySelector('#f')!, [], [], {
      readVisibility: () => { throw new Error('host style read failed'); },
    });
    expect(root.labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('readVisibility 返回空对象时按"可见"处理', () => {
    document.body.innerHTML = '<form id="f"><label>Email<input name="x" /></label></form>';
    const root = createScanRoot(document.querySelector('#f')!, [], [], { readVisibility: () => ({}) });
    expect(root.labelTextFor(control('input[name="x"]'))).toBe('Email');
  });

  it('样式查询有预算：病态 DOM 不会把扫描问成卡顿', () => {
    const rows = Array.from({ length: 600 }, (_, index) => `<span>r${index}</span>`).join('');
    document.body.innerHTML = `<form id="f"><label>Email${rows}<input name="x" /></label></form>`;
    let probes = 0;
    const root = createScanRoot(document.querySelector('#f')!, [], [], {
      readVisibility: () => { probes += 1; return {}; },
    });
    root.labelTextFor(control('input[name="x"]'));
    // 预算 128；超了就退回属性层判据，而不是继续问下去。
    expect(probes).toBeLessThanOrEqual(128);
    expect(probes).toBeGreaterThan(0);
  });

  it('剪枝：藏起来的容器整棵跳过，不会逐个子节点去问样式', () => {
    const rows = Array.from({ length: 200 }, (_, index) => `<li>c${index}</li>`).join('');
    document.body.innerHTML =
      `<form id="f"><label>Phone<div class="hide"><ul>${rows}</ul></div><input name="x" /></label></form>` +
      '<style>.hide{display:none}</style>';
    let probes = 0;
    const root = createScanRoot(document.querySelector('#f')!, [], [], {
      readVisibility: (element) => {
        probes += 1;
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        return style ? { display: style.display, visibility: style.visibility } : {};
      },
    });
    expect(root.labelTextFor(control('input[name="x"]'))).toBe('Phone');
    // 一刀切在容器上：200 个 <li> 一次也没问过。
    expect(probes).toBeLessThan(10);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScanRoot } from '../../src/scanRoot';
import { isApprovedResumeFileTarget } from '../../src/write/setFile';
import { isHoneypot } from '../../src/dict/guards';

/**
 * S0 · 隐藏但真实的简历上传控件必须能填。
 *
 * ⚠️⚠️ **这个文件交接时是红的，这是故意的。** 它先于实现落地，正是本仓一贯的做法
 * （15 号裁决要求 "a red/green test change before code"）。接手人的任务是让它变绿，
 * **同时不让本文件里任何一条"仍须拒绝"的断言变松**。
 *
 * 为什么需要它：2026-08-03 在真实页面上量过，我们的守卫把两家 ATS 的简历控件全拒了，
 * 于是 A3 的链路虽然全通、真实站上一个文件也挂不上去。而当时 880 条单测全绿、
 * 四个构建全过、15 条 e2e 全绿——**没有任何一条现有测试碰得到这个形状**。
 *
 * 真实形状（逐字抄自实测，不要改这些数字）：
 *
 * | | 真实 DOM | 撞在哪 |
 * |---|---|---|
 * | Greenhouse | `input#resume.visually-hidden`，**1×1**，`tabIndex=0`，同容器有 300×42 可见的 `label[for=resume]`「Attach」 | `isHoneypotGeometry`：`width<=1` → 判成陷阱 |
 * | Lever | `input#resume-upload-input[name=resume]`，**230×40 但 `opacity:0`**，`position:absolute`，`tabIndex=-1` | `isVisiblyDenied`：`opacity==='0'` → 判成隐藏 |
 *
 * 两家是同一个模式：原生 file 控件无法做样式，所以全世界都把它藏起来、用自画的按钮
 * 当触发器。**"藏起来"是通用实现模式，不是陷阱信号。**
 *
 * 竞品对照（`/Users/acciokee/Documents/jobrightsimplify agent调研/` 对标报告）：
 * Jobright 用同样的 `File`/`DataTransfer` 写入（第 82 行），Simplify 走可选 `debugger`
 * 的 CDP 路径（第 141 行）——**两家都不对 file 控件做几何/可见性检查**，因为它们只在
 * 主机名白名单上运行。我们是全网注入 + DOM 指纹，所以不能照抄"没有守卫"，
 * 要的是一条**只对 file 控件成立的、更准的守卫**。
 *
 * 负责人批准的方向：对已经通过简历语义正向匹配、且通过身份类蜜罐词检查的
 * `input[type=file]`，不再套用几何与可见性判据，改为要求存在**可见的触发器**
 * （`label[for]`、祖先 `<label>`、或同容器内的可见按钮）。
 * **文本控件的蜜罐规则一个字都不要动**——本文件最后一组断言就是锁这个的。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface Box {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left?: number;
}

/**
 * happy-dom 没有布局引擎，对所有元素返回 0×0。要测"1×1 像素""屏幕外"这类几何判据，
 * 只能显式喂进去——这不是造假，是补上这个环境缺失的那一部分。
 */
function stubLayout(boxes: ReadonlyMap<Element, Box>, styles: ReadonlyMap<Element, Partial<CSSStyleDeclaration>>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { width: 0, height: 0, top: 0 };
    const left = box.left ?? 0;
    return {
      width: box.width, height: box.height, top: box.top, left,
      right: left + box.width, bottom: box.top + box.height, x: left, y: box.top,
      toJSON: () => ({}),
    } as DOMRect;
  });
  const realComputed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((element: Element) => {
    const base = realComputed(element as HTMLElement);
    const extra = styles.get(element);
    return extra ? ({ ...base, ...extra } as CSSStyleDeclaration) : base;
  }) as typeof window.getComputedStyle);
  Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
}

function rootOf(): ReturnType<typeof createScanRoot> {
  return createScanRoot(document.querySelector('form') as HTMLFormElement, []);
}

describe('S0 · 隐藏但真实的简历上传控件（真实页面形状）', () => {
  /** Greenhouse：1×1 视觉隐藏 + 一个 300×42 的可见「Attach」标签。 */
  it('Greenhouse 的 1×1 visually-hidden 控件可以填', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <label for="resume">Resume/CV</label>
          <label class="attach" for="resume">Attach</label>
          <input id="resume" class="visually-hidden" type="file"
                 accept=".pdf,.doc,.docx,.txt,.rtf" />
        </div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const attach = document.querySelector('label.attach') as HTMLElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [attach, { width: 300, height: 42, top: 300 }],
      ]),
      new Map(),
    );

    expect(
      isApprovedResumeFileTarget(input, rootOf()),
      '真实 Greenhouse 的简历控件被拒 —— A3 在这家上一个文件都挂不上去',
    ).toBe(true);
  });

  /** Lever：230×40 但 opacity:0，tabIndex=-1，靠一个可见按钮触发。 */
  it('Lever 的 opacity:0 控件可以填', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="application-field">
          <label for="resume-upload-input">Resume</label>
          <button type="button" class="upload">Attach resume</button>
          <input id="resume-upload-input" name="resume" type="file"
                 class="application-file-input invisible-resume-upload" tabindex="-1" />
        </div>
      </form>`;
    const input = document.getElementById('resume-upload-input') as HTMLInputElement;
    const button = document.querySelector('button.upload') as HTMLElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 230, height: 40, top: 400 }],
        [button, { width: 230, height: 40, top: 400 }],
      ]),
      new Map([[input, { opacity: '0', position: 'absolute' } as Partial<CSSStyleDeclaration>]]),
    );

    expect(
      isApprovedResumeFileTarget(input, rootOf()),
      '真实 Lever 的简历控件被拒 —— A3 在这家上一个文件都挂不上去',
    ).toBe(true);
  });

  /**
   * **滚动位置不得改变结论。** Greenhouse 实测 `top=9500`、视口 720；用户滚到简历
   * 那一栏时 `top` 变成两位数。旧判据在这两种情况下给出**相反**的答案——同一个页面
   * 两种结果，而用户根本不知道自己做了什么导致的。
   */
  it.each([
    ['尚未滚动到（top=9500）', 9500],
    ['已经滚动到（top=180）', 180],
  ])('%s 的结论必须一致', (_name, top) => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume/CV</label>
        <label class="attach" for="resume">Attach</label>
        <input id="resume" class="visually-hidden" type="file" accept=".pdf" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const attach = document.querySelector('label.attach') as HTMLElement;
    stubLayout(
      new Map([
        [input, { width: 1, height: 1, top }],
        [attach, { width: 300, height: 42, top }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(true);
  });

  it('普通文档流中尚未滚入视口的原生 file 自身仍可作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input name="resume" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(
      new Map([[input, { width: 230, height: 40, top: 9500 }]]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(true);
  });

  it('无损圆角裁剪的可见 label 仍可作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Attach resume</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map([[label, { clipPath: 'inset(0 round 12px)' } as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(true);
  });

  it('只有 aria-labelledby 名称的可见按钮仍可作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <span id="attach-name">Attach resume</span>
          <input name="resume" type="file" />
          <button type="button" aria-labelledby="attach-name"></button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 40, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(true);
  });

  /** Workable 2026-08-03 真实页：input.labels 有值，但 label.control 是 null。 */
  it('Workable 的 canonical input.labels 可以为隐藏控件作证', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <span id="resume-heading">Resume</span>
          <label role="button" for="input_files_input_random">Choose file</label>
          <input data-ui="resume" id="input_files_input_random" type="file"
                 aria-labelledby="resume-heading" />
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    // Chrome live-page evidence: the input owns the label, while reading the
    // reverse convenience property yields null. The target-side relation is
    // the one HTML exposes specifically for this input and therefore the one
    // the guard must consume.
    Object.defineProperty(input, 'labels', { value: [label], configurable: true });
    Object.defineProperty(label, 'control', { value: null, configurable: true });
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 120, height: 40, top: 300 }],
      ]),
      new Map([[input, { clip: 'rect(0px, 0px, 0px, 0px)', clipPath: 'inset(50%)' }]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(true);
  });

  /**
   * ⛔ 以下各条是这次放宽的**边界**。让它们变松，等于把防线拆了而不是修好。
   */

  it('⛔ 没有任何可见触发器的 1×1 file 控件仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const label = document.querySelector('label[for="resume"]') as HTMLElement;
    stubLayout(
      new Map([
        [input, { width: 1, height: 1, top: 300 }],
        // 标签自己也是不可见的 —— 整组控件人都看不见，没有任何可点的东西。
        [label, { width: 0, height: 0, top: 300 }],
      ]),
      new Map([[label, { display: 'none' } as Partial<CSSStyleDeclaration>]]),
    );

    expect(
      isApprovedResumeFileTarget(input, rootOf()),
      '一个人完全看不见、也没有任何触发器的 file 控件被放行了 —— 那正是陷阱的形状',
    ).toBe(false);
  });

  it('⛔ 没有任何可见触发器的 0×0 file 控件仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    stubLayout(new Map([[input, { width: 0, height: 0, top: 300 }]]), new Map());

    expect(
      isApprovedResumeFileTarget(input, rootOf()),
      '0×0 被当成“测试环境未知”而放行 —— 真实页面可以用同一形状藏起 file 蜜罐',
    ).toBe(false);
  });

  it('⛔ opacity:0 且没有可见关联触发器时仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLElement;
    stubLayout(
      new Map([
        [input, { width: 230, height: 40, top: 300 }],
        [label, { width: 0, height: 0, top: 300 }],
      ]),
      new Map([[input, { opacity: '0' } as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 没有简历正向语义的 generic upload 仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="upload-control" name="upload" type="file" />
          <button type="button">Attach resume</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 简历身份同时命中 beecatcher 时仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input name="resume" data-qa="beecatcher" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(new Map([[input, { width: 230, height: 40, top: 300 }]]), new Map());

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 可见但没有可读名称的关联触发器仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume"></label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLElement;
    stubLayout(
      new Map([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 300, height: 42, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['隐藏子树', '<span hidden>Attach resume</span>'],
    ['不渲染的 style 节点', '<style>Attach resume</style>'],
  ])('⛔ 只有%s含名称的空白 label 不能伪装可读触发器', (_name, hiddenName) => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">${hiddenName}</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 重复 id 的第二个控件不能借用第一个控件的 label', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume/CV</label>
        <input id="resume" type="file" />
        <input id="resume" type="file" />
      </form>`;
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
    const target = inputs[1]!;
    const label = document.querySelector('label') as HTMLLabelElement;
    expect(label.control).toBe(inputs[0]);
    stubLayout(
      new Map<Element, Box>([
        [target, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(target, rootOf())).toBe(false);
  });

  it('⛔ 包裹多个控件的 label 只能为自己的 control 作证', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label>Attach resume
          <input type="text" />
          <input name="resume" type="file" />
        </label>
      </form>`;
    const label = document.querySelector('label') as HTMLLabelElement;
    const text = document.querySelector('input[type="text"]') as HTMLInputElement;
    const target = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(label.control).toBe(text);
    stubLayout(
      new Map<Element, Box>([
        [target, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(target, rootOf())).toBe(false);
  });

  it('⛔ 表单别处的可见按钮不能替隐藏 file 控件作证', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="resume" type="file" />
        <div><button type="button">Help</button></div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 120, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 同字段容器里的 Help 按钮也不能冒充上传触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="resume" type="file" />
          <button type="button">Help</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 120, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each(['Choose location', 'Browse jobs', 'Select country', 'File complaint'])(
    '⛔ 同字段容器里的“%s”不能冒充上传触发器',
    (buttonName) => {
      document.body.innerHTML = `
        <form id="application-form">
          <div class="field">
            <input id="resume" type="file" />
            <button type="button">${buttonName}</button>
          </div>
        </form>`;
      const input = document.querySelector('input') as HTMLInputElement;
      const button = document.querySelector('button') as HTMLButtonElement;
      stubLayout(
        new Map<Element, Box>([
          [input, { width: 1, height: 1, top: 300 }],
          [button, { width: 160, height: 36, top: 300 }],
        ]),
        new Map(),
      );

      expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
    },
  );

  it.each([
    'Upload avatar',
    'Attach note',
    'Choose document type',
    'Select attachment policy',
    'Do not upload resume',
    '上传头像',
    '选择文件格式',
    '添付写真',
  ])('⛔ 同字段容器的非简历动作“%s”不能作触发器', (buttonName) => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" type="file" />
          <button type="button">${buttonName}</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['id', 'id="upload-transcript"'],
    ['name', 'name="cover-letter-upload"'],
    ['data-ui', 'data-ui="portfolio-upload"'],
    ['data-qa', 'data-qa="beecatcher"'],
    ['data-testid', 'data-testid="transcript-upload"'],
    ['class', 'class="cover-letter-upload"'],
    ['avatar id', 'id="upload-avatar"'],
  ])('⛔ 可见 Upload 按钮的 %s 负向身份必须一票否决', (_name, attribute) => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" type="file" />
          <button type="button" ${attribute}>Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['stale resume class + transcript data', 'resume-upload', 'data-testid="transcript-upload"'],
    ['stale cv class + cover-letter data', 'cv-upload', 'data-test="cover-letter-upload"'],
  ])('⛔ %s 不能用 class 正词洗白负向 data 身份', (_name, className, dataAttribute) => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" class="${className}" ${dataAttribute} type="file" />
          <button type="button">Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ class=resume-upload 本身不得提供简历正向身份', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input class="resume-upload" type="file" />
          <button type="button">Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 目标控件的 class=beecatcher 身份必须一票否决', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" class="beecatcher" type="file" />
          <button type="button">Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 同容器有两个 file 控件时泛称 Upload 按钮不能为简历控件作证', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" type="file" />
          <input name="portfolio" type="file" />
          <button type="button">Upload</button>
        </div>
      </form>`;
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
    const target = inputs[0]!;
    const other = inputs[1]!;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [target, { width: 1, height: 1, top: 300 }],
        [other, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 36, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(target, rootOf())).toBe(false);
  });

  it('⛔ 根外的正式关联负向 label 只能否决，不能被根内按钮洗白', () => {
    document.body.innerHTML = `
      <label for="resume">For robots only, do not enter</label>
      <form id="application-form">
        <div class="field">
          <input id="resume" name="resume" type="file" />
          <button type="button">Attach resume</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    Object.defineProperty(input, 'labels', { value: [label], configurable: true });
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each(['For robots only, do not enter', 'Upload transcript'])(
    '⛔ 目标 input 的 aria-labelledby 负向名称“%s”必须一票否决',
    (accessibleName) => {
      document.body.innerHTML = `
        <span id="target-name">${accessibleName}</span>
        <form id="application-form">
          <div class="field">
            <input name="resume" aria-labelledby="target-name" type="file" />
            <button type="button">Attach resume</button>
          </div>
        </form>`;
      const input = document.querySelector('input') as HTMLInputElement;
      const button = document.querySelector('button') as HTMLButtonElement;
      stubLayout(
        new Map<Element, Box>([
          [input, { width: 1, height: 1, top: 300 }],
          [button, { width: 230, height: 40, top: 300 }],
        ]),
        new Map(),
      );

      expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
    },
  );

  it.each([
    ['aria-description', 'aria-description="For robots only, do not enter"', ''],
    [
      'aria-describedby',
      'aria-describedby="target-description"',
      '<span id="target-description">Upload transcript</span>',
    ],
  ])('⛔ 目标 input 的 %s 负向说明必须一票否决', (_name, attribute, description) => {
    document.body.innerHTML = `
      ${description}
      <form id="application-form">
        <div class="field">
          <input name="resume" ${attribute} type="file" />
          <button type="button">Attach resume</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['aria-description', 'aria-description="Upload transcript"', ''],
    [
      'aria-describedby',
      'aria-describedby="trigger-description"',
      '<span id="trigger-description">For robots only, do not enter</span>',
    ],
  ])('⛔ 可见 Upload 按钮的 %s 负向说明必须一票否决', (_name, attribute, description) => {
    document.body.innerHTML = `
      ${description}
      <form id="application-form">
        <div class="field">
          <input name="resume" type="file" />
          <button type="button" ${attribute}>Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 根的直接子 file 不能把根的直接子按钮当成字段触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="resume" type="file" />
        <button type="button">Attach resume</button>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 非 form 根的直接子 file 不能把根内任意按钮当触发器', () => {
    document.body.innerHTML = `
      <div id="application-root">
        <input id="resume" type="file" />
        <section><button type="button">Save draft</button></section>
      </div>`;
    const container = document.getElementById('application-root') as HTMLElement;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 180, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, createScanRoot(container, []))).toBe(false);
  });

  it.each(['Upload transcript', 'For robots only, do not enter'])(
    '⛔ 负向名称“%s”的同容器按钮不能作触发器',
    (buttonName) => {
      document.body.innerHTML = `
        <form id="application-form">
          <div class="field">
            <input id="resume" type="file" />
            <button type="button">${buttonName}</button>
          </div>
        </form>`;
      const input = document.getElementById('resume') as HTMLInputElement;
      const button = document.querySelector('button') as HTMLButtonElement;
      stubLayout(
        new Map<Element, Box>([
          [input, { width: 1, height: 1, top: 300 }],
          [button, { width: 230, height: 40, top: 300 }],
        ]),
        new Map(),
      );

      expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
    },
  );

  it('⛔ 任一关联候选出现负向信号时不能被另一个正向候选抵消', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <label for="resume">Resume/CV</label>
          <label for="resume">For robots only, do not enter</label>
          <input id="resume" type="file" />
          <button type="button">Attach resume</button>
        </div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const candidates = [...document.querySelectorAll('label, button')];
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        ...candidates.map((candidate) => [candidate, { width: 230, height: 40, top: 300 }] as const),
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ aria-labelledby 的负向可访问名称不能被可见正向文字掩盖', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <span id="trap-name">For robots only, do not enter</span>
        <label for="resume" aria-labelledby="trap-name">Attach resume</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    [
      '表单根外',
      `<form id="application-form">
         <div class="field">
           <input name="resume" type="file" />
           <button type="button" aria-labelledby="outside-name"></button>
         </div>
       </form>
       <span id="outside-name" hidden>Attach resume</span>`,
      [] as string[],
    ],
    [
      '排除区域',
      `<form id="application-form">
         <span id="outside-name" class="excluded-name" hidden>Attach resume</span>
         <div class="field">
           <input name="resume" type="file" />
           <button type="button" aria-labelledby="outside-name"></button>
         </div>
       </form>`,
      ['.excluded-name'],
    ],
  ])('⛔ 可见按钮不能借用%s的 aria-labelledby 名称', (_name, markup, excludeWithin) => {
    document.body.innerHTML = markup;
    const form = document.querySelector('form') as HTMLFormElement;
    const input = document.querySelector('input') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 40, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, createScanRoot(form, excludeWithin))).toBe(false);
  });

  it.each([
    ['transform 位移到永久视口外', { transform: 'translateY(-10000px)' }, -10_000],
    ['filter:opacity(0) 完全透明', { filter: 'opacity(0)' }, 300],
  ])('⛔ %s 的关联 label 不能作触发器', (_name, style, top) => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Attach resume</label>
        <input id="resume" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top }],
      ]),
      new Map([[label, style as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['fixed 且永久在视口外', { position: 'fixed' }, -10_000],
    ['transform 位移隐藏', { transform: 'translateY(-10000px)' }, -10_000],
  ])('⛔ %s 的原生 file 自身不能作触发器', (_name, style, top) => {
    document.body.innerHTML = `
      <form id="application-form">
        <input name="resume" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(
      new Map([[input, { width: 230, height: 40, top }]]),
      new Map([[input, style as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['opacity:.001', { opacity: '0.001' }],
    ['filter:opacity(.001)', { filter: 'opacity(.001)' }],
  ])('⛔ %s 的近乎透明原生 file 自身不能作触发器', (_name, style) => {
    document.body.innerHTML = `
      <form id="application-form"><input name="resume" type="file" /></form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(
      new Map([[input, { width: 230, height: 40, top: 300 }]]),
      new Map([[input, style as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    [
      '祖先与按钮 opacity 乘积低于阈值',
      { opacity: '0.1' },
      { opacity: '0.1' },
    ],
    [
      '祖先与按钮 filter opacity 乘积低于阈值',
      { filter: 'opacity(20%)' },
      { filter: 'opacity(.2)' },
    ],
  ])('⛔ %s 时不能把触发器当成可见', (_name, parentStyle, buttonStyle) => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input name="resume" type="file" />
          <button type="button">Upload</button>
        </div>
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const field = document.querySelector('.field') as HTMLDivElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map<Element, Partial<CSSStyleDeclaration>>([
        [field, parentStyle],
        [button, buttonStyle],
      ]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ disabled 的同容器按钮不能作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="resume" type="file" />
          <button type="button" disabled>Attach resume</button>
        </div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 同容器的最终 Submit 不能作上传触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="resume" type="file" />
          <button type="submit">Attach resume</button>
        </div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it.each([
    ['aria-disabled', { attribute: 'aria-disabled="true"', style: {} }],
    ['display:none', { attribute: '', style: { display: 'none' } }],
  ])('⛔ %s 的同容器按钮不能作触发器', (_name, guard) => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="resume" type="file" />
          <button type="button" ${guard.attribute}>Attach resume</button>
        </div>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map([[button, guard.style as Partial<CSSStyleDeclaration>]]),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 排除区域内的同容器按钮不能作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <input id="resume" type="file" />
          <button type="button" class="excluded-upload-trigger">Attach resume</button>
        </div>
      </form>`;
    const form = document.getElementById('application-form') as HTMLFormElement;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [button, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(
      isApprovedResumeFileTarget(input, createScanRoot(form, ['.excluded-upload-trigger'])),
    ).toBe(false);
  });

  it('⛔ 控件本身位于排除区域时仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="excluded-field">
          <label for="resume">Resume/CV</label>
          <input id="resume" type="file" />
        </div>
      </form>`;
    const form = document.querySelector('form') as HTMLFormElement;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, createScanRoot(form, ['.excluded-field']))).toBe(false);
  });

  it('⛔ 表单根外的控件即使其余信号全正向仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form"></form>
      <input id="resume" type="file" />`;
    const form = document.querySelector('form') as HTMLFormElement;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(new Map([[input, { width: 230, height: 40, top: 300 }]]), new Map());

    expect(isApprovedResumeFileTarget(input, createScanRoot(form, []))).toBe(false);
  });

  it('⛔ 祖先隐藏的关联 label 不能作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div hidden><label for="resume">Attach resume</label></div>
        <input id="resume" type="file" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    stubLayout(
      new Map<Element, Box>([
        [input, { width: 1, height: 1, top: 300 }],
        [label, { width: 230, height: 40, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ 水平画布外的原生 file 自身不能作触发器', () => {
    document.body.innerHTML = `
      <form id="application-form"><input name="resume" type="file" /></form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    stubLayout(
      new Map([[input, { width: 230, height: 40, top: 300, left: 1400 }]]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  it('⛔ disabled 的控件仍须拒绝', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume/CV</label>
        <label class="attach" for="resume">Attach</label>
        <input id="resume" type="file" disabled />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const attach = document.querySelector('label.attach') as HTMLElement;
    stubLayout(
      new Map([
        [input, { width: 1, height: 1, top: 300 }],
        [attach, { width: 300, height: 42, top: 300 }],
      ]),
      new Map(),
    );

    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });

  /**
   * ⛔ **文本控件的蜜罐规则一个字都不能动。** Workday 的 `beecatcher` 会被
   * portfolioUrl 的同义词精确命中并填入用户真实网址 → 整份申请被静默判为 bot 丢弃。
   * 这条断言直接调 `isHoneypot`，所以它与 file 控件那条路径完全独立——
   * 放宽 file 判据时若把 `isHoneypotGeometry` 本身改坏，这里必须变红。
   */
  it('⛔ 文本蜜罐（1×1 + beecatcher 身份）仍须被判成蜜罐', () => {
    expect(
      isHoneypot({
        text: 'Portfolio',
        identities: ['beecatcher'],
        geometry: { width: 1, height: 1 },
      }),
      'Workday 的 beecatcher 不再被判成蜜罐 —— 填进去整份申请会被静默丢弃',
    ).toBe(true);

    // 纯几何、无身份词的文本陷阱同样要继续命中。
    expect(
      isHoneypot({
        text: 'Website',
        identities: ['url2'],
        geometry: { width: 1, height: 1 },
      }),
      '1×1 的文本控件不再被判成蜜罐 —— 文本路径的几何判据被误伤了',
    ).toBe(true);
  });
});

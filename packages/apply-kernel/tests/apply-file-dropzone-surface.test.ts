import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScanRoot } from '../src/scanRoot';
import { isApprovedResumeFileTarget } from '../src/write/setFile';

/**
 * 拖放上传区（2026-09-28，通用路）。PostHog 的必填「Resume/CV」是 react-dropzone：一个可聚焦的
 * `div[role=presentation][tabindex=0]` 包着一句「Upload file or drag and drop here」与一个 1×1、clip 掉的
 * `input[type=file]`。它从前两处被判成「没有可见的触发器」、写不进去（TARGET_NOT_WRITABLE）：
 *
 *  · 整页包在一个滚动区里，滚动区用 `mask-image: linear-gradient(…)` 把上下两头各淡出 32px——
 *    一个淡出边缘的遮罩被当成了「藏起来」；
 *  · 上传区本身是 role=presentation（react-dropzone 的缺省），不是 role=button，不算触发器。
 *
 * 标记照 PostHog 的公开页面结构手写，没有页面数据。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const rect = (width: number, height: number, top = 300) => ({
  width, height, top, left: 40, right: 40 + width, bottom: top + height, x: 40, y: top, toJSON: () => ({}),
}) as DOMRect;

/** 计算样式桩：只改给定元素的那几条，其余照 happy-dom 的原值。 */
function stubStyles(overrides: ReadonlyMap<Element, Partial<CSSStyleDeclaration>>): void {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const style = original(element, pseudo);
    const extra = overrides.get(element);
    if (extra === undefined) return style;
    return new Proxy(style, {
      get: (target, property) => (property in extra ? extra[property as keyof CSSStyleDeclaration] : Reflect.get(target, property)),
    });
  });
}

const FADE = 'linear-gradient(rgba(0, 0, 0, 0) 0px, rgb(0, 0, 0) 32px, rgb(0, 0, 0) calc(100% - 32px), rgba(0, 0, 0, 0))';

function mount(zone: string): { root: ReturnType<typeof createScanRoot>; input: HTMLInputElement; scroll: HTMLElement } {
  document.body.innerHTML = `
    <form>
      <div class="scroll-area">
        <div class="w-full">
          <label class="block">Resume/CV<span>*</span></label>
          ${zone}
        </div>
      </div>
    </form>`;
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(1, 1));
  for (const element of document.querySelectorAll('[data-visible]')) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(94, 33));
  }
  return {
    root: createScanRoot(document.querySelector('form')!, []),
    input,
    scroll: document.querySelector('.scroll-area') as HTMLElement,
  };
}

const POSTHOG_ZONE = `
  <div role="presentation" tabindex="0" data-visible>
    <div><p><button type="button" data-visible><span>Upload file</span></button><span>or drag and drop here</span></p></div>
    <input accept="application/pdf,.pdf" type="file" tabindex="-1" name="Resume/CV" required>
  </div>`;

describe('拖放上传区：看得见的上传区里藏着的 input[type=file]', () => {
  it('外层滚动区淡出边缘的遮罩不算藏起来：上传区的按钮是触发器', () => {
    const { root, input, scroll } = mount(POSTHOG_ZONE);
    stubStyles(new Map([[scroll, { maskImage: FADE } as Partial<CSSStyleDeclaration>]]));
    expect(isApprovedResumeFileTarget(input, root)).toBe(true);
  });

  it('整个透明的遮罩仍然算藏起来', () => {
    const { root, input, scroll } = mount(POSTHOG_ZONE);
    stubStyles(new Map([[scroll, { maskImage: 'linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))' } as Partial<CSSStyleDeclaration>]]));
    expect(isApprovedResumeFileTarget(input, root)).toBe(false);
  });

  it('图片遮罩（url）看不出透不透明：仍然算藏起来', () => {
    const { root, input, scroll } = mount(POSTHOG_ZONE);
    stubStyles(new Map([[scroll, { maskImage: 'url("mask.svg")' } as Partial<CSSStyleDeclaration>]]));
    expect(isApprovedResumeFileTarget(input, root)).toBe(false);
  });

  it('没有按钮的上传区：可聚焦的 role=presentation 包装本身就是触发器', () => {
    const { root, input } = mount(`
      <div role="presentation" tabindex="0" data-visible>
        <p>Drag and drop your file here, or click to browse</p>
        <input type="file" tabindex="-1" name="resume">
      </div>`);
    expect(isApprovedResumeFileTarget(input, root)).toBe(true);
  });

  it('不可聚焦、也没说上传的包装不算：人操作不了它', () => {
    const { root, input } = mount(`
      <div role="presentation" data-visible>
        <p>Drag and drop your file here, or click to browse</p>
        <input type="file" tabindex="-1" name="resume">
      </div>`);
    expect(isApprovedResumeFileTarget(input, root)).toBe(false);
  });

  it('可聚焦、却没说上传的包装也不算', () => {
    const { root, input } = mount(`
      <div role="presentation" tabindex="0" data-visible>
        <p>Supported formats: PDF, DOCX</p>
        <input type="file" tabindex="-1" name="resume">
      </div>`);
    expect(isApprovedResumeFileTarget(input, root)).toBe(false);
  });
});

describe('自定义标签当触发器：「Choose files. No files chosen.」（Valve）', () => {
  /**
   * 2026-09-28 Valve：原生 input 透明（opacity 0），人点的是 `<label for>`，文字「Choose files.」后面跟着一个
   * 「No files chosen.」的状态。空状态剥掉之后剩「Choose files. .」，句末的标点把「choose files」那条结尾锚点顶掉了。
   */
  it('句末标点不影响认出上传按钮', () => {
    document.body.innerHTML = `
      <form>
        <p>Attach your documents. Please include a resume.</p>
        <input type="file" multiple name="resume[]" id="applicant_documents">
        <label for="applicant_documents" data-visible>Choose files. <span>No files chosen.</span></label>
      </form>`;
    const input = document.getElementById('applicant_documents') as HTMLInputElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(20, 20));
    const label = document.querySelector('label')!;
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue(rect(120, 30));
    stubStyles(new Map([[input, { opacity: '0' } as Partial<CSSStyleDeclaration>]]));
    expect(isApprovedResumeFileTarget(input, createScanRoot(document.querySelector('form')!, []))).toBe(true);
  });
});

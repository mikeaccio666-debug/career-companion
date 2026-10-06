// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import type { ApplyFieldDescriptor } from '@edaix/apply-kernel/contracts';
import { hostFieldHasValue } from '../lib/dock/hostField';
import { scanCurrentPage } from '../lib/kernelScanner';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();

/**
 * ARIA 代理选择题在扩展这一侧的两个接缝（2026-09-23；内核那一半在
 * packages/apply-kernel/tests/apply-aria-proxy-choice.test.ts）：
 *
 *  1. 生产扫描器把 CSS 生成内容的读法交给内核：Ashby 必填的是非题只在题干的 `::after` 上画一个星号，
 *     DOM 里没有任何 required / aria-required。没有这个读法，这一题照实是「选填」，浮层的「需要你」
 *     只列必填，它就不会出现在那里。
 *  2. 浮层看「用户是不是已经在网站上答了」：代理题看组里公布的 ARIA 状态，不看藏着的原生 radio——
 *     Workable 上那个 radio 的 checked 晚一拍、还会与 aria-checked 不一致。
 *
 * 题目文字是合成的。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const ASHBY_LOC = {
  hostname: 'jobs.ashbyhq.com',
  origin: 'https://jobs.ashbyhq.com',
  pathname: '/example-org/00000000-0000-4000-8000-000000000000/application',
};

const QUESTION = 'Are you at least 18 years of age?';

function mountAshby(): void {
  document.body.innerHTML = `
    <div class="ashby-application-form-container">
      <div class="ashby-application-form-field-entry" data-field-path="_systemfield_name">
        <label class="ashby-application-form-question-title" for="_systemfield_name">Name</label>
        <input id="_systemfield_name" name="_systemfield_name" type="text" required>
      </div>
      <div class="ashby-application-form-field-entry" data-field-path="question_1001">
        <label class="hashed-required ashby-application-form-question-title" for="question_1001">${QUESTION}</label>
        <div class="ashby-application-form-input-yesno">
          <button aria-pressed="false">Yes</button>
          <button aria-pressed="false">No</button>
          <input type="checkbox" tabindex="-1" name="question_1001">
        </div>
      </div>
    </div>`;
}

function proxyField(fields: readonly ApplyFieldDescriptor[]): ApplyFieldDescriptor | undefined {
  return fields.find((field) => field.kind === 'choice' && field.choice.control === 'proxy');
}

describe('生产扫描器把题干的 ::after 交给内核判必填', () => {
  it('星号画在 ::after 上：这道是非题是必填；样式里没有星号：照实是选填', async () => {
    mountAshby();
    const original = window.getComputedStyle.bind(window);
    // happy-dom 不算伪元素：这里替它回答「那个构建哈希 class 的 ::after 是一个星号」。
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const style = original(element, pseudo ?? undefined);
      if (pseudo === '::after' && element.classList.contains('hashed-required')) {
        return new Proxy(style, { get: (target, key) => (key === 'content' ? '"*"' : Reflect.get(target, key)) });
      }
      return style;
    });
    const withMarker = await scanCurrentPage(document, ASHBY_LOC);
    expect(proxyField(withMarker.scan?.descriptor.fields ?? [])).toMatchObject({ label: QUESTION, required: true });
    expect(computed.mock.calls.some(([, pseudo]) => pseudo === '::after')).toBe(true);

    computed.mockRestore();
    mountAshby();
    const withoutMarker = await scanCurrentPage(document, ASHBY_LOC);
    expect(proxyField(withoutMarker.scan?.descriptor.fields ?? [])).toMatchObject({ label: QUESTION, required: false });
  });
});

describe('浮层看代理题有没有答：看公布的 ARIA 状态', () => {
  it('Ashby 是非题：组里任何一颗 aria-pressed="true" 就算答了', () => {
    mountAshby();
    const [yes, no] = [...document.querySelectorAll('button')];
    expect(hostFieldHasValue(yes)).toBe(false);
    no!.setAttribute('aria-pressed', 'true');
    // 行挂在第一颗（Yes）上，答的是 No：这一题照样算答了。
    expect(hostFieldHasValue(yes)).toBe(true);
  });

  it('Workable 单选：看 aria-checked，不看藏着的 radio（它会晚一拍、会不一致）', () => {
    document.body.innerHTML = `
      <fieldset role="radiogroup" aria-labelledby="q_label">
        <div role="radio" aria-checked="false" tabindex="0"><label><input type="radio" name="QA_1" aria-hidden="true" tabindex="-1"><span>YES</span></label></div>
        <div role="radio" aria-checked="false" tabindex="-1"><label><input type="radio" name="QA_1" aria-hidden="true" tabindex="-1"><span>NO</span></label></div>
      </fieldset>`;
    const [first, second] = [...document.querySelectorAll('[role="radio"]')];
    // 藏着的 radio 说勾上了，宿主公布的状态说没有：信宿主公布的。
    (first!.querySelector('input') as HTMLInputElement).checked = true;
    expect(hostFieldHasValue(first)).toBe(false);
    second!.setAttribute('aria-checked', 'true');
    expect(hostFieldHasValue(first)).toBe(true);
  });

  it('单个 role=checkbox（不在任何组里）只看它自己', () => {
    document.body.innerHTML = `
      <div>
        <label><div role="checkbox" aria-checked="false" tabindex="0" id="a"><input type="checkbox" tabindex="-1" aria-hidden="true"></div><span>First consent</span></label>
        <label><div role="checkbox" aria-checked="true" tabindex="0" id="b"><input type="checkbox" tabindex="-1" aria-hidden="true"></div><span>Second consent</span></label>
      </div>`;
    expect(hostFieldHasValue(document.getElementById('a'))).toBe(false);
    expect(hostFieldHasValue(document.getElementById('b'))).toBe(true);
  });
});

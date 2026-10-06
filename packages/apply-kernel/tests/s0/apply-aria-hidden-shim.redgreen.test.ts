import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../../src/engine';
import { readApplyForm } from '../../src/registry';
import { installBundledApplyAdapters } from '../../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * react-select 的校验垫片不得出现在面板里 —— 以及这条判据**不得**碰到隐藏的
 * 简历 file 控件。
 *
 * 起因是负责人 2026-08-09 第一次在真实 Greenhouse 页上打开面板：9 个字段里
 * 最后一行是**一个没有名字的空白行**，写着"我们无法安全判定这个字段"。
 * 我在真实页面（job-boards.greenhouse.io/anthropic/jobs/5023394008）复现并抓到
 * 它的真身：react-select 给每个下拉配的
 * `input.remix-css-1a0ro4n-requiredInput` —— 无 id、无 name、
 * `aria-hidden="true"`、`tabindex="-1"`、`opacity:0`、`pointer-events:none`。
 *
 * 两个方向都要锁死，因为它们互相拉扯：
 *
 *  ⛔ 放宽成"看不见就跳过" → 简历那条整条 A3 取件路径会一起消失（真实页面上
 *     `#resume` 就是 `class="visually-hidden"`）。同一页实测它是 `tabIndex 0`、
 *     没有 `aria-hidden`、`pointer-events:auto`，所以合取判据碰不到它。
 *  ⛔ 收紧成"只按 class 名匹配" → 换一个打包哈希（`remix-css-*` 是构建产物）
 *     就失效，而失效是静默的：空白行又回来了，没有任何报错。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountGreenhouseWithShim(): void {
  document.body.innerHTML = `
    <form id="application-form" class="application--form">
      <label for="first_name">First Name*</label>
      <input id="first_name" type="text" autocomplete="given-name" required />

      <label for="email">Email*</label>
      <input id="email" type="text" autocomplete="email" required />

      <div class="select-shell">
        <label id="country-label" for="country">Country</label>
        <input id="country" type="text" role="combobox" aria-autocomplete="list"
               aria-labelledby="country-label" class="select__input" />
        <input required tabindex="-1" aria-hidden="true"
               class="remix-css-1a0ro4n-requiredInput" value="" />
      </div>

      <label for="resume">Attach</label>
      <input id="resume" type="file" class="visually-hidden" accept=".pdf,.doc,.docx" />
    </form>
  `;
}

describe('站点自己声明"不是给人填的"控件', () => {
  it('⛔ react-select 的校验垫片不进扫描结果（它会渲染成一个没有名字的空白行）', () => {
    mountGreenhouseWithShim();
    const form = readApplyForm('greenhouse');
    expect(form, 'Greenhouse 表单没被识别，这条断言就失去意义').not.toBeNull();

    const descriptors = form!.fields;
    const shimEntries = descriptors.filter(
      (field) => field.element.getAttribute('aria-hidden') === 'true',
    );
    expect(shimEntries, 'aria-hidden + tabindex=-1 的垫片被当成字段列出来了').toHaveLength(0);

    // 面板上不得再出现"没有名字的行"。这是负责人实际看到的那个症状本身。
    const unnamed = descriptors.filter((field) => field.label.trim() === '');
    expect(unnamed, '仍有无名字段会渲染成空白行').toHaveLength(0);
  });

  it('✅ 视觉隐藏但可聚焦的简历 file 控件必须保留（A3 取件的唯一入口）', () => {
    mountGreenhouseWithShim();
    const form = readApplyForm('greenhouse');
    const resume = form!.fields.find((field) => field.element.getAttribute('id') === 'resume');
    expect(
      resume,
      '简历控件被一起过滤掉了 —— 判据放宽成"看不见就跳过"就会这样',
    ).toBeDefined();
  });

  it('✅ 真实字段与 combobox 本体不受影响', () => {
    mountGreenhouseWithShim();
    const form = readApplyForm('greenhouse');
    const ids = form!.fields.map((field) => field.element.getAttribute('id'));
    expect(ids).toContain('first_name');
    expect(ids).toContain('email');
    expect(ids, 'combobox 本体不是垫片，必须留下').toContain('country');
  });

  it('⛔ 单独一条 aria-hidden 或单独一条 tabindex=-1 都不足以跳过（判据必须是合取）', () => {
    document.body.innerHTML = `
      <form id="application-form" class="application--form">
        <!-- 必须有一个能被识别的字段：容器里一个规范字段都没有时，
             readApplyForm 按设计 fail-closed 返回 null，这条断言就测不到东西了。 -->
        <label for="email">Email*</label>
        <input id="email" type="text" autocomplete="email" required />
        <label for="a">Only aria-hidden</label>
        <input id="a" type="text" aria-hidden="true" />
        <label for="b">Only tabindex</label>
        <input id="b" type="text" tabindex="-1" />
      </form>
    `;
    const form = readApplyForm('greenhouse');
    const ids = form!.fields.map((field) => field.element.getAttribute('id'));
    expect(ids, '只有 aria-hidden 就被跳过 —— 判据被放宽了').toContain('a');
    expect(ids, '只有 tabindex=-1 就被跳过 —— 判据被放宽了').toContain('b');
  });

  it('⛔ 判据不得依赖 class 名（`remix-css-*` 是打包哈希，换一次构建就变）', () => {
    // 这条是补上来的：第一版测试用的是真实 class 名，于是"按 class 名匹配"这个
    // 错误实现**照样能通过**（变异实测 exit=0）。换成一个完全不同的 class，
    // 只保留站点自己的两条声明，class 实现就会漏掉它。
    document.body.innerHTML = `
      <form id="application-form" class="application--form">
        <label for="email">Email*</label>
        <input id="email" type="text" autocomplete="email" required />
        <input required tabindex="-1" aria-hidden="true" class="totally-different-hash-9f2" />
        <input required tabindex="-1" aria-hidden="true" />
      </form>
    `;
    const form = readApplyForm('greenhouse');
    const shims = form!.fields.filter(
      (field) => field.element.getAttribute('aria-hidden') === 'true',
    );
    expect(shims, '判据依赖了 class 名 —— 换个打包哈希就会静默失效').toHaveLength(0);
  });

  it('计划里也看不到它（不是只在 UI 层过滤）', () => {
    mountGreenhouseWithShim();
    const form = readApplyForm('greenhouse');
    const plan = buildApplyPlan(form!, { firstName: 'Terry', email: 'terry@example.com' });
    // skipped 只带 { label, reason, required }，没有 element —— 所以这里按
    // "面板上不得出现无名条目"来判，它正是负责人看到的那个空白行。
    const unnamed = [
      ...plan.entries.map((entry) => entry.label),
      ...plan.skipped.map((entry) => entry.label),
    ].filter((label) => label.trim() === '');
    expect(unnamed, '垫片没进 fields 却进了 plan —— 面板会渲染成空白行').toHaveLength(0);
  });
});

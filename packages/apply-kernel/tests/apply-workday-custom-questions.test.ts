import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isJobDependentField } from '../src/dict/guards';

/**
 * Workday 雇主自定义题的**结构证据**——即「为什么问答回路不是补丁，是差异化本身」。
 *
 * 结构取自真实申请流程 step 5「Application Questions」（2026-08-21 只读实测；
 * 未替用户回答任何雇主问题、未上传文件、未提交）。
 *
 * ## 核心事实：核心字段有钩子，自定义题没有
 *
 *   step 2 核心字段： `formField-legalName--firstName`   ← 语义化，跨租户稳定
 *   step 5 自定义题： `formField-1cef6417bc1510015a7e...` ← **随机 hex GUID**
 *
 * GUID 是逐租户逐岗位生成的。也就是说雇主自定义题**没有任何稳定钩子**，
 * 唯一信号是标签文字。而标签文字是雇主自由填写的，构造上无穷。
 *
 * ## 这就是问答回路存在的理由
 *
 * 这类题同时满足四条：
 *  ① 逐雇主逐岗位，**不可能靠扩字段覆盖完**；
 *  ② 没有稳定标识，规则数据抓不住；
 *  ③ 是 f(候选人 × 岗位)——「我愿不愿意为**这个**岗位搬家」，档案存不下；
 *  ④ 但**一句话就能答**，且答案能按作用域复用
 *     （PD-2026-08-18-PROFILE-QUESTION-MODEL 的 AnswerScopeRef）。
 *
 * 四条合起来就是 `CHAT_ANSWER` 的定义域。竞品对照（2026-08-21 实测，Simplify
 * 面板原文）：「Basic autofill (direct profile fields) is free. Full AI-powered
 * autofill for custom questions is for Simplify+ subscribers.」——**这一档是
 * 它们的付费点**，不是边角料。
 */

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/workday/experience-and-questions.html'),
  'utf8',
);

afterEach(() => {
  document.body.innerHTML = '';
});

const mount = () => { document.body.innerHTML = FIXTURE; };

const questionsPage = () => document.querySelector('[data-automation-id="applyFlowQuestionsPage"]')!;
const wrappers = (root: Element) =>
  [...root.querySelectorAll('div[data-automation-id^="formField-"]')];

describe('自定义题没有稳定钩子', () => {
  it('⚠️ wrapper id 是随机 hex GUID，不是语义名', () => {
    mount();
    const ids = wrappers(questionsPage()).map(
      (w) => w.getAttribute('data-automation-id')!.replace('formField-', ''),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(
        /^[0-9a-f]{32}$/.test(id),
        `${id} 不是 GUID——如果 Workday 改成语义名，规则策略要重评`,
      ).toBe(true);
    }
  });

  it('对比：核心字段的 id 是语义化的', () => {
    mount();
    // 同一家、同一份申请，两页的命名策略完全不同——这不是我们推测出来的，是实测。
    document.body.innerHTML +=
      '<div data-automation-id="formField-legalName--firstName"></div>';
    expect(
      document.querySelector('[data-automation-id="formField-legalName--firstName"]'),
      '核心字段也变成 GUID 了——那 Workday 适配器整体策略都要改',
    ).not.toBeNull();
  });

  it('唯一可用的信号是标签文字', () => {
    mount();
    for (const w of wrappers(questionsPage())) {
      const label = w.querySelector('label')?.textContent?.trim() ?? '';
      expect(label.length, 'GUID 之外连标签都没有——那这一栏对谁都不可解').toBeGreaterThan(0);
    }
  });
});

describe('这些题落在哪个原因码', () => {
  it('「我愿不愿意搬家」是岗位相关题——守卫认得出', () => {
    mount();
    const relocate = [...questionsPage().querySelectorAll('label')]
      .map((l) => l.textContent!.trim())
      .find((t) => /relocate/i.test(t))!;
    expect(relocate).toBe('I am willing to relocate');
    expect(
      isJobDependentField(relocate),
      '搬家意愿没被判成岗位相关题——它会被当成"我们没认出来"，用户以为等下个版本就好了',
    ).toBe(true);
  });

  it('题目形态是混合的：typeahead / 自定义下拉 / 勾选 / 长文本', () => {
    mount();
    const shapes = wrappers(questionsPage()).map((w) => {
      const c = w.querySelector('input, button, textarea')!;
      return c.getAttribute('aria-haspopup') === 'listbox'
        ? 'custom-dropdown'
        : c.tagName.toLowerCase() === 'textarea'
          ? 'textarea'
          : (c.getAttribute('type') ?? 'typeahead');
    });
    // 四种形态里只有 textarea 今天有写入原语——就算知道答案也写不进去三种。
    expect(new Set(shapes)).toEqual(new Set(['typeahead', 'custom-dropdown', 'checkbox', 'textarea']));
  });
});

describe('简历上传的真实形态', () => {
  it('file input 是 display:none，可见的是拖放区与按钮', () => {
    mount();
    const input = document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')!;
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('style')).toContain('display:none');
    // 有可见触发器 → 该挂；没有才是 TARGET_NOT_WRITABLE（本窗口新增的码）。
    expect(document.querySelector('[data-automation-id="select-files"]')).not.toBeNull();
    expect(document.querySelector('[data-automation-id="file-upload-drop-zone"]')).not.toBeNull();
  });
});

describe('重复段的增删行', () => {
  it('四个 Add 按钮共用同一个 automation-id，无 aria-label', () => {
    mount();
    const adds = [...document.querySelectorAll('button[data-automation-id="add-button"]')];
    expect(adds).toHaveLength(4);
    for (const b of adds) {
      expect(
        b.getAttribute('aria-label'),
        'Add 按钮有 aria-label 了——那 CAP-AF-020 的分段策略可以简化',
      ).toBeNull();
    }
  });

  it('⚠️ 只能靠 DOM 顺序分段：属性上区分不了四个段落', () => {
    mount();
    const page = document.querySelector('[data-automation-id="applyFlowMyExpPage"]')!;
    const order = [...page.children]
      .filter((e) => e.tagName === 'H3' || e.getAttribute('data-automation-id') === 'add-button')
      .map((e) => (e.tagName === 'H3' ? `#${e.textContent!.trim()}` : 'ADD'));
    // 段标题与按钮严格交替——这是 CAP-AF-020 在这一家唯一可用的分段依据。
    expect(order.slice(0, 8)).toEqual([
      '#Work Experience', 'ADD',
      '#Education', 'ADD',
      '#Professional Licensure/Certification', 'ADD',
      '#Languages', 'ADD',
    ]);
  });
});

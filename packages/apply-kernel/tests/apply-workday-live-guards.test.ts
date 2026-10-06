// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePageVeto } from '../src/gate/pageVeto';
import { resolveApplyGate } from '../src/gate/resolve';
import { isHoneypot, HONEYPOT_IDENTITY } from '../src/dict/guards';
import { testApplyPolicy } from './helpers/applyTestAuthority';

/**
 * Workday step 1「Create Account」的**真实页面**回归夹具。
 *
 * 取自 `rochester.wd5.myworkdayjobs.com` 的公开岗位申请页
 * （2026-08-21 只读实测：未登录、未输入任何数据、未创建任何账号）。
 *
 * 当前 stable runtime **绝对不能碰**这一页：pending password proposal 只有专用
 * origin-bound local credential + durable release 才可能获批，账号创建确认仍由用户本人完成。
 * 所以这组测试锁的是"我们真的没碰"，以及三道防线在**真实结构**上真的生效。
 *
 * ## 实测记下的三件事
 *
 * **① 蜜罐是活的，而且冲着 autofill 来。** 页面上有
 * `data-automation-id="beecatcher"`、`name="website"`、1×0 像素、id 是随机 UUID
 * 的输入框。`name="website"` 不是巧合——它正对着 autofill 通用的
 * portfolio/website 正则。填了它，整份申请被静默判为 bot 流量丢弃，而界面还会
 * 显示"已填"（阶段 0 复现的正是这一幕）。
 *
 * **② 稳定钩子只有 `data-automation-id`。** 所有真控件的 `name` 都是 null，
 * `id` 是 `input-4/5/6` 这种序号（跨页不稳）。
 *
 * **③ 八步进度条。** `progressBarActiveStep` × 1 + `progressBarInactiveStep` × 7
 * ——这一页是第 1 步，我们要接管的 My Information 在第 2 步之后。
 */

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/workday/create-account-step1.html'),
  'utf8',
);

const WORKDAY_HOST = 'rochester.wd5.myworkdayjobs.com';

function mount(): void {
  document.body.innerHTML = FIXTURE;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('账号页整页否决', () => {
  it('真实的 Create Account 页判 CREDENTIAL_PAGE', () => {
    mount();
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed, '在 Workday 的账号创建页上没有整页否决').toBe(true);
    if (verdict.vetoed) expect(verdict.reason).toBe('CREDENTIAL_PAGE');
  });

  it('门控整链在这一页上不挂载——哪怕主机认得出是 Workday', () => {
    mount();
    const verdict = resolveApplyGate({
      doc: document,
      hostname: WORKDAY_HOST,
      policy: testApplyPolicy(),
      isTopFrame: true,
    });
    expect(verdict.attach, '在账号创建页上挂载了浮层').toBe(false);
    if (!verdict.attach) expect(verdict.reason).toBe('CREDENTIAL_PAGE');
  });
});

describe('活蜜罐的三道防线', () => {
  const beecatcher = () =>
    document.querySelector<HTMLInputElement>('[data-automation-id="beecatcher"]')!;

  it('前提：这个陷阱真的在夹具里，且带着 name="website"', () => {
    mount();
    const trap = beecatcher();
    expect(trap, '夹具里没有蜜罐，后面的断言全是空转').not.toBeNull();
    expect(trap.getAttribute('name'), '陷阱的 name 变了，这条夹具的意义就没了').toBe('website');
  });

  it('身份层：data-automation-id 命中', () => {
    mount();
    expect(HONEYPOT_IDENTITY.test('beecatcher')).toBe(true);
    expect(
      isHoneypot({ text: '', identities: [beecatcher().getAttribute('data-automation-id')] }),
      '身份层没拦住 Workday 官方蜜罐',
    ).toBe(true);
  });

  it('几何层：1×0 像素命中', () => {
    mount();
    expect(
      isHoneypot({ text: '', identities: [], geometry: { width: 1, height: 0 } }),
      '几何层没拦住 1×0 的陷阱',
    ).toBe(true);
  });

  it('⚠️ 反向证明：name="website" 确实会撞上通用 portfolio 正则', () => {
    // 这条不是在测我们的代码，是在**证明这个陷阱为什么危险**：
    // 四家现行规则里 portfolio 的写法就是 /(portfolio|personal (web)?site|website)/i。
    // 蜜罐的 name 正好落在里面——所以拦它的必须是守卫，不能指望匹配层不命中。
    // 这也是「放宽 website/homepage 正则」这件事必须谨慎的活证据。
    const portfolioPattern = /(portfolio|personal (web)?site|website)/i;
    mount();
    expect(
      portfolioPattern.test(beecatcher().getAttribute('name') ?? ''),
      '如果这条变成 false，说明陷阱换形态了，蜜罐守卫的紧迫性要重新评估',
    ).toBe(true);
  });
});

describe('结构事实（写规则时要用）', () => {
  it('八步流程，当前在第 1 步', () => {
    mount();
    expect(document.querySelectorAll('[data-automation-id="progressBarActiveStep"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-automation-id="progressBarInactiveStep"]')).toHaveLength(7);
  });

  it('稳定钩子只有 data-automation-id：真控件的 name 全是 null', () => {
    mount();
    for (const id of ['email', 'password', 'verifyPassword']) {
      const control = document.querySelector<HTMLInputElement>(`input[data-automation-id="${id}"]`);
      expect(control, `控件 ${id} 不在了`).not.toBeNull();
      expect(control!.getAttribute('name'), `${id} 有了 name——稳定钩子的判断要重来`).toBeNull();
    }
  });

  it('wrapper 里装着同名控件：formField-X → [data-automation-id=X]', () => {
    mount();
    for (const key of ['email', 'password', 'verifyPassword']) {
      const wrapper = document.querySelector(`div[data-automation-id="formField-${key}"]`);
      expect(wrapper, `没有 formField-${key} 这个 wrapper`).not.toBeNull();
      expect(
        wrapper!.querySelector(`[data-automation-id="${key}"]`),
        `formField-${key} 里没有同名控件——wrapper 分类法的前提不成立`,
      ).not.toBeNull();
    }
  });

  it('degenerate wrapper：勾选框的 wrapper 后缀是空的', () => {
    // `formField-`（无后缀）真实存在。写 wrapper 分类法时不能假设后缀非空。
    mount();
    expect(document.querySelector('div[data-automation-id="formField-"]')).not.toBeNull();
  });
});

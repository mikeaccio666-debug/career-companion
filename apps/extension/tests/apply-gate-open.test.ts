// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openApplyFormFirst } from '../lib/applyGateOpen';

/**
 * D8（2026-10-04 负责人）：BambooHR 的岗位页上申请表还没打开，「自动填写」先替他点开「Apply for This Job」，等表单出来
 * 接着填。bench-1003：没点开就按，8/8 页停在「申请表还没打开」；点开之后必填 77%。
 *
 * 那一下只把表单展开（网址不变），不提交任何东西。按不按看翻页那一位（远程可关，取不到即关）；按的只能是规则声明的
 * 那一颗、看得见的那一颗；他按了「停止」就不按、不接着填。
 */

afterEach(() => { document.body.innerHTML = ''; });

function setup(over: Partial<Parameters<typeof openApplyFormFirst>[0]> = {}) {
  document.body.innerHTML = '<main><button type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button></main>';
  const button = document.querySelector('button')!;
  let clicks = 0;
  button.addEventListener('click', () => { clicks += 1; });
  const stopper = new AbortController();
  const input = {
    allowed: () => true,
    control: () => button as HTMLElement,
    isVisible: () => true,
    waitForForm: async () => 'SCANNED' as const,
    signal: stopper.signal,
    ...over,
  };
  return { input, clicks: () => clicks, stopper };
}

describe('申请表还没打开：先替他点开', () => {
  it('开着、规则声明的那一颗、看得见 → 点一下，等表单出来，交回扫描结果', async () => {
    const { input, clicks } = setup();
    await expect(openApplyFormFirst(input)).resolves.toBe('SCANNED');
    expect(clicks()).toBe(1);
  });

  it('翻页那一位关着（或取不到）→ 不点', async () => {
    const { input, clicks } = setup({ allowed: () => false });
    await expect(openApplyFormFirst(input)).resolves.toBeNull();
    expect(clicks()).toBe(0);
  });

  it('规则没交出那一颗、看不见 → 不点', async () => {
    const none = setup({ control: () => null });
    await expect(openApplyFormFirst(none.input)).resolves.toBeNull();
    const hidden = setup({ isVisible: () => false });
    await expect(openApplyFormFirst(hidden.input)).resolves.toBeNull();
    expect(hidden.clicks()).toBe(0);
  });

  it('他按了「停止」：不点；等表单的时候按的，不接着填', async () => {
    const before = setup();
    before.stopper.abort();
    await expect(openApplyFormFirst(before.input)).resolves.toBeNull();
    expect(before.clicks()).toBe(0);
    const during = setup();
    during.input.waitForForm = async () => { during.stopper.abort(); return 'SCANNED' as const; };
    await expect(openApplyFormFirst(during.input)).resolves.toBeNull();
    expect(during.clicks()).toBe(1);
  });

  it('读按钮、判可见抛错：当没有，不点', async () => {
    const { input, clicks } = setup({ control: () => { throw new Error('boom'); } });
    await expect(openApplyFormFirst(input)).resolves.toBeNull();
    expect(clicks()).toBe(0);
  });
});

describe('接线：只在第一次扫描停在「申请表还没打开」时、不是连填翻过来的那一页', () => {
  const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');

  it('按翻页那一位、规则声明的那一颗、生产的可见性；等表单与连填翻页同一个等法', () => {
    const at = content.indexOf("outcome.stop === 'APPLY_FORM_NOT_OPENED'");
    expect(at).toBeGreaterThan(0);
    const block = content.slice(at - 200, at + 900);
    expect(block).toContain("mode !== 'AFTER_ADVANCE'");
    expect(block).toContain('openApplyFormFirst({');
    expect(block).toContain('allowed: () => advanceAllowed(runtime.fillPolicy, runtime.mapping.vendor),');
    expect(block).toContain('control: () => readRuntimeApplyGate(runtime.mapping, document),');
    expect(block).toContain('isVisible: isRenderedControl,');
    // 点完之后表单要渲染一下：那之前扫描照旧停在「申请表还没打开」，等，不当结论（2026-10-04 测试台：一扫就交回，8/8 页报
    // 「申请表还没打开」，而表单其实已经展开了）。
    expect(block).toContain('waitForForm: () => scanWhenReady({ scanOnce, budgetMs: NEXT_PAGE_SCAN_BUDGET_MS, alsoNotReady: APPLY_GATE_NOT_READY }),');
    expect(content).toContain("const APPLY_GATE_NOT_READY: ReadonlySet<string> = new Set(['APPLY_FORM_NOT_OPENED']);");
    expect(block).toContain('signal: stopper.signal,');
    // 在「扫描没成就照实说」那一段之前：点开之后的那一次扫描接着走正常的路。
    expect(at).toBeLessThan(content.indexOf('if (outcome.scan === null) {', at));
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { GESTURE_PROOF_TTL_MS, mintAuthorityFromGesture, type TrustedGestureProof } from '@edaix/apply-kernel/grant';

import { NEXT_PAGE_RESERVE_MS, createAdvanceThenFill, scanWhenReady } from '../lib/advanceThenFill';
import type { DockAdvanceOutcome } from '../lib/autofillDock';

/**
 * 「继续到下一页」= 翻过去，然后接着填下一页（advanceThenFill.ts）。
 *
 * 信任根仍是那一次点击：点击当下取凭证，翻过去之后拿它填下一页。这里钉三件事——
 * 只在真的翻过去、且凭证还来得及的时候才接着填；没有凭证（页面派发的点击）绝不填；
 * 下一页还没渲染完的时候等它，扫到了还要等字段数稳定。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

/** 在我方 shadow 里的一颗按钮上派发一次点击，监听器里当场调用 handler（与浮层里的形状一样）。 */
function clickFromOurShadow(
  handler: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAdvanceOutcome>,
  trusted = true,
): Promise<DockAdvanceOutcome> {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let pending: Promise<DockAdvanceOutcome> = Promise.resolve('UNAVAILABLE');
  button.addEventListener('click', (event) => { pending = handler(event, shadowRoot); });
  button.dispatchEvent(trusted ? new TrustedClick('click', { bubbles: true, composed: true }) : new MouseEvent('click', { bubbles: true }));
  host.remove();
  return pending;
}

describe('翻过去之后接着填', () => {
  it('真点击 + 翻过去了 → 拿点击当下的凭证填下一页，告诉浮层「翻过去了，正在填」', async () => {
    const fill = vi.fn<(proof: TrustedGestureProof) => void>();
    const handler = createAdvanceThenFill({ advance: async () => 'ADVANCED', fillNextPage: fill });
    expect(await clickFromOurShadow(handler)).toBe('ADVANCED_FILLING');
    expect(fill).toHaveBeenCalledTimes(1);
    // 这张凭证是内核认的那一种：铸得出填写票。
    const minted = mintAuthorityFromGesture({ proof: fill.mock.calls[0]![0], purpose: 'fill', fingerprint: 'f' });
    expect(minted.ok).toBe(true);
  });

  it('页面派发的点击 → 没有凭证，翻页的结论原样交回，绝不填', async () => {
    const fill = vi.fn();
    // 假设翻页那一侧没拦住（它自己也会拦）：这一层照样不填。
    const handler = createAdvanceThenFill({ advance: async () => 'ADVANCED', fillNextPage: fill });
    expect(await clickFromOurShadow(handler, false)).toBe('ADVANCED');
    expect(fill).not.toHaveBeenCalled();
  });

  it.each(['NOT_ADVANCED', 'UNAVAILABLE', 'UNTRUSTED'] as const)('%s → 原样交回，不填', async (outcome) => {
    const fill = vi.fn();
    const handler = createAdvanceThenFill({ advance: async () => outcome, fillNextPage: fill });
    expect(await clickFromOurShadow(handler)).toBe(outcome);
    expect(fill).not.toHaveBeenCalled();
  });

  it('翻页花的时间太长、凭证剩下的不够下一页用 → 不自动填，交还用户点 Autofill', async () => {
    let clock = 1_000_000;
    const fill = vi.fn();
    const handler = createAdvanceThenFill({
      now: () => clock,
      advance: async () => { clock += GESTURE_PROOF_TTL_MS - NEXT_PAGE_RESERVE_MS + 1; return 'ADVANCED'; },
      fillNextPage: fill,
    });
    expect(await clickFromOurShadow(handler)).toBe('ADVANCED');
    expect(fill).not.toHaveBeenCalled();
  });

  it('填是在把结论交给浮层之前发起的——浮层收到「正在填」时，那一轮已经上路', async () => {
    const order: string[] = [];
    const handler = createAdvanceThenFill({ advance: async () => 'ADVANCED', fillNextPage: () => order.push('fill') });
    const outcome = await clickFromOurShadow(handler).then((value) => { order.push(`dock:${value}`); return value; });
    expect(outcome).toBe('ADVANCED_FILLING');
    expect(order).toEqual(['fill', 'dock:ADVANCED_FILLING']);
  });
});

/** 一次扫描的替身：null 表示没扫到（带停止码），数字表示扫到了这么多字段。 */
function scans(sequence: ReadonlyArray<number | string>) {
  let index = 0;
  const scanOnce = vi.fn(async () => {
    const step = sequence[Math.min(index, sequence.length - 1)]!;
    index += 1;
    return typeof step === 'number'
      ? { scan: { descriptor: { fields: Array.from({ length: step }) } } }
      : { scan: null, stop: step };
  });
  return scanOnce;
}

function clock() {
  let now = 0;
  return { now: () => now, wait: async (ms: number) => { now += ms; } };
}

describe('scanWhenReady：等新的一页真的出来', () => {
  it('新一页还没渲染（锚点没命中、字段还没出来）→ 隔一会儿再扫，扫到并且稳定了才用', async () => {
    const scanOnce = scans(['ROOT_NOT_FOUND', 'NO_KEYED_FIELD', 6, 6]);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 8_000, ...clock() });
    expect(outcome.scan?.descriptor.fields).toHaveLength(6);
    expect(scanOnce).toHaveBeenCalledTimes(4);
  });

  it('字段一批批出来 → 等到两次扫描一样多为止，不拿前半张表去填', async () => {
    const scanOnce = scans([3, 7, 9, 9]);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 8_000, ...clock() });
    expect(outcome.scan?.descriptor.fields).toHaveLength(9);
  });

  it('这一代 DOM 封不住（还在变）→ 也是再等等', async () => {
    const scanOnce = scans(['NOT_SEALABLE:ANCHOR_MOVED', 5, 5]);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 8_000, ...clock() });
    expect(outcome.scan?.descriptor.fields).toHaveLength(5);
  });

  it.each(['PATH_NOT_APPLY', 'APPLY_FORM_NOT_OPENED', 'NO_AUTHORIZED_FIELD'])('%s 不是「还没出来」→ 不等，原样交回', async (stop) => {
    const scanOnce = scans([stop, 5]);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 8_000, ...clock() });
    expect(outcome).toEqual({ scan: null, stop });
    expect(scanOnce).toHaveBeenCalledTimes(1);
  });

  it('调用方点名的另外几种也当「还没出来」（D8：替他点开申请表之后，表单渲染出来之前照旧停在 APPLY_FORM_NOT_OPENED）', async () => {
    const scanOnce = scans(['APPLY_FORM_NOT_OPENED', 'APPLY_FORM_NOT_OPENED', 12, 12]);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 8_000, alsoNotReady: new Set(['APPLY_FORM_NOT_OPENED']), ...clock() });
    expect(outcome.scan?.descriptor.fields).toHaveLength(12);
    expect(scanOnce).toHaveBeenCalledTimes(4);
  });

  it('等到预算用完还是没有表（比如最后的 Review 页）→ 交回最后一次的结果，不无限等', async () => {
    const scanOnce = scans(['ROOT_NOT_FOUND']);
    const outcome = await scanWhenReady({ scanOnce, budgetMs: 3_000, pollMs: 400, ...clock() });
    expect(outcome).toEqual({ scan: null, stop: 'ROOT_NOT_FOUND' });
    expect(scanOnce.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(3_000 / 400));
  });
});

/**
 * 一张手势票必须覆盖**整整一轮**填写。
 *
 * 2026-09-22 生产实测（29 个真实在招岗位）：26 项写入失败于 GESTURE_EXPIRED，全是排在后面的
 * 字段。真因是票据窗口 5 秒，而一份带十几个组合框的申请页跑完要十几秒——前 5 秒写得进去，
 * 之后整轮剩下的一个都写不进，用户只看到「本项未完成」。
 *
 * 这条测试把窗口钉在「够跑完一轮」这件事上：把窗口改回 5 秒，第二条断言立刻红。
 */

import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_TTL_MS,
  GESTURE_PROOF_TTL_MS,
  captureTrustedShadowGesture,
  checkActiveCapability,
  consumeAuthority,
  mintAuthorityFromGesture,
} from '../src/grant';

function trustedGesture(now: number) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadow.appendChild(button);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadow, now); });
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadow, host, document.body, document, window] });
  button.dispatchEvent(event);
  return proof;
}

function mintAt(now: number) {
  const proof = trustedGesture(now);
  return mintAuthorityFromGesture({
    proof: proof as never,
    purpose: 'fill',
    fingerprint: 'fp-1',
    capabilities: new Set(['set-text' as const, 'set-combobox' as const]),
    now,
  });
}

describe('一张票覆盖一轮填写', () => {
  it('窗口至少 60 秒：组合框要开菜单、等列表稳定、点选、回读，还有延时复检', () => {
    expect(AUTHORITY_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });

  /** 写入期真正问的是「这张已经开跑的票现在还算数吗」，所以先按产品路把它 consume 成活票。 */
  function activeAt(t0: number) {
    const minted = mintAt(t0);
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error('mint failed');
    const consumed = consumeAuthority(minted.value, t0);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) throw new Error('consume failed');
    return consumed.value;
  }

  it('铸票 30 秒后仍能写——真实页面上那时候才刚写到一半', () => {
    const t0 = 1_800_000_000_000;
    expect(checkActiveCapability(activeAt(t0), 'set-combobox', t0 + 30_000).ok).toBe(true);
  });

  it('窗口终究有上限：过了就不再是有效授权', () => {
    const t0 = 1_800_000_000_000;
    const expired = checkActiveCapability(activeAt(t0), 'set-text', t0 + AUTHORITY_TTL_MS + 1);
    expect(expired).toMatchObject({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('「一次点击能留多久再用」不受影响：凭证自己仍是 30 秒', () => {
    expect(GESTURE_PROOF_TTL_MS).toBe(30_000);
    const t0 = 1_800_000_000_000;
    const proof = trustedGesture(t0);
    const late = mintAuthorityFromGesture({
      proof: proof as never,
      purpose: 'fill',
      fingerprint: 'fp-1',
      capabilities: new Set(['set-text' as const]),
      now: t0 + GESTURE_PROOF_TTL_MS + 1,
    });
    expect(late).toMatchObject({ ok: false, code: 'GESTURE_EXPIRED' });
  });
});

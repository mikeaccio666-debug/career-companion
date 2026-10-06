import { describe, expect, it } from 'vitest';

import { nextFaceRetryDelayMs, FACE_RETRY_DELAYS_MS } from '../lib/autofillDockDecision';
import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 「取不到规则」是**这一次**的事，不是**这一页**的事——所以要再问。
 *
 * MV3 的 worker 是冷启动的：用户打开申请页，内容脚本在 `document_start` 就报到，
 * 规则包还在路上。后台等它（`dock-face-awaits-rules`），但等不到就如实回
 * `RULES_UNAVAILABLE`——那句话是对的，错的是**说完就不动了**。
 *
 * 内容脚本只在启动、`focus`、`pageshow` 这三个时机报到。用户直接落在申请页上、
 * 不切走再切回来，那张「暂时取不到填写规则」就一直挂着，而规则其实几秒后就装好了。
 * 批测里更彻底：每页新开一个标签页、从不失焦，于是一次都不会重问。
 *
 * 重试不放松任何一道闸：每一次都是**重新向后台要一张脸**，同一条消息、同一段
 * 计算、同样 fail closed。规则真的取不到时，退避问完就停在那张脸上——那时它是
 * 真话（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。
 *
 * 只对 RULES_UNAVAILABLE 重试。其余几张脸都是**关于这一页的结论**，不会自己变：
 * 没登录要用户去登，不属于任何 Mission 要用户去加，认不出就是认不出——
 * 对它们轮询只是白耗电。
 */

const face = (f: AutofillAffordance) => f;

describe('取不到规则要按退避再问，别的脸不问', () => {
  it('第一次取不到：给一个退避', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' }), 0))
      .toBe(FACE_RETRY_DELAYS_MS[0]);
  });

  it('退避是递增的，问够就停', () => {
    const delays = FACE_RETRY_DELAYS_MS.map((_, i) =>
      nextFaceRetryDelayMs(face({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' }), i));
    expect(delays).toEqual([...FACE_RETRY_DELAYS_MS]);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    expect(nextFaceRetryDelayMs(
      face({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' }),
      FACE_RETRY_DELAYS_MS.length,
    ), '问够了还接着问 = 白耗电').toBeNull();
  });

  it('没登录不重问——那是要用户去做的事，不会自己变', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }), 0)).toBeNull();
  });

  it('不属于任何 Mission 不重问', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }), 0)).toBeNull();
  });

  it('认不出这一页不重问', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'DORMANT' }), 0)).toBeNull();
  });

  it('已经能填了当然不重问', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'READY' }), 0)).toBeNull();
  });

  // 这一页什么都不挂（百科、新闻、购物）：也是结论。内容脚本要把它原样交到这里（`parseDockFaceReply`），
  // 不能先变成 null——那就成了「没答上来」（`dock-face-hidden-is-final` 跑真内容脚本钉着）。
  it('这一页什么都不挂（HIDDEN）不重问', () => {
    expect(nextFaceRetryDelayMs(face({ kind: 'HIDDEN' }), 0)).toBeNull();
  });

  // 后台那个 `.catch(() => undefined)`：认不出的回复一律不挂浮层。这时**也要再问**——
  // 一次通道抖动不该让插件在这一页上永久消失。
  it('后台压根没答上来：也要再问', () => {
    expect(nextFaceRetryDelayMs(null, 0)).toBe(FACE_RETRY_DELAYS_MS[0]);
  });

  it('退避第一档要长过报到自身的节流窗（2s），否则这一问会被吞掉', () => {
    expect(FACE_RETRY_DELAYS_MS[0]).toBeGreaterThan(2_000);
  });
});

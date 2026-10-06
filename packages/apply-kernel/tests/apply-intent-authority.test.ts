import { describe, expect, it } from 'vitest';

import {
  checkActiveCapability,
  consumeAuthority,
  mintIntentAuthority,
  releaseAuthority,
} from '../src/grant';

/**
 * Intent 铸造路径的特征测试（T10，20 §3 授权链重做）。
 *
 * 锁三件事：①lease 为信任根的铸造与手势路径共享同一套运行时语义
 * （一次核销、逐写入过期、能力位收窄）；②写入窗口由 lease 到期统一
 * 约束——服务端控制，本地无宽限；③畸形/过期 lease fail-closed 且
 * 原因码可区分（LEASE_INVALID / LEASE_EXPIRED）。
 */

const LEASE = { executionLease: 'lease_9f2c', expiresAtMs: 10_000 };

function mint(now = 1_000, lease = LEASE) {
  return mintIntentAuthority({ lease, purpose: 'fill', fingerprint: 'fp_1', now });
}

describe('mintIntentAuthority', () => {
  it('合法 lease 铸出的票据走完整生命周期：核销一次 → 能力检查 → 释放', () => {
    const minted = mint();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const consumed = consumeAuthority(minted.value, 2_000);
    expect(consumed.ok).toBe(true);

    expect(checkActiveCapability(minted.value, 'set-text', 3_000).ok).toBe(true);
    // 默认能力集不含文件写入——能力位不会凭空变宽。
    expect(checkActiveCapability(minted.value, 'set-file', 3_000)).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });

    releaseAuthority(minted.value);
    expect(checkActiveCapability(minted.value, 'set-text', 3_500)).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
  });

  it('一次核销：同一票据第二次 consume → GRANT_CONSUMED', () => {
    const minted = mint();
    if (!minted.ok) throw new Error('mint failed');
    expect(consumeAuthority(minted.value, 2_000).ok).toBe(true);
    expect(consumeAuthority(minted.value, 2_100)).toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });

  it('写入窗口 = lease 窗口：到期后逐写入检查当场失效', () => {
    const minted = mint();
    if (!minted.ok) throw new Error('mint failed');
    consumeAuthority(minted.value, 2_000);
    expect(checkActiveCapability(minted.value, 'set-text', 9_999).ok).toBe(true);
    expect(checkActiveCapability(minted.value, 'set-text', 10_001)).toEqual({
      ok: false,
      code: 'GESTURE_EXPIRED',
    });
  });

  it('过期 lease 拒铸 → LEASE_EXPIRED；畸形 lease 拒铸 → LEASE_INVALID', () => {
    expect(mint(10_001)).toEqual({ ok: false, code: 'LEASE_EXPIRED' });
    expect(mint(1_000, { executionLease: '', expiresAtMs: 10_000 })).toEqual({
      ok: false,
      code: 'LEASE_INVALID',
    });
    expect(mint(1_000, { executionLease: 'x', expiresAtMs: Number.NaN })).toEqual({
      ok: false,
      code: 'LEASE_INVALID',
    });
  });

  it('伪造对象绕不过 branding：未经铸造的票据形状被写入路径拒绝', () => {
    const forged = {
      purpose: 'fill',
      fingerprint: null,
      capabilities: new Set(['set-text']),
      expiresAt: 99_999,
    };
    expect(consumeAuthority(forged as never, 1_000)).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
  });
});

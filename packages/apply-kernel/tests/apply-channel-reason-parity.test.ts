import { describe, expect, it } from 'vitest';

import { RECEIPT_REASON_CODES } from '@edaix/contracts/draft';
import { APPLY_ERROR_CODES } from '../src/contracts';

/**
 * 通道原因码闭集 = kernel APPLY_ERROR_CODES 的字面镜像（依赖方向
 * kernel→contracts 不允许反向 import，contracts 里是复制件）。
 * 本测试锁**双向相等**：kernel 新增错误码没同步通道闭集 → 红（通道会把
 * 新码整帧拒收）；通道多出 kernel 没有的码 → 红（幽灵码没人产出）。
 */

describe('通道原因码 ↔ kernel 错误码 双向一致', () => {
  it('两个闭集完全相等', () => {
    expect([...RECEIPT_REASON_CODES].sort()).toEqual([...APPLY_ERROR_CODES].sort());
  });
});

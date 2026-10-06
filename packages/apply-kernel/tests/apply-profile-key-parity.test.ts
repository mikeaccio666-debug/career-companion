import { describe, expect, it } from 'vitest';

import { APPLICATION_PROFILE_FIELD_KEYS } from '@edaix/contracts';
import { APPLY_FIELD_KEYS } from '../src/contracts';

/**
 * §5.8 档案端点的 11 键闭集 = kernel canonical registry 的字面镜像
 * （依赖方向 kernel→contracts 不允许反向 import，contracts 里是复制件）。
 * 双向相等：任一侧加键没同步另一侧 → 红。
 */

describe('§5.8 档案键 ↔ kernel canonical 键 双向一致', () => {
  it('两个闭集完全相等', () => {
    expect([...APPLICATION_PROFILE_FIELD_KEYS].sort()).toEqual([...APPLY_FIELD_KEYS].sort());
  });
});

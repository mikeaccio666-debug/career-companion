/**
 * 后端发得出、插件必须接得住的档案键。
 *
 * argoland #469 给 `allowedFieldKeys` 加了 addressLine1 / addressRegion /
 * currentCompany 三个键，端点也一直在发；插件这边停在十一个，于是这三个字段
 * **每次都发过来、每次都被丢掉**。实测语料里 currentCompany 一项就命中 48 次。
 */

import { describe, expect, it } from 'vitest';

import {
  APPLICATION_PROFILE_FIELD_KEYS,
  partitionExecutionIntentClaimKeys,
} from '../src/executionIntent';

describe('档案键清单与后端对齐', () => {
  it('后端在发的三个键也在清单里', () => {
    for (const key of ['addressLine1', 'addressRegion', 'currentCompany'] as const) {
      expect(APPLICATION_PROFILE_FIELD_KEYS).toContain(key);
    }
  });

  it('这三个键能作为 claim key 被认出来，而不是当成题目键', () => {
    // claim key 必须整体 ASCII 升序；三个新键都小于 'question:'，序不破。
    const partitioned = partitionExecutionIntentClaimKeys([
      'addressLine1', 'addressRegion', 'currentCompany', 'email', 'firstName',
    ]);
    expect(partitioned).not.toBeNull();
    expect(partitioned?.profileKeys).toEqual([
      'addressLine1', 'addressRegion', 'currentCompany', 'email', 'firstName',
    ]);
    expect(partitioned?.questionKeys).toEqual([]);
  });
});

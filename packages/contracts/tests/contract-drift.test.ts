import { describe, expect, it } from 'vitest';

import {
  compareContract,
  parseClosedSets,
  parseHeadingSections,
  parseMirrorEndpoints,
  parseSourceEndpoints,
  // @ts-expect-error -- 纯 JS 模块，无类型声明；它刻意不进 TS 编译面
} from '../../../scripts/lib/contract-drift.mjs';

/**
 * 契约漂移门禁的解析逻辑测试。
 *
 * Yiwen 审 PR #17（2026-08-18）第 4 条：「新门禁没有自动测试，CI 连解析逻辑
 * 都未执行」——原实现把 git/fs/解析/退出码揉在一个脚本里，而 CI 固定走
 * 「缺后端 → 跳过」分支，于是端点、章节、闭集三层解析在 CI 里**零执行**。
 *
 * 现在解析是纯函数，本文件用 fixture 直接驱动它：**与后端 clone 在不在无关**，
 * 每次 CI 都真跑。
 */

const SOURCE = `
# EdAIX Agent API 契约

## 3. 会话

### 3.1 建会话

POST /api/v1/agent/session

## 5. 执行意图

### 5.4 签发接口

POST /api/v1/agent/execution-intent

正文里也会散着提到 §5.4 与 §3.1，这是**故意的**——
它们不该被当成标题（见「章节靠 heading 判定」那一组）。

### 5.7 回执

PATCH /api/v1/agent/receipt

闭集成员：APPLY_STARTED、APPLY_SUCCEEDED
`;

const HTTP_TS = `
export const AGENT_HTTP = [
  endpoint('POST', '/api/v1/agent/session', '3.1', 'create session'),
  endpoint('POST', '/api/v1/agent/execution-intent', '5.4', 'issue intent'),
  endpoint('PATCH', '/api/v1/agent/receipt', '5.7', 'receipt'),
] as const;
`;

/**
 * fixture 的闭集。
 *
 * ⚠️ 语义由 `scripts/lib/closed-set-manifest.mjs` 定：顶层默认受后端源契约治理，
 * 子目录必须显式登记为 GOVERNED_NESTED 或 EXEMPT。`draft/channel.ts` 里的真实闭集
 * 已在 EXEMPT 里登记——它是 chat↔扩展的浏览器内通道，不经后端
 * （Yiwen 二轮【高1】：递归扩大了范围但没定义语义，真实双仓上门禁直接红）。
 */
const CLOSED_SETS = {
  'events.ts': `export const APPLY_EVENTS = ['APPLY_STARTED', 'APPLY_SUCCEEDED'] as const;`,
  // 已在 manifest 的 EXEMPT 里登记，不参与比对。
  'draft/channel.ts': `export const RUN_STEPS = ['NOT_IN_SOURCE_AT_ALL'] as const;`,
};

const base = () => ({ source: SOURCE, httpTs: HTTP_TS, closedSetFiles: CLOSED_SETS });

describe('干净基线：没有漂移', () => {
  it('三层全部对齐', () => {
    const r = compareContract(base());
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
    expect(r.badSection).toEqual([]);
    expect(r.drifted).toEqual([]);
    expect(r.failed).toBe(0);
  });

  it('汇报的数量不是 0——否则下面所有用例都可能是空转', () => {
    const r = compareContract(base());
    expect(r.counts.sourceEndpoints).toBe(3);
    expect(r.counts.mirrorEndpoints).toBe(3);
    expect(r.counts.closedSetsSeen).toBe(2);
    expect(r.counts.closedSetsGoverned, 'draft/ 的那个应被豁免，只剩顶层一个受治理').toBe(1);
  });
});

describe('端点集合：双向都要红', () => {
  it('源契约加了端点、镜像没跟 → missing', () => {
    const r = compareContract({ ...base(), source: `${SOURCE}\nDELETE /api/v1/agent/session\n` });
    expect(r.missing).toEqual(['DELETE /api/v1/agent/session']);
    expect(r.failed).toBeGreaterThan(0);
  });

  it('镜像自造端点、源契约没有 → extra', () => {
    const r = compareContract({
      ...base(),
      httpTs: `${HTTP_TS}\nendpoint('GET', '/api/v1/agent/ghost', '5.4', 'x')`,
    });
    expect(r.extra).toEqual(['GET /api/v1/agent/ghost']);
  });

  it('路径写错一个字母 → 同时报两边', () => {
    const r = compareContract({ ...base(), httpTs: HTTP_TS.replace('/session', '/sessio') });
    expect(r.missing).toContain('POST /api/v1/agent/session');
    expect(r.extra).toContain('POST /api/v1/agent/sessio');
  });
});

describe('章节靠 heading 判定，不是全文搜数字', () => {
  /**
   * 这一组直接对应她的探针：把真标题 `### 5.4 签发接口` 改成 `### 9.9 …`，
   * 而正文别处仍出现 `§5.4`。原实现全文搜 `5.4` 命中，
   * 继续报「全部可定位 / ✓ 无漂移」，退出码 0。
   */
  it('后端重排章节号 → 必须红（正文里残留的 §5.4 不算数）', () => {
    const renumbered = SOURCE.replace('### 5.4 签发接口', '### 9.9 签发接口');
    expect(renumbered, '正文里应仍有 §5.4，否则这条测的不是同一件事').toContain('§5.4');

    const r = compareContract({ ...base(), source: renumbered });
    expect(
      r.badSection,
      '章节被重排却没报——说明还在全文搜数字，正文里的 §5.4 顶替了标题',
    ).toHaveLength(1);
    expect(r.badSection[0]).toContain('5.4');
  });

  it('heading 解析：只认 ## 到 ###### 开头的编号', () => {
    const sections = parseHeadingSections(SOURCE);
    expect([...sections].sort()).toEqual(['3', '3.1', '5', '5.4', '5.7']);
  });

  it('正文里的 §5.4 不会被当成标题', () => {
    expect(parseHeadingSections('正文提到 §5.4 和 5.4 节，但没有标题。')).toEqual(new Set());
  });
});

describe('闭集治理范围：显式 manifest，不靠目录猜', () => {
  it('已豁免的 draft/ 闭集不参与比对——即便成员在源契约里完全找不到', () => {
    // 这一条直接对应 Yiwen 二轮【高1】：递归之后 draft/channel.ts 的五个闭集
    // 被当成漂移，真实双仓上门禁退出 1。它们是浏览器内通道的 wire truth，
    // 后端源契约里当然没有，也不该有。
    const r = compareContract(base());
    expect(r.drifted, 'draft/ 的闭集不该被当成后端漂移').toEqual([]);
  });

  it('顶层闭集出现源契约没有的成员 → 红', () => {
    const r = compareContract({
      ...base(),
      closedSetFiles: {
        ...CLOSED_SETS,
        'events.ts': `export const APPLY_EVENTS = ['GHOST_CODE'] as const;`,
      },
    });
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0]).toContain('GHOST_CODE');
  });

  it('显式受治理的 draft proposal 闭集仍参与 source parity', () => {
    const proposal = `
      export const PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES = [
        'BACKGROUND_CHECK_AUTHORIZATION',
        'ARBITRATION_AGREEMENT',
      ] as const;
      export const PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES = [
        'OTP_OR_2FA',
        'MARKETING_SUBSCRIPTION',
      ] as const;
    `;
    const aligned = compareContract({
      ...base(),
      source: `${SOURCE}\nBACKGROUND_CHECK_AUTHORIZATION ARBITRATION_AGREEMENT OTP_OR_2FA MARKETING_SUBSCRIPTION`,
      closedSetFiles: {
        ...CLOSED_SETS,
        'draft/sensitiveWriteProposal.ts': proposal,
      },
    });
    expect(aligned.drifted).toEqual([]);
    expect(aligned.counts.closedSetsGoverned).toBe(3);

    const drifted = compareContract({
      ...base(),
      source: `${SOURCE}\nBACKGROUND_CHECK_AUTHORIZATION OTP_OR_2FA MARKETING_SUBSCRIPTION`,
      closedSetFiles: {
        ...CLOSED_SETS,
        'draft/sensitiveWriteProposal.ts': proposal,
      },
    });
    expect(drifted.drifted).toHaveLength(1);
    expect(drifted.drifted[0]).toContain('ARBITRATION_AGREEMENT');
  });

  it('子目录新增未登记的闭集 → 红（覆盖面不许被静默缩小）', () => {
    // 这是 manifest 最重要的一个方向：漏登记必须报错，不能默默跳过。
    const r = compareContract({
      ...base(),
      closedSetFiles: {
        ...CLOSED_SETS,
        'draft/newthing.ts': `export const BRAND_NEW_SET = ['AAA', 'BBB'] as const;`,
      },
    });
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0]).toContain('draft/newthing.ts BRAND_NEW_SET');
    expect(r.failed).toBeGreaterThan(0);
  });

  it('EXEMPT 里有代码中已不存在的条目 → 红（manifest 不许变成过期清单）', () => {
    // 这是**仓库级卫生检查**，只在扫真实全量 src 时才有意义，
    // 所以默认关、要显式打开（fixture 只含子集，默认开必然误报）。
    const r = compareContract({
      ...base(),
      closedSetFiles: { 'events.ts': CLOSED_SETS['events.ts'] },
      checkStaleExemptions: true,
    });
    expect(r.staleExemptions.length, 'draft/ 的豁免登记还在，但 fixture 里没有那些闭集').toBeGreaterThan(0);
  });

  it('GOVERNED_NESTED 里有代码中已不存在的条目 → 红', () => {
    const r = compareContract({
      ...base(),
      checkStaleExemptions: true,
    });
    expect(r.staleGovernedRegistrations.length).toBeGreaterThan(0);
    expect(r.failed).toBeGreaterThan(0);
  });

  it('默认不开这项检查——否则每个 fixture 用例都会被它误报', () => {
    const r = compareContract({ ...base(), closedSetFiles: { 'events.ts': CLOSED_SETS['events.ts'] } });
    expect(r.staleExemptions).toEqual([]);
    expect(r.staleGovernedRegistrations).toEqual([]);
  });
});

describe('解析器本身', () => {
  it('源契约端点：JWKS 不参与比对', () => {
    const eps = parseSourceEndpoints(
      'GET /.well-known/edaix-execution-intent-jwks.json 与 POST /api/v1/agent/session',
    );
    expect([...eps]).toEqual(['POST /api/v1/agent/session']);
  });

  it('镜像端点：带出 sourceSection', () => {
    const calls = parseMirrorEndpoints(HTTP_TS);
    expect(calls.map((c: { section: string }) => c.section)).toEqual(['3.1', '5.4', '5.7']);
  });

  it('镜像端点：多行 endpoint 调用仍参与 parity', () => {
    const calls = parseMirrorEndpoints(`
      endpoint(
        'POST',
        '/api/v1/agent/execution-intents/sensitive-material',
        '5.9.7',
        'bearer',
        'json',
      )
    `);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/agent/execution-intents/sensitive-material',
        section: '5.9.7',
      },
    ]);
  });

  it('句尾标点不算路径的一部分', () => {
    expect([...parseSourceEndpoints('见 POST /api/v1/agent/session。')]).toEqual([
      'POST /api/v1/agent/session',
    ]);
  });

  it('owner Profile route 也属于后端 source↔mirror parity', () => {
    expect([
      ...parseSourceEndpoints(
        'GET /users/me/application-profile 与 DELETE /users/me/application-profile',
      ),
    ]).toEqual([
      'GET /users/me/application-profile',
      'DELETE /users/me/application-profile',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  GAP_SEVERITIES,
  PRIORITY_TIERS,
  SKILL_RATINGS,
  STRENGTH_SOURCES,
  isGapStrengthReportStale,
  parseGapStrengthReport,
} from '../src/gap-strength';

/**
 * T5 Gap/Strength 源契约草案的特征测试。锁三条不变量：
 *   ①「多一个键整帧拒收」+ 闭集成员校验；
 *   ② 验收铁律「无市场资料 ⇒ severity 必 UNKNOWN，不假装精确」；
 *   ③ 41-能力地图末节「derived StrengthTag 必须引用 confirmed collection」。
 * 每条都配一个变异探针注释：删掉对应保护即应变红。
 */

const EVIDENCE = { profileRef: 'profile/skills/python', note: 'Kaggle Top 1%' };

const GAP = {
  id: 'gap_sql',
  skill: 'SQL',
  category: 'HARD',
  currentLevel: 'C',
  severity: 'CRITICAL',
  evidence: [EVIDENCE],
  recommendedAction: { kind: 'COURSE', detail: 'LeetCode SQL 50 + 窗口函数' },
};

const STRENGTH_DERIVED = {
  id: 'str_math',
  label: '数理与统计基础扎实',
  source: 'DERIVED',
  category: 'HARD',
  evidence: [EVIDENCE],
};

const DIRECTION = {
  targetRole: 'Data Analyst',
  companyContext: null,
  tiers: [
    {
      tier: 'PRIMARY',
      roleTitles: ['Data Analyst', 'Business Analyst'],
      industryExamples: ['TikTok — Data Analyst, New Grad'],
      applyRatio: { minPct: 75, maxPct: 80 },
    },
  ],
};

const REPORT = {
  schemaVersion: 1,
  revision: 1,
  targetRoleKey: 'data-analyst',
  profileRevision: '7',
  marketDataAvailable: true,
  careerDirection: DIRECTION,
  gaps: [GAP],
  strengths: [STRENGTH_DERIVED],
  generatedAt: null,
};

const ok = (value: unknown) => {
  const parsed = parseGapStrengthReport(value);
  expect(parsed.ok, `应接受: ${JSON.stringify(value)}`).toBe(true);
  return parsed;
};
const rejected = (value: unknown, code = 'GAP_STRENGTH_MALFORMED') => {
  expect(parseGapStrengthReport(value)).toEqual({ ok: false, code });
};

describe('闭集完整性', () => {
  it('9 级评分含 UNKNOWN', () => {
    expect(SKILL_RATINGS).toContain('A+');
    expect(SKILL_RATINGS).toContain('C-');
    expect(SKILL_RATINGS).toContain('UNKNOWN');
    expect(SKILL_RATINGS.length).toBe(10);
  });
  it('三档优先级 / 四级严重度 / 三路来源', () => {
    expect([...PRIORITY_TIERS]).toEqual(['PRIMARY', 'SECONDARY', 'TERTIARY']);
    expect([...GAP_SEVERITIES]).toEqual(['CRITICAL', 'MAJOR', 'MINOR', 'UNKNOWN']);
    expect([...STRENGTH_SOURCES]).toEqual(['USER_CONFIRMED', 'USER_FREEFORM', 'DERIVED']);
  });
});

describe('信封与精确键白名单', () => {
  it('接受合法报告', () => {
    ok(REPORT);
  });
  it('非对象 / null 拒收', () => {
    rejected(null);
    rejected('report');
    rejected([]);
  });
  it('schemaVersion > 1 提示升级', () => {
    rejected({ ...REPORT, schemaVersion: 2 }, 'GAP_STRENGTH_VERSION_TOO_NEW');
  });
  // 变异探针：删掉 exactKeys 顶层校验，本用例应转绿（保护失效）。
  it('多一个未知键整帧拒收', () => {
    rejected({ ...REPORT, sneaky: 1 });
  });
  it('缺字段拒收', () => {
    const { targetRoleKey, ...missing } = REPORT;
    void targetRoleKey;
    rejected(missing);
  });
  it('闭集越界拒收（severity / rating / tier）', () => {
    rejected({ ...REPORT, gaps: [{ ...GAP, severity: 'BLOCKER' }] });
    rejected({ ...REPORT, gaps: [{ ...GAP, currentLevel: 'A++' }] });
    rejected({
      ...REPORT,
      careerDirection: { ...DIRECTION, tiers: [{ ...DIRECTION.tiers[0], tier: 'FOURTH' }] },
    });
  });
  it('applyRatio 越界 / 反序拒收', () => {
    const bad = (r: unknown) => ({
      ...REPORT,
      careerDirection: { ...DIRECTION, tiers: [{ ...DIRECTION.tiers[0], applyRatio: r }] },
    });
    rejected(bad({ minPct: 80, maxPct: 75 }));
    rejected(bad({ minPct: -1, maxPct: 10 }));
    rejected(bad({ minPct: 0, maxPct: 101 }));
  });
});

describe('验收铁律：无市场资料 ⇒ severity 必 UNKNOWN', () => {
  it('marketDataAvailable=false 且 severity=UNKNOWN → 接受', () => {
    ok({ ...REPORT, marketDataAvailable: false, gaps: [{ ...GAP, severity: 'UNKNOWN' }] });
  });
  // 变异探针：删掉 parseGapItem 里 market-unknown 那段，本用例应转绿（假装精确未被拦）。
  it('marketDataAvailable=false 但 severity=CRITICAL → 专用错误码拒收', () => {
    rejected(
      { ...REPORT, marketDataAvailable: false, gaps: [GAP] },
      'GAP_STRENGTH_MARKET_UNKNOWN_VIOLATION',
    );
  });
});

describe('derived StrengthTag 必须引用 confirmed collection', () => {
  it('derived 带 profileRef 证据 → 接受', () => {
    ok(REPORT);
  });
  it('USER_FREEFORM 可无结构化引用', () => {
    ok({
      ...REPORT,
      strengths: [
        { id: 'str_x', label: '自我驱动', source: 'USER_FREEFORM', category: 'SOFT', evidence: [] },
      ],
    });
  });
  // 变异探针：删掉 parseStrengthTag 里 DERIVED 证据校验，本两用例应转绿。
  it('derived 无证据 → 专用错误码拒收', () => {
    rejected(
      { ...REPORT, strengths: [{ ...STRENGTH_DERIVED, evidence: [] }] },
      'GAP_STRENGTH_DERIVED_EVIDENCE_MISSING',
    );
  });
  it('derived 证据 profileRef 为 null → 拒收', () => {
    rejected(
      {
        ...REPORT,
        strengths: [{ ...STRENGTH_DERIVED, evidence: [{ profileRef: null, note: '推测' }] }],
      },
      'GAP_STRENGTH_DERIVED_EVIDENCE_MISSING',
    );
  });
});

describe('失效判断（Profile / Target Role change invalidation）', () => {
  const base = { profileRevision: '7' as const, targetRoleKey: 'data-analyst' };
  it('两者一致 → 不 stale', () => {
    expect(isGapStrengthReportStale(base, { ...base })).toBe(false);
  });
  it('profileRevision 变化 → stale', () => {
    expect(isGapStrengthReportStale(base, { ...base, profileRevision: '8' })).toBe(true);
  });
  it('targetRoleKey 变化 → stale', () => {
    expect(isGapStrengthReportStale(base, { ...base, targetRoleKey: 'mle' })).toBe(true);
  });
});

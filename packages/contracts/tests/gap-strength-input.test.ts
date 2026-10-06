import { describe, expect, it } from 'vitest';

import type { GapItem, MarketRequirementInput } from '../src/gap-strength';
import {
  coerceGapSeverityForMarket,
  coerceGapsForMarket,
  confirmedProfileRefs,
  isMarketDataAvailable,
  normalizeTargetRoleKey,
  parsePlannerInput,
  parsePlannerProfileInput,
} from '../src/gap-strength-input';

const MARKET: MarketRequirementInput = { available: true, requirements: ['SQL', 'Tableau'] };

const INPUT = {
  targetRole: 'Data Analyst',
  targetRoleKey: 'data analyst',
  companyContext: null,
  profileRevision: '7',
  market: MARKET,
};

const GAP: GapItem = {
  id: 'gap_sql',
  skill: 'SQL',
  category: 'HARD',
  currentLevel: 'C',
  severity: 'CRITICAL',
  evidence: [{ profileRef: 'profile/skills', note: 'n' }],
  recommendedAction: { kind: 'COURSE', detail: 'SQL 50' },
};

const okParse = (v: unknown) => {
  const r = parsePlannerInput(v);
  expect(r.ok, `应接受: ${JSON.stringify(v)}`).toBe(true);
  return r;
};
const rejected = (v: unknown, code = 'PLANNER_INPUT_MALFORMED') => {
  expect(parsePlannerInput(v)).toEqual({ ok: false, code });
};

describe('normalizeTargetRoleKey：忽略大小写、折叠空白', () => {
  it('大小写归一', () => {
    expect(normalizeTargetRoleKey('Data Analyst')).toBe('data analyst');
    expect(normalizeTargetRoleKey('DATA ANALYST')).toBe('data analyst');
  });
  it('首尾空白与内部多空白折叠', () => {
    expect(normalizeTargetRoleKey('  Data   Analyst ')).toBe('data analyst');
  });
  it('保留中文（不做 slug 化）', () => {
    expect(normalizeTargetRoleKey(' 数据 分析师 ')).toBe('数据 分析师');
  });
  it('相似但不相同的 Role 不折叠成同一键', () => {
    expect(normalizeTargetRoleKey('Data Analyst')).not.toBe(
      normalizeTargetRoleKey('Data Scientist'),
    );
  });
});

describe('parsePlannerInput', () => {
  it('接受合法输入', () => {
    okParse(INPUT);
  });
  it('多键 / 缺键 / 空 role 拒收', () => {
    rejected({ ...INPUT, sneaky: 1 });
    const { market, ...missing } = INPUT;
    void market;
    rejected(missing);
    rejected({ ...INPUT, targetRole: '   ' });
  });
  it('profileRevision 非法拒收', () => {
    rejected({ ...INPUT, profileRevision: '-1' });
    rejected({ ...INPUT, profileRevision: '01' });
    rejected({ ...INPUT, profileRevision: 7 });
    rejected({ ...INPUT, profileRevision: 'x' });
  });
  it('market 结构非法拒收', () => {
    rejected({ ...INPUT, market: { available: 'yes', requirements: [] } });
    rejected({ ...INPUT, market: { available: true, requirements: [1] } });
  });
  // 变异探针：删掉 targetRoleKey===normalize(role) 那条，本用例应转绿。
  it('targetRoleKey 与 role 归一化不一致 → 专用错误码', () => {
    rejected({ ...INPUT, targetRoleKey: 'DATA-ANALYST' }, 'PLANNER_INPUT_ROLE_KEY_MISMATCH');
  });
});

describe('isMarketDataAvailable：空 requirement 视同无资料', () => {
  it('available 且有 requirement → true', () => {
    expect(isMarketDataAvailable({ available: true, requirements: ['SQL'] })).toBe(true);
  });
  it('available 但空 requirement → false', () => {
    expect(isMarketDataAvailable({ available: true, requirements: [] })).toBe(false);
  });
  it('available=false → false', () => {
    expect(isMarketDataAvailable({ available: false, requirements: ['SQL'] })).toBe(false);
  });
});

describe('coerce：无市场资料把 severity 压成 UNKNOWN', () => {
  it('有资料 → 原样保留', () => {
    expect(coerceGapSeverityForMarket(GAP, true).severity).toBe('CRITICAL');
  });
  // 变异探针：删掉 coerce 的强制分支，本用例应转绿。
  it('无资料 → 压成 UNKNOWN', () => {
    expect(coerceGapSeverityForMarket(GAP, false).severity).toBe('UNKNOWN');
  });
  it('批量 coerce', () => {
    const out = coerceGapsForMarket([GAP, { ...GAP, id: 'g2' }], false);
    expect(out.every((g) => g.severity === 'UNKNOWN')).toBe(true);
  });
  it('coerce 结果满足 parser 的 market-unknown 校验（两侧一致）', async () => {
    const { parseGapStrengthReport } = await import('../src/gap-strength');
    const report = {
      schemaVersion: 1,
      revision: 1,
      targetRoleKey: 'data analyst',
      profileRevision: '7',
      marketDataAvailable: false,
      careerDirection: {
        targetRole: 'Data Analyst',
        companyContext: null,
        tiers: [
          {
            tier: 'PRIMARY',
            roleTitles: ['Data Analyst'],
            industryExamples: ['x'],
            applyRatio: { minPct: 75, maxPct: 80 },
          },
        ],
      },
      gaps: coerceGapsForMarket([GAP], false),
      strengths: [],
      generatedAt: null,
    };
    expect(parseGapStrengthReport(report).ok).toBe(true);
  });
});

// ── S4 · Q1 Profile 输入（与 T3 对齐的口径，2026-08-22）────────────────────

const PROFILE = {
  profileRevision: '7',
  skills: [
    { profileRef: 'sk_sql', name: 'SQL', confirmed: true, selfRatedLevel: 3 },
    { profileRef: 'sk_tab', name: 'Tableau', confirmed: false, selfRatedLevel: null },
  ],
  experiences: [{ profileRef: 'ex_1', summary: '两年数据分析实习', confirmed: true }],
  projects: [{ profileRef: 'pj_1', summary: '销售漏斗看板', confirmed: false }],
  achievements: [{ profileRef: 'ac_1', summary: '效率提升 30%', confirmed: true }],
  educations: [
    {
      profileRef: 'ed_1',
      summary: 'BSc Statistics',
      confirmed: true,
      courses: [
        { profileRef: 'co_1', name: '数据库系统', confirmed: true },
        { profileRef: 'co_2', name: '机器学习', confirmed: false },
      ],
    },
  ],
};

describe('parsePlannerProfileInput', () => {
  it('接受五类 confirmed collection 的合法输入', () => {
    const out = parsePlannerProfileInput(PROFILE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.skills).toHaveLength(2);
      expect(out.value.educations[0]!.courses).toHaveLength(2);
    }
  });

  it('多一个键整帧拒收（exact-keys 纪律）', () => {
    const out = parsePlannerProfileInput({ ...PROFILE, resumeRawText: '简历原文' });
    expect(out).toEqual({ ok: false, code: 'PLANNER_PROFILE_MALFORMED' });
  });

  it('少一类 collection 整帧拒收', () => {
    const { achievements: _dropped, ...rest } = PROFILE;
    expect(parsePlannerProfileInput(rest).ok).toBe(false);
  });

  it('条目缺 profileRef 或 profileRef 为空即拒收（evidence 指针不可缺）', () => {
    const bad = {
      ...PROFILE,
      skills: [{ profileRef: '', name: 'SQL', confirmed: true, selfRatedLevel: null }],
    };
    expect(parsePlannerProfileInput(bad).ok).toBe(false);
  });

  it('条目缺 confirmed 标记即拒收', () => {
    const bad = { ...PROFILE, experiences: [{ profileRef: 'ex_1', summary: 'x' }] };
    expect(parsePlannerProfileInput(bad).ok).toBe(false);
  });

  it('selfRatedLevel 只接受 0–4 序数或 null', () => {
    const bad = {
      ...PROFILE,
      skills: [{ profileRef: 'sk_1', name: 'SQL', confirmed: true, selfRatedLevel: 5 }],
    };
    expect(parsePlannerProfileInput(bad).ok).toBe(false);
    const alsoBad = {
      ...PROFILE,
      skills: [{ profileRef: 'sk_1', name: 'SQL', confirmed: true, selfRatedLevel: 'A' }],
    };
    expect(parsePlannerProfileInput(alsoBad).ok).toBe(false);
  });

  it('course 条目同样 exact-keys 校验', () => {
    const bad = {
      ...PROFILE,
      educations: [
        {
          profileRef: 'ed_1',
          summary: 'BSc',
          confirmed: true,
          courses: [{ profileRef: 'co_1', name: 'DB', confirmed: true, grade: 'A' }],
        },
      ],
    };
    expect(parsePlannerProfileInput(bad).ok).toBe(false);
  });
});

describe('confirmedProfileRefs', () => {
  it('只收 confirmed 条目（含 education 的 courses），未确认的一律不进集合', () => {
    const parsed = parsePlannerProfileInput(PROFILE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const refs = confirmedProfileRefs(parsed.value);
    expect([...refs].sort()).toEqual(['ac_1', 'co_1', 'ed_1', 'ex_1', 'sk_sql']);
    // 变异探针语义：sk_tab / pj_1 / co_2 都是 confirmed:false，绝不能出现。
    expect(refs.has('sk_tab')).toBe(false);
    expect(refs.has('pj_1')).toBe(false);
    expect(refs.has('co_2')).toBe(false);
  });
});

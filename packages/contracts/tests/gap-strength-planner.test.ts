import { describe, expect, it } from 'vitest';

import { parseGapStrengthReport, type CareerDirection } from '../src/gap-strength';
import {
  buildGapStrengthReport,
  gapStrengthCacheKey,
  type BuildReportParams,
  type ExtractedCandidateSkill,
  type ExtractedRequiredSkill,
  type SkillMeta,
} from '../src/gap-strength-planner';

// ── Fixture：以张浩宇（Haoyu）背景做 Q1/Q2 抽取的样例（先用 fixture 起步）──

const ev = (ref: string, note: string) => ({ profileRef: ref, note });

const FIXTURE_CANDIDATE: readonly ExtractedCandidateSkill[] = [
  { skillId: 'python-data', category: 'HARD', candidateLevel: 4, evidence: [ev('profile/awards/kaggle', 'Kaggle Top 1%')] },
  { skillId: 'r-lang', category: 'HARD', candidateLevel: 3, evidence: [ev('profile/research/yale', '耶鲁计量研究')] },
  { skillId: 'statistics', category: 'HARD', candidateLevel: 4, evidence: [ev('profile/research/yale', 'DID/IV')] },
  { skillId: 'sql', category: 'HARD', candidateLevel: 0, evidence: [] },
  { skillId: 'tableau', category: 'HARD', candidateLevel: 0, evidence: [] },
];

const FIXTURE_REQUIRED: readonly ExtractedRequiredSkill[] = [
  { skillId: 'sql', requiredLevel: 3, importance: 'MUST' },
  { skillId: 'python-data', requiredLevel: 3, importance: 'MUST' },
  { skillId: 'tableau', requiredLevel: 2, importance: 'NICE' },
  { skillId: 'statistics', requiredLevel: 3, importance: 'MUST' },
];

const META: Record<string, SkillMeta> = {
  'sql': { label: 'SQL', category: 'HARD', remediationType: 'COURSE_SKILL' },
  'python-data': { label: 'Python 数据分析', category: 'HARD', remediationType: 'COURSE_SKILL' },
  'tableau': { label: 'Tableau/BI', category: 'HARD', remediationType: 'TOOL_SKILL' },
  'statistics': { label: '统计与计量', category: 'HARD', remediationType: 'COURSE_SKILL' },
  'r-lang': { label: 'R 语言', category: 'HARD', remediationType: 'COURSE_SKILL' },
};
const skillMeta = (id: string): SkillMeta => META[id] ?? { label: id, category: 'HARD', remediationType: 'COURSE_SKILL' };

const DIRECTION: CareerDirection = {
  targetRole: 'Data Analyst',
  companyContext: null,
  tiers: [
    { tier: 'PRIMARY', roleTitles: ['Data Analyst'], industryExamples: ['TikTok — Data Analyst'], applyRatio: { minPct: 75, maxPct: 80 } },
  ],
};

const base = (over: Partial<BuildReportParams> = {}): BuildReportParams => ({
  revision: 1,
  targetRoleKey: 'data analyst',
  profileRevision: '7',
  marketDataAvailable: true,
  candidate: FIXTURE_CANDIDATE,
  required: FIXTURE_REQUIRED,
  skillMeta,
  careerDirection: DIRECTION,
  generatedAt: null,
  userStrengths: [],
  ...over,
});

describe('buildGapStrengthReport（有市场资料）', () => {
  const report = buildGapStrengthReport(base());

  it('组装结果能过 parser（两侧一致）', () => {
    expect(parseGapStrengthReport(report).ok).toBe(true);
  });

  it('只对有差距的技能产 gap；已覆盖的跳过', () => {
    const ids = report.gaps.map((g) => g.id).sort();
    // sql(缺)、tableau(缺)；python/statistics 已覆盖跳过
    expect(ids).toEqual(['gap_sql', 'gap_tableau']);
  });

  it('SQL 必备完全缺失 → CRITICAL + COURSE', () => {
    const sql = report.gaps.find((g) => g.id === 'gap_sql')!;
    expect(sql.severity).toBe('CRITICAL');
    expect(sql.recommendedAction.kind).toBe('COURSE');
  });

  it('Tableau NICE 缺口 delta2 → MAJOR', () => {
    const t = report.gaps.find((g) => g.id === 'gap_tableau')!;
    expect(t.severity).toBe('MAJOR');
  });

  it('高水平且有 confirmed 证据 → derived StrengthTag（python/r/statistics）', () => {
    const ids = report.strengths.map((s) => s.id).sort();
    expect(ids).toEqual(['str_python-data', 'str_r-lang', 'str_statistics']);
    expect(report.strengths.every((s) => s.source === 'DERIVED')).toBe(true);
    // derived 必须带 profileRef 证据
    expect(report.strengths.every((s) => s.evidence.length > 0 && s.evidence.every((e) => e.profileRef !== null))).toBe(true);
  });
});

describe('无市场资料', () => {
  it('required 为空 → 无 gap，strength 仍来自 profile', () => {
    const report = buildGapStrengthReport(base({ marketDataAvailable: false, required: [] }));
    expect(report.gaps).toEqual([]);
    expect(report.strengths.length).toBe(3);
    expect(parseGapStrengthReport(report).ok).toBe(true);
  });
  it('若仍传 required：severity 全 UNKNOWN 且能过 parser（不假装精确）', () => {
    const report = buildGapStrengthReport(base({ marketDataAvailable: false }));
    expect(report.gaps.every((g) => g.severity === 'UNKNOWN')).toBe(true);
    expect(parseGapStrengthReport(report).ok).toBe(true);
  });
});

describe('Q11 缓存键', () => {
  const parts = {
    userId: 'u1', targetRoleKey: 'data analyst', profileRevision: '9007199254740993' as const,
    strengthRevision: '11' as const,
    marketSnapshotVersion: 'm1', scoringPolicyVersion: 'gap-strength-scoring-v1',
    promptVersion: 'p1', modelVersion: 'claude-x',
  };
  it('确定性：同参数同键', () => {
    expect(gapStrengthCacheKey(parts)).toBe(gapStrengthCacheKey({ ...parts }));
  });
  it('任一版本变 → 键变（触发重算）', () => {
    expect(gapStrengthCacheKey(parts)).toContain('|9007199254740993|');
    expect(gapStrengthCacheKey(parts)).not.toBe(gapStrengthCacheKey({ ...parts, profileRevision: '9007199254740994' }));
    expect(gapStrengthCacheKey(parts)).not.toBe(gapStrengthCacheKey({ ...parts, strengthRevision: '12' }));
    expect(gapStrengthCacheKey(parts)).not.toBe(gapStrengthCacheKey({ ...parts, modelVersion: 'claude-y' }));
  });
});

describe('Profile Strength merge', () => {
  it('includes persisted user strengths and de-duplicates a matching derived label', () => {
    const report = buildGapStrengthReport(base({
      userStrengths: [{
        id: 'profile_strength_1',
        label: '統計與計量',
        source: 'USER_CONFIRMED',
        category: 'HARD',
        evidence: [ev('profile-v2/achievements/a1', 'Confirmed Profile achievement')],
      }],
    }));
    expect(report.strengths.filter((item) => item.label === '統計與計量')).toHaveLength(1);
    expect(report.strengths.find((item) => item.label === '統計與計量')?.source).toBe('USER_CONFIRMED');
  });
});

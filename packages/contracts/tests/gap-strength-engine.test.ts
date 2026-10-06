import { describe, expect, it } from 'vitest';

import type { SkillMatch } from '../src/gap-strength-engine';
import {
  categoryScoreToRating,
  clampToBand,
  computeCategoryScore,
  computeGapSeverity,
  DEFAULT_APPLY_RATIO_PCT,
  fitScoreToTier,
  isStrengthCandidate,
  selectRecommendedActionKind,
} from '../src/gap-strength-engine';

const match = (o: Partial<SkillMatch>): SkillMatch => ({
  skillId: 'sql',
  requiredLevel: 3,
  candidateLevel: 0,
  importance: 'MUST',
  ...o,
});

describe('Q5 computeGapSeverity 门槛', () => {
  it('必备完全缺失 → CRITICAL', () => {
    expect(computeGapSeverity(match({ importance: 'MUST', candidateLevel: 0, requiredLevel: 3 }), true)).toBe('CRITICAL');
  });
  it('gapScore≥4 → CRITICAL（NICE delta4）', () => {
    expect(computeGapSeverity(match({ importance: 'NICE', requiredLevel: 4, candidateLevel: 0 }), true)).toBe('CRITICAL');
  });
  it('gapScore∈[2,4) → MAJOR（MUST delta1）', () => {
    expect(computeGapSeverity(match({ importance: 'MUST', requiredLevel: 3, candidateLevel: 2 }), true)).toBe('MAJOR');
  });
  it('gapScore∈(0,2) → MINOR（NICE delta1）', () => {
    expect(computeGapSeverity(match({ importance: 'NICE', requiredLevel: 2, candidateLevel: 1 }), true)).toBe('MINOR');
  });
  it('delta≤0 → 非 gap（null）', () => {
    expect(computeGapSeverity(match({ requiredLevel: 2, candidateLevel: 3 }), true)).toBeNull();
  });
  // 变异探针：删掉 !marketDataAvailable 分支，本用例应转绿（假装精确未拦）。
  it('无市场资料 → UNKNOWN', () => {
    expect(computeGapSeverity(match({ requiredLevel: 3, candidateLevel: 0 }), false)).toBe('UNKNOWN');
  });
});

describe('Q4 品类字母评分', () => {
  it('全部达标 → categoryScore=1 → A+', () => {
    const ms = [match({ requiredLevel: 3, candidateLevel: 3 }), match({ skillId: 'py', requiredLevel: 2, candidateLevel: 4, importance: 'NICE' })];
    expect(computeCategoryScore(ms, true)).toBe(1);
    expect(categoryScoreToRating(1)).toBe('A+');
  });
  it('完全不达标 → 0 → C-', () => {
    const ms = [match({ requiredLevel: 3, candidateLevel: 0 })];
    expect(computeCategoryScore(ms, true)).toBe(0);
    expect(categoryScoreToRating(0)).toBe('C-');
  });
  it('MUST 权重更高：拉低总分', () => {
    // MUST 缺(0/3) 权重2；NICE 达标(2/2) 权重1 → (2*0 + 1*1)/(2+1)=1/3≈0.333 → C+
    const ms = [match({ importance: 'MUST', requiredLevel: 3, candidateLevel: 0 }), match({ skillId: 'x', importance: 'NICE', requiredLevel: 2, candidateLevel: 2 })];
    const score = computeCategoryScore(ms, true);
    expect(score).toBeCloseTo(1 / 3, 5);
    expect(categoryScoreToRating(score)).toBe('C+');
  });
  it('requiredLevel=0 的项不计入', () => {
    const ms = [match({ requiredLevel: 0, candidateLevel: 0 })];
    expect(computeCategoryScore(ms, true)).toBeNull();
  });
  it('band 边界：0.75→A-，0.65→B+，0.45→B-，0.15→C', () => {
    expect(categoryScoreToRating(0.75)).toBe('A-');
    expect(categoryScoreToRating(0.65)).toBe('B+');
    expect(categoryScoreToRating(0.45)).toBe('B-');
    expect(categoryScoreToRating(0.15)).toBe('C');
  });
  // 变异探针：删掉 !marketDataAvailable→null，本用例应转绿。
  it('无市场资料 → null → UNKNOWN', () => {
    expect(computeCategoryScore([match({})], false)).toBeNull();
    expect(categoryScoreToRating(null)).toBe('UNKNOWN');
  });
});

describe('Q6 recommended action 决策表', () => {
  it('会但没写进简历 → RESUME_REWRITE（优先级最高）', () => {
    expect(selectRecommendedActionKind({ remediationType: 'COURSE_SKILL', severity: 'CRITICAL', hasButHidden: true })).toBe('RESUME_REWRITE');
  });
  it('硬技能课程 → COURSE', () => {
    expect(selectRecommendedActionKind({ remediationType: 'COURSE_SKILL', severity: 'MAJOR', hasButHidden: false })).toBe('COURSE');
  });
  it('工具类 CRITICAL → CERTIFICATION，否则 COURSE', () => {
    expect(selectRecommendedActionKind({ remediationType: 'TOOL_SKILL', severity: 'CRITICAL', hasButHidden: false })).toBe('CERTIFICATION');
    expect(selectRecommendedActionKind({ remediationType: 'TOOL_SKILL', severity: 'MINOR', hasButHidden: false })).toBe('COURSE');
  });
  it('实战缺口 → PROJECT；软性 → MOCK_INTERVIEW；人脉 → NETWORKING', () => {
    expect(selectRecommendedActionKind({ remediationType: 'EXPERIENCE_GAP', severity: 'MAJOR', hasButHidden: false })).toBe('PROJECT');
    expect(selectRecommendedActionKind({ remediationType: 'SOFT_SKILL', severity: 'MAJOR', hasButHidden: false })).toBe('MOCK_INTERVIEW');
    expect(selectRecommendedActionKind({ remediationType: 'NETWORK', severity: 'MINOR', hasButHidden: false })).toBe('NETWORKING');
  });
});

describe('Q9 strength 候选门禁', () => {
  it('level≥3 且有 confirmed achievement 证据 → true', () => {
    expect(isStrengthCandidate(4, true)).toBe(true);
    expect(isStrengthCandidate(3, true)).toBe(true);
  });
  it('level<3 或无证据 → false', () => {
    expect(isStrengthCandidate(2, true)).toBe(false);
    expect(isStrengthCandidate(4, false)).toBe(false);
  });
});

describe('Q7/Q8 tier 与投递比例', () => {
  it('fitScore 分档', () => {
    expect(fitScoreToTier(0.7)).toBe('PRIMARY');
    expect(fitScoreToTier(0.45)).toBe('SECONDARY');
    expect(fitScoreToTier(0.44)).toBe('TERTIARY');
  });
  it('投递比例默认和=100', () => {
    const { PRIMARY, SECONDARY, TERTIARY } = DEFAULT_APPLY_RATIO_PCT;
    expect(PRIMARY + SECONDARY + TERTIARY).toBe(100);
  });
  it('clampToBand 夹回模板 band', () => {
    expect(clampToBand(90, { minPct: 75, maxPct: 80 })).toBe(80);
    expect(clampToBand(60, { minPct: 75, maxPct: 80 })).toBe(75);
    expect(clampToBand(77, { minPct: 75, maxPct: 80 })).toBe(77);
  });
});

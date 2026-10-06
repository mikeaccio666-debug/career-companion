/**
 * T5 · 规划老师确定性评分引擎（additive L1 repository contract）。
 *
 * 落地设计文档 gap-strength-DESIGN.md 的确定性内核（Q3–Q9）：匹配→评分→
 * severity→action→strength→投递比例，全部纯函数、零 LLM、按 SCORING_POLICY_VERSION
 * 版本化，保证「同一输入稳定得同一结果」。LLM 只在上游做文本→SkillId 抽取，
 * 不进入本文件。
 */

import type {
  GapSeverity,
  RecommendedActionKind,
  SkillRating,
} from './gap-strength.ts';

/** 评分策略版本；门槛/band 任何调整都要 bump 它，并纳入缓存键。 */
export const SCORING_POLICY_VERSION = 'gap-strength-scoring-v1';

/** 序数水平 0–4（比 A+~C- 更适合计算）。 */
export type OrdinalLevel = 0 | 1 | 2 | 3 | 4;

export const SKILL_IMPORTANCES = ['MUST', 'NICE'] as const;
export type SkillImportance = (typeof SKILL_IMPORTANCES)[number];

/** importance 权重（MUST 双倍）。 */
export const IMPORTANCE_WEIGHT: Readonly<Record<SkillImportance, number>> = {
  MUST: 2,
  NICE: 1,
};

/** 一条候选人 vs 岗位要求的匹配记录（Q3 产出）。 */
export type SkillMatch = {
  readonly skillId: string;
  readonly requiredLevel: OrdinalLevel;
  readonly candidateLevel: OrdinalLevel;
  readonly importance: SkillImportance;
};

// ── Q5 severity 判定门槛 ────────────────────────────────────────────

/**
 * @returns GapSeverity；delta ≤ 0（已覆盖，非 gap）返回 null；
 * 无市场资料一律 UNKNOWN（不假装精确）。
 */
export function computeGapSeverity(
  match: SkillMatch,
  marketDataAvailable: boolean,
): GapSeverity | null {
  if (!marketDataAvailable) return 'UNKNOWN';
  const delta = match.requiredLevel - match.candidateLevel;
  if (delta <= 0) return null;
  // 必备且完全缺失 → 直接 CRITICAL。
  if (match.importance === 'MUST' && match.candidateLevel === 0) return 'CRITICAL';
  const gapScore = delta * IMPORTANCE_WEIGHT[match.importance];
  if (gapScore >= 4) return 'CRITICAL';
  if (gapScore >= 2) return 'MAJOR';
  return 'MINOR';
}

// ── Q4 品类字母评分（相对岗位要求的达标度）────────────────────────

/**
 * categoryScore = Σ(w · min(1, cand/required)) / Σ w，∈ [0,1]。
 * requiredLevel=0 的项不计入（对该技能无要求）。
 * @returns [0,1]；无匹配项或无市场资料返回 null（→ UNKNOWN）。
 */
export function computeCategoryScore(
  matches: readonly SkillMatch[],
  marketDataAvailable: boolean,
): number | null {
  if (!marketDataAvailable) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const m of matches) {
    if (m.requiredLevel === 0) continue;
    const w = IMPORTANCE_WEIGHT[m.importance];
    weighted += w * Math.min(1, m.candidateLevel / m.requiredLevel);
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  return weighted / totalWeight;
}

/** categoryScore → 9 级字母（版本化 band）；null → UNKNOWN。 */
export function categoryScoreToRating(score: number | null): SkillRating {
  if (score === null) return 'UNKNOWN';
  if (score >= 0.9) return 'A+';
  if (score >= 0.83) return 'A';
  if (score >= 0.75) return 'A-';
  if (score >= 0.65) return 'B+';
  if (score >= 0.55) return 'B';
  if (score >= 0.45) return 'B-';
  if (score >= 0.3) return 'C+';
  if (score >= 0.15) return 'C';
  return 'C-';
}

// ── Q6 recommended action 决策表 ───────────────────────────────────

/** 技能的默认补齐方式（来自 taxonomy）。 */
export const REMEDIATION_TYPES = [
  'COURSE_SKILL', // 可上课补的硬技能（SQL 等）
  'TOOL_SKILL', // 工具类（BI/Tableau），课程或认证
  'EXPERIENCE_GAP', // 缺实战/项目
  'SOFT_SKILL', // 软性/沟通
  'NETWORK', // 人脉/内推
] as const;
export type RemediationType = (typeof REMEDIATION_TYPES)[number];

/**
 * Q6：kind 由确定性表决定；detail 文案另由 Persona Renderer 润色（不在此）。
 * hasButHidden = 会但没写进简历（candidateLevel≥required 却 evidence 弱）→ 优先改简历。
 */
export function selectRecommendedActionKind(params: {
  readonly remediationType: RemediationType;
  readonly severity: GapSeverity;
  readonly hasButHidden: boolean;
}): RecommendedActionKind {
  if (params.hasButHidden) return 'RESUME_REWRITE';
  switch (params.remediationType) {
    case 'COURSE_SKILL':
      return 'COURSE';
    case 'TOOL_SKILL':
      return params.severity === 'CRITICAL' ? 'CERTIFICATION' : 'COURSE';
    case 'EXPERIENCE_GAP':
      return 'PROJECT';
    case 'SOFT_SKILL':
      return 'MOCK_INTERVIEW';
    case 'NETWORK':
      return 'NETWORKING';
    default:
      return 'OTHER';
  }
}

// ── Q9 strength 候选门禁 ───────────────────────────────────────────

/** candidateLevel ≥ 3 且有 confirmed achievement/职业 evidence → strength 候选。 */
export function isStrengthCandidate(
  candidateLevel: OrdinalLevel,
  hasConfirmedAchievementEvidence: boolean,
): boolean {
  return candidateLevel >= 3 && hasConfirmedAchievementEvidence;
}

// ── Q7/Q8 tier 分档与投递比例 ──────────────────────────────────────

export const TIER_FIT_BANDS = { PRIMARY: 0.7, SECONDARY: 0.45 } as const;

/** fitScore∈[0,1] → tier（版本化 band）。 */
export function fitScoreToTier(fitScore: number): 'PRIMARY' | 'SECONDARY' | 'TERTIARY' {
  if (fitScore >= TIER_FIT_BANDS.PRIMARY) return 'PRIMARY';
  if (fitScore >= TIER_FIT_BANDS.SECONDARY) return 'SECONDARY';
  return 'TERTIARY';
}

/** 投递比例策略默认（对齐导师模板 band，和=100）。 */
export const DEFAULT_APPLY_RATIO_PCT = { PRIMARY: 78, SECONDARY: 17, TERTIARY: 5 } as const;

/** 把派生比例夹回模板 band。 */
export function clampToBand(valuePct: number, band: { minPct: number; maxPct: number }): number {
  return Math.min(band.maxPct, Math.max(band.minPct, valuePct));
}

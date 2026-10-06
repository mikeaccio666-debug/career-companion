/**
 * T5 · 规划老师 planner 核心（repository candidate）。
 *
 * 可移植、纯逻辑，供 apps/api 的 NestJS 层消费（Q11 的 HTTP/存储壳另在 apps/api）。
 * 覆盖：
 *   - Q1/Q2：技能解析的**端口类型**（apps/api 使用 confirmed Profile adapter + 版本化岗位要求库）；
 *   - Q3–Q9：调 gap-strength-engine 把抽取结果组装成 GapStrengthReport；
 *   - Q11 核心：缓存键 + 组装（重算/失效沿用 isGapStrengthReportStale）。
 * 组装结果保证能过 parseGapStrengthReport（两侧一致）。
 */

import type {
  CareerDirection,
  Evidence,
  GapItem,
  GapStrengthReport,
  MarketRequirementInput,
  SkillCategory,
  SkillRating,
  StrengthTag,
} from './gap-strength.ts';
import type { PlannerProfileInput } from './gap-strength-input.ts';
import type { DecimalString } from './common.ts';
import type { OrdinalLevel, RemediationType, SkillImportance, SkillMatch } from './gap-strength-engine.ts';
import {
  computeGapSeverity,
  isStrengthCandidate,
  selectRecommendedActionKind,
} from './gap-strength-engine.ts';

// ── Q1/Q2 解析端口（此处只定契约与输出形状）────────────────────────

/** Q1 输出：候选人某技能的已聚合水平 + 证据。 */
export type ExtractedCandidateSkill = {
  readonly skillId: string;
  readonly category: SkillCategory;
  readonly candidateLevel: OrdinalLevel;
  readonly evidence: readonly Evidence[];
};

/** Q2 输出：岗位要求的某技能。 */
export type ExtractedRequiredSkill = {
  readonly skillId: string;
  readonly requiredLevel: OrdinalLevel;
  readonly importance: SkillImportance;
};

/** taxonomy 提供的技能元信息（label / 补齐方式 / 维度）。 */
export type SkillMeta = {
  readonly label: string;
  readonly category: SkillCategory;
  readonly remediationType: RemediationType;
};

/**
 * Q1 端口：从 Profile 解析候选人技能与程度。apps/api 只消费 fully USER_CONFIRMED
 * 的结构化 Profile V2 字段并做确定性聚合；测试可注入 fixture 实现。输入形状与 T3 对齐：
 * 五类 confirmed collection + profileRef/confirmed 标记，见 PlannerProfileInput。
 * evidence.profileRef 必须取自 profile 条目的 profileRef；derived 优势只能引
 * confirmed 条目（confirmedProfileRefs 给出合法集合）。
 */
export type CandidateSkillExtractor = (
  profile: PlannerProfileInput,
) => readonly ExtractedCandidateSkill[];

/**
 * Q2 端口：从版本化岗位要求库解析 required skills，不依赖 Profile 或 JD 原文。
 * 输出为 {skillId, requiredLevel, importance}；unknown role 由调用方保持 market unavailable。
 */
export type RequiredSkillExtractor = (
  market: MarketRequirementInput,
) => readonly ExtractedRequiredSkill[];

// ── 序数 → 字母（interim，schema v2 前的过渡；见 DESIGN Q4 注）──────────

/**
 * ⚠️ interim：GapItem.currentLevel 目前是 SkillRating（字母）。字母本应是**品类
 * rollup**（相对要求），逐技能应存序数——v2 契约再拆。过渡期用此映射产出 schema
 * 合法值，不代表最终语义。
 */
export function ordinalToSkillRating(level: OrdinalLevel): SkillRating {
  switch (level) {
    case 4:
      return 'A';
    case 3:
      return 'B';
    case 2:
      return 'C+';
    case 1:
      return 'C';
    default:
      return 'C-';
  }
}

// ── Q11 缓存键 ─────────────────────────────────────────────────────

export type GapStrengthCacheKeyParts = {
  readonly userId: string;
  readonly targetRoleKey: string;
  readonly profileRevision: DecimalString;
  readonly strengthRevision: DecimalString;
  readonly marketSnapshotVersion: string;
  readonly scoringPolicyVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
};

/** 所有影响结果的版本进键 → 同键命中即返回旧行 → 稳定结果（DESIGN Q11）。 */
export function gapStrengthCacheKey(p: GapStrengthCacheKeyParts): string {
  return [
    p.userId,
    p.targetRoleKey,
    p.profileRevision,
    p.strengthRevision,
    p.marketSnapshotVersion,
    p.scoringPolicyVersion,
    p.promptVersion,
    p.modelVersion,
  ].join('|');
}

// ── Q3–Q9 组装 ─────────────────────────────────────────────────────

export type BuildReportParams = {
  readonly revision: number;
  readonly targetRoleKey: string;
  readonly profileRevision: DecimalString;
  readonly marketDataAvailable: boolean;
  readonly candidate: readonly ExtractedCandidateSkill[];
  readonly required: readonly ExtractedRequiredSkill[];
  readonly skillMeta: (skillId: string) => SkillMeta;
  readonly careerDirection: CareerDirection;
  readonly generatedAt: string | null;
  readonly userStrengths: readonly StrengthTag[];
};

/**
 * 组装 GapStrengthReport：逐 required 技能匹配候选人水平 → 算 severity → 有差距
 * 才产 GapItem；候选人高水平且有 confirmed 证据 → 产 derived StrengthTag。
 * 结果保证过 parseGapStrengthReport。
 */
export function buildGapStrengthReport(p: BuildReportParams): GapStrengthReport {
  const candidateById = new Map<string, ExtractedCandidateSkill>();
  for (const c of p.candidate) candidateById.set(c.skillId, c);

  const gaps: GapItem[] = [];
  for (const r of p.required) {
    const cand = candidateById.get(r.skillId);
    const candidateLevel: OrdinalLevel = cand ? cand.candidateLevel : 0;
    const match: SkillMatch = {
      skillId: r.skillId,
      requiredLevel: r.requiredLevel,
      candidateLevel,
      importance: r.importance,
    };
    const severity = computeGapSeverity(match, p.marketDataAvailable);
    if (severity === null) continue; // 已覆盖，非 gap
    const meta = p.skillMeta(r.skillId);
    const actionKind = selectRecommendedActionKind({
      remediationType: meta.remediationType,
      severity,
      hasButHidden: false, // 展示型差距需 Q1 的 evidence-visibility 信号，后续接
    });
    gaps.push({
      id: `gap_${r.skillId}`,
      skill: meta.label,
      category: meta.category,
      currentLevel: ordinalToSkillRating(candidateLevel),
      severity,
      evidence: cand ? cand.evidence : [],
      recommendedAction: {
        kind: actionKind,
        detail: `${meta.label}：需从 L${candidateLevel} 提升到 L${r.requiredLevel}`,
      },
    });
  }

  const strengths: StrengthTag[] = [...p.userStrengths];
  const strengthLabels = new Set(strengths.map((item) => normalizeStrengthLabel(item.label)));
  for (const c of p.candidate) {
    const grounded = c.evidence.filter((e) => e.profileRef !== null);
    if (!isStrengthCandidate(c.candidateLevel, grounded.length > 0)) continue;
    const label = p.skillMeta(c.skillId).label;
    if (strengthLabels.has(normalizeStrengthLabel(label))) continue;
    strengths.push({
      id: `str_${c.skillId}`,
      label,
      source: 'DERIVED',
      category: c.category,
      evidence: grounded,
    });
    strengthLabels.add(normalizeStrengthLabel(label));
  }

  return {
    schemaVersion: 1,
    revision: p.revision,
    targetRoleKey: p.targetRoleKey,
    profileRevision: p.profileRevision,
    marketDataAvailable: p.marketDataAvailable,
    careerDirection: p.careerDirection,
    gaps,
    strengths,
    generatedAt: p.generatedAt,
  };
}

function normalizeStrengthLabel(label: string): string {
  return label.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

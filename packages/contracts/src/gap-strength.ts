/**
 * T5 · 规划老师 Gap / Strength executable contract。当前按 additive L1 原子切片
 * 收敛到 stable root；repository runtime candidate 从 @edaix/contracts 根引用。
 *
 * 归属 40-工程计划 T5（Gap Analysis + Strength Discovery）。本文件只定义
 * 结构化的 GapItem / StrengthTag / CareerDirection 与其运行时解析器，供
 * Qualification / Resume（文书老师）/ Learning 消费。字段设计对齐导师
 * 真实使用的《GAP 分析报告》模板：
 *   - 软性/硬性技能 9 级评分  → SkillRating
 *   - 差距 Comment            → GapItem.evidence + recommendedAction
 *   - 求职岗位三档优先级       → CareerDirection.tiers
 * 以及 41-能力地图末节裁决：StrengthTag 分 user-confirmed/freeform 与
 * derived 两路，derived 必须引用 confirmed collection 的 evidence。
 *
 * ⚠️ 纪律：契约类改动，合入 main / 启用前仍须走 PR #41 的收敛评审（作者之外
 * 正式成员全部 approve）；并行开发不等于终审通过。验收铁律「无市场资料标
 * unknown，不假装精确」落成 marketDataAvailable=false ⇒ 所有 gap.severity 必为 UNKNOWN。
 */

import type { DecimalString } from './common.ts';

/** 技能水平 9 级评分（导师模板口径）+ 无数据时的 UNKNOWN。 */
export const SKILL_RATINGS = [
  'A+', 'A', 'A-',
  'B+', 'B', 'B-',
  'C+', 'C', 'C-',
  'UNKNOWN',
] as const;
export type SkillRating = (typeof SKILL_RATINGS)[number];

/** 技能维度：软性 / 硬性（专业） / 学历背景。 */
export const SKILL_CATEGORIES = ['SOFT', 'HARD', 'BACKGROUND'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** 差距严重度；无市场资料一律 UNKNOWN（验收铁律）。 */
export const GAP_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'UNKNOWN'] as const;
export type GapSeverity = (typeof GAP_SEVERITIES)[number];

/** StrengthTag 两路来源（41-能力地图末节）：用户确认 / 用户自填 / 派生。 */
export const STRENGTH_SOURCES = ['USER_CONFIRMED', 'USER_FREEFORM', 'DERIVED'] as const;
export type StrengthSource = (typeof STRENGTH_SOURCES)[number];

/** 求职岗位优先级三档（模板：75-80% / 15-20% / 5-0%）。 */
export const PRIORITY_TIERS = ['PRIMARY', 'SECONDARY', 'TERTIARY'] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

/** 推荐动作类别（模板「后续提升方案」的可消费分类）。 */
export const RECOMMENDED_ACTION_KINDS = [
  'COURSE', 'PROJECT', 'CERTIFICATION',
  'RESUME_REWRITE', 'MOCK_INTERVIEW', 'NETWORKING', 'OTHER',
] as const;
export type RecommendedActionKind = (typeof RECOMMENDED_ACTION_KINDS)[number];

/**
 * 证据。derived StrengthTag 与非 UNKNOWN 的 gap 都必须能追到来源：
 * profileRef 指向 confirmed collection 的稳定引用（null = 无结构化引用，
 * 仅 note 说明，允许用于 USER_FREEFORM）。
 */
export type Evidence = {
  readonly profileRef: string | null;
  readonly note: string;
};

export type GapRecommendedAction = {
  readonly kind: RecommendedActionKind;
  readonly detail: string;
};

export type GapItem = {
  readonly id: string;
  readonly skill: string;
  readonly category: SkillCategory;
  readonly currentLevel: SkillRating;
  readonly severity: GapSeverity;
  readonly evidence: readonly Evidence[];
  readonly recommendedAction: GapRecommendedAction;
};

export type StrengthTag = {
  readonly id: string;
  readonly label: string;
  readonly source: StrengthSource;
  readonly category: SkillCategory;
  readonly evidence: readonly Evidence[];
};

/** 申请比例区间（百分比，闭区间，0-100，min ≤ max）。 */
export type ApplyRatio = {
  readonly minPct: number;
  readonly maxPct: number;
};

export type CareerPriorityTier = {
  readonly tier: PriorityTier;
  readonly roleTitles: readonly string[];
  readonly industryExamples: readonly string[];
  readonly applyRatio: ApplyRatio;
};

export type CareerDirection = {
  readonly targetRole: string;
  readonly companyContext: string | null;
  readonly tiers: readonly CareerPriorityTier[];
};

/**
 * 市场需求输入适配器的入参。available=false 表示没有可信市场资料，
 * 下游必须据此把 gap severity 标为 UNKNOWN，不得假装精确。
 */
export type MarketRequirementInput = {
  readonly available: boolean;
  readonly requirements: readonly string[];
};

/**
 * 规划老师的结构化产出。绑定 profileRevision 与 targetRoleKey 用于失效判断：
 * 任一变化即视为 stale，须重算（见 isGapStrengthReportStale）。
 */
export type GapStrengthReport = {
  readonly schemaVersion: 1;
  readonly revision: number;
  /** 归一化后的 targetRole 身份键（immutable），失效判断的一半。 */
  readonly targetRoleKey: string;
  /** 本报告所依据的 Profile revision，失效判断的另一半。 */
  readonly profileRevision: DecimalString;
  readonly marketDataAvailable: boolean;
  readonly careerDirection: CareerDirection;
  readonly gaps: readonly GapItem[];
  readonly strengths: readonly StrengthTag[];
  readonly generatedAt: string | null;
};

export const GAP_STRENGTH_ERROR_CODES = [
  'GAP_STRENGTH_MALFORMED',
  'GAP_STRENGTH_VERSION_TOO_NEW',
  'GAP_STRENGTH_MARKET_UNKNOWN_VIOLATION',
  'GAP_STRENGTH_DERIVED_EVIDENCE_MISSING',
] as const;
export type GapStrengthErrorCode = (typeof GAP_STRENGTH_ERROR_CODES)[number];

export type GapStrengthParseResult =
  | { readonly ok: true; readonly value: GapStrengthReport }
  | { readonly ok: false; readonly code: GapStrengthErrorCode };

// ── 内部校验小工具（多一个键整帧拒收；闭集成员精确校验） ──────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === 'string';

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isDecimalString = (v: unknown): v is DecimalString =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(v);

/** 键集必须与 allowed 完全一致：不多不少。 */
const exactKeys = (obj: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) return false;
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  }
  return true;
};

const inSet = <T extends string>(v: unknown, set: readonly T[]): v is T =>
  isString(v) && (set as readonly string[]).includes(v);

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every(isString);

const parseEvidence = (v: unknown): Evidence | null => {
  if (!isRecord(v) || !exactKeys(v, ['profileRef', 'note'])) return null;
  if (!(v.profileRef === null || isString(v.profileRef))) return null;
  if (!isString(v.note)) return null;
  return { profileRef: v.profileRef, note: v.note };
};

const parseEvidenceArray = (v: unknown): readonly Evidence[] | null => {
  if (!Array.isArray(v)) return null;
  const out: Evidence[] = [];
  for (const item of v) {
    const e = parseEvidence(item);
    if (e === null) return null;
    out.push(e);
  }
  return out;
};

const parseRecommendedAction = (v: unknown): GapRecommendedAction | null => {
  if (!isRecord(v) || !exactKeys(v, ['kind', 'detail'])) return null;
  if (!inSet(v.kind, RECOMMENDED_ACTION_KINDS)) return null;
  if (!isString(v.detail)) return null;
  return { kind: v.kind, detail: v.detail };
};

const parseApplyRatio = (v: unknown): ApplyRatio | null => {
  if (!isRecord(v) || !exactKeys(v, ['minPct', 'maxPct'])) return null;
  if (!isFiniteNumber(v.minPct) || !isFiniteNumber(v.maxPct)) return null;
  if (v.minPct < 0 || v.maxPct > 100 || v.minPct > v.maxPct) return null;
  return { minPct: v.minPct, maxPct: v.maxPct };
};

const parseTier = (v: unknown): CareerPriorityTier | null => {
  if (!isRecord(v) || !exactKeys(v, ['tier', 'roleTitles', 'industryExamples', 'applyRatio'])) {
    return null;
  }
  if (!inSet(v.tier, PRIORITY_TIERS)) return null;
  if (!isStringArray(v.roleTitles) || !isStringArray(v.industryExamples)) return null;
  const applyRatio = parseApplyRatio(v.applyRatio);
  if (applyRatio === null) return null;
  return {
    tier: v.tier,
    roleTitles: v.roleTitles,
    industryExamples: v.industryExamples,
    applyRatio,
  };
};

const parseCareerDirection = (v: unknown): CareerDirection | null => {
  if (!isRecord(v) || !exactKeys(v, ['targetRole', 'companyContext', 'tiers'])) return null;
  if (!isString(v.targetRole)) return null;
  if (!(v.companyContext === null || isString(v.companyContext))) return null;
  if (!Array.isArray(v.tiers)) return null;
  const tiers: CareerPriorityTier[] = [];
  for (const t of v.tiers) {
    const parsed = parseTier(t);
    if (parsed === null) return null;
    tiers.push(parsed);
  }
  return { targetRole: v.targetRole, companyContext: v.companyContext, tiers };
};

/** @returns 解析后的 GapItem，或返回错误码（区分「畸形」与「market-unknown 违规」）。 */
const parseGapItem = (
  v: unknown,
  marketDataAvailable: boolean,
): { ok: true; value: GapItem } | { ok: false; code: GapStrengthErrorCode } => {
  if (
    !isRecord(v) ||
    !exactKeys(v, ['id', 'skill', 'category', 'currentLevel', 'severity', 'evidence', 'recommendedAction'])
  ) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (!isString(v.id) || v.id.length === 0) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!isString(v.skill)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!inSet(v.category, SKILL_CATEGORIES)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!inSet(v.currentLevel, SKILL_RATINGS)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!inSet(v.severity, GAP_SEVERITIES)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  const evidence = parseEvidenceArray(v.evidence);
  if (evidence === null) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  const recommendedAction = parseRecommendedAction(v.recommendedAction);
  if (recommendedAction === null) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };

  // 验收铁律：无市场资料时不许假装精确 → severity 必须 UNKNOWN。
  if (!marketDataAvailable && v.severity !== 'UNKNOWN') {
    return { ok: false, code: 'GAP_STRENGTH_MARKET_UNKNOWN_VIOLATION' };
  }

  return {
    ok: true,
    value: {
      id: v.id,
      skill: v.skill,
      category: v.category,
      currentLevel: v.currentLevel,
      severity: v.severity,
      evidence,
      recommendedAction,
    },
  };
};

/** @returns StrengthTag，或错误码（derived 必须带 profileRef 证据）。 */
const parseStrengthTag = (
  v: unknown,
): { ok: true; value: StrengthTag } | { ok: false; code: GapStrengthErrorCode } => {
  if (!isRecord(v) || !exactKeys(v, ['id', 'label', 'source', 'category', 'evidence'])) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (!isString(v.id) || v.id.length === 0) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!isString(v.label)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!inSet(v.source, STRENGTH_SOURCES)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!inSet(v.category, SKILL_CATEGORIES)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  const evidence = parseEvidenceArray(v.evidence);
  if (evidence === null) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };

  // 41-能力地图末节：derived tag 必须引用 confirmed collection（≥1 条带 profileRef 的证据）。
  if (v.source === 'DERIVED') {
    const grounded = evidence.length > 0 && evidence.every((e) => e.profileRef !== null);
    if (!grounded) return { ok: false, code: 'GAP_STRENGTH_DERIVED_EVIDENCE_MISSING' };
  }

  return {
    ok: true,
    value: {
      id: v.id,
      label: v.label,
      source: v.source,
      category: v.category,
      evidence,
    },
  };
};

/**
 * 校验一个 GapStrengthReport。逐字段闭集 + 精确键白名单；把
 * market-unknown 违规与 derived-evidence 缺失升级成语义错误码，
 * 其余一律 GAP_STRENGTH_MALFORMED。
 */
export function parseGapStrengthReport(input: unknown): GapStrengthParseResult {
  if (!isRecord(input)) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };

  // 版本先判：>1 提示升级，其余非 1 视为畸形。
  if (isFiniteNumber(input.schemaVersion) && input.schemaVersion > 1) {
    return { ok: false, code: 'GAP_STRENGTH_VERSION_TOO_NEW' };
  }

  if (
    !exactKeys(input, [
      'schemaVersion', 'revision', 'targetRoleKey', 'profileRevision',
      'marketDataAvailable', 'careerDirection', 'gaps', 'strengths', 'generatedAt',
    ])
  ) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }

  if (input.schemaVersion !== 1) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  if (!isFiniteNumber(input.revision) || input.revision < 0) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (!isString(input.targetRoleKey) || input.targetRoleKey.length === 0) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (!isDecimalString(input.profileRevision)) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (typeof input.marketDataAvailable !== 'boolean') {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }
  if (!(input.generatedAt === null || isString(input.generatedAt))) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }

  const careerDirection = parseCareerDirection(input.careerDirection);
  if (careerDirection === null) return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };

  if (!Array.isArray(input.gaps) || !Array.isArray(input.strengths)) {
    return { ok: false, code: 'GAP_STRENGTH_MALFORMED' };
  }

  const gaps: GapItem[] = [];
  for (const g of input.gaps) {
    const parsed = parseGapItem(g, input.marketDataAvailable);
    if (!parsed.ok) return parsed;
    gaps.push(parsed.value);
  }

  const strengths: StrengthTag[] = [];
  for (const s of input.strengths) {
    const parsed = parseStrengthTag(s);
    if (!parsed.ok) return parsed;
    strengths.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      revision: input.revision,
      targetRoleKey: input.targetRoleKey,
      profileRevision: input.profileRevision,
      marketDataAvailable: input.marketDataAvailable,
      careerDirection,
      gaps,
      strengths,
      generatedAt: input.generatedAt,
    },
  };
}

/**
 * 失效判断（Profile / Target Role change invalidation）。任一变化即 stale。
 * 消费方（Qualification / Resume / Learning）在读取前调用；stale 须重算。
 */
export function isGapStrengthReportStale(
  report: Pick<GapStrengthReport, 'profileRevision' | 'targetRoleKey'>,
  current: { readonly profileRevision: DecimalString; readonly targetRoleKey: string },
): boolean {
  return (
    report.profileRevision !== current.profileRevision ||
    report.targetRoleKey !== current.targetRoleKey
  );
}

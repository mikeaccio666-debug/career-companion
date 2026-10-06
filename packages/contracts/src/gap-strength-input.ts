/**
 * T5 · 规划老师输入模型与市场适配器（additive L1 repository contract）。
 *
 * 承接 gap-strength.ts：
 *   - S2 PlannerInput：Target Role / company context 的结构化入参；
 *     targetRoleKey 归一化（忽略大小写、折叠空白）以对齐 Role 模型
 *     「相同 Role 忽略大小写不得重复」。
 *   - S3 市场需求适配器（builder 侧）：把「无市场资料」这条验收铁律
 *     落成可复用的强制函数——available=false（或无 requirement）时，
 *     产出侧就把 severity 压成 UNKNOWN，保证下游拿到的 report 天然满足
 *     gap-strength.ts 里 parser 的 market-unknown 校验（两侧一致）。
 *   - S4 Q1 Profile 输入（2026-08-22 与 T3/Issac 对齐、Mike 批准的口径）：
 *     T5 从 Profile 拿五类 confirmed collection（skills / experiences /
 *     projects / achievements / educations 含 courses），每条带稳定
 *     profileRef（evidence 指针）与 confirmed 标记；skills 可带用户自评水平。
 *     不要简历原文（Data-L1 不进本契约）。Q2 不依赖 Profile，
 *     形状见 gap-strength-planner.ts 的 ExtractedRequiredSkill。
 */

import type { GapItem, GapSeverity, MarketRequirementInput } from './gap-strength.ts';
import type { OrdinalLevel } from './gap-strength-engine.ts';
import type { DecimalString } from './common.ts';

/** T5 planner HTTP request shared by compute/latest; exact-object validation remains at the API boundary. */
export type GapStrengthTargetRoleRequest = {
  readonly targetRole: string;
};

export type PlannerInput = {
  /** 用户所填的原始 free-text role。 */
  readonly targetRole: string;
  /** 归一化后的身份键（immutable，失效判断用）。 */
  readonly targetRoleKey: string;
  /** 目标公司 / 行业上下文；无则 null。 */
  readonly companyContext: string | null;
  /** 本次规划所依据的 Profile revision。 */
  readonly profileRevision: DecimalString;
  /** 市场需求输入（可为「无资料」）。 */
  readonly market: MarketRequirementInput;
};

export const PLANNER_INPUT_ERROR_CODES = [
  'PLANNER_INPUT_MALFORMED',
  'PLANNER_INPUT_ROLE_KEY_MISMATCH',
] as const;
export type PlannerInputErrorCode = (typeof PLANNER_INPUT_ERROR_CODES)[number];

export type PlannerInputParseResult =
  | { readonly ok: true; readonly value: PlannerInput }
  | { readonly ok: false; readonly code: PlannerInputErrorCode };

/**
 * 归一化 targetRole → 身份键：去首尾空白、转小写、把内部连续空白折叠为单个空格。
 * 保留中文等非 ASCII（求职岗位可能是中文），只做大小写/空白归一，不做 slug 化。
 */
export function normalizeTargetRoleKey(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, ' ');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isDecimalString = (v: unknown): v is DecimalString =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(v);
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every(isString);

const exactKeys = (obj: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) return false;
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  }
  return true;
};

const parseMarket = (v: unknown): MarketRequirementInput | null => {
  if (!isRecord(v) || !exactKeys(v, ['available', 'requirements'])) return null;
  if (typeof v.available !== 'boolean') return null;
  if (!isStringArray(v.requirements)) return null;
  return { available: v.available, requirements: v.requirements };
};

export function parsePlannerInput(input: unknown): PlannerInputParseResult {
  if (!isRecord(input)) return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  if (!exactKeys(input, ['targetRole', 'targetRoleKey', 'companyContext', 'profileRevision', 'market'])) {
    return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  }
  if (!isString(input.targetRole) || input.targetRole.trim().length === 0) {
    return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  }
  if (!isString(input.targetRoleKey) || input.targetRoleKey.length === 0) {
    return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  }
  if (!(input.companyContext === null || isString(input.companyContext))) {
    return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  }
  if (!isDecimalString(input.profileRevision)) {
    return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };
  }
  const market = parseMarket(input.market);
  if (market === null) return { ok: false, code: 'PLANNER_INPUT_MALFORMED' };

  // targetRoleKey 必须是 targetRole 的归一化结果，杜绝前端自造不一致的键。
  if (input.targetRoleKey !== normalizeTargetRoleKey(input.targetRole)) {
    return { ok: false, code: 'PLANNER_INPUT_ROLE_KEY_MISMATCH' };
  }

  return {
    ok: true,
    value: {
      targetRole: input.targetRole,
      targetRoleKey: input.targetRoleKey,
      companyContext: input.companyContext,
      profileRevision: input.profileRevision,
      market,
    },
  };
}

/**
 * 市场资料是否「可用」：必须 available 且至少有一条 requirement。
 * 空 requirement 视同无资料（不假装精确）。
 */
export function isMarketDataAvailable(market: MarketRequirementInput): boolean {
  return market.available && market.requirements.length > 0;
}

/**
 * builder 侧强制：无市场资料时把 severity 压成 UNKNOWN。
 * 与 gap-strength.ts parser 的 market-unknown 校验对称——产出侧先压，
 * 校验侧再拦，双保险。
 */
export function coerceGapSeverityForMarket(
  gap: GapItem,
  marketDataAvailable: boolean,
): GapItem {
  if (marketDataAvailable || gap.severity === 'UNKNOWN') return gap;
  const unknown: GapSeverity = 'UNKNOWN';
  return { ...gap, severity: unknown };
}

/** 批量应用到一组 gap。 */
export function coerceGapsForMarket(
  gaps: readonly GapItem[],
  marketDataAvailable: boolean,
): readonly GapItem[] {
  return gaps.map((g) => coerceGapSeverityForMarket(g, marketDataAvailable));
}

// ── S4 · Q1 Profile 输入（confirmed collections，与 T3 对齐的口径）──────────

/**
 * 技能条目。selfRatedLevel 是用户自评（有就给，没有 null）；
 * 自评只是 Q1 聚合的输入之一，不直接当 candidateLevel 用。
 */
export type ProfileSkillItem = {
  /** confirmed collection 的稳定引用 id（evidence 指针，不含原文）。 */
  readonly profileRef: string;
  readonly name: string;
  /** 用户是否已确认。derived StrengthTag 只能引用 confirmed 条目。 */
  readonly confirmed: boolean;
  readonly selfRatedLevel: OrdinalLevel | null;
};

/** experiences / projects / achievements 共用形状：一段已结构化的摘要。 */
export type ProfileNarrativeItem = {
  readonly profileRef: string;
  readonly summary: string;
  readonly confirmed: boolean;
};

export type ProfileCourseItem = {
  readonly profileRef: string;
  readonly name: string;
  readonly confirmed: boolean;
};

export type ProfileEducationItem = {
  readonly profileRef: string;
  readonly summary: string;
  readonly confirmed: boolean;
  readonly courses: readonly ProfileCourseItem[];
};

/**
 * Q1 的 Profile 输入：五类 confirmed collection + 所依据的 revision。
 * 只收结构化条目与稳定引用，绝不收简历原文（Data-L1 边界）。
 */
export type PlannerProfileInput = {
  readonly profileRevision: DecimalString;
  readonly skills: readonly ProfileSkillItem[];
  readonly experiences: readonly ProfileNarrativeItem[];
  readonly projects: readonly ProfileNarrativeItem[];
  readonly achievements: readonly ProfileNarrativeItem[];
  readonly educations: readonly ProfileEducationItem[];
};

export const PLANNER_PROFILE_ERROR_CODES = ['PLANNER_PROFILE_MALFORMED'] as const;
export type PlannerProfileErrorCode = (typeof PLANNER_PROFILE_ERROR_CODES)[number];

export type PlannerProfileParseResult =
  | { readonly ok: true; readonly value: PlannerProfileInput }
  | { readonly ok: false; readonly code: PlannerProfileErrorCode };

const ORDINAL_LEVELS: readonly OrdinalLevel[] = [0, 1, 2, 3, 4];

const isOrdinalLevel = (v: unknown): v is OrdinalLevel =>
  typeof v === 'number' && (ORDINAL_LEVELS as readonly number[]).includes(v);

const isNonEmptyString = (v: unknown): v is string =>
  isString(v) && v.trim().length > 0;

const parseSkillItem = (v: unknown): ProfileSkillItem | null => {
  if (!isRecord(v) || !exactKeys(v, ['profileRef', 'name', 'confirmed', 'selfRatedLevel'])) return null;
  if (!isNonEmptyString(v.profileRef) || !isNonEmptyString(v.name)) return null;
  if (typeof v.confirmed !== 'boolean') return null;
  if (!(v.selfRatedLevel === null || isOrdinalLevel(v.selfRatedLevel))) return null;
  return { profileRef: v.profileRef, name: v.name, confirmed: v.confirmed, selfRatedLevel: v.selfRatedLevel };
};

const parseNarrativeItem = (v: unknown): ProfileNarrativeItem | null => {
  if (!isRecord(v) || !exactKeys(v, ['profileRef', 'summary', 'confirmed'])) return null;
  if (!isNonEmptyString(v.profileRef) || !isString(v.summary)) return null;
  if (typeof v.confirmed !== 'boolean') return null;
  return { profileRef: v.profileRef, summary: v.summary, confirmed: v.confirmed };
};

const parseCourseItem = (v: unknown): ProfileCourseItem | null => {
  if (!isRecord(v) || !exactKeys(v, ['profileRef', 'name', 'confirmed'])) return null;
  if (!isNonEmptyString(v.profileRef) || !isNonEmptyString(v.name)) return null;
  if (typeof v.confirmed !== 'boolean') return null;
  return { profileRef: v.profileRef, name: v.name, confirmed: v.confirmed };
};

const parseEducationItem = (v: unknown): ProfileEducationItem | null => {
  if (!isRecord(v) || !exactKeys(v, ['profileRef', 'summary', 'confirmed', 'courses'])) return null;
  if (!isNonEmptyString(v.profileRef) || !isString(v.summary)) return null;
  if (typeof v.confirmed !== 'boolean') return null;
  if (!Array.isArray(v.courses)) return null;
  const courses: ProfileCourseItem[] = [];
  for (const c of v.courses) {
    const parsed = parseCourseItem(c);
    if (parsed === null) return null;
    courses.push(parsed);
  }
  return { profileRef: v.profileRef, summary: v.summary, confirmed: v.confirmed, courses };
};

const parseAll = <T>(v: unknown, parse: (item: unknown) => T | null): readonly T[] | null => {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
};

/** 帧级 fail-closed：任何一条不合形状即整帧拒收（与本文件其余 parser 同纪律）。 */
export function parsePlannerProfileInput(input: unknown): PlannerProfileParseResult {
  const malformed = { ok: false, code: 'PLANNER_PROFILE_MALFORMED' } as const;
  if (!isRecord(input)) return malformed;
  if (!exactKeys(input, ['profileRevision', 'skills', 'experiences', 'projects', 'achievements', 'educations'])) {
    return malformed;
  }
  if (!isDecimalString(input.profileRevision)) return malformed;
  const skills = parseAll(input.skills, parseSkillItem);
  const experiences = parseAll(input.experiences, parseNarrativeItem);
  const projects = parseAll(input.projects, parseNarrativeItem);
  const achievements = parseAll(input.achievements, parseNarrativeItem);
  const educations = parseAll(input.educations, parseEducationItem);
  if (!skills || !experiences || !projects || !achievements || !educations) return malformed;
  return {
    ok: true,
    value: { profileRevision: input.profileRevision, skills, experiences, projects, achievements, educations },
  };
}

/**
 * 全部 confirmed 条目的 profileRef 集合（含 education 的 courses）。
 * derived StrengthTag 的 evidence.profileRef 必须落在这个集合里。
 */
export function confirmedProfileRefs(profile: PlannerProfileInput): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const s of profile.skills) if (s.confirmed) refs.add(s.profileRef);
  for (const group of [profile.experiences, profile.projects, profile.achievements]) {
    for (const item of group) if (item.confirmed) refs.add(item.profileRef);
  }
  for (const e of profile.educations) {
    if (e.confirmed) refs.add(e.profileRef);
    for (const c of e.courses) if (c.confirmed) refs.add(c.profileRef);
  }
  return refs;
}

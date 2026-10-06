/**
 * T5 · 岗位→技能库（人工整理，可换源）——2026-08-25 领导裁定「做一个市场统计技能表，
 * 自建或接现成的先 review 实时性与可靠性再定」后的落地形状。
 *
 * 为什么需要它：T5 的输入只有 **Profile + 目标岗位名称**（见 PlannerInput，无 JD）。
 * 因此「这个岗位要什么技能、要到什么水平」必须另有来源。本文件定义那个来源的
 * **契约与完整性规则**，内容（哪些岗位、哪些技能）是数据，存在消费侧、可替换。
 *
 * 两件事在这里合流，且**刻意分开建模**：
 *   - `SkillTaxonomyEntry`：技能**词典**（id / 别名 / 分类 / 补齐方式）。变化慢，
 *     看重覆盖面与稳定性；将来若接 ESCO／O*NET，替换的是这部分。
 *   - `RoleRequirementEntry`：岗位**要求**（要哪些技能、到几级、必备还是加分）。
 *     变化快，看重实时性；将来若接 scraper 市场统计，替换的是这部分。
 *   两者用同一套 `skillId` 对齐，所以可以各自独立换源而不互相牵动。
 *
 * 铁律对接：库里查不到该岗位 → 返回 null → 上游 `marketDataAvailable=false`
 * → 所有 severity 为 UNKNOWN。**绝不因为“有个库”就对未收录岗位假装精确**
 * （T5 验收：无市场数据时标 unknown）。
 */

import type { SkillCategory } from './gap-strength.ts';
import type { OrdinalLevel, RemediationType, SkillImportance } from './gap-strength-engine.ts';
import { REMEDIATION_TYPES, SKILL_IMPORTANCES } from './gap-strength-engine.ts';
import { SKILL_CATEGORIES } from './gap-strength.ts';
import { normalizeTargetRoleKey } from './gap-strength-input.ts';

/** 数据出处。CURATED=人工整理；其余为将来换源预留，语义不同不可混用。 */
export const REQUIREMENT_SOURCES = ['CURATED', 'MARKET_AGGREGATE', 'EXTERNAL_TAXONOMY'] as const;
export type RequirementSource = (typeof REQUIREMENT_SOURCES)[number];

/** 技能词典条目。aliases 用于把自由文本对齐到 skillId（"Postgres" → sql）。 */
export type SkillTaxonomyEntry = {
  readonly skillId: string;
  readonly label: string;
  /** 同义词／拼写变体，大小写与首尾空白不敏感；不得跨技能重复。 */
  readonly aliases: readonly string[];
  readonly category: SkillCategory;
  /** 默认补齐方式，决定推荐动作（见 selectRecommendedActionKind）。 */
  readonly remediationType: RemediationType;
};

/** 岗位对某技能的要求。 */
export type RoleSkillRequirement = {
  readonly skillId: string;
  readonly requiredLevel: OrdinalLevel;
  readonly importance: SkillImportance;
};

/** 一个岗位的完整要求集合。roleKey 必须是 roleTitle 的归一化结果。 */
export type RoleRequirementEntry = {
  readonly roleKey: string;
  readonly roleTitle: string;
  readonly requirements: readonly RoleSkillRequirement[];
};

/**
 * 一份可校验的库。版本号进缓存键：库一改，旧报告即失效重算
 * （与 promptVersion／modelVersion 同等地位，见 gapStrengthCacheKey）。
 */
export type SkillRequirementLibrary = {
  readonly libraryVersion: string;
  readonly source: RequirementSource;
  readonly skills: readonly SkillTaxonomyEntry[];
  readonly roles: readonly RoleRequirementEntry[];
};

/**
 * 完整性错误码。人工维护的库会腐化——这些码就是防腐层，
 * 每一条都对应一种「改数据时最容易犯的错」。
 */
export const SKILL_LIBRARY_ERROR_CODES = [
  'SKILL_LIBRARY_MALFORMED',
  /** 两个词典条目用了同一个 skillId。 */
  'SKILL_LIBRARY_DUPLICATE_SKILL',
  /** 同一个别名指向不同技能，对齐会二义。 */
  'SKILL_LIBRARY_ALIAS_COLLISION',
  /** 两个岗位条目用了同一个 roleKey。 */
  'SKILL_LIBRARY_DUPLICATE_ROLE',
  /** roleKey 不是 roleTitle 的归一化结果。 */
  'SKILL_LIBRARY_ROLE_KEY_MISMATCH',
  /** 岗位引用了词典里不存在的 skillId（悬空引用）。 */
  'SKILL_LIBRARY_UNKNOWN_SKILL_REF',
  /** 同一岗位内重复要求同一技能。 */
  'SKILL_LIBRARY_DUPLICATE_REQUIREMENT',
] as const;
export type SkillLibraryErrorCode = (typeof SKILL_LIBRARY_ERROR_CODES)[number];

export type SkillLibraryParseResult =
  | { readonly ok: true; readonly value: SkillRequirementLibrary }
  | { readonly ok: false; readonly code: SkillLibraryErrorCode };

// ── 内部校验小工具（与本包其余 parser 同纪律：多一个键整帧拒收）──────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === 'string';

const isNonEmptyString = (v: unknown): v is string => isString(v) && v.trim().length > 0;

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

const ORDINAL_LEVELS: readonly OrdinalLevel[] = [0, 1, 2, 3, 4];
const isOrdinalLevel = (v: unknown): v is OrdinalLevel =>
  typeof v === 'number' && (ORDINAL_LEVELS as readonly number[]).includes(v);

/** 别名比较键：大小写与首尾／内部多余空白不敏感。 */
export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, ' ');
}

const parseSkillEntry = (v: unknown): SkillTaxonomyEntry | null => {
  if (!isRecord(v) || !exactKeys(v, ['skillId', 'label', 'aliases', 'category', 'remediationType'])) {
    return null;
  }
  if (!isNonEmptyString(v.skillId) || !isNonEmptyString(v.label)) return null;
  if (!Array.isArray(v.aliases) || !v.aliases.every(isNonEmptyString)) return null;
  if (!inSet(v.category, SKILL_CATEGORIES)) return null;
  if (!inSet(v.remediationType, REMEDIATION_TYPES)) return null;
  return {
    skillId: v.skillId,
    label: v.label,
    aliases: v.aliases as readonly string[],
    category: v.category,
    remediationType: v.remediationType,
  };
};

const parseRequirement = (v: unknown): RoleSkillRequirement | null => {
  if (!isRecord(v) || !exactKeys(v, ['skillId', 'requiredLevel', 'importance'])) return null;
  if (!isNonEmptyString(v.skillId)) return null;
  if (!isOrdinalLevel(v.requiredLevel)) return null;
  if (!inSet(v.importance, SKILL_IMPORTANCES)) return null;
  return { skillId: v.skillId, requiredLevel: v.requiredLevel, importance: v.importance };
};

const parseRoleEntry = (v: unknown): RoleRequirementEntry | null => {
  if (!isRecord(v) || !exactKeys(v, ['roleKey', 'roleTitle', 'requirements'])) return null;
  if (!isNonEmptyString(v.roleKey) || !isNonEmptyString(v.roleTitle)) return null;
  if (!Array.isArray(v.requirements)) return null;
  const requirements: RoleSkillRequirement[] = [];
  for (const item of v.requirements) {
    const parsed = parseRequirement(item);
    if (parsed === null) return null;
    requirements.push(parsed);
  }
  return { roleKey: v.roleKey, roleTitle: v.roleTitle, requirements };
};

/**
 * 解析并校验一份库。形状 + **跨条目完整性**都过才算 ok：
 * 悬空 skillId、别名二义、roleKey 与标题不一致等，都在这里 fail closed，
 * 不留到运行时才发现。
 */
export function parseSkillRequirementLibrary(input: unknown): SkillLibraryParseResult {
  const fail = (code: SkillLibraryErrorCode) => ({ ok: false, code }) as const;
  if (!isRecord(input) || !exactKeys(input, ['libraryVersion', 'source', 'skills', 'roles'])) {
    return fail('SKILL_LIBRARY_MALFORMED');
  }
  if (!isNonEmptyString(input.libraryVersion)) return fail('SKILL_LIBRARY_MALFORMED');
  if (!inSet(input.source, REQUIREMENT_SOURCES)) return fail('SKILL_LIBRARY_MALFORMED');
  if (!Array.isArray(input.skills) || !Array.isArray(input.roles)) {
    return fail('SKILL_LIBRARY_MALFORMED');
  }

  const skills: SkillTaxonomyEntry[] = [];
  const skillIds = new Set<string>();
  const aliasOwner = new Map<string, string>();
  for (const raw of input.skills) {
    const entry = parseSkillEntry(raw);
    if (entry === null) return fail('SKILL_LIBRARY_MALFORMED');
    if (skillIds.has(entry.skillId)) return fail('SKILL_LIBRARY_DUPLICATE_SKILL');
    skillIds.add(entry.skillId);
    // 技能自身的 label 与 id 也参与别名占位，避免「A 的 label 是 B 的 alias」这类二义。
    for (const alias of [entry.skillId, entry.label, ...entry.aliases]) {
      const key = normalizeAlias(alias);
      const owner = aliasOwner.get(key);
      if (owner !== undefined && owner !== entry.skillId) return fail('SKILL_LIBRARY_ALIAS_COLLISION');
      aliasOwner.set(key, entry.skillId);
    }
    skills.push(entry);
  }

  const roles: RoleRequirementEntry[] = [];
  const roleKeys = new Set<string>();
  for (const raw of input.roles) {
    const entry = parseRoleEntry(raw);
    if (entry === null) return fail('SKILL_LIBRARY_MALFORMED');
    if (roleKeys.has(entry.roleKey)) return fail('SKILL_LIBRARY_DUPLICATE_ROLE');
    if (entry.roleKey !== normalizeTargetRoleKey(entry.roleTitle)) {
      return fail('SKILL_LIBRARY_ROLE_KEY_MISMATCH');
    }
    roleKeys.add(entry.roleKey);
    const seen = new Set<string>();
    for (const requirement of entry.requirements) {
      if (!skillIds.has(requirement.skillId)) return fail('SKILL_LIBRARY_UNKNOWN_SKILL_REF');
      if (seen.has(requirement.skillId)) return fail('SKILL_LIBRARY_DUPLICATE_REQUIREMENT');
      seen.add(requirement.skillId);
    }
    roles.push(entry);
  }

  return {
    ok: true,
    value: { libraryVersion: input.libraryVersion, source: input.source, skills, roles },
  };
}

// ── 查询（全部纯函数，无 LLM）────────────────────────────────────────

/**
 * 岗位名称 → 要求集合。**查不到返回 null**，调用方据此把
 * marketDataAvailable 置 false，让 severity 落到 UNKNOWN。
 * 入参可以是用户原文（内部归一化），无需调用方先处理。
 */
export function lookupRoleRequirements(
  library: SkillRequirementLibrary,
  targetRole: string,
): readonly RoleSkillRequirement[] | null {
  const key = normalizeTargetRoleKey(targetRole);
  const entry = library.roles.find((role) => role.roleKey === key);
  return entry ? entry.requirements : null;
}

/** 自由文本 → skillId（走别名表）；对不齐返回 null，不猜。 */
export function resolveSkillId(library: SkillRequirementLibrary, text: string): string | null {
  const key = normalizeAlias(text);
  for (const skill of library.skills) {
    if (normalizeAlias(skill.skillId) === key || normalizeAlias(skill.label) === key) return skill.skillId;
    if (skill.aliases.some((alias) => normalizeAlias(alias) === key)) return skill.skillId;
  }
  return null;
}

/** skillId → 展示与决策元信息；未收录返回 null。 */
export function skillMetaFor(
  library: SkillRequirementLibrary,
  skillId: string,
): { readonly label: string; readonly category: SkillCategory; readonly remediationType: RemediationType } | null {
  const skill = library.skills.find((entry) => entry.skillId === skillId);
  return skill ? { label: skill.label, category: skill.category, remediationType: skill.remediationType } : null;
}

/** 库收录了哪些岗位（用于 UI 提示可选目标，或运营盘点覆盖面）。 */
export function coveredRoleTitles(library: SkillRequirementLibrary): readonly string[] {
  return library.roles.map((role) => role.roleTitle);
}

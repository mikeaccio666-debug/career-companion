import type { GapItem, GapSeverity, GapStrengthReport } from './gap-strength.ts';
import { rankLearningCourses } from './learning-course-ranking.ts';

export const LEARNING_COVERAGE_STATUSES = [
  'SUPPORTED',
  'PARTIAL',
  'NO_COURSE',
  'ROLE_MODEL_MISSING',
] as const;
export type LearningCoverageStatus = (typeof LEARNING_COVERAGE_STATUSES)[number];

export const LEARNING_COURSE_DEPTHS = ['FOUNDATION', 'PRACTICE', 'PORTFOLIO'] as const;
export type LearningCourseDepth = (typeof LEARNING_COURSE_DEPTHS)[number];

export type LearningCourseSkill = {
  readonly skillId: string;
  readonly depth: LearningCourseDepth;
};

/** Persisted in LearningProjectTemplate.cardMetadata.gapRecommendation. */
export type LearningCourseRecommendationMetadata = {
  readonly schemaVersion: 1;
  readonly catalogVersion: string;
  readonly roleKeys: readonly string[];
  readonly skills: readonly LearningCourseSkill[];
  readonly evidenceOutputs: readonly string[];
};

/** Runtime row after joining persisted metadata with the existing Learning template identity. */
export type LearningCourseCatalogItem = LearningCourseRecommendationMetadata & {
  readonly projectKey: string;
  readonly title: string;
  readonly summary: string | null;
  readonly difficulty: number;
};

export type LearningCourseRecommendation = {
  readonly projectKey: string;
  readonly title: string;
  readonly summary: string | null;
  readonly difficulty: number;
  readonly matchedGapIds: readonly string[];
  readonly matchedSkillIds: readonly string[];
  readonly evidenceOutputs: readonly string[];
};

export const LEARNING_UNCOVERED_REASONS = ['NO_MATCHING_COURSE', 'ROLE_MODEL_MISSING'] as const;
export type LearningUncoveredReason = (typeof LEARNING_UNCOVERED_REASONS)[number];

export type LearningUncoveredGap = {
  readonly gapId: string;
  readonly skillId: string;
  readonly skill: string;
  readonly severity: GapSeverity;
  readonly reason: LearningUncoveredReason;
};

export type LearningRecommendationResponse = {
  readonly schemaVersion: 1;
  readonly targetRoleKey: string;
  readonly gapReportRevision: number;
  readonly catalogVersion: string;
  readonly coverageStatus: LearningCoverageStatus;
  readonly recommendations: readonly LearningCourseRecommendation[];
  readonly uncoveredGaps: readonly LearningUncoveredGap[];
};

export const LEARNING_RECOMMENDATION_ERROR_CODES = [
  'LEARNING_COURSE_CATALOG_MALFORMED',
  'LEARNING_RECOMMENDATION_MALFORMED',
] as const;
export type LearningRecommendationErrorCode = (typeof LEARNING_RECOMMENDATION_ERROR_CODES)[number];

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: LearningRecommendationErrorCode };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const inSet = <T extends string>(value: unknown, set: readonly T[]): value is T =>
  typeof value === 'string' && (set as readonly string[]).includes(value);

function parseSkill(value: unknown): LearningCourseSkill | null {
  if (!isRecord(value) || !exactKeys(value, ['skillId', 'depth'])) return null;
  if (!isNonEmptyString(value.skillId) || !inSet(value.depth, LEARNING_COURSE_DEPTHS)) return null;
  return { skillId: value.skillId, depth: value.depth };
}

function parseMetadata(value: unknown): LearningCourseRecommendationMetadata | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'catalogVersion', 'roleKeys', 'skills', 'evidenceOutputs',
  ])) return null;
  if (value.schemaVersion !== 1 || !isNonEmptyString(value.catalogVersion)) return null;
  if (!Array.isArray(value.roleKeys) || !value.roleKeys.every(isNonEmptyString)) return null;
  if (!Array.isArray(value.skills) || !Array.isArray(value.evidenceOutputs)) return null;
  if (!value.evidenceOutputs.every(isNonEmptyString)) return null;
  const skills: LearningCourseSkill[] = [];
  const skillIds = new Set<string>();
  for (const raw of value.skills) {
    const skill = parseSkill(raw);
    if (!skill || skillIds.has(skill.skillId)) return null;
    skillIds.add(skill.skillId);
    skills.push(skill);
  }
  if (skills.length === 0) return null;
  return {
    schemaVersion: 1,
    catalogVersion: value.catalogVersion,
    roleKeys: value.roleKeys,
    skills,
    evidenceOutputs: value.evidenceOutputs as readonly string[],
  };
}

export function parseLearningCourseRecommendationMetadata(
  value: unknown,
): ParseResult<LearningCourseRecommendationMetadata> {
  const parsed = parseMetadata(value);
  return parsed
    ? { ok: true, value: parsed }
    : { ok: false, code: 'LEARNING_COURSE_CATALOG_MALFORMED' };
}

export function parseLearningCourseCatalogItem(value: unknown): ParseResult<LearningCourseCatalogItem> {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'catalogVersion', 'projectKey', 'title', 'summary', 'difficulty',
    'roleKeys', 'skills', 'evidenceOutputs',
  ])) return { ok: false, code: 'LEARNING_COURSE_CATALOG_MALFORMED' };
  const metadata = parseMetadata({
    schemaVersion: value.schemaVersion,
    catalogVersion: value.catalogVersion,
    roleKeys: value.roleKeys,
    skills: value.skills,
    evidenceOutputs: value.evidenceOutputs,
  });
  if (!metadata || !isNonEmptyString(value.projectKey) || !isNonEmptyString(value.title)) {
    return { ok: false, code: 'LEARNING_COURSE_CATALOG_MALFORMED' };
  }
  if (!(value.summary === null || typeof value.summary === 'string')) {
    return { ok: false, code: 'LEARNING_COURSE_CATALOG_MALFORMED' };
  }
  if (!Number.isInteger(value.difficulty) || (value.difficulty as number) < 1 || (value.difficulty as number) > 5) {
    return { ok: false, code: 'LEARNING_COURSE_CATALOG_MALFORMED' };
  }
  return {
    ok: true,
    value: {
      ...metadata,
      projectKey: value.projectKey,
      title: value.title,
      summary: value.summary,
      difficulty: value.difficulty as number,
    },
  };
}

function skillIdFromGap(gap: GapItem): string | null {
  return gap.id.startsWith('gap_') && gap.id.length > 4 ? gap.id.slice(4) : null;
}

export function buildLearningRecommendation(input: {
  readonly report: GapStrengthReport;
  readonly catalog: readonly LearningCourseCatalogItem[];
}): LearningRecommendationResponse {
  const catalogVersion = input.catalog[0]?.catalogVersion ?? 'unavailable';
  const knownGaps = input.report.gaps.flatMap((gap) => {
    const skillId = skillIdFromGap(gap);
    return skillId ? [{ gap, skillId }] : [];
  });
  if (!input.report.marketDataAvailable) {
    return {
      schemaVersion: 1,
      targetRoleKey: input.report.targetRoleKey,
      gapReportRevision: input.report.revision,
      catalogVersion,
      coverageStatus: 'ROLE_MODEL_MISSING',
      recommendations: [],
      uncoveredGaps: knownGaps.map(({ gap, skillId }) => uncovered(gap, skillId, 'ROLE_MODEL_MISSING')),
    };
  }

  const recommendations = rankLearningCourses({
    targetRoleKey: input.report.targetRoleKey,
    gaps: knownGaps.map(({ gap, skillId }) => ({ gapIds: [gap.id], skillId, severity: gap.severity })),
    catalog: input.catalog,
  }).slice(0, 3);
  // v1 intentionally retains coverage over the selected three, unlike v2.
  const covered = new Set(recommendations.flatMap(({ matchedSkillIds }) => matchedSkillIds));
  const uncoveredGaps = knownGaps
    .filter(({ skillId }) => !covered.has(skillId))
    .map(({ gap, skillId }) => uncovered(gap, skillId, 'NO_MATCHING_COURSE'));
  const coverageStatus: LearningCoverageStatus = recommendations.length === 0
    ? 'NO_COURSE'
    : uncoveredGaps.length === 0 ? 'SUPPORTED' : 'PARTIAL';
  return {
    schemaVersion: 1,
    targetRoleKey: input.report.targetRoleKey,
    gapReportRevision: input.report.revision,
    catalogVersion,
    coverageStatus,
    recommendations,
    uncoveredGaps,
  };
}

function uncovered(
  gap: GapItem,
  skillId: string,
  reason: LearningUncoveredReason,
): LearningUncoveredGap {
  return { gapId: gap.id, skillId, skill: gap.skill, severity: gap.severity, reason };
}

export function parseLearningCourseRecommendation(value: unknown): LearningCourseRecommendation | null {
  if (!isRecord(value) || !exactKeys(value, [
    'projectKey', 'title', 'summary', 'difficulty', 'matchedGapIds', 'matchedSkillIds', 'evidenceOutputs',
  ])) return null;
  if (!isNonEmptyString(value.projectKey) || !isNonEmptyString(value.title)) return null;
  if (!(value.summary === null || typeof value.summary === 'string')) return null;
  if (!Number.isInteger(value.difficulty) || (value.difficulty as number) < 1 || (value.difficulty as number) > 5) return null;
  for (const key of ['matchedGapIds', 'matchedSkillIds', 'evidenceOutputs'] as const) {
    if (!Array.isArray(value[key]) || !value[key].every(isNonEmptyString)) return null;
  }
  return value as LearningCourseRecommendation;
}

function parseUncoveredGap(value: unknown): LearningUncoveredGap | null {
  if (!isRecord(value) || !exactKeys(value, ['gapId', 'skillId', 'skill', 'severity', 'reason'])) return null;
  if (!isNonEmptyString(value.gapId) || !isNonEmptyString(value.skillId) || !isNonEmptyString(value.skill)) return null;
  const severities = ['CRITICAL', 'MAJOR', 'MINOR', 'UNKNOWN'] as const;
  if (!inSet(value.severity, severities) || !inSet(value.reason, LEARNING_UNCOVERED_REASONS)) return null;
  return value as LearningUncoveredGap;
}

export function parseLearningRecommendationResponse(value: unknown): ParseResult<LearningRecommendationResponse> {
  const fail = () => ({ ok: false, code: 'LEARNING_RECOMMENDATION_MALFORMED' }) as const;
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'targetRoleKey', 'gapReportRevision', 'catalogVersion',
    'coverageStatus', 'recommendations', 'uncoveredGaps',
  ])) return fail();
  if (value.schemaVersion !== 1 || !isNonEmptyString(value.targetRoleKey) || !isNonEmptyString(value.catalogVersion)) return fail();
  if (!Number.isInteger(value.gapReportRevision) || (value.gapReportRevision as number) < 0) return fail();
  if (!inSet(value.coverageStatus, LEARNING_COVERAGE_STATUSES)) return fail();
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 3 || !Array.isArray(value.uncoveredGaps)) return fail();
  const recommendations = value.recommendations.map(parseLearningCourseRecommendation);
  const uncoveredGaps = value.uncoveredGaps.map(parseUncoveredGap);
  if (recommendations.some((item) => item === null) || uncoveredGaps.some((item) => item === null)) return fail();
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      targetRoleKey: value.targetRoleKey,
      gapReportRevision: value.gapReportRevision as number,
      catalogVersion: value.catalogVersion,
      coverageStatus: value.coverageStatus,
      recommendations: recommendations as LearningCourseRecommendation[],
      uncoveredGaps: uncoveredGaps as LearningUncoveredGap[],
    },
  };
}

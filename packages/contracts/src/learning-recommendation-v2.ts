import type { DecimalString } from './common.ts';
import { parseGapAnalysisReportV2, type GapAnalysisReportV2 } from './gap-analysis-v2.ts';
import type { GapSeverity } from './gap-strength.ts';
import { LEARNING_SEVERITY_WEIGHT, rankLearningCourses, type LearningRankGap } from './learning-course-ranking.ts';
import {
  parseLearningCourseCatalogItem,
  parseLearningCourseRecommendation,
  type LearningCourseCatalogItem,
  type LearningCourseRecommendation,
} from './learning-recommendation.ts';
import { parseSkillRequirementLibrary, resolveSkillId, type SkillRequirementLibrary } from './skill-library.ts';

export const LEARNING_MAPPING_POLICY_VERSION = 'gap-v2-exact-taxonomy@1';
export const LEARNING_V2_UNCOVERED_REASONS = ['SKILL_MAPPING_MISSING', 'NO_MATCHING_COURSE'] as const;
export type LearningRecommendationRequestV2 = Readonly<{
  conversationId: string;
  reportId: string;
  expectedReportRevision: DecimalString;
}>;
export type LearningSourceReportV2 = Readonly<{
  reportId: string;
  conversationId: string;
  conversationRevision: DecimalString;
  revision: DecimalString;
}>;
export type LearningUncoveredGapV2 = Readonly<{
  gapId: string;
  skillId: string | null;
  skill: string;
  severity: GapSeverity;
  reason: (typeof LEARNING_V2_UNCOVERED_REASONS)[number];
}>;
export type LearningRecommendationResponseV2 = Readonly<{
  schemaVersion: 2;
  sourceReport: LearningSourceReportV2;
  targetRoleKey: string;
  catalogVersion: string;
  taxonomyVersion: string;
  mappingPolicyVersion: string;
  /** A ranked subset of up to three courses, not the complete catalog coverage. */
  recommendations: readonly LearningCourseRecommendation[];
  /** Gaps unmapped or not covered anywhere in the eligible published catalog. */
  uncoveredGaps: readonly LearningUncoveredGapV2[];
}>;
export const LEARNING_RECOMMENDATION_V2_ERROR_CODES = ['LEARNING_RECOMMENDATION_V2_MALFORMED'] as const;
type Result = Readonly<{ ok: true; value: LearningRecommendationResponseV2 }>
  | Readonly<{ ok: false; code: (typeof LEARNING_RECOMMENDATION_V2_ERROR_CODES)[number] }>;
const fail = (): Result => ({ ok: false, code: 'LEARNING_RECOMMENDATION_V2_MALFORMED' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isRevision = (value: unknown): value is DecimalString => typeof value === 'string' && DECIMAL.test(value);
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export function parseLearningRecommendationRequestV2(value: unknown): LearningRecommendationRequestV2 | null {
  if (!isRecord(value) || !exactKeys(value, ['conversationId', 'reportId', 'expectedReportRevision'])
    || !isUuid(value.conversationId) || !isUuid(value.reportId) || !isRevision(value.expectedReportRevision)) return null;
  return { conversationId: value.conversationId, reportId: value.reportId, expectedReportRevision: value.expectedReportRevision };
}

export function learningSourceReportV2(report: GapAnalysisReportV2): LearningSourceReportV2 {
  return { reportId: report.reportId, conversationId: report.conversation.id,
    conversationRevision: report.conversation.revision, revision: report.revision };
}

export function learningRecommendationMatchesReportV2(
  value: LearningRecommendationResponseV2,
  report: GapAnalysisReportV2,
): boolean {
  const source = value.sourceReport;
  return source.reportId === report.reportId && source.revision === report.revision
    && source.conversationId === report.conversation.id && source.conversationRevision === report.conversation.revision
    && value.targetRoleKey === report.conversation.targetRoleKey;
}

export function buildLearningRecommendationV2(input: Readonly<{
  report: GapAnalysisReportV2;
  catalog: readonly LearningCourseCatalogItem[];
  library: SkillRequirementLibrary;
}>): Result {
  const parsedReport = parseGapAnalysisReportV2(input.report);
  const parsedLibrary = parseSkillRequirementLibrary(input.library);
  if (!parsedReport.ok || !parsedLibrary.ok) return fail();
  const report = parsedReport.value;
  const library = parsedLibrary.value;
  const skills = new Map(library.skills.map((skill) => [skill.skillId, skill]));
  if (input.catalog.some((course) => !parseLearningCourseCatalogItem(course).ok
    || course.skills.some(({ skillId }) => !skills.has(skillId)))
    || !unique(input.catalog.map(({ projectKey }) => projectKey))
    || new Set(input.catalog.map(({ catalogVersion }) => catalogVersion)).size > 1) return fail();

  const grouped = new Map<string, LearningRankGap>();
  const mapped = report.assessment.gaps.map((gap) => {
    const candidateId = resolveSkillId(library, gap.requirement);
    const skillId = candidateId && skills.get(candidateId)?.category === gap.category ? candidateId : null;
    if (skillId !== null) {
      const previous = grouped.get(skillId);
      grouped.set(skillId, {
        gapIds: [...previous?.gapIds ?? [], gap.id], skillId,
        severity: previous && LEARNING_SEVERITY_WEIGHT[previous.severity] > LEARNING_SEVERITY_WEIGHT[gap.severity]
          ? previous.severity : gap.severity,
      });
    }
    return { gap, skillId };
  });
  const ranked = rankLearningCourses({ targetRoleKey: report.conversation.targetRoleKey, gaps: [...grouped.values()], catalog: input.catalog });
  const covered = new Set(ranked.flatMap(({ matchedSkillIds }) => matchedSkillIds));
  return parseLearningRecommendationResponseV2({
    schemaVersion: 2,
    sourceReport: learningSourceReportV2(report),
    targetRoleKey: report.conversation.targetRoleKey,
    catalogVersion: input.catalog[0]?.catalogVersion ?? 'unavailable',
    taxonomyVersion: library.libraryVersion,
    mappingPolicyVersion: LEARNING_MAPPING_POLICY_VERSION,
    recommendations: ranked.slice(0, 3),
    uncoveredGaps: mapped.filter(({ skillId }) => skillId === null || !covered.has(skillId))
      .map(({ gap, skillId }): LearningUncoveredGapV2 => ({
        gapId: gap.id, skillId, skill: gap.requirement, severity: gap.severity,
        reason: skillId === null ? 'SKILL_MAPPING_MISSING' : 'NO_MATCHING_COURSE',
      })),
  });
}

export function parseLearningRecommendationResponseV2(value: unknown): Result {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'sourceReport', 'targetRoleKey', 'catalogVersion',
    'taxonomyVersion', 'mappingPolicyVersion', 'recommendations', 'uncoveredGaps']) || value.schemaVersion !== 2) return fail();
  const source = value.sourceReport;
  if (!isRecord(source) || !exactKeys(source, ['reportId', 'conversationId', 'conversationRevision', 'revision'])
    || !isUuid(source.reportId) || !isUuid(source.conversationId) || !isRevision(source.conversationRevision)
    || !isRevision(source.revision)) return fail();
  if (![value.targetRoleKey, value.catalogVersion, value.taxonomyVersion, value.mappingPolicyVersion].every(isText)
    || !Array.isArray(value.recommendations) || value.recommendations.length > 3
    || !Array.isArray(value.uncoveredGaps) || value.uncoveredGaps.length > 30) return fail();
  const recommendations: LearningCourseRecommendation[] = [];
  for (const raw of value.recommendations) {
    const parsed = parseLearningCourseRecommendation(raw);
    if (!parsed || parsed.matchedGapIds.length === 0 || parsed.matchedGapIds.length > 30
      || parsed.matchedSkillIds.length === 0 || parsed.matchedSkillIds.length > 30
      || !unique(parsed.matchedGapIds) || !unique(parsed.matchedSkillIds)) return fail();
    recommendations.push(parsed);
  }
  if (!unique(recommendations.map(({ projectKey }) => projectKey))) return fail();
  const uncoveredGaps: LearningUncoveredGapV2[] = [];
  for (const gap of value.uncoveredGaps) {
    if (!isRecord(gap) || !exactKeys(gap, ['gapId', 'skillId', 'skill', 'severity', 'reason'])
      || !isText(gap.gapId) || !isText(gap.skill)
      || !['CRITICAL', 'MAJOR', 'MINOR'].includes(String(gap.severity))) return fail();
    if (gap.reason === 'SKILL_MAPPING_MISSING' ? gap.skillId !== null
      : gap.reason !== 'NO_MATCHING_COURSE' || !isText(gap.skillId)) return fail();
    if (recommendations.some(({ matchedGapIds }) => matchedGapIds.includes(gap.gapId as string))) return fail();
    uncoveredGaps.push(gap as LearningUncoveredGapV2);
  }
  if (!unique(uncoveredGaps.map(({ gapId }) => gapId))) return fail();
  return { ok: true, value: {
    schemaVersion: 2,
    sourceReport: { reportId: source.reportId, conversationId: source.conversationId,
      conversationRevision: source.conversationRevision, revision: source.revision },
    targetRoleKey: value.targetRoleKey as string, catalogVersion: value.catalogVersion as string,
    taxonomyVersion: value.taxonomyVersion as string, mappingPolicyVersion: value.mappingPolicyVersion as string,
    recommendations, uncoveredGaps,
  } };
}

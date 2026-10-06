import type { GapSeverity } from './gap-strength.ts';
import type {
  LearningCourseCatalogItem,
  LearningCourseDepth,
  LearningCourseRecommendation,
} from './learning-recommendation.ts';

export type LearningRankGap = Readonly<{
  gapIds: readonly string[];
  skillId: string;
  severity: GapSeverity;
}>;

export const LEARNING_SEVERITY_WEIGHT: Readonly<Record<GapSeverity, number>> = {
  UNKNOWN: 0, MINOR: 1, MAJOR: 2, CRITICAL: 3,
};
const DEPTH_WEIGHT: Readonly<Record<LearningCourseDepth, number>> = {
  FOUNDATION: 1, PRACTICE: 2, PORTFOLIO: 3,
};

/** Input adapters own gap grouping and coverage semantics; ranking is shared. */
export function rankLearningCourses(input: Readonly<{
  targetRoleKey: string;
  gaps: readonly LearningRankGap[];
  catalog: readonly LearningCourseCatalogItem[];
}>): readonly LearningCourseRecommendation[] {
  return input.catalog.flatMap((course) => {
    if (!course.roleKeys.includes(input.targetRoleKey)) return [];
    const skills = new Map(course.skills.map((skill) => [skill.skillId, skill.depth]));
    const matches = input.gaps.filter(({ skillId }) => skills.has(skillId));
    if (matches.length === 0) return [];
    const score = matches.reduce((sum, { severity, skillId }) =>
      sum + LEARNING_SEVERITY_WEIGHT[severity] * 10 + DEPTH_WEIGHT[skills.get(skillId)!], 0);
    return [{ course, matches, score }];
  }).sort((left, right) => right.score - left.score || left.course.projectKey.localeCompare(right.course.projectKey))
    .map(({ course, matches }) => ({
      projectKey: course.projectKey,
      title: course.title,
      summary: course.summary,
      difficulty: course.difficulty,
      matchedGapIds: matches.flatMap(({ gapIds }) => gapIds),
      matchedSkillIds: matches.map(({ skillId }) => skillId),
      evidenceOutputs: course.evidenceOutputs,
    }));
}

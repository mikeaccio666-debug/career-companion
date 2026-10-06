import { describe, expect, it } from 'vitest';
import {
  GAP_ANALYSIS_FACTOR_KINDS,
  buildLearningRecommendationV2,
  parseLearningRecommendationRequestV2,
  parseLearningRecommendationResponseV2,
  type GapAnalysisGapV2,
  type GapAnalysisReportV2,
  type LearningCourseCatalogItem,
  type SkillRequirementLibrary,
} from '../src/index.ts';

const library: SkillRequirementLibrary = {
  libraryVersion: 'test-taxonomy@1', source: 'CURATED', roles: [],
  skills: ['SQL', 'Python', 'Statistics', 'Tableau'].map((label) => ({
    skillId: label.toLowerCase(), label, aliases: label === 'SQL' ? ['Postgres'] : [],
    category: 'HARD', remediationType: 'COURSE_SKILL',
  })),
};
const gap = (id: string, requirement: string, severity: 'CRITICAL' | 'MAJOR' | 'MINOR' = 'MAJOR'): GapAnalysisGapV2 => ({
  id, requirement, category: 'HARD', currentLevel: 0,
  requiredLevel: severity === 'CRITICAL' ? 3 : severity === 'MAJOR' ? 2 : 1, severity,
  explanation: 'Evidence is missing.', evidenceRefs: [],
  factors: GAP_ANALYSIS_FACTOR_KINDS.map((kind) => ({
    kind, signal: 'UNKNOWN', explanation: 'Not evidenced.', evidenceRefs: [],
  })),
  recommendedAction: { kind: 'COURSE', reasonCode: 'SKILL_NOT_DEMONSTRATED', detail: 'Practice this skill.' },
});
const report = (gaps: readonly GapAnalysisGapV2[]): GapAnalysisReportV2 => ({
  schemaVersion: 2,
  reportId: '11111111-1111-4111-8111-111111111111',
  analysisRunId: '22222222-2222-4222-8222-222222222222',
  revision: '9007199254740993',
  conversation: {
    id: '33333333-3333-4333-8333-333333333333', revision: '3',
    targetRole: 'Data Analyst', targetRoleKey: 'data analyst',
  },
  inputs: {
    profileRevision: '7', resume: null, strengthRevision: '1',
    roleRequirementSnapshotId: '55555555-5555-4555-8555-555555555555',
  },
  assessment: { summary: 'Evidence-grounded gaps.', confidence: 'LOW', gaps, strengths: [] },
  provenance: {
    promptVersion: 'test-prompt', model: 'test-model',
    assessmentPolicyVersion: 'gap-assessment-policy@2', scoringPolicyVersion: 'gap-scoring-policy@2',
    generatedAt: '2026-09-08T00:00:00.000Z',
  },
});
const course = (skillId: string, projectKey = skillId): LearningCourseCatalogItem => ({
  schemaVersion: 1, catalogVersion: 'test-catalog@1', projectKey, title: projectKey,
  summary: null, difficulty: 2, roleKeys: ['data analyst'],
  skills: [{ skillId, depth: 'PORTFOLIO' }], evidenceOutputs: ['Project evidence'],
});
const build = (gaps: readonly GapAnalysisGapV2[], catalog = [course('sql')]) => {
  const result = buildLearningRecommendationV2({ report: report(gaps), catalog, library });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
};

describe('Learning v2 exact report and taxonomy projection', () => {
  it('matches the requirement label/alias, never the generated requirement or gap id', () => {
    const result = build([
      gap('gap_arbitrary_model_id', '  pOsTgReS  '),
      gap('gap_sql', 'Synthetic unrecognized skill'),
      { ...gap('gap_wrong_category', 'SQL'), category: 'SOFT' },
    ]);
    expect(result.recommendations[0]?.matchedGapIds).toEqual(['gap_arbitrary_model_id']);
    expect(result.uncoveredGaps.map(({ gapId, skillId, reason }) => ({ gapId, skillId, reason }))).toEqual([
      { gapId: 'gap_sql', skillId: null, reason: 'SKILL_MAPPING_MISSING' },
      { gapId: 'gap_wrong_category', skillId: null, reason: 'SKILL_MAPPING_MISSING' },
    ]);
    expect(result.sourceReport.revision).toBe('9007199254740993');
    expect(result.taxonomyVersion).toBe(library.libraryVersion);
    expect(parseLearningRecommendationResponseV2(result)).toEqual({ ok: true, value: result });
  });

  it('counts each skill severity and course depth once while retaining every original gap explanation link', () => {
    const result = build([
      gap('gap_sql_one', 'SQL', 'MAJOR'), gap('gap_sql_two', 'Postgres', 'MINOR'),
      gap('gap_python', 'Python', 'CRITICAL'),
    ], [course('sql'), course('python')]);
    expect(result.recommendations.map(({ projectKey }) => projectKey)).toEqual(['python', 'sql']);
    expect(result.recommendations[1]?.matchedGapIds).toEqual(['gap_sql_one', 'gap_sql_two']);
    expect(result.recommendations[1]?.matchedSkillIds).toEqual(['sql']);
  });

  it('computes coverage over the full eligible catalog, independently from the top-three display limit', () => {
    const skills = ['SQL', 'Python', 'Statistics', 'Tableau'];
    const result = build(skills.map((label) => gap(`gap_${label}`, label)), skills.map((label) => course(label.toLowerCase())));
    expect(result.recommendations).toHaveLength(3);
    expect(result.uncoveredGaps).toEqual([]);
    expect(result.recommendations.map(({ projectKey }) => projectKey)).toEqual(['python', 'sql', 'statistics']);
    const wrongRole = build([gap('gap_sql', 'SQL')], [{ ...course('sql'), roleKeys: ['unrelated role'] }]);
    expect(wrongRole.recommendations).toEqual([]);
    expect(wrongRole.uncoveredGaps[0]).toMatchObject({ skillId: 'sql', reason: 'NO_MATCHING_COURSE' });
  });

  it('rejects an invalid/colliding taxonomy and inconsistent catalog rather than choosing a mapping', () => {
    const inputs = { report: report([gap('gap_sql', 'SQL')]), catalog: [course('sql')], library };
    expect(buildLearningRecommendationV2({
      ...inputs, library: { ...library, skills: [...library.skills, { ...library.skills[1]!, aliases: ['SQL'] }] },
    }).ok).toBe(false);
    expect(buildLearningRecommendationV2({ ...inputs, catalog: [course('sql'), { ...course('python'), catalogVersion: 'other' }] }).ok).toBe(false);
  });

  it('accepts only an exact source-report request and preserves decimal revisions', () => {
    const input = { conversationId: report([]).conversation.id, reportId: report([]).reportId, expectedReportRevision: '9007199254740993' };
    expect(parseLearningRecommendationRequestV2(input)).toEqual(input);
    for (const bad of [
      { ...input, expectedReportRevision: 4 }, { ...input, expectedReportRevision: '01' },
      { ...input, targetRole: 'Data Analyst' }, { ...input, conversationId: 'wrong' },
    ]) expect(parseLearningRecommendationRequestV2(bad)).toBeNull();
    const response = build([gap('gap_sql', 'SQL')]);
    expect(parseLearningRecommendationResponseV2({ ...response, sourceReport: { ...response.sourceReport, revision: 7 } }).ok).toBe(false);
    expect(parseLearningRecommendationResponseV2({ ...response, recommendations: [...response.recommendations, ...response.recommendations] }).ok).toBe(false);
    expect(parseLearningRecommendationResponseV2({ ...response, uncoveredGaps: [{ gapId: 'gap_x', skillId: 'sql', skill: 'SQL', severity: 'MAJOR', reason: 'SKILL_MAPPING_MISSING' }] }).ok).toBe(false);
  });
});

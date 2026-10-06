import { describe, expect, it } from 'vitest';
import {
  buildLearningRecommendation,
  parseLearningCourseCatalogItem,
  parseLearningRecommendationResponse,
  type GapStrengthReport,
  type LearningCourseCatalogItem,
} from '../src/index.ts';

const report = (marketDataAvailable = true): GapStrengthReport => ({
  schemaVersion: 1,
  revision: 7,
  targetRoleKey: 'data analyst',
  profileRevision: '3',
  marketDataAvailable,
  careerDirection: { targetRole: 'Data Analyst', companyContext: null, tiers: [] },
  gaps: [
    {
      id: 'gap_sql', skill: 'SQL', category: 'HARD', currentLevel: 'C+', severity: marketDataAvailable ? 'CRITICAL' : 'UNKNOWN',
      evidence: [], recommendedAction: { kind: 'COURSE', detail: 'Practice SQL' },
    },
    {
      id: 'gap_bi-tool', skill: 'BI 工具', category: 'HARD', currentLevel: 'C', severity: marketDataAvailable ? 'MAJOR' : 'UNKNOWN',
      evidence: [], recommendedAction: { kind: 'COURSE', detail: 'Build dashboards' },
    },
  ],
  strengths: [],
  generatedAt: '2026-09-01T00:00:00.000Z',
});

const course = (overrides: Partial<LearningCourseCatalogItem> = {}): LearningCourseCatalogItem => ({
  schemaVersion: 1,
  catalogVersion: '2026-09-01',
  projectKey: 'ecommerce-metrics-agent',
  title: '电商指标问答 Agent',
  summary: '按统一指标口径回答业务问题。',
  difficulty: 2,
  roleKeys: ['data analyst', 'business intelligence analyst'],
  skills: [{ skillId: 'sql', depth: 'PORTFOLIO' }],
  evidenceOutputs: ['可运行的指标问答工具', '评测集'],
  ...overrides,
});

describe('learning recommendation contract', () => {
  it('strictly parses persisted course recommendation metadata', () => {
    expect(parseLearningCourseCatalogItem(course()).ok).toBe(true);
    expect(parseLearningCourseCatalogItem({ ...course(), surprise: true })).toEqual({
      ok: false,
      code: 'LEARNING_COURSE_CATALOG_MALFORMED',
    });
  });

  it('matches stable gap skill ids, ranks deterministically, and reports uncovered gaps', () => {
    const result = buildLearningRecommendation({
      report: report(),
      catalog: [
        course(),
        course({
          projectKey: 'sql-foundations', title: 'SQL Foundations',
          roleKeys: ['data analyst'], skills: [{ skillId: 'sql', depth: 'FOUNDATION' }],
        }),
        course({
          projectKey: 'fuzzy-title-only', title: 'BI and SQL in the title',
          roleKeys: ['data analyst'], skills: [{ skillId: 'python-data', depth: 'PORTFOLIO' }],
        }),
      ],
    });

    expect(result.coverageStatus).toBe('PARTIAL');
    expect(result.recommendations.map((item) => item.projectKey)).toEqual([
      'ecommerce-metrics-agent',
      'sql-foundations',
    ]);
    expect(result.recommendations[0]?.matchedGapIds).toEqual(['gap_sql']);
    expect(result.uncoveredGaps).toEqual([
      { gapId: 'gap_bi-tool', skillId: 'bi-tool', skill: 'BI 工具', severity: 'MAJOR', reason: 'NO_MATCHING_COURSE' },
    ]);
    expect(parseLearningRecommendationResponse(result).ok).toBe(true);
  });

  it('caps recommendations at three with a stable project-key tie break', () => {
    const result = buildLearningRecommendation({
      report: { ...report(), gaps: [report().gaps[0]!] },
      catalog: ['d', 'b', 'a', 'c'].map((key) => course({ projectKey: key, title: key })),
    });
    expect(result.recommendations.map((item) => item.projectKey)).toEqual(['a', 'b', 'c']);
  });

  it('fails closed when the role model is unavailable instead of guessing courses', () => {
    const result = buildLearningRecommendation({ report: report(false), catalog: [course()] });
    expect(result.coverageStatus).toBe('ROLE_MODEL_MISSING');
    expect(result.recommendations).toEqual([]);
    expect(result.uncoveredGaps.every((gap) => gap.reason === 'ROLE_MODEL_MISSING')).toBe(true);
  });

  it('does not use a course that names the role but covers none of its stable gap skills', () => {
    const result = buildLearningRecommendation({
      report: report(),
      catalog: [course({ skills: [{ skillId: 'python-data', depth: 'PORTFOLIO' }] })],
    });
    expect(result.coverageStatus).toBe('NO_COURSE');
    expect(result.recommendations).toEqual([]);
  });
});

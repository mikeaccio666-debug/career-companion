import { describe, expect, it } from 'vitest';
import {
  parseGapAnalysisReportV2,
  parseGapAnalysisResponseV2,
  type GapAnalysisReportV2,
} from '../src/gap-analysis-v2.ts';

const REPORT: GapAnalysisReportV2 = {
  schemaVersion: 2,
  reportId: '11111111-1111-4111-8111-111111111111',
  analysisRunId: '22222222-2222-4222-8222-222222222222',
  revision: '1',
  conversation: {
    id: '33333333-3333-4333-8333-333333333333',
    revision: '3',
    targetRole: 'Data Analyst',
    targetRoleKey: 'data analyst',
  },
  inputs: {
    profileRevision: '7',
    resume: {
      versionId: '44444444-4444-4444-8444-444444444444',
      contentRevision: 2,
      contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      structuredHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    strengthRevision: '1',
    roleRequirementSnapshotId: '55555555-5555-4555-8555-555555555555',
  },
  assessment: {
    summary: 'The candidate demonstrates analysis fundamentals but needs stronger delivery evidence.',
    confidence: 'MEDIUM',
    gaps: [
      {
        id: 'gap_sql_delivery',
        requirement: 'Deliver production-grade SQL analysis',
        category: 'HARD',
        currentLevel: 2,
        requiredLevel: 3,
        severity: 'MINOR',
        explanation: 'SQL is listed, but repeated delivery and measurable impact are not yet evidenced.',
        evidenceRefs: ['profile-v2/skills/sql'],
        factors: [
          {
            kind: 'EVIDENCE_STRENGTH',
            signal: 'WEAK',
            explanation: 'One confirmed skill reference exists without a linked outcome.',
            evidenceRefs: ['profile-v2/skills/sql'],
          },
          {
            kind: 'FREQUENCY',
            signal: 'UNKNOWN',
            explanation: 'Usage frequency was not provided.',
            evidenceRefs: [],
          },
          ...(['DURATION', 'RECENCY', 'PROJECT_COMPLEXITY', 'QUANTIFIED_OUTCOMES', 'SELF_RATING'] as const).map((kind) => ({
            kind, signal: 'UNKNOWN' as const, explanation: `${kind} was not provided.`, evidenceRefs: [],
          })),
        ],
        recommendedAction: {
          kind: 'PROJECT',
          reasonCode: 'EVIDENCE_MISSING',
          detail: 'Build one scoped SQL analysis project with a measurable result.',
        },
      },
    ],
    strengths: [],
  },
  provenance: {
    promptVersion: 'gap-analysis-v2@1',
    model: 'gpt-4.1-mini',
    assessmentPolicyVersion: 'gap-assessment-policy@1',
    scoringPolicyVersion: 'gap-scoring-policy@1',
    generatedAt: '2026-09-01T20:00:00.000Z',
  },
};

describe('Gap Analysis v2 contract', () => {
  it('accepts an explainable report bound to conversation, Profile and parsed Resume revisions', () => {
    expect(parseGapAnalysisReportV2(REPORT)).toEqual({ ok: true, value: REPORT });
  });

  it('requires at least Profile or parsed Resume evidence', () => {
    const invalid = {
      ...REPORT,
      inputs: { ...REPORT.inputs, profileRevision: null, resume: null },
    };
    expect(parseGapAnalysisReportV2(invalid)).toEqual({
      ok: false,
      code: 'GAP_ANALYSIS_EVIDENCE_REQUIRED',
    });
  });

  it('rejects LLM evidence refs outside the immutable input allowlist', () => {
    const parsed = parseGapAnalysisReportV2(REPORT, {
      evidenceRefs: new Set(['profile-v2/projects/project-1']),
    });
    expect(parsed).toEqual({ ok: false, code: 'GAP_ANALYSIS_EVIDENCE_REF_INVALID' });
  });

  it('allows mock interview only when interview evidence grounds the recommendation', () => {
    const gap = REPORT.assessment.gaps[0]!;
    const invalid = {
      ...REPORT,
      assessment: {
        ...REPORT.assessment,
        gaps: [{
          ...gap,
          recommendedAction: {
            kind: 'MOCK_INTERVIEW',
            reasonCode: 'INTERVIEW_ARTICULATION_WEAK',
            detail: 'Practice explaining this skill.',
          },
        }],
      },
    };
    expect(parseGapAnalysisReportV2(invalid)).toEqual({
      ok: false,
      code: 'GAP_ANALYSIS_ACTION_EVIDENCE_INVALID',
    });
  });

  it('represents missing evidence as a stable waiting state rather than a fabricated report', () => {
    expect(parseGapAnalysisResponseV2({
      status: 'WAITING_FOR_EVIDENCE',
      reasonCode: 'PROFILE_OR_READY_RESUME_REQUIRED',
    })).toEqual({
      ok: true,
      value: {
        status: 'WAITING_FOR_EVIDENCE',
        reasonCode: 'PROFILE_OR_READY_RESUME_REQUIRED',
      },
    });
  });

  it('rejects duplicate ids, incomplete factor sets and severity drift', () => {
    expect(parseGapAnalysisReportV2({
      ...REPORT,
      assessment: { ...REPORT.assessment, gaps: [REPORT.assessment.gaps[0]!, REPORT.assessment.gaps[0]!] },
    })).toMatchObject({ ok: false, code: 'GAP_ANALYSIS_MALFORMED' });
    const gap = REPORT.assessment.gaps[0]!;
    expect(parseGapAnalysisReportV2({
      ...REPORT,
      assessment: { ...REPORT.assessment, gaps: [{ ...gap, factors: gap.factors.slice(0, 6) }] },
    })).toMatchObject({ ok: false, code: 'GAP_ANALYSIS_MALFORMED' });
    expect(parseGapAnalysisReportV2({
      ...REPORT,
      assessment: { ...REPORT.assessment, gaps: [{ ...gap, severity: 'MAJOR' }] },
    })).toMatchObject({ ok: false, code: 'GAP_ANALYSIS_MALFORMED' });
  });

  it('rejects arbitrary failure reason strings', () => {
    expect(parseGapAnalysisResponseV2({
      status: 'FAILED_RETRYABLE',
      runId: REPORT.analysisRunId,
      reasonCode: 'anything',
    })).toEqual({ ok: false, code: 'GAP_ANALYSIS_MALFORMED' });
  });
});

const ENRICHED_GAP = {
  ...REPORT.assessment.gaps[0]!,
  skillId: 'sql',
  importance: 'MUST' as const,
  levelDelta: 1,
  diagnosis: 'EVIDENCE_MISSING' as const,
  priorityScore: 3,
  priorityRank: 1,
  recommendedAction: {
    ...REPORT.assessment.gaps[0]!.recommendedAction,
    objective: 'Create portfolio-ready evidence for SQL delivery.',
    steps: ['Define a bounded project that requires SQL delivery.', 'Publish the output and document your contribution.'],
    successEvidence: ['A project artifact that demonstrates SQL delivery and your contribution.'],
  },
};
const ENRICHED: GapAnalysisReportV2 = {
  ...REPORT,
  assessment: {
    summary: REPORT.assessment.summary,
    confidence: REPORT.assessment.confidence,
    readinessScore: 67,
    evidenceCoveragePct: 100,
    topGapIds: ['gap_sql_delivery'],
    actionPlan: {
      firstPriorityGapId: 'gap_sql_delivery',
      items: [{ gapId: 'gap_sql_delivery', sequence: 1, timeframe: 'THIS_WEEK', actionKind: 'PROJECT' }],
    },
    gaps: [ENRICHED_GAP],
    strengths: [],
  },
  provenance: { ...REPORT.provenance, assessmentPolicyVersion: 'gap-assessment-policy@3', scoringPolicyVersion: 'gap-scoring-policy@3' },
};

describe('Gap Analysis v2 contract · policy@3 enrichment', () => {
  it('round-trips readiness, coverage, ranking, the action plan and the enriched action', () => {
    const parsed = parseGapAnalysisReportV2(ENRICHED);
    expect(parsed).toEqual({ ok: true, value: ENRICHED });
  });

  it('keeps accepting immutable reports written before the enrichment', () => {
    expect(parseGapAnalysisReportV2(REPORT)).toEqual({ ok: true, value: REPORT });
  });

  it.each<[string, (report: GapAnalysisReportV2) => unknown]>([
    ['a level delta that disagrees with the levels', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...ENRICHED_GAP, levelDelta: 2 }] } })],
    ['a zero priority score', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...ENRICHED_GAP, priorityScore: 0 }] } })],
    ['an unknown diagnosis', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...ENRICHED_GAP, diagnosis: 'GUESSED' }] } })],
    ['half an enrichment on the gap', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...REPORT.assessment.gaps[0]!, skillId: 'sql' }] } })],
    ['an objective without steps', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...ENRICHED_GAP, recommendedAction: { ...REPORT.assessment.gaps[0]!.recommendedAction, objective: 'x' } }] } })],
    ['empty steps', (r) => ({ ...r, assessment: { ...r.assessment, gaps: [{ ...ENRICHED_GAP, recommendedAction: { ...ENRICHED_GAP.recommendedAction, steps: [] } }] } })],
    ['a readiness score above 100', (r) => ({ ...r, assessment: { ...r.assessment, readinessScore: 101 } })],
    ['a fractional coverage', (r) => ({ ...r, assessment: { ...r.assessment, evidenceCoveragePct: 66.6 } })],
    ['a top gap that is not assessed', (r) => ({ ...r, assessment: { ...r.assessment, topGapIds: ['gap_unknown'] } })],
    ['a plan item for an unassessed gap', (r) => ({ ...r, assessment: { ...r.assessment, actionPlan: { firstPriorityGapId: 'gap_unknown', items: [{ gapId: 'gap_unknown', sequence: 1, timeframe: 'THIS_WEEK', actionKind: 'PROJECT' }] } } })],
    ['a plan that does not start at sequence 1', (r) => ({ ...r, assessment: { ...r.assessment, actionPlan: { firstPriorityGapId: 'gap_sql_delivery', items: [{ gapId: 'gap_sql_delivery', sequence: 2, timeframe: 'THIS_WEEK', actionKind: 'PROJECT' }] } } })],
    ['a first priority that is not the first item', (r) => ({ ...r, assessment: { ...r.assessment, actionPlan: { firstPriorityGapId: null, items: [{ gapId: 'gap_sql_delivery', sequence: 1, timeframe: 'THIS_WEEK', actionKind: 'PROJECT' }] } } })],
    ['an unknown timeframe', (r) => ({ ...r, assessment: { ...r.assessment, actionPlan: { firstPriorityGapId: 'gap_sql_delivery', items: [{ gapId: 'gap_sql_delivery', sequence: 1, timeframe: 'SOMEDAY', actionKind: 'PROJECT' }] } } })],
    ['half an enrichment on the assessment', (r) => ({ ...r, assessment: { summary: r.assessment.summary, confidence: r.assessment.confidence, readinessScore: 67, gaps: r.assessment.gaps, strengths: [] } })],
  ])('rejects %s', (_label, mutate) => {
    expect(parseGapAnalysisReportV2(mutate(ENRICHED))).toEqual({ ok: false, code: 'GAP_ANALYSIS_MALFORMED' });
  });
});

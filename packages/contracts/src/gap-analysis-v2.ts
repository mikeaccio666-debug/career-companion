import type { DecimalString } from './common.ts';
import type { GapSeverity, SkillCategory } from './gap-strength.ts';

export const GAP_ANALYSIS_FACTOR_KINDS = [
  'DURATION',
  'RECENCY',
  'FREQUENCY',
  'PROJECT_COMPLEXITY',
  'QUANTIFIED_OUTCOMES',
  'SELF_RATING',
  'EVIDENCE_STRENGTH',
] as const;
export type GapAnalysisFactorKind = (typeof GAP_ANALYSIS_FACTOR_KINDS)[number];

export const GAP_ANALYSIS_FACTOR_SIGNALS = ['STRONG', 'MODERATE', 'WEAK', 'UNKNOWN'] as const;
export type GapAnalysisFactorSignal = (typeof GAP_ANALYSIS_FACTOR_SIGNALS)[number];

export const GAP_ANALYSIS_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type GapAnalysisConfidence = (typeof GAP_ANALYSIS_CONFIDENCE)[number];

export const GAP_ANALYSIS_ACTION_KINDS = [
  'COURSE',
  'PRACTICE',
  'PROJECT',
  'RESUME_REWRITE',
  'MOCK_INTERVIEW',
] as const;
export type GapAnalysisActionKind = (typeof GAP_ANALYSIS_ACTION_KINDS)[number];

export const GAP_ANALYSIS_ACTION_REASONS = [
  'SKILL_NOT_DEMONSTRATED',
  'NEEDS_REPETITION',
  'EVIDENCE_MISSING',
  'RESUME_VISIBILITY_LOW',
  'INTERVIEW_ARTICULATION_WEAK',
] as const;
export const GAP_ANALYSIS_FAILURE_REASONS = ['GAP_ANALYSIS_GENERATION_INVALID'] as const;
export type GapAnalysisFailureReason = (typeof GAP_ANALYSIS_FAILURE_REASONS)[number];
export type GapAnalysisActionReason = (typeof GAP_ANALYSIS_ACTION_REASONS)[number];

export type GapAnalysisFactorV2 = {
  readonly kind: GapAnalysisFactorKind;
  readonly signal: GapAnalysisFactorSignal;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
};

export type GapAnalysisRecommendedActionV2 = {
  readonly kind: GapAnalysisActionKind;
  readonly reasonCode: GapAnalysisActionReason;
  readonly detail: string;
  /** Present on reports from gap-assessment-policy@3 onwards; absent on immutable earlier reports. */
  readonly objective?: string;
  readonly steps?: readonly string[];
  readonly successEvidence?: readonly string[];
};

export const GAP_ANALYSIS_IMPORTANCE = ['MUST', 'SHOULD', 'NICE'] as const;
export type GapAnalysisImportance = (typeof GAP_ANALYSIS_IMPORTANCE)[number];
export const GAP_ANALYSIS_DIAGNOSES = [
  'CAPABILITY_MISSING',
  'PRACTICE_MISSING',
  'EVIDENCE_MISSING',
  'RESUME_VISIBILITY_LOW',
  'INTERVIEW_ARTICULATION_WEAK',
] as const;
export type GapAnalysisDiagnosis = (typeof GAP_ANALYSIS_DIAGNOSES)[number];
export const GAP_ANALYSIS_TIMEFRAMES = ['THIS_WEEK', 'NEXT_2_WEEKS', 'THIS_MONTH'] as const;
export type GapAnalysisTimeframe = (typeof GAP_ANALYSIS_TIMEFRAMES)[number];

export type GapAnalysisGapV2 = {
  readonly id: string;
  /** The enriched fields exist only on reports from gap-scoring-policy@3 onwards. */
  readonly skillId?: string;
  readonly importance?: GapAnalysisImportance;
  readonly requirement: string;
  readonly category: SkillCategory;
  readonly currentLevel: 0 | 1 | 2 | 3 | 4;
  readonly requiredLevel: 1 | 2 | 3 | 4;
  readonly severity: GapSeverity;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
  readonly factors: readonly GapAnalysisFactorV2[];
  readonly levelDelta?: number;
  readonly diagnosis?: GapAnalysisDiagnosis;
  readonly priorityScore?: number;
  readonly priorityRank?: number;
  readonly recommendedAction: GapAnalysisRecommendedActionV2;
};

export type GapAnalysisActionPlanItemV2 = {
  readonly gapId: string;
  readonly sequence: number;
  readonly timeframe: GapAnalysisTimeframe;
  readonly actionKind: GapAnalysisActionKind;
};

export type GapAnalysisStrengthV2 = {
  readonly id: string;
  readonly label: string;
  readonly category: SkillCategory;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
};

export type GapAnalysisReportV2 = {
  readonly schemaVersion: 2;
  readonly reportId: string;
  readonly analysisRunId: string;
  readonly revision: DecimalString;
  readonly conversation: {
    readonly id: string;
    readonly revision: DecimalString;
    readonly targetRole: string;
    readonly targetRoleKey: string;
  };
  readonly inputs: {
    readonly profileRevision: DecimalString | null;
    readonly resume: null | {
      readonly versionId: string;
      readonly contentRevision: number;
      readonly contentHash: string;
      readonly structuredHash: string;
    };
    readonly strengthRevision: DecimalString;
    readonly roleRequirementSnapshotId: string;
  };
  readonly assessment: {
    readonly summary: string;
    readonly confidence: GapAnalysisConfidence;
    /** Present on reports from gap-scoring-policy@3 onwards; absent on immutable earlier reports. */
    readonly readinessScore?: number;
    readonly evidenceCoveragePct?: number;
    readonly topGapIds?: readonly string[];
    readonly actionPlan?: {
      readonly firstPriorityGapId: string | null;
      readonly items: readonly GapAnalysisActionPlanItemV2[];
    };
    readonly gaps: readonly GapAnalysisGapV2[];
    readonly strengths: readonly GapAnalysisStrengthV2[];
  };
  readonly provenance: {
    readonly promptVersion: string;
    readonly model: string;
    readonly assessmentPolicyVersion: string;
    readonly scoringPolicyVersion: string;
    readonly generatedAt: string;
  };
};

export const GAP_ANALYSIS_ERROR_CODES = [
  'GAP_ANALYSIS_MALFORMED',
  'GAP_ANALYSIS_VERSION_TOO_NEW',
  'GAP_ANALYSIS_EVIDENCE_REQUIRED',
  'GAP_ANALYSIS_EVIDENCE_REF_INVALID',
  'GAP_ANALYSIS_ACTION_EVIDENCE_INVALID',
] as const;
export type GapAnalysisErrorCode = (typeof GAP_ANALYSIS_ERROR_CODES)[number];

export type GapAnalysisParseResult =
  | Readonly<{ ok: true; value: GapAnalysisReportV2 }>
  | Readonly<{ ok: false; code: GapAnalysisErrorCode }>;

export type GapAnalysisResponseV2 =
  | Readonly<{
      status: 'WAITING_FOR_EVIDENCE';
      reasonCode: 'PROFILE_OR_READY_RESUME_REQUIRED';
    }>
  | Readonly<{
      status: 'WAITING_FOR_RESUME_SELECTION';
      reasonCode: 'READY_RESUME_SELECTION_REQUIRED';
    }>
  | Readonly<{ status: 'PENDING' | 'RUNNING'; runId: string }>
  | Readonly<{ status: 'SUCCEEDED'; report: GapAnalysisReportV2 }>
  | Readonly<{
      status: 'FAILED_RETRYABLE' | 'FAILED_FINAL';
      runId: string;
      reasonCode: GapAnalysisFailureReason;
    }>
  | Readonly<{ status: 'STALE'; runId: string; reasonCode: 'INPUT_REVISION_CHANGED' }>;

export type GapAnalysisComputeRequestV2 = Readonly<{
  conversationId: string;
  resumeVersionId?: string;
}>;

export function parseGapAnalysisComputeRequestV2(input: unknown): GapAnalysisComputeRequestV2 | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.length < 1 || keys.length > 2 || keys[0] !== 'conversationId'
    || (keys.length === 2 && keys[1] !== 'resumeVersionId')
    || !isUuid(input.conversationId)
    || !(input.resumeVersionId === undefined || isUuid(input.resumeVersionId))) return null;
  return input.resumeVersionId === undefined
    ? { conversationId: input.conversationId }
    : { conversationId: input.conversationId, resumeVersionId: input.resumeVersionId };
}

export type GapAnalysisResponseParseResult =
  | Readonly<{ ok: true; value: GapAnalysisResponseV2 }>
  | Readonly<{ ok: false; code: GapAnalysisErrorCode }>;

type ParseOptions = Readonly<{ evidenceRefs?: ReadonlySet<string> }>;
type RecordValue = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: RecordValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000;
const inSet = <T extends string>(value: unknown, set: readonly T[]): value is T =>
  typeof value === 'string' && (set as readonly string[]).includes(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isDecimal = (value: unknown): value is DecimalString =>
  typeof value === 'string' && DECIMAL.test(value);
const isLevel = (value: unknown, minimum: number): value is 0 | 1 | 2 | 3 | 4 =>
  Number.isInteger(value) && typeof value === 'number' && value >= minimum && value <= 4;
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseRefs(value: unknown, options: ParseOptions): readonly string[] | GapAnalysisErrorCode {
  if (!Array.isArray(value) || !value.every(isString)) return 'GAP_ANALYSIS_MALFORMED';
  const refs = [...new Set(value)];
  if (refs.length !== value.length) return 'GAP_ANALYSIS_MALFORMED';
  if (options.evidenceRefs && refs.some((ref) => !options.evidenceRefs!.has(ref))) {
    return 'GAP_ANALYSIS_EVIDENCE_REF_INVALID';
  }
  return refs;
}

function parseFactor(value: unknown, options: ParseOptions): GapAnalysisFactorV2 | GapAnalysisErrorCode {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'signal', 'explanation', 'evidenceRefs'])) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  if (!inSet(value.kind, GAP_ANALYSIS_FACTOR_KINDS)
    || !inSet(value.signal, GAP_ANALYSIS_FACTOR_SIGNALS)
    || !isString(value.explanation)) return 'GAP_ANALYSIS_MALFORMED';
  const evidenceRefs = parseRefs(value.evidenceRefs, options);
  if (typeof evidenceRefs === 'string') return evidenceRefs;
  if (value.signal === 'UNKNOWN' && evidenceRefs.length > 0) return 'GAP_ANALYSIS_MALFORMED';
  if (value.signal !== 'UNKNOWN' && evidenceRefs.length === 0) return 'GAP_ANALYSIS_EVIDENCE_REF_INVALID';
  if (value.kind === 'SELF_RATING' && value.signal !== 'UNKNOWN'
    && !evidenceRefs.some((ref) => ref.startsWith('self-rating/'))) {
    return 'GAP_ANALYSIS_EVIDENCE_REF_INVALID';
  }
  return { kind: value.kind, signal: value.signal, explanation: value.explanation, evidenceRefs };
}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every(isString);

function parseAction(value: unknown): GapAnalysisRecommendedActionV2 | null {
  if (!isRecord(value)) return null;
  const enriched = Object.hasOwn(value, 'objective');
  if (!exactKeys(value, enriched
    ? ['kind', 'reasonCode', 'detail', 'objective', 'steps', 'successEvidence']
    : ['kind', 'reasonCode', 'detail'])) return null;
  if (!inSet(value.kind, GAP_ANALYSIS_ACTION_KINDS)
    || !inSet(value.reasonCode, GAP_ANALYSIS_ACTION_REASONS)
    || !isString(value.detail)) return null;
  if (enriched && (!isString(value.objective) || !isStringList(value.steps) || !isStringList(value.successEvidence))) {
    return null;
  }
  const allowed: Readonly<Record<GapAnalysisActionKind, readonly GapAnalysisActionReason[]>> = {
    COURSE: ['SKILL_NOT_DEMONSTRATED'],
    PRACTICE: ['SKILL_NOT_DEMONSTRATED', 'NEEDS_REPETITION'],
    PROJECT: ['EVIDENCE_MISSING', 'NEEDS_REPETITION'],
    RESUME_REWRITE: ['RESUME_VISIBILITY_LOW'],
    MOCK_INTERVIEW: ['INTERVIEW_ARTICULATION_WEAK'],
  };
  if (!allowed[value.kind].includes(value.reasonCode)) return null;
  return {
    kind: value.kind,
    reasonCode: value.reasonCode,
    detail: value.detail,
    ...(enriched ? {
      objective: value.objective as string,
      steps: [...(value.steps as readonly string[])],
      successEvidence: [...(value.successEvidence as readonly string[])],
    } : {}),
  };
}

const GAP_KEYS = [
  'id', 'requirement', 'category', 'currentLevel', 'requiredLevel', 'severity',
  'explanation', 'evidenceRefs', 'factors', 'recommendedAction',
] as const;
const ENRICHED_GAP_KEYS = [
  'id', 'skillId', 'importance', 'requirement', 'category', 'currentLevel', 'requiredLevel',
  'severity', 'explanation', 'evidenceRefs', 'factors', 'levelDelta', 'diagnosis',
  'priorityScore', 'priorityRank', 'recommendedAction',
] as const;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function parseGap(value: unknown, options: ParseOptions): GapAnalysisGapV2 | GapAnalysisErrorCode {
  if (!isRecord(value)) return 'GAP_ANALYSIS_MALFORMED';
  const enriched = Object.hasOwn(value, 'skillId');
  if (!exactKeys(value, enriched ? ENRICHED_GAP_KEYS : GAP_KEYS)) return 'GAP_ANALYSIS_MALFORMED';
  if (!isString(value.id) || !isString(value.requirement)
    || !inSet(value.category, ['SOFT', 'HARD', 'BACKGROUND'] as const)
    || !isLevel(value.currentLevel, 0) || !isLevel(value.requiredLevel, 1)
    || !inSet(value.severity, ['CRITICAL', 'MAJOR', 'MINOR', 'UNKNOWN'] as const)
    || !isString(value.explanation) || !Array.isArray(value.factors)) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  if (enriched && (!isString(value.skillId)
    || !inSet(value.importance, GAP_ANALYSIS_IMPORTANCE)
    || !inSet(value.diagnosis, GAP_ANALYSIS_DIAGNOSES)
    || value.levelDelta !== value.requiredLevel - value.currentLevel
    || !isPositiveInteger(value.priorityScore) || !isPositiveInteger(value.priorityRank))) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  const evidenceRefs = parseRefs(value.evidenceRefs, options);
  if (typeof evidenceRefs === 'string') return evidenceRefs;
  const factors: GapAnalysisFactorV2[] = [];
  for (const candidate of value.factors) {
    const factor = parseFactor(candidate, options);
    if (typeof factor === 'string') return factor;
    factors.push(factor);
  }
  if (factors.length !== GAP_ANALYSIS_FACTOR_KINDS.length
    || new Set(factors.map((factor) => factor.kind)).size !== GAP_ANALYSIS_FACTOR_KINDS.length
    || GAP_ANALYSIS_FACTOR_KINDS.some((kind) => !factors.some((factor) => factor.kind === kind))) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  if (value.currentLevel >= value.requiredLevel
    || value.severity !== severityForLevels(value.currentLevel, value.requiredLevel)) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  const action = parseAction(value.recommendedAction);
  if (!action) return 'GAP_ANALYSIS_MALFORMED';
  const allRefs = new Set([...evidenceRefs, ...factors.flatMap((factor) => factor.evidenceRefs)]);
  if (action.kind === 'MOCK_INTERVIEW' && ![...allRefs].some((ref) => ref.startsWith('interview/'))) {
    return 'GAP_ANALYSIS_ACTION_EVIDENCE_INVALID';
  }
  if (action.kind === 'RESUME_REWRITE' && ![...allRefs].some((ref) => ref.startsWith('resume-structured/'))) {
    return 'GAP_ANALYSIS_ACTION_EVIDENCE_INVALID';
  }
  return {
    id: value.id,
    ...(enriched ? { skillId: value.skillId as string, importance: value.importance as GapAnalysisImportance } : {}),
    requirement: value.requirement,
    category: value.category,
    currentLevel: value.currentLevel,
    requiredLevel: value.requiredLevel as 1 | 2 | 3 | 4,
    severity: value.severity,
    explanation: value.explanation,
    evidenceRefs,
    factors,
    ...(enriched ? {
      levelDelta: value.levelDelta as number,
      diagnosis: value.diagnosis as GapAnalysisDiagnosis,
      priorityScore: value.priorityScore as number,
      priorityRank: value.priorityRank as number,
    } : {}),
    recommendedAction: action,
  };
}

function parseStrength(value: unknown, options: ParseOptions): GapAnalysisStrengthV2 | GapAnalysisErrorCode {
  if (!isRecord(value) || !exactKeys(value, ['id', 'label', 'category', 'explanation', 'evidenceRefs'])
    || !isString(value.id) || !isString(value.label) || !isString(value.explanation)
    || !inSet(value.category, ['SOFT', 'HARD', 'BACKGROUND'] as const)) {
    return 'GAP_ANALYSIS_MALFORMED';
  }
  const evidenceRefs = parseRefs(value.evidenceRefs, options);
  if (typeof evidenceRefs === 'string') return evidenceRefs;
  if (evidenceRefs.length === 0) return 'GAP_ANALYSIS_EVIDENCE_REF_INVALID';
  return { id: value.id, label: value.label, category: value.category, explanation: value.explanation, evidenceRefs };
}

const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100;

/** The plan may only reference assessed gaps, in a dense 1-based sequence, and must lead with its first item. */
function parseActionPlan(
  topGapIds: readonly string[],
  plan: RecordValue,
  gaps: readonly GapAnalysisGapV2[],
): GapAnalysisReportV2['assessment']['actionPlan'] | null {
  const gapIds = new Set(gaps.map((gap) => gap.id));
  if (new Set(topGapIds).size !== topGapIds.length || topGapIds.some((id) => !gapIds.has(id))) return null;
  const items: GapAnalysisActionPlanItemV2[] = [];
  for (const candidate of plan.items as unknown[]) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['gapId', 'sequence', 'timeframe', 'actionKind'])
      || !isString(candidate.gapId) || !gapIds.has(candidate.gapId)
      || !isPositiveInteger(candidate.sequence)
      || !inSet(candidate.timeframe, GAP_ANALYSIS_TIMEFRAMES)
      || !inSet(candidate.actionKind, GAP_ANALYSIS_ACTION_KINDS)) return null;
    items.push({ gapId: candidate.gapId, sequence: candidate.sequence, timeframe: candidate.timeframe, actionKind: candidate.actionKind });
  }
  if (items.some((item, index) => item.sequence !== index + 1)
    || new Set(items.map((item) => item.gapId)).size !== items.length
    || plan.firstPriorityGapId !== (items[0]?.gapId ?? null)) return null;
  return { firstPriorityGapId: plan.firstPriorityGapId as string | null, items };
}

export function parseGapAnalysisReportV2(input: unknown, options: ParseOptions = {}): GapAnalysisParseResult {
  if (!isRecord(input)) return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  if (typeof input.schemaVersion === 'number' && input.schemaVersion > 2) {
    return { ok: false, code: 'GAP_ANALYSIS_VERSION_TOO_NEW' };
  }
  if (!exactKeys(input, ['schemaVersion', 'reportId', 'analysisRunId', 'revision', 'conversation', 'inputs', 'assessment', 'provenance'])
    || input.schemaVersion !== 2 || !isUuid(input.reportId) || !isUuid(input.analysisRunId) || !isDecimal(input.revision)
    || !isRecord(input.conversation) || !isRecord(input.inputs)
    || !isRecord(input.assessment) || !isRecord(input.provenance)) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  const conversation = input.conversation;
  if (!exactKeys(conversation, ['id', 'revision', 'targetRole', 'targetRoleKey'])
    || !isUuid(conversation.id) || !isDecimal(conversation.revision)
    || !isString(conversation.targetRole) || !isString(conversation.targetRoleKey)) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  const inputs = input.inputs;
  if (!exactKeys(inputs, ['profileRevision', 'resume', 'strengthRevision', 'roleRequirementSnapshotId'])
    || !(inputs.profileRevision === null || isDecimal(inputs.profileRevision))
    || !isDecimal(inputs.strengthRevision) || !isUuid(inputs.roleRequirementSnapshotId)) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  let resume: GapAnalysisReportV2['inputs']['resume'] = null;
  if (inputs.resume !== null) {
    if (!isRecord(inputs.resume)
      || !exactKeys(inputs.resume, ['versionId', 'contentRevision', 'contentHash', 'structuredHash'])
      || !isUuid(inputs.resume.versionId) || !Number.isSafeInteger(inputs.resume.contentRevision)
      || (inputs.resume.contentRevision as number) < 0
      || typeof inputs.resume.contentHash !== 'string' || !SHA256.test(inputs.resume.contentHash)
      || typeof inputs.resume.structuredHash !== 'string' || !SHA256.test(inputs.resume.structuredHash)) {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    resume = {
      versionId: inputs.resume.versionId,
      contentRevision: inputs.resume.contentRevision as number,
      contentHash: inputs.resume.contentHash,
      structuredHash: inputs.resume.structuredHash,
    };
  }
  if (inputs.profileRevision === null && resume === null) {
    return { ok: false, code: 'GAP_ANALYSIS_EVIDENCE_REQUIRED' };
  }
  const assessment = input.assessment;
  const enrichedAssessment = Object.hasOwn(assessment, 'readinessScore');
  if (!exactKeys(assessment, enrichedAssessment
    ? ['summary', 'confidence', 'readinessScore', 'evidenceCoveragePct', 'topGapIds', 'actionPlan', 'gaps', 'strengths']
    : ['summary', 'confidence', 'gaps', 'strengths'])
    || !isString(assessment.summary) || !inSet(assessment.confidence, GAP_ANALYSIS_CONFIDENCE)
    || !Array.isArray(assessment.gaps) || !Array.isArray(assessment.strengths)) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  if (enrichedAssessment && (!isPercent(assessment.readinessScore) || !isPercent(assessment.evidenceCoveragePct)
    || !Array.isArray(assessment.topGapIds) || !assessment.topGapIds.every(isString)
    || !isRecord(assessment.actionPlan) || !exactKeys(assessment.actionPlan, ['firstPriorityGapId', 'items'])
    || !(assessment.actionPlan.firstPriorityGapId === null || isString(assessment.actionPlan.firstPriorityGapId))
    || !Array.isArray(assessment.actionPlan.items))) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  const gaps: GapAnalysisGapV2[] = [];
  for (const candidate of assessment.gaps) {
    const gap = parseGap(candidate, options);
    if (typeof gap === 'string') return { ok: false, code: gap };
    gaps.push(gap);
  }
  if (new Set(gaps.map((gap) => gap.id)).size !== gaps.length) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  let actionPlan: GapAnalysisReportV2['assessment']['actionPlan'];
  if (enrichedAssessment) {
    const parsed = parseActionPlan(assessment.topGapIds as readonly string[], assessment.actionPlan as RecordValue, gaps);
    if (!parsed) return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    actionPlan = parsed;
  }
  const strengths: GapAnalysisStrengthV2[] = [];
  for (const candidate of assessment.strengths) {
    const strength = parseStrength(candidate, options);
    if (typeof strength === 'string') return { ok: false, code: strength };
    strengths.push(strength);
  }
  if (new Set(strengths.map((strength) => strength.id)).size !== strengths.length) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  const provenance = input.provenance;
  if (!exactKeys(provenance, ['promptVersion', 'model', 'assessmentPolicyVersion', 'scoringPolicyVersion', 'generatedAt'])
    || !isString(provenance.promptVersion) || !isString(provenance.model)
    || !isString(provenance.assessmentPolicyVersion) || !isString(provenance.scoringPolicyVersion)
    || !isIsoDate(provenance.generatedAt)) {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      reportId: input.reportId,
      analysisRunId: input.analysisRunId,
      revision: input.revision,
      conversation: {
        id: conversation.id,
        revision: conversation.revision,
        targetRole: conversation.targetRole,
        targetRoleKey: conversation.targetRoleKey,
      },
      inputs: {
        profileRevision: inputs.profileRevision,
        resume,
        strengthRevision: inputs.strengthRevision,
        roleRequirementSnapshotId: inputs.roleRequirementSnapshotId,
      },
      assessment: {
        summary: assessment.summary,
        confidence: assessment.confidence,
        ...(enrichedAssessment ? {
          readinessScore: assessment.readinessScore as number,
          evidenceCoveragePct: assessment.evidenceCoveragePct as number,
          topGapIds: [...(assessment.topGapIds as readonly string[])],
          actionPlan,
        } : {}),
        gaps,
        strengths,
      },
      provenance: {
        promptVersion: provenance.promptVersion,
        model: provenance.model,
        assessmentPolicyVersion: provenance.assessmentPolicyVersion,
        scoringPolicyVersion: provenance.scoringPolicyVersion,
        generatedAt: provenance.generatedAt,
      },
    },
  };
}

export function parseGapAnalysisResponseV2(input: unknown): GapAnalysisResponseParseResult {
  if (!isRecord(input) || typeof input.status !== 'string') {
    return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
  }
  if (input.status === 'WAITING_FOR_EVIDENCE') {
    if (!exactKeys(input, ['status', 'reasonCode']) || input.reasonCode !== 'PROFILE_OR_READY_RESUME_REQUIRED') {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    return { ok: true, value: { status: input.status, reasonCode: input.reasonCode } };
  }
  if (input.status === 'WAITING_FOR_RESUME_SELECTION') {
    if (!exactKeys(input, ['status', 'reasonCode']) || input.reasonCode !== 'READY_RESUME_SELECTION_REQUIRED') {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    return { ok: true, value: { status: input.status, reasonCode: input.reasonCode } };
  }
  if (input.status === 'PENDING' || input.status === 'RUNNING') {
    if (!exactKeys(input, ['status', 'runId']) || !isUuid(input.runId)) {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    return { ok: true, value: { status: input.status, runId: input.runId } };
  }
  if (input.status === 'SUCCEEDED') {
    if (!exactKeys(input, ['status', 'report'])) return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    const report = parseGapAnalysisReportV2(input.report);
    return report.ok ? { ok: true, value: { status: input.status, report: report.value } } : report;
  }
  if (input.status === 'FAILED_RETRYABLE' || input.status === 'FAILED_FINAL') {
    if (!exactKeys(input, ['status', 'runId', 'reasonCode']) || !isUuid(input.runId)
      || !inSet(input.reasonCode, GAP_ANALYSIS_FAILURE_REASONS)) {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    return { ok: true, value: { status: input.status, runId: input.runId, reasonCode: input.reasonCode } };
  }
  if (input.status === 'STALE') {
    if (!exactKeys(input, ['status', 'runId', 'reasonCode']) || !isUuid(input.runId)
      || input.reasonCode !== 'INPUT_REVISION_CHANGED') {
      return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
    }
    return { ok: true, value: { status: input.status, runId: input.runId, reasonCode: input.reasonCode } };
  }
  return { ok: false, code: 'GAP_ANALYSIS_MALFORMED' };
}

function severityForLevels(currentLevel: number, requiredLevel: number): GapSeverity {
  const delta = requiredLevel - currentLevel;
  return delta >= 3 ? 'CRITICAL' : delta === 2 ? 'MAJOR' : 'MINOR';
}

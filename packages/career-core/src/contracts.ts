import type { AgentSpeakerKey } from '@companion/platform-contracts';

export const ROLE_FAMILIES = ['swe', 'mle', 'ds', 'da', 'de', 'hw', 'other'] as const;
export type CareerRoleFamily = typeof ROLE_FAMILIES[number];

/** Domain data carries references; raw CVs, email bodies and OAuth tokens stay in private ports. */
export type CareerSkillId = 'career-intake' | 'role-exploration' | 'evidence-story' | 'project-sprint' | 'networking-practice' | 'application-preparation' | 'interview-practice' | 'resume-revision' | 'skill-drill' | 'interview-brief' | 'job-triage' | 'mentor-handoff';
export type CareerInput = 'profile' | 'project-facts' | 'current-jobs' | 'knowledge' | 'target-role' | 'skill-gaps' | 'conversation-goal' | 'target-job' | 'confirmed-profile' | 'reviewed-resume' | 'resume-source' | 'target-direction' | 'contact';
export type CareerPhase = 'P0' | 'P1-1' | 'P1-4' | 'P1-6' | 'P1-7' | 'P1-8' | 'P1-9' | 'P1-10' | 'P1b' | 'P2';
export type CareerTool = 'read_profile' | 'read_journey' | 'search_knowledge' | 'search_org_knowledge' | 'search_jobs' | 'read_job_posting' | 'read_evidence' | 'read_stories' | 'read_resume_version' | 'summarize_interview_coverage' | 'save_plan_draft' | 'save_story_draft' | 'save_resume_draft' | 'save_practice_record' | 'draft_outbound' | 'propose_journey_update';
export interface CareerSkillDefinition {
  readonly id: CareerSkillId;
  readonly revision: number;
  readonly owner: AgentSpeakerKey;
  readonly phase: CareerPhase;
  readonly name: string;
  readonly goal: string;
  readonly whenToUse: string;
  readonly instructions: string;
  readonly requiredInputs: readonly CareerInput[];
  readonly tools: readonly CareerTool[];
  readonly outputs: readonly string[];
  readonly reviewCriteria: readonly string[];
  readonly stopWhen: string;
  readonly outputContract: Readonly<Record<string, unknown>>;
  readonly methodRefs: readonly { readonly methodId: string; readonly revision: number }[];
  readonly invocation: 'model' | 'user' | 'both';
  readonly expectedSeconds: number;
  /** Evaluation set identifiers are a requirement, not evidence that evaluation has passed. */
  readonly evals: readonly string[];
}
export interface CareerInputReference {
  input: CareerInput;
  id: string;
  revision: number;
  ownerId: string;
  state: 'current' | 'withdrawn' | 'stale';
}
/** Constructed by the authenticated server, never accepted as a client grant. */
export interface CareerRunContext {
  ownerId: string;
  profileRevision: number;
  inputs: readonly CareerInputReference[];
  tools: Readonly<Partial<Record<CareerTool, 'ready' | 'unavailable' | 'requires_connection'>>>;
}
export type CareerRunPreparation =
  | { state: 'blocked'; skillId: CareerSkillId; reasons: string[] }
  | { state: 'ready_for_draft'; skillId: CareerSkillId; skillRevision: number; profileRevision: number; inputs: CareerInputReference[]; tools: CareerTool[]; maxToolCalls: 12; maxModelTurns: 6; externalActions: 'forbidden'; reviewRequired: true };
export type CareerEvidenceKind = 'project' | 'resume_review' | 'practice_review' | 'outreach' | 'application' | 'interview';
export interface CareerEvidence {
  id: string;
  ownerId: string;
  /** Stable project, CV revision, practice attempt, message, application or interview identity. */
  subjectId: string;
  kind: CareerEvidenceKind;
  state: 'active' | 'withdrawn' | 'rejected';
  verification: 'self_reported' | 'observed' | 'user_confirmed' | 'mentor_reviewed';
  /** Private artifact/receipt/review reference; a reference alone does not verify its contents. */
  referenceId?: string;
  occurredAt: string;
  /** Authenticated review metadata; scope cannot expand from one artifact to every skill. */
  mentorReview?: { reviewerId: string; scope: CareerEvidenceKind; reviewedAt: string; rubricRevision: string };
}
export interface CareerProgress {
  policyRevision: 1;
  counts: Record<CareerEvidenceKind, number>;
  provisionalCounts: Record<CareerEvidenceKind, number>;
  milestones: ('first_project_evidence' | 'first_reviewed_resume' | 'first_reviewed_practice' | 'first_confirmed_outreach' | 'first_confirmed_application' | 'first_confirmed_interview')[];
}
export interface KnowledgeCitation {
  /** updatedAt is this knowledge version's registration time, not an inferred source modification time. */
  sourceId: string; revision: string; passageId: string; updatedAt: string;
}
export interface CareerKnowledgePort {
  /** Implementations filter the authenticated owner's access before retrieval. */
  search(context: { ownerId: string; signal: AbortSignal }, query: string): Promise<{ text: string; citations: KnowledgeCitation[] }[]>;
}
export interface CareerJobObservation {
  source: 'greenhouse' | 'lever' | 'ashby' | 'licensed_feed' | 'manual';
  sourceId: string; employer: string; title: string; canonicalUrl: string;
  observedAt: string; postedAt?: string; checkedAt?: string;
  state: 'observed_open' | 'closed' | 'unknown';
  sponsorship: 'explicit_yes' | 'explicit_no' | 'unknown';
}
export interface CareerJobsPort {
  search(context: { ownerId: string; signal: AbortSignal }, input: { query: string; limit: number }): Promise<CareerJobObservation[]>;
}

import type { Approval, Artifact, Capability, Conversation, Job, Message, VoiceRecord, WorkflowStep } from './index.ts';
import type { ConversationTaskOrigin } from './conversation-tasks.ts';
import type { GoalPlanContinuation, GoalPlanInputSnapshot, GoalPlanInputSource, GoalPlanReceipt, GoalPlanStatus, GoalPlanStepState, GoalPlanTaskBindings } from './plans.ts';
import type { GoalPlanProposalSummary } from './goal-proposals.ts';
import type { McpTaskSummary } from './mcp.ts';
import type { JobOutcomeEvidence, JobOutcomeReviewRecord, JobOutcomeReviewPage } from './job-outcome-reviews.ts';
import type { VoiceContextSnapshot } from './voice-context.ts';

/** Deployment features do not assert a staff role, consent or execution authorization. */
export interface PlatformFeatures {
  version: 1;
  workbench: boolean;
  providerDetails: boolean;
}

/** Genuine capability availability, separate from the internal provider catalogue. */
export interface PublicCapabilities {
  capabilities: Record<Capability, boolean>;
  chatAttachments?: PublicChatAttachmentSupport;
}

/** Input limits without local ASR configuration or model identifiers. */
export interface PublicChatAttachmentSupport {
  directMimeTypes: string[];
  maxAttachments: number;
  maxTotalBytes: number;
  audioTranscripts: {
    mimeTypes: string[];
    maxAudioBytes: number;
    maxDurationSeconds: number;
    maxPerMessage: number;
    maxReviewedCharacters: number;
    available: boolean;
    reviewRequired: true;
  };
}

/** Immutable ASR output keeps source evidence; it does not verify the speaker. */
export interface PublicAudioTranscriptionReceipt {
  id: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  text: string;
  provenance: 'untrusted_audio_transcript';
  createdAt: string;
}

/** User-selected text remains distinct from the immutable ASR output. */
export interface PublicReviewedAudioTranscript {
  receiptId: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  text: string;
  textModified: boolean;
  provenance: 'untrusted_audio_transcript';
}

export interface PublicMessage {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  status: Message['status'];
  createdAt: string;
  attachments?: Message['attachments'];
  audioTranscripts?: PublicReviewedAudioTranscript[];
}

export interface PublicConversation {
  id: string;
  title: string;
  createdAt: Conversation['createdAt'];
  updatedAt: Conversation['updatedAt'];
}

/** Read-only execution facts; this DTO cannot reconstruct or authorize a task. */
export interface PublicJob {
  id: string;
  kind: Job['kind'];
  status: Job['status'];
  progress: number;
  attempt: number;
  generation?: number;
  artifacts: Artifact[];
  createdAt: string;
  updatedAt: string;
  error?: PublicError;
  mcp?: McpTaskSummary;
  workflowSteps?: { index: number; kind: WorkflowStep['kind']; state: NonNullable<Job['workflowSteps']>[number]['state']; errorCode?: string }[];
  workflowResumeAvailable?: boolean;
  browserExecution?: NonNullable<Job['browserExecution']>;
}

/** An approval summary is not the reviewed arguments or a grant to execute. */
export interface PublicApproval {
  id: string;
  jobId: string;
  toolName?: string;
  status: Approval['status'];
  generation?: number;
  createdAt: string;
}

/** The human-facing definition omits execution configuration. Its hash remains
 * the original server definition hash, not a hash of this projection. */
export interface PublicTaskDefinition {
  kind: Job['kind'];
  prompt: string;
}
export type PublicGoalPlanStepInput =
  | { kind: 'task'; title: string; task: PublicTaskDefinition; bindings?: GoalPlanTaskBindings }
  | { kind: 'agent_turn'; title: string; instruction: string };
export interface PublicGoalPlanStep {
  index: number;
  input: PublicGoalPlanStepInput;
  state: GoalPlanStepState;
  ready: boolean;
  blockReason?: string;
  job?: PublicJob;
  generation?: number;
  approval?: PublicApproval;
  artifacts: Artifact[];
  messageId?: string;
  receipt?: GoalPlanReceipt;
  resolvedTask?: PublicTaskDefinition;
  inputSources?: GoalPlanInputSource[];
}
export interface PublicGoalPlan {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  revision: number;
  status: GoalPlanStatus;
  definitionHash: string;
  steps: PublicGoalPlanStep[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}
export interface PublicGoalPlanList { plans: PublicGoalPlan[]; limit: number }
export interface PublicGoalPlanContinuation extends GoalPlanContinuation {}
export interface PublicGoalPlanInputSnapshot extends GoalPlanInputSnapshot {}
export type PublicGoalPlanContinueResult =
  | { kind: 'task'; plan: PublicGoalPlan; stepIndex: number; job: PublicJob; approval?: PublicApproval }
  | { kind: 'agent_turn'; plan: PublicGoalPlan; stepIndex: number; continuation: PublicGoalPlanContinuation }
  | { kind: 'existing'; plan: PublicGoalPlan; stepIndex: number };
export interface PublicGoalPlanProposalSummary extends GoalPlanProposalSummary {}
export interface PublicGoalPlanProposalList { proposals: PublicGoalPlanProposalSummary[]; nextBefore: string | null; limit: number }
export interface PublicGoalPlanProposalResult { proposal: PublicGoalPlanProposalSummary }
export interface PublicConversationTask { origin: ConversationTaskOrigin; job: PublicJob; generation: number; approval?: PublicApproval }
export interface PublicConversationTaskPage { tasks: PublicConversationTask[]; nextBefore: string | null }

export interface PublicWorkflowStep {
  kind: WorkflowStep['kind'];
  prompt: string;
  referenceImages?: { fromStep: number; imageIndex?: number }[];
}
export interface PublicWorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  steps: PublicWorkflowStep[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Neutral control errors; this never rewrites user content or external results. */
export interface PublicError { code: string; message: string; status?: number }
export interface PublicToolProgress { messageId: string; name: string; status: 'started' | 'completed' }

/** Unknown outcomes stay unknown. Provider handles are not disclosed or replaced. */
export interface PublicJobOutcomeEvidence extends Omit<JobOutcomeEvidence, 'hasProviderTask' | 'reasons' | 'attempts' | 'workflow'> {
  hasExternalTask: boolean;
  reasons: (Exclude<JobOutcomeEvidence['reasons'][number], 'comfyui_submission_unknown' | 'model_relay_uncertain'> | 'external_submission_unknown' | 'analysis_result_unknown')[];
  attempts: { attempt: number; status: JobOutcomeEvidence['attempts'][number]['status']; hasExternalTask: boolean }[];
  workflow?: { scope: 'task_checkpoint'; revision: number; steps: { index: number; state: NonNullable<JobOutcomeEvidence['workflow']>['steps'][number]['state']; hasExternalTask: boolean }[] };
}
export interface PublicJobOutcomeReviewPage extends Omit<JobOutcomeReviewPage, 'evidence'> { evidence: PublicJobOutcomeEvidence | null }
export interface PublicJobOutcomeReviewSaved { record: JobOutcomeReviewRecord }

export interface PublicVoiceRecord {
  id: string;
  conversationId: string;
  clientRecordId: string;
  source: VoiceRecord['source'];
  role: VoiceRecord['role'];
  text: string;
  provenance: 'client_submitted';
  sessionId?: string;
  attachments: VoiceRecord['attachments'];
  createdAt: string;
}

/** Direct WebRTC needs its actual endpoint and temporary credential. These are
 * transport fields, not a promise that browser network traffic hides its vendor. */
export interface PublicVoiceSessionResponse {
  clientSecret: string;
  endpoint: string;
  expiresAt?: number;
  inputTranscriptionEnabled?: boolean;
  sessionId: string;
  serverContext?: VoiceContextSnapshot;
}

/** Actual aggregate usage, without the internal provider/model breakdown. */
export interface PublicAccountUsage {
  period: { from: string; to: string; timeZone: 'UTC' };
  chat: {
    calls: number;
    reportedCalls: number;
    missingCalls: number;
    invalidCalls: number;
    pendingCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    coverage: 'none' | 'partial' | 'complete';
    outcomes: { complete: number; failed: number; cancelled: number; interrupted: number; running: number };
    legacyReports: number;
  };
}

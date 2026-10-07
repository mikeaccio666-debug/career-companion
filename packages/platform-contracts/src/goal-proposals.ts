import type { Capability, ExecutionTemplateBinding, ProviderStatus } from './index.ts';

export const GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT = 20;
export const GOAL_PLAN_PROPOSAL_MAX_LIMIT = 50;
export const EXECUTION_CAPABILITIES_MAX_BYTES = 32 * 1024;
/** Bounded owned metadata. Status is stored plan state; completion is determined only by reading the plan. */
export interface GoalPlanProposalSummary {
  planId: string;
  conversationId: string;
  title: string;
  revision: number;
  status: 'draft' | 'active' | 'paused' | 'cancelled';
  stepCount: number;
  /** Null means the originating assistant message was deleted; the editable plan remains. */
  messageId: string | null;
  createdAt: string;
}
export interface GoalPlanProposalList { proposals: GoalPlanProposalSummary[]; nextBefore: string | null; limit: number }
export interface GoalPlanProposalResult { proposal: GoalPlanProposalSummary }
/** Current server configuration, not proof of third-party identity, permission or end-to-end readiness. */
export interface ExecutionProviderCapability {
  id: string; name: string; enabled: boolean; keyConfigured: boolean;
  capabilities: Capability[];
  modelsByCapability: Partial<Record<Capability, string[]>>;
  referenceImages?: ProviderStatus['referenceImages'];
  browserActionsEnabled?: boolean;
  executionTemplate?: ExecutionTemplateBinding;
}
export interface ExecutionCapabilities {
  providers: ExecutionProviderCapability[];
  source: 'server_configuration';
  accountAuthorizationVerified: false;
  truncated: boolean;
}

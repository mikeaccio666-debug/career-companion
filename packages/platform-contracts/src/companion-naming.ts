/** Saved raw naming intent. Semantic name rules run after genuine detection. */
export interface CompanionNamingRequest {
  readonly taskId: string; readonly expectedEntryRevision: number; readonly expectedIdentityRevision: number;
  readonly operationId: string; readonly name: string;
}
export type CompanionNamingHold = 'authorization_required' | 'configuration_unavailable' | 'requires_review';
export type CompanionNamingNameCategory = 'family_or_partner' | 'team_or_org' | 'same_as_user' | 'abusive' | 'public_figure' | 'length';
/** Observation only. No raw text, classifier credentials or execution permission. */
export interface CompanionNamingProgress {
  readonly dispatchId: string; readonly taskId: string; readonly submissionId: string; readonly submittedRevision: number;
  readonly phase: 'queued' | 'checking' | 'held' | 'detected'; readonly hold: CompanionNamingHold | null;
  readonly detection: { readonly status: 'pending' | 'running' | 'detected'; readonly generation: number;
    readonly level: 'L0' | 'L1' | 'L2' | null; readonly mode: 'full' | 'keyword_only' | null };
  readonly application: { readonly status: 'pending' | 'applied' | 'name_rejected' | 'superseded' | 'not_eligible';
    readonly rejectedCategory: CompanionNamingNameCategory | null; readonly identityRevision: number | null };
  /** Captured is not published, presented, acknowledged or handled. */
  readonly resource: 'not_determined' | 'not_required' | 'pending' | 'ready' | 'unavailable';
}
export interface CompanionNamingAccepted {
  readonly acceptance: { readonly dispatchId: string; readonly taskId: string; readonly submissionId: string;
    readonly operation: { readonly id: string; readonly appliedRevision: number; readonly replayed: boolean } };
  readonly progress: CompanionNamingProgress;
}
export type CompanionNamingState = { readonly kind: 'not_started' } | {
  readonly kind: 'naming'; readonly entry: { readonly taskId: string; readonly companionId: string;
    readonly revision: number; readonly latestSubmissionId: string }; readonly latest: CompanionNamingProgress | null;
};

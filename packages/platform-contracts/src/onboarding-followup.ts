import type { OnboardingDraft, OnboardingQuestion, OnboardingSkipReason } from './onboarding.ts';

/** Server-rendered, reviewed resources. Internal review references and raw intake text are excluded. */
export type OnboardingResourceAction =
  | Readonly<{ kind: 'call'; number: string; label: string }>
  | Readonly<{ kind: 'sms'; number: string; body: string | null; label: string }>
  | Readonly<{ kind: 'web'; url: string; label: string }>;
export interface OnboardingPublicSafetyResponse {
  readonly text: string; readonly question?: string;
  readonly resourceCard: Readonly<{
    title: string; schoolUnknown: string; footer: string;
    outsideUs: Readonly<{ label: string; text: string }>;
    contacts: readonly Readonly<{ id: string; verifiedAt: string; name: string; description: string; actions: readonly OnboardingResourceAction[] }>[];
  }>;
}
export interface OnboardingSafetyPublication {
  readonly publicationId: string; readonly responseId: string; readonly submissionId: string;
  readonly level: 'L1' | 'L2'; readonly publishedAt: string; readonly retentionUntil: string;
  readonly response: OnboardingPublicSafetyResponse;
  /** These are protocol events; presentation is a client claim, acknowledgment is a user declaration. */
  readonly presented: boolean; readonly acknowledged: boolean; readonly handled: boolean; readonly clarifiedAt: string | null;
}
export interface OnboardingFollowupState {
  readonly draft: OnboardingDraft | null;
  readonly publications: readonly OnboardingSafetyPublication[];
  readonly pendingResponses: readonly Readonly<{ responseId: string; submissionId: string; status: 'pending' | 'expired' }>[];
  readonly safety: Readonly<{ status: 'clear' | 'pending' | 'blocked'; pendingCount: number; blockedLevel: 'L1' | 'L2' | null }>;
}
export type OnboardingFollowupAction =
  | { kind: 'present' | 'need_support' }
  | { kind: 'acknowledge' | 'continue_intake'; presentationReceipt: string }
  | { kind: 'clarify_exaggeration'; presentationReceipt: string; safe: true; exaggeration: true };
/** No safety level, source history, approval, user ID or session authority comes from this request. */
export interface OnboardingFollowupCommand {
  operationId: string; expectedDraftRevision: number; publicationId: string; action: OnboardingFollowupAction;
}
export interface OnboardingFollowupResult {
  readonly draft: OnboardingDraft;
  readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
  readonly publicationId: string;
  readonly resumeStatus: 'not_requested' | 'remaining_safety' | 'waiting_for_safety' | 'resumed';
  /** A lost response is recovered by presenting again with a new operation, never by storing the handle in the browser. */
  readonly presentationReceipt?: string;
}
/** Availability describes current configuration; it never grants model/tool execution permission. */
export type OnboardingAnswerSummary = Readonly<{
  questionId: OnboardingQuestion; prompt: string; label: string; appliedRevision: number;
}> & (Readonly<{ kind: 'answered' }> | Readonly<{ kind: 'skipped'; reason: OnboardingSkipReason }>);
export interface OnboardingEntryState extends OnboardingFollowupState {
  readonly freeTextAvailable: boolean;
  /** Fixed, ordered projection of authenticated answers only. No raw text or memory/execution claim. */
  readonly answerSummaries: readonly OnboardingAnswerSummary[];
  readonly question: Readonly<{ questionId: OnboardingQuestion; prompt: string; choices: readonly Readonly<{value: string; label: string}>[] }> | null;
}

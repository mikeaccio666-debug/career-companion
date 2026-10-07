/** O5/O6 public projection. The server retains style dimensions, answers and execution receipts. */
export const COMPANION_INK_TOKENS = Object.freeze(['yanzhi', 'zheshi', 'ganlan', 'jiangzi', 'dai', 'yanzi', 'hehui'] as const);
export type CompanionPublicInkToken = typeof COMPANION_INK_TOKENS[number];
export interface PublicCompanionPreview {
  readonly taskId: string;
  readonly companionId: string;
  readonly revision: 1;
  readonly generatedBy: 'model' | 'fallback';
  readonly summary: string;
  readonly samples: readonly [string, string, string];
  readonly inkToken: CompanionPublicInkToken;
}
export type CompanionDraftEntryState =
  | { readonly kind: 'intake_required' }
  | { readonly kind: 'not_prepared'; readonly intakeRevision: number; readonly generationAvailable: boolean }
  | { readonly kind: 'generation'; readonly taskId: string; readonly companionId: string; readonly generation: number;
      readonly status: 'pending' | 'running' | 'failed' | 'interrupted' | 'uncertain';
      /** Durable accepted-request hold. It neither changes task generation nor renews execution authority. */
      readonly hold: null | 'authorization_required' | 'configuration_unavailable' | 'requires_review' }
  | { readonly kind: 'preview'; readonly preview: PublicCompanionPreview };
/** Idempotent acceptance of the already persisted intake; no answers, provider or model supplied by the browser. */
export interface CompanionDraftRequest { readonly operationId: string; readonly expectedRevision: number; }
export interface CompanionDraftAccepted {
  readonly entry: CompanionDraftEntryState;
  readonly operation: { readonly id: string; readonly replayed: boolean };
}

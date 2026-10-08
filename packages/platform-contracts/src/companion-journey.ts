import type { PublicCompanionPreview } from './companion-entry.ts';
import type { CompanionNamingState, CompanionNamingAccepted } from './companion-naming.ts';
import type { PublicCompanionIdentityDraft, CompanionSealSelection, CompanionSealSelectionSaved } from './companion-identity.ts';

/** Persisted facts only. Viewing an identity is not current permission to name,
 * select, generate, birth a companion or enter a room. */
export interface CompanionIdentityObservation {
  readonly identity: PublicCompanionIdentityDraft | null;
  readonly selection: CompanionSealSelection | null;
}
export type CompanionStudentJourneyState =
  | { readonly kind: 'not_started'; readonly naming: CompanionNamingState }
  | { readonly kind: 'journey'; readonly taskId: string; readonly companionId: string;
      readonly stage: 'preview' | 'naming' | 'seal_ready' | 'seal_saved';
      readonly preview: PublicCompanionPreview | null; readonly naming: CompanionNamingState;
      /** Genuine current managed operation coordinate, not execution authority.
       * A volatile unresolved own intent must never be replaced by this head. */
      readonly latestNamingOperationId: string | null;
      readonly identity: PublicCompanionIdentityDraft | null; readonly selection: CompanionSealSelection | null };
export interface CompanionSealSelectionOperationRequest { readonly taskId: string; readonly operationId: string; }
/** An own-operation observer reports the original committed revision beside
 * current saved state. It never reselects or borrows a later intent. */
export type CompanionSealSelectionOperationObservation = CompanionSealSelectionSaved | null;
/** Explicit recovery of the original classified operation; no raw name,
 * generation, source grade, execution token or new intent is supplied. */
export interface CompanionNamePreparationResumeRequest { readonly operationId: string; }
export type CompanionNamePreparationResumeResult = CompanionNamingAccepted;

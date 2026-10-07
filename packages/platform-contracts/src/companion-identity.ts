import type { CompanionPublicInkToken } from './companion-entry.ts';

/** Student-shaped data only. These fields do not prove asset approval, safety
 * classification, current account authority, or a companion birth.
 */
export interface PublicCompanionSealCandidate {
  readonly char: string;
  readonly reason: string;
}
export type PublicCompanionSealCandidates = readonly [
  PublicCompanionSealCandidate, PublicCompanionSealCandidate, PublicCompanionSealCandidate,
];
export interface PublicCompanionIdentityDraft {
  readonly companionId: string;
  readonly taskId: string;
  readonly previewRevision: 1;
  readonly revision: number;
  readonly name: string;
  readonly nameOrigin: 'user_typed';
  readonly sealCandidates: PublicCompanionSealCandidates;
  readonly inkToken: CompanionPublicInkToken;
}

/** The name and selection have separate revisions. Changing the name makes a
 * previous selection ineligible without resetting its revision or reviving it
 * when the user changes the name back. Revision zero means never selected.
 */
export interface CompanionSealSelection {
  readonly companionId: string;
  readonly taskId: string;
  readonly previewRevision: 1;
  readonly identityRevision: number;
  readonly revision: number;
  readonly selectedSeal: string | null;
}
/** Only an existing candidate can be chosen. No name, model, policy, review,
 * preview, or execution permission is supplied by the caller.
 */
export interface CompanionSealSelectionRequest {
  readonly taskId: string;
  readonly expectedIdentityRevision: number;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly sealChar: string;
}
export interface CompanionSealSelectionSaved {
  readonly selection: CompanionSealSelection;
  /** A replay reports the original applied revision alongside CURRENT state;
   * it never overwrites a later choice or advances an onboarding cursor.
   */
  readonly operation: {
    readonly id: string;
    readonly appliedRevision: number;
    readonly replayed: boolean;
  };
}

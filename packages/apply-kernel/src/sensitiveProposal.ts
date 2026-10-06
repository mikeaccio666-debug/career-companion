import type {
  PendingL2pSensitiveAssistedWriteClass,
  PendingL2pSensitiveManualOnlyClass,
} from '@edaix/contracts/draft';

export type PendingSensitiveLegalProposalClass = Exclude<
  PendingL2pSensitiveAssistedWriteClass,
  'PASSWORD'
>;

export interface PendingSensitiveVerifiedRuleFacts {
  /** Classification came from a verified, backend-delivered apply-rule. */
  readonly authority: 'VERIFIED_BACKEND_APPLY_RULE';
  readonly proposalClass: PendingSensitiveLegalProposalClass;
  readonly localeStatus: 'SUPPORTED' | 'UNSUPPORTED';
  readonly statementShape: 'EXACT_UNBUNDLED' | 'BUNDLED_OR_AMBIGUOUS';
}

export interface PendingSensitiveCandidateFacts {
  readonly controlType: string;
  readonly autocomplete?: string | null;
  /** Optional negative fact from the verified rule interpreter; negative wins. */
  readonly manualOnlySignal?: PendingSensitiveManualReason | null;
  /** No local label regex may mint a positive proposal classification. */
  readonly verifiedRule?: PendingSensitiveVerifiedRuleFacts | null;
}

export type PendingSensitiveManualReason =
  | PendingL2pSensitiveManualOnlyClass
  | 'COMPOSITE_OR_AMBIGUOUS';

/** Current draft surface is deliberately negative-only and cannot mint authority. */
export type PendingSensitiveCandidateClassification = Readonly<{
  kind: 'MANUAL_ONLY';
  reason: PendingSensitiveManualReason;
}>;

const LEGAL_PROPOSAL_CLASSES = new Set<string>([
  'BACKGROUND_CHECK_AUTHORIZATION',
  'ARBITRATION_AGREEMENT',
  'CREDIT_REPORT_AUTHORIZATION',
  'DRUG_TEST_AUTHORIZATION',
]);

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function manual(reason: PendingSensitiveManualReason): PendingSensitiveCandidateClassification {
  return Object.freeze({ kind: 'MANUAL_ONLY', reason });
}

/**
 * Negative-only draft classifier. Raw labels and structural "verified" facts
 * are deliberately not an authority, so every current path is manual-only.
 * A future positive candidate must be privately minted by the verified runtime
 * interpreter and still obtain a durable per-item release plus fresh target,
 * rule, policy and capability-ceiling revalidation.
 */
export function classifyPendingSensitiveCandidate(
  input: PendingSensitiveCandidateFacts,
): PendingSensitiveCandidateClassification {
  if (input.manualOnlySignal) return manual(input.manualOnlySignal);

  const controlType = normalize(input.controlType);
  const autocomplete = normalize(input.autocomplete ?? '');
  if (autocomplete === 'one-time-code') return manual('OTP_OR_2FA');

  if (controlType === 'password') {
    // A plain structural object cannot prove element identity, canonical target
    // or backend occurrence authority. Password remains manual-only until the
    // runtime interpreter can mint a private, element-bound candidate.
    return manual(input.verifiedRule ? 'COMPOSITE_OR_AMBIGUOUS' : 'UNKNOWN_HIGH_RISK');
  }
  if (autocomplete === 'current-password' || autocomplete === 'new-password') {
    return manual('UNKNOWN_HIGH_RISK');
  }

  const rule = input.verifiedRule;
  if (
    !rule ||
    rule.authority !== 'VERIFIED_BACKEND_APPLY_RULE' ||
    !LEGAL_PROPOSAL_CLASSES.has(rule.proposalClass)
  ) {
    return manual('UNKNOWN_HIGH_RISK');
  }
  if (rule.localeStatus !== 'SUPPORTED') return manual('UNKNOWN_HIGH_RISK');
  if (rule.statementShape !== 'EXACT_UNBUNDLED') {
    return manual('COMPOSITE_OR_AMBIGUOUS');
  }
  if (controlType !== 'checkbox') return manual('COMPOSITE_OR_AMBIGUOUS');

  // Structural rule facts are useful for negative classification only. A
  // future positive path must consume a module-private candidate minted by the
  // verified runtime interpreter and bound to this exact element/occurrence.
  return manual('UNKNOWN_HIGH_RISK');
}

/**
 * Draft surface for PR #77's atomic L2-P proposal. Nothing in the stable
 * contract root, runtime decoders, issuer, claim, or material endpoint accepts
 * these values before final-head approval and DDL-owned final convergence.
 */
export const PENDING_L2P_SENSITIVE_PROPOSAL_STATUS =
  'PENDING_L2P_PROPOSAL' as const;

export const PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES = [
  'BACKGROUND_CHECK_AUTHORIZATION',
  'ARBITRATION_AGREEMENT',
  'CREDIT_REPORT_AUTHORIZATION',
  'DRUG_TEST_AUTHORIZATION',
  'PASSWORD',
] as const;
export type PendingL2pSensitiveAssistedWriteClass =
  (typeof PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES)[number];

export const PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES = [
  'OTP_OR_2FA',
  'CAPTCHA_OR_HUMAN_CHALLENGE',
  'MARKETING_SUBSCRIPTION',
  'CONTACT_CURRENT_EMPLOYER',
  'OTHER_SUBSTANTIVE_AUTHORIZATION',
  'FILE_PICKER',
  'UNKNOWN_HIGH_RISK',
] as const;
export type PendingL2pSensitiveManualOnlyClass =
  (typeof PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES)[number];

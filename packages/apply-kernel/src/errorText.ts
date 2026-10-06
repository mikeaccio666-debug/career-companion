/**
 * The sole mapping from stable autofill error codes to UI translation keys.
 *
 * This deliberately returns a key rather than user-facing prose: adding an
 * error code must make TypeScript require a matching display state, while the
 * UI language remains wholly owned by `i18n/strings.ts`.
 */

import type { ApplyErrorCode, ApplyProfileAccessErrorCode } from './contracts';

export const APPLY_ERROR_TEXT = {
  CLICK_DENIED: 'apply.error.clickDenied',
  HONEYPOT: 'apply.error.honeypot',
  OTHER_PERSON: 'apply.error.otherPerson',
  JOB_DEPENDENT: 'apply.error.jobDependent',
  MANUAL_ONLY: 'apply.error.manualOnly',
  PREFILLED_NEEDS_CONFIRMATION: 'apply.error.prefilledNeedsConfirmation',
  HOST_UNCONFIRMED: 'apply.error.hostUnconfirmed',
  CHOICE_NO_DATA: 'apply.error.choiceNoData',
  NO_VALUE: 'apply.error.noValue',
  SENSITIVE_OPT_OUT: 'apply.error.sensitiveOptOut',
  UNSUPPORTED_CONTROL: 'apply.error.unsupportedControl',
  LOW_CONFIDENCE: 'apply.error.lowConfidence',
  USER_ONLY: 'apply.error.userOnly',
  NOT_EMPTY: 'apply.error.notEmpty',
  NO_OPTION_MATCH: 'apply.error.noOptionMatch',
  AMBIGUOUS_OPTION: 'apply.error.ambiguousOption',
  OPTIONS_INCOMPLETE: 'apply.error.optionsIncomplete',
  WRITE_REVERTED: 'apply.error.writeReverted',
  VALUE_COERCED: 'apply.error.valueCoerced',
  VERIFY_TIMEOUT: 'apply.error.verifyTimeout',
  HOST_REJECTED: 'apply.error.hostRejected',
  TARGET_NOT_WRITABLE: 'apply.error.targetNotWritable',
  DUPLICATE_FIELD: 'apply.error.duplicateField',
  LATE_REVERTED: 'apply.error.lateReverted',
  WIDGET_TIMEOUT: 'apply.error.widgetTimeout',
  DETACHED: 'apply.error.detached',
  IDENTITY_CHANGED: 'apply.error.identityChanged',
  HOST_SUBMITTED: 'apply.error.hostSubmitted',
  ABORTED: 'apply.error.aborted',
  GESTURE_UNTRUSTED: 'apply.error.gestureUntrusted',
  GESTURE_FOREIGN: 'apply.error.gestureForeign',
  GESTURE_EXPIRED: 'apply.error.gestureExpired',
  GRANT_CONSUMED: 'apply.error.grantConsumed',
  LEASE_INVALID: 'apply.error.leaseInvalid',
  LEASE_EXPIRED: 'apply.error.leaseExpired',
  PLAN_STALE: 'apply.error.planStale',
  POLICY_DISABLED: 'apply.error.policyDisabled',
  JOURNAL_UNAVAILABLE: 'apply.error.journalUnavailable',
  CAPABILITY_DISABLED: 'apply.error.capabilityDisabled',
  STORAGE_UNAVAILABLE: 'apply.error.storageUnavailable',
  SCHEMA_TOO_NEW: 'apply.error.schemaTooNew',
} as const satisfies Record<ApplyErrorCode, `apply.error.${string}`>;

export type ApplyErrorTextKey = (typeof APPLY_ERROR_TEXT)[ApplyErrorCode];

/** No fallback: an unhandled error code is a type error at its introduction. */
export function applyErrorText(code: ApplyErrorCode): ApplyErrorTextKey {
  return APPLY_ERROR_TEXT[code];
}

/** Account-profile errors have their own copy; they are not host-write outcomes. */
export const APPLY_PROFILE_ACCESS_ERROR_TEXT = {
  INVALID_SENDER: 'apply.profileError.unavailable',
  INVALID_REQUEST: 'apply.profileError.unavailable',
  LOGIN_REQUIRED: 'apply.profileError.loginRequired',
  PROFILE_CONFLICT: 'apply.profileError.conflict',
  // 与并发冲突分开：那个重试就行，这个必须重新加载——手上这份状态属于一个
  // 已经不存在的世代（档案被删过或重新启用过）。
  PROFILE_DELETION_CONFLICT: 'apply.profileError.deletionConflict',
  PROFILE_UNAVAILABLE: 'apply.profileError.unavailable',
  INVALID_RESPONSE: 'apply.profileError.unavailable',
  RESUME_UNAVAILABLE: 'apply.profileError.resumeUnavailable',
  STORAGE_UNAVAILABLE: 'apply.profileError.storageUnavailable',
} as const satisfies Record<ApplyProfileAccessErrorCode, `apply.profileError.${string}`>;

export type ApplyProfileAccessErrorTextKey =
  (typeof APPLY_PROFILE_ACCESS_ERROR_TEXT)[ApplyProfileAccessErrorCode];

export function applyProfileAccessErrorText(
  code: ApplyProfileAccessErrorCode,
): ApplyProfileAccessErrorTextKey {
  return APPLY_PROFILE_ACCESS_ERROR_TEXT[code];
}

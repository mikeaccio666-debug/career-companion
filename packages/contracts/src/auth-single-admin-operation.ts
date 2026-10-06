export const SINGLE_ADMIN_OPERATION_CODES = [
  'AUTH_ADMIN_OPERATION_SMTP_ACCEPTED', 'AUTH_ADMIN_OPERATION_NOT_ADMITTED', 'AUTH_ADMIN_OPERATION_UNAVAILABLE',
  'AUTH_ADMIN_OPERATION_STATE_UNAVAILABLE', 'AUTH_ADMIN_EMAIL_NOT_ADMITTED', 'AUTH_ADMIN_EMAIL_UNAVAILABLE',
  'AUTH_ADMIN_PROVISION_TARGET_INVALID', 'AUTH_ADMIN_PROVISION_NOT_ADMITTED', 'AUTH_ADMIN_PROVISION_TARGET_UNAVAILABLE',
  'AUTH_ADMIN_PROVISION_CONFLICT', 'AUTH_ADMIN_PROVISION_UNAVAILABLE', 'AUTH_EMAIL_TARGET_INVALID',
  'AUTH_EMAIL_EVENT_UNAVAILABLE', 'EMAIL_PROVIDER_UNAVAILABLE', 'AUTH_EMAIL_DELIVERY_UNCERTAIN', 'AUTH_EMAIL_STATE_UNAVAILABLE',
] as const;
export type SingleAdminOperationResult = Readonly<{
  ok: boolean;
  code: typeof SINGLE_ADMIN_OPERATION_CODES[number];
  accountProvisioned: boolean | null;
  providerAccepted: boolean | null;
  eventId?: string;
  userId?: string;
  recoveryCode?: 'AUTH_ADMIN_RECOVERY_REQUIRES_OPERATOR_REVIEW';
}>;

/** Closed, value-free Auth CLI boundary. Known partial outcomes must survive a nonzero exit. */
export function parseSingleAdminOperationResult(value: unknown): SingleAdminOperationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!['ok', 'code', 'accountProvisioned', 'providerAccepted'].every(key => Object.hasOwn(row, key))
    || !Object.keys(row).every(key => ['ok', 'code', 'accountProvisioned', 'providerAccepted', 'eventId', 'userId', 'recoveryCode'].includes(key))
    || typeof row.ok !== 'boolean' || !SINGLE_ADMIN_OPERATION_CODES.some(code => row.code === code)
    || ![true, false, null].includes(row.accountProvisioned as boolean | null)
    || ![true, false, null].includes(row.providerAccepted as boolean | null)
    || ['eventId', 'userId'].some(key => row[key] !== undefined && (typeof row[key] !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row[key])))
    || row.recoveryCode !== undefined && row.recoveryCode !== 'AUTH_ADMIN_RECOVERY_REQUIRES_OPERATOR_REVIEW'
    || row.ok === true && (row.code !== 'AUTH_ADMIN_OPERATION_SMTP_ACCEPTED'
      || row.accountProvisioned !== true || row.providerAccepted !== true)) return null;
  return Object.freeze({ ...row }) as SingleAdminOperationResult;
}

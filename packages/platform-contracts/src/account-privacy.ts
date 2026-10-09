export const ACCOUNT_PRIVACY_PURPOSES = ['account_export', 'account_delete'] as const;
export type AccountPrivacyPurpose = typeof ACCOUNT_PRIVACY_PURPOSES[number];
export interface AccountReauthentication { readonly purpose: AccountPrivacyPurpose; readonly password: string; }
/** Short-lived secret: keep only in memory, never persist or log this response. */
export interface AccountPrivacyProof { readonly ownerId: string; readonly purpose: AccountPrivacyPurpose; readonly token: string; readonly expiresAt: string; }
export function accountPrivacyPurpose(value: unknown): AccountPrivacyPurpose {
  if (typeof value !== 'string' || !ACCOUNT_PRIVACY_PURPOSES.includes(value as AccountPrivacyPurpose)) throw new Error('Invalid privacy purpose.');
  return value as AccountPrivacyPurpose;
}
export function parseAccountReauthentication(value: unknown): Readonly<AccountReauthentication> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid reauthentication.');
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !d.purpose || !d.password || Object.values(d).some(v => !('value' in v) || !v.enumerable)) throw new Error('Invalid reauthentication.');
  const purpose = accountPrivacyPurpose(d.purpose.value), password = d.password.value;
  if (typeof password !== 'string' || !password.length || password.length > 1024 || new TextEncoder().encode(password).length > 1024) throw new Error('Invalid reauthentication.');
  return Object.freeze({ purpose, password });
}

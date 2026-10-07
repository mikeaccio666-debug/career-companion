import type { StudentAuthOptions, StudentConsentStatus } from '@companion/platform-contracts';
import { isCurrentStudentConsent, parseLegalAvailability } from './student-entry-state.ts';
export type AuthOptions = StudentAuthOptions;
export type AccountActionPurpose = 'password-reset' | 'verify-email';
export type AccountActionLink = { kind: AccountActionPurpose; token: string } | { kind: 'invalid'; purpose?: AccountActionPurpose };

/** Read and erase an action fragment before rendering or making any requests. */
export function takeAccountActionLink(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState' | 'state'>): AccountActionLink | null {
  const fragment = location.hash;
  if (!fragment.startsWith('#account-action=')) return null;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const match = /^#account-action=(password-reset|verify-email)&token=([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (match) return { kind: match[1] as AccountActionPurpose, token: match[2] };
  const purpose = /^#account-action=(password-reset|verify-email)(?:&|$)/.exec(fragment)?.[1] as AccountActionPurpose | undefined;
  return { kind: 'invalid', ...(purpose ? { purpose } : {}) };
}

/** A short-lived module inbox keeps React StrictMode's repeated initializer safe. */
export class AccountActionInbox {
  private action: AccountActionLink | null;
  constructor(action: AccountActionLink | null) { this.action = action; }
  peek() { return this.action; }
  clear() { this.action = null; }
}

export function parseAuthOptions(value: unknown): AuthOptions {
  if (!value || typeof value !== 'object' || typeof (value as AuthOptions).emailActionsEnabled !== 'boolean' || typeof (value as AuthOptions).requireVerifiedEmail !== 'boolean') throw new Error('服务没有返回有效的账号配置，请重试。');
  const data = value as AuthOptions;
  if (data.requireInvite !== undefined && typeof data.requireInvite !== 'boolean') throw new Error('服务没有返回有效的邀请配置，请重试。');
  return { emailActionsEnabled: data.emailActionsEnabled, requireVerifiedEmail: data.requireVerifiedEmail, requireInvite: data.requireInvite ?? true, legal: parseLegalAvailability(data.legal) };
}

export function canOpenAuthenticatedAccount(options: AuthOptions | null, user: { emailVerified?: boolean } | null, action: AccountActionLink | null): boolean {
  return !!options && !!user && !action && (!options.requireVerifiedEmail || user.emailVerified === true);
}
export function canOpenPrivateWorkspace(options: AuthOptions | null, user: { id?: string; emailVerified?: boolean } | null, action: AccountActionLink | null, consent: StudentConsentStatus | null = null): boolean {
  return canOpenAuthenticatedAccount(options, user, action) && isCurrentStudentConsent(options, user?.id, consent);
}
export function studentAccountEntryStep(options: AuthOptions | null, user: { id?: string; emailVerified?: boolean } | null, action: AccountActionLink | null, consent: StudentConsentStatus | null): 'account-action' | 'auth' | 'email-verification' | 'consent' | 'welcome' {
  if (action && (action.kind !== 'verify-email' || user)) return 'account-action';
  if (!user) return 'auth';
  if (!canOpenAuthenticatedAccount(options, user, action)) return 'email-verification';
  return canOpenPrivateWorkspace(options, user, action, consent) ? 'welcome' : 'consent';
}

export function passwordResetValidation(password: string, confirmation: string): string | null {
  if (password.length < 10 || password.length > 256) return '密码需要 10 到 256 个字符。';
  return password === confirmation ? null : '两次输入的密码不一致。';
}

export const passwordResetAcceptedText = '如果存在该账号，我们会发送找回邮件。';
export const emailActionsDisabledText = '当前服务尚未启用账号邮件，暂时无法发送找回或验证邮件。';

/** No reflected server payloads, token values, or provider error details reach the UI. */
export function accountActionFailure(error: unknown): { text: string; discardToken: boolean } {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ACCOUNT_ACTION_INVALID') return { text: '链接无效、已使用或已过期。验证邮箱时，请确认登录了收到邮件的账号。', discardToken: false };
  if (code === 'ACCOUNT_EMAIL_UNAVAILABLE') return { text: emailActionsDisabledText, discardToken: false };
  if (code === 'INVALID_REQUEST') return { text: '请检查填写的内容。密码需要 10 到 256 个字符。', discardToken: false };
  if (code === 'REQUEST_LIMIT_REACHED') return { text: '操作过于频繁，请稍后再试。', discardToken: false };
  if (error && typeof error === 'object' && 'status' in error && error.status === 401) return { text: '登录已失效，请退出并重新登录收到邮件的账号。', discardToken: false };
  return { text: '操作未完成。请检查连接后重试，或重新申请邮件。', discardToken: false };
}

import { platformAccountId, type LegalAvailability, type PublicLegalDocuments, type StudentAuthOptions, type StudentConsentStatus, type StudentRegistrationInput, type TermsAcceptance } from '@companion/platform-contracts';

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !('value' in item))) return;
  return value as Record<string, unknown>;
}
function version(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 120; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function parseLegalAvailability(value: unknown): LegalAvailability {
  const data = record(value);
  return data?.status === 'available' && version(data.version) && digest(data.digest)
    ? { status: 'available', version: data.version, digest: data.digest } : { status: 'unavailable' };
}
export function parsePublicLegalDocuments(value: unknown): PublicLegalDocuments {
  const data = record(value);
  if (data?.status === 'unavailable') return { status: 'unavailable' };
  const legal = parseLegalAvailability(data), terms = record(data?.terms), privacy = record(data?.privacy);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500_000;
  if (legal.status !== 'available' || !text(terms?.title) || !text(terms?.body) || !text(privacy?.title) || !text(privacy?.body) || !text(data?.dataNotice)) throw new Error('暂时无法读取完整的隐私政策和用户协议。');
  return { ...legal, terms: { title: terms.title, body: terms.body }, privacy: { title: privacy.title, body: privacy.body }, dataNotice: data.dataNotice };
}
export function legalDocumentsMatch(options: StudentAuthOptions | null, documents: PublicLegalDocuments | null): documents is Extract<PublicLegalDocuments, { status: 'available' }> {
  return options?.legal.status === 'available' && documents?.status === 'available' && options.legal.version === documents.version && options.legal.digest === documents.digest;
}
export function termsAcceptance(options: StudentAuthOptions | null, documents: PublicLegalDocuments | null, accepted: boolean): TermsAcceptance {
  if (!accepted || !legalDocumentsMatch(options, documents)) throw new Error('请先阅读并确认当前隐私政策和用户协议。');
  return { accepted: true, version: documents.version, digest: documents.digest };
}
export function studentRegistrationInput(options: StudentAuthOptions | null, documents: PublicLegalDocuments | null, accepted: boolean, input: { email: string; password: string; name: string; inviteCode: string }): StudentRegistrationInput {
  const email = input.email.trim(), inviteCode = input.inviteCode.trim();
  if (!email || input.password.length < 10 || input.password.length > 256) throw new Error('请填写邮箱和至少 10 个字符的密码。');
  if (options?.requireInvite && !inviteCode || inviteCode && !/^[A-Za-z0-9_-]{20,128}$/.test(inviteCode)) throw new Error('请填写收到的邀请码，并使用收到邀请的邮箱。');
  return { email, password: input.password, name: input.name.trim() || email.split('@')[0].slice(0, 80), ...(inviteCode ? { inviteCode } : {}), consent: termsAcceptance(options, documents, accepted) };
}
export function parseStudentConsent(value: unknown, userId: string): StudentConsentStatus {
  const data = record(record(value)?.consent);
  if (!data || !platformAccountId(userId) || data.userId !== userId || !['unavailable', 'required', 'current'].includes(String(data.status)) || !(data.version === null || version(data.version)) || !(data.digest === null || digest(data.digest)) || data.status === 'current' && (!version(data.version) || !digest(data.digest))) throw new Error('服务没有确认当前账号的协议状态，请重试。');
  return { userId, status: data.status as StudentConsentStatus['status'], version: data.version as string | null, digest: data.digest as string | null };
}
export function isCurrentStudentConsent(options: StudentAuthOptions | null, userId: string | undefined, consent: StudentConsentStatus | null): boolean {
  return !!userId && options?.legal.status === 'available' && consent?.userId === userId && consent.status === 'current' && consent.version === options.legal.version && consent.digest === options.legal.digest;
}
export type PublicLegalPage = 'terms' | 'privacy';
export function publicLegalPage(pathname: string): PublicLegalPage | null { return pathname === '/terms' ? 'terms' : pathname === '/privacy' ? 'privacy' : null; }
export function studentEntryFailure(value: unknown): string {
  const code = value && typeof value === 'object' && 'code' in value ? String(value.code) : '';
  if (code === 'INVITE_REQUIRED' || code === 'INVITE_INVALID') return '请填写有效的邀请码，并使用收到邀请的邮箱。邀请码可能已使用或已过期。';
  if (code === 'TERMS_VERSION_CHANGED') return '协议已更新，请刷新后重新阅读并确认。';
  if (code === 'LEGAL_DOCUMENTS_UNAVAILABLE') return '隐私政策和用户协议暂未开放，请稍后重试。';
  if (code === 'EMAIL_EXISTS') return '这个邮箱已有账号，请切换到登录。';
  if (code === 'INVALID_CREDENTIALS') return '邮箱或密码不正确，请检查后重试。';
  if (code === 'REQUEST_LIMIT_REACHED') return '操作过于频繁，请稍后再试。';
  if (code === 'INVALID_REQUEST' || code === 'INVALID_INPUT') return '请检查邮箱、密码和邀请码。密码至少需要 10 个字符。';
  return '操作未完成，请检查填写的信息和连接后重试。';
}

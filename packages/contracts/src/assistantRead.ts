import { parseUuid, type Uuid } from './common.ts';
import type { CandidateProfileSnapshotV2 } from './profileV2.ts';
import type { ProfileDirectoryPersonalV1 } from './profileDirectory.ts';
import { parseResumeLibrarySnapshotV1, type ResumeLibrarySnapshotV1 } from './resumeLibrary.ts';
import { closedRecord, parseCandidateProfileSnapshotV2, parseProfileDirectoryPersonalV1 } from './profileSnapshotValidation.ts';

/** S2-B, ATOMIC L2-T; production activation remains default-off. */
export const ASSISTANT_READ_PORT = 'edaix/assistant-read-v1';
export const ASSISTANT_UI_LOCALES = ['en-US', 'zh-CN'] as const;
export type AssistantUiLocale = typeof ASSISTANT_UI_LOCALES[number];
export const isAssistantUiLocale = (value: unknown): value is AssistantUiLocale => value === 'en-US' || value === 'zh-CN';
export const ASSISTANT_READ_CODES = ['CANCELLED', 'DISABLED', 'LOGIN_REQUIRED', 'UNAVAILABLE', 'RESPONSE_MALFORMED', 'OWNER_CHANGED', 'LOCKED', 'SENDER_REJECTED'] as const;
export type AssistantReadCode = typeof ASSISTANT_READ_CODES[number];
export interface AssistantSessionIdentity { readonly ownerId: Uuid; readonly generation: number }
export interface AssistantReadValues {
  LAYOUT_CONTEXT: { readonly nonce: Uuid; readonly origin: string };
  SESSION: { readonly identity: AssistantSessionIdentity | null; readonly locale: AssistantUiLocale };
  PERSONAL: ProfileDirectoryPersonalV1;
  PROFILE_V2: CandidateProfileSnapshotV2;
  RESUMES: ResumeLibrarySnapshotV1;
  OPEN_PORTAL: null;
  LOGOUT: null;
  SET_LOCALE: AssistantUiLocale;
}
export type AssistantReadOperation = keyof AssistantReadValues;
export type AssistantReadRequest = { readonly kind: 'assistant/read-v1'; readonly id: Uuid } &
  ({ readonly operation: Exclude<AssistantReadOperation, 'SET_LOCALE'> } | { readonly operation: 'SET_LOCALE'; readonly locale: AssistantUiLocale });
export type AssistantReadResponse = { readonly kind: 'assistant/read-result-v1'; readonly id: Uuid } & {
  [K in AssistantReadOperation]: { readonly operation: K } & ({ readonly ok: true; readonly value: AssistantReadValues[K] } | { readonly ok: false; readonly code: AssistantReadCode });
}[AssistantReadOperation];
export interface AssistantPortalLocale { readonly kind: 'assistant/portal-locale-v1'; readonly locale: AssistantUiLocale }
/** Worker -> registered top document only; no account data travels through the host. */
export interface AssistantHostAttest { readonly kind: 'assistant/host-attest-v1'; readonly frameUrl: string }
export interface AssistantHostAttestation { readonly kind: 'assistant/host-attestation-v1'; readonly present: boolean }
export function parseAssistantHostAttest(value: unknown): AssistantHostAttest | null {
  if (!closedRecord(value, ['kind', 'frameUrl']) || value.kind !== 'assistant/host-attest-v1' || typeof value.frameUrl !== 'string') return null;
  const match = /^chrome-extension:\/\/(?:[a-p]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/assistant\.html\?launch=([a-f0-9-]{36})$/.exec(value.frameUrl);
  return match && parseUuid(match[1]) ? value as unknown as AssistantHostAttest : null;
}
export function parseAssistantHostAttestation(value: unknown): AssistantHostAttestation | null {
  return closedRecord(value, ['kind', 'present']) && value.kind === 'assistant/host-attestation-v1' && typeof value.present === 'boolean'
    ? value as unknown as AssistantHostAttestation : null;
}
const operations = ['LAYOUT_CONTEXT', 'SESSION', 'PERSONAL', 'PROFILE_V2', 'RESUMES', 'OPEN_PORTAL', 'LOGOUT', 'SET_LOCALE'];
function pageOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}
export function parseAssistantReadRequest(value: unknown): AssistantReadRequest | null {
  if (!closedRecord(value, ['kind', 'id', 'operation'], ['locale']) || value.kind !== 'assistant/read-v1' || !parseUuid(value.id) || !operations.includes(value.operation as string)) return null;
  if (value.operation === 'SET_LOCALE' ? !isAssistantUiLocale(value.locale) : Object.hasOwn(value, 'locale')) return null;
  return value as unknown as AssistantReadRequest;
}
export function parseAssistantPortalLocale(value: unknown): AssistantPortalLocale | null {
  return closedRecord(value, ['kind', 'locale']) && value.kind === 'assistant/portal-locale-v1' && isAssistantUiLocale(value.locale) ? value as unknown as AssistantPortalLocale : null;
}
export function parseAssistantReadResponse(value: unknown): AssistantReadResponse | null {
  if (!closedRecord(value, ['kind', 'id', 'operation', 'ok'], ['value', 'code']) || value.kind !== 'assistant/read-result-v1' || !parseUuid(value.id) || !operations.includes(value.operation as string)) return null;
  if (value.ok === false) return !Object.hasOwn(value, 'value') && ASSISTANT_READ_CODES.includes(value.code as AssistantReadCode) ? value as unknown as AssistantReadResponse : null;
  if (value.ok !== true || Object.hasOwn(value, 'code')) return null;
  const body = value.value;
  if (value.operation === 'PROFILE_V2' || value.operation === 'PERSONAL') {
    const projected = value.operation === 'PROFILE_V2' ? parseCandidateProfileSnapshotV2(body) : parseProfileDirectoryPersonalV1(body);
    return projected ? { ...value, value: projected } as unknown as AssistantReadResponse : null;
  }
  const valid = value.operation === 'LAYOUT_CONTEXT'
    ? closedRecord(body, ['nonce', 'origin']) && parseUuid(body.nonce) !== null && pageOrigin(body.origin)
    : value.operation === 'SESSION'
    ? closedRecord(body, ['identity', 'locale']) && isAssistantUiLocale(body.locale) &&
      (body.identity === null || (closedRecord(body.identity, ['ownerId', 'generation']) && parseUuid(body.identity.ownerId) !== null && Number.isSafeInteger(body.identity.generation) && Number(body.identity.generation) >= 0))
    : value.operation === 'SET_LOCALE' ? isAssistantUiLocale(body) : body === null;
  if (value.operation === 'RESUMES') {
    // 简历库的解析器对后端先发的加法容错（2026-09-28）：交出去的是它按认得的字段重建的那一份，多出来的成员不往下传。
    const library = parseResumeLibrarySnapshotV1(body);
    return library ? { ...value, value: library } as unknown as AssistantReadResponse : null;
  }
  return valid ? value as unknown as AssistantReadResponse : null;
}

/** Value-free worker notifications cannot carry owner data or credential material. */
export type AssistantReadNotification = { readonly kind: 'assistant/state-invalidated-v1' }
  | { readonly kind: 'assistant/locale-changed-v1'; readonly locale: AssistantUiLocale };
export function parseAssistantReadNotification(value: unknown): AssistantReadNotification | null {
  if (closedRecord(value, ['kind']) && value.kind === 'assistant/state-invalidated-v1') return value as unknown as AssistantReadNotification;
  return closedRecord(value, ['kind', 'locale']) && value.kind === 'assistant/locale-changed-v1' && isAssistantUiLocale(value.locale)
    ? value as unknown as AssistantReadNotification : null;
}

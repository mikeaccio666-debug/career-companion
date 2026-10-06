import { parseUuid } from './common.ts';
import { closedRecord } from './profileSnapshotValidation.ts';
import { parseIntakeStartRequest, parseIntakeTurnRequest, parseIntakeRevisionRequest, parseIntakeCandidateDecisionRequest, parseIntakeConfirmRequest,
  parseIntakeView, parseIntakeEvent, type IntakeView, type IntakeEvent, type IntakeStartRequest, type IntakeTurnRequest,
  type IntakeRevisionRequest, type IntakeCandidateDecisionRequest, type IntakeConfirmRequest } from './profileIntake.ts';
/** Intake shares the existing authenticated Role/Profile port; it never adds a host-page channel. */
export type AssistantIntakeAbort = { readonly kind: 'assistant/intake-abort-v1'; readonly id: string };
export function parseAssistantIntakeAbort(v: unknown): AssistantIntakeAbort | null {
  return closedRecord(v, ['kind', 'id']) && v.kind === 'assistant/intake-abort-v1' && !!parseUuid(v.id) ? v as unknown as AssistantIntakeAbort : null;
}
export const INTAKE_CLIENT_CODES = ['DISABLED', 'LOGIN_REQUIRED', 'OWNER_CHANGED', 'SENDER_REJECTED', 'CANCELLED', 'UNAVAILABLE', 'LOCKED', 'NOT_FOUND',
  'VALIDATION_FAILED', 'RESPONSE_MALFORMED', 'SAVE_UNCERTAIN', 'REVISION_CONFLICT', 'USAGE_EXHAUSTED', 'RATE_LIMITED', 'AUDIO_INVALID', 'LIMIT_REACHED', 'VOICE_DENIED', 'VOICE_NO_DEVICE'] as const;
export type IntakeClientCode = typeof INTAKE_CLIENT_CODES[number];
type Base = { readonly kind: 'assistant/intake-request-v1'; readonly id: string };
export type AssistantIntakeRequest = Base & (
  | { readonly operation: 'CURRENT' }
  | { readonly operation: 'START'; readonly request: IntakeStartRequest }
  | { readonly operation: 'REPLY'; readonly sessionId: string; readonly request: IntakeTurnRequest }
  | { readonly operation: 'CLEAR'; readonly sessionId: string; readonly request: IntakeRevisionRequest }
  | { readonly operation: 'CANCEL'; readonly sessionId: string; readonly turnId: string; readonly request: IntakeRevisionRequest }
  | { readonly operation: 'DECIDE'; readonly sessionId: string; readonly turnId: string; readonly candidateId: string; readonly request: IntakeCandidateDecisionRequest }
  | { readonly operation: 'CONFIRM'; readonly sessionId: string; readonly turnId: string; readonly candidateId: string; readonly request: IntakeConfirmRequest }
);
export type IntakeCommand = AssistantIntakeRequest extends infer R ? R extends AssistantIntakeRequest ? Omit<R, 'kind' | 'id'> : never : never;
export type IntakeResult = { readonly ok: true; readonly value: IntakeView } | { readonly ok: false; readonly code: IntakeClientCode };
export type AssistantIntakeResponse = { readonly kind: 'assistant/intake-result-v1'; readonly id: string } & IntakeResult;
export type AssistantIntakeProgress = { readonly kind: 'assistant/intake-progress-v1'; readonly id: string; readonly event: IntakeEvent };
export function parseAssistantIntakeRequest(v: unknown): AssistantIntakeRequest | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'assistant/intake-request-v1' || !parseUuid(r.id)) return null;
  if (r.operation === 'CURRENT') return closedRecord(r, ['kind', 'id', 'operation']) ? r as unknown as AssistantIntakeRequest : null;
  const base = ['kind', 'id', 'operation', 'request'];
  if (r.operation === 'START') return closedRecord(r, base) && parseIntakeStartRequest(r.request) ? r as unknown as AssistantIntakeRequest : null;
  if (!parseUuid(r.sessionId)) return null;
  if (r.operation === 'REPLY' || r.operation === 'CLEAR') return closedRecord(r, [...base, 'sessionId']) && (r.operation === 'REPLY' ? parseIntakeTurnRequest(r.request) : parseIntakeRevisionRequest(r.request)) ? r as unknown as AssistantIntakeRequest : null;
  if (!parseUuid(r.turnId)) return null;
  if (r.operation === 'CANCEL') return closedRecord(r, [...base, 'sessionId', 'turnId']) && parseIntakeRevisionRequest(r.request) ? r as unknown as AssistantIntakeRequest : null;
  if (typeof r.candidateId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.candidateId)) return null;
  if (r.operation === 'DECIDE' || r.operation === 'CONFIRM') return closedRecord(r, [...base, 'sessionId', 'turnId', 'candidateId']) && (r.operation === 'DECIDE' ? parseIntakeCandidateDecisionRequest(r.request) : parseIntakeConfirmRequest(r.request)) ? r as unknown as AssistantIntakeRequest : null;
  return null;
}
export function parseAssistantIntakeResponse(v: unknown): AssistantIntakeResponse | null {
  if (!v || typeof v !== 'object') return null; const r = v as Record<string, unknown>;
  if (r.kind !== 'assistant/intake-result-v1' || !parseUuid(r.id)) return null;
  if (r.ok === true && closedRecord(r, ['kind', 'id', 'ok', 'value']) && parseIntakeView(r.value)) return r as unknown as AssistantIntakeResponse;
  if (r.ok === false && closedRecord(r, ['kind', 'id', 'ok', 'code']) && INTAKE_CLIENT_CODES.includes(r.code as IntakeClientCode)) return r as unknown as AssistantIntakeResponse;
  return null;
}
export function parseAssistantIntakeProgress(v: unknown): AssistantIntakeProgress | null {
  if (!closedRecord(v, ['kind', 'id', 'event']) || v.kind !== 'assistant/intake-progress-v1' || !parseUuid(v.id)) return null;
  const event = parseIntakeEvent(v.event); return event ? { kind: v.kind, id: v.id as string, event } : null;
}

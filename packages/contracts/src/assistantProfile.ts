import { parseUuid, type Uuid } from './common.ts';
import { PROFILE_V2_MAX_REQUEST_BYTES, type CandidateProfileSnapshotV2, type PatchCandidateProfileV2 } from './profileV2.ts';
import { parseCandidateProfileV2Patch } from './profilePatchValidation.ts';
import { closedRecord, parseCandidateProfileSnapshotV2 } from './profileSnapshotValidation.ts';
import { ASSISTANT_READ_CODES, parseAssistantReadRequest, parseAssistantReadResponse,
  type AssistantReadRequest, type AssistantReadValues } from './assistantRead.ts';

/** S3-A L2-T ATOMIC. Separate default-off protocol; the S2 readonly port gains no write operation. */
export const ASSISTANT_PROFILE_PORT = 'edaix/assistant-profile-v1';
export const ASSISTANT_PROFILE_CODES = [...ASSISTANT_READ_CODES, 'VALIDATION_FAILED', 'REVISION_CONFLICT', 'SAVE_UNCERTAIN', 'READBACK_CHANGED'] as const;
export type AssistantProfileCode = typeof ASSISTANT_PROFILE_CODES[number];
export interface AssistantProfileValues extends AssistantReadValues { PATCH_PROFILE_V2: CandidateProfileSnapshotV2 }
export type AssistantProfileOperation = keyof AssistantProfileValues;
type ReKind<T> = T extends AssistantReadRequest ? Omit<T, 'kind'> & { readonly kind: 'assistant/profile-v1' } : never;
export type AssistantProfileRequest = ReKind<AssistantReadRequest> | {
  readonly kind: 'assistant/profile-v1'; readonly id: Uuid; readonly operation: 'PATCH_PROFILE_V2'; readonly patch: PatchCandidateProfileV2;
};
export type AssistantProfileResponse = { readonly kind: 'assistant/profile-result-v1'; readonly id: Uuid } & {
  [K in AssistantProfileOperation]: { readonly operation: K } & ({ readonly ok: true; readonly value: AssistantProfileValues[K] } | { readonly ok: false; readonly code: AssistantProfileCode });
}[AssistantProfileOperation];

export function parseAssistantProfileRequest(value: unknown): AssistantProfileRequest | null {
  if (!closedRecord(value, ['kind', 'id', 'operation'], ['locale', 'patch']) || value.kind !== 'assistant/profile-v1') return null;
  if (value.operation !== 'PATCH_PROFILE_V2') {
    const read = parseAssistantReadRequest({ ...value, kind: 'assistant/read-v1' });
    return read ? { ...read, kind: 'assistant/profile-v1' } : null;
  }
  if (!closedRecord(value, ['kind', 'id', 'operation', 'patch']) || !parseUuid(value.id)) return null;
  const patch = parseCandidateProfileV2Patch(value.patch);
  if (!patch || new TextEncoder().encode(JSON.stringify(patch)).byteLength > PROFILE_V2_MAX_REQUEST_BYTES) return null;
  return { kind: 'assistant/profile-v1', id: parseUuid(value.id)!, operation: 'PATCH_PROFILE_V2', patch };
}

export function parseAssistantProfileResponse(value: unknown): AssistantProfileResponse | null {
  if (!closedRecord(value, ['kind', 'id', 'operation', 'ok'], ['code', 'value']) || value.kind !== 'assistant/profile-result-v1' || !parseUuid(value.id)) return null;
  if (value.operation !== 'PATCH_PROFILE_V2') {
    const read = parseAssistantReadResponse({ ...value, kind: 'assistant/read-result-v1' });
    return read ? { ...read, kind: 'assistant/profile-result-v1' } : null;
  }
  if (value.ok === false) return !Object.hasOwn(value, 'value') && ASSISTANT_PROFILE_CODES.includes(value.code as AssistantProfileCode)
    ? value as unknown as AssistantProfileResponse : null;
  if (value.ok !== true || Object.hasOwn(value, 'code')) return null;
  const snapshot = parseCandidateProfileSnapshotV2(value.value);
  return snapshot ? { kind: 'assistant/profile-result-v1', id: parseUuid(value.id)!, operation: 'PATCH_PROFILE_V2', ok: true, value: snapshot } : null;
}

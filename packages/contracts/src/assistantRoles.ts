import { parseUuid, type Uuid } from './common.ts';
import type { ConversationBaseView, ConversationStatus, CreateConversationRequest } from './conversations.ts';
import { closedRecord } from './profileSnapshotValidation.ts';
import { ASSISTANT_PROFILE_CODES, parseAssistantProfileRequest, parseAssistantProfileResponse,
  type AssistantProfileRequest, type AssistantProfileValues } from './assistantProfile.ts';
import { isRoleRevision, parseRolePreferencesPatch, parseRolePreferencesSnapshot, upgradeRolePreferences,
  type RolePreferencesPatch, type RolePreferencesSnapshot } from './rolePreferences.ts';

export const ASSISTANT_ROLES_PORT = 'edaix/assistant-roles-v1';
export const ASSISTANT_ROLE_CODES = [...ASSISTANT_PROFILE_CODES, 'NOT_FOUND'] as const;
export type AssistantRoleCode = typeof ASSISTANT_ROLE_CODES[number];
export type AssistantRoleView = Pick<ConversationBaseView, 'id' | 'revision' | 'targetRole' | 'jobPreferences'> & { readonly status: ConversationStatus };
export interface AssistantRolePage { readonly items: readonly AssistantRoleView[]; readonly nextCursor: string | null }
export interface AssistantRoleValues extends AssistantProfileValues {
  LIST_ROLES: AssistantRolePage;
  CREATE_ROLE: { readonly role: AssistantRoleView; readonly created: boolean };
  READ_ROLE_PREFS: RolePreferencesSnapshot;
  PATCH_ROLE_PREFS: RolePreferencesSnapshot;
}
export type AssistantRoleOperation = keyof AssistantRoleValues;
type ReKind<T> = T extends AssistantProfileRequest ? Omit<T, 'kind'> & { readonly kind: 'assistant/roles-v1' } : never;
export type AssistantRoleRequest = ReKind<AssistantProfileRequest> | ({ readonly kind: 'assistant/roles-v1'; readonly id: Uuid } & (
  | { readonly operation: 'LIST_ROLES'; readonly cursor: string | null }
  | { readonly operation: 'CREATE_ROLE'; readonly request: CreateConversationRequest }
  | { readonly operation: 'READ_ROLE_PREFS'; readonly conversationId: Uuid }
  | { readonly operation: 'PATCH_ROLE_PREFS'; readonly conversationId: Uuid; readonly patch: RolePreferencesPatch }
));
export type AssistantRoleResponse = { readonly kind: 'assistant/roles-result-v1'; readonly id: Uuid } & {
  [K in AssistantRoleOperation]: { readonly operation: K } & ({ readonly ok: true; readonly value: AssistantRoleValues[K] } | { readonly ok: false; readonly code: AssistantRoleCode });
}[AssistantRoleOperation];
const operations = ['LIST_ROLES', 'CREATE_ROLE', 'READ_ROLE_PREFS', 'PATCH_ROLE_PREFS'];
const cursorValid = (v: unknown): v is string | null => v === null || typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/\p{Cc}/u.test(v);
export function roleText(value: unknown, max: number): value is string {
  return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value) && value.length > 0 && [...value].length <= max &&
    value === value.normalize('NFC').trim() && !/\p{Cc}/u.test(value);
}
export function parseAssistantRoleView(value: unknown): AssistantRoleView | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, id = parseUuid(v.id);
  if (!id || !isRoleRevision(v.revision) || !roleText(v.targetRole, 120) || !['ACTIVE', 'ARCHIVED'].includes(String(v.status))) return null;
  const prefs = upgradeRolePreferences(v.jobPreferences);
  return prefs ? { id, revision: v.revision, targetRole: v.targetRole, status: v.status as ConversationStatus, jobPreferences: { preferredLocation: prefs.preferredLocation } } : null;
}
export function parseAssistantRoleCreate(value: unknown): CreateConversationRequest | null {
  if (!closedRecord(value, ['clientRequestId', 'kind', 'targetRole', 'title', 'jobPreferences'], ['generationLocale']) ||
    !parseUuid(value.clientRequestId) || value.kind !== 'ROLE' || !roleText(value.targetRole, 120) || value.title !== value.targetRole ||
    value.generationLocale !== undefined && value.generationLocale !== 'en-US' && value.generationLocale !== 'zh-CN') return null;
  const prefs = upgradeRolePreferences(value.jobPreferences);
  return prefs ? { clientRequestId: parseUuid(value.clientRequestId)!, kind: 'ROLE', targetRole: value.targetRole, title: value.targetRole,
    jobPreferences: { preferredLocation: prefs.preferredLocation }, ...(value.generationLocale ? { generationLocale: value.generationLocale } : {}) } : null;
}
export function parseAssistantRoleRequest(value: unknown): AssistantRoleRequest | null {
  if (!closedRecord(value, ['kind', 'id', 'operation'], ['locale', 'patch', 'cursor', 'request', 'conversationId']) || value.kind !== 'assistant/roles-v1' || !parseUuid(value.id)) return null;
  if (!operations.includes(String(value.operation))) {
    const profile = parseAssistantProfileRequest({ ...value, kind: 'assistant/profile-v1' });
    return profile ? { ...profile, kind: 'assistant/roles-v1' } : null;
  }
  const base = { kind: 'assistant/roles-v1' as const, id: parseUuid(value.id)! };
  if (value.operation === 'LIST_ROLES') return closedRecord(value, ['kind', 'id', 'operation', 'cursor']) && cursorValid(value.cursor) ? { ...base, operation: 'LIST_ROLES', cursor: value.cursor } : null;
  if (value.operation === 'CREATE_ROLE') {
    const request = closedRecord(value, ['kind', 'id', 'operation', 'request']) ? parseAssistantRoleCreate(value.request) : null;
    return request ? { ...base, operation: 'CREATE_ROLE', request } : null;
  }
  const conversationId = parseUuid(value.conversationId);
  if (!conversationId) return null;
  if (value.operation === 'READ_ROLE_PREFS') return closedRecord(value, ['kind', 'id', 'operation', 'conversationId']) ? { ...base, operation: 'READ_ROLE_PREFS', conversationId } : null;
  const patch = closedRecord(value, ['kind', 'id', 'operation', 'conversationId', 'patch']) ? parseRolePreferencesPatch(value.patch) : null;
  return patch ? { ...base, operation: 'PATCH_ROLE_PREFS', conversationId, patch } : null;
}
export function parseAssistantRoleResponse(value: unknown): AssistantRoleResponse | null {
  if (!closedRecord(value, ['kind', 'id', 'operation', 'ok'], ['value', 'code']) || value.kind !== 'assistant/roles-result-v1' || !parseUuid(value.id)) return null;
  if (!operations.includes(String(value.operation))) {
    const profile = parseAssistantProfileResponse({ ...value, kind: 'assistant/profile-result-v1' });
    return profile ? { ...profile, kind: 'assistant/roles-result-v1' } : null;
  }
  if (value.ok === false) return !Object.hasOwn(value, 'value') && ASSISTANT_ROLE_CODES.includes(value.code as AssistantRoleCode) ? value as unknown as AssistantRoleResponse : null;
  if (value.ok !== true || Object.hasOwn(value, 'code')) return null;
  const base = { kind: 'assistant/roles-result-v1' as const, id: parseUuid(value.id)!, ok: true as const };
  if (value.operation === 'READ_ROLE_PREFS' || value.operation === 'PATCH_ROLE_PREFS') {
    const snapshot = parseRolePreferencesSnapshot(value.value);
    return snapshot ? { ...base, operation: value.operation, value: snapshot } : null;
  }
  if (value.operation === 'CREATE_ROLE') {
    if (!closedRecord(value.value, ['role', 'created']) || typeof value.value.created !== 'boolean') return null;
    const role = parseAssistantRoleView(value.value.role);
    return role ? { ...base, operation: 'CREATE_ROLE', value: { role, created: value.value.created } } : null;
  }
  if (!closedRecord(value.value, ['items', 'nextCursor']) || !Array.isArray(value.value.items) || value.value.items.length > 50 || !cursorValid(value.value.nextCursor)) return null;
  const items = value.value.items.map(parseAssistantRoleView);
  return items.every((item): item is AssistantRoleView => item !== null) && new Set(items.map(item => item.id)).size === items.length
    ? { ...base, operation: 'LIST_ROLES', value: { items, nextCursor: value.value.nextCursor } } : null;
}

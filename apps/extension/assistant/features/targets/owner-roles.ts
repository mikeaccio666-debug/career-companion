import {
  ROLE_PREFERENCES_MAX_BYTES,
  createConversation,
  getConversation,
  getRolePreferences,
  listConversations,
  parseAssistantRoleCreate,
  parseAssistantRoleRequest,
  parseAssistantRoleResponse,
  parseAssistantRoleView,
  parseRolePreferencesSnapshot,
  parseUuid,
  type AssistantRoleCode,
  type AssistantRoleRequest,
  type AssistantRoleValues,
} from '@edaix/contracts';
import type { OwnerProfileWriterInput } from '../profile/owner-writer';
import { boundedJson, exactOrigin } from '../session/owner-reader';
import { readResult, sameSession, type SessionIdentity } from '../session/read-ports';

export type RoleCommand = Extract<AssistantRoleRequest, { operation: 'LIST_ROLES' | 'CREATE_ROLE' | 'READ_ROLE_PREFS' | 'PATCH_ROLE_PREFS' }>;
export type RoleResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AssistantRoleCode };
type Value = AssistantRoleValues[RoleCommand['operation']];
export interface RolePorts {
  list(cursor: string | null, signal: AbortSignal): Promise<RoleResult<AssistantRoleValues['LIST_ROLES']>>;
  create(request: import('@edaix/contracts').CreateConversationRequest, signal: AbortSignal): Promise<RoleResult<AssistantRoleValues['CREATE_ROLE']>>;
  read(id: import('@edaix/contracts').Uuid, signal: AbortSignal): Promise<RoleResult<AssistantRoleValues['READ_ROLE_PREFS']>>;
  save(id: import('@edaix/contracts').Uuid, patch: import('@edaix/contracts').RolePreferencesPatch, signal: AbortSignal): Promise<RoleResult<AssistantRoleValues['PATCH_ROLE_PREFS']>>;
}
/** Worker only, fixed endpoints, no retry. Every network request rechecks the exact frame and owner. */
export function createOwnerRoles(input: OwnerProfileWriterInput) {
  const origin = input.enabled === true ? exactOrigin(input.apiBase) : null, fetchFn = input.fetchFn ?? fetch;
  return { async execute(identity: SessionIdentity, raw: RoleCommand, caller: AbortSignal, admitted: () => Promise<boolean>): Promise<RoleResult<Value>> {
    const request = parseAssistantRoleRequest(raw);
    const fail = (code: AssistantRoleCode): RoleResult<Value> => ({ ok: false, code });
    if (!request || !['LIST_ROLES', 'CREATE_ROLE', 'READ_ROLE_PREFS', 'PATCH_ROLE_PREFS'].includes(request.operation)) return fail('VALIDATION_FAILED');
    if (!origin) return fail('DISABLED');
    const command = request as RoleCommand;
    let submitted = false;
    const check = async (signal: AbortSignal): Promise<AssistantRoleCode | null> => {
      if (signal.aborted) return submitted ? 'SAVE_UNCERTAIN' : 'CANCELLED';
      if (!await admitted()) return 'SENDER_REJECTED';
      const current = await input.currentSession();
      if (!current) return 'LOGIN_REQUIRED';
      if (!sameSession(identity, current)) return 'OWNER_CHANGED';
      return signal.aborted ? (submitted ? 'SAVE_UNCERTAIN' : 'CANCELLED') : null;
    };
    const phase = async (run: (signal: AbortSignal) => Promise<RoleResult<Value>>) => {
      const signal = AbortSignal.any([caller, AbortSignal.timeout(10_000)]);
      const r = await readResult(async () => ({ ok: true, value: await run(signal) }), signal);
      return r.ok ? r.value : fail(submitted ? 'SAVE_UNCERTAIN' : r.code);
    };
    type HttpResult = { ok: true; data: unknown; status: number } | { ok: false; code: AssistantRoleCode; conflictId?: string };
    const http = async (path: string, method: 'GET' | 'POST' | 'PATCH', signal: AbortSignal, body?: unknown): Promise<HttpResult> => {
      const before = await check(signal); if (before) return { ok: false, code: before };
      const token = await input.accessToken(); if (!token) return { ok: false, code: 'LOGIN_REQUIRED' };
      const ready = await check(signal); if (ready) return { ok: false, code: ready };
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && new TextEncoder().encode(encoded).length > ROLE_PREFERENCES_MAX_BYTES) return { ok: false, code: 'VALIDATION_FAILED' };
      if (method !== 'GET') submitted = true;
      const response = await fetchFn(new URL(path, origin).href, { method, signal, body: encoded, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(encoded ? { 'content-type': 'application/json' } : {}) } });
      const decoded = await boundedJson(response);
      const after = await check(signal); if (after) return { ok: false, code: after };
      if (response.ok && decoded.ok) return { ok: true, data: decoded.value, status: response.status };
      const error = decoded.ok && decoded.value && typeof decoded.value === 'object' ? decoded.value as Record<string, unknown> : {};
      if (response.status === 401) return { ok: false, code: 'LOGIN_REQUIRED' };
      if (response.status === 402 || response.status === 403) return { ok: false, code: 'LOCKED' };
      if (response.status === 404) return { ok: false, code: 'NOT_FOUND' };
      if (response.status === 400 && error.code === 'VALIDATION_FAILED') return { ok: false, code: 'VALIDATION_FAILED' };
      if (response.status === 409 && error.code === 'CONVERSATION_ROLE_CONFLICT') {
        const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
        const id = parseUuid(details.conversationId);
        return { ok: false, code: 'REVISION_CONFLICT', ...(id ? { conflictId: id } : {}) };
      }
      if (response.status === 409 && error.code === 'CONVERSATION_STATE_CONFLICT') return { ok: false, code: 'REVISION_CONFLICT' };
      return { ok: false, code: submitted ? 'SAVE_UNCERTAIN' : 'UNAVAILABLE' };
    };
    const rolePath = (id: string) => getConversation.path.replace(':conversationId', id);
    const prefsPath = (id: string) => getRolePreferences.path.replace(':conversationId', id);
    if (command.operation === 'LIST_ROLES') return phase(async signal => {
      const query = new URLSearchParams({ status: 'ACTIVE', limit: '50', ...(command.cursor ? { cursor: command.cursor } : {}) });
      const r = await http(`${listConversations.path}?${query}`, 'GET', signal); if (!r.ok) return fail(r.code);
      const v = r.data as { schemaVersion?: unknown; items?: unknown; page?: { nextCursor?: unknown; hasMore?: unknown } } | null;
      if (!v || v.schemaVersion !== 1 || !v.page || typeof v.page.hasMore !== 'boolean' || v.page.hasMore !== (v.page.nextCursor !== null)) return fail('RESPONSE_MALFORMED');
      const parsed = parseAssistantRoleResponse({ kind: 'assistant/roles-result-v1', id: command.id, operation: 'LIST_ROLES', ok: true, value: { items: v.items, nextCursor: v.page.nextCursor } });
      return parsed?.ok && parsed.operation === 'LIST_ROLES' && parsed.value.items.every(role => role.status === 'ACTIVE') ? { ok: true, value: parsed.value } : fail('RESPONSE_MALFORMED');
    });
    if (command.operation === 'READ_ROLE_PREFS') return phase(async signal => {
      const r = await http(prefsPath(command.conversationId), 'GET', signal); if (!r.ok) return fail(r.code);
      const value = parseRolePreferencesSnapshot(r.data);
      return value?.conversationId === command.conversationId ? { ok: true, value } : fail('RESPONSE_MALFORMED');
    });
    if (command.operation === 'PATCH_ROLE_PREFS') {
      const saved = await phase(async signal => {
        const r = await http(prefsPath(command.conversationId), 'PATCH', signal, command.patch); if (!r.ok) return fail(r.code);
        const value = parseRolePreferencesSnapshot(r.data);
        return value?.conversationId === command.conversationId && BigInt(value.revision) === BigInt(command.patch.expectedRevision) + 1n &&
          JSON.stringify(value.preferences) === JSON.stringify(command.patch.preferences) ? { ok: true, value } : fail('SAVE_UNCERTAIN');
      });
      if (!saved.ok) return saved;
      return phase(async signal => {
        const r = await http(prefsPath(command.conversationId), 'GET', signal); if (!r.ok) return fail(r.code === 'NOT_FOUND' ? 'SAVE_UNCERTAIN' : r.code);
        const latest = parseRolePreferencesSnapshot(r.data);
        if (!latest) return fail('SAVE_UNCERTAIN');
        return JSON.stringify(latest) === JSON.stringify(saved.value) ? { ok: true, value: latest } : fail('READBACK_CHANGED');
      });
    }
    const create = parseAssistantRoleCreate(command.request); if (!create) return fail('VALIDATION_FAILED');
    let created = false, roleId = '';
    const saved = await phase(async signal => {
      const r = await http(createConversation.path, 'POST', signal, create);
      if (!r.ok) {
        if (r.conflictId) { roleId = r.conflictId; return { ok: true, value: { items: [], nextCursor: null } }; }
        return fail(r.code);
      }
      const data = r.data as { schemaVersion?: unknown; conversation?: unknown } | null;
      const role = data?.schemaVersion === 1 ? parseAssistantRoleView(data.conversation) : null;
      if (!role || role.targetRole !== create.targetRole) return fail('SAVE_UNCERTAIN');
      roleId = role.id; created = r.status === 201;
      return { ok: true, value: { role, created } };
    });
    if (!saved.ok) return saved;
    return phase(async signal => {
      const r = await http(rolePath(roleId), 'GET', signal); if (!r.ok) return fail(r.code);
      const data = r.data as { schemaVersion?: unknown; conversation?: unknown } | null;
      const role = data?.schemaVersion === 1 ? parseAssistantRoleView(data.conversation) : null;
      return role && role.id === roleId ? { ok: true, value: { role, created } } : fail('SAVE_UNCERTAIN');
    });
  } };
}

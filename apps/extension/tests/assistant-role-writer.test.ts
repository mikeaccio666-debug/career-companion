import { describe, expect, it, vi } from 'vitest';
import { parseUuid, parseAssistantRoleRequest } from '@edaix/contracts';
import { createOwnerRoles, type RoleCommand } from '../assistant/features/targets/owner-roles';
const ownerId = parseUuid('10000000-0000-4000-8000-000000000001')!, id = parseUuid('20000000-0000-4000-8000-000000000002')!;
const identity = { ownerId, generation: 1 };
const preferences = { preferredLocation: 'Toronto', workMode: 'REMOTE', salary: null, availableFrom: null };
const command = parseAssistantRoleRequest({ kind: 'assistant/roles-v1', id: ownerId, operation: 'PATCH_ROLE_PREFS', conversationId: id, patch: { expectedRevision: '1', preferences } }) as RoleCommand;
const saved = { schemaVersion: 1, conversationId: id, revision: '2', preferences };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function setup(enabled = true) {
  const currentSession = vi.fn(async () => identity), accessToken = vi.fn(async () => 'fixture-access'), admitted = vi.fn(async () => true);
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(saved));
  const client = createOwnerRoles({ enabled, apiBase: 'https://api.example.test', currentSession, accessToken, fetchFn });
  return { currentSession, accessToken, admitted, fetchFn, execute: (request = command, signal = new AbortController().signal) => client.execute(identity, request, signal, admitted) };
}
describe('Role worker HTTP boundary', () => {
  it('sends one owner PATCH and confirms matching fresh readback', async () => {
    const h = setup(); expect(await h.execute()).toEqual({ ok: true, value: saved });
    expect(h.fetchFn.mock.calls.map(([, init]) => init!.method)).toEqual(['PATCH', 'GET']);
    expect(h.fetchFn.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
  });
  it('rejects disabled, stale frame and changed owner before submitting', async () => {
    const off = setup(false); expect(await off.execute()).toMatchObject({ code: 'DISABLED' }); expect(off.fetchFn).not.toHaveBeenCalled();
    const frame = setup(); frame.accessToken.mockImplementation(async () => { frame.admitted.mockResolvedValue(false); return 'fixture-access'; });
    expect(await frame.execute()).toMatchObject({ code: 'SENDER_REJECTED' }); expect(frame.fetchFn).not.toHaveBeenCalled();
    const owner = setup(); owner.accessToken.mockImplementation(async () => { owner.currentSession.mockResolvedValue({ ownerId, generation: 2 }); return 'fixture-access'; });
    expect(await owner.execute()).toMatchObject({ code: 'OWNER_CHANGED' }); expect(owner.fetchFn).not.toHaveBeenCalled();
  });
  it('never retries conflicts, transport failures, or a changed readback', async () => {
    const conflict = setup(); conflict.fetchFn.mockResolvedValue(json({ code: 'CONVERSATION_STATE_CONFLICT' }, 409));
    expect(await conflict.execute()).toEqual({ ok: false, code: 'REVISION_CONFLICT' }); expect(conflict.fetchFn).toHaveBeenCalledOnce();
    const lost = setup(); lost.fetchFn.mockRejectedValue(new Error('private detail'));
    expect(await lost.execute()).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' }); expect(lost.fetchFn).toHaveBeenCalledOnce();
    const changed = setup(); changed.fetchFn.mockResolvedValueOnce(json(saved)).mockResolvedValueOnce(json({ ...saved, revision: '3' }));
    expect(await changed.execute()).toEqual({ ok: false, code: 'READBACK_CHANGED' });
  });
  it('refuses another role snapshot and late canceled responses', async () => {
    const foreign = setup(); foreign.fetchFn.mockResolvedValue(json({ ...saved, conversationId: ownerId }));
    expect(await foreign.execute()).toMatchObject({ code: 'SAVE_UNCERTAIN' });
    const canceled = setup(), abort = new AbortController();
    canceled.fetchFn.mockImplementation(async () => { abort.abort(); return json(saved); });
    expect(await canceled.execute(command, abort.signal)).toMatchObject({ code: 'SAVE_UNCERTAIN' });
    expect(canceled.fetchFn).toHaveBeenCalledOnce();
  });
  it('resolves a duplicate create through the returned owned ID without writing its preferences', async () => {
    const h = setup(), role = { id, revision: '4', targetRole: 'Designer', status: 'ACTIVE', jobPreferences: { preferredLocation: 'Boston' } };
    h.fetchFn.mockResolvedValueOnce(json({ code: 'CONVERSATION_ROLE_CONFLICT', details: { conversationId: id } }, 409)).mockResolvedValueOnce(json({ schemaVersion: 1, conversation: role }));
    const create = parseAssistantRoleRequest({ kind: 'assistant/roles-v1', id: ownerId, operation: 'CREATE_ROLE', request: { clientRequestId: ownerId, kind: 'ROLE', targetRole: 'Designer', title: 'Designer', jobPreferences: { preferredLocation: 'Toronto' } } }) as RoleCommand;
    expect(await h.execute(create)).toEqual({ ok: true, value: { role, created: false } });
    expect(h.fetchFn.mock.calls.map(([, init]) => init!.method)).toEqual(['POST', 'GET']);
  });
});

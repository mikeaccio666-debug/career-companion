import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { parseCandidateProfileV2Patch } from '@edaix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ messages: [] as any[], receive: null as any, gone: null as any, disconnect: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: () => ({
  onMessage: { addListener: (fn: any) => { h.receive = fn; } }, onDisconnect: { addListener: (fn: any) => { h.gone = fn; } },
  postMessage: (m: unknown) => h.messages.push(m), disconnect: h.disconnect,
}) } } }));
import { createAssistantReadClient } from '../assistant/runtime/client';
const reply = (m: any, value: unknown = null) => h.receive({ kind: 'assistant/read-result-v1', id: m.id, operation: m.operation, ok: true, value });
beforeEach(() => { h.messages = []; h.disconnect.mockClear(); });
afterEach(() => vi.restoreAllMocks());
describe('runtime response lifetime', () => {
  it('distinguishes malformed replies from browser disconnects without logging payloads', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() });
    const pending = c.ports.session(new AbortController().signal);
    h.receive({ token: 'private-canary', html: '<private>' }); await pending;
    expect(log.mock.calls).toEqual([['[ArgoLand.AI]', 'CLIENT_RESPONSE_MALFORMED']]);
    log.mockClear(); const retried = c.ports.session(new AbortController().signal);
    h.gone(); await retried;
    expect(log.mock.calls).toEqual([['[ArgoLand.AI]', 'CLIENT_PORT_DISCONNECTED']]);
    c.dispose();
  });
  it('clears reads on invalidation while permitting logout acknowledgement', async () => {
    const invalidated = vi.fn(), c = createAssistantReadClient({ invalidated, locale: vi.fn() });
    const promise = c.ports.logout(new AbortController().signal); const m = h.messages[0];
    h.receive({ kind: 'assistant/state-invalidated-v1' }); reply(m);
    expect(await promise).toEqual({ ok: true, value: undefined });
    expect(invalidated).toHaveBeenCalledExactlyOnceWith('OWNER_CHANGED'); expect(h.disconnect).not.toHaveBeenCalled();
    h.gone(); expect(invalidated).toHaveBeenLastCalledWith('UNAVAILABLE'); c.dispose();
  });
  it('ignores one late cancelled response without accepting unsolicited responses', async () => {
    const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() }), abort = new AbortController();
    const promise = c.ports.session(abort.signal), m = h.messages[0]; abort.abort(); await promise;
    reply(m, { identity: null, locale: 'en-US' }); expect(h.disconnect).not.toHaveBeenCalled();
    reply(m, { identity: null, locale: 'en-US' }); expect(h.disconnect).toHaveBeenCalledOnce(); c.dispose();
  });
});


describe('dedicated Profile save client', () => {
  const patch = parseCandidateProfileV2Patch({ schemaVersion: 2, expectedRevision: '1', expectedDeletionEpoch: '0', fields: { summary: 'Owner edit' } })!;
  it('keeps writes disabled for existing readonly clients', async () => {
    const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() });
    expect(await c.saveProfile(patch, new AbortController().signal)).toEqual({ ok: false, code: 'DISABLED' });
    expect(h.messages).toEqual([]); c.dispose();
  });
  it('uses the dedicated protocol, preserves typed conflicts and never resends a cancelled write', async () => {
    const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() }, { profileEditing: true });
    const p = c.saveProfile(patch, new AbortController().signal), m = h.messages[0];
    expect(m).toMatchObject({ kind: 'assistant/profile-v1', operation: 'PATCH_PROFILE_V2', patch });
    h.receive({ kind: 'assistant/profile-result-v1', id: m.id, operation: m.operation, ok: false, code: 'REVISION_CONFLICT' });
    expect(await p).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    const abort = new AbortController(), pending = c.saveProfile(patch, abort.signal), second = h.messages[1];
    abort.abort(); expect(await pending).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' });
    h.receive({ kind: 'assistant/profile-result-v1', id: second.id, operation: second.operation, ok: false, code: 'SAVE_UNCERTAIN' });
    expect(h.messages).toHaveLength(2); expect(h.disconnect).not.toHaveBeenCalled(); c.dispose();
  });
});

it('keeps a save pending through the separate PATCH and readback budgets', async () => {
  vi.useFakeTimers();
  const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() }, { profileEditing: true });
  try {
    const patch = parseCandidateProfileV2Patch({ schemaVersion: 2, expectedRevision: '1', expectedDeletionEpoch: '0', fields: { summary: 'Owner edit' } })!;
    let settled = false;
    const pending = c.saveProfile(patch, new AbortController().signal).then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(settled).toBe(false);
    const m = h.messages[0], value = fictionalProfileSnapshot('Fictional owner');
    h.receive({ kind: 'assistant/profile-result-v1', id: m.id, operation: m.operation, ok: true, value });
    expect(await pending).toEqual({ ok: true, value }); expect(h.messages).toHaveLength(1);
  } finally { c.dispose(); vi.useRealTimers(); }
});

it('does not cancel private layout bootstrap when account state is invalidated', async () => {
  const c = createAssistantReadClient({ invalidated: vi.fn(), locale: vi.fn() });
  const pending = c.layoutContext(), m = h.messages[0];
  h.receive({ kind: 'assistant/state-invalidated-v1' });
  const value = { nonce: '30000000-0000-4000-8000-000000000001', origin: 'https://host.example.test' };
  reply(m, value);
  expect(await pending).toEqual(value); c.dispose();
});

it('aborts a pending Autofill START with STOP and never replays it after invalidation',async()=>{
 const c=createAssistantReadClient({invalidated:vi.fn(),locale:vi.fn()},{roleManagement:true});
 const id=crypto.randomUUID(),selection={batchId:id,preparationId:id,missionId:id,resumeVersionId:id},abort=new AbortController();
 const pending=c.autofillPorts.execute('START',selection,abort.signal,id);abort.abort();
 expect(await pending).toEqual({ok:false,code:'RESULT_UNKNOWN'});
 expect(h.messages.map(m=>m.operation)).toEqual(['START','STOP']);
 h.receive({kind:'assistant/state-invalidated-v1'});
 expect(h.messages.filter(m=>m.operation==='START')).toHaveLength(1);c.dispose();
});

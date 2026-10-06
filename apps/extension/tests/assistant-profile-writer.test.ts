import { describe, expect, it, vi } from 'vitest';
import { parseUuid, parseCandidateProfileV2Patch } from '@edaix/contracts';
import { createOwnerProfileWriter } from '../assistant/features/profile/owner-writer';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';

const identity = { ownerId: parseUuid('10000000-0000-4000-8000-000000000001')!, generation: 1 };
const patch = parseCandidateProfileV2Patch({ schemaVersion: 2, expectedRevision: '1', expectedDeletionEpoch: '0', fields: { summary: 'Updated' } })!;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function setup(enabled = true) {
  const saved = structuredClone(fictionalProfileSnapshot('Fictional owner'))!;
  (saved as any).revision = '2'; (saved.profile as any).summary = 'Updated';
  const currentSession = vi.fn(async () => identity);
  const accessToken = vi.fn(async () => 'fictional-access');
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(saved));
  const admitted = vi.fn(async () => true);
  const writer = createOwnerProfileWriter({ enabled, apiBase: 'https://api.example.test', currentSession, accessToken, fetchFn });
  const save = (signal = new AbortController().signal) => writer.patch(identity, patch, signal, admitted);
  return { saved, currentSession, accessToken, fetchFn, admitted, save };
}
describe('assistant owner Profile save', () => {
  it('performs one authorized PATCH and verifies a fresh owner GET before reporting saved', async () => {
    const h = setup(); expect(await h.save()).toEqual({ ok: true, value: h.saved });
    expect(h.fetchFn.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(['PATCH', 'GET']);
    const init = h.fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(init.body as string)).toEqual(patch);
    expect(init.headers).toEqual(expect.objectContaining({ authorization: 'Bearer fictional-access' }));
  });
  it('fails closed before any write when disabled or the window changes while obtaining credentials', async () => {
    const off = setup(false); expect(await off.save()).toMatchObject({ ok: false, code: 'DISABLED' }); expect(off.fetchFn).not.toHaveBeenCalled();
    const h = setup(); h.accessToken.mockImplementation(async () => { h.admitted.mockResolvedValue(false); return 'fictional-access'; });
    expect(await h.save()).toMatchObject({ ok: false, code: 'SENDER_REJECTED' }); expect(h.fetchFn).not.toHaveBeenCalled();
  });
  it('rejects an owner change during token lookup and never sends it with the previous owner draft', async () => {
    const h = setup(); h.accessToken.mockImplementation(async () => { h.currentSession.mockResolvedValue({ ...identity, generation: 2 }); return 'fictional-access'; });
    expect(await h.save()).toMatchObject({ ok: false, code: 'OWNER_CHANGED' }); expect(h.fetchFn).not.toHaveBeenCalled();
  });
  it.each(['PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH'])('returns a typed conflict for %s and does not retry', async code => {
    const h = setup(); h.fetchFn.mockResolvedValue(json({ code }, 409));
    expect(await h.save()).toEqual({ ok: false, code: 'REVISION_CONFLICT' }); expect(h.fetchFn).toHaveBeenCalledOnce();
  });
  it('never retries a write after a network failure, malformed success, or authentication rejection', async () => {
    const h = setup(); h.fetchFn.mockRejectedValue(new Error('do not expose arbitrary response detail'));
    expect(await h.save()).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' }); expect(h.fetchFn).toHaveBeenCalledOnce();
    const malformed = setup(); malformed.fetchFn.mockResolvedValue(json({ ok: true }));
    expect(await malformed.save()).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' }); expect(malformed.fetchFn).toHaveBeenCalledOnce();
    const denied = setup(); denied.fetchFn.mockResolvedValue(json({ code: 'LOGIN_REQUIRED' }, 401));
    expect(await denied.save()).toEqual({ ok: false, code: 'LOGIN_REQUIRED' }); expect(denied.fetchFn).toHaveBeenCalledOnce();
  });
  it('does not claim success if the readback changed or the owner expired after the write', async () => {
    const h = setup(); h.fetchFn.mockResolvedValueOnce(json(h.saved)).mockResolvedValueOnce(json({ ...h.saved, revision: '3' }));
    expect(await h.save()).toEqual({ ok: false, code: 'READBACK_CHANGED' });
    const changed = setup(); changed.fetchFn.mockImplementation(async () => { changed.currentSession.mockResolvedValue({ ...identity, generation: 2 }); return json(changed.saved); });
    expect(await changed.save()).toEqual({ ok: false, code: 'OWNER_CHANGED' }); expect(changed.fetchFn).toHaveBeenCalledOnce();
  });
  it('bounds a hanging request and distinguishes cancellation before versus after submission', async () => {
    const before = new AbortController(); before.abort(); const h = setup();
    expect(await h.save(before.signal)).toEqual({ ok: false, code: 'CANCELLED' }); expect(h.fetchFn).not.toHaveBeenCalled();
    const during = new AbortController(); const pending = setup();
    pending.fetchFn.mockImplementation(() => { during.abort(); return new Promise(() => {}); });
    expect(await pending.save(during.signal)).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' }); expect(pending.fetchFn).toHaveBeenCalledOnce();
  });
});

it('gives a slow committed PATCH and its readback separate ten-second budgets', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
  });
  try {
    const h = setup();
    h.fetchFn.mockImplementation(async () => { await new Promise(r => setTimeout(r, 9_000)); return json(h.saved); });
    const saving = h.save();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    const first = h.fetchFn.mock.calls[0]![1]!.signal, second = h.fetchFn.mock.calls[1]![1]!.signal;
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await saving).toEqual({ ok: true, value: h.saved });
    expect(first!.aborted).toBe(true); expect(second!.aborted).toBe(false);
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

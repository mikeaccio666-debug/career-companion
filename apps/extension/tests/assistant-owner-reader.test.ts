import { describe, expect, it, vi } from 'vitest';
import { AGENT_ENDPOINTS, parseUuid } from '@edaix/contracts';
import { createProfileDirectoryClient } from '../lib/profileDirectoryClient';
import type { DirectoryResponseText } from '../lib/profileDirectoryTransport';
import { createOwnerReader } from '../assistant/features/session/owner-reader';

const A = { ownerId: parseUuid('10000000-0000-4000-8000-000000000001')!, generation: 1 };
const body = { schemaVersion: 1, libraryRevision: '0', defaultTrackId: null, tracks: [] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function setup() {
  let identity = A;
  const fetchFn = vi.fn(async () => response(body));
  const accessToken = vi.fn(async () => 'fictional-access');
  const refreshAccessToken = vi.fn(async () => 'fictional-refreshed');
  const directoryRun = vi.fn(async () => ({ ok: true as const, text: JSON.stringify({
    schemaVersion: 1, revision: '0', deletionEpoch: '0', updatedAt: null,
    fields: { firstName: null, lastName: null, fullName: null, preferredName: null,
      email: null, phone: null, linkedinUrl: null, githubUrl: null, portfolioUrl: null, city: null, location: null },
  }) as DirectoryResponseText }));
  const options = { enabled: true, apiBase: 'https://api.example.test', fetchFn: fetchFn as typeof fetch,
    currentSession: async () => identity, accessToken, refreshAccessToken,
    directory: createProfileDirectoryClient({ run: directoryRun }) };
  return { options, reader: createOwnerReader(options), fetchFn, accessToken, refreshAccessToken, directoryRun,
    changeOwner: () => { identity = { ...A, generation: 2 }; } };
}

describe('assistant worker-only owner reads', () => {
  it('defaults off and sends nothing for a missing or invalid origin', async () => {
    const h = setup();
    for (const override of [{ enabled: false }, { enabled: undefined }, { apiBase: null }, { apiBase: 'https://api.example.test/unreviewed-path' }]) {
      const reader = createOwnerReader({ ...h.options, ...override });
      expect(await reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'DISABLED' });
    }
    expect(h.accessToken).not.toHaveBeenCalled(); expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('uses only the existing owner library GET and shared response parser', async () => {
    const h = setup();
    expect(await h.reader.resumes(A, new AbortController().signal)).toEqual({ ok: true, value: body });
    expect(h.fetchFn).toHaveBeenCalledWith('https://api.example.test' + AGENT_ENDPOINTS.getResumeLibrary.path,
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { accept: 'application/json', authorization: 'Bearer fictional-access' } }));
    // 2026-09-28：共用的解析器对后端先发的加法容错——多出来的成员不拒整份，但也不往下传（结果按认得的字段重建）。
    h.fetchFn.mockImplementation(async () => response({ ...body, storageKey: 'private' }));
    const tolerated = await h.reader.resumes(A, new AbortController().signal);
    expect(tolerated).toEqual({ ok: true, value: body });
    expect(JSON.stringify(tolerated)).not.toContain('storageKey');
    // 认得的字段坏了照旧整份不要。
    h.fetchFn.mockImplementation(async () => response({ ...body, libraryRevision: -1 }));
    expect(await h.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'RESPONSE_MALFORMED' });
  });

  it('rejects a changed session both before spending a token and after the response', async () => {
    const h = setup(); h.changeOwner();
    expect(await h.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'OWNER_CHANGED' });
    expect(h.accessToken).not.toHaveBeenCalled();
    const other = setup(); other.fetchFn.mockImplementation(async () => { other.changeOwner(); return response(body); });
    expect(await other.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'OWNER_CHANGED' });
  });

  it('retries only the documented login-required 401, once, under the same session', async () => {
    const h = setup(); h.fetchFn.mockResolvedValueOnce(response({ code: 'LOGIN_REQUIRED' }, 401)).mockResolvedValueOnce(response(body));
    expect((await h.reader.resumes(A, new AbortController().signal)).ok).toBe(true);
    expect(h.refreshAccessToken).toHaveBeenCalledTimes(1);
    const other = setup(); other.fetchFn.mockResolvedValue(response({ code: 'SOMETHING_ELSE' }, 401));
    expect(await other.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'LOGIN_REQUIRED' });
    expect(other.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('bounds response bytes, cancellation and untrusted thrown text', async () => {
    const h = setup();
    h.fetchFn.mockResolvedValue(new Response('x'.repeat(1024 * 1024), { headers: { 'content-type': 'application/json' } }));
    expect(await h.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'RESPONSE_MALFORMED' });
    h.fetchFn.mockRejectedValue(new Error('private content must not escape'));
    expect(await h.reader.resumes(A, new AbortController().signal)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const signal = AbortSignal.abort();
    expect(await h.reader.resumes(A, signal)).toEqual({ ok: false, code: 'CANCELLED' });
  });

  it('uses the bounded personal GET and rejects unknown 401s without refreshing', async () => {
    const h = setup();
    h.fetchFn.mockResolvedValue(response({ code: 'UNKNOWN' }, 401));
    expect(await h.reader.personal(A, new AbortController().signal)).toEqual({ ok: false, code: 'LOGIN_REQUIRED' });
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
    expect(h.fetchFn).toHaveBeenCalledExactlyOnceWith('https://api.example.test/users/me/profile-directory/personal', expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });
});

import { describe, expect, it, vi } from 'vitest';

import { OWNER_PROFILE_V2_ENDPOINTS, getResumeLibrary, setDefaultResumeTrack } from '@edaix/contracts';

/** 资料编辑器还要读简历库、设默认简历（2026-09-23）：那两条在简历库的契约里，不在 owner profile 表里。 */
const ENDPOINTS = { ...OWNER_PROFILE_V2_ENDPOINTS, getResumeLibrary, setDefaultResumeTrack } as const;
import {
  PROFILE_DIRECTORY_OPERATIONS,
  PROFILE_DIRECTORY_ROUTES,
  createProfileDirectoryTransport,
  type ProfileDirectoryOperation,
} from '../lib/profileDirectoryTransport';

const apiBase = 'https://api.test.invalid';

function harness(responses: readonly { status?: number; body?: string; contentType?: string }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const next = queue.shift() ?? { status: 200, body: '{}' };
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: () => next.contentType ?? 'application/json' },
      text: async () => next.body ?? '{}',
    } as unknown as Response;
  });
  const transport = createProfileDirectoryTransport({
    apiBase, getAccessToken: async () => 'token', fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { transport, calls };
}

describe('the worker half', () => {
  it('exposes operations, never a URL, so a taken-over panel cannot aim the token', () => {
    // Every reachable address is named here, in reviewed code. `run` accepts an
    // operation and nothing else; there is no parameter a caller could put a
    // path into.
    expect(Object.keys(PROFILE_DIRECTORY_ROUTES).sort()).toEqual([...PROFILE_DIRECTORY_OPERATIONS].sort());
    for (const [, path] of Object.values(PROFILE_DIRECTORY_ROUTES)) {
      // 两种前缀都是我们自己 API 上、这里点名的地址：档案走 owner 路由，EEO 在 argoland
      // 只有 agent 路由（/users/me/… 在生产上 404，2026-09-21 实测）。
      expect(path.startsWith('/users/me/') || path.startsWith('/api/v1/agent/')).toBe(true);
    }
  });

  it('routes every operation to the path the contract declares', () => {
    const declared = {
      PERSONAL_READ: 'getOwnerProfileDirectoryPersonalV1',
      PERSONAL_SAVE: 'replaceOwnerProfileDirectoryPersonalV1',
      WORK_AUTHORIZATION_READ: 'getOwnerProfileDirectoryWorkAuthorizationV1',
      WORK_AUTHORIZATION_SAVE: 'replaceOwnerProfileDirectoryWorkAuthorizationV1',
      EEO_READ: 'getOwnerEeoSelfIdentificationV1',
      EEO_SAVE: 'replaceOwnerEeoSelfIdentificationV1',
      PREFERENCES_READ: 'getOwnerProfileDirectoryPreferencesV1',
      PREFERENCES_SAVE: 'replaceOwnerProfileDirectoryPreferencesV1',
      PROFILE_V2_READ: 'getOwnerApplicationProfileV2',
      PROFILE_V2_SAVE: 'patchOwnerApplicationProfileV2',
      SIGNING_CONSENT_READ: 'getOwnerApplicationSigningConsentV1',
      SIGNING_CONSENT_GRANT: 'grantOwnerApplicationSigningConsentV1',
      SIGNING_CONSENT_REVOKE: 'revokeOwnerApplicationSigningConsentV1',
      RESUME_LIBRARY_READ: 'getResumeLibrary',
      RESUME_DEFAULT_SET: 'setDefaultResumeTrack',
    } as const satisfies Record<ProfileDirectoryOperation, keyof typeof ENDPOINTS>;

    // The worker writes the paths out instead of importing the endpoint table,
    // which would cost it 22KB of definitions it never calls. That is only safe
    // while this comparison holds.
    for (const [operation, endpointId] of Object.entries(declared)) {
      const [method, path] = PROFILE_DIRECTORY_ROUTES[operation as ProfileDirectoryOperation];
      expect(path).toBe(ENDPOINTS[endpointId].path);
      expect(method).toBe(ENDPOINTS[endpointId].method);
    }
  });

  it('hands the answer back as text, which has no fields to read off it', async () => {
    const { transport } = harness([{ body: '{"schemaVersion":1,"revision":"4"}' }]);
    const result = await transport.run('PERSONAL_READ');

    expect(result).toEqual({ ok: true, text: '{"schemaVersion":1,"revision":"4"}' });
    // The point of the shape: a caller cannot reach a value without going
    // through the panel side's parser first.
    if (result.ok) expect(typeof result.text).toBe('string');
  });

  it('carries the bearer token and never leaks it into the result', async () => {
    const { transport, calls } = harness([{ body: '{}' }]);
    const result = await transport.run('PERSONAL_READ');

    expect(calls[0]!.headers['authorization']).toBe('Bearer token');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('reports a save someone else got in front of, instead of retrying over them', async () => {
    const { transport, calls } = harness([{ status: 412, body: '{}' }]);
    expect(await transport.run('PERSONAL_SAVE', { schemaVersion: 1 })).toEqual({ ok: false, code: 'STALE' });
    expect(calls).toHaveLength(1);
  });

  it('stays off entirely until an API origin is configured', async () => {
    const transport = createProfileDirectoryTransport({
      apiBase: null, getAccessToken: async () => 'token',
      fetchFn: (() => { throw new Error('must not be called'); }) as unknown as typeof fetch,
    });
    expect(await transport.run('PERSONAL_READ')).toEqual({ ok: false, code: 'DISABLED' });
  });

  it('spends no token on an operation it has no route for', async () => {
    const getAccessToken = vi.fn(async () => 'token');
    const transport = createProfileDirectoryTransport({
      apiBase, getAccessToken,
      fetchFn: (() => { throw new Error('must not be called'); }) as unknown as typeof fetch,
    });
    expect(await transport.run('NOT_AN_OPERATION' as ProfileDirectoryOperation))
      .toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});

describe('答复的大小上限跟着契约的容量走（2026-09-27）', () => {
  // 负责人的新账号（简历导入，104 条技能、8 个项目、6 段教育、6 段经历）完整档案 144,659 字节；从前的上限是 128 KB，
  // 于是 worker 把一次正常的 200 丢掉、报 UNAVAILABLE：资料编辑器「暂时读不到你的资料」，填写时经历与教育也一起读不出来。
  // 契约允许 120 条技能、24 段经历与 40 个项目（描述各 12,000 字）……整份可以到 3 MB 多，上限按它定。
  // `{"padding":""}` 是 14 个字节：生成的答复正好 `bytes` 字节。
  const body = (bytes: number) => JSON.stringify({ padding: 'x'.repeat(Math.max(0, bytes - 14)) });

  it('一份 141 KB 的档案照常交回', async () => {
    const { transport } = harness([{ status: 200, body: body(144_659) }]);
    const result = await transport.run('PROFILE_V2_READ');
    expect(result.ok).toBe(true);
  });

  it('3.5 MB 也照常交回（契约容量之内）', async () => {
    const { transport } = harness([{ status: 200, body: body(3_500_000) }]);
    expect((await transport.run('PROFILE_V2_READ')).ok).toBe(true);
  });

  it('超过 4 MiB 才拒，而且说出是太大，不混进 UNAVAILABLE', async () => {
    const { transport } = harness([{ status: 200, body: body(4 * 1024 * 1024 + 1) }]);
    expect(await transport.run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'RESPONSE_TOO_LARGE' });
  });
});

/**
 * 2026-10-04：资料编辑器的读与存各有时限（8 秒），到点了从前也报 UNAVAILABLE（「暂时读不到」），分不出是后端卡住；
 * argoland #710：门户正在保存档案的同一刻，存（PATCH）等不到锁就答可重试的 503 AGENT_UNAVAILABLE——等约 1 秒再试一次。
 */
describe('到点与「资料正在别处保存」', () => {
  it('到点没答完：答 TIMEOUT，不混进 UNAVAILABLE', async () => {
    const transport = createProfileDirectoryTransport({
      apiBase,
      getAccessToken: async () => 'token',
      timeoutMs: 30,
      fetchFn: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch,
    });
    expect(await transport.run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(await transport.run('PROFILE_V2_SAVE', { schemaVersion: 2 })).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  const busyTransport = (statuses: readonly number[]) => {
    const waits: number[] = [];
    let hits = 0;
    const transport = createProfileDirectoryTransport({
      apiBase,
      getAccessToken: async () => 'token',
      sleep: async (ms) => { waits.push(ms); },
      fetchFn: (async () => {
        const status = statuses[Math.min(hits, statuses.length - 1)]!;
        hits += 1;
        const body = status === 503 ? '{"code":"AGENT_UNAVAILABLE","statusCode":503}' : '{"schemaVersion":2}';
        return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => body } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    return { transport, waits, hits: () => hits };
  };

  it('门户正在保存（503 AGENT_UNAVAILABLE）：等约 1 秒再试一次，成了照常交回', async () => {
    const h = busyTransport([503, 200]);
    expect(await h.transport.run('PROFILE_V2_SAVE', { schemaVersion: 2 })).toEqual({ ok: true, text: '{"schemaVersion":2}' });
    expect(h.hits()).toBe(2);
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0]!).toBeGreaterThanOrEqual(800);
    expect(h.waits[0]!).toBeLessThanOrEqual(1200);
  });

  it('再试一次还在保存：答 BUSY，只试这一次', async () => {
    const h = busyTransport([503, 503, 200]);
    expect(await h.transport.run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'BUSY' });
    expect(h.hits()).toBe(2);
  });
});

describe('失败的答复带上那一次请求（2026-10-04，体检 11-3）', () => {
  it('非 2xx：交回状态码与服务端的 x-request-id（只进诊断）；不像请求号的不带', async () => {
    const answer = (requestId: string) => vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: (name: string) => (name === 'x-request-id' ? requestId : 'application/json') },
      text: async () => '{"message":"student@example.com"}',
    }) as unknown as Response);
    const run = (fetchFn: ReturnType<typeof answer>) => createProfileDirectoryTransport({
      apiBase, getAccessToken: async () => 'token', fetchFn: fetchFn as unknown as typeof fetch,
    }).run('EEO_READ');
    await expect(run(answer('req-0123456789'))).resolves.toEqual({ ok: false, code: 'UNAVAILABLE', status: 503, requestId: 'req-0123456789' });
    await expect(run(answer('https://evil.example/x'))).resolves.toEqual({ ok: false, code: 'UNAVAILABLE', status: 503 });
  });
});

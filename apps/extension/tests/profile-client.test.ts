import { describe, expect, it } from 'vitest';

import { APPLICATION_PROFILE_FIELD_KEYS, APPLICATION_PROFILE_FIELD_KEYS_HEADER } from '@edaix/contracts';
import { PROFILE_CLIENT_DIAG_CODES, createProfileProvider, type ProfileBinding } from '../lib/profileClient';

/**
 * 刀九特征测试（2026-08-15 按 §5.8 契约切片 e4191043 重写）：
 * header 绑定、exact-shape、三道相等校验（fieldSchemaVersion/fieldKeys/
 * profile 三元——失配 = stale 停止填表）、敏感键整份拒收（C-b 绊线）、
 * 401 看码分流、fail-closed 分支、Data-L1（值不出诊断口）。
 */

const BINDING: ProfileBinding = {
  fieldKeys: ['email', 'firstName', 'lastName', 'phone'],
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '12',
    deletionEpoch: '2',
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
};

/** §5.8 exact shape：profile 恒带齐 11 键（未选中的为 null）。 */
function fullProfile(values: Record<string, string | null>): Record<string, string | null> {
  const profile: Record<string, string | null> = {};
  for (const key of APPLICATION_PROFILE_FIELD_KEYS) profile[key] = null;
  return { ...profile, ...values };
}

const GOOD_BODY = {
  schemaVersion: 1,
  fieldSchemaVersion: 1,
  fieldKeys: [...BINDING.fieldKeys],
  revision: '12',
  deletionEpoch: '2',
  snapshotDigest: `sha256:${'c'.repeat(64)}`,
  profile: fullProfile({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
    phone: '', // 空串 = 无值，滤掉
    city: 'London', // 值存在但不在 JWS fieldKeys → 不交给填表链
  }),
};

function harness(options: {
  body?: unknown;
  status?: number;
  token?: string | null;
  throwNetwork?: boolean;
  retryBody?: unknown;
} = {}) {
  const diags: string[] = [];
  const bearers: string[] = [];
  const headerValues: Array<string | undefined> = [];
  let hits = 0;
  const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
    if (options.throwNetwork) throw new Error('down');
    hits += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    bearers.push(headers['authorization'] ?? '');
    headerValues.push(headers[APPLICATION_PROFILE_FIELD_KEYS_HEADER]);
    if (options.retryBody !== undefined && hits === 1) {
      return { ok: false, status: 401, json: async () => ({ code: 'LOGIN_REQUIRED' }) };
    }
    const status = options.status ?? 200;
    const body = options.retryBody !== undefined && hits === 2 ? options.retryBody : options.body;
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;

  const provider = createProfileProvider({
    apiBase: 'https://api.test.invalid',
    getAccessToken: async () => (options.token === undefined ? 'tok_1' : options.token),
    refreshAccessToken: async () => 'tok_fresh',
    fetchFn,
    onDiagnostic: (code) => diags.push(code),
  });
  return { provider, diags, bearers, headerValues };
}

describe('档案取数（§5.8）', () => {
  it('happy path：header=JWS fieldKeys；只把 fieldKeys 允许的非空值交给填表链', async () => {
    const h = harness({ body: GOOD_BODY });
    expect(await h.provider.getProfile(BINDING)).toEqual({
      ok: true,
      draft: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
      },
    });
    expect(h.headerValues).toEqual(['email,firstName,lastName,phone']);
    expect(h.diags).toEqual([]);
  });

  it('三道绑定任一失配 → stale（丢弃整份，停止填表等重签）', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...GOOD_BODY, fieldSchemaVersion: 2 },
      { ...GOOD_BODY, fieldKeys: ['email', 'firstName', 'lastName'] },
      { ...GOOD_BODY, fieldKeys: [...BINDING.fieldKeys, 'city'] },
      { ...GOOD_BODY, revision: '13' },
      { ...GOOD_BODY, deletionEpoch: '3' },
      { ...GOOD_BODY, snapshotDigest: `sha256:${'d'.repeat(64)}` },
    ];
    for (const body of cases) {
      const h = harness({ body });
      expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: true });
      expect(h.diags).toEqual(['PROFILE_BINDING_MISMATCH']);
    }
  });

  it('形状：缺键 / 非 string|null 值 → 整份拒收（非 stale）', async () => {
    const missingKey = { ...GOOD_BODY, profile: (() => {
      const p = fullProfile({});
      delete p['portfolioUrl'];
      return p;
    })() };
    const badValue = { ...GOOD_BODY, profile: fullProfile({ email: 7 as unknown as string }) };
    for (const body of [missingKey, badValue]) {
      const h = harness({ body });
      expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
      expect(h.diags).toEqual(['PROFILE_RESPONSE_MALFORMED']);
    }
  });

  // 键表随插件版本走；后端一次纯加法会同时到达所有旧版插件。原来的 exact-shape
  // 会让那一刻起每一次自动填写都死在这里。多出来的键忽略：它的值从不进 draft。
  it('多带了本版本不认得的键 → 忽略并记一笔，其余照常交给填表链', async () => {
    const h = harness({
      body: { ...GOOD_BODY, profile: { ...fullProfile({ firstName: 'Ada' }), futureNewKey: 'x', pronounsSet: 'y' } },
    });
    const result = await h.provider.getProfile(BINDING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({ firstName: 'Ada' });
    expect(Object.keys(result.draft)).not.toContain('futureNewKey');
    expect(h.diags).toEqual(['PROFILE_UNKNOWN_KEYS_IGNORED']);
  });

  it('敏感/EEO 类键出现 → 整份拒收（C-b：敏感值绝不进填表链）', async () => {
    const h = harness({
      body: { ...GOOD_BODY, profile: { ...fullProfile({ firstName: 'Ada' }), veteranStatus: 'protected-value' } },
    });
    expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
    expect(h.diags).toEqual(['PROFILE_SENSITIVE_SMUGGLED']);
  });

  it('401 看码分流：LOGIN_REQUIRED 换新一次重放；未登录 → 零请求', async () => {
    const retried = harness({ retryBody: GOOD_BODY });
    expect((await retried.provider.getProfile(BINDING)).ok).toBe(true);
    expect(retried.bearers).toEqual(['Bearer tok_1', 'Bearer tok_fresh']);

    const noAuth = harness({ token: null });
    expect(await noAuth.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
    expect(noAuth.diags).toEqual(['PROFILE_AUTH_UNAVAILABLE']);
    expect(noAuth.bearers).toHaveLength(0);
  });

  it('非 LOGIN_REQUIRED 的 401 → 不换新、不重放（§2.2 警告）', async () => {
    const h = harness({ status: 401, body: { code: 'EXECUTION_INTENT_INVALID' } });
    expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
    expect(h.bearers).toEqual(['Bearer tok_1']);
    expect(h.diags).toEqual(['PROFILE_REJECTED']);
  });

  it('fail-closed 分支：4xx / 5xx / 断网 / 畸形 / schemaVersion≠1 各按其码', async () => {
    expect((await harness({ status: 404, body: {} }).provider.getProfile(BINDING)).ok).toBe(false);
    expect((await harness({ status: 503, body: {} }).provider.getProfile(BINDING)).ok).toBe(false);
    expect((await harness({ throwNetwork: true }).provider.getProfile(BINDING)).ok).toBe(false);
    expect((await harness({ body: 'not-json-object' }).provider.getProfile(BINDING)).ok).toBe(false);
    expect((await harness({ body: { ...GOOD_BODY, schemaVersion: 2 } }).provider.getProfile(BINDING)).ok).toBe(false);
    expect((await harness({ body: { ...GOOD_BODY, profile: [1] } }).provider.getProfile(BINDING)).ok).toBe(false);
  });

  it('Data-L1：诊断口只出闭集稳定码，档案值不出现', async () => {
    const cases = [
      harness({ status: 404, body: {} }),
      harness({ body: { ...GOOD_BODY, profile: { ...fullProfile({}), race: 'x' } } }),
      harness({ body: { ...GOOD_BODY, revision: '99' } }),
      harness({ token: null }),
    ];
    const known = new Set<string>(PROFILE_CLIENT_DIAG_CODES);
    for (const h of cases) {
      await h.provider.getProfile(BINDING);
      for (const code of h.diags) {
        expect(known.has(code), `闭集外诊断: ${code}`).toBe(true);
        expect(code).not.toMatch(/Ada|ada@|protected-value/);
      }
    }
  });
});

/**
 * 2026-10-03 前端体检 3.1／3f-3：扁平档案请求没有超时——后端卡住时浮层一直停在「正在对照你的资料」。
 * argoland #710：门户正在保存档案的同一刻，执行侧读档案等不到共享锁（最多 2 秒）就答可重试的 503 AGENT_UNAVAILABLE；
 * #710 自己写了「其余靠客户端重试」。
 */
describe('扁平档案：超时与「资料正在保存」', () => {
  const pending = (): Promise<'HUNG'> => new Promise((resolve) => { setTimeout(() => resolve('HUNG'), 600); });

  it('后端卡住不回：到点就停，答 TIMEOUT 并记 PROFILE_FETCH_TIMEOUT（不会一直转）', async () => {
    const diags: string[] = [];
    const fetchFn = ((_input: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
    const provider = createProfileProvider({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'tok_1',
      fetchFn,
      timeoutMs: 40,
      onDiagnostic: (code) => diags.push(code),
    });
    const result = await Promise.race([provider.getProfile(BINDING), pending()]);
    expect(result, '请求自己有时限，不靠外面的等待').not.toBe('HUNG');
    expect(result).toEqual({ ok: false, stale: false, reason: 'TIMEOUT' });
    expect(diags).toEqual(['PROFILE_FETCH_TIMEOUT']);
  });

  const busyHarness = (answers: ReadonlyArray<{ status: number; body: unknown }>) => {
    const diags: string[] = [];
    const waits: number[] = [];
    let hits = 0;
    const fetchFn = (async () => {
      const answer = answers[Math.min(hits, answers.length - 1)]!;
      hits += 1;
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    }) as unknown as typeof fetch;
    const provider = createProfileProvider({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'tok_1',
      fetchFn,
      sleep: async (ms) => { waits.push(ms); },
      onDiagnostic: (code) => diags.push(code),
    });
    return { provider, diags, waits, hits: () => hits };
  };
  const BUSY = { status: 503, body: { code: 'AGENT_UNAVAILABLE', statusCode: 503 } };

  it('门户正在保存（503 AGENT_UNAVAILABLE）：等约 1 秒再读一次，读到了照常交回', async () => {
    const h = busyHarness([BUSY, { status: 200, body: GOOD_BODY }]);
    const result = await h.provider.getProfile(BINDING);
    expect(result.ok).toBe(true);
    expect(h.hits()).toBe(2);
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0]!).toBeGreaterThanOrEqual(800);
    expect(h.waits[0]!).toBeLessThanOrEqual(1200);
    expect(h.diags).toEqual(['PROFILE_BUSY_RETRIED']);
  });

  it('再读一次还是在保存：只重试这一次，答 BUSY（浮层说「资料正在保存」，不说「读不到」）', async () => {
    const h = busyHarness([BUSY, BUSY, { status: 200, body: GOOD_BODY }]);
    expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false, reason: 'BUSY' });
    expect(h.hits()).toBe(2);
    expect(h.diags).toEqual(['PROFILE_BUSY_RETRIED', 'PROFILE_BUSY']);
  });

  it('别的 503（不是 AGENT_UNAVAILABLE）：不重试，照旧 PROFILE_FETCH_FAILED', async () => {
    const h = busyHarness([{ status: 503, body: { code: 'TOOL_TIMEOUT' } }, { status: 200, body: GOOD_BODY }]);
    expect(await h.provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
    expect(h.hits()).toBe(1);
    expect(h.diags).toEqual(['PROFILE_FETCH_FAILED']);
  });
});

describe('档案取数失败带上那一次请求（2026-10-04，体检 11-3）', () => {
  it('非 2xx：码不变，另交状态码与服务端的 x-request-id（不像请求号的不带），答复体不读', async () => {
    const seen: Array<[string, unknown]> = [];
    const answer = (status: number, requestId: string) => (async () => ({
      ok: false,
      status,
      headers: { get: (name: string) => (name === 'x-request-id' ? requestId : null) },
      json: async () => ({ message: 'student@example.com' }),
    })) as unknown as typeof fetch;
    for (const [status, requestId] of [[503, 'req-0123456789'], [404, 'https://evil.example/x']] as const) {
      const provider = createProfileProvider({
        apiBase: 'https://api.test.invalid',
        getAccessToken: async () => 'tok_1',
        fetchFn: answer(status, requestId),
        onDiagnostic: (code, detail) => seen.push([code, detail]),
      });
      expect(await provider.getProfile(BINDING)).toEqual({ ok: false, stale: false });
    }
    expect(seen).toEqual([
      ['PROFILE_FETCH_FAILED', { http: { httpStatus: 503, requestId: 'req-0123456789' } }],
      ['PROFILE_REJECTED', { http: { httpStatus: 404 } }],
    ]);
    expect(JSON.stringify(seen)).not.toContain('student@');
  });
});

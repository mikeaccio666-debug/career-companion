import { beforeAll, describe, expect, it } from 'vitest';

import { INTENT_CLIENT_DIAG_CODES, createIntentClient } from '../lib/intentClient';
import { INTENT_VERIFY_ERROR_CODES } from '../lib/intentVerify';
import { createTestIntentSigner, type TestIntentSigner } from './helpers/intentSigner';
import {
  FIXTURE_HEADER,
  FIXTURE_INSTALL,
  FIXTURE_ISSUER,
  FIXTURE_NOW,
  baseClaims,
  sha,
} from './helpers/intentFixtures';

/**
 * 刀六a 特征测试：凭证 HTTP 客户端（issue → JWKS 验签 → 原子 claim）。
 * fetch 用假路由，签名用真钥匙——锁的是协议行为与 fail-closed 姿势。
 */

const REF = { clientRequestId: 'req_1', missionId: 'm_1', missionStepId: 'ms_1', missionRevision: '8' };
const ORIGIN = 'https://job-boards.greenhouse.io';
const FIELD_KEYS = ['email', 'firstName', 'lastName'];

let signer: TestIntentSigner;
let goodJws: string;
beforeAll(async () => {
  signer = await createTestIntentSigner('k_test_1');
  goodJws = await signer.sign(FIXTURE_HEADER, baseClaims());
});

interface Route {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }):
    | { status: number; body: unknown }
    | { throwNetwork: true }
    | null;
}

const GOOD_CLAIM_BODY = () => ({
  schemaVersion: 1,
  claim: {
    missionId: 'm_1',
    missionStepId: 'ms_1',
    intentVersion: 1,
    executionLease: 'opaque-lease-1',
    leaseExpiresAt: '2027-01-15T00:05:00.000Z',
    allowedActions: ['FILL'],
  },
});

interface HarnessOptions {
  routes?: Route;
  token?: string | null | (() => Promise<string | null>);
  userId?: string | null;
  installId?: string | null;
  clock?: { t: number };
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const diags: string[] = [];
  const clock = options.clock ?? { t: FIXTURE_NOW };

  const defaultRoutes: Route = (url) => {
    if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
      return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
    }
    if (url.includes('/missions/m_1/execution-intents')) {
      return {
        status: 201,
        body: { schemaVersion: 1, executionIntent: goodJws, expiresAt: 'x', intentVersion: 1, kid: 'k_test_1' },
      };
    }
    if (url.endsWith('/execution-intents/claim')) {
      return { status: 200, body: GOOD_CLAIM_BODY() };
    }
    return null;
  };
  const routes = options.routes ?? defaultRoutes;

  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const matched = routes(url, init as never);
    if (matched && 'throwNetwork' in matched) throw new Error('network down');
    if (!matched) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: matched.status < 400, status: matched.status, json: async () => matched.body };
  }) as unknown as typeof fetch;

  const client = createIntentClient({
    apiBase: 'https://api.test.invalid',
    expectedIssuer: FIXTURE_ISSUER,
    getAccessToken: (() => {
      const token = options.token;
      if (typeof token === 'function') return token;
      return async () => (token === undefined ? 'tok_1' : token);
    })(),
    getUserId: async () => (options.userId === undefined ? 'user-1' : options.userId),
    getInstallId: async () => (options.installId === undefined ? FIXTURE_INSTALL : options.installId),
    fetchFn,
    now: () => clock.t,
    onDiagnostic: (code) => diags.push(code),
  });

  return { client, calls, diags, clock };
}

const claimCalls = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) => c.url.endsWith('/execution-intents/claim'));

describe('acquire（issue → JWKS → 验签）', () => {
  it('happy path：带 Bearer 签发、验签通过、任务引用比对通过', async () => {
    const h = harness();
    const acquired = await h.client.acquirer.acquire(REF);
    expect(acquired.ok).toBe(true);

    const issue = h.calls.find((c) => c.url.includes('/execution-intents') && c.method === 'POST')!;
    expect(issue.headers['authorization']).toBe('Bearer tok_1');
    expect(issue.body).toEqual({
      missionRevision: '8',
      missionStepId: 'ms_1',
      extensionInstallId: FIXTURE_INSTALL,
    });
    expect(h.diags).toEqual([]);
  });

  it('未登录 / 无用户 id / 无 install id → 拒绝且零网络请求（fail-closed 在本地）', async () => {
    for (const [options, code] of [
      [{ token: null }, 'AUTH_UNAVAILABLE'],
      [{ userId: null }, 'AUTH_UNAVAILABLE'],
      [{ installId: null }, 'INSTALL_ID_UNAVAILABLE'],
    ] as const) {
      const h = harness(options);
      expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
      expect(h.calls).toHaveLength(0);
      expect(h.diags).toEqual([code]);
    }
  });

  it('provider 抛错不外逸：收敛为 AUTH_UNAVAILABLE 稳定码（T22 真实现的常态失败）', async () => {
    const h = harness({
      token: async () => {
        throw new Error('secret oauth error with https://auth.internal?token=abc');
      },
    });
    expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(h.diags).toEqual(['AUTH_UNAVAILABLE']);
  });

  it('issue 非 2xx / fetch 抛错 → ISSUE_HTTP_FAILED；响应缺 schemaVersion 或缺 JWS → ISSUE_RESPONSE_MALFORMED', async () => {
    const issue500 = harness({ routes: (url) => (url.includes('/execution-intents') ? { status: 500, body: {} } : null) });
    expect(await issue500.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(issue500.diags).toEqual(['ISSUE_HTTP_FAILED']);

    const issueDown = harness({ routes: (url) => (url.includes('/execution-intents') ? { throwNetwork: true } : null) });
    expect(await issueDown.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(issueDown.diags).toEqual(['ISSUE_HTTP_FAILED']);

    for (const body of [
      { executionIntent: 'x.y.z' }, // 缺 schemaVersion（§1.1 unknown → fail-closed）
      { schemaVersion: 2, executionIntent: 'x.y.z' },
      { schemaVersion: 1 }, // 缺 JWS
    ]) {
      const h = harness({ routes: (url) => (url.includes('/execution-intents') ? { status: 201, body } : null) });
      expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
      expect(h.diags).toEqual(['ISSUE_RESPONSE_MALFORMED']);
    }
  });

  it('JWKS 拉取失败且无缓存 → JWKS_UNAVAILABLE（绝不降级为跳过验签）', async () => {
    const h = harness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) return { throwNetwork: true };
        if (url.includes('/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(h.diags).toEqual(['JWKS_UNAVAILABLE']);
  });

  it('kid 轮换：首份 JWKS 不含该 kid → 强刷一次再验成；强刷也失败 → JWKS_UNAVAILABLE', async () => {
    let jwksHits = 0;
    const rotating = harness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          jwksHits += 1;
          return { status: 200, body: { keys: jwksHits === 1 ? [signer.decoyJwk, signer.decoyJwk2] : [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    expect((await rotating.client.acquirer.acquire(REF)).ok).toBe(true);
    expect(jwksHits).toBe(2);

    let refreshHits = 0;
    const refreshDead = harness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          refreshHits += 1;
          if (refreshHits === 1) return { status: 200, body: { keys: [signer.decoyJwk, signer.decoyJwk2] } };
          return { throwNetwork: true };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    // 强刷失败但手上有（空）缓存 → 仍用缓存 → kid 仍未知 → 稳定码拒绝，不崩。
    expect(await refreshDead.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(refreshDead.diags).toEqual(['INTENT_KID_UNKNOWN']);
  });

  it('§5.2 严格 keyset：畸形 200 原子拒绝——冷缓存直接失败，不抛不滑过', async () => {
    for (const badKeys of [
      [null, 42, { kty: 'EC' }, signer.publicJwk], // 畸形条目
      [signer.publicJwk], // 少于 2 把
      [signer.publicJwk, signer.decoyJwk, signer.decoyJwk2, signer.decoyJwk2, signer.publicJwk], // 多于 4
      [signer.publicJwk, { ...signer.decoyJwk, kid: signer.publicJwk.kid }], // 重复 kid
      [signer.publicJwk, { ...signer.publicJwk, kid: 'other' }], // 重复 key material
      [signer.publicJwk, { ...signer.decoyJwk, d: 'secret' }], // 带私钥标量
      [signer.publicJwk, { ...signer.decoyJwk, x: 'short' }], // 非 canonical 坐标
    ]) {
      const h = harness({
        routes: (url) => {
          if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
            return { status: 200, body: { keys: badKeys } };
          }
          if (url.includes('/missions/m_1/execution-intents')) {
            return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
          }
          return null;
        },
      });
      expect((await h.client.acquirer.acquire(REF)).ok).toBe(false);
      expect(h.diags).toContain('JWKS_MALFORMED');
    }
  });

  it('§5.2 原子替换：畸形 200 不覆盖最后一份已验证缓存（沿用旧 keyset 继续验签）', async () => {
    let poisoned = false;
    const clock = { t: FIXTURE_NOW };
    const h = harness({
      clock,
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          return poisoned
            ? { status: 200, body: { keys: [null] } } // 畸形 200
            : { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    expect((await h.client.acquirer.acquire(REF)).ok).toBe(true); // 建立已验证缓存

    poisoned = true;
    clock.t = FIXTURE_NOW + 400; // 过 300s 新鲜期 → 触发重拉 → 拿到畸形 200
    const jws2 = await signer.sign(FIXTURE_HEADER, baseClaims({ iat: clock.t - 10, nbf: clock.t - 10, exp: clock.t + 100 }));
    const h2routesHitBefore = h.diags.length;
    void h2routesHitBefore;
    void jws2; // 时间窗内票据由 issue 路由固定返回 goodJws（相对 FIXTURE_NOW），改用宽期票据不必要——
    // goodJws 已过期会先在验签层报 INTENT_EXPIRED；此处只断言 JWKS 层行为：
    // 沿用旧缓存 = 验签仍拿到含签名 kid 的 keyset，报出的码是时间窗而非 KID_UNKNOWN/UNAVAILABLE。
    await h.client.acquirer.acquire(REF);
    expect(h.diags).toContain('JWKS_MALFORMED'); // 畸形被察觉
    expect(h.diags).not.toContain('JWKS_UNAVAILABLE'); // 但没有失去 keyset
    expect(h.diags).not.toContain('INTENT_KID_UNKNOWN'); // 旧缓存仍认得签名 kid
  });

  it('旧缓存兜底有陈旧上限：超过 24h 的缓存不再救急 → JWKS_UNAVAILABLE', async () => {
    // 撤 key 时效不能被"取数一直失败"无限拖长（远程开关取数教训的密钥版）。
    let failNow = false;
    const clock = { t: FIXTURE_NOW };
    const h = harness({
      clock,
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          if (failNow) return { throwNetwork: true };
          return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    expect((await h.client.acquirer.acquire(REF)).ok).toBe(true); // 缓存已建

    failNow = true;
    clock.t = FIXTURE_NOW + 90_000; // >24h：旧缓存过陈旧上限，fail-closed
    expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(h.diags.at(-1)).toBe('JWKS_UNAVAILABLE');
  });

  it('issuer 不符的票被验签层拒绝，诊断码穿透', async () => {
    const evilJws = await signer.sign(FIXTURE_HEADER, baseClaims({ iss: 'https://evil.test' }));
    const h = harness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: evilJws } };
        }
        return null;
      },
    });
    expect(await h.client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(h.diags).toEqual(['INTENT_ISSUER_MISMATCH']);
  });

  it('验签通过但 claims 指向别的 mission → INTENT_REF_MISMATCH', async () => {
    // 路由放行 m_OTHER 的签发请求，但回的 JWS claims 仍指 m_1——归属核对要拒。
    const h = harness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_OTHER/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        return null;
      },
    });
    expect(await h.client.acquirer.acquire({ ...REF, missionId: 'm_OTHER' })).toEqual({ ok: false });
    expect(h.diags).toEqual(['INTENT_REF_MISMATCH']);
  });

  it('§5.4：JWS missionStepId 指向新建 execution step（≠ 请求的 approval step）→ 接受', async () => {
    const h = harness();
    expect((await h.client.acquirer.acquire({ ...REF, missionStepId: 'ms_APPROVAL' })).ok).toBe(true);
    expect(h.diags).toEqual([]);
  });

  it('401 → 强制换新一次并重放（本地 exp 判定覆盖不了服务端侧失效）', async () => {
    let issueHits = 0;
    const refreshes: number[] = [];
    const calls: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
        return { ok: true, status: 200, json: async () => ({ keys: [signer.publicJwk, signer.decoyJwk] }) };
      }
      if (url.includes('/missions/m_1/execution-intents')) {
        issueHits += 1;
        if (issueHits === 1) return { ok: false, status: 401, json: async () => ({ code: 'LOGIN_REQUIRED' }) };
        return { ok: true, status: 201, json: async () => ({ schemaVersion: 1, executionIntent: goodJws }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const client = createIntentClient({
      apiBase: 'https://api.test.invalid',
      expectedIssuer: FIXTURE_ISSUER,
      getAccessToken: async () => 'tok_stale',
      refreshAccessToken: async () => {
        refreshes.push(1);
        return 'tok_fresh';
      },
      getUserId: async () => 'user-1',
      getInstallId: async () => FIXTURE_INSTALL,
      fetchFn,
      now: () => FIXTURE_NOW,
    });
    const acquired = await client.acquirer.acquire(REF);
    expect(acquired.ok).toBe(true);
    expect(refreshes).toHaveLength(1); // 换新恰好一次
    const issues = calls.filter((c) => c.url.includes('/missions/m_1/execution-intents'));
    expect(issues[0]!.headers['authorization']).toBe('Bearer tok_stale');
    expect(issues[1]!.headers['authorization']).toBe('Bearer tok_fresh'); // 重放用新 token
  });

  it('401 但码不是 LOGIN_REQUIRED（如 EXECUTION_INTENT_INVALID）→ 不换新不重放（§2.2 警告）', async () => {
    const refreshes: number[] = [];
    let issueHits = 0;
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
        return { ok: true, status: 200, json: async () => ({ keys: [signer.publicJwk, signer.decoyJwk] }) };
      }
      if (url.includes('/missions/m_1/execution-intents')) {
        issueHits += 1;
        return { ok: false, status: 401, json: async () => ({ code: 'EXECUTION_INTENT_INVALID' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const client = createIntentClient({
      apiBase: 'https://api.test.invalid',
      expectedIssuer: FIXTURE_ISSUER,
      getAccessToken: async () => 'tok_1',
      refreshAccessToken: async () => {
        refreshes.push(1);
        return 'tok_fresh';
      },
      getUserId: async () => 'user-1',
      getInstallId: async () => FIXTURE_INSTALL,
      fetchFn,
      now: () => FIXTURE_NOW,
    });
    expect(await client.acquirer.acquire(REF)).toEqual({ ok: false });
    expect(refreshes).toHaveLength(0); // 不白烧 token 轮转
    expect(issueHits).toBe(1); // 不盲重放
  });
});

describe('claim（本地复核 → 服务端原子核销）', () => {
  async function acquiredHarness(options: HarnessOptions = {}) {
    const h = harness(options);
    const acquired = await h.client.acquirer.acquire(REF);
    if (!acquired.ok) throw new Error('acquire failed in setup');
    return { ...h, intent: acquired.intent };
  }
  const goodRequest = (intent: { jws: string }) => ({
    intent,
    actualOrigin: ORIGIN,
    actualFieldKeys: FIELD_KEYS,
    scanDigest: sha('e'),
  });

  it('happy path：actualTarget 回显批准值，lease 换算 Unix 秒，范围与动作面取验签 claims', async () => {
    const h = await acquiredHarness();
    const claimed = await h.client.claimer.claim(goodRequest(h.intent));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.grant).toEqual({
      missionId: 'm_1',
      missionStepId: 'ms_1',
      fieldKeys: FIELD_KEYS,
      // 没有记忆键的票据授权的就是空集——记忆复用默认关。
      questionKeys: [],
      allowedActions: ['FILL'],
      executionLease: 'opaque-lease-1',
      leaseExpiresAt: Math.floor(Date.parse('2027-01-15T00:05:00.000Z') / 1000),
      intentVersion: 1,
      planDigest: sha('b'),
      // jobIdentityHash = JCS(已验签 target 六字段) 的 sha256（组成锁定在
      // intentClient；对齐清单第 ⑤ 项——后端须用同一组成复核）。
      jobIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      // §5.8 取数绑定：三元 + fieldSchemaVersion 逐字透传自已验签 claims。
      fieldSchemaVersion: 1,
      profileSnapshot: { revision: '1', deletionEpoch: '1', snapshotDigest: sha('c') },
    });

    const wire = claimCalls(h)[0]!;
    expect(wire.headers['authorization']).toBe('Bearer tok_1');
    expect(wire.body).toMatchObject({
      executionIntent: expect.any(String),
      extensionInstallId: FIXTURE_INSTALL,
      actualTarget: { canonicalOrigin: ORIGIN, pathRuleId: 'greenhouse-application-v1' },
      actualFieldKeys: FIELD_KEYS,
      scanDigest: sha('e'),
    });
  });

  it('§5.5 本地复核先行：origin / 字段集合 / scanDigest 形状不符 → 拒绝且不上网', async () => {
    const wrongOrigin = await acquiredHarness();
    expect(
      await wrongOrigin.client.claimer.claim({ ...goodRequest(wrongOrigin.intent), actualOrigin: 'https://evil.example.test' }),
    ).toEqual({ ok: false, code: 'RESCAN_MISMATCH' });
    expect(claimCalls(wrongOrigin)).toHaveLength(0);

    const missingField = await acquiredHarness();
    expect(
      await missingField.client.claimer.claim({ ...goodRequest(missingField.intent), actualFieldKeys: ['email', 'firstName'] }),
    ).toEqual({ ok: false, code: 'RESCAN_MISMATCH' });
    expect(claimCalls(missingField)).toHaveLength(0);

    const badDigest = await acquiredHarness();
    expect(
      await badDigest.client.claimer.claim({ ...goodRequest(badDigest.intent), scanDigest: 'not-a-digest' }),
    ).toEqual({ ok: false, code: 'INTENT_REJECTED' });
    expect(claimCalls(badDigest)).toHaveLength(0);
    expect(badDigest.diags).toEqual(['CLAIM_SCAN_DIGEST_MALFORMED']);
  });

  it('acquire 后登录态丢失：claim 前 token 变 null → AUTH_UNAVAILABLE，不上网', async () => {
    let token: string | null = 'tok_1';
    const h = await acquiredHarness({ token: async () => token });
    token = null;
    expect(await h.client.claimer.claim(goodRequest(h.intent))).toEqual({ ok: false, code: 'INTENT_REJECTED' });
    expect(claimCalls(h)).toHaveLength(0);
    expect(h.diags).toEqual(['AUTH_UNAVAILABLE']);
  });

  it('服务端比对失败码 → RESCAN_MISMATCH；同一票二次 claim → INTENT_REJECTED（一次性）', async () => {
    const h = await acquiredHarness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        if (url.endsWith('/execution-intents/claim')) {
          return { status: 409, body: { code: 'EXECUTION_FIELD_SET_MISMATCH' } };
        }
        return null;
      },
    });
    expect(await h.client.claimer.claim(goodRequest(h.intent))).toEqual({ ok: false, code: 'RESCAN_MISMATCH' });
    // 本地记录已核销：不重放旧票（§5.6.8），重试必须从 issue 重新走。
    expect(await h.client.claimer.claim(goodRequest(h.intent))).toEqual({ ok: false, code: 'INTENT_REJECTED' });
  });

  it('claim 响应畸形逐款拒收：非 JSON 错误体 / 缺 lease / 坏日期 / schemaVersion 2 / 动作面不符', async () => {
    const cases: Array<{ status: number; body: unknown; wantDiag: string }> = [
      { status: 500, body: 'not-json', wantDiag: 'CLAIM_HTTP_FAILED' },
      {
        status: 200,
        body: { schemaVersion: 1, claim: { ...GOOD_CLAIM_BODY().claim, executionLease: '' } },
        wantDiag: 'CLAIM_RESPONSE_MALFORMED',
      },
      {
        status: 200,
        body: { schemaVersion: 1, claim: { ...GOOD_CLAIM_BODY().claim, leaseExpiresAt: 'not-a-date' } },
        wantDiag: 'CLAIM_RESPONSE_MALFORMED',
      },
      { status: 200, body: { ...GOOD_CLAIM_BODY(), schemaVersion: 2 }, wantDiag: 'CLAIM_RESPONSE_MALFORMED' },
      {
        status: 200,
        body: { schemaVersion: 1, claim: { ...GOOD_CLAIM_BODY().claim, allowedActions: ['FILL', 'SUBMIT'] } },
        wantDiag: 'CLAIM_RESPONSE_MALFORMED',
      },
    ];
    for (const testCase of cases) {
      const h = await acquiredHarness({
        routes: (url) => {
          if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
            return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
          }
          if (url.includes('/missions/m_1/execution-intents')) {
            return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
          }
          if (url.endsWith('/execution-intents/claim')) {
            return { status: testCase.status, body: testCase.body };
          }
          return null;
        },
      });
      expect(await h.client.claimer.claim(goodRequest(h.intent))).toEqual({ ok: false, code: 'INTENT_REJECTED' });
      expect(h.diags.at(-1)).toBe(testCase.wantDiag);
    }
  });

  it('凭证纪律：诊断码全部属于稳定码闭集，绝无 JWS/lease 片段', async () => {
    const known = new Set<string>([...INTENT_CLIENT_DIAG_CODES, ...INTENT_VERIFY_ERROR_CODES]);
    const h = await acquiredHarness({
      routes: (url) => {
        if (url.endsWith('/.well-known/edaix-execution-intent-jwks.json')) {
          return { status: 200, body: { keys: [signer.publicJwk, signer.decoyJwk] } };
        }
        if (url.includes('/missions/m_1/execution-intents')) {
          return { status: 201, body: { schemaVersion: 1, executionIntent: goodJws } };
        }
        if (url.endsWith('/execution-intents/claim')) return { throwNetwork: true };
        return null;
      },
    });
    await h.client.claimer.claim(goodRequest(h.intent)); // fetch 抛错分支
    await h.client.claimer.claim(goodRequest(h.intent)); // 已核销分支
    await h.client.acquirer.acquire({ ...REF, missionStepId: 'ms_OTHER' });
    expect(h.diags.length).toBeGreaterThan(0);
    for (const code of h.diags) {
      expect(known.has(code), `诊断口出现闭集外内容: ${code}`).toBe(true);
      expect(code).not.toContain('.');
    }
  });
});

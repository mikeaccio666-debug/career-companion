import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_SESSION_ENDPOINTS, parseUuid } from '@edaix/contracts';

import { AUTH_CLIENT_DIAG_CODES, createAuthClient, parseJwtExpiry, type AuthKeyValueStore } from '../lib/authClient';

/**
 * 刀八特征测试（审计修复批后）：登录态生命周期——存储分层（access 只在
 * 内存）、单飞轮转 + 结局不明日志位、5xx/断网/4xx 三分、登出纪元、
 * install 补登记。fetch 假路由；token 用真 JWT 结构。
 */

// 路径只有契约表一个来源。2026-09-16 之前客户端与这里都硬写了裸
// `/extension/installs`——那是 Vibe ID 的安装登记，Career Team 的在
// `/api/v1/agent/` 前缀下。假路由照着错路径答，于是测试全绿而真环境
// 连不上：status 端点在服务端根本是 404。
const LINK_INSTALL_PATH = AUTH_SESSION_ENDPOINTS.linkExtensionInstall.path;
const ATTEST_INSTALL_PATH = AUTH_SESSION_ENDPOINTS.attestExtensionInstall.path;

it('安装登记走 Career Team 前缀，不是 Vibe ID 占着的那条裸路径', () => {
  expect(LINK_INSTALL_PATH).toBe('/api/v1/agent/extension-installs');
  expect(ATTEST_INSTALL_PATH).toBe('/api/v1/agent/extension-installs/status');
  const source = readFileSync(new URL('../lib/authClient.ts', import.meta.url), 'utf8');
  expect(source).toContain(`'${LINK_INSTALL_PATH}'`);
  expect(source).toContain(`'${ATTEST_INSTALL_PATH}'`);
  expect(source).not.toMatch(/'\/extension\/installs/);
});

const NOW = 1_800_000_000;
const USER_1_ID = '11111111-1111-4111-8111-111111111111';
const USER_2_ID = '22222222-2222-4222-8222-222222222222';

it('keeps install-status validation on the shared executable contract authority', () => {
  const source = readFileSync(
    new URL('../lib/authClient.ts', import.meta.url),
    'utf8',
  );
  expect(source).toContain('parseAttestExtensionInstallResponse(response.body)');
});

function makeJwt(exp: number, sub = USER_1_ID): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp })}.sig`;
}

function tokenPair(accessExp: number, refreshToken = 'refresh_1', userId = USER_1_ID) {
  return {
    accessToken: makeJwt(accessExp, userId),
    refreshToken,
    user: { id: userId, email: `${userId}@example.test`, role: 'STUDENT' },
  };
}

function memoryStore(): AuthKeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

type RouteResult = { status: number; body: unknown; raw?: string } | { throwNetwork: true } | null;
interface Route {
  (
    path: string,
    body: Record<string, unknown>,
    bearer: string | undefined,
    init: RequestInit,
  ): RouteResult | Promise<RouteResult>;
}

function harness(options: {
  routes?: Route;
  clock?: { t: number };
  store?: AuthKeyValueStore;
  onSessionInvalidated?: () => void;
  onBeforeLogout?: (accessToken: string | null) => Promise<void>;
} = {}) {
  const clock = options.clock ?? { t: NOW };
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
    bearer?: string;
    init: RequestInit;
  }> = [];
  const diags: string[] = [];
  /** 提前轮换的登记（unix 秒）：worker 要在 access 到期前把自己叫醒。 */
  const rotations: number[] = [];
  const store = (options.store as ReturnType<typeof memoryStore>) ?? memoryStore();

  let refreshSeq = 0;
  const defaultRoutes: Route = (path, body) => {
    if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(clock.t + 900) };
    if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
    if (path === ATTEST_INSTALL_PATH) {
      return {
        status: 200,
        body: {
          connected: true,
          installId: body['installId'],
          userId: USER_1_ID,
        },
      };
    }
    if (path === '/auth/refresh') {
      refreshSeq += 1;
      return { status: 201, body: tokenPair(clock.t + 900, `refresh_${refreshSeq + 1}`) };
    }
    if (path === '/auth/logout') return { status: 201, body: { ok: true } };
    return null;
  };
  const routes = options.routes ?? defaultRoutes;

  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const bearer = headers['authorization']?.replace('Bearer ', '');
    const requestInit = init ?? {};
    calls.push(bearer === undefined
      ? { path: url.pathname, body, init: requestInit }
      : { path: url.pathname, body, bearer, init: requestInit });
    const matched = await routes(url.pathname, body, bearer, requestInit);
    if (matched && 'throwNetwork' in matched) throw new Error('network down');
    if (!matched) return { ok: false, status: 404, text: async () => '{}' };
    return {
      ok: matched.status < 400,
      status: matched.status,
      text: async () => {
        if (matched.raw !== undefined) return matched.raw;
        const serialized = JSON.stringify(await matched.body);
        return serialized ?? '';
      },
    };
  }) as unknown as typeof fetch;

  const client = createAuthClient({
    apiBase: 'https://api.test.invalid',
    store,
    fetchFn,
    now: () => clock.t,
    onDiagnostic: (code) => diags.push(code),
    onBeforeLogout: options.onBeforeLogout,
    onSessionInvalidated: options.onSessionInvalidated,
    scheduleRotation: (whenUnixSeconds) => rotations.push(whenUnixSeconds),
  });
  return { client, calls, diags, store, clock, fetchFn, rotations };
}

const HANDOFF = { code: 'code_1', state: 's'.repeat(64), extensionId: 'ext_1' };
const refreshCalls = (h: { calls: Array<{ path: string; body: Record<string, unknown> }> }) =>
  h.calls.filter((c) => c.path === '/auth/refresh');

describe('parseJwtExpiry', () => {
  it('解出 exp；畸形一律 0', () => {
    expect(parseJwtExpiry(makeJwt(123))).toBe(123);
    expect(parseJwtExpiry('not-a-jwt')).toBe(0);
    expect(parseJwtExpiry('a.!!!.c')).toBe(0);
  });
});

describe('authClient（登录态生命周期）', () => {
  it('invalidates assistant identity synchronously before queued logout work', async () => {
    let calls = 0, release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ onSessionInvalidated: () => { calls++; }, onBeforeLogout: () => blocked });
    const redeem = h.client.redeemHandoff(HANDOFF);
    expect(calls).toBe(1); await redeem;
    const before = calls, logout = h.client.logout();
    expect(calls).toBe(before + 1);
    release(); await logout;
    expect(await h.client.getUserId()).toBeNull();
  });

  it('connection readiness distinguishes no session and owner mismatch with zero network', async () => {
    const h = harness();
    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('UNAUTHENTICATED');
    expect(h.calls).toEqual([]);

    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);
    await expect(h.client.readConnectionReadiness(USER_2_ID))
      .resolves.toBe('OWNER_MISMATCH');
    expect(h.calls).toEqual([]);
  });

  it('connection readiness uses only the fresh install-status read after binding', async () => {
    const h = harness();
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);

    await expect(h.client.readConnectionReadiness(USER_1_ID)).resolves.toBe('READY');
    expect(h.calls.map((call) => call.path)).toEqual([ATTEST_INSTALL_PATH]);
  });

  it('connection readiness separates a proven unlinked install from unavailable authority', async () => {
    let statusMode: 'unlinked' | 'malformed' = 'unlinked';
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return { status: 201, body: tokenPair(NOW + 900) };
        }
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === ATTEST_INSTALL_PATH) {
          return statusMode === 'unlinked'
            ? { status: 200, body: { connected: false } }
            : { status: 200, body: { connected: true, installId: body['installId'] } };
        }
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);
    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('INSTALL_UNLINKED');
    statusMode = 'malformed';
    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls.every((call) => call.path === ATTEST_INSTALL_PATH)).toBe(true);
  });

  it('missing install identity is read-only unlinked with zero local or network mutation', async () => {
    const h = harness();
    await h.client.redeemHandoff(HANDOFF);
    h.store.data.delete('extensionInstallId');
    h.calls.splice(0);
    const set = vi.spyOn(h.store, 'set');

    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('INSTALL_UNLINKED');
    expect(h.calls).toEqual([]);
    expect(set).not.toHaveBeenCalled();
    expect(h.store.data.has('extensionInstallId')).toBe(false);
  });

  it('storage uncertainty is unavailable and never generates an install identity', async () => {
    const base = memoryStore();
    const h = harness({ store: base });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);
    const set = vi.spyOn(base, 'set');
    const originalGet = base.get.bind(base);
    vi.spyOn(base, 'get').mockImplementation(async (key) => {
      if (key === 'extensionInstallId') throw new Error('storage unavailable');
      return originalGet(key);
    });

    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls).toEqual([]);
    expect(set).not.toHaveBeenCalled();
  });

  it('session storage failure is not misreported as unauthenticated', async () => {
    const store: AuthKeyValueStore = {
      async get() { throw new Error('storage unavailable'); },
      async set() { throw new Error('unexpected write'); },
      async remove() { throw new Error('unexpected remove'); },
    };
    const h = harness({ store });

    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls).toEqual([]);
  });

  it('an outcome-unknown refresh journal blocks READY before refresh or status traffic', async () => {
    const h = harness();
    await h.client.redeemHandoff(HANDOFF);
    h.store.data.set('authRotationInFlight', true);
    h.calls.splice(0);

    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls).toEqual([]);
  });

  it('handoff redeem 只 adopt 201、要用的几项都对的 ExtensionTokenPair（多出来的字段不拒，2026-10-03）', async () => {
    const exactPair = tokenPair(NOW + 900);
    for (const [redeemResult, accepted] of [
      [{ status: 200, body: exactPair }, false],
      [{ status: 202, body: exactPair }, false],
      [{ status: 204, body: exactPair }, false],
      [{ status: 201, body: { ...exactPair, extra: true } }, true],
      // 多出来的字段不拒，不等于要用的那几项可以松：两层都多了字段、角色却不认得，照旧拒。
      [{ status: 201, body: { ...exactPair, extra: true, user: { ...exactPair.user, extra: true, role: 'OWNER' } } }, false],
      [{ status: 201, body: { ...exactPair, user: { ...exactPair.user, email: undefined } } }, false],
      [{ status: 201, body: { ...exactPair, user: { ...exactPair.user, id: 'not-a-uuid' } } }, false],
      [{ status: 201, body: { ...exactPair, user: { ...exactPair.user, role: 'OWNER' } } }, false],
      [{
        status: 201,
        body: exactPair,
        raw: `{"accessToken":"shadow","access\\u0054oken":${JSON.stringify(exactPair.accessToken)},"refreshToken":${JSON.stringify(exactPair.refreshToken)},"user":${JSON.stringify(exactPair.user)}}`,
      }, false],
      [{ status: 201, body: exactPair }, true],
    ] as const) {
      if ('raw' in redeemResult) {
        // Mutation proof: JSON.parse alone collapses the escaped duplicate to
        // an otherwise exact body, so only the pre-parser can reject it.
        expect(JSON.parse(redeemResult.raw)).toEqual(exactPair);
      }
      const h = harness({
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') return redeemResult;
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          return null;
        },
      });

      await expect(h.client.redeemHandoff(HANDOFF)).resolves.toBe(accepted);
      expect(h.store.data.has('authSession')).toBe(accepted);
      expect(h.calls.some((call) => call.path === LINK_INSTALL_PATH)).toBe(accepted);
      if (!accepted) expect(h.diags).toContain('AUTH_RESPONSE_MALFORMED');
    }
  });

  /**
   * 2026-10-03 体检 10-7：argoland 的 TokenPair 网页登录也在用；后端在两层任何一层加一个字段（先在 argoland 加、插件跟版本，
   * 正是 RULE-EXT-CONTRACT-CONSUMER 定的正路），从前每一个装着的插件都登录不了、续不了期——续期那一下服务端已经轮换过了。
   * 要用的那几项照旧逐项严格验；多出来的不认、也不往下传。
   */
  it('兑换与续期：两层都多出来字段也照常登录、续期，只取要用的那几项', async () => {
    const additive = (pair: ReturnType<typeof tokenPair>) => ({
      ...pair,
      expiresIn: 900,
      session: { id: 'sess_extra_1' },
      user: { ...pair.user, displayName: 'Taylor Extra', emailVerified: true, avatarUrl: null },
    });
    const refreshed = tokenPair(NOW + 1_800, 'refresh_2');
    const h = harness({
      routes: (path) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: additive(tokenPair(NOW + 900)) };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') return { status: 201, body: additive(refreshed) };
        return null;
      },
    });

    await expect(h.client.redeemHandoff(HANDOFF)).resolves.toBe(true);
    expect(h.store.data.get('authSession')).toEqual({ refreshToken: 'refresh_1', userId: USER_1_ID });
    await expect(h.client.forceRefresh()).resolves.toBe(refreshed.accessToken);
    expect(h.store.data.get('authSession')).toEqual({ refreshToken: 'refresh_2', userId: USER_1_ID });
    expect(h.store.data.has('authRotationInFlight')).toBe(false);
    expect(h.diags).not.toContain('AUTH_RESPONSE_MALFORMED');
    expect(h.diags).not.toContain('AUTH_REFRESH_TRANSPORT');
    // 多出来的一样都没落盘。
    expect(JSON.stringify([...h.store.data.values()])).not.toMatch(/Taylor Extra|sess_extra_1|expiresIn|emailVerified/u);
  });

  it('install 登记只接受 exact 202 {ok:true}，并修复持久化的非法 UUID', async () => {
    for (const [installResult, accepted] of [
      [{ status: 200, body: { ok: true } }, false],
      [{ status: 202, body: { ok: false } }, false],
      [{ status: 202, body: { ok: true, extra: true } }, false],
      [{ status: 202, body: { ok: true }, raw: '{"ok":false,"\\u006fk":true}' }, false],
      [{ status: 202, body: { ok: true } }, true],
    ] as const) {
      if ('raw' in installResult) expect(JSON.parse(installResult.raw)).toEqual({ ok: true });
      const store = memoryStore();
      store.data.set('extensionInstallId', 'not-a-canonical-uuid');
      const h = harness({
        store,
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') {
            return { status: 201, body: tokenPair(NOW + 900) };
          }
          if (path === LINK_INSTALL_PATH) return installResult;
          return null;
        },
      });

      await expect(h.client.redeemHandoff(HANDOFF)).resolves.toBe(accepted);
      const link = h.calls.find((call) => call.path === LINK_INSTALL_PATH);
      expect(parseUuid(link?.body['installId'])).not.toBeNull();
      expect(store.data.get('extensionInstallId')).toBe(link?.body['installId']);
      expect(store.data.get('extensionInstallLinked')).toBe(accepted ? USER_1_ID : undefined);
      expect(h.diags.includes('AUTH_INSTALL_LINK_FAILED')).toBe(!accepted);
    }
  });

  it('兑换成功：access 只在内存（持久层无 access token），install 自动登记', async () => {
    const h = harness();
    expect(await h.client.redeemHandoff(HANDOFF)).toBe(true);
    const access = await h.client.getAccessToken();
    expect(access).toContain('.');
    expect(await h.client.getUserId()).toBe(USER_1_ID);

    // 契约 §2.2：access token 不落盘——持久层序列化后不含它。
    expect(JSON.stringify([...h.store.data.entries()])).not.toContain(access);
    expect(JSON.stringify([...h.store.data.entries()])).toContain('refresh_1');

    const link = h.calls.find((c) => c.path === LINK_INSTALL_PATH)!;
    expect(link.body).toEqual({ installId: await h.client.getInstallId() });
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_1_ID);
    const redeem = h.calls.find((c) => c.path === '/auth/extension-handoffs/redeem')!;
    expect(redeem.bearer).toBeUndefined(); // public 端点
    expect(redeem.init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(redeem.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('到期前单飞轮转：并发只打一次 /auth/refresh；成功后日志位清空', async () => {
    const h = harness();
    await h.client.redeemHandoff(HANDOFF);
    h.clock.t += 900;
    const [a, b] = await Promise.all([h.client.getAccessToken(), h.client.getAccessToken()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(refreshCalls(h)).toHaveLength(1);
    expect(refreshCalls(h)[0]!.body).toEqual({ refreshToken: 'refresh_1' });
    expect(h.store.data.has('authRotationInFlight')).toBe(false);
  });

  it('SW 冷启动（内存空、持久层有会话）：一次轮转恢复 access', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);
    // 新实例 = SW 重启：内存 access 丢了，refresh 换新。
    const second = harness({ store: shared });
    expect(await second.client.getAccessToken()).not.toBeNull();
    expect(refreshCalls(second)).toHaveLength(1);
  });

  it('refresh 只 adopt 201、要用的几项都对的 ExtensionTokenPair，别的 2xx 保留 journal 且绝不重放 R0', async () => {
    const exactPair = tokenPair(NOW + 1_800, 'refresh_2');
    for (const refreshResult of [
      { status: 200, body: exactPair },
      { status: 202, body: exactPair },
      { status: 204, body: exactPair },
      { status: 201, body: { ...exactPair, user: { ...exactPair.user, id: 'not-a-uuid' } } },
      { status: 201, body: { ...exactPair, user: { ...exactPair.user, role: 'OWNER' } } },
      {
        status: 201,
        body: exactPair,
        raw: `{"accessToken":${JSON.stringify(exactPair.accessToken)},"refreshToken":"shadow","refresh\\u0054oken":${JSON.stringify(exactPair.refreshToken)},"user":${JSON.stringify(exactPair.user)}}`,
      },
    ] as const) {
      if ('raw' in refreshResult && typeof refreshResult.raw === 'string') {
        expect(JSON.parse(refreshResult.raw)).toEqual(exactPair);
      }
      const h = harness({
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') {
            return { status: 201, body: tokenPair(NOW + 900) };
          }
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          if (path === '/auth/refresh') return refreshResult;
          return null;
        },
      });
      await h.client.redeemHandoff(HANDOFF);

      await expect(h.client.forceRefresh()).resolves.toBeNull();
      expect(h.store.data.get('authSession')).toEqual({
        refreshToken: 'refresh_1',
        userId: USER_1_ID,
      });
      expect(h.store.data.get('authRotationInFlight')).toBe(true);
      expect(h.diags).toContain('AUTH_REFRESH_TRANSPORT');
      expect(refreshCalls(h)).toHaveLength(1);
    }
  });

  it('SW 冷启动 logout：先轮转取得真实 bearer，再撤销新 refresh，不留下 active row 语义', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);

    const restarted = harness({ store: shared });
    await restarted.client.logout();

    expect(refreshCalls(restarted)).toHaveLength(1);
    expect(refreshCalls(restarted)[0]!.body).toEqual({ refreshToken: 'refresh_1' });
    const revoke = restarted.calls.find((call) => call.path === '/auth/logout');
    expect(revoke?.body).toEqual({ refreshToken: 'refresh_2' });
    expect(revoke?.bearer).toBe(makeJwt(NOW + 900, USER_1_ID));
    expect(await restarted.client.getUserId()).toBeNull();
    expect(shared.data.has('authSession')).toBe(false);
  });

  it('ingress 5xx 可能发生在 R0→R1 commit 后：保留 journal，后续零重放', async () => {
    let committedBehindIngress = false;
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(NOW + 900) };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') {
          committedBehindIngress = true;
          return { status: 503, body: {} };
        }
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.clock.t += 900;
    expect(await h.client.getAccessToken()).toBeNull(); // 本次拿不到
    expect(committedBehindIngress).toBe(true);
    expect(h.diags).toContain('AUTH_REFRESH_TRANSPORT');
    expect(h.store.data.get('authRotationInFlight')).toBe(true);

    // 2026-09-20 改：日志位在，下一次照样带旧 token 问一次（服务端宽限窗兜底）。
    // 网关还是 5xx → 仍是结局不明：日志位留着、会话也留着，不清。
    expect(await h.client.getAccessToken()).toBeNull();
    expect(refreshCalls(h)).toHaveLength(2);
    expect(h.store.data.get('authRotationInFlight')).toBe(true);
    expect(h.diags).not.toContain('AUTH_REFRESH_FAILED');
    expect(await h.client.getUserId()).toBe(USER_1_ID);
  });

  it('断网 = 结局不明：内存 token 用到真到期；之后带旧 token 再问一次，网络回来就救回', async () => {
    let offline = false;
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(NOW + 900) };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') return offline ? { throwNetwork: true } : { status: 201, body: tokenPair(NOW + 900) };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    offline = true;
    h.clock.t = NOW + 850; // 进提前续期窗（900-60），但离真到期还有 50s
    expect(await h.client.getAccessToken()).not.toBeNull(); // 断网不当场杀会话
    expect(h.diags).toContain('AUTH_REFRESH_TRANSPORT');

    h.clock.t = NOW + 901; // 真到期
    expect(await h.client.getAccessToken()).toBeNull();
    // 2026-09-20 改：结局不明**不再等于死刑**。服务端有 60s 宽限窗（后继没被用过就
    // 允许再来一次），所以这里带着旧 token 再问一次是安全的：201 就救回来，
    // 4xx 才是真的不可恢复。断网时两次都没答，日志位留着、会话也留着。
    expect(refreshCalls(h)).toHaveLength(2);
    expect(h.diags).not.toContain('AUTH_REFRESH_FAILED');
    expect(await h.client.getUserId()).toBe(USER_1_ID); // 会话还在，等网络回来

    offline = false; // 网络回来：宽限窗内一问就救回
    expect(await h.client.getAccessToken()).not.toBeNull();
    expect(h.store.data.has('authRotationInFlight')).toBe(false);
  });

  // ── 2026-09-20：会话 15 分钟必死的三条修法 ─────────────────────────────
  //
  // 实测：批测 08:53 开跑，09:08 起浮层全说「未连接」。access 15m + refresh 单次
  // 轮换 + MV3 worker 随时被杀 → 第一次轮换几乎必然发生在某次冷启动里，worker 死在
  // 「服务端已轮换、客户端未落盘」之间 → 日志位留下 → 下一次直接 clearSession()。
  describe('日志位不再等于死刑（服务端有宽限窗）', () => {
    it('日志位 + 服务端 201：带旧 token 问一次，救回会话、清日志位', async () => {
      const h = harness();
      await h.client.redeemHandoff(HANDOFF);
      h.store.data.set('authRotationInFlight', true);
      h.clock.t = NOW + 901; // 内存 token 真到期，只能走刷新
      expect(await h.client.getAccessToken()).not.toBeNull();
      expect(refreshCalls(h)).toHaveLength(1);
      expect(h.store.data.has('authRotationInFlight')).toBe(false);
      expect(await h.client.getUserId()).toBe(USER_1_ID);
      expect(h.diags).not.toContain('AUTH_REFRESH_FAILED');
    });

    it('日志位 + 服务端 4xx：确实不可恢复，才清空会话', async () => {
      const h = harness({
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(NOW + 900) };
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          if (path === '/auth/refresh') return { status: 401, body: { code: 'UNAUTHORIZED' } };
          return null;
        },
      });
      await h.client.redeemHandoff(HANDOFF);
      h.store.data.set('authRotationInFlight', true);
      h.clock.t = NOW + 901;
      expect(await h.client.getAccessToken()).toBeNull();
      expect(refreshCalls(h)).toHaveLength(1);
      expect(h.diags).toContain('AUTH_REFRESH_FAILED');
      expect(await h.client.getUserId()).toBeNull();
    });

    // 只要 worker 醒着，轮换就不会死在半路。alarm 把它在到期前 120s 叫醒。
    it('拿到 access token 就登记提前轮换：到期前 120s', async () => {
      const h = harness();
      await h.client.redeemHandoff(HANDOFF);
      expect(h.rotations).toEqual([NOW + 900 - 120]);
      h.clock.t = NOW + 800; // 提前轮换：拿到新 token 后再登记一次
      await h.client.forceRefresh();
      expect(h.rotations).toEqual([NOW + 900 - 120, NOW + 800 + 900 - 120]);
    });
  });

  it('SW 死在轮转窗口（日志位残留）：新实例带旧 token 问一次，宽限窗救回', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);
    shared.data.set('authRotationInFlight', true); // 模拟死在落盘前

    // 2026-09-20 改：这一幕正是「会话 15 分钟必死」的现场。以前新实例零重放、
    // 直接清会话；现在服务端有宽限窗（后继没被用过就允许再来一次），所以问一次。
    const second = harness({ store: shared });
    expect(await second.client.getAccessToken()).not.toBeNull();
    expect(refreshCalls(second)).toHaveLength(1);
    expect(second.diags).toContain('AUTH_REFRESH_GRACE_ATTEMPT');
    expect(second.diags).not.toContain('AUTH_REFRESH_FAILED');
    expect(shared.data.has('authRotationInFlight')).toBe(false);
    expect(await second.client.getUserId()).toBe(USER_1_ID);
  });

  it('轮转日志写盘失败时 fail closed，零调用 /auth/refresh 且不烧旧会话', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);
    const journalBroken: AuthKeyValueStore = {
      get: shared.get,
      remove: shared.remove,
      async set(key, value) {
        if (key === 'authRotationInFlight') throw new Error('journal unavailable');
        await shared.set(key, value);
      },
    };
    const second = harness({ store: journalBroken });

    expect(await second.client.forceRefresh()).toBeNull();
    expect(refreshCalls(second)).toHaveLength(0);
    expect(second.diags).toContain('AUTH_STORAGE_UNAVAILABLE');
    expect(await second.client.getUserId()).toBe(USER_1_ID);
    expect(shared.data.get('authSession')).toEqual({
      refreshToken: 'refresh_1',
      userId: USER_1_ID,
    });
  });

  it('轮转成功但新 session 落盘失败后，新 SW 带旧 token 问一次即救回', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);
    let rejectNextSessionWrite = true;
    const sessionWriteBroken: AuthKeyValueStore = {
      get: shared.get,
      remove: shared.remove,
      async set(key, value) {
        if (key === 'authSession' && rejectNextSessionWrite) {
          rejectNextSessionWrite = false;
          throw new Error('session write unavailable');
        }
        await shared.set(key, value);
      },
    };
    const rotating = harness({ store: sessionWriteBroken });

    expect(await rotating.client.forceRefresh()).not.toBeNull();
    expect(refreshCalls(rotating)).toHaveLength(1);
    expect(shared.data.get('authRotationInFlight')).toBe(true);

    // 2026-09-20 改：新对没落住盘，盘里还是 R0；服务端那边 R1 从未被用过——
    // 这正是宽限窗定义的情形。新 SW 带 R0 问一次就救回，不再清会话。
    const restarted = harness({ store: shared });
    expect(await restarted.client.getAccessToken()).not.toBeNull();
    expect(refreshCalls(restarted)).toHaveLength(1);
    expect(restarted.diags).not.toContain('AUTH_REFRESH_FAILED');
    expect(await restarted.client.getUserId()).toBe(USER_1_ID);
  });

  it('清会话时 session remove 单点失败必须保留 journal，下一实例再问一次并把清理做完', async () => {
    const shared = memoryStore();
    const first = harness({ store: shared });
    await first.client.redeemHandoff(HANDOFF);
    let rejectNextSessionWrite = true;
    const sessionWriteBroken: AuthKeyValueStore = {
      get: shared.get,
      remove: shared.remove,
      async set(key, value) {
        if (key === 'authSession' && rejectNextSessionWrite) {
          rejectNextSessionWrite = false;
          throw new Error('session write unavailable');
        }
        await shared.set(key, value);
      },
    };
    const rotating = harness({ store: sessionWriteBroken });
    expect(await rotating.client.forceRefresh()).not.toBeNull();
    expect(shared.data.get('authRotationInFlight')).toBe(true);
    expect(shared.data.get('authSession')).toEqual({
      refreshToken: 'refresh_1',
      userId: USER_1_ID,
    });

    let failSessionRemoveOnce = true;
    const selectiveRemoveFailure: AuthKeyValueStore = {
      get: shared.get,
      set: shared.set,
      async remove(key) {
        if (key === 'authSession' && failSessionRemoveOnce) {
          failSessionRemoveOnce = false;
          throw new Error('session remove unavailable');
        }
        await shared.remove(key);
      },
    };
    // 2026-09-20 改：日志位在时新实例会带旧 token 问一次；这里让服务端答 4xx，
    // 走到 clearSession——本条守的不变量是「remove 失败一次也不能丢日志位，
    // 下一实例要能把清理做完」，这一点不变。
    const rejected: Route = (path) => {
      if (path === '/auth/refresh') return { status: 401, body: { code: 'UNAUTHORIZED' } };
      return null;
    };
    const restarted = harness({ store: selectiveRemoveFailure, routes: rejected });
    expect(await restarted.client.getAccessToken()).toBeNull();
    expect(refreshCalls(restarted)).toHaveLength(1);
    expect(shared.data.has('authSession')).toBe(true);           // remove 失败，会话还在
    expect(shared.data.get('authRotationInFlight')).toBe(true);  // 日志位必须保留

    const restartedAgain = harness({ store: shared, routes: rejected });
    expect(await restartedAgain.client.getAccessToken()).toBeNull();
    expect(refreshCalls(restartedAgain)).toHaveLength(1);        // 再问一次，还是 4xx
    expect(shared.data.has('authSession')).toBe(false);          // 这次清干净了
    expect(shared.data.has('authRotationInFlight')).toBe(false);
  });

  it('4xx：会话不可恢复——清空等新交接', async () => {
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(NOW + 900) };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') return { status: 401, body: { code: 'AUTH_REFRESH_INVALID' } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.clock.t += 900;
    expect(await h.client.getAccessToken()).toBeNull();
    expect(h.diags).toContain('AUTH_REFRESH_FAILED');
    expect(await h.client.getUserId()).toBeNull();
  });

  it('登出与在途刷新竞态：新对不落盘且被尽力作废（纪元检查）', async () => {
    let releaseRefresh: (r: RouteResult) => void = () => {};
    const gate = new Promise<RouteResult>((resolve) => (releaseRefresh = resolve));
    const h = harness({
      routes: (path) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(NOW + 900) };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') return gate; // 悬在途
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.clock.t += 900;
    const pending = h.client.getAccessToken(); // 触发在途刷新
    await expect.poll(() => refreshCalls(h).length).toBe(1);
    const loggingOut = h.client.logout(); // 刷新未归即登出
    releaseRefresh({ status: 201, body: tokenPair(h.clock.t + 900, 'refresh_NEW') });
    await Promise.all([pending, loggingOut]);

    expect(await h.client.getUserId()).toBeNull(); // 会话没有复活
    expect(JSON.stringify([...h.store.data.entries()])).not.toContain('refresh_NEW');
    // 竞态里签出的新 refresh token 被尽力作废。
    const revokes = h.calls.filter((c) => c.path === '/auth/logout');
    expect(revokes.some((c) => c.body['refreshToken'] === 'refresh_NEW')).toBe(true);
  });

  it('A refresh 在途时兑换 B：A 结果只作废，最终 session 与 install 稳定属于 B', async () => {
    let releaseRefresh!: (result: RouteResult) => void;
    const refreshGate = new Promise<RouteResult>((resolve) => { releaseRefresh = resolve; });
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_B'
            ? { status: 201, body: tokenPair(NOW + 1800, 'refresh_B', USER_2_ID) }
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === '/auth/refresh') return refreshGate;
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.clock.t += 900;
    const refreshing = h.client.forceRefresh();
    await expect.poll(() => refreshCalls(h).length).toBe(1);

    const redeemingB = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
    releaseRefresh({ status: 201, body: tokenPair(h.clock.t + 900, 'refresh_A2', USER_1_ID) });

    await expect(refreshing).resolves.toBeNull();
    await expect(redeemingB).resolves.toBe(true);
    expect(await h.client.getUserId()).toBe(USER_2_ID);
    expect(h.store.data.get('authSession')).toEqual({ refreshToken: 'refresh_B', userId: USER_2_ID });
    expect(JSON.stringify([...h.store.data.entries()])).not.toContain('refresh_A2');
    const revokes = h.calls.filter((call) => call.path === '/auth/logout');
    expect(revokes.some((call) => call.body['refreshToken'] === 'refresh_A2')).toBe(true);
    const links = h.calls.filter((call) => call.path === LINK_INSTALL_PATH);
    expect(links.at(-1)?.bearer).toBe(makeJwt(NOW + 1800, USER_2_ID));
  });

  it('两个并发 redeem 按调用 generation 收口，迟到的旧账号不能覆盖新账号', async () => {
    let releaseA!: (result: RouteResult) => void;
    const gateA = new Promise<RouteResult>((resolve) => { releaseA = resolve; });
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_A'
            ? gateA
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) };
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        return null;
      },
    });
    const redeemA = h.client.redeemHandoff({ ...HANDOFF, code: 'code_A' });
    await expect.poll(
      () => h.calls.filter((call) => call.path === '/auth/extension-handoffs/redeem').length,
    ).toBe(1);
    const redeemB = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
    releaseA({ status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) });

    await expect(redeemA).resolves.toBe(false);
    await expect(redeemB).resolves.toBe(true);
    expect(await h.client.getUserId()).toBe(USER_2_ID);
    expect(h.store.data.get('authSession')).toEqual({ refreshToken: 'refresh_B', userId: USER_2_ID });
    expect(h.calls.filter((call) => call.path === LINK_INSTALL_PATH).at(-1)?.bearer)
      .toBe(makeJwt(NOW + 900, USER_2_ID));
    expect(h.calls.some(
      (call) => call.path === '/auth/logout' && call.body['refreshToken'] === 'refresh_A',
    )).toBe(true);
  });

  it('迟到的 A install 补登记先收口，随后 B redeem 必须成为最终 server owner', async () => {
    let installCount = 0;
    let releaseAInstall!: (result: RouteResult) => void;
    const delayedAInstall = new Promise<RouteResult>((resolve) => { releaseAInstall = resolve; });
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_B'
            ? { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) }
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === LINK_INSTALL_PATH) {
          installCount += 1;
          return installCount === 2 ? delayedAInstall : { status: 202, body: { ok: true } };
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.store.data.delete('extensionInstallLinked');

    const linkingA = h.client.ensureInstallLinked();
    await expect.poll(
      () => h.calls.filter((call) => call.path === LINK_INSTALL_PATH).length,
    ).toBe(2);
    const redeemingB = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
    releaseAInstall({ status: 202, body: { ok: true } });

    await linkingA;
    await expect(redeemingB).resolves.toBe(true);
    const links = h.calls.filter((call) => call.path === LINK_INSTALL_PATH);
    expect(links.at(-1)?.bearer).toBe(makeJwt(NOW + 900, USER_2_ID));
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_2_ID);
    expect(await h.client.getUserId()).toBe(USER_2_ID);
  });

  it('redeem 或 logout 一经调用，后到 getAccessToken 不会再拿到旧 generation', async () => {
    let releaseB!: (result: RouteResult) => void;
    let releaseLogout!: (result: RouteResult) => void;
    const bGate = new Promise<RouteResult>((resolve) => { releaseB = resolve; });
    const logoutGate = new Promise<RouteResult>((resolve) => { releaseLogout = resolve; });
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_B'
            ? bGate
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === '/auth/logout') {
          return body['refreshToken'] === 'refresh_B'
            ? logoutGate
            : { status: 201, body: { ok: true } };
        }
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    const oldAccess = makeJwt(NOW + 900, USER_1_ID);

    const redeemingB = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
    await expect.poll(
      () => h.calls.filter((call) => call.path === '/auth/extension-handoffs/redeem').length,
    ).toBe(2);
    const afterRedeem = h.client.getAccessToken();
    releaseB({ status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) });
    await expect(redeemingB).resolves.toBe(true);
    await expect(afterRedeem).resolves.toBe(makeJwt(NOW + 900, USER_2_ID));
    await expect(afterRedeem).resolves.not.toBe(oldAccess);

    const loggingOut = h.client.logout();
    await expect.poll(
      () => h.calls.filter(
        (call) => call.path === '/auth/logout' && call.body['refreshToken'] === 'refresh_B',
      ).length,
    ).toBe(1);
    const afterLogout = h.client.getAccessToken();
    releaseLogout({ status: 201, body: { ok: true } });
    await loggingOut;
    await expect(afterLogout).resolves.toBeNull();
  });

  it('getAccessToken 先排队、logout 后调用时，也不能在 logout 调用后返回旧 bearer', async () => {
    let installCount = 0;
    let releaseInstall!: (result: RouteResult) => void;
    const installGate = new Promise<RouteResult>((resolve) => { releaseInstall = resolve; });
    const h = harness({
      routes: (path) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return { status: 201, body: tokenPair(NOW + 900) };
        }
        if (path === LINK_INSTALL_PATH) {
          installCount += 1;
          return installCount === 2 ? installGate : { status: 202, body: { ok: true } };
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.store.data.delete('extensionInstallLinked');
    const blocking = h.client.ensureInstallLinked();
    await expect.poll(
      () => h.calls.filter((call) => call.path === LINK_INSTALL_PATH).length,
    ).toBe(2);

    const requestedBeforeLogout = h.client.getAccessToken();
    const loggingOut = h.client.logout();
    releaseInstall({ status: 202, body: { ok: true } });

    await blocking;
    await expect(requestedBeforeLogout).resolves.toBeNull();
    await loggingOut;
    expect(await h.client.getUserId()).toBeNull();
  });

  it('hung credential request 在 10s 硬超时后 abort 并释放 transition queue', async () => {
    vi.useFakeTimers();
    try {
      let hangFirstRedeem = true;
      const never = new Promise<RouteResult>(() => {});
      const h = harness({
        routes: (path, body) => {
          if (path === '/auth/extension-handoffs/redeem') {
            if (hangFirstRedeem) {
              hangFirstRedeem = false;
              return never;
            }
            return { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) };
          }
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          return null;
        },
      });
      const stalled = h.client.redeemHandoff(HANDOFF);
      await vi.advanceTimersByTimeAsync(0);
      const firstCall = h.calls.find(
        (call) => call.path === '/auth/extension-handoffs/redeem',
      );
      expect(firstCall?.init).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(firstCall?.init.signal?.aborted).toBe(false);

      const successor = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(firstCall?.init.signal?.aborted).toBe(true);
      await expect(stalled).resolves.toBe(false);
      await expect(successor).resolves.toBe(true);
      expect(await h.client.getUserId()).toBe(USER_2_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('headers 已到但 token body 永不结束，也在同一 10s deadline 内释放队列', async () => {
    vi.useFakeTimers();
    try {
      let hangFirstBody = true;
      const neverBody = new Promise<unknown>(() => {});
      const h = harness({
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') {
            if (hangFirstBody) {
              hangFirstBody = false;
              return { status: 201, body: neverBody };
            }
            return { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) };
          }
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          return null;
        },
      });
      const stalled = h.client.redeemHandoff(HANDOFF);
      await vi.advanceTimersByTimeAsync(0);
      const successor = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(stalled).resolves.toBe(false);
      await expect(successor).resolves.toBe(true);
      expect(await h.client.getUserId()).toBe(USER_2_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('production Response stream 超过 64 KiB 时拒绝且不写 session', async () => {
    const store = memoryStore();
    const oversized = JSON.stringify({
      ...tokenPair(NOW + 900),
      padding: 'x'.repeat(70 * 1024),
    });
    const client = createAuthClient({
      apiBase: 'https://api.test.invalid',
      store,
      now: () => NOW,
      fetchFn: (async () => new Response(oversized, {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    });

    await expect(client.redeemHandoff(HANDOFF)).resolves.toBe(false);
    expect(store.data.has('authSession')).toBe(false);
  });

  it('A 的 linked flag 不能隐藏 B 的失败登记，背景重试必须继续用 B bearer', async () => {
    let failBLink = true;
    const bAccess = makeJwt(NOW + 900, USER_2_ID);
    const h = harness({
      routes: (path, body, bearer) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_B'
            ? { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) }
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === LINK_INSTALL_PATH) {
          if (bearer === bAccess && failBLink) return { status: 503, body: {} };
          return { status: 202, body: { ok: true } };
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_1_ID);

    await expect(h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' })).resolves.toBe(false);
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_1_ID);
    expect(h.diags).toContain('AUTH_INSTALL_LINK_FAILED');

    failBLink = false;
    await h.client.ensureInstallLinked();
    const bLinks = h.calls.filter(
      (call) => call.path === LINK_INSTALL_PATH && call.bearer === bAccess,
    );
    expect(bLinks).toHaveLength(2);
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_2_ID);
  });

  it('install 登记失败：绑定 fail closed；ensureInstallLinked 可幂等补登记', async () => {
    let linkFails = true;
    const h = harness({
      routes: (path) => {
        if (path === '/auth/extension-handoffs/redeem') return { status: 201, body: tokenPair(h.clock.t + 900) };
        if (path === LINK_INSTALL_PATH) return linkFails ? { status: 500, body: {} } : { status: 202, body: { ok: true } };
        if (path === '/auth/refresh') return { status: 201, body: tokenPair(h.clock.t + 900) };
        return null;
      },
    });
    expect(await h.client.redeemHandoff(HANDOFF)).toBe(false);
    expect(h.diags).toContain('AUTH_INSTALL_LINK_FAILED');
    expect(h.store.data.has('extensionInstallLinked')).toBe(false);

    linkFails = false;
    await h.client.ensureInstallLinked();
    expect(h.store.data.get('extensionInstallLinked')).toBe(USER_1_ID);
    await h.client.ensureInstallLinked(); // 已登记 → 不再发
    expect(h.calls.filter((c) => c.path === LINK_INSTALL_PATH)).toHaveLength(2);
  });

  it('Portal attestation never trusts the linked marker and uses a zero-write owner read', async () => {
    let attestFails = false;
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return { status: 201, body: tokenPair(NOW + 900) };
        }
        if (path === LINK_INSTALL_PATH) {
          return { status: 202, body: { ok: true } };
        }
        if (path === ATTEST_INSTALL_PATH) {
          return attestFails
            ? { status: 503, body: {} }
            : {
              status: 200,
              body: {
                connected: true,
                installId: body['installId'],
                userId: USER_1_ID,
              },
            };
        }
        return null;
      },
    });
    expect(await h.client.redeemHandoff(HANDOFF)).toBe(true);
    const expected = {
      userId: USER_1_ID,
      installId: await h.client.getInstallId(),
    };

    const beforeWrongOwner = h.calls.length;
    await expect(h.client.attestInstallLinked(parseUuid(USER_2_ID)!)).resolves.toBeNull();
    expect(h.calls).toHaveLength(beforeWrongOwner);

    await expect(h.client.attestInstallLinked(parseUuid(USER_1_ID)!)).resolves.toEqual(expected);
    expect(h.calls.filter((call) => call.path === LINK_INSTALL_PATH)).toHaveLength(1);
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(1);

    attestFails = true;
    await expect(h.client.attestInstallLinked(parseUuid(USER_1_ID)!)).resolves.toBeNull();
    expect(h.calls.filter((call) => call.path === LINK_INSTALL_PATH)).toHaveLength(1);
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(2);
    expect(h.diags).toContain('AUTH_INSTALL_ATTESTATION_FAILED');
  });

  it('discards a deferred positive status result after a replacement redeem is invoked', async () => {
    let releaseStatus!: (result: RouteResult) => void;
    const statusGate = new Promise<RouteResult>((resolve) => {
      releaseStatus = resolve;
    });
    let statusInstallId: unknown;
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return body['code'] === 'code_B'
            ? { status: 201, body: tokenPair(NOW + 900, 'refresh_B', USER_2_ID) }
            : { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === ATTEST_INSTALL_PATH) {
          statusInstallId = body['installId'];
          return statusGate;
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);

    const readiness = h.client.readConnectionReadiness(USER_1_ID);
    await expect.poll(
      () => h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH).length,
    ).toBe(1);
    const redeemingB = h.client.redeemHandoff({ ...HANDOFF, code: 'code_B' });
    releaseStatus({
      status: 200,
      body: {
        connected: true,
        installId: statusInstallId,
        userId: USER_1_ID,
      },
    });

    await expect(readiness).resolves.toBe('AUTHORITY_UNAVAILABLE');
    await expect(redeemingB).resolves.toBe(true);
    expect(await h.client.getUserId()).toBe(USER_2_ID);
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(1);
  });

  it('discards a deferred positive status result after logout is invoked', async () => {
    let releaseStatus!: (result: RouteResult) => void;
    const statusGate = new Promise<RouteResult>((resolve) => {
      releaseStatus = resolve;
    });
    let statusInstallId: unknown;
    const h = harness({
      routes: (path, body) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return { status: 201, body: tokenPair(NOW + 900, 'refresh_A', USER_1_ID) };
        }
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        if (path === ATTEST_INSTALL_PATH) {
          statusInstallId = body['installId'];
          return statusGate;
        }
        if (path === '/auth/logout') return { status: 201, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);

    const readiness = h.client.readConnectionReadiness(USER_1_ID);
    await expect.poll(
      () => h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH).length,
    ).toBe(1);
    const loggingOut = h.client.logout();
    releaseStatus({
      status: 200,
      body: {
        connected: true,
        installId: statusInstallId,
        userId: USER_1_ID,
      },
    });

    await expect(readiness).resolves.toBe('AUTHORITY_UNAVAILABLE');
    await loggingOut;
    expect(await h.client.getUserId()).toBeNull();
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(1);
  });

  it('logout invocation fences Portal readiness before deferred diagnostics cleanup settles', async () => {
    let releaseCleanup!: () => void;
    let cleanupAccessToken: string | null | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const h = harness({
      onBeforeLogout: (accessToken) => {
        cleanupAccessToken = accessToken;
        return cleanupGate;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);

    const loggingOut = h.client.logout();
    await expect(h.client.attestInstallLinked(parseUuid(USER_1_ID)!)).resolves.toBeNull();

    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(0);
    expect(h.calls.filter((call) => call.path === '/auth/refresh')).toHaveLength(0);
    expect(cleanupAccessToken).toBe(makeJwt(NOW + 900));
    await expect.poll(() => h.store.data.has('authSession')).toBe(false);

    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(0);

    releaseCleanup();
    await loggingOut;
  });

  it('keeps readiness fenced through deferred cleanup when durable logout storage fails', async () => {
    const shared = memoryStore();
    let breakLogoutStorage = false;
    const selectivelyBroken: AuthKeyValueStore = {
      get: shared.get,
      async set(key, value) {
        if (breakLogoutStorage && key === 'authRotationInFlight') {
          throw new Error('tombstone unavailable');
        }
        await shared.set(key, value);
      },
      async remove(key) {
        if (breakLogoutStorage && key === 'authSession') {
          throw new Error('session remove unavailable');
        }
        await shared.remove(key);
      },
    };
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const h = harness({
      store: selectivelyBroken,
      onBeforeLogout: () => cleanupGate,
    });
    await h.client.redeemHandoff(HANDOFF);
    h.calls.splice(0);
    breakLogoutStorage = true;

    const loggingOut = h.client.logout();
    await expect(h.client.readConnectionReadiness(USER_1_ID))
      .resolves.toBe('AUTHORITY_UNAVAILABLE');
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(0);
    await expect.poll(() => h.diags).toContain('AUTH_LOGOUT_NOTIFY_FAILED');
    await expect(h.client.attestInstallLinked(parseUuid(USER_1_ID)!)).resolves.toBeNull();
    expect(h.calls.filter((call) => call.path === ATTEST_INSTALL_PATH)).toHaveLength(0);

    releaseCleanup();
    await loggingOut;
    expect(shared.data.has('authSession')).toBe(true);
  });

  it('cold A session without a linked marker rejects Portal B before refresh or API traffic', async () => {
    const store = memoryStore();
    store.data.set('authSession', {
      refreshToken: 'cold_owner_a_refresh',
      userId: USER_1_ID,
    });
    const h = harness({ store });

    await expect(h.client.attestInstallLinked(parseUuid(USER_2_ID)!)).resolves.toBeNull();

    expect(h.calls).toHaveLength(0);
    expect(store.data.has('extensionInstallLinked')).toBe(false);
  });

  it('logout 先清本地，且只接受 exact 201 {ok:true} 作废回执', async () => {
    for (const [logoutResult, accepted] of [
      [{ status: 200, body: { ok: true } }, false],
      [{ status: 202, body: { ok: true } }, false],
      [{ status: 204, body: null }, false],
      [{ status: 201, body: null }, false],
      [{ status: 201, body: { ok: false } }, false],
      [{ status: 201, body: { ok: true, extra: true } }, false],
      [{ status: 201, body: { ok: true }, raw: '{"ok":false,"\\u006fk":true}' }, false],
      [{ status: 500, body: {} }, false],
      [{ status: 201, body: { ok: true } }, true],
    ] as const) {
      if ('raw' in logoutResult) expect(JSON.parse(logoutResult.raw)).toEqual({ ok: true });
      const h = harness({
        routes: (path) => {
          if (path === '/auth/extension-handoffs/redeem') {
            return { status: 201, body: tokenPair(NOW + 900) };
          }
          if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
          if (path === '/auth/logout') return logoutResult;
          return null;
        },
      });
      await h.client.redeemHandoff(HANDOFF);
      await h.client.logout();
      expect(await h.client.getUserId()).toBeNull(); // 本地 fail-closed 已达成
      expect(h.diags.includes('AUTH_LOGOUT_NOTIFY_FAILED')).toBe(!accepted);
    }
  });

  it('tombstone set 与 session remove 同时失败时 logout 零网络，恢复后只做合法 rotation', async () => {
    const shared = memoryStore();
    let breakLogoutStorage = false;
    const selectivelyBroken: AuthKeyValueStore = {
      get: shared.get,
      async set(key, value) {
        if (breakLogoutStorage && key === 'authRotationInFlight') {
          throw new Error('tombstone unavailable');
        }
        await shared.set(key, value);
      },
      async remove(key) {
        if (breakLogoutStorage && key === 'authSession') {
          throw new Error('session remove unavailable');
        }
        await shared.remove(key);
      },
    };
    const warm = harness({ store: selectivelyBroken });
    await warm.client.redeemHandoff(HANDOFF);
    breakLogoutStorage = true;

    await warm.client.logout();
    expect(warm.calls.filter((call) => call.path === '/auth/logout')).toHaveLength(0);
    expect(warm.calls.filter((call) => call.path === '/auth/refresh')).toHaveLength(0);
    expect(warm.diags).toContain('AUTH_STORAGE_UNAVAILABLE');
    expect(warm.diags).toContain('AUTH_LOGOUT_NOTIFY_FAILED');
    expect(shared.data.get('authSession')).toEqual({
      refreshToken: 'refresh_1',
      userId: USER_1_ID,
    });

    breakLogoutStorage = false;
    const restarted = harness({ store: shared });
    expect(await restarted.client.getAccessToken()).not.toBeNull();
    expect(refreshCalls(restarted)).toHaveLength(1);
    expect(refreshCalls(restarted)[0]!.body).toEqual({ refreshToken: 'refresh_1' });
  });

  it('exp 解不出：保守本地 TTL + 诊断码，token 仍可用且不高频空转轮转', async () => {
    const h = harness({
      routes: (path) => {
        if (path === '/auth/extension-handoffs/redeem') {
          return { status: 201, body: { ...tokenPair(0), accessToken: 'opaque-token-no-jwt' } };
        }
        if (path === LINK_INSTALL_PATH) return { status: 202, body: { ok: true } };
        return null;
      },
    });
    await h.client.redeemHandoff(HANDOFF);
    expect(h.diags).toContain('AUTH_EXP_UNPARSEABLE');
    expect(await h.client.getAccessToken()).toBe('opaque-token-no-jwt'); // TTL 窗内直接可用
    expect(refreshCalls(h)).toHaveLength(0); // 没进高频轮转
  });

  it('installId：存储坏时进程内恒定；诊断只出闭集稳定码', async () => {
    const broken: AuthKeyValueStore = {
      get: async () => {
        throw new Error('storage dead');
      },
      set: async () => {
        throw new Error('storage dead');
      },
      remove: async () => {
        throw new Error('storage dead');
      },
    };
    const h = harness({ store: broken as never });
    const first = await h.client.getInstallId();
    expect(await h.client.getInstallId()).toBe(first); // 恒定，不再每次新造

    const known = new Set<string>(AUTH_CLIENT_DIAG_CODES);
    for (const code of h.diags) {
      expect(known.has(code), `闭集外诊断: ${code}`).toBe(true);
      expect(code).not.toContain('.');
    }
  });
});

it('clears credentials even when the invalidation observer throws', async () => {
  let fail = false;
  const h = harness({ onSessionInvalidated: () => { if (fail) throw new Error('OBSERVER_BUG'); } });
  await h.client.redeemHandoff(HANDOFF);
  expect(await h.client.getAccessToken()).not.toBeNull();
  fail = true;
  await h.client.logout();
  expect(await h.client.getAccessToken()).toBeNull();
  expect(h.store.data.has('authSession')).toBe(false);
  expect(h.diags).toContain('AUTH_INVALIDATION_OBSERVER_FAILED');
});

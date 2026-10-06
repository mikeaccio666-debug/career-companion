import { describe, expect, it, vi } from 'vitest';
import {
  createExecutionRuntimeBundleClient,
  type ExecutionRuntimeBundleContractCodec,
} from '../lib/executionRuntimeBundleClient';
import {
  createExecutionRuntimeBundleStore,
  EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY,
  type ExecutionRuntimeBundleKeyValueStore,
} from '../lib/executionRuntimeBundleStore';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

type TestBundle = Readonly<{
  schemaVersion: 1;
  runtimeBundleVersion: string;
  releaseRevision: string;
  issuedAt: string;
  notBefore: string;
  freshUntil: string;
  notAfter: string;
  compatibility: Readonly<{ minExtensionVersion: string }>;
  valid?: boolean;
}>;

function bundle(input: Partial<TestBundle> = {}): TestBundle {
  return Object.freeze({
    schemaVersion: 1,
    runtimeBundleVersion: `rb1_${HEX_A}`,
    releaseRevision: '7',
    issuedAt: '2026-08-23T11:55:00.000Z',
    notBefore: '2026-08-23T11:56:00.000Z',
    freshUntil: '2026-08-23T12:05:00.000Z',
    notAfter: '2026-08-23T13:00:00.000Z',
    compatibility: { minExtensionVersion: '0.0.0' },
    ...input,
  });
}

const codec: ExecutionRuntimeBundleContractCodec = {
  async decodeJson(raw) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      (value as TestBundle).valid === false ||
      typeof (value as TestBundle).runtimeBundleVersion !== 'string'
    ) return null;
    return value as never;
  },
  isCanonicalRaw(raw) {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  },
  classifyTime(value, nowMs) {
    const candidate = value as unknown as TestBundle;
    if (Date.parse(candidate.issuedAt) > nowMs || Date.parse(candidate.notBefore) > nowMs) {
      return 'TIME_INVALID';
    }
    if (nowMs >= Date.parse(candidate.notAfter)) return 'HARD_EXPIRED';
    if (nowMs >= Date.parse(candidate.freshUntil)) return 'STALE';
    return 'FRESH';
  },
  etagMatches(etag, value) {
    return etag === `"${(value as unknown as TestBundle).runtimeBundleVersion}"`;
  },
};

function response(
  status: number,
  body: unknown,
  etag?: string,
  contentType = 'application/json',
): Response {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (etag !== undefined) headers.etag = etag;
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function createMemoryStore(initial?: unknown) {
  let stored = initial;
  const writes: unknown[] = [];
  return {
    store: {
      read: vi.fn(async () => stored),
      write: vi.fn(async (etag: string, value: TestBundle, rawBody: string) => {
        stored = {
          schemaVersion: 1,
          etag,
          runtimeBundleVersion: value.runtimeBundleVersion,
          releaseRevision: value.releaseRevision,
          rawBody,
        };
        writes.push(stored);
      }),
    },
    writes,
    read: () => stored,
  };
}

function cached(value = bundle(), etag = `"${value.runtimeBundleVersion}"`) {
  return {
    schemaVersion: 1,
    etag,
    runtimeBundleVersion: value.runtimeBundleVersion,
    releaseRevision: value.releaseRevision,
    rawBody: JSON.stringify(value),
  };
}

function harness(input: Readonly<{
  initial?: unknown;
  responses?: readonly (Response | Error)[];
  apiBase?: string | null;
  now?: number;
  extensionVersion?: string;
}> = {}) {
  const memory = createMemoryStore(input.initial);
  const queue = [...(input.responses ?? [])];
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? response(503, { code: 'unavailable' });
  }) as unknown as typeof fetch;
  const client = createExecutionRuntimeBundleClient({
    apiBase: input.apiBase === undefined ? 'https://api.example.test' : input.apiBase,
    store: memory.store,
    codec,
    fetchFn,
    now: () => input.now ?? NOW,
    extensionVersion: () => input.extensionVersion ?? '1.2.3',
  });
  return { client, memory, calls, fetchFn };
}

describe('execution runtime bundle atomic store', () => {
  it('uses one stable key and one exact envelope write', async () => {
    const records = new Map<string, unknown>();
    const calls: Array<[string, unknown]> = [];
    const keyValue: ExecutionRuntimeBundleKeyValueStore = {
      get: async (key) => records.get(key),
      set: async (key, value) => {
        calls.push([key, value]);
        records.set(key, value);
      },
    };
    const store = createExecutionRuntimeBundleStore(keyValue);
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const rawBody = JSON.stringify(value);

    await store.write(etag, value as never, rawBody);

    expect(calls).toEqual([[
      EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY,
      {
        schemaVersion: 1,
        etag,
        runtimeBundleVersion: value.runtimeBundleVersion,
        releaseRevision: value.releaseRevision,
        rawBody,
      },
    ]]);
    await expect(store.read()).resolves.toEqual(calls[0]![1]);
  });
});

describe('execution runtime bundle fetch + remote-confirmation fail-closed', () => {
  it('accepts a strict 200 only after its strong ETag matches, then atomically persists it', async () => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const h = harness({ responses: [response(200, value, etag)] });

    await expect(h.client.refresh()).resolves.toEqual({
      ok: true,
      source: 'NETWORK',
      etag,
      bundle: value,
    });
    expect(h.memory.writes).toEqual([cached(value, etag)]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(
      'https://api.example.test/api/v1/ext/execution-runtime-bundle',
    );
    expect(h.calls[0]!.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    expect(h.calls[0]!.init?.body).toBeUndefined();
  });

  it('passes raw JSON to the contract decoder so duplicate-key evidence is not collapsed', async () => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const raw = `{"schemaVersion":1,"schemaVersion":1,"runtimeBundleVersion":"${value.runtimeBundleVersion}"}`;
    const decodeJson = vi.fn(async () => null);
    const client = createExecutionRuntimeBundleClient({
      apiBase: 'https://api.example.test',
      store: createMemoryStore().store,
      codec: { ...codec, decodeJson },
      now: () => NOW,
      extensionVersion: () => '1.0.0',
      fetchFn: vi.fn(async () => new Response(raw, {
        status: 200,
        headers: { 'content-type': 'application/json', etag },
      })),
    });

    await expect(client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_RESPONSE_MALFORMED',
    });
    expect(decodeJson).toHaveBeenCalledWith(raw);
  });

  it('sends the exact cached ETag and a matching 304 neither rewrites nor extends the bundle', async () => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const envelope = cached(value, etag);
    const h = harness({ initial: envelope, responses: [response(304, null, etag)] });

    await expect(h.client.refresh()).resolves.toEqual({
      ok: true,
      source: 'NOT_MODIFIED',
      etag,
      bundle: value,
    });
    expect(h.calls[0]!.init?.headers).toEqual({
      accept: 'application/json',
      'if-none-match': etag,
    });
    expect(h.memory.writes).toEqual([]);
    expect(h.memory.read()).toBe(envelope);
  });

  it.each([
    ['network exception', new Error('offline'), 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE'],
    ['timeout', new DOMException('timed out', 'TimeoutError'), 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE'],
    ['server outage', response(503, { code: 'unavailable' }), 'RUNTIME_BUNDLE_HTTP_REJECTED'],
  ] as const)('rejects a still-fresh allow cache after %s', async (_label, remote, code) => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const h = harness({ initial: cached(value, etag), responses: [remote] });

    await expect(h.client.refresh()).resolves.toEqual({ ok: false, code });
    expect(h.memory.writes).toEqual([]);
    expect(h.memory.read()).toEqual(cached(value, etag));
  });

  it.each([
    ['stale', bundle({ freshUntil: '2026-08-23T12:00:00.000Z' }), 'RUNTIME_BUNDLE_STALE'],
    ['hard expired', bundle({ notAfter: '2026-08-23T12:00:00.000Z' }), 'RUNTIME_BUNDLE_HARD_EXPIRED'],
    ['not active', bundle({ notBefore: '2026-08-23T12:00:01.000Z' }), 'RUNTIME_BUNDLE_TIME_INVALID'],
  ] as const)('rejects a matching 304 when its exact cache is %s', async (_label, value, code) => {
    const etag = `"${value.runtimeBundleVersion}"`;
    const h = harness({ initial: cached(value, etag), responses: [response(304, null, etag)] });
    await expect(h.client.refresh()).resolves.toEqual({ ok: false, code });
  });

  it.each([
    ['client rejection', response(403, { code: 'forbidden' }), 'RUNTIME_BUNDLE_HTTP_REJECTED'],
    ['malformed 200', response(200, { valid: false }, `"rb1_${HEX_B}"`), 'RUNTIME_BUNDLE_RESPONSE_MALFORMED'],
    ['non-JSON 200', response(200, 'not json', `"rb1_${HEX_B}"`, 'text/plain'), 'RUNTIME_BUNDLE_RESPONSE_MALFORMED'],
  ] as const)('does not use a fresh cache after a %s', async (_label, remote, code) => {
    const h = harness({ initial: cached(), responses: [remote] });
    await expect(h.client.refresh()).resolves.toEqual({ ok: false, code });
  });

  it.each([
    ['missing', undefined],
    ['weak', `W/"rb1_${HEX_A}"`],
    ['mismatched', `"rb1_${HEX_B}"`],
  ])('rejects a 200 response with a %s ETag without falling back', async (_label, etag) => {
    const value = bundle();
    const h = harness({ initial: cached(), responses: [response(200, value, etag)] });
    await expect(h.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_ETAG_INVALID',
    });
    expect(h.memory.writes).toEqual([]);
  });

  it('rejects a release rollback and preserves the newer cache', async () => {
    const current = bundle({ releaseRevision: '8' });
    const rollback = bundle({
      releaseRevision: '7',
      runtimeBundleVersion: `rb1_${HEX_B}`,
    });
    const h = harness({
      initial: cached(current),
      responses: [response(200, rollback, `"${rollback.runtimeBundleVersion}"`)],
    });

    await expect(h.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_ROLLBACK',
    });
    expect(h.memory.writes).toEqual([]);
    expect(h.memory.read()).toEqual(cached(current));
  });

  it('rejects same-revision identity collisions and preserves the cache', async () => {
    const current = bundle({ releaseRevision: '8' });
    const collision = bundle({
      releaseRevision: '8',
      runtimeBundleVersion: `rb1_${HEX_C}`,
    });
    const h = harness({
      initial: cached(current),
      responses: [response(200, collision, `"${collision.runtimeBundleVersion}"`)],
    });

    await expect(h.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_RELEASE_COLLISION',
    });
    expect(h.memory.writes).toEqual([]);
  });

  it.each([
    ['missing schemaVersion', { ...cached(), schemaVersion: undefined }],
    ['missing raw body', { ...cached(), rawBody: undefined }],
    ['extra key', { ...cached(), fetchedAt: NOW }],
    ['weak cached ETag', cached(bundle(), `W/"rb1_${HEX_A}"`)],
  ])('a partial/malformed cache cannot satisfy 304 or remote failure: %s', async (_label, initial) => {
    const h304 = harness({ initial, responses: [response(304, null, `"rb1_${HEX_A}"`)] });
    await expect(h304.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_NOT_MODIFIED_MISMATCH',
    });

    const offline = harness({ initial, responses: [new Error('offline')] });
    await expect(offline.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE',
    });
  });

  it('a 304 must repeat the exact strong cached ETag and never revives stale cache', async () => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const mismatch = harness({
      initial: cached(value, etag),
      responses: [response(304, null, `"rb1_${HEX_B}"`)],
    });
    await expect(mismatch.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_NOT_MODIFIED_MISMATCH',
    });

    const stale = bundle({ freshUntil: '2026-08-23T12:00:00.000Z' });
    const staleEtag = `"${stale.runtimeBundleVersion}"`;
    const stale304 = harness({
      initial: cached(stale, staleEtag),
      responses: [response(304, null, staleEtag)],
    });
    await expect(stale304.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_STALE',
    });
  });

  it('rejects an incompatible minimum extension version', async () => {
    const value = bundle({ compatibility: { minExtensionVersion: '2.0.0' } });
    const h = harness({
      responses: [response(200, value, `"${value.runtimeBundleVersion}"`)],
      extensionVersion: '1.9.9',
    });
    await expect(h.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_EXTENSION_INCOMPATIBLE',
    });
  });

  it('applies the same strict SemVer prerelease precedence as the bundle contract', async () => {
    const prereleaseMinimum = bundle({
      compatibility: { minExtensionVersion: '1.2.3-rc.1' },
    });
    const stable = harness({
      responses: [response(
        200,
        prereleaseMinimum,
        `"${prereleaseMinimum.runtimeBundleVersion}"`,
      )],
      extensionVersion: '1.2.3',
    });
    await expect(stable.client.refresh()).resolves.toMatchObject({
      ok: true,
      source: 'NETWORK',
    });

    const stableMinimum = bundle({ compatibility: { minExtensionVersion: '1.2.3' } });
    for (const extensionVersion of ['1.2.3-rc.1', '1.2.3-01', '1.2.3-alpha..1']) {
      const candidate = harness({
        responses: [response(
          200,
          stableMinimum,
          `"${stableMinimum.runtimeBundleVersion}"`,
        )],
        extensionVersion,
      });
      await expect(candidate.client.refresh()).resolves.toEqual({
        ok: false,
        code: 'RUNTIME_BUNDLE_EXTENSION_INCOMPATIBLE',
      });
    }
  });

  it('does not fetch or read cache when the endpoint origin is not explicitly configured', async () => {
    const h = harness({ apiBase: null, initial: cached() });
    await expect(h.client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_CONFIG_UNAVAILABLE',
    });
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.memory.store.read).not.toHaveBeenCalled();
  });

  it('fails closed when atomic persistence fails, even after a valid 200', async () => {
    const value = bundle();
    const memory = createMemoryStore();
    memory.store.write.mockRejectedValueOnce(new Error('storage unavailable'));
    const client = createExecutionRuntimeBundleClient({
      apiBase: 'https://api.example.test',
      store: memory.store,
      codec,
      now: () => NOW,
      extensionVersion: () => '1.0.0',
      fetchFn: vi.fn(async () => response(200, value, `"${value.runtimeBundleVersion}"`)),
    });

    await expect(client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_PERSIST_FAILED',
    });
  });

  it('fails closed before network access when storage cannot be read', async () => {
    const fetchFn = vi.fn();
    const client = createExecutionRuntimeBundleClient({
      apiBase: 'https://api.example.test',
      store: {
        read: async () => { throw new Error('storage unavailable'); },
        write: async () => {},
      },
      codec,
      now: () => NOW,
      extensionVersion: () => '1.0.0',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_STORAGE_UNAVAILABLE',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns a stable disabled Result instead of rejecting on an unexpected dependency failure', async () => {
    const value = bundle();
    const client = createExecutionRuntimeBundleClient({
      apiBase: 'https://api.example.test',
      store: createMemoryStore().store,
      codec,
      now: () => { throw new Error('clock unavailable'); },
      extensionVersion: () => '1.0.0',
      fetchFn: vi.fn(async () => response(200, value, `"${value.runtimeBundleVersion}"`)),
    });

    await expect(client.refresh()).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE',
    });
  });

  it('can replace a malformed cache only with a newly verified complete 200', async () => {
    const value = bundle();
    const etag = `"${value.runtimeBundleVersion}"`;
    const h = harness({
      initial: { schemaVersion: 1, etag },
      responses: [response(200, value, etag)],
    });

    await expect(h.client.refresh()).resolves.toEqual({
      ok: true,
      source: 'NETWORK',
      etag,
      bundle: value,
    });
    expect(h.memory.read()).toEqual(cached(value, etag));
  });

  it('single-flights concurrent refreshes so an older response cannot overwrite a newer one', async () => {
    const value = bundle();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => {
      await waiting;
      return response(200, value, `"${value.runtimeBundleVersion}"`);
    });
    const memory = createMemoryStore();
    const client = createExecutionRuntimeBundleClient({
      apiBase: 'https://api.example.test',
      store: memory.store,
      codec,
      now: () => NOW,
      extensionVersion: () => '1.0.0',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const first = client.refresh();
    const second = client.refresh();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, source: 'NETWORK' }),
      expect.objectContaining({ ok: true, source: 'NETWORK' }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(memory.store.write).toHaveBeenCalledTimes(1);
  });
});

/**
 * 取数失败时**不得**沿用缓存——哪怕它还在有效期内。
 *
 * 2026-09-18 生产事故之后我试图改掉这一条：一次错误的规则同步让
 * `/execution-runtime-bundle` 全员 503，所有用户的插件当场失能，而每个人
 * storage 里都躺着一份完全有效的规则包（实测那台机器缓存的 `rb1_63b3145b…`
 * 与事故前生产在服的那一份逐字相同）。「后端抖一下 = 产品下线」看起来显然该修。
 *
 * **不该修。** 两条理由，第二条是决定性的：
 *
 * 1. RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 明确点名：取数失败、超时、配置无效或
 *    状态不可证实时保持关闭，**不得以缓存命中推断 production 已放行**。
 * 2. 503 是**有歧义**的。`resolvePublishedBundle()` 在
 *    `AGENT_EXECUTION_RUNTIME_BUNDLE_ENABLED !== true` 时返回 `unavailable()`
 *    ——也就是说**运营方的总开关关掉，长得和「后端挂了」一模一样**。沿用缓存
 *    等于让 kill switch 失效：运营方按下停止键，插件继续填。
 *
 * 上面 `rejects a still-fresh allow cache after %s` 那三条守的就是这件事。
 * 它们当时没写理由，所以这段注释补在这里，免得下一个人（或我自己）再试一次。
 *
 * 用户看到的那个真问题是另一回事，修在别处：取不到规则时面板说「这一页没有
 * 认出申请表」是**假话**——真话是「我们暂时取不到规则」。骗人的文案要改，
 * 失效的闸不能开。
 */

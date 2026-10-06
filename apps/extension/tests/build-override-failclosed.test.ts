import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveExtensionPublicKey } from '../lib/buildConfig';

// Load the actual WXT config: invalid development overrides must throw,
// while store artifacts ignore residual development authority.
const ENV_KEYS = [
  'VIBE_API_BASE',
  'VIBE_WEB_BASE',
  'VIBE_DIST',
  'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED',
  'VIBE_CONTROLLED_MOCK_WRITES',
  'VIBE_LIVE_HOST_WRITES',
  'VIBE_TRUST_TELEMETRY_ENABLED',
  'VIBE_PILOT_UA1_DISCOVERY_ENABLED',
  'VIBE_EXTENSION_FIELD_LAB_ENABLED',
  'VIBE_EXTENSION_CONNECTED_DEV_ENABLED',
  'VIBE_EXTENSION_CONNECTED_STAGING_ENABLED',
  'VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED',
  'VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL',
  'VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY',
  'VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE',
  'VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER',
] as const;

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  vi.resetModules();
}

type Config = {
  entrypointsDir?: string;
  filterEntrypoints?: readonly string[];
  manifest?: Record<string, unknown>;
  outDir?: string;
  vite?: (env?: { command: 'build' | 'serve' }) => { define?: Record<string, string> };
  hooks?: { 'build:manifestGenerated'?: (wxt: unknown, manifest: { content_scripts?: Array<{ matches?: string[] }> }) => void };
};
async function loadConfig(): Promise<Config> {
  return (await import('../wxt.config')).default as Config;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

describe('explicit independent staging current-page artifact', () => {
  const staging = {
    VIBE_DIST: 'connected-staging', VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1',
    VIBE_EXTENSION_CONNECTED_STAGING_ENABLED: '1', VIBE_API_BASE: 'https://staging-api.career-companion.invalid',
    VIBE_WEB_BASE: 'https://staging.career-companion.invalid',
  } as const;
  const activation = { ...staging,
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: '1',
    VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://job-boards.greenhouse.io/edaix-canary/jobs/1',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY: 'STAGING_CURRENT_PAGE_FILL_IMPLEMENTATION_APPROVED_2026-09-09',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE: '2026-09-05T03:00:00.000Z',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-05T03:15:00.000Z',
  } as const;
  it('builds the real panel in the exact staging pair with writes off by default', async () => {
    setEnv(staging);
    const config = await loadConfig();
    expect(config.entrypointsDir).toBe('entrypoints-connected');
    expect(config.filterEntrypoints).toEqual(['sidepanel', 'background', 'apply']);
    expect(config.manifest?.host_permissions).toEqual(['https://staging-api.career-companion.invalid/*', 'https://job-boards.greenhouse.io/*']);
    expect(config.manifest?.externally_connectable).toEqual({ matches: ['https://staging.career-companion.invalid/*'] });
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__: 'true', __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: 'false',
    });
  });
  it('limits a separately configured write artifact to one page and explicit maximum 15 minute window', async () => {
    setEnv(activation);
    const config = await loadConfig();
    const manifest = { content_scripts: [{ matches: ['https://*/*'] }] };
    config.hooks?.['build:manifestGenerated']?.({}, manifest);
    expect(manifest.content_scripts[0]?.matches).toEqual([activation.VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL]);
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__: 'true', __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: 'true',
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__: String(Date.parse(activation.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE)),
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__: String(Date.parse(activation.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER)),
    });
  });
  it.each([
    { VIBE_EXTENSION_CONNECTED_STAGING_ENABLED: '0' }, { VIBE_API_BASE: 'http://localhost:3000' },
    { VIBE_WEB_BASE: 'http://localhost:3100' }, { VIBE_DIST: 'connected-dev' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY: 'POST_PR189_MAIN_2001029F+GREENHOUSE_CONNECTED_DEV_ACTIVATION_IMPLEMENTATION_2026-09-04' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE: '' }, { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-05T03:15:00.001Z' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://job-boards.greenhouse.io/edaix-canary/jobs/1?other=1' },
    { VIBE_CONTROLLED_MOCK_WRITES: '1' }, { VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '1' },
  ])('rejects conflicting staging inputs %j', async (override) => {
    setEnv({ ...activation, ...override });
    await expect(loadConfig()).rejects.toThrow();
  });
  it('refuses a store build even with the full staging tuple', async () => {
    setEnv({ ...activation, VIBE_DIST: 'store' });
    await expect(loadConfig()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
});

describe('approved controlled local TEXT build', () => {
  const localEnv = {
    VIBE_DIST: 'connected-dev',
    VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1',
    VIBE_API_BASE: 'http://localhost:3000',
    VIBE_WEB_BASE: 'http://localhost:3100',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: '1',
    VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL:
      'https://127.0.0.1:9443/__edaix_controlled__/p1-native-text',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY:
      'FIRST_LOCAL_TEXT_ADMISSION_APPROVED_828AAC2E_2026-09-05',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE: '2026-09-06T03:00:00.000Z',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-06T03:15:00.000Z',
  } as const;

  it('bakes the explicit window and sole target into a separate artifact', async () => {
    setEnv(localEnv);
    const config = await loadConfig();
    expect(config.outDir).toBe('.output-connected-dev-local');
    expect(config.manifest?.host_permissions).toEqual([
      'http://localhost:3000/*', 'https://127.0.0.1:9443/*',
    ]);
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__: JSON.stringify(localEnv.VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY),
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__: '"https://127.0.0.1:9443"',
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__: '"/__edaix_controlled__/p1-native-text"',
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__: String(Date.parse(localEnv.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE)),
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__: String(Date.parse(localEnv.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER)),
    });
    const manifest = { content_scripts: [{ matches: ['https://*/*'] }] };
    config.hooks?.['build:manifestGenerated']?.({}, manifest);
    expect(manifest.content_scripts[0]?.matches).toEqual([localEnv.VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL]);
  });

  it.each([
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE: '' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-06T03:15:00.001Z' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-06T02:59:59.999Z' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER: '2026-09-13T00:00:00.000Z' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE: '2026-09-06 03:00:00' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://127.0.0.1:9444/__edaix_controlled__/p1-native-text' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://127.0.0.1:9443/__edaix_controlled__/p1-native-text?x=1' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://127.0.0.1:9443/__edaix_controlled__/p1-native-text#x' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://localhost:9443/__edaix_controlled__/p1-native-text' },
    { VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://job-boards.greenhouse.io/acme/jobs/1' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY: 'true' },
    { VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: '0' },
    { VIBE_DIST: 'development' },
    { VIBE_DIST: 'field-lab', VIBE_EXTENSION_FIELD_LAB_ENABLED: '1' },
  ])('rejects malformed or broadened local admission: %j', async (patch) => {
    setEnv({ ...localEnv, ...patch });
    await expect(loadConfig()).rejects.toThrow(/CONNECTED_DEV_|FIELD_LAB_/);
  });

  it('refuses a store build even with the full local authority tuple', async () => {
    setEnv({ ...localEnv, VIBE_DIST: 'store' });
    await expect(loadConfig()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
});

describe('development overrides and default-off runtime flags', () => {
  it.each([
    ['VIBE_API_BASE', 'ftp://bad.example'], ['VIBE_API_BASE', 'not-a-url'],
    ['VIBE_API_BASE', 'http://api.edaix.io'], ['VIBE_API_BASE', ''],
    ['VIBE_WEB_BASE', 'ftp://bad.example'], ['VIBE_WEB_BASE', 'javascript:alert(1)'],
    ['VIBE_WEB_BASE', ''],
  ])('rejects explicit invalid %s=%s instead of falling back', async (key, raw) => {
    setEnv({ [key]: raw });
    await expect(loadConfig()).rejects.toThrow(new RegExp(`${key} 覆盖值被拒收`));
  });

  it.each([
    {},
    { VIBE_API_BASE: 'https://staging-api.edaix.io', VIBE_WEB_BASE: 'https://staging.edaix.io' },
  ])('accepts absent/valid overrides and ignores store residue: %j', async (env) => {
    setEnv(env);
    await expect(loadConfig()).resolves.toBeTruthy();
  });

  it.each([
    [{ VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '1' }, /必须同时提供合法 VIBE_API_BASE/],
    [{ VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: 'yes' }, /只接受 0 或 1/],
    [{ VIBE_PILOT_UA1_DISCOVERY_ENABLED: 'yes' }, /只接受 0 或 1/],
  ] as const)('rejects incomplete or invalid runtime authority: %j', async (env, reason) => {
    setEnv(env);
    await expect(loadConfig()).rejects.toThrow(reason);
  });

  it.each([
    [{ VIBE_API_BASE: 'https://staging-api.edaix.io' }, 'false'],
    [{ VIBE_API_BASE: 'https://staging-api.edaix.io', VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '1' }, 'true'],
    // 商店包不看这个环境变量——这条不变，变的是它的结论。规则包是商店包认出
    // ATS 页面的唯一来源（registry 的默认表是空的，取不到就一家也认不出），
    // 所以它恒开，取数目标恒为钉死的生产 origin。
  ] as const)('keeps the execution-runtime build gate independent: %j', async (env, expected) => {
    setEnv(env);
    expect((await loadConfig()).vite?.().define?.__VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__).toBe(expected);
  });

  it.each([
    [{}, 'false'],
    [{ VIBE_LIVE_HOST_WRITES: '0' }, 'false'],
    [{ VIBE_LIVE_HOST_WRITES: '1' }, 'true'],
    // 商店包恒开真实写入（2026-09-23 负责人决定），同样不看环境变量：能在远程关掉它的是运行时包里的
    // 策略（取不到、解不开即关），不是构建机上一个游离的环境变量。没有它，商店包在每个真实招聘页上
    // 都把策略判成关闭，认得出表单、一格也写不进。
  ] as const)('live host writes: internal builds opt in, the store build is pinned on: %j', async (env, expected) => {
    setEnv(env);
    expect((await loadConfig()).vite?.().define?.__VIBE_LIVE_HOST_WRITES__).toBe(expected);
  });

  it('rejects a malformed live-writes flag outside the store build', async () => {
    setEnv({ VIBE_LIVE_HOST_WRITES: 'yes' });
    await expect(loadConfig()).rejects.toThrow(/VIBE_LIVE_HOST_WRITES 只接受 0 或 1/);
  });

  it.each([
    [{}, false],
    [{ VIBE_PILOT_UA1_DISCOVERY_ENABLED: '1' }, true],
  ] as const)('emits discovery action only for explicit non-store authority: %j', async (env, enabled) => {
    setEnv(env);
    const config = await loadConfig();
    expect(config.vite?.().define?.__VIBE_PILOT_UA1_DISCOVERY_ENABLED__).toBe(String(enabled));
    // alarms：到期前 120s 叫醒 worker 提前轮换（2026-09-20，会话 15 分钟必死的修法之一）。
    expect(config.manifest?.permissions).toEqual(['storage', 'alarms']);
    if (enabled) expect(config.manifest?.action).toEqual({ default_title: 'Discover controls on this page' });
    else expect(config.manifest).not.toHaveProperty('action');
  });
});

describe('Field Lab exact unpacked-build identity', () => {
  it('is absent from the default build', async () => {
    setEnv({});
    const config = await loadConfig();
    expect(config.filterEntrypoints).toEqual(['background', 'apply']);
    expect(config.outDir).toBe('.output');
    expect(config.vite?.().define?.__VIBE_EXTENSION_FIELD_LAB_ENABLED__).toBe('false');
  });

  it.each([
    [{ VIBE_EXTENSION_FIELD_LAB_ENABLED: 'yes' }, /FIELD_LAB_FLAG_INVALID/],
    [{ VIBE_EXTENSION_FIELD_LAB_ENABLED: '1' }, /FIELD_LAB_BUILD_IDENTITY_INVALID/],
    [{ VIBE_DIST: 'field-lab' }, /FIELD_LAB_BUILD_IDENTITY_INVALID/],
  ] as const)('requires both exact keys and rejects malformed identities: %j', async (env, code) => {
    setEnv(env);
    await expect(loadConfig()).rejects.toThrow(code);
  });

  it('emits only the sidepanel entry under the exact build identity', async () => {
    setEnv({
      VIBE_DIST: 'field-lab',
      VIBE_EXTENSION_FIELD_LAB_ENABLED: '1',
      VIBE_TRUST_TELEMETRY_ENABLED: 'false',
    });
    const config = await loadConfig();
    expect(config.filterEntrypoints).toEqual(['sidepanel']);
    expect(config.outDir).toBe('.output-field-lab');
    expect(config.manifest).not.toHaveProperty('permissions');
    expect(config.manifest).not.toHaveProperty('host_permissions');
    expect(config.manifest).not.toHaveProperty('externally_connectable');
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_API_BASE__: 'null',
      __VIBE_WEB_BASE__: 'null',
      __VIBE_TRUST_TELEMETRY_ENABLED__: 'false',
      __VIBE_CONTROLLED_MOCK_WRITES__: 'false',
      __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__: 'false',
      __VIBE_PILOT_UA1_DISCOVERY_ENABLED__: 'false',
      __VIBE_EXTENSION_FIELD_LAB_ENABLED__: 'true',
    });
    expect(() => config.vite?.({ command: 'serve' })).toThrow(
      /Field Lab .*WXT build.*serve\/HMR/u,
    );
  });

  it.each([
    { VIBE_API_BASE: 'https://staging-api.edaix.io' },
    { VIBE_TRUST_TELEMETRY_ENABLED: 'true' },
    { VIBE_CONTROLLED_MOCK_WRITES: 'yes' },
  ])('rejects Field Lab runtime residue: %j', async (residue) => {
    setEnv({ VIBE_DIST: 'field-lab', VIBE_EXTENSION_FIELD_LAB_ENABLED: '1', ...residue });
    await expect(loadConfig()).rejects.toThrow(/FIELD_LAB_RUNTIME_FLAG_CONFLICT/);
  });

  it('refuses a store build with residual Field Lab flags', async () => {
    setEnv({ VIBE_DIST: 'store', VIBE_EXTENSION_FIELD_LAB_ENABLED: '1' });
    await expect(loadConfig()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
});

describe('connected-dev exact unpacked-build identity', () => {
  const connectedEnv = {
    VIBE_DIST: 'connected-dev',
    VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1',
    VIBE_API_BASE: 'http://localhost:3000',
    VIBE_WEB_BASE: 'http://localhost:3100',
  } as const;
  const activationEnv = {
    ...connectedEnv,
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: '1',
    VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL:
      'https://job-boards.greenhouse.io/edaix-canary/jobs/424242',
    VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY:
      'POST_PR189_MAIN_2001029F+GREENHOUSE_CONNECTED_DEV_ACTIVATION_IMPLEMENTATION_2026-09-04',
  } as const;

  it.each([
    [{ VIBE_EXTENSION_CONNECTED_DEV_ENABLED: 'yes' }, /CONNECTED_DEV_FLAG_INVALID/],
    [{ VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1' }, /CONNECTED_DEV_BUILD_IDENTITY_INVALID/],
    [{ VIBE_DIST: 'connected-dev' }, /CONNECTED_DEV_BUILD_IDENTITY_INVALID/],
  ] as const)('requires both exact build identity keys: %j', async (env, code) => {
    setEnv(env);
    await expect(loadConfig()).rejects.toThrow(code);
  });

  it.each([
    [{ VIBE_DIST: 'connected-dev', VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1', }, /CONNECTED_DEV_RUNTIME_REALM_INVALID/],
    [{ ...connectedEnv, VIBE_API_BASE: 'https://staging-api.edaix.io', }, /CONNECTED_DEV_RUNTIME_REALM_INVALID/],
  ] as const)('requires the one fixed local API and Portal rehearsal realm: %j', async (env, code) => {
    setEnv(env);
    await expect(loadConfig()).rejects.toThrow(code);
  });

  it('emits exactly sidepanel + background + apply with a narrow manifest', async () => {
    setEnv(connectedEnv);
    const config = await loadConfig();
    expect(config.entrypointsDir).toBe('entrypoints-connected');
    expect(config.filterEntrypoints).toEqual(['sidepanel', 'background', 'apply']);
    expect(config.outDir).toBe('.output-connected-dev');
    expect(config.manifest).toEqual({
      name: 'EdAIX Connected Lab (Unpacked Dev)',
      description: 'Local-only current-page Autofill rehearsal; never submits',
      action: { default_title: 'Open EdAIX Connected Lab' },
      permissions: ['storage'],
      host_permissions: [
        'http://localhost:3000/*',
        'https://job-boards.greenhouse.io/*',
      ],
      externally_connectable: { matches: ['http://localhost:3100/*'] },
    });
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_API_BASE__: '"http://localhost:3000"',
      __VIBE_WEB_BASE__: '"http://localhost:3100"',
      __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__: 'true',
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: 'false',
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__: 'null',
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__: 'null',
      __VIBE_EXTENSION_FIELD_LAB_ENABLED__: 'false',
      __VIBE_CONTROLLED_MOCK_WRITES__: 'false',
      __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__: 'false',
      __VIBE_PILOT_UA1_DISCOVERY_ENABLED__: 'false',
    });

    const manifest = { content_scripts: [{ matches: ['https://*/*'] }] };
    config.hooks?.['build:manifestGenerated']?.({}, manifest);
    expect(manifest.content_scripts[0]?.matches).toEqual([
      'https://job-boards.greenhouse.io/*',
    ]);
  });

  it.each([
    [{ ...connectedEnv, VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: 'yes' }, /CONNECTED_DEV_WRITE_FLAG_INVALID/],
    [{ ...connectedEnv, VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED: '1' }, /CONNECTED_DEV_WRITE_AUTHORITY_INVALID/],
    [{ ...activationEnv, VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://example.com/acme/jobs/42', }, /CONNECTED_DEV_TARGET_INVALID/],
    [{ ...activationEnv, VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL: 'https://job-boards.greenhouse.io/edaix-canary/jobs/424242?candidate=private', }, /CONNECTED_DEV_TARGET_INVALID/],
  ] as const)('requires all exact-page activation keys and rejects a broad or non-Greenhouse target: %j', async (env, code) => {
    setEnv(env);
    await expect(loadConfig()).rejects.toThrow(code);
  });

  it('emits a separate exact-path, expiring activation artifact only under the full authority tuple', async () => {
    setEnv(activationEnv);
    const config = await loadConfig();
    expect(config.outDir).toBe('.output-connected-dev-activation');
    expect(config.manifest).toMatchObject({
      name: 'EdAIX Connected Lab — Exact Page (Unpacked Dev)',
      permissions: ['storage'],
      host_permissions: [
        'http://localhost:3000/*',
        'https://job-boards.greenhouse.io/*',
      ],
    });
    expect(config.vite?.({ command: 'build' }).define).toMatchObject({
      __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: 'true',
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__:
        '"https://job-boards.greenhouse.io"',
      __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__:
        '"/edaix-canary/jobs/424242"',
    });
    expect(Number(config.vite?.({ command: 'build' }).define
      ?.__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__)).toBeGreaterThan(0);

    const manifest = { content_scripts: [{ matches: ['https://*/*'] }] };
    config.hooks?.['build:manifestGenerated']?.({}, manifest);
    expect(manifest.content_scripts[0]?.matches).toEqual([
      'https://job-boards.greenhouse.io/edaix-canary/jobs/424242',
    ]);
  });

  it('does not leak through default, store, or Field Lab identities', async () => {
    for (const env of [
      {},
      { VIBE_DIST: 'store', VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1' },
      {
        VIBE_DIST: 'field-lab',
        VIBE_EXTENSION_FIELD_LAB_ENABLED: '1',
        VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1',
      },
    ]) {
      setEnv(env);
      if (env.VIBE_DIST === 'field-lab') {
        await expect(loadConfig()).rejects.toThrow(/FIELD_LAB_RUNTIME_FLAG_CONFLICT/);
      } else if (env.VIBE_DIST === 'store') {
        await expect(loadConfig()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
      } else {
        const config = await loadConfig();
        expect(config.vite?.().define?.__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__).toBe('false');
        expect(config.vite?.().define?.__VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__).toBe('false');
        expect(config.filterEntrypoints).not.toContain('sidepanel');
      }
    }
  });
});

/**
 * The extension id is derived from this key by the browser, so a build that
 * takes the wrong one — or lets the store build take one at all — hands users
 * an identity the portal will not talk to.
 */
describe('resolveExtensionPublicKey', () => {
  const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2DbIDOT5VpYKyQbwk6xytDSppLzbocYYdguvDSL3Xm4aNsbOLm4ttyHS0f3Ws8uFV2kbpoeYlnkGnNAWCRN0uO4Dtl5bp59ZlXi8bktKoTQaXa8elNuEgVr9jkbEfvxuf9IDrcTgMhbGXhdWXpyGvM1G7AsYJdhX6X1Bf5apjGNlJ/DIZuRCuq7za7wsrGu/kP89lCDpTnQjWL5QlaBKcnPql8VuAwviEIj7R7KAOUvCevATXbNvFXlb1yCsTSqNz7CXMZSWUdx8NIEazblRtC5KDTmJGWWGaWaKJWeDYrgCTQAfcV2IuxQnK4pQpxK2r5j8lM/9ofBrCkmAOCJxFQIDAQAB';
  it('accepts an exact base64 key for a non-store build', () => {
    expect(resolveExtensionPublicKey({ storeBuild: false, raw: KEY })).toBe(KEY);
  });
  it('never lets a store build claim an identity from the environment', () => {
    expect(resolveExtensionPublicKey({ storeBuild: true, raw: KEY })).toBeNull();
  });
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace padded', ` ${KEY} `],
    ['not base64', 'not a key at all!!'],
    ['pem wrapped', `-----BEGIN PUBLIC KEY-----\n${KEY}\n-----END PUBLIC KEY-----`],
  ])('refuses %s rather than shipping a path-derived id', (_label, raw) => {
    expect(resolveExtensionPublicKey({ storeBuild: false, raw: raw as string | undefined })).toBeNull();
  });
});

describe('构建形态随版本号一起上报（2026-10-04，体检 11-3）', () => {
  it.each([
    [{}, 'unpacked'],
    [{ VIBE_DIST: 'local', VIBE_API_BASE: 'http://localhost:3000', VIBE_WEB_BASE: 'http://localhost:3100' }, 'local'],
    [{ VIBE_DIST: 'field-lab', VIBE_EXTENSION_FIELD_LAB_ENABLED: '1' }, 'field-lab'],
    [{
      VIBE_DIST: 'connected-staging', VIBE_EXTENSION_CONNECTED_DEV_ENABLED: '1', VIBE_EXTENSION_CONNECTED_STAGING_ENABLED: '1',
      VIBE_API_BASE: 'https://staging-api.career-companion.invalid', VIBE_WEB_BASE: 'https://staging.career-companion.invalid',
    }, 'connected-staging'],
  ])('%j → %s（指向生产的本机包不再报成和商店包一样的版本号）', async (env, flavor) => {
    setEnv(env);
    const config = await loadConfig();
    expect(config.vite?.({ command: 'build' }).define?.__VIBE_BUILD_FLAVOR__).toBe(JSON.stringify(flavor));
  });

  it('只有那几个词；Assistant 构建是 assistant', async () => {
    const { resolveBuildFlavor } = await import('../lib/buildConfig');
    expect(resolveBuildFlavor({ dist: undefined, assistant: true })).toBe('assistant');
    expect(resolveBuildFlavor({ dist: 'ats-lab', assistant: false })).toBe('ats-lab');
    expect(resolveBuildFlavor({ dist: 'connected-dev', assistant: false })).toBe('connected-dev');
    expect(resolveBuildFlavor({ dist: 'something-new', assistant: false })).toBe('unpacked');
  });
});


describe('new-product release boundary', () => {
  it.each([
    {},
    { VIBE_API_BASE: 'https://api.argoland.ai', VIBE_WEB_BASE: 'https://argoland.ai' },
    { VIBE_API_BASE: 'ftp://bad.example', VIBE_WEB_BASE: 'ftp://bad.example' },
    { VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '0', VIBE_LIVE_HOST_WRITES: '0' },
    { VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '1', VIBE_LIVE_HOST_WRITES: '1' },
  ])('refuses direct store construction with residual inputs %j', async (residue) => {
    setEnv({ ...residue, VIBE_DIST: 'store' });
    await expect(loadConfig()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
});

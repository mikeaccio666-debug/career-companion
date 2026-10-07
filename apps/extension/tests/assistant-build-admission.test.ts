import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_EXTENSION_PUBLIC_KEY } from '../lib/developmentIdentity';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const environment = (extra: Record<string, string | undefined> = {}) => {
  for (const [k, v] of Object.entries({ VIBE_ASSISTANT_READ_ENABLED: '1', VIBE_EXTENSION_PUBLIC_KEY: DEVELOPMENT_EXTENSION_PUBLIC_KEY,
    VIBE_API_BASE: 'https://api.example.test', VIBE_WEB_BASE: 'https://portal.example.test', ...extra })) vi.stubEnv(k, v);
  vi.resetModules();
};
describe('assistant read build admission', () => {
  it('requires explicit identities and origins instead of dev/production defaults', async () => {
    for (const extra of [{ VIBE_EXTENSION_PUBLIC_KEY: undefined }, { VIBE_API_BASE: undefined }, { VIBE_WEB_BASE: undefined },
      // 最后两个是生产 origin 本身：Assistant 读构建必须显式指向一个**非生产**
      // 的彩排环境，"覆盖成生产"要和没覆盖一样被拒。
      { VIBE_API_BASE: 'https://api.career-companion.invalid' }, { VIBE_WEB_BASE: 'https://career-companion.invalid' }]) {
      environment(extra); await expect(import('../wxt.config')).rejects.toThrow('ASSISTANT_READ_BUILD_REALM_INVALID');
    }
  });
  it('refuses store release even with an assistant flag', async () => {
    environment({ VIBE_DIST: 'store', VIBE_EXTENSION_PUBLIC_KEY: undefined, VIBE_API_BASE: undefined, VIBE_WEB_BASE: undefined });
    await expect(import('../wxt.config')).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
  it('does not combine Assistant with host writes or discovery pilot', async () => {
    for (const key of ['VIBE_LIVE_HOST_WRITES', 'VIBE_CONTROLLED_MOCK_WRITES', 'VIBE_PILOT_UA1_DISCOVERY_ENABLED']) {
      vi.unstubAllEnvs(); environment({ [key]: '1' });
      await expect(import('../wxt.config')).rejects.toThrow();
    }
  });
});


it('packages the inert executor and admits explicit signed runtime reads without enabling writes', async () => {
  environment({ VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED: '1' });
  const config = (await import('../wxt.config')).default;
  expect(config.filterEntrypoints).toContain('apply');
  const vite = config.vite as (environment: {command:string}) => {define:Record<string,string>};
  expect(vite({command:'build'}).define).toMatchObject({ __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__: 'true', __VIBE_LIVE_HOST_WRITES__: 'false' });
});

describe('assistant profile editing build admission', () => {
  it('requires explicit assistant read admission and rejects invalid flags', async () => {
    environment({ VIBE_ASSISTANT_READ_ENABLED: '0', VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: '1' });
    await expect(import('../wxt.config')).rejects.toThrow('ASSISTANT_PROFILE_BUILD_REALM_INVALID');
    environment({ VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: 'yes' });
    await expect(import('../wxt.config')).rejects.toThrow('ASSISTANT_PROFILE_FLAG_INVALID');
  });
  it('includes editing and roles by default in the combined Assistant artifact', async () => {
    environment({VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED:undefined});
    const config = (await import('../wxt.config')).default;
    expect(config.outDir).toBe('.output-assistant');
    expect((config.vite as any)({command:'build'}).define).toMatchObject({__VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__:'false',__VIBE_LIVE_HOST_WRITES__:'false'});
    expect(config.manifest).toMatchObject({ name: 'Career Companion Staging Preview', version: '0.0.5' });
    environment({ VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: '1', VIBE_DIST: 'store' });
    await expect(import('../wxt.config')).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
  it('rejects contradictory diagnostic overrides and keeps store isolated', async () => {
    environment({ VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED: '1', VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: '0' });
    await expect(import('../wxt.config')).rejects.toThrow('ASSISTANT_ROLE_BUILD_REALM_INVALID');
    environment({ VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED: '1', VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: '1' });
    const enabled = (await import('../wxt.config')).default;
    expect(enabled.outDir).toBe('.output-assistant'); expect(enabled.manifest).toMatchObject({ version: '0.0.5' });
    environment({ VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED: '1', VIBE_ASSISTANT_PROFILE_EDIT_ENABLED: '1', VIBE_DIST: 'store' });
    await expect(import('../wxt.config')).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });

  it('explicitly disables Role and intake ports while retaining profile editing', async () => {
    environment({ VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED: '0' });
    const config = (await import('../wxt.config')).default;
    const vite = config.vite as (environment: {command:string}) => {define:Record<string,string>};
    expect(vite({command:'build'}).define).toMatchObject({
      __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__: 'false',
      __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__: 'true',
    });
  });
});

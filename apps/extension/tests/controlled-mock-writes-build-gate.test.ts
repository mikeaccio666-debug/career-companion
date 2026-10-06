import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'VIBE_DIST',
  'VIBE_API_BASE',
  'VIBE_WEB_BASE',
  'VIBE_CONTROLLED_MOCK_WRITES',
  'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

async function controlledMockWritesDefine(): Promise<boolean> {
  vi.resetModules();
  const config = (await import('../wxt.config')).default as {
    vite?: () => { define?: Record<string, string> };
  };
  const raw = config.vite?.().define?.__VIBE_CONTROLLED_MOCK_WRITES__;
  expect(raw).toBeTypeOf('string');
  return JSON.parse(raw!);
}

describe('controlled Mock host-write build gate', () => {
  it('is false in every ordinary build', async () => {
    expect(await controlledMockWritesDefine()).toBe(false);
  });

  it('rejects an opt-in outside the exact fixed local rehearsal', async () => {
    process.env.VIBE_CONTROLLED_MOCK_WRITES = '1';
    process.env.VIBE_API_BASE = 'https://staging.edaix.io';
    process.env.VIBE_WEB_BASE = 'https://staging.edaix.io';
    await expect(import('../wxt.config')).rejects.toThrow(
      '只允许固定 localhost:3000 / localhost:3100 彩排环境',
    );
  });

  it('is true only for the exact fixed local rehearsal', async () => {
    process.env.VIBE_CONTROLLED_MOCK_WRITES = '1';
    process.env.VIBE_API_BASE = 'http://localhost:3000';
    process.env.VIBE_WEB_BASE = 'http://localhost:3100';
    expect(await controlledMockWritesDefine()).toBe(true);
  });

  it('refuses store builds even when a stale opt-in is present', async () => {
    process.env.VIBE_DIST = 'store';
    process.env.VIBE_CONTROLLED_MOCK_WRITES = '1';
    process.env.VIBE_API_BASE = 'http://localhost:3000';
    process.env.VIBE_WEB_BASE = 'http://localhost:3100';
    await expect(controlledMockWritesDefine()).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });
});

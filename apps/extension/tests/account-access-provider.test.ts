import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountAccessProvider, type AccountAccessDiagnostic } from '../lib/accountAccessProvider';
import type { DockAccountAccessPayload } from '../lib/accountAccessIntent';
import { createAccountVault, type AccountVaultArea, type AccountVaultKeyStore } from '../lib/accountVault';

/**
 * worker 侧的招聘网站账号（2026-09-28）。锁的是：
 *  · 两把钥匙（运行时包的 account-access、点名这一类的那一版同意）缺一把就不交出密码，保险箱一个字不动；
 *  · 共用密码第一次交出时才生成、之后一直是那一条；某一家自己的密码优先；
 *  · 换了一个 ArgoLand 用户，旧的一份整个作废；没登录一律拒；
 *  · **不出这台电脑**：这里一次网络都不发，诊断只有稳定码，里面没有邮箱、密码。
 */

const SITE = 'https://tenant.wd5.myworkdayjobs.com';
const PROFILE_EMAIL = 'candidate@example.test';
const GENERATED = 'Generated-Pass-42';

function memoryArea(): AccountVaultArea {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, structuredClone(value)); },
    remove: async (key) => { data.delete(key); },
  };
}

function memoryKeys(): AccountVaultKeyStore {
  let key: CryptoKey | null = null;
  return { load: async () => key, save: async (next) => { key = next; }, remove: async () => { key = null; } };
}

function setup(options: Partial<{ consent: boolean; capability: boolean; email: string | null; user: string | null }> = {}) {
  const vault = createAccountVault({ area: memoryArea(), keys: memoryKeys() });
  const diagnostics: AccountAccessDiagnostic[] = [];
  const state = { user: options.user === undefined ? 'user-1' : options.user, consent: options.consent ?? true, capability: options.capability ?? true };
  const generate = vi.fn(() => GENERATED);
  const provider = createAccountAccessProvider({
    vault,
    getUserId: async () => state.user,
    consent: async () => state.consent,
    capability: async () => state.capability,
    profileEmail: async () => (options.email === undefined ? PROFILE_EMAIL : options.email),
    generate,
    now: () => 1_000,
    onDiagnostic: (code) => diagnostics.push(code),
  });
  const ask = (payload: DockAccountAccessPayload, site = SITE) => provider.handle(payload, site);
  return { vault, diagnostics, state, generate, ask };
}

let fetchSpy: ReturnType<typeof vi.fn>;
afterEach(() => {
  vi.unstubAllGlobals();
});
function forbidNetwork(): void {
  fetchSpy = vi.fn(() => { throw new Error('network is not allowed here'); });
  vi.stubGlobal('fetch', fetchSpy);
}

describe('两把钥匙', () => {
  it('运行时包里 account-access 关着：DISABLED，不生成、不写保险箱', async () => {
    const { ask, vault, generate } = setup({ capability: false });
    expect(await ask({ step: 'CREDENTIAL' })).toEqual({ kind: 'REFUSED', code: 'DISABLED' });
    expect(generate).not.toHaveBeenCalled();
    expect((await vault.read()).password).toBeNull();
  });

  it('没同意点名这一类的那一版：CONSENT_REQUIRED，不生成、不写保险箱', async () => {
    const { ask, vault, generate } = setup({ consent: false });
    expect(await ask({ step: 'CREDENTIAL' })).toEqual({ kind: 'REFUSED', code: 'CONSENT_REQUIRED' });
    expect(generate).not.toHaveBeenCalled();
    expect((await vault.read()).password).toBeNull();
  });

  it('两把都在：交出资料里的邮箱与第一次生成的那一条密码；第二次还是那一条，不再生成', async () => {
    const { ask, generate } = setup();
    expect(await ask({ step: 'CREDENTIAL' })).toEqual({
      kind: 'ACCOUNT_CREDENTIAL', email: PROFILE_EMAIL, password: GENERATED, source: 'SHARED', generated: true, known: false,
    });
    expect(await ask({ step: 'CREDENTIAL' })).toMatchObject({ password: GENERATED, generated: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('STATUS 只说两把钥匙在不在、这一家有没有他的账号，不带任何秘密', async () => {
    const { ask, state } = setup();
    expect(await ask({ step: 'STATUS' })).toEqual({ kind: 'ACCOUNT_STATUS', consent: true, enabled: true, known: false });
    await ask({ step: 'RECORD', outcome: 'CREATED' });
    state.consent = false;
    expect(await ask({ step: 'STATUS' })).toEqual({ kind: 'ACCOUNT_STATUS', consent: false, enabled: true, known: true });
  });
});

describe('邮箱与密码从哪来', () => {
  it('没有注册邮箱（资料里没有、也没改过）：NO_EMAIL', async () => {
    const { ask } = setup({ email: null });
    expect(await ask({ step: 'CREDENTIAL' })).toEqual({ kind: 'REFUSED', code: 'NO_EMAIL' });
  });

  it('改过的注册邮箱优先；改回 null 就用资料里的', async () => {
    const { ask } = setup();
    expect(await ask({ step: 'SETTINGS_SET_EMAIL', email: 'jobs@example.test' })).toMatchObject({ kind: 'ACCOUNT_SETTINGS', email: 'jobs@example.test' });
    expect(await ask({ step: 'CREDENTIAL' })).toMatchObject({ email: 'jobs@example.test' });
    await ask({ step: 'SETTINGS_SET_EMAIL', email: null });
    expect(await ask({ step: 'CREDENTIAL' })).toMatchObject({ email: PROFILE_EMAIL });
  });

  it('这一家自己的密码优先（他在浮层里输过一次）；别的网站照旧用共用的', async () => {
    const { ask } = setup();
    await ask({ step: 'CREDENTIAL' });
    expect(await ask({ step: 'SITE_PASSWORD', password: 'Their-Own-9' })).toEqual({ kind: 'ACCOUNT_SAVED' });
    expect(await ask({ step: 'CREDENTIAL' })).toMatchObject({ password: 'Their-Own-9', source: 'SITE', known: true });
    expect(await ask({ step: 'CREDENTIAL' }, 'https://other.wd1.myworkdayjobs.com')).toMatchObject({ password: GENERATED, source: 'SHARED', known: false });
  });

  it('改共用密码：不合要求 WEAK_PASSWORD；合要求就换上，REVEAL 交回新的', async () => {
    const { ask } = setup();
    expect(await ask({ step: 'SETTINGS_SET_PASSWORD', password: 'short' })).toEqual({ kind: 'REFUSED', code: 'WEAK_PASSWORD' });
    expect(await ask({ step: 'SETTINGS_SET_PASSWORD', password: 'Brand-New-Pass-7' })).toMatchObject({ kind: 'ACCOUNT_SETTINGS', hasPassword: true });
    expect(await ask({ step: 'REVEAL' })).toEqual({ kind: 'ACCOUNT_PASSWORD', password: 'Brand-New-Pass-7' });
  });

  it('SETTINGS_GET 不带密码，只说有没有、几家用了自己的', async () => {
    const { ask } = setup();
    await ask({ step: 'CREDENTIAL' });
    await ask({ step: 'SITE_PASSWORD', password: 'Their-Own-9' });
    const settings = await ask({ step: 'SETTINGS_GET' });
    expect(settings).toEqual({ kind: 'ACCOUNT_SETTINGS', email: null, defaultEmail: PROFILE_EMAIL, hasPassword: true, sites: 1 });
    expect(JSON.stringify(settings)).not.toContain(GENERATED);
    expect(JSON.stringify(settings)).not.toContain('Their-Own-9');
  });
});

describe('属于谁', () => {
  it('没登录 ArgoLand：一律 UNAVAILABLE', async () => {
    const { ask } = setup({ user: null });
    for (const payload of [{ step: 'STATUS' }, { step: 'CREDENTIAL' }, { step: 'REVEAL' }, { step: 'SETTINGS_GET' }] as const) {
      expect(await ask(payload)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    }
  });

  it('换了一个 ArgoLand 用户：上一个人的那一份整个作废，他拿不到那条密码', async () => {
    const { ask, state, generate, diagnostics } = setup();
    await ask({ step: 'CREDENTIAL' });
    await ask({ step: 'SITE_PASSWORD', password: 'Their-Own-9' });
    state.user = 'user-2';
    generate.mockReturnValueOnce('Second-User-Pass-8');
    expect(await ask({ step: 'REVEAL' })).toEqual({ kind: 'ACCOUNT_PASSWORD', password: null });
    expect(await ask({ step: 'CREDENTIAL' })).toMatchObject({ password: 'Second-User-Pass-8', source: 'SHARED', known: false });
    expect(diagnostics).toContain('ACCOUNT_ACCESS_OWNER_CHANGED');
  });
});

describe('不出这台电脑', () => {
  it('整套流程一次网络都不发；诊断全是稳定码，没有邮箱、密码、网站', async () => {
    forbidNetwork();
    const { ask, diagnostics } = setup();
    await ask({ step: 'STATUS' });
    await ask({ step: 'CREDENTIAL' });
    await ask({ step: 'RECORD', outcome: 'CREATED' });
    await ask({ step: 'SITE_PASSWORD', password: 'Their-Own-9' });
    await ask({ step: 'SETTINGS_SET_EMAIL', email: 'jobs@example.test' });
    await ask({ step: 'SETTINGS_SET_PASSWORD', password: 'Brand-New-Pass-7' });
    await ask({ step: 'REVEAL' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const code of diagnostics) {
      expect(code).toMatch(/^ACCOUNT_ACCESS_[A-Z_]+$/u);
      for (const secret of [PROFILE_EMAIL, GENERATED, 'Their-Own-9', 'Brand-New-Pass-7', 'jobs@example.test', 'myworkdayjobs']) {
        expect(code).not.toContain(secret);
      }
    }
  });
});

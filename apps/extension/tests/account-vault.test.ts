import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_VAULT_STORAGE_KEY,
  EMPTY_ACCOUNT_VAULT,
  createAccountVault,
  type AccountVaultArea,
  type AccountVaultDiagnostic,
  type AccountVaultKeyStore,
} from '../lib/accountVault';

/**
 * 招聘网站账号的本机保险箱（2026-09-28）。锁的是：storage.local 里只有密文（邮箱、密码一个字都读不出来）；密钥不可导出；
 * 读—改—写排队；读不出就当空的、删掉那份读不出的密文；退出（clear）时密文与密钥一起删；诊断只有稳定码。
 */

const EMAIL = 'candidate@example.test';
const PASSWORD = 'Tr1ck-y!Horse#42';
const SITE_PASSWORD = 'Other$ite-Pass9';

function memoryArea(): AccountVaultArea & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, structuredClone(value)); },
    remove: async (key) => { data.delete(key); },
  };
}

function memoryKeys(): AccountVaultKeyStore & { key: CryptoKey | null } {
  const store = {
    key: null as CryptoKey | null,
    load: async () => store.key,
    save: async (key: CryptoKey) => { store.key = key; },
    remove: async () => { store.key = null; },
  };
  return store;
}

function setup() {
  const area = memoryArea();
  const keys = memoryKeys();
  const diagnostics: AccountVaultDiagnostic[] = [];
  const vault = createAccountVault({ area, keys, onDiagnostic: (code) => diagnostics.push(code) });
  return { area, keys, diagnostics, vault };
}

const storedText = (area: ReturnType<typeof memoryArea>): string => JSON.stringify(area.data.get(ACCOUNT_VAULT_STORAGE_KEY));

describe('怎么存', () => {
  it('写进去再读出来是同一份；storage.local 里只有密文，邮箱、密码、网站都读不出来', async () => {
    const { area, vault } = setup();
    await vault.update((record) => ({
      ...record,
      owner: 'user-1',
      email: EMAIL,
      password: PASSWORD,
      sites: { 'https://tenant.wd5.myworkdayjobs.com': { password: SITE_PASSWORD, known: true, at: 1 } },
    }));
    const text = storedText(area);
    for (const secret of [EMAIL, PASSWORD, SITE_PASSWORD, 'myworkdayjobs', 'user-1']) expect(text).not.toContain(secret);
    expect(Object.keys(area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as object).sort()).toEqual(['data', 'iv', 'v']);
    const back = await vault.read();
    expect(back).toEqual({
      v: 1,
      owner: 'user-1',
      email: EMAIL,
      password: PASSWORD,
      sites: { 'https://tenant.wd5.myworkdayjobs.com': { password: SITE_PASSWORD, known: true, at: 1 } },
    });
  });

  it('密钥是 AES-GCM、不可导出；每次写都换一个 IV', async () => {
    const { area, keys, vault } = setup();
    await vault.update((record) => ({ ...record, password: PASSWORD }));
    const first = (area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as { iv: string }).iv;
    await vault.update((record) => ({ ...record, password: PASSWORD }));
    const second = (area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as { iv: string }).iv;
    expect(first).not.toBe(second);
    expect(keys.key).not.toBeNull();
    expect(keys.key!.extractable).toBe(false);
    expect(keys.key!.algorithm.name).toBe('AES-GCM');
    await expect(globalThis.crypto.subtle.exportKey('raw', keys.key!)).rejects.toBeDefined();
  });

  it('并发的两次改排成一队，谁都不丢', async () => {
    const { vault } = setup();
    await Promise.all([
      vault.update((record) => ({ ...record, email: EMAIL })),
      vault.update((record) => ({ ...record, password: PASSWORD })),
    ]);
    expect(await vault.read()).toMatchObject({ email: EMAIL, password: PASSWORD });
  });
});

describe('读不出', () => {
  it('没有记录：空的那一份，没有诊断', async () => {
    const { vault, diagnostics } = setup();
    expect(await vault.read()).toEqual(EMPTY_ACCOUNT_VAULT);
    expect(diagnostics).toEqual([]);
  });

  it('密文被改过：当空的，删掉那份密文，只记稳定码', async () => {
    const { area, vault, diagnostics } = setup();
    await vault.update((record) => ({ ...record, password: PASSWORD }));
    const stored = area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as { v: 1; iv: string; data: string };
    const tampered = `${stored.data.slice(0, -4)}AAAA`;
    area.data.set(ACCOUNT_VAULT_STORAGE_KEY, { ...stored, data: tampered });
    expect(await vault.read()).toEqual(EMPTY_ACCOUNT_VAULT);
    expect(area.data.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(false);
    expect(diagnostics).toEqual(['ACCOUNT_VAULT_UNREADABLE']);
  });

  it('密钥没了（IndexedDB 被清过）：当空的，删掉再也读不出的密文', async () => {
    const { area, keys, vault, diagnostics } = setup();
    await vault.update((record) => ({ ...record, password: PASSWORD }));
    keys.key = null;
    expect(await vault.read()).toEqual(EMPTY_ACCOUNT_VAULT);
    expect(area.data.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(false);
    expect(diagnostics).toEqual(['ACCOUNT_VAULT_KEY_MISSING']);
  });

  it('换一把密钥（另一台电脑、另一次安装）：读不出', async () => {
    const { area, vault } = setup();
    await vault.update((record) => ({ ...record, password: PASSWORD }));
    const other = createAccountVault({ area, keys: memoryKeys() });
    // 另一把密钥没有：当密钥丢了。
    expect(await other.read()).toEqual(EMPTY_ACCOUNT_VAULT);
  });
});

describe('退出', () => {
  it('clear：密文与密钥一起删掉，再读是空的', async () => {
    const { area, keys, vault } = setup();
    await vault.update((record) => ({ ...record, owner: 'user-1', password: PASSWORD }));
    await vault.clear();
    expect(area.data.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(false);
    expect(keys.key).toBeNull();
    expect(await vault.read()).toEqual(EMPTY_ACCOUNT_VAULT);
  });

  it('删不掉：照实记 ACCOUNT_VAULT_CLEAR_FAILED', async () => {
    const area = memoryArea();
    const diagnostics: AccountVaultDiagnostic[] = [];
    const vault = createAccountVault({
      area: { ...area, remove: async () => { throw new Error('quota'); } },
      keys: memoryKeys(),
      onDiagnostic: (code) => diagnostics.push(code),
    });
    await vault.clear();
    expect(diagnostics).toEqual(['ACCOUNT_VAULT_CLEAR_FAILED']);
  });
});

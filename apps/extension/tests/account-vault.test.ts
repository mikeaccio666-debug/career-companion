import { describe, expect, it } from 'vitest';
import { ACCOUNT_VAULT_STORAGE_KEY, AccountVaultError, EMPTY_ACCOUNT_VAULT, createAccountVault, createIndexedDbVaultKeyStore, type AccountSiteRecord, type AccountVaultArea, type AccountVaultDiagnostic, type AccountVaultKeyStore } from '../lib/accountVault';

// Synthetic storage adapters; encryption itself is real WebCrypto.
const EMAIL = 'candidate@example.test'; const PASSWORD = 'Tr1ck-y!Horse#42'; const SITE = 'https://careers.example.test';
function memoryArea(): AccountVaultArea & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>(); return { data, get: async (key) => data.get(key), set: async (key, value) => { data.set(key, structuredClone(value)); }, remove: async (key) => { data.delete(key); } };
}
function memoryKeys(): AccountVaultKeyStore & { key: CryptoKey | null } {
  const store = { key: null as CryptoKey | null, load: async () => store.key, save: async (key: CryptoKey) => { store.key = key; }, remove: async () => { store.key = null; } }; return store;
}
function setup() {
  const area = memoryArea(); const keys = memoryKeys(); const diagnostics: AccountVaultDiagnostic[] = [];
  const vault = createAccountVault({ area, keys, onDiagnostic: (code) => diagnostics.push(code) }); return { area, keys, diagnostics, vault };
}
const entry = (password = PASSWORD): AccountSiteRecord => ({ email: EMAIL, password, source: 'USER_SAVED', state: 'REGISTERED', revision: 1, at: 1 });
const seed = async (vault: ReturnType<typeof createAccountVault>) => vault.update((record) => ({ ...record, owner: 'user-1', email: EMAIL, sites: { [SITE]: entry() } }));
async function legacy(area: AccountVaultArea, keys: AccountVaultKeyStore, value: unknown): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await keys.save(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('argoland-account-vault-v1') }, key, new TextEncoder().encode(JSON.stringify(value)));
  const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  await area.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 1, iv: encode(iv), data: encode(new Uint8Array(data)) });
}
const ciphertext = (area: ReturnType<typeof memoryArea>): string => JSON.stringify(area.data.get(ACCOUNT_VAULT_STORAGE_KEY));

describe('encrypted v2 and legacy compatibility', () => {
  it('roundtrips frozen records while storage contains no plaintext account data', async () => {
    const { area, vault } = setup(); const written = await seed(vault);
    const stored = ciphertext(area); for (const value of [EMAIL, PASSWORD, SITE, 'user-1']) expect(stored).not.toContain(value);
    expect(Object.keys(area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as object).sort()).toEqual(['data', 'iv', 'v']);
    expect(await vault.read()).toEqual(written); expect(written.revision).toBe(1); expect(written.v).toBe(2);
    expect(Object.isFrozen(written)).toBe(true); expect(Object.isFrozen(written.sites[SITE])).toBe(true);
  });
  it('uses nonexportable AES-GCM keys and fresh IV on each write', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const first = ciphertext(area); await vault.update((record) => record);
    expect(ciphertext(area)).not.toBe(first); expect(keys.key?.extractable).toBe(false); expect(keys.key?.algorithm.name).toBe('AES-GCM');
    await expect(crypto.subtle.exportKey('raw', keys.key!)).rejects.toBeDefined();
  });
  it('serializes concurrent updates without losing either site', async () => {
    const { vault } = setup(); await Promise.all([vault.update((r) => ({ ...r, sites: { ...r.sites, [SITE]: entry() } })), vault.update((r) => ({ ...r, sites: { ...r.sites, 'https://second.example.test': entry('Other$ite-Pass9') } }))]);
    expect(Object.keys((await vault.read()).sites)).toHaveLength(2); expect((await vault.read()).revision).toBe(2);
  });
  it('retains every credential beyond the old 400-site cap and across restart', async () => {
    const { vault, area, keys } = setup(); const sites = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`https://site-${i}.example.test`, { ...entry(), at: i }]));
    await vault.update((r) => ({ ...r, owner: 'user-1', sites }));
    const restarted = createAccountVault({ area, keys }); expect(Object.keys((await restarted.read()).sites)).toHaveLength(405); expect((await restarted.read()).sites['https://site-0.example.test']?.password).toBe(PASSWORD);
  });
  it('legacy shared password binds only known preexisting origins; historical profile email remains unknown', async () => {
    const { vault, area, keys } = setup(); await legacy(area, keys, { v: 1, owner: 'user-1', email: null, password: PASSWORD, sites: { [SITE]: { known: true, at: 1 }, 'https://own.example.test': { password: 'Site$Password9', known: true, at: 2 }, 'https://uncertain.example.test': { at: 3 } } });
    const before = ciphertext(area); const back = await vault.read();
    expect(back.sites[SITE]).toMatchObject({ password: PASSWORD, email: null, source: 'LEGACY_SHARED', state: 'REGISTERED' });
    expect(back.sites['https://own.example.test']).toMatchObject({ password: 'Site$Password9', source: 'LEGACY_SITE' });
    expect(back.sites['https://uncertain.example.test']).toMatchObject({ state: 'PENDING' }); expect(back.sites['https://uncertain.example.test']?.password).toBeUndefined();
    expect(back.sites['https://new.example.test']).toBeUndefined(); expect(back.legacyPassword).toBe(PASSWORD); expect(ciphertext(area)).toBe(before);
    await vault.update((r) => r); expect((area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as { v: number }).v).toBe(2); expect((await vault.read()).sites).toEqual(back.sites);
  });
  it('retains orphan legacy shared material for export without inventing a site', async () => {
    const { vault, area, keys } = setup(); await legacy(area, keys, { v: 1, owner: 'user-1', email: EMAIL, password: PASSWORD, sites: {} });
    expect(await vault.read()).toMatchObject({ legacyPassword: PASSWORD, sites: {}, email: EMAIL });
  });
  it('legacy known account without any password becomes NEEDS_PASSWORD, never a usable credential', async () => {
    const { vault, area, keys } = setup(); await legacy(area, keys, { v: 1, owner: 'user-1', email: null, password: null, sites: { [SITE]: { known: true, at: 1 } } });
    expect((await vault.read()).sites[SITE]).toMatchObject({ state: 'NEEDS_PASSWORD', email: null }); expect((await vault.read()).sites[SITE]?.password).toBeUndefined();
  });
});

describe('failure is preserved, never converted to an empty vault', () => {
  it('distinguishes genuinely empty storage', async () => { const { vault, diagnostics } = setup(); expect(await vault.readState()).toEqual({ kind: 'EMPTY', record: EMPTY_ACCOUNT_VAULT }); expect(diagnostics).toEqual([]); });
  it('tampered ciphertext stays stored and blocks updates', async () => {
    const { area, vault } = setup(); await seed(vault); const stored = area.data.get(ACCOUNT_VAULT_STORAGE_KEY) as { iv: string; data: string };
    area.data.set(ACCOUNT_VAULT_STORAGE_KEY, { ...stored, v: 2, data: `${stored.data.slice(0, -4)}AAAA` }); const before = ciphertext(area);
    expect(await vault.readState()).toEqual({ kind: 'UNREADABLE' }); await expect(vault.read()).rejects.toMatchObject({ code: 'UNREADABLE' });
    await expect(vault.update((r) => r)).rejects.toMatchObject({ code: 'UNREADABLE' }); expect(ciphertext(area)).toBe(before);
  });
  it('missing key stays explicit and ciphertext survives read/update/restart', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area); keys.key = null;
    expect(await vault.readState()).toEqual({ kind: 'KEY_MISSING' }); await expect(vault.update((r) => r)).rejects.toMatchObject({ code: 'KEY_MISSING' });
    expect(await createAccountVault({ area, keys }).readState()).toEqual({ kind: 'KEY_MISSING' }); expect(ciphertext(area)).toBe(before); expect(keys.key).toBeNull();
  });
  it('key-store failure and wrong keys preserve ciphertext as UNREADABLE', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area);
    const broken = createAccountVault({ area, keys: { ...keys, load: async () => { throw new Error('synthetic unavailable'); } } }); expect(await broken.readState()).toEqual({ kind: 'UNREADABLE' });
    keys.key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); expect(await vault.readState()).toEqual({ kind: 'UNREADABLE' }); expect(ciphertext(area)).toBe(before);
  });
  it('key disappearance between read and encrypt cannot create a replacement over readable ciphertext', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area); let loads = 0;
    const other = createAccountVault({ area, keys: { ...keys, load: async () => { loads += 1; return loads === 1 ? keys.key : null; } } });
    await expect(other.update((r) => r)).rejects.toMatchObject({ code: 'KEY_MISSING' }); expect(ciphertext(area)).toBe(before);
  });
  it('invalid decrypted legacy data and invalid v2 writes never destroy the previous record', async () => {
    const { area, keys, vault } = setup(); await legacy(area, keys, { v: 1, owner: 'user-1', email: null, password: PASSWORD, sites: { 'invalid origin': { at: 1, known: true } } }); const before = ciphertext(area);
    expect(await vault.readState()).toEqual({ kind: 'UNREADABLE' }); expect(ciphertext(area)).toBe(before);
    await vault.clear(); await seed(vault); const valid = ciphertext(area);
    await expect(vault.update((r) => ({ ...r, sites: { [SITE]: { ...entry(), at: NaN } } }))).rejects.toMatchObject({ code: 'RECORD_INVALID' }); expect(ciphertext(area)).toBe(valid);
  });
  it('failed storage write retains the prior committed record', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area);
    const broken = createAccountVault({ area: { ...area, set: async () => { throw new Error('synthetic quota'); } }, keys }); await expect(broken.update((r) => ({ ...r, email: 'new@example.test' }))).rejects.toBeDefined(); expect(ciphertext(area)).toBe(before);
  });
  it('auth assertion after async key read prevents commit', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area); let current = true;
    const fenced = createAccountVault({ area, keys: { ...keys, load: async () => { const value = keys.key; current = false; return value; } } });
    await expect(fenced.update((r) => r, () => { if (!current) throw new Error('AUTH_CHANGED'); })).rejects.toThrow('AUTH_CHANGED'); expect(ciphertext(area)).toBe(before);
  });
});

describe('explicit confirmed clear', () => {
  it('successful clear removes both ciphertext and key', async () => { const { area, keys, vault } = setup(); await seed(vault); await vault.clear(); expect(area.data.size).toBe(0); expect(keys.key).toBeNull(); expect(await vault.readState()).toEqual({ kind: 'EMPTY', record: EMPTY_ACCOUNT_VAULT }); });
  it('failed ciphertext deletion retains the key, readable vault and stable failure', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area); const original = keys.key;
    const broken = createAccountVault({ area: { ...area, remove: async () => { throw new Error('synthetic denied'); } }, keys });
    await expect(broken.clear()).rejects.toMatchObject({ code: 'CLEAR_FAILED' }); expect(keys.key).toBe(original); expect(ciphertext(area)).toBe(before); expect((await vault.read()).sites[SITE]?.password).toBe(PASSWORD);
  });
  it('key deletion failure is reported after ciphertext was actually removed', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const original = keys.key;
    const broken = createAccountVault({ area, keys: { ...keys, remove: async () => { throw new Error('synthetic IDB abort'); } } });
    await expect(broken.clear()).rejects.toBeInstanceOf(AccountVaultError); expect(area.data.size).toBe(0); expect(keys.key).toBe(original);
  });
});

// Controlled event-level IDB fixture, not a real-browser durability claim.
function controlledIdb() {
  const req = { result: undefined as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
  const tx = { oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null, abort: () => tx.onabort?.(), objectStore: () => ({ put: () => req, get: () => req, delete: () => req }) };
  let closed = 0;
  const db = { transaction: () => tx, close: () => { closed += 1; } };
  const opened = { result: db, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null };
  const factory = { open: () => opened } as unknown as IDBFactory;
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  return { store: createIndexedDbVaultKeyStore(factory), req, tx, opened, flush, closed: () => closed };
}
describe('key persistence waits for transaction completion', () => {
  it('request success alone does not resolve save; complete commits once', async () => {
    const f = controlledIdb(); const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); let settled = false;
    const saving = f.store.save(key).then(() => { settled = true; }); f.opened.onsuccess?.(); await f.flush(); f.req.onsuccess?.(); await f.flush(); expect(settled).toBe(false); expect(f.closed()).toBe(0);
    f.tx.oncomplete?.(); await saving; expect(settled).toBe(true); expect(f.closed()).toBe(1);
  });
  it('abort after successful request rejects save', async () => {
    const f = controlledIdb(); const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); const saving = f.store.save(key); const outcome = expect(saving).rejects.toThrow('IDB_TRANSACTION_FAILED');
    f.opened.onsuccess?.(); await f.flush(); f.req.onsuccess?.(); f.tx.onabort?.(); await outcome; expect(f.closed()).toBe(1);
  });
  it('load and remove also wait for their transaction, including delete abort', async () => {
    const f = controlledIdb(); const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); const loading = f.store.load(); f.opened.onsuccess?.(); await f.flush(); f.req.result = key; f.req.onsuccess?.(); f.tx.oncomplete?.(); expect(await loading).toBe(key);
    const g = controlledIdb(); const removing = g.store.remove(); const outcome = expect(removing).rejects.toThrow('IDB_TRANSACTION_FAILED'); g.opened.onsuccess?.(); await g.flush(); g.req.onsuccess?.(); g.tx.onabort?.(); await outcome;
  });
});


describe('ciphertext deletion requires verified absence', () => {
  it('resolved no-op remove cannot delete the only usable key', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area), key = keys.key; const broken = createAccountVault({ area: { ...area, remove: async () => undefined }, keys });
    await expect(broken.clear()).rejects.toMatchObject({ code: 'CLEAR_FAILED' }); expect(ciphertext(area)).toBe(before); expect(keys.key).toBe(key); expect((await vault.read()).sites[SITE]?.password).toBe(PASSWORD);
  });
  it('unavailable readback cannot delete the retained key or claim successful cleanup', async () => {
    const { area, keys, vault } = setup(); await seed(vault); const before = ciphertext(area), key = keys.key; const broken = createAccountVault({ area: { ...area, remove: async () => undefined, get: async () => { throw new Error('synthetic readback denied'); } }, keys });
    await expect(broken.clear()).rejects.toMatchObject({ code: 'CLEAR_FAILED' }); expect(ciphertext(area)).toBe(before); expect(keys.key).toBe(key);
  });
});

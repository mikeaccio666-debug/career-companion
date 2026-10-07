import { describe, expect, it, vi } from 'vitest';
import { createAccountAccessProvider, createAccountAccessOperationStore, type AccountAuthContext, type AccountAccessProviderDeps } from '../lib/accountAccessProvider';
import { ACCOUNT_VAULT_STORAGE_KEY, createAccountVault, type AccountVaultArea, type AccountVaultKeyStore } from '../lib/accountVault';
import type { DockAccountAccessReply } from '../lib/accountAccessIntent';
const SITE = 'https://careers.example.test'; const OTHER = 'https://second.example.test'; const EMAIL = 'candidate@example.test';
function setup(options: Readonly<{ generated?: boolean }> = {}) {
  const data = new Map<string, unknown>(); const area: AccountVaultArea = { get: async (key) => data.get(key), set: async (key, value) => { data.set(key, structuredClone(value)); }, remove: async (key) => { data.delete(key); } };
  let key: CryptoKey | null = null;
  const keys: AccountVaultKeyStore = { load: async () => key, save: async (value) => { key = value; }, remove: async () => { key = null; } };
  const vault = createAccountVault({ area, keys }); const ops = createAccountAccessOperationStore();
  let auth: AccountAuthContext | null = { userId: 'user-a', epoch: 1 }; let managed: AccountAuthContext | null | undefined; let email: string | null = EMAIL; let enabled = true; let consent = true; let generated = 0;
  const deps: AccountAccessProviderDeps = { vault, ops, getAuthContext: async () => auth, getManagementContext: async () => managed === undefined ? auth : managed, capability: async () => enabled, consent: async () => consent, profileEmail: async () => email, now: () => 100, ...(options.generated ? {} : { generate: () => `New$Generated24-${++generated}` }) };
  return { vault, area, keys, data, ops, deps, provider: createAccountAccessProvider(deps), setAuth: (value: AccountAuthContext | null) => { auth = value; }, setManaged: (value: AccountAuthContext | null) => { managed = value; }, setEmail: (value: string | null) => { email = value; }, setEnabled: (value: boolean) => { enabled = value; }, setConsent: (value: boolean) => { consent = value; }, generated: () => generated };
}
function credential(reply: DockAccountAccessReply): Extract<DockAccountAccessReply, { kind: 'ACCOUNT_CREDENTIAL' }> { expect(reply.kind).toBe('ACCOUNT_CREDENTIAL'); if (reply.kind !== 'ACCOUNT_CREDENTIAL') throw new Error('fixture credential unavailable'); return reply; }
function prompt(reply: DockAccountAccessReply): Readonly<{ operationId: string; authEpoch: number }> { if (reply.kind === 'ACCOUNT_STATUS' || reply.kind === 'ACCOUNT_PASSWORD_PROMPT') return { operationId: reply.operationId, authEpoch: reply.authEpoch }; if (reply.kind === 'REFUSED' && reply.operationId !== undefined && reply.authEpoch !== undefined) return { operationId: reply.operationId, authEpoch: reply.authEpoch }; throw new Error('fixture context unavailable'); }
async function request(f: ReturnType<typeof setup>, purpose: 'register' | 'login', site = SITE, provider = f.provider, statusProvider = f.provider): Promise<DockAccountAccessReply> { const status = await statusProvider.handle({ step: 'STATUS' }, site); if (status.kind !== 'ACCOUNT_STATUS') return status; return provider.handle({ step: 'CREDENTIAL', purpose, operationId: status.operationId, expectedEpoch: status.authEpoch }, site); }
async function register(f: ReturnType<typeof setup>, site = SITE) { return credential(await request(f, 'register', site)); }
async function record(f: ReturnType<typeof setup>, c: ReturnType<typeof credential>, outcome: 'CREATED' | 'SIGNED_IN' | 'EXISTS' | 'VERIFICATION_REQUIRED', site = SITE) { return f.provider.handle({ step: 'RECORD', outcome, operationId: c.operationId, expectedEpoch: c.authEpoch }, site); }
const stored = (f: ReturnType<typeof setup>): string => JSON.stringify(f.data.get(ACCOUNT_VAULT_STORAGE_KEY));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function encryptedLegacy(f: ReturnType<typeof setup>, value: unknown): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await f.keys.save(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('argoland-account-vault-v1') }, key, new TextEncoder().encode(JSON.stringify(value)));
  const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  await f.area.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 1, iv: encode(iv), data: encode(new Uint8Array(data)) });
}

describe('per-origin reservation and actual observed outcomes', () => {
  it('reserves distinct new-site passwords before release and reuses a pending retry without implying account existence', async () => {
    const f = setup(); const first = await register(f); const second = await register(f, OTHER); const retry = await register(f);
    expect(first.password).not.toBe(second.password); expect(retry.password).toBe(first.password); expect(first.source).toBe('GENERATED'); expect(first.generated).toBe(true); expect(retry.generated).toBe(false); expect(first.known).toBe(false);
    expect(f.generated()).toBe(2); expect((await f.vault.read()).sites[SITE]).toMatchObject({ email: EMAIL, password: first.password, state: 'PENDING' });
    expect((await f.provider.handle({ step: 'STATUS' }, SITE))).toMatchObject({ kind: 'ACCOUNT_STATUS', known: false }); expect(stored(f)).not.toContain(first.password);
  });
  it('production generator produces two real independent reservations', async () => { const f = setup({ generated: true }); const a = await register(f); const b = await register(f, OTHER); expect(a.password).toHaveLength(16); expect(a.password).not.toBe(b.password); });
  it('concurrent same-site requests reserve once, across provider instances sharing the worker store', async () => {
    const f = setup(); const second = createAccountAccessProvider(f.deps); const aContext = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)), bContext = prompt(await f.provider.handle({ step: 'STATUS' }, SITE));
    const replies = await Promise.all([f.provider.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: aContext.operationId, expectedEpoch: 1 }, SITE), second.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: bContext.operationId, expectedEpoch: 1 }, SITE)]);
    expect(replies.filter((r) => r.kind === 'ACCOUNT_CREDENTIAL')).toHaveLength(1); expect(replies.filter((r) => r.kind === 'REFUSED')).toEqual([{ kind: 'REFUSED', code: 'OPERATION_STALE' }]); const a = credential(replies.find((r) => r.kind === 'ACCOUNT_CREDENTIAL')!); const b = credential(await request(f, 'register', SITE, second)); expect(a.password).toBe(b.password); expect(f.generated()).toBe(1);
    expect(await second.handle({ step: 'RECORD', outcome: 'CREATED', operationId: a.operationId, expectedEpoch: a.authEpoch }, SITE)).toEqual({ kind: 'ACCOUNT_SAVED' });
  });
  it('successful creation records the exact email and permits later login without generation', async () => {
    const f = setup(); const first = await register(f); expect(await record(f, first, 'CREATED')).toEqual({ kind: 'ACCOUNT_SAVED' }); f.setEmail('different@example.test');
    const login = credential(await request(f, 'login', SITE)); expect(login.email).toBe(EMAIL); expect(login.password).toBe(first.password); expect(login.known).toBe(true); expect(f.generated()).toBe(1);
    expect(await record(f, login, 'SIGNED_IN')).toEqual({ kind: 'ACCOUNT_SAVED' });
  });
  it('pending registration refuses login and supplies a fresh manual-password context', async () => {
    const f = setup(); await register(f); const before = stored(f); const reply = await request(f, 'login', SITE);
    expect(reply).toMatchObject({ kind: 'REFUSED', code: 'NO_PASSWORD', authEpoch: 1 }); expect(prompt(reply).operationId).toBeTruthy(); expect(stored(f)).toBe(before); expect(f.generated()).toBe(1);
  });
  it('EXISTS does not promote generated password; manual fresh password recovers the real account', async () => {
    const f = setup(); const first = await register(f); expect(await record(f, first, 'EXISTS')).toMatchObject({ kind: 'ACCOUNT_PASSWORD_PROMPT', authEpoch: 1, email: EMAIL });
    expect((await f.vault.read()).sites[SITE]).toMatchObject({ state: 'NEEDS_PASSWORD', password: first.password });
    const login = await request(f, 'login', SITE); const p = prompt(login); expect(login).toMatchObject({ kind: 'REFUSED', code: 'NO_PASSWORD' });
    expect(await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Existing$RealPassword9', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toMatchObject({ kind: 'ACCOUNT_STATUS', enabled: true, consent: true, known: true, authEpoch: 1 });
    expect(credential(await request(f, 'login', SITE))).toMatchObject({ password: 'Existing$RealPassword9', source: 'USER_SAVED', known: true });
  });
  it('email verification remains pending across restart; a fresh actual manual credential is required for login', async () => {
    const f = setup(); const c = await register(f); await record(f, c, 'VERIFICATION_REQUIRED'); const restarted = createAccountAccessProvider({ ...f.deps, vault: createAccountVault({ area: f.area, keys: f.keys }), ops: createAccountAccessOperationStore() });
    expect((await f.vault.read()).sites[SITE]?.state).toBe('PENDING'); expect(await request(f, 'login', SITE, restarted, restarted)).toMatchObject({ kind: 'REFUSED', code: 'NO_PASSWORD' });
  });
  it('missing login credential never generates, while a status context permits a deliberate user-saved password', async () => {
    const f = setup(); const noPassword = await request(f, 'login', SITE); expect(noPassword).toMatchObject({ kind: 'REFUSED', code: 'NO_PASSWORD' }); expect(f.generated()).toBe(0);
    const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); expect(await f.provider.handle({ step: 'SITE_PASSWORD', password: 'User$Saved9', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE)).toMatchObject({ kind: 'ACCOUNT_STATUS', enabled: true, consent: true, known: true, authEpoch: 1 });
    expect((await f.vault.read()).sites[SITE]).toMatchObject({ email: EMAIL, source: 'USER_SAVED', state: 'REGISTERED' });
  });
  it('missing email refuses without creating a vault', async () => { const f = setup(); f.setEmail(null); expect(await request(f, 'register', SITE)).toEqual({ kind: 'REFUSED', code: 'NO_EMAIL' }); expect(f.data.size).toBe(0); });
});

describe('auth, rule/consent and operation fences', () => {
  it('requires current actual auth and both existing gates, without generating or disclosing a credential', async () => {
    const f = setup(); f.setEnabled(false); expect(await request(f, 'register', SITE)).toEqual({ kind: 'REFUSED', code: 'DISABLED' }); f.setEnabled(true); f.setConsent(false);
    expect(await request(f, 'register', SITE)).toEqual({ kind: 'REFUSED', code: 'CONSENT_REQUIRED' }); f.setAuth(null); expect(await f.provider.handle({ step: 'STATUS' }, SITE)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' }); expect(f.generated()).toBe(0);
  });
  it('untrusted origins and unavailable gate reads fail closed', async () => {
    const f = setup(); const broken = createAccountAccessProvider({ ...f.deps, capability: async () => { throw new Error('synthetic unavailable'); } }); expect(await request(f, 'register', SITE, broken)).toEqual({ kind: 'REFUSED', code: 'DISABLED' });
    expect(await f.provider.handle({ step: 'STATUS' }, 'http://unsafe.example.test')).toEqual({ kind: 'REFUSED', code: 'DISABLED' });
  });
  it('owner mismatch does not clear, overwrite or expose the original vault', async () => {
    const f = setup(); await register(f); const before = stored(f); f.setAuth({ userId: 'user-b', epoch: 2 });
    expect(await f.provider.handle({ step: 'STATUS' }, SITE)).toEqual({ kind: 'REFUSED', code: 'OWNER_CHANGED' }); expect(await request(f, 'register', OTHER)).toEqual({ kind: 'REFUSED', code: 'OWNER_CHANGED' }); expect(await f.provider.manage({ step: 'LIST' })).toEqual({ kind: 'REFUSED', code: 'OWNER_CHANGED' }); expect(stored(f)).toBe(before);
  });
  it('unowned retained legacy material cannot be silently claimed', async () => { const f = setup(); await f.vault.update((r) => ({ ...r, legacyPassword: 'Orphan$Legacy9' })); const before = stored(f); expect(await f.provider.handle({ step: 'STATUS' }, SITE)).toEqual({ kind: 'REFUSED', code: 'OWNER_CHANGED' }); expect(stored(f)).toBe(before); });
  it('auth change during capability await rejects the attempt before any write', async () => {
    const f = setup(); const wait = deferred<boolean>(); const provider = createAccountAccessProvider({ ...f.deps, capability: () => wait.promise }); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const response = provider.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE); await Promise.resolve(); f.setAuth({ userId: 'user-b', epoch: 2 }); wait.resolve(true);
    expect(await response).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(f.data.size).toBe(0); expect(f.generated()).toBe(0);
  });
  it('auth invalidation during profile await rejects same-owner stale epoch too', async () => {
    const f = setup(); const wait = deferred<string | null>(); const provider = createAccountAccessProvider({ ...f.deps, profileEmail: () => wait.promise }); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const response = provider.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE); for (let i = 0; i < 12; i += 1) await Promise.resolve(); f.setAuth({ userId: 'user-a', epoch: 2 }); wait.resolve(EMAIL);
    expect(await response).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(f.data.size).toBe(0);
  });
  it('late observed outcome cannot cross owner or epoch and preserves the original pending entry', async () => {
    const f = setup(); const c = await register(f); const before = stored(f); f.setAuth({ userId: 'user-b', epoch: 1 }); expect(await record(f, c, 'CREATED')).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    f.setAuth({ userId: 'user-a', epoch: 2 }); expect(await record(f, c, 'CREATED')).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(stored(f)).toBe(before);
  });
  it('stale prompt from A cannot write a password into B even if the client supplies B epoch', async () => {
    const f = setup(); const p = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); f.setAuth({ userId: 'user-b', epoch: 2 }); expect(await f.provider.handle({ step: 'SITE_PASSWORD', password: 'User$Saved9', operationId: p.operationId, expectedEpoch: 2 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(f.data.size).toBe(0);
  });
  it('operation binds the exact origin, purpose, and site revision and is consumed after success', async () => {
    const f = setup(); const c = await register(f); expect(await record(f, c, 'CREATED', OTHER)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(await record(f, c, 'SIGNED_IN')).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    const old = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); expect(await record(f, c, 'CREATED')).toEqual({ kind: 'ACCOUNT_SAVED' }); const before = stored(f);
    expect(await record(f, c, 'CREATED')).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(await f.provider.handle({ step: 'SITE_PASSWORD', password: 'User$Saved9', operationId: old.operationId, expectedEpoch: old.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(stored(f)).toBe(before);
  });
  it('worker restart invalidates old ids even with the same numeric epoch, while stored credentials survive', async () => {
    const f = setup(); const c = await register(f); const restarted = createAccountAccessProvider({ ...f.deps, ops: createAccountAccessOperationStore() }); const before = stored(f);
    expect(await restarted.handle({ step: 'RECORD', outcome: 'CREATED', operationId: c.operationId, expectedEpoch: c.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(stored(f)).toBe(before); expect(credential(await request(f, 'register', SITE, restarted, restarted)).password).toBe(c.password);
  });
  it('concurrent duplicate outcomes accept only one commit', async () => { const f = setup(); const c = await register(f); const results = await Promise.all([record(f, c, 'CREATED'), record(f, c, 'CREATED')]); expect(results.filter((r) => r.kind === 'ACCOUNT_SAVED')).toHaveLength(1); expect((await f.vault.read()).sites[SITE]?.revision).toBe(2); });
  it('post-storage auth change suppresses secret response; transition serialization remains root responsibility', async () => {
    const f = setup(); const provider = createAccountAccessProvider({ ...f.deps, vault: createAccountVault({ area: { ...f.area, set: async (key, value) => { await f.area.set(key, value); f.setAuth({ userId: 'user-b', epoch: 2 }); } }, keys: f.keys }) });
    expect(await request(f, 'register', SITE, provider)).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' }); expect(f.data.size).toBe(1); // actual completed storage commit is not falsely claimed rolled back
  });
});

describe('extension-only management and recovery state', () => {
  it('redacted page LIST contains no passwords; only management reveals one site or exports exact rows', async () => {
    const f = setup(); const c = await register(f); await record(f, c, 'CREATED'); const page = await f.provider.handle({ step: 'LIST' }, SITE); expect(page.kind).toBe('VAULT_LIST'); expect(JSON.stringify(page)).not.toContain(c.password);
    if (page.kind !== 'VAULT_LIST' || page.revision === null) throw new Error('fixture list unavailable');
    expect(await f.provider.manage({ step: 'REVEAL', origin: SITE, expectedRevision: page.revision, expectedEpoch: page.authEpoch })).toEqual({ kind: 'ACCOUNT_PASSWORD', origin: SITE, password: c.password, revision: page.revision, authEpoch: 1 });
    expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: page.revision, expectedEpoch: 1 })).toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: SITE, email: EMAIL, password: c.password, source: 'GENERATED', state: 'REGISTERED' }], legacyPassword: null });
  });
  it('revision and epoch changes between LIST and secrets fail closed', async () => {
    const f = setup(); await register(f); const list = await f.provider.manage({ step: 'LIST' }); if (list.kind !== 'VAULT_LIST' || list.revision === null) throw new Error('fixture list unavailable'); await register(f, OTHER);
    expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: list.revision, expectedEpoch: 1 })).toEqual({ kind: 'REFUSED', code: 'REVISION_CHANGED' }); f.setAuth({ userId: 'user-a', epoch: 2 }); expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: list.revision, expectedEpoch: 1 })).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' });
  });
  it('root-provided retained-owner management context can export during a fenced handoff but cannot authorize page writes', async () => {
    const f = setup(); await register(f); f.setAuth(null); f.setManaged({ userId: 'user-a', epoch: 3 }); const list = await f.provider.manage({ step: 'LIST' }); expect(list).toMatchObject({ kind: 'VAULT_LIST', authEpoch: 3 }); expect(await request(f, 'register', OTHER)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
  });
  it('key missing is not EMPTY and secrets refuse without destroying ciphertext', async () => {
    const f = setup(); await register(f); const before = stored(f); await f.keys.remove(); expect(await f.provider.manage({ step: 'LIST' })).toMatchObject({ kind: 'VAULT_LIST', status: 'KEY_MISSING', revision: null, sites: [] }); expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: 1, expectedEpoch: 1 })).toEqual({ kind: 'REFUSED', code: 'KEY_MISSING' }); expect(stored(f)).toBe(before);
  });
  it('management secret read rechecks current auth after async storage await', async () => {
    const f = setup(); await register(f); const vault = createAccountVault({ area: { ...f.area, get: async (key) => { const value = await f.area.get(key); f.setAuth({ userId: 'user-a', epoch: 2 }); return value; } }, keys: f.keys }); const provider = createAccountAccessProvider({ ...f.deps, vault });
    expect(await provider.manage({ step: 'REVEAL', origin: SITE, expectedRevision: 1, expectedEpoch: 1 })).toEqual({ kind: 'REFUSED', code: 'AUTH_CHANGED' });
  });
  it('provider never makes a network request or logs account values', async () => {
    const f = setup(); const events: string[] = []; const network = vi.fn(() => { throw new Error('network prohibited'); }); vi.stubGlobal('fetch', network);
    try { const provider = createAccountAccessProvider({ ...f.deps, onDiagnostic: (code) => events.push(code) }); const c = credential(await request(f, 'register', SITE, provider)); expect(network).not.toHaveBeenCalled(); expect(JSON.stringify(events)).not.toContain(EMAIL); expect(JSON.stringify(events)).not.toContain(c.password); } finally { vi.unstubAllGlobals(); }
  });
  it('explicit worker-store invalidation and expiry reject old context ids', async () => {
    let now = 0; const f = setup(); const ops = createAccountAccessOperationStore({ now: () => now }); const provider = createAccountAccessProvider({ ...f.deps, ops }); const p = prompt(await provider.handle({ step: 'STATUS' }, SITE)); now = 600_001;
    expect(await provider.handle({ step: 'SITE_PASSWORD', password: 'User$Saved9', operationId: p.operationId, expectedEpoch: 1 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); const next = prompt(await provider.handle({ step: 'STATUS' }, SITE)); ops.invalidate(); expect(await provider.handle({ step: 'SITE_PASSWORD', password: 'User$Saved9', operationId: next.operationId, expectedEpoch: 1 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
});


describe('opaque current-operation checks before each real host action', () => {
  it('checks a live credential repeatedly without consuming it, then rejects it after recorded outcome', async () => {
    const f = setup(); const c = await register(f); const payload = { step: 'CHECK', operationId: c.operationId, expectedEpoch: c.authEpoch } as const;
    expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' }); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' }); await record(f, c, 'CREATED'); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
  it('restart rejects the old plaintext-run operation even if numeric epoch is unchanged', async () => {
    const f = setup(); const c = await register(f); const restarted = createAccountAccessProvider({ ...f.deps, ops: createAccountAccessOperationStore() }); expect(await restarted.handle({ step: 'CHECK', operationId: c.operationId, expectedEpoch: c.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
  it('owner ABA uses the real epoch rather than matching the final user id', async () => {
    const f = setup(); const c = await register(f); f.setAuth({ userId: 'user-b', epoch: 2 }); f.setAuth({ userId: 'user-a', epoch: 3 }); expect(await f.provider.handle({ step: 'CHECK', operationId: c.operationId, expectedEpoch: 3 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
  it('changed site credential revision and revoked capability/consent reject the next action', async () => {
    const f = setup(); const c = await register(f); const payload = { step: 'CHECK', operationId: c.operationId, expectedEpoch: c.authEpoch } as const; f.setEnabled(false); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'REFUSED', code: 'DISABLED' }); f.setEnabled(true); f.setConsent(false); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'REFUSED', code: 'CONSENT_REQUIRED' }); f.setConsent(true);
    const p = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Replaced$Actual9', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
  it('changed unpersisted profile email invalidates a fresh manual-password context', async () => {
    const f = setup(); const p = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); f.setEmail('new@example.test'); expect(await f.provider.handle({ step: 'CHECK', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
});


describe('legacy material and commit failures', () => {
  it('legacy bound credential works only for its prior site; a new site never receives shared material', async () => {
    const f = setup(); const historicalEmail = 'historical@example.test'; await encryptedLegacy(f, { v: 1, owner: 'user-a', email: historicalEmail, password: 'Old$Shared9', sites: { [SITE]: { known: true, at: 1 } } });
    const list = await f.provider.manage({ step: 'LIST' }); expect(list).toMatchObject({ kind: 'VAULT_LIST', sites: [{ origin: SITE, email: historicalEmail, source: 'LEGACY_SHARED' }] });
    const login = credential(await request(f, 'login', SITE)); expect(login).toMatchObject({ password: 'Old$Shared9', email: historicalEmail, source: 'LEGACY_SHARED' }); expect((await f.vault.read()).sites[SITE]?.email).toBe(historicalEmail);
    const fresh = await register(f, OTHER); expect(fresh.password).not.toBe('Old$Shared9'); expect(fresh.source).toBe('GENERATED'); await record(f, login, 'SIGNED_IN'); expect((await f.vault.read()).sites[SITE]?.email).toBe(historicalEmail);
  });
  it('encrypted v1 known site with unknown email never pairs its old password with a current profile email', async () => {
    const f = setup(); await encryptedLegacy(f, { v: 1, owner: 'user-a', email: null, password: 'Old$Shared9', sites: { [SITE]: { known: true, at: 1 } } });
    const currentProfile = vi.fn(async () => 'new-personal@example.test'); const provider = createAccountAccessProvider({ ...f.deps, profileEmail: currentProfile }); const before = stored(f);
    const status = await provider.handle({ step: 'STATUS' }, SITE); expect(status).toMatchObject({ kind: 'ACCOUNT_STATUS', known: true }); const p = prompt(status);
    expect(await provider.handle({ step: 'CHECK', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' });
    const reply = await provider.handle({ step: 'CREDENTIAL', purpose: 'login', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE); expect(reply).toEqual({ kind: 'REFUSED', code: 'NO_EMAIL' }); expect(JSON.stringify(reply)).not.toContain('Old$Shared9');
    expect(await provider.handle({ step: 'PASSWORD_PROMPT', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    expect(currentProfile).not.toHaveBeenCalled(); expect(f.generated()).toBe(0); expect(stored(f)).toBe(before); expect((await f.vault.read()).sites[SITE]).toMatchObject({ email: null, password: 'Old$Shared9', state: 'REGISTERED' });
    expect(await provider.manage({ step: 'EXPORT', expectedRevision: 0, expectedEpoch: 1 })).toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: SITE, email: null, password: 'Old$Shared9' }] }); expect(stored(f)).toBe(before);
  });
  it('new-origin registration may use the actual current profile without rebuilding an unknown legacy username', async () => {
    const f = setup(); await encryptedLegacy(f, { v: 1, owner: 'user-a', email: null, password: 'Old$Shared9', sites: { [SITE]: { known: true, at: 1 } } }); f.setEmail('new-personal@example.test');
    const fresh = await register(f, OTHER); expect(fresh).toMatchObject({ email: 'new-personal@example.test', source: 'GENERATED', known: false }); expect(fresh.password).not.toBe('Old$Shared9'); expect(f.generated()).toBe(1);
    const saved = await f.vault.read(); expect(saved.sites[OTHER]).toMatchObject({ email: 'new-personal@example.test', password: fresh.password, state: 'PENDING' }); expect(saved.sites[SITE]).toMatchObject({ email: null, password: 'Old$Shared9', state: 'REGISTERED' }); expect(saved.legacyPassword).toBe('Old$Shared9');
    expect(await request(f, 'login', SITE)).toEqual({ kind: 'REFUSED', code: 'NO_EMAIL' });
  });
  it('deliberately saved password with unknown existing username stays exportable but cannot auto-login using vault or profile email', async () => {
    const f = setup(); await f.vault.update((r) => ({ ...r, owner: 'user-a', email: 'current-vault@example.test', sites: { [SITE]: { email: null, password: 'Old$Shared9', source: 'LEGACY_SHARED', state: 'REGISTERED', revision: 0, at: 1 } } }));
    const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const derived = await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Fresh$UserSaved9', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE); expect(derived).toMatchObject({ kind: 'ACCOUNT_STATUS', known: true }); const p = prompt(derived);
    expect(await f.provider.handle({ step: 'CHECK', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' }); expect(await f.provider.handle({ step: 'CREDENTIAL', purpose: 'login', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'NO_EMAIL' });
    const saved = await f.vault.read(); expect(saved.sites[SITE]).toMatchObject({ email: null, password: 'Fresh$UserSaved9', source: 'USER_SAVED', state: 'REGISTERED' }); expect(f.generated()).toBe(0);
    expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: saved.revision, expectedEpoch: 1 })).toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: SITE, email: null, password: 'Fresh$UserSaved9', source: 'USER_SAVED' }] });
  });
  it('orphan legacy password is exported separately, with no invented origin or known-account claim', async () => {
    const f = setup(); await f.vault.update((r) => ({ ...r, owner: 'user-a', legacyPassword: 'Orphan$Old9' })); expect(await f.provider.manage({ step: 'EXPORT', expectedRevision: 1, expectedEpoch: 1 })).toEqual({ kind: 'VAULT_EXPORT', rows: [], legacyPassword: 'Orphan$Old9', revision: 1, authEpoch: 1 });
    expect(await request(f, 'login', SITE)).toMatchObject({ kind: 'REFUSED', code: 'NO_PASSWORD' }); expect(f.generated()).toBe(0);
  });
  it('failed reserve commit never returns a generated credential', async () => {
    const f = setup(); const provider = createAccountAccessProvider({ ...f.deps, vault: createAccountVault({ area: { ...f.area, set: async () => { throw new Error('synthetic quota'); } }, keys: f.keys }) }); expect(await request(f, 'register', SITE, provider)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' }); expect(f.data.size).toBe(0);
  });
  it('failed outcome commit can retry the same operation without inventing a successful saved receipt', async () => {
    const f = setup(); const c = await register(f); const before = stored(f); const broken = createAccountAccessProvider({ ...f.deps, vault: createAccountVault({ area: { ...f.area, set: async () => { throw new Error('synthetic quota'); } }, keys: f.keys }) });
    expect(await broken.handle({ step: 'RECORD', outcome: 'CREATED', operationId: c.operationId, expectedEpoch: c.authEpoch }, SITE)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' }); expect(stored(f)).toBe(before); expect(await record(f, c, 'CREATED')).toEqual({ kind: 'ACCOUNT_SAVED' });
  });
  it('unreadable stored data remains UNREADABLE in management and blocks fresh reservations', async () => {
    const f = setup(); f.data.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 2, iv: 'broken', data: 'broken' }); const before = stored(f); expect(await f.provider.manage({ step: 'LIST' })).toMatchObject({ kind: 'VAULT_LIST', status: 'KEY_MISSING' });
    await f.keys.save(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])); expect(await f.provider.manage({ step: 'LIST' })).toMatchObject({ kind: 'VAULT_LIST', status: 'UNREADABLE' }); expect(await request(f, 'register', SITE)).toEqual({ kind: 'REFUSED', code: 'UNREADABLE' }); expect(stored(f)).toBe(before);
  });
});


describe('password prompt inherits the original operation owner', () => {
  it('derives a fresh manual context from a valid failed-login operation without consuming a new owner status', async () => {
    const f = setup(); const reg = await register(f); await record(f, reg, 'CREATED'); const login = credential(await request(f, 'login', SITE));
    const reply = await f.provider.handle({ step: 'PASSWORD_PROMPT', operationId: login.operationId, expectedEpoch: login.authEpoch }, SITE); expect(reply).toMatchObject({ kind: 'ACCOUNT_PASSWORD_PROMPT', authEpoch: 1, email: EMAIL }); const p = prompt(reply); expect(p.operationId).not.toBe(login.operationId);
    expect(await f.provider.handle({ step: 'CHECK', operationId: login.operationId, expectedEpoch: 1 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(await f.provider.handle({ step: 'CHECK', operationId: p.operationId, expectedEpoch: 1 }, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' });
  });
  it.each(['EXISTS', 'VERIFICATION_REQUIRED'] as const)('%s commits the real state and returns a new same-owner/site prompt bound to its new revision', async (outcome) => {
    const f = setup(); const c = await register(f); const response = await record(f, c, outcome); const p = prompt(response); expect(response).toMatchObject({ kind: 'ACCOUNT_PASSWORD_PROMPT', email: EMAIL, authEpoch: c.authEpoch });
    expect((await f.vault.read()).sites[SITE]?.state).toBe(outcome === 'EXISTS' ? 'NEEDS_PASSWORD' : 'PENDING'); expect(await f.provider.handle({ step: 'CHECK', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toEqual({ kind: 'ACCOUNT_CURRENT' });
    expect(await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Actual$UserSaved9', operationId: p.operationId, expectedEpoch: p.authEpoch }, SITE)).toMatchObject({ kind: 'ACCOUNT_STATUS', enabled: true, consent: true, known: true, authEpoch: 1 });
  });
  it('never derives a B prompt from A plaintext context, even if client supplies B epoch or owner has made an ABA', async () => {
    const f = setup(); const c = await register(f); const before = stored(f); f.setAuth({ userId: 'user-b', epoch: 2 }); expect(await f.provider.handle({ step: 'PASSWORD_PROMPT', operationId: c.operationId, expectedEpoch: 2 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    f.setAuth({ userId: 'user-a', epoch: 3 }); expect(await f.provider.handle({ step: 'PASSWORD_PROMPT', operationId: c.operationId, expectedEpoch: 3 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(stored(f)).toBe(before);
  });
  it('prompt derivation requires current gates, revision and original worker registry', async () => {
    const f = setup(); const c = await register(f); const p = { step: 'PASSWORD_PROMPT', operationId: c.operationId, expectedEpoch: 1 } as const; f.setConsent(false); expect(await f.provider.handle(p, SITE)).toEqual({ kind: 'REFUSED', code: 'CONSENT_REQUIRED' }); f.setConsent(true);
    expect(await createAccountAccessProvider({ ...f.deps, ops: createAccountAccessOperationStore() }).handle(p, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    const context = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Actual$Changed9', operationId: context.operationId, expectedEpoch: 1 }, SITE); expect(await f.provider.handle(p, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
});


describe('credential inherits the displayed status operation', () => {
  it('consumes an old status and returns a separately bound credential; repeated old source is rejected', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const payload = { step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: status.authEpoch } as const;
    const c = credential(await f.provider.handle(payload, SITE)); expect(c.operationId).not.toBe(status.operationId); expect(await f.provider.handle(payload, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
  });
  it('old displayed A status cannot be rebound to B or survive owner ABA by forging the current epoch', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); f.setAuth({ userId: 'user-b', epoch: 2 }); expect(await f.provider.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: 2 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' });
    f.setAuth({ userId: 'user-a', epoch: 3 }); expect(await f.provider.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: 3 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(f.data.size).toBe(0); expect(f.generated()).toBe(0);
  });
  it('worker restart refuses a displayed status even when numeric epoch matches', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const fresh = createAccountAccessProvider({ ...f.deps, ops: createAccountAccessOperationStore() }); expect(await fresh.handle({ step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: 1 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(f.data.size).toBe(0);
  });
  it('same status concurrent credential requests permit only one reservation and secret release', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const payload = { step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: status.authEpoch } as const; const replies = await Promise.all([f.provider.handle(payload, SITE), f.provider.handle(payload, SITE)]); expect(replies.filter((r) => r.kind === 'ACCOUNT_CREDENTIAL')).toHaveLength(1); expect(f.generated()).toBe(1);
  });
  it('saved manual password returns same-owner actual status that can continue login without a fresh owner lookup', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const saved = await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Actual$UserSaved9', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE); expect(saved).toMatchObject({ kind: 'ACCOUNT_STATUS', enabled: true, consent: true, known: true, authEpoch: 1 }); const next = prompt(saved);
    expect(credential(await f.provider.handle({ step: 'CREDENTIAL', purpose: 'login', operationId: next.operationId, expectedEpoch: next.authEpoch }, SITE)).password).toBe('Actual$UserSaved9');
  });
  it('a switched owner cannot continue with a saved-password-derived status', async () => {
    const f = setup(); const status = prompt(await f.provider.handle({ step: 'STATUS' }, SITE)); const saved = await f.provider.handle({ step: 'SITE_PASSWORD', password: 'Actual$UserSaved9', operationId: status.operationId, expectedEpoch: status.authEpoch }, SITE); const next = prompt(saved); const before = stored(f); f.setAuth({ userId: 'user-b', epoch: 2 }); expect(await f.provider.handle({ step: 'CREDENTIAL', purpose: 'login', operationId: next.operationId, expectedEpoch: 2 }, SITE)).toEqual({ kind: 'REFUSED', code: 'OPERATION_STALE' }); expect(stored(f)).toBe(before);
  });
});

import { describe, expect, it } from 'vitest';
import { AUTH_SESSION_ENDPOINTS } from '@edaix/contracts';
import { createAuthClient } from '../lib/authClient';
import { createAccountVault, ACCOUNT_VAULT_STORAGE_KEY } from '../lib/accountVault';
import { createAccountAccessOperationStore, createAccountAccessProvider } from '../lib/accountAccessProvider';
import { createAccountVaultLifecycle } from '../lib/accountVaultLifecycle';
import { MANAGEMENT_TRANSITION_BINDING } from '../lib/accountVaultTransitions';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://careers.example.test';
const NOW = 1_800_000_000;
const handoff = { code: 'fictional-code', state: 's'.repeat(64), extensionId: 'fictional-extension' };
function pair(owner: string) {
  const b64 = (x: unknown) => btoa(JSON.stringify(x)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { accessToken: `${b64({ alg: 'HS256' })}.${b64({ sub: owner, exp: NOW + 900 })}.sig`,
    refreshToken: `fictional-${owner}`, user: { id: owner, email: 'student@example.test', role: 'STUDENT' } };
}
function harness() {
  const values = new Map<string, unknown>(), authValues = new Map<string, unknown>();
  let key: CryptoKey | null = null, nextOwner = A, keyDeletes = 0, invalidations = 0;
  let blockRemove: (() => Promise<void>) | null = null, removeFails = false;
  const area = { get: async (name: string) => values.get(name), set: async (name: string, value: unknown) => { values.set(name, value); },
    remove: async (name: string) => { if (blockRemove) await blockRemove(); if (removeFails) throw new Error('synthetic failure'); values.delete(name); } };
  const vault = createAccountVault({ area, keys: { load: async () => key, save: async (value) => { key = value; }, remove: async () => { keyDeletes++; key = null; } } });
  const ops = createAccountAccessOperationStore();
  let lifecycle!: ReturnType<typeof createAccountVaultLifecycle>;
  const auth = createAuthClient({ apiBase: 'https://offline.test.invalid', now: () => NOW,
    store: { get: async (name) => authValues.get(name), set: async (name, value) => { authValues.set(name, value); }, remove: async (name) => { authValues.delete(name); } },
    beforeReplaceSession: (change) => lifecycle.beforeReplaceSession(change), onSessionInvalidated: () => lifecycle.onAuthInvalidated(),
    fetchFn: (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path === '/auth/extension-handoffs/redeem' || path === '/auth/refresh' ? pair(nextOwner) : { ok: true };
      const status = path === AUTH_SESSION_ENDPOINTS.linkExtensionInstall.path ? 202 : 201;
      return { ok: true, status, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch,
  });
  const shown: string[] = [];
  lifecycle = createAccountVaultLifecycle({ auth: () => auth, vault, area, invalidateOperations: () => ops.invalidate(),
    broadcastInvalidated: () => { invalidations++; }, showSwitch: async (ticket) => { shown.push(ticket); } });
  const provider = createAccountAccessProvider({ vault, ops, getAuthContext: () => lifecycle.readContext(),
    getManagementContext: () => lifecycle.readContext(true), profileEmail: async () => 'student@example.test', capability: async () => true, consent: async () => true });
  const credentialFor = async (purpose: 'register' | 'login') => {
    const status = await provider.handle({ step: 'STATUS' }, ORIGIN);
    if (status.kind !== 'ACCOUNT_STATUS') throw new Error('fixture status');
    return provider.handle({ step: 'CREDENTIAL', purpose, operationId: status.operationId, expectedEpoch: status.authEpoch }, ORIGIN);
  };
  const seed = async () => {
    await auth.redeemHandoff(handoff);
    const credential = await credentialFor('register');
    if (credential.kind !== 'ACCOUNT_CREDENTIAL') throw new Error('fixture credential');
    expect(await provider.handle({ step: 'RECORD', outcome: 'CREATED', operationId: credential.operationId, expectedEpoch: credential.authEpoch }, ORIGIN)).toEqual({ kind: 'ACCOUNT_SAVED' });
  };
  return { auth, vault, provider, lifecycle, values, authValues, shown, seed, credentialFor,
    next: (owner: string) => { nextOwner = owner; }, failRemove: () => { removeFails = true; },
    block: (fn: () => Promise<void>) => { blockRemove = fn; }, keyDeletes: () => keyDeletes, invalidations: () => invalidations };
}
const until = async (test: () => boolean) => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error('fixture timeout'); };

describe('actual auth/vault worker lifecycle', () => {
  it('same verified owner preserves exact ciphertext but invalidates old credential operations', async () => {
    const h = harness(); await h.seed();
    const credential = await h.credentialFor('login');
    if (credential.kind !== 'ACCOUNT_CREDENTIAL') throw new Error('fixture');
    const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
    expect(await h.auth.redeemHandoff(handoff)).toBe(true);
    expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect(h.shown).toEqual([]);
    expect(await h.provider.handle({ step: 'CHECK', operationId: credential.operationId, expectedEpoch: credential.authEpoch }, ORIGIN)).toMatchObject({ kind: 'REFUSED' });
  });
  it('waits for real settings confirmation, permits retained-owner export, and cancel preserves both owners data', async () => {
    const h = harness(); await h.seed(); const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
    h.next(B); const replace = h.auth.redeemHandoff(handoff); await until(() => h.shown.length === 1);
    expect(await h.lifecycle.readContext()).toBeNull();
    const snapshot = await h.provider.manage({ step: 'LIST' });
    if (snapshot.kind !== 'VAULT_LIST' || snapshot.revision === null) throw new Error('fixture');
    expect(await h.provider.manage({ step: 'EXPORT', expectedRevision: snapshot.revision, expectedEpoch: snapshot.authEpoch })).toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: ORIGIN, email: 'student@example.test' }] });
    expect(h.lifecycle.transitions.cancel(h.shown[0]!, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'CANCELED' });
    expect(await replace).toBe(false); expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect((await h.auth.readVaultAuthContext())?.userId).toBe(A); expect(h.keyDeletes()).toBe(0);
  });
  it('clears only after confirmation and then completes verified new-owner persistence', async () => {
    const h = harness(); await h.seed(); h.next(B);
    const replace = h.auth.redeemHandoff(handoff); await until(() => h.shown.length === 1);
    expect(h.values.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(true);
    expect(await h.lifecycle.transitions.confirm(h.shown[0]!, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'TRANSITION_DONE', action: 'SWITCH_ACCOUNT' });
    expect(await replace).toBe(true); expect((await h.auth.readVaultAuthContext())?.userId).toBe(B);
    expect(h.values.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(false); expect(h.keyDeletes()).toBe(1);
  });
  it('failed ciphertext deletion cancels replacement and retains key plus recoverable old ciphertext', async () => {
    const h = harness(); await h.seed(); const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY); h.failRemove(); h.next(B);
    const replace = h.auth.redeemHandoff(handoff); await until(() => h.shown.length === 1);
    expect(await h.lifecycle.transitions.confirm(h.shown[0]!, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'CLEAR_FAILED' });
    expect(await replace).toBe(false); expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect(h.keyDeletes()).toBe(0); expect((await h.vault.read()).owner).toBe(A);
  });
  it('prepares logout without deleting; a real confirmed logout deletes encrypted data and key once', async () => {
    const h = harness(); await h.seed();
    const pending = await h.lifecycle.transitions.prepareLogout(MANAGEMENT_TRANSITION_BINDING);
    if (pending.kind !== 'CONFIRM_REQUIRED') throw new Error('fixture');
    expect(pending.canExport).toBe(true); expect(h.values.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(true);
    expect(await h.lifecycle.transitions.confirm(pending.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'TRANSITION_DONE', action: 'LOGOUT' });
    expect(h.authValues.has('authSession')).toBe(false); expect(h.values.has(ACCOUNT_VAULT_STORAGE_KEY)).toBe(false); expect(h.keyDeletes()).toBe(1);
    expect(await h.lifecycle.transitions.confirm(pending.ticket, MANAGEMENT_TRANSITION_BINDING)).toMatchObject({ kind: 'REFUSED' }); expect(h.keyDeletes()).toBe(1);
  });
  it('logout deletion failure reports failure without pretending retained ciphertext is empty', async () => {
    const h = harness(); await h.seed(); h.failRemove();
    const pending = await h.lifecycle.transitions.prepareLogout(MANAGEMENT_TRANSITION_BINDING);
    if (pending.kind !== 'CONFIRM_REQUIRED') throw new Error('fixture');
    expect(await h.lifecycle.transitions.confirm(pending.ticket, MANAGEMENT_TRANSITION_BINDING)).toEqual({ kind: 'REFUSED', code: 'CLEAR_FAILED' });
    expect(await h.auth.readVaultAuthContext()).toBeNull(); expect((await h.vault.read()).owner).toBe(A); expect(h.keyDeletes()).toBe(0);
  });
  it('a verified new handoff cannot persist while confirmed old-owner cleanup is deferred', async () => {
    const h = harness(); await h.seed(); let release!: () => void, entered = false;
    h.block(() => { entered = true; return new Promise<void>((resolve) => { release = resolve; }); });
    const pending = await h.lifecycle.transitions.prepareLogout(MANAGEMENT_TRANSITION_BINDING);
    if (pending.kind !== 'CONFIRM_REQUIRED') throw new Error('fixture');
    const clear = h.lifecycle.transitions.confirm(pending.ticket, MANAGEMENT_TRANSITION_BINDING); await until(() => entered);
    h.next(B); const replace = h.auth.redeemHandoff(handoff);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.authValues.has('authSession')).toBe(false); expect(await h.lifecycle.readContext(true)).toBeNull();
    release(); expect(await clear).toEqual({ kind: 'TRANSITION_DONE', action: 'LOGOUT' });
    expect(await replace).toBe(true); expect((await h.auth.readVaultAuthContext())?.userId).toBe(B);
    expect(h.keyDeletes()).toBe(1);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AUTH_SESSION_ENDPOINTS, APPLICATION_PROFILE_FIELD_KEYS } from '@edaix/contracts';
import { detectApplyVendor } from '@edaix/apply-kernel/vendors';
import { declaresAccountSteps, installApplyAdapters, isAccountFormPath, isApplyFormPath } from '@edaix/apply-kernel/registry';
import { createBundledApplyPolicy, isApplyPolicyEnabled, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';
import { createAuthClient } from '../lib/authClient';
import { createAccountVault, ACCOUNT_VAULT_STORAGE_KEY, type AccountVault, type AccountVaultKeyStore } from '../lib/accountVault';
import { createAccountVaultLifecycle } from '../lib/accountVaultLifecycle';
import { createAccountVaultMessageRouter } from '../lib/accountVaultMessageRouter';
import { createAccountAccessProvider, createAccountAccessOperationStore } from '../lib/accountAccessProvider';
import { createAccountVaultManagementIntent, createDockAccountAccessIntent, parseDockAccountAccessIntent, parseDockAccountAccessReply } from '../lib/accountAccessIntent';
import type { VaultManagementSender } from '../lib/accountVaultTransitionIntent';
import { senderTabForPageOrFrame, type SenderPageLike } from '../lib/senderPage';
import { signingConsentCoversAccountRegistration, type SigningConsentStanding } from '../lib/signingConsentProvider';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ID = 'a'.repeat(32), EMAIL = 'student@example.test', ORIGIN = 'https://careers.example.test';
const NOW = 1_800_000_000;
const HANDOFF = { code: 'fictional-code', state: 's'.repeat(64), extensionId: ID };
const SETTINGS = `chrome-extension://${ID}/vault.html`;
type BackgroundSender = VaultManagementSender & SenderPageLike;
const settings: BackgroundSender = { id: ID, frameId: 0, url: SETTINGS, tab: { id: 7, url: SETTINGS } };
const page: BackgroundSender = { id: ID, frameId: 0, url: `${ORIGIN}/apply`, tab: { id: 3, url: `${ORIGIN}/apply` } };

// Execute the actual background composition, not a second implementation of its
// gate. Browser storage/transport are synthetic; auth, crypto vault, lifecycle,
// provider, sender admission and management router are the real modules.
const source = readFileSync(resolve(__dirname, '../entrypoints/background.ts'), 'utf8');
const start = source.indexOf('  // Worker-only local credentials.');
const end = source.indexOf('  const missionApplicationTargetClient = ', start);
if (start < 0 || end <= start) throw new Error('background fixture boundary missing');
const script = ts.transpileModule(`${source.slice(start, end)}\n({ vault: accountVault, lifecycle: vaultLifecycle });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function pair(owner: string, mint: number) {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { accessToken: `${b64({ alg: 'HS256' })}.${b64({ sub: owner, exp: NOW + 900, jti: `synthetic-mint-${mint}` })}.sig`,
    refreshToken: `fictional-${owner}-mint-${mint}`, user: { id: owner, email: EMAIL, role: 'STUDENT' } };
}

function harness(assistant: boolean | undefined) {
  const values = new Map<string, unknown>(), authValues = new Map<string, unknown>();
  const listeners: ((message: unknown, sender: BackgroundSender) => unknown)[] = [];
  const opened: string[] = [], diagnostics: string[] = [];
  const minted: ReturnType<typeof pair>[] = [];
  const requests: { pathname: string; refreshToken: string | null; bearer: string | null }[] = [];
  let key: CryptoKey | null = null, nextOwner = A;
  let operationsCreated = 0, providersCreated = 0, keyDeletes = 0, ciphertextDeletes = 0, broadcasts = 0;
  let readsPaused: (() => Promise<void>) | null = null;
  let policy: ApplyPolicy | null = null;
  let consent: SigningConsentStanding = { granted: false, reconsent: false };
  const keys: AccountVaultKeyStore = { load: async () => key, save: async (value) => { key = value; }, remove: async () => { keyDeletes++; key = null; } };
  const hooks = {
    beforeVaultSessionReplace: (async () => false) as NonNullable<Parameters<typeof createAuthClient>[0]['beforeReplaceSession']>,
    vaultAuthInvalidated: () => {},
  };
  const auth = createAuthClient({ apiBase: 'https://offline.test.invalid', now: () => NOW,
    store: { get: async (name) => authValues.get(name), set: async (name, value) => { authValues.set(name, value); }, remove: async (name) => { authValues.delete(name); } },
    beforeReplaceSession: (change) => sandbox.beforeVaultSessionReplace(change),
    onSessionInvalidated: () => sandbox.vaultAuthInvalidated(),
    fetchFn: (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const request: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ pathname: path,
        refreshToken: typeof request === 'object' && request !== null && 'refreshToken' in request && typeof request.refreshToken === 'string' ? request.refreshToken : null,
        bearer: new Headers(init?.headers).get('authorization'),
      });
      let body: unknown = { ok: true };
      if (path === '/auth/extension-handoffs/redeem' || path === '/auth/refresh') {
        const issued = pair(nextOwner, minted.length + 1); minted.push(issued); body = issued;
      }
      return { ok: true, status: path === AUTH_SESSION_ENDPOINTS.linkExtensionInstall.path ? 202 : 201, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch,
  });
  const sandbox = {
    ...hooks,
    ...(assistant === undefined ? {} : { __VIBE_ASSISTANT_READ_ENABLED__: assistant }),
    URL, setTimeout, clearTimeout, TextEncoder, Uint8Array, crypto: globalThis.crypto,
    browser: { storage: { local: {
      get: async (name: string) => { if (readsPaused && name === ACCOUNT_VAULT_STORAGE_KEY) await readsPaused(); return { [name]: values.get(name) }; },
      set: async (update: Record<string, unknown>) => { for (const [name, value] of Object.entries(update)) values.set(name, value); },
      remove: async (name: string) => { ciphertextDeletes++; values.delete(name); },
    } }, runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}${path}`,
      onMessage: { addListener: (listener: (message: unknown, sender: BackgroundSender) => unknown) => listeners.push(listener) } },
    tabs: { create: async ({ url }: { url: string }) => { opened.push(url); } } },
    createAccountVault, createIndexedDbVaultKeyStore: () => keys,
    createAccountVaultLifecycle, createAccountVaultMessageRouter,
    createAccountAccessOperationStore: () => { operationsCreated++; return createAccountAccessOperationStore(); },
    createAccountAccessProvider: (deps: Parameters<typeof createAccountAccessProvider>[0]) => { providersCreated++; return createAccountAccessProvider(deps); },
    authClient: auth, recordDiagnostic: (code: string) => { diagnostics.push(code); },
    broadcastSessionChanged: () => { broadcasts++; },
    senderTabForPageOrFrame, readFrameForms: async () => ({}),
    parseDockAccountAccessIntent, detectApplyVendor, declaresAccountSteps, isAccountFormPath, isApplyFormPath, isApplyPolicyEnabled,
    APPLICATION_PROFILE_FIELD_KEYS,
    executionRuntimeAuthority: { fillPolicyForVendor: async () => policy },
    profileProvider: { getProfile: async () => ({ ok: true, draft: { email: EMAIL } }) },
    signingConsentCoversAccountRegistration, signingConsentProvider: { read: async () => consent },
  };
  const mounted = runInNewContext(script, sandbox) as { vault: AccountVault; lifecycle: ReturnType<typeof createAccountVaultLifecycle> };
  const seed = async () => mounted.vault.update((record) => ({ ...record, owner: A, email: EMAIL,
    sites: { [ORIGIN]: { email: EMAIL, password: 'synthetic-site-password', source: 'USER_SAVED', state: 'REGISTERED', revision: 1, at: 1 } } }));
  const send = async (message: unknown, sender: BackgroundSender) => {
    for (const listener of listeners) { const result = listener(message, sender); if (result !== undefined) return await result; }
    return undefined;
  };
  return { auth, ...mounted, values, authValues, opened, diagnostics, minted, requests, seed, send,
    next: (owner: string) => { nextOwner = owner; }, loseKey: () => { key = null; },
    pause: (operation: () => Promise<void>) => { readsPaused = operation; }, unpause: () => { readsPaused = null; },
    setConsent: (value: SigningConsentStanding) => { consent = value; },
    setPolicy: (value: ApplyPolicy | null) => { policy = value; },
    counts: () => ({ listeners: listeners.length, operationsCreated, providersCreated, keyDeletes, ciphertextDeletes, broadcasts }) };
}

describe('Assistant background account boundary with real auth and vault', () => {
  it('has no legacy operations or credential/management/open/logout message handlers', async () => {
    const h = harness(true);
    for (const message of [createDockAccountAccessIntent(ORIGIN, '/apply', { step: 'STATUS' }),
      createAccountVaultManagementIntent({ step: 'LIST' }),
      { kind: 'dock/open-vault', version: 1, origin: ORIGIN, pathname: '/apply' },
      { kind: 'account-vault/transition', version: 1, payload: { step: 'PREPARE_LOGOUT' } }]) {
      expect(await h.send(message, settings)).toBeUndefined(); expect(await h.send(message, page)).toBeUndefined();
    }
    expect(h.counts()).toMatchObject({ listeners: 0, operationsCreated: 0, providersCreated: 0, keyDeletes: 0, ciphertextDeletes: 0 });
    expect(h.opened).toEqual([]);
  });

  it('still permits first real verified login with an empty vault', async () => {
    const h = harness(true);
    expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    expect((await h.auth.readVaultAuthContext())?.userId).toBe(A);
    expect((await h.vault.readState()).kind).toBe('EMPTY');
    expect(h.counts()).toMatchObject({ operationsCreated: 0, keyDeletes: 0, ciphertextDeletes: 0 });
  });

  it('same verified owner reauth preserves ciphertext and retained passwords exactly', async () => {
    const h = harness(true); await h.seed(); const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
    expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect((await h.vault.read()).sites[ORIGIN]?.password).toBe('synthetic-site-password');
    expect(h.counts()).toMatchObject({ operationsCreated: 0, keyDeletes: 0, ciphertextDeletes: 0 });
    expect(h.opened).toEqual([]);
  });

  it('cross-owner handoff is refused without opening nonexistent settings or deleting anything', async () => {
    const h = harness(true); await h.seed(); expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY); h.next(B);
    expect(await h.auth.redeemHandoff(HANDOFF)).toBe(false);
    expect((await h.auth.readVaultAuthContext())?.userId).toBe(A);
    expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect(h.minted).toHaveLength(2);
    expect(h.requests.filter((request) => request.pathname === '/auth/logout')).toEqual([
      { pathname: '/auth/logout', refreshToken: h.minted[1]!.refreshToken, bearer: `Bearer ${h.minted[1]!.accessToken}` },
    ]);
    expect(h.authValues.get('authSession')).toMatchObject({ userId: A, refreshToken: h.minted[0]!.refreshToken });
    expect(h.counts()).toMatchObject({ keyDeletes: 0, ciphertextDeletes: 0 }); expect(h.opened).toEqual([]);
  });

  it.each(['KEY_MISSING', 'UNREADABLE'] as const)('preserves %s retained ciphertext and refuses replacement', async (state) => {
    const h = harness(true); await h.seed(); expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    if (state === 'KEY_MISSING') h.loseKey();
    else h.values.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 2, iv: 'invalid', data: 'invalid' });
    const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
    expect((await h.vault.readState()).kind).toBe(state);
    expect(await h.auth.redeemHandoff(HANDOFF)).toBe(false);
    expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect(h.minted).toHaveLength(2);
    expect(h.requests.filter((request) => request.pathname === '/auth/logout')).toEqual([
      { pathname: '/auth/logout', refreshToken: h.minted[1]!.refreshToken, bearer: `Bearer ${h.minted[1]!.accessToken}` },
    ]);
    expect(h.authValues.get('authSession')).toMatchObject({ userId: A, refreshToken: h.minted[0]!.refreshToken });
    expect(h.counts()).toMatchObject({ keyDeletes: 0, ciphertextDeletes: 0 }); expect(h.opened).toEqual([]);
  });

  it('auth invalidation while retained-vault read awaits prevents the pending handoff from committing', async () => {
    const h = harness(true); await h.seed(); expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
    let entered!: () => void, release!: () => void;
    const readEntered = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.pause(async () => { entered(); await held; });
    const pending = h.auth.redeemHandoff(HANDOFF);
    await readEntered;
    const logout = h.auth.logout();
    h.unpause(); release();
    expect(await pending).toBe(false);
    await logout;
    expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
    expect(h.minted).toHaveLength(2);
    // The rejected candidate is revoked first. This fixture explicitly requests
    // logout while the handoff waits, so the old pair is then revoked by that
    // separately authorized logout; it is not mistaken for the new candidate.
    expect(h.requests.filter((request) => request.pathname === '/auth/logout')).toEqual([
      { pathname: '/auth/logout', refreshToken: h.minted[1]!.refreshToken, bearer: `Bearer ${h.minted[1]!.accessToken}` },
      { pathname: '/auth/logout', refreshToken: h.minted[0]!.refreshToken, bearer: `Bearer ${h.minted[0]!.accessToken}` },
    ]);
    expect(h.authValues.has('authSession')).toBe(false);
    expect(h.counts()).toMatchObject({ keyDeletes: 0, ciphertextDeletes: 0 });
  });

  it.each([false, undefined])('default/disabled Assistant flag %s retains real legacy sender and permission gates', async (flag) => {
    const h = harness(flag); await h.seed(); expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
    expect(h.counts()).toMatchObject({ listeners: 4, operationsCreated: 1 });
    const list = createAccountVaultManagementIntent({ step: 'LIST' });
    expect(await h.send(list, page)).toBeUndefined();
    expect(await h.send(list, { ...settings, id: 'b'.repeat(32) })).toBeUndefined();
    expect(await h.send(list, settings)).toMatchObject({ kind: 'VAULT_LIST', status: 'READABLE', sites: [{ origin: ORIGIN, email: EMAIL }] });
    const record = await h.vault.read(), epoch = h.auth.vaultAuthEpoch();
    expect(await h.send(createAccountVaultManagementIntent({ step: 'EXPORT', expectedRevision: record.revision, expectedEpoch: epoch }), settings))
      .toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: ORIGIN, password: 'synthetic-site-password' }] });
    const status = createDockAccountAccessIntent(ORIGIN, '/apply', { step: 'STATUS' });
    expect(await h.send(status, { ...page, id: 'b'.repeat(32) })).toBeUndefined();
    expect(await h.send(status, page)).toEqual({ kind: 'REFUSED', code: 'DISABLED' });
    expect(h.counts()).toMatchObject({ keyDeletes: 0, ciphertextDeletes: 0 });
  });

  it('default declared-account route still requires both actual consent and current runtime policy', async () => {
    installApplyAdapters({ workday: workdayAdapter });
    try {
      const h = harness(false); expect(await h.auth.redeemHandoff(HANDOFF)).toBe(true);
      const origin = 'https://tenant.wd5.myworkdayjobs.com', pathname = '/en-US/site/job/x/apply/applyManually';
      const sender: BackgroundSender = { id: ID, frameId: 0, url: origin + pathname, tab: { id: 3, url: origin + pathname } };
      const bundled = createBundledApplyPolicy(Date.now());
      const enabledPolicy: ApplyPolicy = { ...bundled, vendors: { ...bundled.vendors, workday: true }, capabilities: { ...bundled.capabilities, 'account-access': true } };
      h.setPolicy(enabledPolicy);
      const credential = async () => {
        const status = parseDockAccountAccessReply(await h.send(createDockAccountAccessIntent(origin, pathname, { step: 'STATUS' }), sender));
        if (status?.kind !== 'ACCOUNT_STATUS') throw new Error('declared-account fixture status missing');
        return parseDockAccountAccessReply(await h.send(createDockAccountAccessIntent(origin, pathname, {
          step: 'CREDENTIAL', purpose: 'register', operationId: status.operationId, expectedEpoch: status.authEpoch,
        }), sender));
      };
      expect(await credential()).toMatchObject({ kind: 'REFUSED', code: 'CONSENT_REQUIRED' });
      h.setConsent({ granted: true, reconsent: false });
      h.setPolicy(null);
      expect(await credential()).toMatchObject({ kind: 'REFUSED', code: 'DISABLED' });
      h.setPolicy(enabledPolicy);
      const issued = await credential();
      expect(issued).toMatchObject({ kind: 'ACCOUNT_CREDENTIAL', email: EMAIL, source: 'GENERATED', generated: true, known: false });
      if (issued?.kind !== 'ACCOUNT_CREDENTIAL') throw new Error('fixture credential not issued');
      const before = h.values.get(ACCOUNT_VAULT_STORAGE_KEY);
      h.setPolicy(null);
      expect(await h.send(createDockAccountAccessIntent(origin, pathname, { step: 'CHECK', operationId: issued.operationId, expectedEpoch: issued.authEpoch }), sender))
        .toEqual({ kind: 'REFUSED', code: 'DISABLED' });
      expect(h.values.get(ACCOUNT_VAULT_STORAGE_KEY)).toBe(before);
      expect(h.counts()).toMatchObject({ operationsCreated: 1, keyDeletes: 0, ciphertextDeletes: 0 });
    } finally { installApplyAdapters({}); }
  });
});

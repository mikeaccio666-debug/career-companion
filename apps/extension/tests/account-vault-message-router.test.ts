import { describe, expect, it, vi } from 'vitest';
import { createAccountVaultMessageRouter } from '../lib/accountVaultMessageRouter';
import { createAccountVault, type AccountVaultRecord } from '../lib/accountVault';
import { createAccountAccessOperationStore, createAccountAccessProvider } from '../lib/accountAccessProvider';
import { createAccountVaultManagementIntent } from '../lib/accountAccessIntent';
import { MANAGEMENT_TRANSITION_BINDING, type AccountVaultTransitions } from '../lib/accountVaultTransitions';
import { senderTabForPage } from '../lib/senderPage';
const ID = 'a'.repeat(32), SETTINGS = `chrome-extension://${ID}/vault.html`, ORIGIN = 'https://careers.example.test';
const settings = { id: ID, frameId: 0, url: SETTINGS, tab: { id: 7, url: SETTINGS } };
const page = { id: ID, frameId: 0, url: `${ORIGIN}/apply`, tab: { id: 3, url: `${ORIGIN}/apply` } };
async function setup() {
  const values = new Map<string, unknown>(); let key: CryptoKey | null = null;
  const vault = createAccountVault({ area: { get: async (name) => values.get(name), set: async (name, value) => { values.set(name, value); }, remove: async (name) => { values.delete(name); } },
    keys: { load: async () => key, save: async (value) => { key = value; }, remove: async () => { key = null; } } });
  const record: AccountVaultRecord = { v: 2, owner: 'actual-fixture-owner', email: 'student@example.test', legacyPassword: null, revision: 0,
    sites: { [ORIGIN]: { email: 'student@example.test', password: 'fictional-only-secret', source: 'USER_SAVED', state: 'REGISTERED', revision: 1, at: 1 } } };
  await vault.update(() => record);
  const provider = createAccountAccessProvider({ vault, ops: createAccountAccessOperationStore(), getAuthContext: async () => ({ userId: record.owner!, epoch: 1 }),
    getManagementContext: async () => ({ userId: record.owner!, epoch: 1 }), profileEmail: async () => null, consent: async () => false, capability: async () => false });
  const transitions = { prepareLogout: vi.fn(async () => ({ kind: 'TRANSITION_NONE' as const })), pending: vi.fn(async () => ({ kind: 'TRANSITION_NONE' as const })),
    confirm: vi.fn(async () => ({ kind: 'TRANSITION_DONE' as const, action: 'LOGOUT' as const })), cancel: vi.fn(() => ({ kind: 'REFUSED' as const, code: 'CANCELED' as const })),
    requestSwitch: vi.fn(async () => false), invalidate: vi.fn() } satisfies AccountVaultTransitions;
  const opened: string[] = [];
  const router = createAccountVaultMessageRouter({ extensionId: ID, managementUrl: SETTINGS, transitions, manage: provider.manage,
    pageAllowed: async (sender, claim) => senderTabForPage(sender, ID, claim) !== null, openTab: async (url) => { opened.push(url); } });
  return { router, transitions, opened, vault, values };
}
describe('actual worker vault routes', () => {
  it('only a real top-level extension settings sender can export the real encrypted vault', async () => {
    const h = await setup(), record = await h.vault.read();
    const message = createAccountVaultManagementIntent({ step: 'EXPORT', expectedEpoch: 1, expectedRevision: record.revision });
    expect(await h.router.management(message, settings)).toMatchObject({ kind: 'VAULT_EXPORT', rows: [{ origin: ORIGIN, password: 'fictional-only-secret' }] });
    for (const sender of [page, { ...settings, id: 'b'.repeat(32) }, { ...settings, frameId: 2 }, { ...settings, url: `${ORIGIN}/vault.html` },
      { ...settings, url: SETTINGS.replace('/vault.html', '/assistant.html') }, { ...settings, url: SETTINGS + '?claimedOwner=actual-fixture-owner' }, { ...settings, tab: { url: `${ORIGIN}/apply` } }]) {
      expect(h.router.management(message, sender)).toBeUndefined();
    }
  });
  it('content-script protocol cannot request a full-vault secret by using an old or forged shape', async () => {
    const h = await setup();
    for (const payload of [{ step: 'EXPORT', expectedEpoch: 1, expectedRevision: 1 }, { step: 'REVEAL' }, { step: 'SETTINGS_SET_PASSWORD', password: 'fictional-only-secret' }]) {
      const message = { kind: 'dock/account-access-intent', version: 1, origin: ORIGIN, pathname: '/apply', payload };
      expect(h.router.management(message, page)).toBeUndefined(); expect(h.router.open(message, page)).toBeUndefined(); expect(h.router.transition(message, page)).toBeUndefined();
    }
  });
  it('trusted-settings route binds the confirmation to management; ATS messages cannot clear or get a nonce', async () => {
    const h = await setup();
    const confirm = { kind: 'account-vault/transition', version: 1, payload: { step: 'CONFIRM', ticket: 'fictional-ticket' } };
    expect(h.router.transition(confirm, page)).toBeUndefined(); expect(h.transitions.confirm).not.toHaveBeenCalled();
    expect(await h.router.transition(confirm, settings)).toEqual({ kind: 'TRANSITION_DONE', action: 'LOGOUT' });
    expect(h.transitions.confirm).toHaveBeenCalledWith('fictional-ticket', MANAGEMENT_TRANSITION_BINDING);
  });
  it('dock logout only opens confirmation page, returns no nonce, and performs zero logout/clear', async () => {
    const h = await setup(); const before = [...h.values.values()];
    const message = { kind: 'dock/vault-transition', version: 1, origin: ORIGIN, pathname: '/apply', payload: { step: 'PREPARE_LOGOUT' } };
    expect(await h.router.open(message, page)).toEqual({ ok: true });
    expect(h.opened).toEqual([SETTINGS + '?action=logout']); expect(h.transitions.prepareLogout).not.toHaveBeenCalled(); expect([...h.values.values()]).toEqual(before);
    expect(await h.router.open(message, { ...page, url: `${ORIGIN}/different` })).toEqual({ ok: false }); expect(h.opened).toHaveLength(1);
  });
  it('opens only exact settings URL with a validated origin; rejects client dock confirm and external navigation', async () => {
    const h = await setup(); const message = { kind: 'dock/open-vault', version: 1, origin: ORIGIN, pathname: '/apply', selectedOrigin: 'https://other.example.test' };
    expect(await h.router.open(message, page)).toEqual({ ok: true });
    expect(h.opened[0]).toBe(SETTINGS + '?selectedOrigin=https%3A%2F%2Fother.example.test');
    expect(h.router.open({ ...message, selectedOrigin: 'javascript:alert(1)' }, page)).toBeUndefined();
    expect(h.router.open({ kind: 'dock/vault-transition', version: 1, origin: ORIGIN, pathname: '/apply', payload: { step: 'CONFIRM', ticket: 'fictional-ticket' } }, page)).toBeUndefined();
    expect(h.transitions.confirm).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createVaultSettingsPorts } from '../assistant/features/account-vault/runtime-client';

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const gesture = () => new TrustedClick('click');
const managementUrl = 'chrome-extension://test-extension/vault.html';
const origin = 'https://careers.example.test';
const listed = { kind: 'VAULT_LIST', status: 'READABLE', revision: 7, authEpoch: 11, email: 'student@example.test', defaultEmail: null, sites: [] };
function fixture(pageUrl = managementUrl, send = vi.fn(async (_message: unknown): Promise<unknown> => listed)) {
  const download = vi.fn();
  const ports = createVaultSettingsPorts({ extensionId: 'test-extension', managementUrl, pageUrl, send, subscribe: () => () => {}, download });
  return { ports, send, download, signal: new AbortController().signal };
}

describe('vault settings adapter', () => {
  it.each(['https://careers.example.test/vault.html', 'chrome-extension://other-extension/vault.html', `${managementUrl}?unknown=1`, `${managementUrl}#fragment`])('does not message or download from a non-management page %s', async (url) => {
    const { ports, send, signal } = fixture(url);
    expect((await ports.list(signal)).ok).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(() => ports.download('fictional')).toThrow('VAULT_PAGE_UNAVAILABLE');
  });

  it('uses the closed management protocol and preserves the real epoch/revision', async () => {
    const { ports, send, signal } = fixture(); expect(await ports.list(signal)).toEqual({ ok: true, value: listed });
    expect(send).toHaveBeenCalledWith({ kind: 'account-vault/management', version: 1, payload: { step: 'LIST' } });
    send.mockResolvedValue({ kind: 'ACCOUNT_PASSWORD', origin, password: 'fictional-secret', revision: 7, authEpoch: 11 });
    await ports.reveal({ origin, expectedRevision: 7, expectedEpoch: 11 }, gesture(), signal);
    expect(send).toHaveBeenLastCalledWith({ kind: 'account-vault/management', version: 1, payload: { step: 'REVEAL', origin, expectedRevision: 7, expectedEpoch: 11 } });
  });

  it('does not accept wrong or additional secret reply fields as a successful list', async () => {
    const { ports, send, signal } = fixture(); send.mockResolvedValue({ ...listed, password: 'forbidden-secret' });
    expect((await ports.list(signal)).ok).toBe(false);
    send.mockResolvedValue({ kind: 'ACCOUNT_PASSWORD', origin, password: 'fictional-secret', revision: 7, authEpoch: 11 });
    expect((await ports.list(signal)).ok).toBe(false);
  });

  it('requires a real click before requesting secret replies', async () => {
    const { ports, send, signal } = fixture();
    expect(await ports.reveal({ origin, expectedRevision: 7, expectedEpoch: 11 }, new MouseEvent('click'), signal)).toEqual({ ok: false, code: 'UNTRUSTED' });
    expect(await ports.export({ expectedRevision: 7, expectedEpoch: 11 }, new MouseEvent('click'), signal)).toEqual({ ok: false, code: 'UNTRUSTED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('prepares logout only in the settings page after PENDING, and never auto-confirms', async () => {
    const send = vi.fn(async (message: unknown): Promise<unknown> => {
      const step = (message as { payload: { step: string } }).payload.step;
      return step === 'PENDING' ? { kind: 'TRANSITION_NONE' } : { kind: 'CONFIRM_REQUIRED', ticket: 'worker-ticket', action: 'LOGOUT', hasVault: true, canExport: true, expiresAt: Date.now() + 60_000 };
    });
    const { ports, signal } = fixture(`${managementUrl}?action=logout`, send);
    expect((await ports.loadPendingTransition!(signal)).ok).toBe(true);
    expect(send.mock.calls.map(([message]) => (message as { payload: { step: string } }).payload.step)).toEqual(['PENDING', 'PREPARE_LOGOUT']);
    await ports.loadPendingTransition!(signal);
    expect(send.mock.calls.filter(([message]) => (message as { payload: { step: string } }).payload.step === 'PREPARE_LOGOUT')).toHaveLength(1);
    expect(send.mock.calls.some(([message]) => (message as { payload: { step: string } }).payload.step === 'CONFIRM')).toBe(false);
  });

  it('does not prepare logout for a normal or selected-origin settings visit', async () => {
    const send = vi.fn(async (): Promise<unknown> => ({ kind: 'TRANSITION_NONE' }));
    const { ports, signal } = fixture(`${managementUrl}?selectedOrigin=${encodeURIComponent(origin)}`, send);
    expect(await ports.loadPendingTransition!(signal)).toEqual({ ok: true, value: null }); expect(send).toHaveBeenCalledTimes(1);
  });
});
